// Representation of shortcuts (Binding), and parsing and validation of the key name arrays received in configure.

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

/// The condition for one key of a Binding. A name that does not distinguish left and right, such as "Control", is satisfied by either physical key
public struct KeySpec: Hashable, Sendable {
    /// The name written in the settings
    public let name: String
    /// Names of the physical keys that satisfy this condition
    public let physical: Set<String>

    public init(name: String) {
        self.name = name
        self.physical = Set(KeyTable.physicalNames(for: name))
    }

    public var isModifier: Bool { ModifierKind(rawValue: name) != nil || KeyTable.isModifier(name) }
}

public struct Binding: Hashable, Sendable, CustomStringConvertible {
    public let action: HotkeyAction
    /// Number within the same action (0..2)
    public let index: Int
    public let specs: [KeySpec]

    public init(action: HotkeyAction, index: Int, keys: [String]) {
        self.action = action
        self.index = index
        self.specs = keys.map(KeySpec.init(name:))
    }

    /// Whether it includes a non-modifier (a character key, a mouse button and so on)
    public var hasNonModifier: Bool { specs.contains { !$0.isModifier } }

    /// Whether the pressed keys are exactly this Binding's keys
    public func isExactlySatisfied(by down: Set<String>) -> Bool {
        guard !down.isEmpty, isHeld(by: down) else { return false }
        return down.allSatisfy { key in specs.contains { $0.physical.contains(key) } }
    }

    /// Whether all of this Binding's keys are pressed (other keys may be pressed too)
    public func isHeld(by down: Set<String>) -> Bool {
        specs.allSatisfy { !$0.physical.isDisjoint(with: down) }
    }

    /// Whether the two Bindings can match at the same time on the same key combination
    public func conflicts(with other: Binding) -> Bool {
        guard specs.count == other.specs.count else { return false }
        let a = specs.allSatisfy { s in other.specs.contains { !$0.physical.isDisjoint(with: s.physical) } }
        let b = other.specs.allSatisfy { s in specs.contains { !$0.physical.isDisjoint(with: s.physical) } }
        return a && b
    }

    public var description: String {
        "\(action.rawValue)[\(index)]=" + specs.map(\.name).joined(separator: "+")
    }

    /// Whether the shortcut is Fn (the Globe key) alone. The Globe key's system action is suppressed only when such a shortcut exists (HK-6)
    public var isBareFn: Bool { specs.count == 1 && specs[0].physical == Set(["Fn"]) }

    /// Whether the shortcut is made only of ⌃⌥⌘⇧ (no Fn and no character key).
    /// Only these are treated as interrupted by a click or scroll while held (HK-1).
    /// Holding Fn, clicking to place the cursor and then speaking is normal use, so shortcuts with Fn are excluded
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

    /// Parses configure.hotkeys. Shortcuts that cannot be accepted are left out, with the reason added to errors
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
