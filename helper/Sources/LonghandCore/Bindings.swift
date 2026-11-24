// ショートカット（Binding）の表現と、configure で受け取ったキー名の配列からの解析・検証。

public enum HotkeyAction: String, CaseIterable, Sendable, Codable {
    case activate
    case lock
    case cancel
    case pasteLast = "paste_last"
}

public enum HotkeyPhase: String, Sendable, Codable {
    case down
    case up
    case interrupted
}

public enum PttState: String, Sendable, Codable {
    case inactive
    case active
    case locked
    case finalizing
}

/// Binding を構成する 1 キー分の条件。"Control" のように左右を区別しない名前は、どちらの物理キーでも満たす
public struct KeySpec: Hashable, Sendable {
    /// 設定に書かれた名前
    public let name: String
    /// この条件を満たす物理キーの名前
    public let physical: Set<String>

    public init(name: String) {
        self.name = name
        self.physical = Set(KeyTable.physicalNames(for: name))
    }

    public var isModifier: Bool { ModifierKind(rawValue: name) != nil || KeyTable.isModifier(name) }
}

public struct Binding: Hashable, Sendable, CustomStringConvertible {
    public let action: HotkeyAction
    /// 同じ action の中での番号（0..2）
    public let index: Int
    public let specs: [KeySpec]

    public init(action: HotkeyAction, index: Int, keys: [String]) {
        self.action = action
        self.index = index
        self.specs = keys.map(KeySpec.init(name:))
    }

    /// 修飾キー以外（文字キー、マウスボタンなど）を含むか
    public var hasNonModifier: Bool { specs.contains { !$0.isModifier } }

    /// 押されているキーがちょうどこの Binding のキーだけか
    public func isExactlySatisfied(by down: Set<String>) -> Bool {
        guard !down.isEmpty, isHeld(by: down) else { return false }
        return down.allSatisfy { key in specs.contains { $0.physical.contains(key) } }
    }

    /// この Binding のキーがすべて押されているか（ほかのキーが一緒に押されていてもよい）
    public func isHeld(by down: Set<String>) -> Bool {
        specs.allSatisfy { !$0.physical.isDisjoint(with: down) }
    }

    /// 2 つの Binding が同じキーの組み合わせで同時に成立しうるか
    public func conflicts(with other: Binding) -> Bool {
        guard specs.count == other.specs.count else { return false }
        let a = specs.allSatisfy { s in other.specs.contains { !$0.physical.isDisjoint(with: s.physical) } }
        let b = other.specs.allSatisfy { s in specs.contains { !$0.physical.isDisjoint(with: s.physical) } }
        return a && b
    }

    public var description: String {
        "\(action.rawValue)[\(index)]=" + specs.map(\.name).joined(separator: "+")
    }

    /// Fn（地球儀キー）だけのショートカットか。地球儀キーのシステム動作を止めるのは、これがあるときだけにする（HK-6）
    public var isBareFn: Bool { specs.count == 1 && specs[0].physical == Set(["Fn"]) }

    /// ⌃⌥⌘⇧ だけでできたショートカットか（Fn も文字キーも含まない）。
    /// 押したままのクリックやスクロールで中断とみなすのは、これだけにする（HK-1）。
    /// Fn を押したままクリックして入力位置を決めてから話すのは普通の使い方なので、Fn を含むものは対象外
    public var isPlainModifierOnly: Bool {
        !specs.isEmpty && specs.allSatisfy { $0.isModifier && !$0.physical.contains("Fn") }
    }
}

public struct BindingParseResult: Sendable {
    public var bindings: [Binding]
    public var errors: [String]
}

public enum BindingParser {
    public static let maxBindingsPerAction = 3
    public static let maxKeysPerBinding = 5

    /// configure.hotkeys を解析する。受け付けられないショートカットは除外して errors に理由を入れる
    public static func parse(_ hotkeys: [String: [[String]]]) -> BindingParseResult {
        var result = BindingParseResult(bindings: [], errors: [])
        for key in hotkeys.keys.sorted() where HotkeyAction(rawValue: key) == nil {
            result.errors.append("unknown action: \(key)")
        }
        for action in HotkeyAction.allCases {
            let list = hotkeys[action.rawValue] ?? []
            for (i, keys) in list.enumerated() {
                let label = "\(action.rawValue)[\(i)]"
                if i >= maxBindingsPerAction {
                    result.errors.append("\(label): too many shortcuts (max \(maxBindingsPerAction))")
                    continue
                }
                if let err = validate(keys) {
                    result.errors.append("\(label) \(keys.joined(separator: "+")): \(err)")
                    continue
                }
                let binding = Binding(action: action, index: i, keys: keys)
                if let other = result.bindings.first(where: { $0.conflicts(with: binding) }) {
                    result.errors.append("\(label) \(keys.joined(separator: "+")): conflicts with \(other)")
                    continue
                }
                result.bindings.append(binding)
            }
        }
        return result
    }

    static func validate(_ keys: [String]) -> String? {
        if keys.isEmpty { return "empty shortcut" }
        if keys.count > maxKeysPerBinding { return "too many keys (max \(maxKeysPerBinding))" }
        var seen = Set<String>()
        for name in keys {
            if name == "CapsLock" { return "CapsLock is not supported" }
            if !KeyTable.isValidName(name) { return "unknown key name: \(name)" }
            let phys = Set(KeyTable.physicalNames(for: name))
            if !seen.isDisjoint(with: phys) { return "duplicate key: \(name)" }
            seen.formUnion(phys)
        }
        return nil
    }
}
