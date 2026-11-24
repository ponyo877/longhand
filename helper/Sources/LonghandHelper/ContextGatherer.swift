import AppKit
import ApplicationServices
import Foundation
import LonghandCore

/// get_context の実装。前面アプリ、フォーカス中の要素、入力欄の内容、ウィンドウのタイトル、ブラウザのホスト名を取る。
/// 全体で約 300ms、ホスト名の探索は約 150ms を上限にする。AX の各呼び出しは 0.25 秒のタイムアウトで切る。
enum ContextGatherer {
    static let totalBudgetMs: Double = 300
    static let hostBudgetMs: Double = 150

    static let nonTextRoles: Set<String> = [
        "AXButton", "AXCheckBox", "AXRadioButton", "AXPopUpButton", "AXMenuButton", "AXMenuItem", "AXMenu",
        "AXMenuBar", "AXMenuBarItem", "AXList", "AXOutline", "AXTable", "AXRow", "AXImage", "AXSlider",
        "AXWindow", "AXApplication", "AXDockItem", "AXDisclosureTriangle", "AXToolbar", "AXLink", "AXTabGroup",
        "AXIncrementor", "AXColorWell", "AXSplitter", "AXProgressIndicator", "AXBrowser",
    ]

    static func appInfo(pid: pid_t?) -> AppInfoPayload {
        guard let pid, let app = NSRunningApplication(processIdentifier: pid) else {
            return AppInfoPayload(name: "", bundleId: "", pid: pid ?? 0)
        }
        return AppInfoPayload(name: app.localizedName ?? "", bundleId: app.bundleIdentifier ?? "", pid: pid)
    }

    /// targetPid を渡すと、フォーカス中のアプリの代わりにそのアプリを調べる（--probe-context 用）
    static func gather(includeField: Bool, includeHost: Bool, maxContextChars: Int, targetPid: pid_t? = nil) -> ContextPayload {
        let sw = Stopwatch()
        let trusted = AX.isTrusted()
        let pid = targetPid ?? (trusted ? AX.focusedAppPid() : NSWorkspace.shared.frontmostApplication?.processIdentifier)
        let app = appInfo(pid: pid)
        var ctx = ContextPayload(app: app, canPaste: "unknown", elapsedMs: 0)
        guard trusted, let pid else {
            ctx.elapsedMs = sw.elapsedMs
            return ctx
        }

        let appEl = AX.app(pid)
        if let window = AX.element(appEl, kAXFocusedWindowAttribute), let title = AX.string(window, kAXTitleAttribute), !title.isEmpty {
            ctx.windowTitle = TextSlicing.truncate(title, max: 200)
        }

        let focused = targetPid != nil ? AX.element(appEl, kAXFocusedUIElementAttribute) : AX.focusedElement(appPid: pid)
        if let el = focused {
            let attrs = AX.multiple(el, [
                kAXRoleAttribute, kAXSubroleAttribute, kAXDescriptionAttribute, kAXTitleAttribute,
                kAXPlaceholderValueAttribute, kAXHelpAttribute,
            ])
            let role = attrs[kAXRoleAttribute] as? String ?? AX.string(el, kAXRoleAttribute) ?? "AXUnknown"
            let subrole = attrs[kAXSubroleAttribute] as? String
            let secure = FieldReader.isSecure(role: role, subrole: subrole)
            let editable = AX.isSettable(el, kAXValueAttribute)
                || FieldReader.textRoles.contains(role)
                || AX.value(el, "AXEditableAncestor") != nil
            var descParts: [String] = []
            for key in [kAXDescriptionAttribute, kAXTitleAttribute, kAXPlaceholderValueAttribute, kAXHelpAttribute] {
                if let s = attrs[key] as? String {
                    let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
                    if !t.isEmpty && !descParts.contains(t) { descParts.append(t) }
                }
            }
            var field = FieldInfoPayload(
                role: role, subrole: subrole,
                description: descParts.isEmpty ? nil : TextSlicing.truncate(descParts.joined(separator: " | "), max: 200),
                isSecure: secure, editable: editable
            )
            ctx.canPaste = canPaste(role: role, secure: secure, editable: editable, element: el)
            // ボタンなど文字を受け付けない要素の本文は読まない（空文字を返すと「空の入力欄」と誤解される）
            if includeField && !secure && ctx.canPaste != "no" {
                readText(el, into: &field, maxChars: max(0, maxContextChars), deadline: sw.start + totalBudgetMs - 30,
                         maxValueChars: AppObserver.isChromiumLike(pid: pid) ? Self.chromiumMaxValueChars : Self.maxValueChars)
            }
            ctx.field = field
        }

        if includeHost, BrowserHost.isBrowser(app.bundleId) {
            let remaining = totalBudgetMs - sw.elapsed
            let budget = min(hostBudgetMs, max(20, remaining))
            ctx.host = BrowserHost.find(app: appEl, focused: focused, deadline: Clock.nowMs() + budget)
        }
        ctx.elapsedMs = sw.elapsedMs
        if Double(ctx.elapsedMs) > totalBudgetMs {
            Log.info("get_context slow: \(ctx.elapsedMs)ms for \(app.bundleId)")
        }
        return ctx
    }

    static func canPaste(role: String, secure: Bool, editable: Bool, element: AXUIElement) -> String {
        if secure || editable || FieldReader.textRoles.contains(role) { return "yes" }
        if role == "AXWebArea" { return "unknown" }
        if nonTextRoles.contains(role) { return "no" }
        return "unknown"
    }

    /// 値を丸ごと読む経路（StringForRange に対応しない要素向け）の上限。
    /// Chromium と Electron は大きな値を返すのが遅く、AX のタイムアウトまで待たされやすいので小さくする（CTX-3）
    static let maxValueChars = 300_000
    static let chromiumMaxValueChars = 10_000

    /// 選択範囲とキャレット前後の文字列を読む（UTF-16 単位）
    static func readText(_ el: AXUIElement, into field: inout FieldInfoPayload, maxChars: Int, deadline: Double,
                         maxValueChars: Int = maxValueChars) {
        let m = AX.multiple(el, [kAXSelectedTextRangeAttribute, kAXNumberOfCharactersAttribute])
        var sel: CFRange?
        if let v = m[kAXSelectedTextRangeAttribute], CFGetTypeID(v) == AXValueGetTypeID() {
            var r = CFRange()
            if AXValueGetValue(v as! AXValue, .cfRange, &r) { sel = r }
        }
        let total = (m[kAXNumberOfCharactersAttribute] as? NSNumber)?.intValue
        field.totalLength = total

        // 1. StringForRange で必要な部分だけ読む（巨大な欄でも速い）
        if let sel, let total, sel.location >= 0, sel.location + sel.length <= total {
            let beforeStart = max(0, sel.location - maxChars)
            let end = sel.location + sel.length
            let before = AX.stringForRange(el, location: beforeStart, length: sel.location - beforeStart)
            if before != nil || sel.location == 0 {
                field.beforeCursor = before.map { trimLeadingHalf($0) } ?? ""
                if sel.length == 0 {
                    field.selectedText = ""
                } else {
                    let cap = min(sel.length, 20000)
                    field.selectedText = AX.string(el, kAXSelectedTextAttribute).map { TextSlicing.substring($0, utf16Start: 0, end: cap) }
                        ?? AX.stringForRange(el, location: sel.location, length: cap)
                }
                if Clock.nowMs() < deadline {
                    let afterLen = min(maxChars, total - end)
                    field.afterCursor = afterLen > 0 ? (AX.stringForRange(el, location: end, length: afterLen) ?? nil) : ""
                }
                if field.afterCursor != nil || Clock.nowMs() >= deadline { return }
            }
        }

        // 2. AXValue から切り出す（StringForRange に対応しない要素向け）
        if let total, total > maxValueChars { return }
        guard Clock.nowMs() < deadline, let value = AX.string(el, kAXValueAttribute) else {
            if field.selectedText == nil, let s = AX.string(el, kAXSelectedTextAttribute) { field.selectedText = s }
            return
        }
        let units = value.utf16.count
        if field.totalLength == nil { field.totalLength = units }
        if let sel, sel.location >= 0, sel.location <= units {
            let end = min(units, sel.location + max(0, sel.length))
            field.beforeCursor = TextSlicing.before(value, location: sel.location, maxChars: maxChars)
            field.afterCursor = TextSlicing.after(value, location: end, maxChars: maxChars)
            if field.selectedText == nil {
                field.selectedText = TextSlicing.substring(value, utf16Start: sel.location, end: min(end, sel.location + 20000))
            }
        } else {
            // キャレット位置が分からない。末尾にあるとみなす
            field.beforeCursor = TextSlicing.before(value, location: units, maxChars: maxChars)
            if field.selectedText == nil { field.selectedText = AX.string(el, kAXSelectedTextAttribute) }
        }
    }

    /// StringForRange がサロゲートペアの後半から始まったときに捨てる
    private static func trimLeadingHalf(_ s: String) -> String {
        if let first = s.utf16.first, UTF16.isTrailSurrogate(first) {
            return String(decoding: s.utf16.dropFirst(), as: UTF16.self)
        }
        return s
    }
}

/// ブラウザのホスト名を AX から探す
enum BrowserHost {
    static let browserBundleIds: Set<String> = [
        "com.apple.Safari", "com.apple.SafariTechnologyPreview",
        "com.google.Chrome", "com.google.Chrome.beta", "com.google.Chrome.dev", "com.google.Chrome.canary",
        "org.chromium.Chromium",
        "com.microsoft.edgemac", "com.microsoft.edgemac.Beta", "com.microsoft.edgemac.Dev", "com.microsoft.edgemac.Canary",
        "com.brave.Browser", "com.brave.Browser.beta", "com.brave.Browser.nightly",
        "company.thebrowser.Browser", "company.thebrowser.dia",
        "com.vivaldi.Vivaldi", "com.operasoftware.Opera",
        "org.mozilla.firefox", "org.mozilla.firefoxdeveloperedition", "org.mozilla.nightly",
        "app.zen-browser.zen", "com.kagi.kagimacOS",
    ]

    static func isBrowser(_ bundleId: String) -> Bool {
        browserBundleIds.contains(bundleId)
    }

    static func find(app: AXUIElement, focused: AXUIElement?, deadline: Double) -> String? {
        // 1. フォーカス中の要素から親をたどって AXWebArea を探す（ページ内にフォーカスがあれば速い）
        if let focused {
            var el: AXUIElement? = focused
            var steps = 0
            while let cur = el, steps < 60, Clock.nowMs() < deadline {
                if AX.string(cur, kAXRoleAttribute) == "AXWebArea", let host = host(of: cur) { return host }
                el = AX.element(cur, kAXParentAttribute)
                steps += 1
            }
        }
        // 2. ウィンドウの中を幅優先で探す（AXWebArea の AXURL、またはアドレスバーの値）
        guard Clock.nowMs() < deadline, let window = AX.element(app, kAXFocusedWindowAttribute) else { return nil }
        var queue: [AXUIElement] = [window]
        var visited = 0
        var addressCandidate: String?
        while !queue.isEmpty, visited < 400, Clock.nowMs() < deadline {
            let el = queue.removeFirst()
            visited += 1
            let attrs = AX.multiple(el, [kAXRoleAttribute, kAXIdentifierAttribute, kAXDescriptionAttribute])
            let role = attrs[kAXRoleAttribute] as? String ?? ""
            if role == "AXWebArea", let host = host(of: el) { return host }
            if addressCandidate == nil, role == "AXTextField" {
                let ident = (attrs[kAXIdentifierAttribute] as? String ?? "").lowercased()
                let desc = (attrs[kAXDescriptionAttribute] as? String ?? "").lowercased()
                if ident.contains("url") || ident.contains("address") || desc.contains("address") || desc.contains("アドレス")
                    || desc.contains("url") || desc.contains("search or enter") {
                    if let v = AX.string(el, kAXValueAttribute), let h = parseHost(v) { addressCandidate = h }
                }
            }
            if role == "AXWebArea" { continue } // ページの中までは潜らない
            queue.append(contentsOf: AX.children(el))
        }
        return addressCandidate
    }

    static func host(of webArea: AXUIElement) -> String? {
        guard let url = AX.url(webArea, "AXURL") else { return nil }
        guard let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" else { return nil }
        return url.host
    }

    /// アドレスバーの文字列（スキームがないこともある）からホスト名を取り出す
    static func parseHost(_ text: String) -> String? {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty, !t.contains(" ") else { return nil }
        let withScheme = t.contains("://") ? t : "https://" + t
        guard let url = URL(string: withScheme), let host = url.host, host.contains(".") else { return nil }
        return host
    }
}
