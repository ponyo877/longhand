// Hotkey matching (a state machine). Pure logic kept apart from OS events, verified with XCTest.
//
// Rules:
// - A Binding matches the moment the pressed keys are exactly that Binding's keys, and emits phase "down".
//   Only a key press can trigger a match. A shorter Binding that becomes an exact match because a key was released does not fire
//   (releasing only Space from Fn+Space does not fire activate).
// - A Binding that includes a character key or a mouse button matches only on the press of a non-modifier key
//   (pressing Fn while holding Space does not match Fn+Space).
// - A matched Binding stays "held" until any of its keys is released, and emits "up" at that point.
// - When another key is pressed while a Binding is held:
//   - If that key makes a longer Binding containing the held one an exact match (Fn → Fn+Space),
//     only the longer one's "down" is emitted. The shorter one stays held and emits neither "up" nor "interrupted".
//     The shorter one's "up" is emitted when its own key (Fn) is released.
//     Fn → Space → release Space → release Fn gives activate:down, lock:down, lock:up, activate:up.
//   - Otherwise, for activate only, "interrupted" is emitted once (Fn+Delete and so on). It stays held.
// - Swallowing: a non-modifier key that completed a Binding (Space in Fn+Space and so on) has its press, repeats and release all swallowed.
//   A cancel Binding is swallowed only while PTT is in a session (anything but inactive). Modifier keys are never swallowed.
// - recording (recording a shortcut) stops matching and swallows every non-modifier key.

public struct HotkeyEvent: Equatable, Sendable, CustomStringConvertible {
    public let action: HotkeyAction
    public let phase: HotkeyPhase

    public init(_ action: HotkeyAction, _ phase: HotkeyPhase) {
        self.action = action
        self.phase = phase
    }

    public var description: String { "\(action.rawValue):\(phase.rawValue)" }
}

public struct MatchOutput: Equatable, Sendable {
    public var events: [HotkeyEvent] = []
    /// Whether to swallow this event
    public var swallow: Bool = false

    public init(events: [HotkeyEvent] = [], swallow: Bool = false) {
        self.events = events
        self.swallow = swallow
    }
}

public struct HotkeyMatcher: Sendable {
    public private(set) var bindings: [Binding] = []
    /// Physical keys pressed right now
    public private(set) var down: Set<String> = []
    /// Keys whose press was swallowed (their repeats and release are swallowed too)
    public private(set) var swallowed: Set<String> = []
    /// Held Bindings (index into bindings → whether interrupted was emitted)
    private var held: [Int: Bool] = [:]
    /// The order in which held Bindings matched. When released together, "up" is emitted newest first (lock:up → activate:up)
    private var firedOrder: [Int: Int] = [:]
    private var orderCounter = 0

    public var pttState: PttState = .inactive
    public private(set) var recording = false

    public init(bindings: [Binding] = []) {
        self.bindings = bindings
    }

    /// Held Bindings
    public var heldBindings: [Binding] { held.keys.sorted().map { bindings[$0] } }

    /// Returns the held indices, newest match first
    private var heldNewestFirst: [Int] {
        held.keys.sorted { (firedOrder[$0] ?? 0) > (firedOrder[$1] ?? 0) }
    }

    // MARK: - Configuration

    /// Replaces the Bindings. Emits "up" for held ones
    public mutating func setBindings(_ newBindings: [Binding]) -> MatchOutput {
        let out = releaseAllHeld()
        bindings = newBindings
        return out
    }

    /// Turns recording mode on or off. Entering it emits "up" for held Bindings
    public mutating func setRecording(_ on: Bool) -> MatchOutput {
        guard on != recording else { return MatchOutput() }
        recording = on
        return on ? releaseAllHeld() : MatchOutput()
    }

    private mutating func releaseAllHeld() -> MatchOutput {
        var out = MatchOutput()
        for idx in heldNewestFirst {
            out.events.append(HotkeyEvent(bindings[idx].action, .up))
        }
        held.removeAll()
        firedOrder.removeAll()
        return out
    }

    // MARK: - Input

    /// Whether an activate made only of ⌃⌥⌘⇧ is held without having emitted interrupted yet
    public var holdsPointerInterruptibleActivate: Bool {
        held.contains { idx, interrupted in
            !interrupted && bindings[idx].action == .activate && bindings[idx].isPlainModifierOnly
        }
    }

    /// Emits "interrupted" once for a held activate made only of ⌃⌥⌘⇧.
    /// Used when there is a click or scroll while it is held (a click with ⌘ held down and so on. HK-1). Not emitted for ones that include Fn
    public mutating func interruptOnPointer() -> MatchOutput {
        var out = MatchOutput()
        for idx in held.keys.sorted() where held[idx] == false {
            let b = bindings[idx]
            guard b.action == .activate, b.isPlainModifierOnly else { continue }
            held[idx] = true
            if out.events.isEmpty { out.events.append(HotkeyEvent(.activate, .interrupted)) }
        }
        return out
    }

    /// A key press. isRepeat is a key repeat (kCGKeyboardEventAutorepeat)
    public mutating func press(_ key: String, isRepeat: Bool = false) -> MatchOutput {
        if isRepeat {
            return MatchOutput(swallow: swallowed.contains(key))
        }
        var out = MatchOutput()
        if down.contains(key) {
            // The release was missed. Treat the key as released first, then handle this as a press
            out = release(key)
        }
        down.insert(key)
        let isModifierKey = KeyTable.isModifier(key)

        if recording {
            if !isModifierKey {
                swallowed.insert(key)
                out.swallow = true
            }
            return out
        }

        // Bindings that this press makes an exact match (excluding held ones)
        var fired: [Int] = []
        for (idx, b) in bindings.enumerated() where held[idx] == nil {
            if b.hasNonModifier && isModifierKey { continue }
            if b.isExactlySatisfied(by: down) { fired.append(idx) }
        }

        // Effect on held Bindings. If the press matched another Binding (fired exactly matches down, so it is
        // a longer Binding containing the held b), emit nothing. b's "up" is emitted when b's own key is released
        for idx in held.keys.sorted() {
            let b = bindings[idx]
            if b.isExactlySatisfied(by: down) { continue } // Left and right modifier keys both down, for example
            if fired.isEmpty && b.action == .activate && held[idx] == false {
                held[idx] = true
                out.events.append(HotkeyEvent(.activate, .interrupted))
            }
        }

        for idx in fired {
            held[idx] = false
            orderCounter += 1
            firedOrder[idx] = orderCounter
            out.events.append(HotkeyEvent(bindings[idx].action, .down))
        }

        if !isModifierKey && fired.contains(where: { shouldSwallow(bindings[$0]) }) {
            swallowed.insert(key)
            out.swallow = true
        }
        return out
    }

    /// A key release
    public mutating func release(_ key: String) -> MatchOutput {
        var out = MatchOutput()
        out.swallow = swallowed.remove(key) != nil
        guard down.remove(key) != nil else { return out }
        for idx in heldNewestFirst where !bindings[idx].isHeld(by: down) {
            held[idx] = nil
            firedOrder[idx] = nil
            out.events.append(HotkeyEvent(bindings[idx].action, .up))
        }
        return out
    }

    /// Releases keys thought to be down that were actually released (guards against missed events)
    public mutating func releaseStale(_ keys: [String]) -> MatchOutput {
        var out = MatchOutput()
        for key in keys {
            let r = release(key)
            out.events.append(contentsOf: r.events)
        }
        return out
    }

    private func shouldSwallow(_ b: Binding) -> Bool {
        switch b.action {
        case .cancel: return pttState != .inactive
        case .activate, .lock, .pasteLast: return true
        }
    }
}
