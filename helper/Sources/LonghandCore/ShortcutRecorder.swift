// ショートカット記録モードで、押されているキーと「最大になった組み合わせ」を追跡する。

public struct ShortcutUpdate: Equatable, Sendable {
    public let keys: [String]
    public let combo: [String]
    public let done: Bool
}

public struct ShortcutRecorder: Sendable {
    /// 押されているキー（押した順）
    private var pressed: [String] = []
    /// 押下が始まってから最大になった組み合わせ（表示順に並べたもの）
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

    /// 修飾キー（Fn, Control, Alt, Shift, Meta の順、左 → 右）を先に、残りは押した順に並べる
    static func ordered(_ keys: [String]) -> [String] {
        let mods = keys.filter(KeyTable.isModifier).sorted { KeyTable.sortKey($0) < KeyTable.sortKey($1) }
        let others = keys.filter { !KeyTable.isModifier($0) && !KeyTable.isMouse($0) }
        let mice = keys.filter(KeyTable.isMouse)
        return mods + others + mice
    }
}
