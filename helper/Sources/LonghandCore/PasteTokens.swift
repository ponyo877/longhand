// paste.text のインラインコマンド記法の解析。
//
//   <|BACKSPACE|>   Backspace
//   <|WAIT_n|>      n ミリ秒待つ（1..5000）
//   <|ENTER|>       Return
//   <|TAB|>         Tab
// 拡張（protocol.ts にはまだないが、先に実装しておく）:
//   <|ENTER_CMD|> <|ENTER_CTRL|> <|ENTER_SHIFT|> <|CMD_SHIFT_D|>
// 知らないトークンや範囲外の WAIT は、そのまま文字列として貼り付ける。

public struct KeyPress: Equatable, Sendable {
    /// KeyTable のキー名（"Backspace"、"Enter"、"Tab"、"KeyD" など）
    public let key: String
    public let modifiers: Set<ModifierKind>

    public init(_ key: String, _ modifiers: Set<ModifierKind> = []) {
        self.key = key
        self.modifiers = modifiers
    }
}

public enum PasteSegment: Equatable, Sendable {
    case text(String)
    case key(KeyPress)
    case wait(Int)
}

public enum PasteTokenParser {
    public static let maxWaitMs = 5000

    public static func parse(_ input: String) -> [PasteSegment] {
        var segments: [PasteSegment] = []
        var text = ""
        var rest = Substring(input)

        func flushText() {
            if !text.isEmpty {
                segments.append(.text(text))
                text = ""
            }
        }

        while let open = rest.range(of: "<|") {
            text += rest[rest.startIndex..<open.lowerBound]
            let afterOpen = rest[open.upperBound...]
            guard let close = afterOpen.range(of: "|>") else {
                text += rest[open.lowerBound...]
                rest = rest[rest.endIndex...]
                break
            }
            let name = String(afterOpen[afterOpen.startIndex..<close.lowerBound])
            if let seg = segment(forToken: name) {
                flushText()
                segments.append(seg)
                rest = afterOpen[close.upperBound...]
            } else {
                // 知らないトークン。"<|" だけを文字列として進め、残りを改めて調べる（"<|<|ENTER|>" に対応するため）
                text += "<|"
                rest = afterOpen
            }
        }
        text += rest
        flushText()
        return segments
    }

    static func segment(forToken name: String) -> PasteSegment? {
        switch name {
        case "BACKSPACE": return .key(KeyPress("Backspace"))
        case "ENTER": return .key(KeyPress("Enter"))
        case "TAB": return .key(KeyPress("Tab"))
        case "ENTER_CMD": return .key(KeyPress("Enter", [.meta]))
        case "ENTER_CTRL": return .key(KeyPress("Enter", [.control]))
        case "ENTER_SHIFT": return .key(KeyPress("Enter", [.shift]))
        case "CMD_SHIFT_D": return .key(KeyPress("KeyD", [.meta, .shift]))
        default:
            guard name.hasPrefix("WAIT_") else { return nil }
            let digits = name.dropFirst(5)
            guard !digits.isEmpty, digits.count <= 5, digits.allSatisfy(\.isASCII), digits.allSatisfy(\.isNumber),
                  let n = Int(digits), (1...maxWaitMs).contains(n) else { return nil }
            return .wait(n)
        }
    }
}
