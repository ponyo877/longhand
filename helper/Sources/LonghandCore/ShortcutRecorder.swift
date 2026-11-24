// In shortcut recording mode, tracks the pressed keys and the largest combination reached.

public struct ShortcutUpdate: Equatable, Sendable {
    public let keys: [String]
    public let combo: [String]
    public let done: Bool
}

public struct ShortcutRecorder: Sendable {
    /// Pressed keys (in the order pressed)
    private var pressed: [String] = []
    /// The largest combination since keys started being pressed (in display order)
    public private(set) var combo: [String] = []

    public init() {}

    public var keys: [String] { Self.ordered(pressed) }

    public mutating func reset() {
        pressed.removeAll()
        combo.removeAll()
    }

    public mutating func press(_ key: String) -> ShortcutUpdate? {
        guard !pressed.contains(key) else { return nil }
        pressed.append(key)
        if pressed.count >= combo.count {
            combo = Self.ordered(pressed)
        }
        return ShortcutUpdate(keys: keys, combo: combo, done: false)
    }

    public mutating func release(_ key: String) -> ShortcutUpdate? {
        guard let i = pressed.firstIndex(of: key) else { return nil }
        pressed.remove(at: i)
        if pressed.isEmpty {
            let update = ShortcutUpdate(keys: [], combo: combo, done: !combo.isEmpty)
            combo.removeAll()
            return update
        }
        return ShortcutUpdate(keys: keys, combo: combo, done: false)
    }

    /// Puts modifier keys first (in the order Fn, Control, Alt, Shift, Meta, left → right) and the rest in the order pressed
    static func ordered(_ keys: [String]) -> [String] {
        let mods = keys.filter(KeyTable.isModifier).sorted { KeyTable.sortKey($0) < KeyTable.sortKey($1) }
        let others = keys.filter { !KeyTable.isModifier($0) && !KeyTable.isMouse($0) }
        let mice = keys.filter(KeyTable.isMouse)
        return mods + others + mice
    }
}
