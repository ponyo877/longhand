import Foundation

// Decisions for watching the field after a paste (PST-9, learning). Pure logic kept apart from the OS, verified with XCTest.
//
// The helper's FieldWatcher passes field reads (observe) and the user's key input (keystroke, enter) here,
// and this decides whether to stop watching and which last value (final) learning uses.
//
// Rules:
// - afterPaste: read again until the pasted text shows up in the field (up to afterPasteMaxMs). If it never shows up, the last read.
// - Send detection: stop watching when the field becomes empty, or when the pasted text disappears and the field gets much shorter.
//   final is the read just before that. If Return had a keyDown just before, the reason is enter and the read at the keyDown moment is used.
//   Getting shorter right after Backspace or ⌘X is the user editing, so it is not taken as a send.
// - Key input: arrows, navigation, Esc, F keys, ⌘C and the like, and Return, are not counted. The read just before the first keystroke
//   becomes the baseline (to tell the app's automatic conversions and late-arriving pastes apart from the user's edits).
// - Settling: when ending on a timeout, wait up to settleMaxWaitMs for settleMs without changes (the caller decides).

/// Classification of key input while watching
public enum WatchKey: Equatable, Sendable {
    /// Not counted (arrows, Home/End, PageUp/PageDown, Esc, Tab, F keys, ⌘A, ⌘C and so on)
    case ignore
    /// Typing characters, ⌘V, ⌘Z and so on
    case edit
    /// Backspace, Delete, ⌘X, ⌃H and so on (the field getting shorter right after is not taken as a send)
    case deletion
    /// Return, or Enter on the numeric keypad (with or without modifiers)
    case enter

    private static let navigation: Set<String> = [
        "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown",
        "Escape", "Tab", "Insert", "ContextMenu", "Lang1", "Lang2", "Help",
    ]

    /// keyName is a KeyTable name ("KeyA", "Enter" and so on)
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
            // Emacs-style keys of Cocoa text editing
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
        /// How long afterPaste is read again until the pasted text shows up in the field
        public var afterPasteMaxMs: Double = 1000
        /// How long to confirm there are no changes before the last read
        public var settleMs: Double = 1000
        /// Longest wait for things to settle after the timeout
        public var settleMaxWaitMs: Double = 1500
        /// If the field clears within this time of a Return keyDown, the reason is enter
        public var enterAttributionMs: Double = 3000
        /// Getting shorter within this time of a deletion key is not taken as a send
        public var deletionGraceMs: Double = 400
        /// Once this much time has passed since the last keystroke, the user counts as "not typing"
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
        /// For enter and sent, the read just before sending (same as final). Otherwise nil
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
    /// The latest read
    public private(set) var last: String
    public private(set) var lastChangeAt: Double
    public private(set) var keystrokes = 0
    private var firstKeystrokeAt: Double?
    private var lastKeystrokeAt: Double?
    private var lastDeletionAt: Double?
    private var baseline: String?
    private var enterRead: (t: Double, text: String)?
    /// The field cleared without Return. If it is still gone on the next read, it is taken as a send
    private var pendingSent: (t: Double, final: String, cleared: Bool)?
    private let probe: String

    /// initial is the read right after the paste (nil if it could not be read)
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

    // MARK: - Input

    /// Takes the result of reading the field. Returns .end when a send is detected
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
            // Gone without Return. The read and the keystroke notification may have arrived out of order, so check on the next read
            pendingSent = (t, prev, kind == .cleared)
        }
        last = text
        return .continue
    }

    /// The user's key input (keys this process synthesized, key repeats and swallowed hotkeys are not passed)
    public mutating func keystroke(_ kind: WatchKey, at t: Double) {
        guard kind != .ignore else { return }
        // The text disappeared because of something the user did
        pendingSent = nil
        if keystrokes == 0 {
            baseline = last
            firstKeystrokeAt = t
        }
        keystrokes += 1
        lastKeystrokeAt = t
        if kind == .deletion { lastDeletionAt = t }
    }

    /// A Return keyDown. text is the value read at that moment (nil if it could not be read).
    /// Not an edit, so it is not counted in keystrokes (if the user only sent, keystrokes stays 0)
    public mutating func enter(text: String?, at t: Double) {
        pendingSent = nil
        guard let text else { return }
        enterRead = (t, text)
        // A read taken after the send emptied the field (the wait was too late) is not treated as the latest value
        if Self.hasContent(text) || !Self.hasContent(last) {
            if text != last { lastChangeAt = t }
            last = text
        }
    }

    /// Ends for a reason other than send detection. finalRead is the value read just before ending
    public mutating func end(_ reason: EndReason, at t: Double, finalRead: String? = nil) -> Result {
        if let finalRead {
            if case let .end(r) = observe(finalRead, at: t) { return r }
        }
        // A send waiting for confirmation can no longer be read again, so it is taken as a send
        if let p = pendingSent {
            pendingSent = nil
            return result(.sent, final: p.final, at: t)
        }
        if reason == .focusChanged || reason == .elementGone, let e = enterRead, t - e.t <= config.enterAttributionMs {
            return result(.enter, final: Self.hasContent(e.text) ? e.text : last, at: t)
        }
        return result(reason, final: last, at: t)
    }

    // MARK: - Queries

    /// Whether it may end on the timeout (no changes for settleMs, or past the longest wait)
    public func canFinishAfterDeadline(deadline: Double, now: Double) -> Bool {
        now - lastChangeAt >= config.settleMs || now - deadline >= config.settleMaxWaitMs
    }

    public func isSettled(at t: Double) -> Bool { t - lastChangeAt >= config.settleMs }

    /// Whether to read again soon (in about 150 ms) to confirm a send
    public var wantsQuickRead: Bool { pendingSent != nil }

    /// Whether the pasted content shows up in the text (ignores differences in surrounding whitespace, line endings and NBSP)
    public func containsInserted(_ text: String) -> Bool {
        if probe.isEmpty { return true }
        let s = Self.normalize(text)
        if s.contains(probe) { return true }
        // The app's automatic conversions can change part of a long sentence, so seeing the first or last 24 characters is enough
        let units = Array(probe.utf16)
        guard units.count > 48 else { return false }
        let head = TextSlicing.substring(probe, utf16Start: 0, end: 24)
        let tail = TextSlicing.substring(probe, utf16Start: units.count - 24, end: units.count)
        return s.contains(head) || s.contains(tail)
    }

    // MARK: - Internals

    private enum SentKind { case cleared, vanished }

    private func sentKind(prev: String, now: String, t: Double) -> SentKind? {
        if let d = lastDeletionAt, t - d <= config.deletionGraceMs { return nil }
        // The field became empty
        if !Self.hasContent(now) && Self.hasContent(prev) { return .cleared }
        // The pasted text disappeared
        guard afterPasteFixed, containsInserted(prev), !containsInserted(now) else { return nil }
        // A send if Return was just pressed, or if it disappeared while the user was not typing (some apps show a placeholder in an empty field)
        if let e = enterRead, t - e.t <= config.enterAttributionMs { return .vanished }
        if lastKeystrokeAt.map({ t - $0 > config.typingQuietMs }) ?? true { return .vanished }
        // While the user is typing, only when the field gets much shorter, to tell it apart from rewriting
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
