import XCTest
@testable import LonghandCore

final class HotkeyMatcherTests: XCTestCase {
    /// 既定値に近い設定
    func defaultMatcher(extra: [String: [[String]]] = [:]) -> HotkeyMatcher {
        var config: [String: [[String]]] = [
            "activate": [["Fn"], ["ControlLeft", "AltLeft"]],
            "lock": [["Fn", "Space"]],
            "cancel": [["Escape"]],
            "paste_last": [["Meta", "Control", "KeyV"]],
        ]
        for (k, v) in extra { config[k] = v }
        let parsed = BindingParser.parse(config)
        XCTAssertEqual(parsed.errors, [])
        return HotkeyMatcher(bindings: parsed.bindings)
    }

    func ev(_ a: HotkeyAction, _ p: HotkeyPhase) -> HotkeyEvent { HotkeyEvent(a, p) }

    func testFnAloneDownUp() {
        var m = defaultMatcher()
        XCTAssertEqual(m.press("Fn"), MatchOutput(events: [ev(.activate, .down)], swallow: false))
        XCTAssertEqual(m.release("Fn"), MatchOutput(events: [ev(.activate, .up)], swallow: false))
    }

    func testFnSpaceLockWinsOverActivateAndSwallowsSpace() {
        var m = defaultMatcher()
        _ = m.press("Fn")
        let out = m.press("Space")
        // 長いほうの down だけ。activate は保持を続け、up も interrupted も出さない
        XCTAssertEqual(out.events, [ev(.lock, .down)])
        XCTAssertTrue(out.swallow)
        // Space のリピートと解放も飲み込む
        XCTAssertEqual(m.press("Space", isRepeat: true), MatchOutput(events: [], swallow: true))
        XCTAssertEqual(m.release("Space"), MatchOutput(events: [ev(.lock, .up)], swallow: true))
        // activate の up は Fn を離したときに出る（新たな activate:down は出ない）
        XCTAssertEqual(m.release("Fn"), MatchOutput(events: [ev(.activate, .up)], swallow: false))
    }

    func testFnSpaceToggleWhileHoldingFn() {
        var m = defaultMatcher()
        _ = m.press("Fn")
        XCTAssertEqual(m.press("Space").events, [ev(.lock, .down)])
        XCTAssertEqual(m.release("Space").events, [ev(.lock, .up)])
        // もう一度 Space → lock down（main 側でトグル）。activate は保持中のまま
        let again = m.press("Space")
        XCTAssertEqual(again.events, [ev(.lock, .down)])
        XCTAssertTrue(again.swallow)
        XCTAssertEqual(m.release("Space").events, [ev(.lock, .up)])
        XCTAssertEqual(m.release("Fn").events, [ev(.activate, .up)])
    }

    func testExtraKeyAfterLockInterruptsActivate() {
        var m = defaultMatcher()
        _ = m.press("Fn")
        XCTAssertEqual(m.press("Space").events, [ev(.lock, .down)])
        // どの Binding も成立させないキーなら、保持中の activate に interrupted を 1 回だけ出す
        XCTAssertEqual(m.press("KeyA"), MatchOutput(events: [ev(.activate, .interrupted)], swallow: false))
        XCTAssertEqual(m.release("KeyA").events, [])
        XCTAssertEqual(m.release("Space").events, [ev(.lock, .up)])
        XCTAssertEqual(m.release("Fn").events, [ev(.activate, .up)])
    }

    func testReleaseFnBeforeSpace() {
        var m = defaultMatcher()
        _ = m.press("Fn")
        _ = m.press("Space")
        // 両方同時に終わる。新しく成立した lock から先に up を出す
        XCTAssertEqual(m.release("Fn"), MatchOutput(events: [ev(.lock, .up), ev(.activate, .up)], swallow: false))
        XCTAssertEqual(m.release("Space"), MatchOutput(events: [], swallow: true))
    }

    func testFnAsModifierInterruptsActivateOnce() {
        var m = defaultMatcher()
        _ = m.press("Fn")
        let del = m.press("Backspace")
        XCTAssertEqual(del.events, [ev(.activate, .interrupted)])
        XCTAssertFalse(del.swallow, "Fn+Delete must reach the app")
        XCTAssertEqual(m.release("Backspace"), MatchOutput())
        XCTAssertEqual(m.press("ArrowLeft").events, [], "interrupted only once")
        _ = m.release("ArrowLeft")
        XCTAssertEqual(m.release("Fn").events, [ev(.activate, .up)])
    }

    func testFnThenShiftInterrupts() {
        var m = defaultMatcher()
        _ = m.press("Fn")
        XCTAssertEqual(m.press("ShiftLeft").events, [ev(.activate, .interrupted)])
        XCTAssertEqual(m.release("Fn").events, [ev(.activate, .up)])
    }

    func testSpaceThenFnDoesNotLock() {
        var m = defaultMatcher()
        XCTAssertEqual(m.press("Space"), MatchOutput())
        XCTAssertEqual(m.press("Fn"), MatchOutput(), "Fn+Space must be completed by the non-modifier key")
        XCTAssertEqual(m.release("Space"), MatchOutput())
        XCTAssertEqual(m.release("Fn"), MatchOutput(), "releasing into a shorter chord does not fire")
    }

    func testCommandThenFnDoesNotActivate() {
        var m = defaultMatcher()
        _ = m.press("MetaLeft")
        XCTAssertEqual(m.press("Fn").events, [])
        _ = m.release("MetaLeft")
        XCTAssertEqual(m.release("Fn").events, [])
    }

    func testSidelessModifiersMatchEitherSide() {
        var m = defaultMatcher()
        _ = m.press("MetaRight")
        _ = m.press("ControlLeft")
        let v = m.press("KeyV")
        XCTAssertEqual(v.events, [ev(.pasteLast, .down)])
        XCTAssertTrue(v.swallow)
        XCTAssertEqual(m.release("KeyV"), MatchOutput(events: [ev(.pasteLast, .up)], swallow: true))
    }

    func testSidedBindingRequiresThatSide() {
        var m = defaultMatcher()
        _ = m.press("ControlRight")
        XCTAssertEqual(m.press("AltLeft").events, [])
        var m2 = defaultMatcher()
        _ = m2.press("ControlLeft")
        XCTAssertEqual(m2.press("AltLeft").events, [ev(.activate, .down)])
        XCTAssertEqual(m2.release("ControlLeft").events, [ev(.activate, .up)])
    }

    func testEscapeSwallowedOnlyDuringSession() {
        var m = defaultMatcher()
        let idle = m.press("Escape")
        XCTAssertEqual(idle.events, [ev(.cancel, .down)])
        XCTAssertFalse(idle.swallow)
        XCTAssertEqual(m.release("Escape"), MatchOutput(events: [ev(.cancel, .up)], swallow: false))

        m.pttState = .active
        let active = m.press("Escape")
        XCTAssertTrue(active.swallow)
        XCTAssertEqual(m.release("Escape").swallow, true)

        m.pttState = .locked
        XCTAssertTrue(m.press("Escape").swallow)
        // セッションが終わっても、押下を飲み込んだキーの解放は飲み込む
        m.pttState = .inactive
        XCTAssertTrue(m.release("Escape").swallow)
    }

    func testPlainTypingPassesThrough() {
        var m = defaultMatcher()
        for k in ["KeyH", "KeyE", "Space", "KeyL"] {
            XCTAssertEqual(m.press(k), MatchOutput())
            XCTAssertEqual(m.release(k), MatchOutput())
        }
    }

    func testModifiersNeverSwallowed() {
        var m = defaultMatcher()
        XCTAssertFalse(m.press("Fn").swallow)
        XCTAssertTrue(m.press("Space").swallow, "the Space of Fn+Space is swallowed")
        XCTAssertFalse(m.release("Fn").swallow)
    }

    func testMouseButtonBinding() {
        var m = defaultMatcher(extra: ["activate": [["Mouse4"]]])
        let d = m.press("Mouse4")
        XCTAssertEqual(d.events, [ev(.activate, .down)])
        XCTAssertTrue(d.swallow)
        XCTAssertEqual(m.release("Mouse4"), MatchOutput(events: [ev(.activate, .up)], swallow: true))
        XCTAssertEqual(m.press("Mouse5"), MatchOutput())
    }

    func testFunctionKeyActivateSwallowed() {
        var m = defaultMatcher(extra: ["activate": [["F5"]]])
        let d = m.press("F5")
        XCTAssertEqual(d.events, [ev(.activate, .down)])
        XCTAssertTrue(d.swallow)
        XCTAssertTrue(m.press("F5", isRepeat: true).swallow)
        XCTAssertEqual(m.release("F5").events, [ev(.activate, .up)])
    }

    func testRecordingSuppressesHotkeysAndSwallowsKeys() {
        var m = defaultMatcher()
        _ = m.press("Fn")
        // 記録モードに入ると保持中の Binding は up
        XCTAssertEqual(m.setRecording(true).events, [ev(.activate, .up)])
        XCTAssertEqual(m.press("Space"), MatchOutput(events: [], swallow: true))
        XCTAssertEqual(m.release("Space"), MatchOutput(events: [], swallow: true))
        XCTAssertEqual(m.release("Fn"), MatchOutput())
        XCTAssertEqual(m.press("ShiftLeft").swallow, false)
        _ = m.release("ShiftLeft")
        // 記録中に押したキーは、記録が終わってからの解放も飲み込む
        _ = m.press("KeyA")
        _ = m.setRecording(false)
        XCTAssertTrue(m.release("KeyA").swallow)
        XCTAssertEqual(m.press("Fn").events, [ev(.activate, .down)])
    }

    func testMissedReleaseRecovers() {
        var m = defaultMatcher()
        _ = m.press("Fn")
        // Fn の押下がもう一度来た（解放を取りこぼした）
        XCTAssertEqual(m.press("Fn").events, [ev(.activate, .up), ev(.activate, .down)])
        XCTAssertEqual(m.releaseStale(["Fn"]).events, [ev(.activate, .up)])
        XCTAssertTrue(m.down.isEmpty)
    }

    func testSetBindingsReleasesHeld() {
        var m = defaultMatcher()
        _ = m.press("Fn")
        XCTAssertEqual(m.setBindings([]).events, [ev(.activate, .up)])
        XCTAssertEqual(m.release("Fn"), MatchOutput())
    }

    func testBothControlKeysStillSatisfySidelessBinding() {
        let parsed = BindingParser.parse(["activate": [["Control"]]])
        var m = HotkeyMatcher(bindings: parsed.bindings)
        XCTAssertEqual(m.press("ControlLeft").events, [ev(.activate, .down)])
        XCTAssertEqual(m.press("ControlRight").events, [])
        XCTAssertEqual(m.release("ControlLeft").events, [])
        XCTAssertEqual(m.release("ControlRight").events, [ev(.activate, .up)])
    }

    func testRepeatOfUnswallowedKeyPasses() {
        var m = defaultMatcher()
        _ = m.press("KeyA")
        XCTAssertEqual(m.press("KeyA", isRepeat: true), MatchOutput())
    }
}

final class BindingParserTests: XCTestCase {
    func testRejectsUnknownAndDuplicates() {
        let r = BindingParser.parse([
            "activate": [["Fn"], ["Fn"], ["Foo"], ["Control", "ControlLeft"], [], ["A", "B", "C", "D", "E", "F"]],
            "lock": [["Fn", "Space"], ["CapsLock"], ["Control", "ControlLeft"]],
            "bogus": [["KeyA"]],
        ])
        XCTAssertEqual(r.bindings.map(\.description), ["activate[0]=Fn", "lock[0]=Fn+Space"])
        XCTAssertTrue(r.errors.contains { $0.contains("unknown action: bogus") })
        XCTAssertTrue(r.errors.contains { $0.contains("activate[1]") && $0.contains("conflicts") })
        XCTAssertTrue(r.errors.contains { $0.contains("unknown key name: Foo") })
        XCTAssertTrue(r.errors.contains { $0.contains("duplicate key") })
        XCTAssertTrue(r.errors.contains { $0.contains("too many shortcuts") })
        XCTAssertTrue(r.errors.contains { $0.contains("CapsLock") })
    }

    func testSidelessAndSidedConflict() {
        let r = BindingParser.parse(["activate": [["Control", "Space"]], "lock": [["ControlLeft", "Space"]]])
        XCTAssertEqual(r.bindings.count, 1)
        XCTAssertEqual(r.errors.count, 1)
    }

    func testDifferentChordsDoNotConflict() {
        let r = BindingParser.parse(["activate": [["Fn"]], "lock": [["Fn", "Space"]], "cancel": [["Escape"]]])
        XCTAssertEqual(r.errors, [])
        XCTAssertEqual(r.bindings.count, 3)
    }

    func testMaxFiveKeys() {
        let r = BindingParser.parse(["activate": [["Control", "Alt", "Shift", "Meta", "KeyK"]]])
        XCTAssertEqual(r.errors, [])
    }
}
