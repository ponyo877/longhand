import AppKit
import ApplicationServices
import Foundation
import LonghandCore

/// AXUIElement を Sendable として持ち回るための箱（AX の呼び出しはスレッドをまたいでも安全）
struct AXRef: @unchecked Sendable {
    let element: AXUIElement
}

/// Accessibility API の小道具。どの呼び出しもメッセージングのタイムアウトで上限を切る（既定 0.25 秒）
enum AX {
    static let defaultTimeout: Float = 0.25

    static func configureGlobalTimeout() {
        // システム全体の要素に設定すると、全要素の既定値になる
        AXUIElementSetMessagingTimeout(AXUIElementCreateSystemWide(), defaultTimeout)
    }

    static func isTrusted(prompt: Bool = false) -> Bool {
        if prompt {
            let key = "AXTrustedCheckOptionPrompt" as CFString
            return AXIsProcessTrustedWithOptions([key: true] as CFDictionary)
        }
        return AXIsProcessTrusted()
    }

    static func app(_ pid: pid_t, timeout: Float = defaultTimeout) -> AXUIElement {
        let el = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(el, timeout)
        return el
    }

    // MARK: - 属性の読み書き

    static func copy(_ el: AXUIElement, _ attr: String) -> (AXError, CFTypeRef?) {
        var value: CFTypeRef?
        let err = AXUIElementCopyAttributeValue(el, attr as CFString, &value)
        return (err, value)
    }

    static func value(_ el: AXUIElement, _ attr: String) -> CFTypeRef? {
        let (err, v) = copy(el, attr)
        return err == .success ? v : nil
    }

    static func string(_ el: AXUIElement, _ attr: String) -> String? {
        guard let v = value(el, attr) else { return nil }
        if let s = v as? String { return s }
        if let a = v as? NSAttributedString { return a.string }
        return nil
    }

    static func element(_ el: AXUIElement, _ attr: String) -> AXUIElement? {
        guard let v = value(el, attr), CFGetTypeID(v) == AXUIElementGetTypeID() else { return nil }
        return (v as! AXUIElement)
    }

    static func int(_ el: AXUIElement, _ attr: String) -> Int? {
        (value(el, attr) as? NSNumber)?.intValue
    }

    static func bool(_ el: AXUIElement, _ attr: String) -> Bool? {
        (value(el, attr) as? NSNumber)?.boolValue
    }

    static func url(_ el: AXUIElement, _ attr: String) -> URL? {
        guard let v = value(el, attr) else { return nil }
        if let u = v as? URL { return u }
        if let s = v as? String { return URL(string: s) }
        return nil
    }

    static func range(_ el: AXUIElement, _ attr: String) -> CFRange? {
        guard let v = value(el, attr), CFGetTypeID(v) == AXValueGetTypeID() else { return nil }
        var r = CFRange()
        return AXValueGetValue(v as! AXValue, .cfRange, &r) ? r : nil
    }

    static func children(_ el: AXUIElement) -> [AXUIElement] {
        (value(el, kAXChildrenAttribute) as? [AXUIElement]) ?? []
    }

    static func isSettable(_ el: AXUIElement, _ attr: String) -> Bool {
        var settable = DarwinBoolean(false)
        return AXUIElementIsAttributeSettable(el, attr as CFString, &settable) == .success && settable.boolValue
    }

    @discardableResult
    static func set(_ el: AXUIElement, _ attr: String, _ value: CFTypeRef) -> AXError {
        AXUIElementSetAttributeValue(el, attr as CFString, value)
    }

    /// 複数の属性をまとめて読む（往復を 1 回にする）
    static func multiple(_ el: AXUIElement, _ attrs: [String]) -> [String: CFTypeRef] {
        var values: CFArray?
        let err = AXUIElementCopyMultipleAttributeValues(el, attrs as CFArray, [], &values)
        guard err == .success, let arr = values as? [CFTypeRef], arr.count == attrs.count else { return [:] }
        var out: [String: CFTypeRef] = [:]
        for (i, a) in attrs.enumerated() {
            let v = arr[i]
            // 取れなかった属性は AXValue（kAXValueAXErrorType）で返ってくる
            if CFGetTypeID(v) == AXValueGetTypeID(), AXValueGetType(v as! AXValue) == .axError { continue }
            out[a] = v
        }
        return out
    }

    static func stringForRange(_ el: AXUIElement, location: Int, length: Int) -> String? {
        guard length >= 0, location >= 0 else { return nil }
        var r = CFRange(location: location, length: length)
        guard let param = AXValueCreate(.cfRange, &r) else { return nil }
        var value: CFTypeRef?
        let err = AXUIElementCopyParameterizedAttributeValue(el, kAXStringForRangeParameterizedAttribute as CFString, param, &value)
        guard err == .success else { return nil }
        if let s = value as? String { return s }
        if let a = value as? NSAttributedString { return a.string }
        return nil
    }

    static func pid(of el: AXUIElement) -> pid_t? {
        var pid: pid_t = 0
        return AXUIElementGetPid(el, &pid) == .success ? pid : nil
    }

    // MARK: - フォーカス

    /// フォーカス中のアプリ（AX 優先、なければ NSWorkspace の最前面）
    static func focusedAppPid() -> pid_t? {
        let sys = AXUIElementCreateSystemWide()
        if let app = element(sys, kAXFocusedApplicationAttribute), let pid = pid(of: app) {
            return pid
        }
        return NSWorkspace.shared.frontmostApplication?.processIdentifier
    }

    static func focusedElement(appPid: pid_t) -> AXUIElement? {
        let app = app(appPid)
        if let el = element(app, kAXFocusedUIElementAttribute) { return el }
        // アプリ要素から取れないときはシステム全体から
        return element(AXUIElementCreateSystemWide(), kAXFocusedUIElementAttribute)
    }
}

/// 入力欄の状態（着地確認と監視に使う）
struct FieldState: Equatable {
    var length: Int?
    var selection: CFRange?
    /// 短い欄の内容（4000 文字まで）。それより長ければ nil
    var shortValue: String?

    static func == (a: FieldState, b: FieldState) -> Bool {
        a.length == b.length && a.selection?.location == b.selection?.location
            && a.selection?.length == b.selection?.length && a.shortValue == b.shortValue
    }

    var isReadable: Bool { length != nil || selection != nil || shortValue != nil }

    static func read(_ el: AXUIElement) -> FieldState {
        let m = AX.multiple(el, [kAXNumberOfCharactersAttribute, kAXSelectedTextRangeAttribute])
        var s = FieldState()
        s.length = (m[kAXNumberOfCharactersAttribute] as? NSNumber)?.intValue
        if let v = m[kAXSelectedTextRangeAttribute], CFGetTypeID(v) == AXValueGetTypeID() {
            var r = CFRange()
            if AXValueGetValue(v as! AXValue, .cfRange, &r) { s.selection = r }
        }
        if s.length == nil || (s.length ?? 0) <= 4000 {
            if let v = AX.string(el, kAXValueAttribute), v.utf16.count <= 4000 {
                s.shortValue = v
                if s.length == nil { s.length = v.utf16.count }
            }
        }
        return s
    }
}

enum FieldReader {
    static let secureSubrole = "AXSecureTextField"
    static let textRoles: Set<String> = ["AXTextField", "AXTextArea", "AXComboBox", "AXSearchField"]

    static func isSecure(role: String?, subrole: String?) -> Bool {
        subrole == secureSubrole || role == secureSubrole
    }

    /// 欄の全文（UTF-16 で最大 maxChars。長ければキャレットの周りを切り出す）
    static func fullText(_ el: AXUIElement, maxChars: Int = 20000) -> String? {
        snapshot(el, maxChars: maxChars)?.text
    }

    /// 欄の全文と、その文字列が欄の中のどこから始まるか（切り出したとき）、選択範囲
    static func snapshot(_ el: AXUIElement, maxChars: Int = 20000) -> (text: String, start: Int, selection: CFRange?)? {
        let length = AX.int(el, kAXNumberOfCharactersAttribute)
        let sel = AX.range(el, kAXSelectedTextRangeAttribute)
        if let length, length > maxChars {
            let center = sel?.location ?? length
            let start = max(0, min(length - maxChars, center - maxChars / 2))
            if let s = AX.stringForRange(el, location: start, length: maxChars) { return (s, start, sel) }
            if length > 500_000 { return nil }
        }
        guard let v = AX.string(el, kAXValueAttribute) else { return nil }
        let units = v.utf16.count
        if units <= maxChars { return (v, 0, sel) }
        // TextSlicing.window と同じ位置で切り出す
        let center = sel?.location ?? units
        var start = max(0, center - maxChars / 2)
        let end = min(units, start + maxChars)
        start = max(0, end - maxChars)
        return (TextSlicing.window(v, center: center, maxChars: maxChars), start, sel)
    }
}
