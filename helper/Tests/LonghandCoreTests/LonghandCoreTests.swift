import XCTest
@testable import LonghandCore

final class KeyTableTests: XCTestCase {
    func testUSKeys() {
        XCTAssertEqual(KeyTable.nameByKeyCode[0x00], "KeyA")
        XCTAssertEqual(KeyTable.nameByKeyCode[0x09], "KeyV")
        XCTAssertEqual(KeyTable.nameByKeyCode[0x31], "Space")
        XCTAssertEqual(KeyTable.nameByKeyCode[0x35], "Escape")
        XCTAssertEqual(KeyTable.nameByKeyCode[0x33], "Backspace")
        XCTAssertEqual(KeyTable.nameByKeyCode[0x75], "Delete")
        XCTAssertEqual(KeyTable.nameByKeyCode[0x24], "Enter")
        XCTAssertEqual(KeyTable.nameByKeyCode[0x32], "Backquote")
        XCTAssertEqual(KeyTable.nameByKeyCode[0x7A], "F1")
        XCTAssertEqual(KeyTable.nameByKeyCode[0x5A], "F20")
        XCTAssertEqual(KeyTable.nameByKeyCode[0x7E], "ArrowUp")
    }

    func testModifierKeys() {
        XCTAssertEqual(KeyTable.nameByKeyCode[0x3F], "Fn")
        XCTAssertEqual(KeyTable.nameByKeyCode[0xB3], "Fn")
        XCTAssertEqual(KeyTable.keyCodeByName["Fn"], 0x3F)
        XCTAssertEqual(KeyTable.nameByKeyCode[0x37], "MetaLeft")
        XCTAssertEqual(KeyTable.nameByKeyCode[0x36], "MetaRight")
        XCTAssertEqual(KeyTable.nameByKeyCode[0x3B], "ControlLeft")
        XCTAssertEqual(KeyTable.nameByKeyCode[0x3E], "ControlRight")
        XCTAssertEqual(KeyTable.modifierKind(ofPhysical: "AltRight"), .alt)
        XCTAssertNil(KeyTable.modifierKind(ofPhysical: "CapsLock"))
    }

    func testJISKeys() {
        XCTAssertEqual(KeyTable.nameByKeyCode[0x5D], "IntlYen")
        XCTAssertEqual(KeyTable.nameByKeyCode[0x5E], "IntlRo")
        XCTAssertEqual(KeyTable.nameByKeyCode[0x66], "Lang2") // Eisu (英数)
        XCTAssertEqual(KeyTable.nameByKeyCode[0x68], "Lang1") // Kana (かな)
        XCTAssertEqual(KeyTable.nameByKeyCode[0x5F], "NumpadComma")
        for name in KeyTable.jisOnlyNames {
            XCTAssertNotNil(KeyTable.keyCodeByName[name], name)
        }
        // The "@" key on the JIS layout is in the same position as [ on US (BracketLeft)
        XCTAssertEqual(KeyTable.keyCodeByName["BracketLeft"], 0x21)
    }

    func testRoundTrip() {
        for (name, code) in KeyTable.keyCodeByName {
            XCTAssertEqual(KeyTable.nameByKeyCode[code], name)
        }
    }

    func testValidNames() {
        for n in ["Fn", "Control", "MetaLeft", "KeyZ", "Digit0", "F12", "Mouse3", "Mouse5", "IntlYen", "Lang1"] {
            XCTAssertTrue(KeyTable.isValidName(n), n)
        }
        for n in ["Mouse1", "Mouse2", "CapsLock", "Cmd", "keya", ""] {
            XCTAssertFalse(KeyTable.isValidName(n), n)
        }
    }

    func testLayoutKind() {
        XCTAssertEqual(KeyTable.layoutKind(fromKBLayoutType: 0x4A49_5320), .jis)
        XCTAssertEqual(KeyTable.layoutKind(fromKBLayoutType: 0x414E_5349), .ansi)
        XCTAssertEqual(KeyTable.layoutKind(fromKBLayoutType: 0x4953_4F20), .iso)
    }
}

final class ShortcutRecorderTests: XCTestCase {
    func testComboIsMaximum() {
        var r = ShortcutRecorder()
        XCTAssertEqual(r.press("MetaLeft"), ShortcutUpdate(keys: ["MetaLeft"], combo: ["MetaLeft"], done: false))
        XCTAssertEqual(r.press("KeyK")?.combo, ["MetaLeft", "KeyK"])
        XCTAssertEqual(r.press("ControlLeft")?.combo, ["ControlLeft", "MetaLeft", "KeyK"])
        XCTAssertEqual(r.release("KeyK"), ShortcutUpdate(keys: ["ControlLeft", "MetaLeft"], combo: ["ControlLeft", "MetaLeft", "KeyK"], done: false))
        XCTAssertNil(r.press("MetaLeft"), "already pressed")
        _ = r.release("MetaLeft")
        XCTAssertEqual(r.release("ControlLeft"), ShortcutUpdate(keys: [], combo: ["ControlLeft", "MetaLeft", "KeyK"], done: true))
        // The next recording starts empty
        XCTAssertEqual(r.press("Fn")?.combo, ["Fn"])
    }

    func testOrdering() {
        var r = ShortcutRecorder()
        _ = r.press("KeyV")
        _ = r.press("MetaRight")
        _ = r.press("Fn")
        _ = r.press("Mouse4")
        XCTAssertEqual(r.keys, ["Fn", "MetaRight", "KeyV", "Mouse4"])
    }

    func testReleaseUnknownKey() {
        var r = ShortcutRecorder()
        XCTAssertNil(r.release("KeyA"))
    }
}

final class PasteTokenTests: XCTestCase {
    func testPlainText() {
        XCTAssertEqual(PasteTokenParser.parse("こんにちは"), [.text("こんにちは")])
        XCTAssertEqual(PasteTokenParser.parse(""), [])
    }

    func testTokensInOrder() {
        XCTAssertEqual(PasteTokenParser.parse("<|BACKSPACE|>新しい文<|WAIT_100|><|TAB|>x<|ENTER|>"), [
            .key(KeyPress("Backspace")), .text("新しい文"), .wait(100), .key(KeyPress("Tab")), .text("x"), .key(KeyPress("Enter")),
        ])
    }

    func testUnknownTokensAreLiteral() {
        XCTAssertEqual(PasteTokenParser.parse("a<|FOO|>b"), [.text("a<|FOO|>b")])
        XCTAssertEqual(PasteTokenParser.parse("<|WAIT_0|><|WAIT_6000|><|WAIT_x|>"), [.text("<|WAIT_0|><|WAIT_6000|><|WAIT_x|>")])
        XCTAssertEqual(PasteTokenParser.parse("a <| b |> c"), [.text("a <| b |> c")])
        XCTAssertEqual(PasteTokenParser.parse("unterminated <|ENTER"), [.text("unterminated <|ENTER")])
    }

    func testNestedOpenBeforeToken() {
        XCTAssertEqual(PasteTokenParser.parse("<|<|ENTER|>"), [.text("<|"), .key(KeyPress("Enter"))])
    }

    func testExtendedTokens() {
        XCTAssertEqual(PasteTokenParser.parse("<|ENTER_CMD|><|CMD_SHIFT_D|>"), [
            .key(KeyPress("Enter", [.meta])), .key(KeyPress("KeyD", [.meta, .shift])),
        ])
    }

    func testWaitBounds() {
        XCTAssertEqual(PasteTokenParser.parse("<|WAIT_1|><|WAIT_5000|>"), [.wait(1), .wait(5000)])
    }
}

final class AudioChunkerTests: XCTestCase {
    func testChunking() {
        var c = AudioChunker(chunkSize: 4)
        XCTAssertEqual(c.append([1, 2, 3]), [])
        XCTAssertEqual(c.append([4, 5, 6, 7, 8, 9]), [[1, 2, 3, 4], [5, 6, 7, 8]])
        XCTAssertEqual(c.flush(), [9])
        XCTAssertNil(c.flush())
    }

    func testRmsPeakAndBase64() {
        let s: [Float] = [0.5, -0.5, 0.5, -0.5]
        XCTAssertEqual(AudioMath.rms(s), 0.5, accuracy: 1e-6)
        XCTAssertEqual(AudioMath.peak([0.1, -0.9, 0.3]), 0.9, accuracy: 1e-6)
        XCTAssertEqual(AudioMath.rms([]), 0)
        let b64 = AudioMath.base64Float32LE([1.0, -2.5])
        // 1.0f = 0x3F800000 → LE 00 00 80 3F
        XCTAssertEqual(Data(base64Encoded: b64).map(Array.init), [0x00, 0x00, 0x80, 0x3F, 0x00, 0x00, 0x20, 0xC0])
        XCTAssertEqual(AudioMath.decodeFloat32LE(b64), [1.0, -2.5])
    }
}

final class TextSlicingTests: XCTestCase {
    func testBeforeAfter() {
        let s = "abcdefghij"
        XCTAssertEqual(TextSlicing.before(s, location: 5, maxChars: 3), "cde")
        XCTAssertEqual(TextSlicing.before(s, location: 2, maxChars: 10), "ab")
        XCTAssertEqual(TextSlicing.after(s, location: 7, maxChars: 10), "hij")
        XCTAssertEqual(TextSlicing.after(s, location: 20, maxChars: 10), "")
    }

    func testSurrogatePairsAreNotSplit() {
        let s = "a😀b" // UTF-16: a, D83D, DE00, b
        XCTAssertEqual(TextSlicing.substring(s, utf16Start: 2, end: 4), "b")
        XCTAssertEqual(TextSlicing.substring(s, utf16Start: 0, end: 2), "a")
        XCTAssertEqual(TextSlicing.substring(s, utf16Start: 1, end: 3), "😀")
        XCTAssertEqual(TextSlicing.before(s, location: 4, maxChars: 2), "b")
    }

    func testJapanese() {
        let s = "今日は良い天気です"
        XCTAssertEqual(TextSlicing.before(s, location: 3, maxChars: 1000), "今日は")
        XCTAssertEqual(TextSlicing.after(s, location: 5, maxChars: 2), "天気")
    }

    func testWindow() {
        let s = String(repeating: "x", count: 100) + "CARET" + String(repeating: "y", count: 100)
        let w = TextSlicing.window(s, center: 102, maxChars: 20)
        XCTAssertEqual(w.utf16.count, 20)
        XCTAssertTrue(w.contains("CA"))
        XCTAssertEqual(TextSlicing.window("short", center: 0, maxChars: 20), "short")
        XCTAssertEqual(TextSlicing.window(s, center: 0, maxChars: 10), String(repeating: "x", count: 10))
    }

    func testLooselyEqual() {
        XCTAssertTrue(TextSlicing.looselyEqual(" hello\r\nworld ", "hello\nworld"))
        XCTAssertTrue(TextSlicing.looselyEqual("e\u{301}", "é"))
        XCTAssertFalse(TextSlicing.looselyEqual("hello", "hullo"))
    }
}

final class GlobePolicyTests: XCTestCase {
    let receipt = GlobeReceipt(originalValue: 2, appliedValue: 0, pid: 123, createdAt: "x")

    func testRestoreWhenUnchanged() {
        XCTAssertEqual(GlobePolicy.release(receipt: receipt, currentValue: 0), .restore(2))
    }

    func testDiscardWhenUserChanged() {
        XCTAssertEqual(GlobePolicy.release(receipt: receipt, currentValue: 1), .discard)
    }

    func testRecoveryLeavesLiveOwner() {
        XCTAssertEqual(GlobePolicy.recovery(receipt: receipt, currentValue: 0, ownerAlive: true), .leave)
        XCTAssertEqual(GlobePolicy.recovery(receipt: receipt, currentValue: 0, ownerAlive: false), .restore(2))
    }

    func testReceiptCodable() throws {
        let data = try JSONEncoder().encode(receipt)
        XCTAssertEqual(try JSONDecoder().decode(GlobeReceipt.self, from: data), receipt)
    }
}
