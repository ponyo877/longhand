// Mapping between macOS virtual key codes (kVK_*) and the protocol's key names (following W3C KeyboardEvent.code).
//
// KeyboardEvent.code names the physical position of a key, so on both the US (ANSI) and JIS layouts
// the same key code gets the same name. Keys found only on the JIS layout (¥, _, Eisu, Kana, the keypad ,)
// have their own names (IntlYen, IntlRo, Lang2, Lang1, NumpadComma).
// The mapping follows Chromium's dom_code_data.inc (the mac column).

/// Kind of modifier key (left and right not distinguished)
public enum ModifierKind: String, CaseIterable, Sendable {
    case fn = "Fn"
    case control = "Control"
    case alt = "Alt"
    case shift = "Shift"
    case meta = "Meta"

    /// Names of the physical keys of this kind
    public var physicalNames: [String] {
        switch self {
        case .fn: return ["Fn"]
        case .control: return ["ControlLeft", "ControlRight"]
        case .alt: return ["AltLeft", "AltRight"]
        case .shift: return ["ShiftLeft", "ShiftRight"]
        case .meta: return ["MetaLeft", "MetaRight"]
        }
    }

    /// Order for display and sorting
    public var order: Int {
        switch self {
        case .fn: return 0
        case .control: return 1
        case .alt: return 2
        case .shift: return 3
        case .meta: return 4
        }
    }
}

/// Physical keyboard layout
public enum KeyboardLayoutKind: String, Sendable {
    case ansi = "ANSI"
    case iso = "ISO"
    case jis = "JIS"
}

public enum KeyTable {
    /// Key code → key name (physical keys, left and right distinguished)
    public static let nameByKeyCode: [UInt16: String] = {
        var m: [UInt16: String] = [
            // Character keys (named after the US layout legends; same positions on JIS)
            0x00: "KeyA", 0x01: "KeyS", 0x02: "KeyD", 0x03: "KeyF", 0x04: "KeyH", 0x05: "KeyG",
            0x06: "KeyZ", 0x07: "KeyX", 0x08: "KeyC", 0x09: "KeyV", 0x0A: "IntlBackslash", 0x0B: "KeyB",
            0x0C: "KeyQ", 0x0D: "KeyW", 0x0E: "KeyE", 0x0F: "KeyR", 0x10: "KeyY", 0x11: "KeyT",
            0x12: "Digit1", 0x13: "Digit2", 0x14: "Digit3", 0x15: "Digit4", 0x16: "Digit6", 0x17: "Digit5",
            0x18: "Equal", 0x19: "Digit9", 0x1A: "Digit7", 0x1B: "Minus", 0x1C: "Digit8", 0x1D: "Digit0",
            0x1E: "BracketRight", 0x1F: "KeyO", 0x20: "KeyU", 0x21: "BracketLeft", 0x22: "KeyI", 0x23: "KeyP",
            0x24: "Enter", 0x25: "KeyL", 0x26: "KeyJ", 0x27: "Quote", 0x28: "KeyK", 0x29: "Semicolon",
            0x2A: "Backslash", 0x2B: "Comma", 0x2C: "Slash", 0x2D: "KeyN", 0x2E: "KeyM", 0x2F: "Period",
            0x30: "Tab", 0x31: "Space", 0x32: "Backquote", 0x33: "Backspace", 0x35: "Escape",
            // Modifier keys
            0x36: "MetaRight", 0x37: "MetaLeft", 0x38: "ShiftLeft", 0x39: "CapsLock", 0x3A: "AltLeft",
            0x3B: "ControlLeft", 0x3C: "ShiftRight", 0x3D: "AltRight", 0x3E: "ControlRight", 0x3F: "Fn",
            // Numeric keypad
            0x41: "NumpadDecimal", 0x43: "NumpadMultiply", 0x45: "NumpadAdd", 0x47: "NumLock",
            0x4B: "NumpadDivide", 0x4C: "NumpadEnter", 0x4E: "NumpadSubtract", 0x51: "NumpadEqual",
            0x52: "Numpad0", 0x53: "Numpad1", 0x54: "Numpad2", 0x55: "Numpad3", 0x56: "Numpad4",
            0x57: "Numpad5", 0x58: "Numpad6", 0x59: "Numpad7", 0x5B: "Numpad8", 0x5C: "Numpad9",
            // Volume
            0x48: "AudioVolumeUp", 0x49: "AudioVolumeDown", 0x4A: "AudioVolumeMute",
            // Keys only on the JIS layout
            0x5D: "IntlYen", 0x5E: "IntlRo", 0x5F: "NumpadComma", 0x66: "Lang2", 0x68: "Lang1",
            // Function keys
            0x7A: "F1", 0x78: "F2", 0x63: "F3", 0x76: "F4", 0x60: "F5", 0x61: "F6", 0x62: "F7",
            0x64: "F8", 0x65: "F9", 0x6D: "F10", 0x67: "F11", 0x6F: "F12", 0x69: "F13", 0x6B: "F14",
            0x71: "F15", 0x6A: "F16", 0x40: "F17", 0x4F: "F18", 0x50: "F19", 0x5A: "F20",
            // Editing and navigation
            0x6E: "ContextMenu", 0x72: "Insert", 0x73: "Home", 0x74: "PageUp", 0x75: "Delete",
            0x77: "End", 0x79: "PageDown", 0x7B: "ArrowLeft", 0x7C: "ArrowRight", 0x7D: "ArrowDown",
            0x7E: "ArrowUp",
        ]
        // The Globe key on newer Macs can report 0xB3. Treat it the same as Fn (the reverse lookup gives 0x3F).
        m[0xB3] = "Fn"
        return m
    }()

    /// Key name → key code (reverse lookup)
    public static let keyCodeByName: [String: UInt16] = {
        var m: [String: UInt16] = [:]
        for (code, name) in nameByKeyCode where m[name] == nil || code < m[name]! {
            m[name] = code
        }
        return m
    }()

    /// Mouse button names (CGEvent buttonNumber → name). 0 = left and 1 = right are not handled
    public static let mouseNameByButton: [Int64: String] = [2: "Mouse3", 3: "Mouse4", 4: "Mouse5"]
    public static let mouseButtonByName: [String: Int64] = ["Mouse3": 2, "Mouse4": 3, "Mouse5": 4]

    /// Keys that exist only on the JIS layout
    public static let jisOnlyNames: Set<String> = ["IntlYen", "IntlRo", "NumpadComma", "Lang2", "Lang1"]

    /// Gets the modifier kind from a physical key name (nil if it is not a modifier). CapsLock is not treated as a modifier
    public static func modifierKind(ofPhysical name: String) -> ModifierKind? {
        switch name {
        case "Fn": return .fn
        case "ControlLeft", "ControlRight": return .control
        case "AltLeft", "AltRight": return .alt
        case "ShiftLeft", "ShiftRight": return .shift
        case "MetaLeft", "MetaRight": return .meta
        default: return nil
        }
    }

    public static func isModifier(_ physicalName: String) -> Bool {
        modifierKind(ofPhysical: physicalName) != nil
    }

    public static func isMouse(_ name: String) -> Bool {
        mouseButtonByName[name] != nil
    }

    /// Whether the key name is valid in the protocol (including modifier names that do not distinguish left and right)
    public static func isValidName(_ name: String) -> Bool {
        if ModifierKind(rawValue: name) != nil { return true }
        if keyCodeByName[name] != nil { return name != "CapsLock" }
        return isMouse(name)
    }

    /// Expands a key name into a set of physical key names ("Control" → ControlLeft/ControlRight)
    public static func physicalNames(for name: String) -> [String] {
        if let kind = ModifierKind(rawValue: name) { return kind.physicalNames }
        return [name]
    }

    /// Sort order (modifier keys → everything else)
    public static func sortKey(_ name: String) -> (Int, Int, String) {
        if let kind = modifierKind(ofPhysical: name) ?? ModifierKind(rawValue: name) {
            let sideOrder = name.hasSuffix("Right") ? 1 : 0
            return (0, kind.order * 2 + sideOrder, name)
        }
        if isMouse(name) { return (2, 0, name) }
        return (1, 0, name)
    }

    /// Determines the physical keyboard layout (from the return value of Carbon's KBGetLayoutType)
    /// The return value is a four-character OSType code: kKeyboardJIS = 'JIS ', kKeyboardANSI = 'ANSI', kKeyboardISO = 'ISO '
    public static func layoutKind(fromKBLayoutType value: UInt32) -> KeyboardLayoutKind {
        switch value {
        case 0x4A49_5320: return .jis // 'JIS '
        case 0x4953_4F20: return .iso // 'ISO '
        default: return .ansi
        }
    }
}
