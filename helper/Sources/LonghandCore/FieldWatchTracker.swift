import Foundation

// 貼り付け後の監視（PST-9、学習）の判定。OS から切り離した純粋なロジックで、XCTest で検証する。
//
// ヘルパーの FieldWatcher が、入力欄の読み取り（observe）と利用者のキー入力（keystroke、enter）をここへ渡し、
// 監視を終えるかどうかと、学習に使う最後の値（final）を決めてもらう。
//
// 規則:
// - afterPaste: 貼り付けた文字列が欄に見えるまで読み直す（afterPasteMaxMs まで）。見えなければ最後の読み取り。
// - 送信の検知: 欄が空になった、または貼り付けた文字列が消えて欄が大きく短くなったら、監視を終える。
//   final はその直前の読み取り。直前に Return の keyDown があれば理由を enter にし、keyDown の瞬間の読み取りを使う。
//   Backspace や ⌘X の直後に短くなったのは利用者の手直しなので、送信とみなさない。
// - キー入力: 矢印、ナビゲーション、Esc、F キー、⌘C など、それに Return は数えない。最初のキー入力の直前の読み取りを baseline にする
//   （アプリの自動変換や遅れて反映された貼り付けを、利用者の手直しと区別するため）。
// - 安定待ち: 時間切れで終えるときは、settleMs の間変化がなくなるのを settleMaxWaitMs まで待つ（判断は呼び出し側）。

/// 監視中のキー入力の分類
public enum WatchKey: Equatable, Sendable {
    /// 数えない（矢印、Home/End、PageUp/PageDown、Esc、Tab、F キー、⌘A、⌘C など）
    case ignore
    /// 文字の入力、⌘V、⌘Z など
    case edit
    /// Backspace、Delete、⌘X、⌃H など（直後に欄が短くなっても送信とみなさない）
    case deletion
    /// Return、テンキーの Enter（修飾キーの有無を問わない）
    case enter

    private static let navigation: Set<String> = [
        "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown",
        "Escape", "Tab", "Insert", "ContextMenu", "Lang1", "Lang2", "Help",
    ]

    /// keyName は KeyTable の名前（"KeyA"、"Enter" など）
    public static func classify(keyName: String, command: Bool, control: Bool, option: Bool) -> WatchKey {
        if keyName == "Enter" || keyName == "NumpadEnter" { return .enter }
        if keyName == "Backspace" || keyName == "Delete" { return .deletion }
        if navigation.contains(keyName) { return .ignore }
        if keyName.hasPrefix("F"), let n = Int(keyName.dropFirst()), (1...20).contains(n) { return .ignore }
        if command {
            switch keyName {
            case "KeyV", "KeyZ", "KeyY": return .edit
            case "KeyX": return .deletion
            default: return .ignore
            }
        }
        if control {
            // Cocoa のテキスト編集の Emacs 風キー
            switch keyName {
            case "KeyH", "KeyD", "KeyK", "KeyW": return .deletion
            case "KeyY", "KeyT", "KeyO": return .edit
            default: return .ignore
            }
        }
        _ = option
        return .edit
    }
}

public struct FieldWatchTracker: Sendable {
    public struct Config: Sendable {
        /// 貼り付けた文字列が欄に見えるまで afterPaste を読み直す上限
        public var afterPasteMaxMs: Double = 1000
        /// 最後の読み取りの前に、変化がないことを確かめる時間
        public var settleMs: Double = 1000
        /// 時間切れの後に安定を待つ上限
        public var settleMaxWaitMs: Double = 1500
        /// Return の keyDown から、この時間内に欄が消えたら理由を enter にする
        public var enterAttributionMs: Double = 3000
        /// 削除系のキーの後、この時間内に短くなったのは送信とみなさない
        public var deletionGraceMs: Double = 400
        /// 最後のキー入力からこの時間が過ぎていれば「打っていない」とみなす
        public var typingQuietMs: Double = 1000

        public init() {}
    }

    public enum EndReason: String, Sendable {
        case timeout
        case focusChanged = "focus_changed"
        case elementGone = "element_gone"
        case enter
        case sent
        case cancelled
    }

    public struct Result: Equatable, Sendable {
        public var reason: EndReason
        public var afterPaste: String
        public var final: String
        public var baseline: String
        public var keystrokes: Int
        public var firstKeystrokeMs: Double?
        public var lastKeystrokeMs: Double?
        public var settled: Bool
        public var durationMs: Double
        /// enter と sent のとき、送信直前の読み取り（final と同じ）。それ以外は nil
        public var preSend: String? { reason == .enter || reason == .sent ? final : nil }
    }

    public enum Verdict: Equatable, Sendable {
        case `continue`
        case end(Result)
    }

    public let before: String
    public let inserted: String
    public let startedAt: Double
    public let config: Config

    public private(set) var afterPaste: String
    public private(set) var afterPasteFixed: Bool
    /// 最新の読み取り
    public private(set) var last: String
    public private(set) var lastChangeAt: Double
    public private(set) var keystrokes = 0
    private var firstKeystrokeAt: Double?
    private var lastKeystrokeAt: Double?
    private var lastDeletionAt: Double?
    private var baseline: String?
    private var enterRead: (t: Double, text: String)?
    /// Return なしで欄が消えた。次の読み取りでも消えたままなら送信とみなす
    private var pendingSent: (t: Double, final: String, cleared: Bool)?
    private let probe: String

    /// initial は貼り付け直後の読み取り（読めなければ nil）
    public init(before: String, inserted: String, initial: String?, startedAt: Double, config: Config = Config()) {
        self.before = before
        self.inserted = inserted
        self.startedAt = startedAt
        self.config = config
        self.probe = Self.normalize(inserted).trimmingCharacters(in: .whitespacesAndNewlines)
        let first = initial ?? before
        self.afterPaste = first
        self.last = first
        self.lastChangeAt = startedAt
        self.afterPasteFixed = false
        if let initial, containsInserted(initial) { afterPasteFixed = true }
    }

    // MARK: - 入力

    /// 欄を読んだ結果を渡す。送信を検知したら .end を返す
    public mutating func observe(_ text: String, at t: Double) -> Verdict {
        if !afterPasteFixed {
            afterPaste = text
            if containsInserted(text) || t - startedAt >= config.afterPasteMaxMs { afterPasteFixed = true }
        }
        let prev = last
        if text != prev { lastChangeAt = t }
        if let p = pendingSent {
            pendingSent = nil
            let stillGone = p.cleared ? !Self.hasContent(text) : !containsInserted(text)
            if stillGone { return .end(result(.sent, final: p.final, at: t)) }
        }
        if let kind = sentKind(prev: prev, now: text, t: t) {
            if let e = enterRead, t - e.t <= config.enterAttributionMs {
                return .end(result(.enter, final: Self.hasContent(e.text) ? e.text : prev, at: t))
            }
            // Return なしで消えた。読み取りとキー入力の通知が前後した可能性があるので、次の読み取りで確かめる
            pendingSent = (t, prev, kind == .cleared)
        }
        last = text
        return .continue
    }

    /// 利用者のキー入力（自分が合成したもの、キーリピート、飲み込んだホットキーは渡さない）
    public mutating func keystroke(_ kind: WatchKey, at t: Double) {
        guard kind != .ignore else { return }
        // 消えたのは利用者の操作によるものだった
        pendingSent = nil
        if keystrokes == 0 {
            baseline = last
            firstKeystrokeAt = t
        }
        keystrokes += 1
        lastKeystrokeAt = t
        if kind == .deletion { lastDeletionAt = t }
    }

    /// Return の keyDown。text はその瞬間に読んだ値（読めなければ nil）。
    /// 手直しではないので keystrokes には数えない（送信しただけなら keystrokes は 0 のまま）
    public mutating func enter(text: String?, at t: Double) {
        pendingSent = nil
        guard let text else { return }
        enterRead = (t, text)
        // 送信で空になった後の読み取り（待ちが間に合わなかった）は、最新の値として扱わない
        if Self.hasContent(text) || !Self.hasContent(last) {
            if text != last { lastChangeAt = t }
            last = text
        }
    }

    /// 送信の検知以外の理由で終える。finalRead は終える直前に読めた値
    public mutating func end(_ reason: EndReason, at t: Double, finalRead: String? = nil) -> Result {
        if let finalRead {
            if case let .end(r) = observe(finalRead, at: t) { return r }
        }
        // 確かめ待ちの送信は、もう読み直せないので送信とみなす
        if let p = pendingSent {
            pendingSent = nil
            return result(.sent, final: p.final, at: t)
        }
        if reason == .focusChanged || reason == .elementGone, let e = enterRead, t - e.t <= config.enterAttributionMs {
            return result(.enter, final: Self.hasContent(e.text) ? e.text : last, at: t)
        }
        return result(reason, final: last, at: t)
    }

    // MARK: - 問い合わせ

    /// 時間切れで終えてよいか（settleMs の間変化がないか、待ちの上限を過ぎたか）
    public func canFinishAfterDeadline(deadline: Double, now: Double) -> Bool {
        now - lastChangeAt >= config.settleMs || now - deadline >= config.settleMaxWaitMs
    }

    public func isSettled(at t: Double) -> Bool { t - lastChangeAt >= config.settleMs }

    /// 送信の確かめのため、すぐ（150ms ほどで）読み直してほしいか
    public var wantsQuickRead: Bool { pendingSent != nil }

    /// 文字列に貼り付けた内容が見えるか（前後の空白、改行コード、NBSP の違いは無視する）
    public func containsInserted(_ text: String) -> Bool {
        if probe.isEmpty { return true }
        let s = Self.normalize(text)
        if s.contains(probe) { return true }
        // 長い文はアプリの自動変換で一部が変わることがあるので、先頭か末尾の 24 字が見えればよい
        let units = Array(probe.utf16)
        guard units.count > 48 else { return false }
        let head = TextSlicing.substring(probe, utf16Start: 0, end: 24)
        let tail = TextSlicing.substring(probe, utf16Start: units.count - 24, end: units.count)
        return s.contains(head) || s.contains(tail)
    }

    // MARK: - 内部

    private enum SentKind { case cleared, vanished }

    private func sentKind(prev: String, now: String, t: Double) -> SentKind? {
        if let d = lastDeletionAt, t - d <= config.deletionGraceMs { return nil }
        // 欄が空になった
        if !Self.hasContent(now) && Self.hasContent(prev) { return .cleared }
        // 貼り付けた文字列が消えた
        guard afterPasteFixed, containsInserted(prev), !containsInserted(now) else { return nil }
        // 直前に Return を押した、または利用者が打っていないのに消えたなら送信（空の欄にプレースホルダが出るアプリもある）
        if let e = enterRead, t - e.t <= config.enterAttributionMs { return .vanished }
        if lastKeystrokeAt.map({ t - $0 > config.typingQuietMs }) ?? true { return .vanished }
        // 打っている最中なら、書き換えと区別するため、欄が大きく短くなったときだけ
        let drop = prev.utf16.count - now.utf16.count
        return drop >= max(1, probe.utf16.count / 2) ? .vanished : nil
    }

    private func result(_ reason: EndReason, final: String, at t: Double) -> Result {
        Result(
            reason: reason,
            afterPaste: afterPaste,
            final: final,
            baseline: baseline ?? afterPaste,
            keystrokes: keystrokes,
            firstKeystrokeMs: firstKeystrokeAt.map { max(0, $0 - startedAt) },
            lastKeystrokeMs: lastKeystrokeAt.map { max(0, $0 - startedAt) },
            settled: isSettled(at: t),
            durationMs: max(0, t - startedAt)
        )
    }

    static func hasContent(_ s: String) -> Bool {
        !s.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    static func normalize(_ s: String) -> String {
        s.replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\u{00A0}", with: " ")
            .precomposedStringWithCanonicalMapping
    }
}
