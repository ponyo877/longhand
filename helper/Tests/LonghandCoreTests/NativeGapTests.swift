import XCTest
@testable import LonghandCore

final class RivalTapFinderTests: XCTestCase {
    let mask: UInt64 = (1 << 10) | (1 << 11) | (1 << 12) | (1 << 25) | (1 << 26)
    let me: Int32 = 100

    func tap(_ pid: Int32, point: UInt32 = 0, options: UInt32 = 0, enabled: Bool = true, mask m: UInt64? = nil) -> TapEntry {
        TapEntry(tapPoint: point, options: options, enabled: enabled, eventsOfInterest: m ?? mask, tappingPid: pid)
    }

    func testNoRivalWhenWeAreFirst() {
        let list = [tap(me), tap(200)]
        XCTAssertNil(RivalTapFinder.rivalInFront(list, ownPid: me, ownMask: mask))
    }

    func testActiveTapAheadIsRival() {
        let list = [tap(200), tap(me)]
        XCTAssertEqual(RivalTapFinder.rivalInFront(list, ownPid: me, ownMask: mask)?.tappingPid, 200)
    }

    func testIgnoresListenOnlyDisabledSessionAndUnrelatedMasks() {
        let list = [
            tap(201, options: 1),
            tap(202, enabled: false),
            tap(203, point: 1),
            tap(204, mask: 1 << 1), // Left mouse button only
            tap(me),
        ]
        XCTAssertNil(RivalTapFinder.rivalInFront(list, ownPid: me, ownMask: mask))
    }

    func testFirstQualifyingRivalIsReported() {
        let list = [tap(201, options: 1), tap(202), tap(203), tap(me)]
        XCTAssertEqual(RivalTapFinder.rivalInFront(list, ownPid: me, ownMask: mask)?.tappingPid, 202)
    }

    func testOwnTapMissingMeansUnknown() {
        XCTAssertNil(RivalTapFinder.rivalInFront([tap(200)], ownPid: me, ownMask: mask))
    }
}

final class RivalBackoffTests: XCTestCase {
    func testThreeMovesPerMinuteThenGiveUpOnce() {
        var b = RivalBackoff()
        XCTAssertEqual(b.decide(rivalPid: 7, now: 0), .move)
        XCTAssertEqual(b.decide(rivalPid: 7, now: 4000), .move)
        XCTAssertEqual(b.decide(rivalPid: 7, now: 8000), .move)
        XCTAssertEqual(b.decide(rivalPid: 7, now: 12000), .giveUp)
        XCTAssertEqual(b.decide(rivalPid: 7, now: 16000), .ignore)
        XCTAssertEqual(b.decide(rivalPid: 7, now: 600_000), .ignore)
        // Another rival is counted separately
        XCTAssertEqual(b.decide(rivalPid: 8, now: 16000), .move)
    }

    func testOldMovesExpire() {
        var b = RivalBackoff()
        XCTAssertEqual(b.decide(rivalPid: 7, now: 0), .move)
        XCTAssertEqual(b.decide(rivalPid: 7, now: 1000), .move)
        XCTAssertEqual(b.decide(rivalPid: 7, now: 2000), .move)
        XCTAssertEqual(b.decide(rivalPid: 7, now: 70_000), .move)
    }

    func testForgetWhenProcessExits() {
        var b = RivalBackoff(maxMoves: 1, windowMs: 60_000)
        XCTAssertEqual(b.decide(rivalPid: 7, now: 0), .move)
        XCTAssertEqual(b.decide(rivalPid: 7, now: 10), .giveUp)
        b.retain(onlyPids: [])
        XCTAssertFalse(b.hasGivenUp(on: 7))
        XCTAssertEqual(b.decide(rivalPid: 7, now: 20), .move)
    }
}

final class PasteLandingTests: XCTestCase {
    func testClassify() {
        XCTAssertEqual(PasteLanding.classify(changed: true, read: false), .confirmed)
        XCTAssertEqual(PasteLanding.classify(changed: true, read: true), .confirmed)
        XCTAssertEqual(PasteLanding.classify(changed: false, read: true), .read)
        XCTAssertEqual(PasteLanding.classify(changed: false, read: false), .unconfirmed)
    }

    func testResendOnlyWhenNotReadAndUnchanged() {
        XCTAssertTrue(PasteLanding.shouldResend(changed: false, read: false))
        XCTAssertFalse(PasteLanding.shouldResend(changed: false, read: true))
        XCTAssertFalse(PasteLanding.shouldResend(changed: true, read: false))
    }
}

final class WatchKeyTests: XCTestCase {
    func k(_ name: String, cmd: Bool = false, ctrl: Bool = false, opt: Bool = false) -> WatchKey {
        WatchKey.classify(keyName: name, command: cmd, control: ctrl, option: opt)
    }

    func testClassify() {
        XCTAssertEqual(k("KeyA"), .edit)
        XCTAssertEqual(k("Space"), .edit)
        XCTAssertEqual(k("KeyA", opt: true), .edit)
        XCTAssertEqual(k("Backspace"), .deletion)
        XCTAssertEqual(k("Backspace", opt: true), .deletion)
        XCTAssertEqual(k("Enter"), .enter)
        XCTAssertEqual(k("Enter", cmd: true), .enter)
        XCTAssertEqual(k("NumpadEnter"), .enter)
        XCTAssertEqual(k("ArrowLeft"), .ignore)
        XCTAssertEqual(k("End"), .ignore)
        XCTAssertEqual(k("Escape"), .ignore)
        XCTAssertEqual(k("F5"), .ignore)
        XCTAssertEqual(k("KeyC", cmd: true), .ignore)
        XCTAssertEqual(k("KeyA", cmd: true), .ignore)
        XCTAssertEqual(k("KeyV", cmd: true), .edit)
        XCTAssertEqual(k("KeyZ", cmd: true), .edit)
        XCTAssertEqual(k("KeyX", cmd: true), .deletion)
        XCTAssertEqual(k("KeyE", ctrl: true), .ignore)
        XCTAssertEqual(k("KeyH", ctrl: true), .deletion)
    }
}

final class FieldWatchTrackerTests: XCTestCase {
    let inserted = "会議は明日の十時からです"

    func make(before: String = "", initial: String? = nil) -> FieldWatchTracker {
        FieldWatchTracker(before: before, inserted: inserted, initial: initial, startedAt: 0)
    }

    func testAfterPasteWaitsUntilInsertedTextAppears() {
        var w = make(before: "メモ: ", initial: "メモ: ")
        XCTAssertFalse(w.afterPasteFixed)
        XCTAssertEqual(w.observe("メモ: 会議は明日", at: 100), .continue)
        XCTAssertFalse(w.afterPasteFixed)
        XCTAssertEqual(w.observe("メモ: 会議は明日の十時からです", at: 200), .continue)
        XCTAssertTrue(w.afterPasteFixed)
        XCTAssertEqual(w.afterPaste, "メモ: 会議は明日の十時からです")
    }

    func testAfterPasteGivesUpAfterLimit() {
        var w = make(initial: "")
        _ = w.observe("別の文", at: 1200)
        XCTAssertTrue(w.afterPasteFixed)
        XCTAssertEqual(w.afterPaste, "別の文")
    }

    func testClearedAfterEnterUsesTheReadAtKeyDown() {
        var w = make(initial: inserted)
        w.keystroke(.edit, at: 1000)
        _ = w.observe("会議は明後日の十時からです", at: 1500)
        w.enter(text: "会議は明後日の十時からです。", at: 2000)
        guard case let .end(r) = w.observe("", at: 2300) else { return XCTFail("did not detect the send") }
        XCTAssertEqual(r.reason, .enter)
        XCTAssertEqual(r.final, "会議は明後日の十時からです。")
        XCTAssertEqual(r.baseline, inserted)
        XCTAssertEqual(r.keystrokes, 1)
        XCTAssertEqual(r.firstKeystrokeMs, 1000)
        XCTAssertEqual(r.preSend, "会議は明後日の十時からです。")
    }

    func testLateEnterReadThatIsAlreadyEmptyFallsBackToPreviousRead() {
        var w = make(initial: inserted)
        w.keystroke(.edit, at: 1400)
        _ = w.observe("会議は明後日の十時からです", at: 1500)
        w.enter(text: "", at: 2000)
        guard case let .end(r) = w.observe("", at: 2100) else { return XCTFail("did not detect the send") }
        XCTAssertEqual(r.reason, .enter)
        XCTAssertEqual(r.final, "会議は明後日の十時からです")
    }

    func testClearedWithoutEnterIsSentAfterConfirmation() {
        var w = make(initial: inserted)
        w.keystroke(.edit, at: 1400)
        _ = w.observe("会議は明後日の十時からです", at: 1500)
        // The first one waits for confirmation
        XCTAssertEqual(w.observe("", at: 6000), .continue)
        XCTAssertTrue(w.wantsQuickRead)
        guard case let .end(r) = w.observe("", at: 6150) else { return XCTFail("did not detect the send") }
        XCTAssertEqual(r.reason, .sent)
        XCTAssertEqual(r.final, "会議は明後日の十時からです")
        XCTAssertEqual(r.keystrokes, 1)
    }

    func testKeystrokeCancelsPendingSent() {
        var w = make(initial: inserted)
        // The changed read arrived before the first key of the select-and-retype
        XCTAssertEqual(w.observe("会議はm", at: 1000), .continue)
        XCTAssertTrue(w.wantsQuickRead)
        w.keystroke(.edit, at: 995)
        XCTAssertFalse(w.wantsQuickRead)
        XCTAssertEqual(w.observe("会議は明後日", at: 1150), .continue)
    }

    func testInsertedTextVanishingIsSentEvenIfPlaceholderRemains() {
        var w = make(before: "", initial: inserted)
        XCTAssertEqual(w.observe("メッセージを入力", at: 3000), .continue)
        guard case let .end(r) = w.observe("メッセージを入力", at: 3150) else { return XCTFail("did not detect the send") }
        XCTAssertEqual(r.reason, .sent)
        XCTAssertEqual(r.final, inserted)
    }

    func testRewordingWhileTypingIsNotSent() {
        var w = make(initial: inserted)
        w.keystroke(.edit, at: 1000)
        XCTAssertEqual(w.observe("会議は明後日の11時から", at: 1200), .continue)
        XCTAssertEqual(w.last, "会議は明後日の11時から")
    }

    func testDeletionByUserIsNotSent() {
        var w = make(initial: inserted)
        w.keystroke(.deletion, at: 1000)
        XCTAssertEqual(w.observe("", at: 1200), .continue)
        // If the retyped sentence disappears after the grace period, it is a send
        w.keystroke(.edit, at: 1900)
        _ = w.observe("会議は十時から", at: 2000)
        XCTAssertEqual(w.observe("", at: 5000), .continue)
        guard case let .end(r) = w.observe("", at: 5150) else { return XCTFail("did not detect the send") }
        XCTAssertEqual(r.final, "会議は十時から")
    }

    func testFocusChangeRightAfterClearIsSent() {
        var w = make(initial: inserted)
        let r = w.end(.focusChanged, at: 4000, finalRead: "")
        XCTAssertEqual(r.reason, .sent)
        XCTAssertEqual(r.final, inserted)
    }

    func testIgnoredKeysDoNotCountOrMoveBaseline() {
        var w = make(initial: inserted)
        w.keystroke(.ignore, at: 500)
        _ = w.observe(inserted + "（自動整形）", at: 800)
        w.keystroke(.edit, at: 900)
        let r = w.end(.timeout, at: 31000)
        XCTAssertEqual(r.keystrokes, 1)
        XCTAssertEqual(r.baseline, inserted + "（自動整形）")
        XCTAssertEqual(r.reason, .timeout)
        XCTAssertNil(r.preSend)
    }

    func testFocusChangeShortlyAfterEnterIsEnter() {
        var w = make(initial: inserted)
        w.enter(text: inserted, at: 1000)
        let r = w.end(.focusChanged, at: 1500)
        XCTAssertEqual(r.reason, .enter)
        XCTAssertEqual(r.final, inserted)
        // If the user only sent, there are 0 editing keystrokes
        XCTAssertEqual(r.keystrokes, 0)
    }

    func testIMEEnterThatDoesNotClearKeepsWatching() {
        var w = make(initial: inserted)
        w.enter(text: inserted + "かくにん", at: 1000)
        XCTAssertEqual(w.observe(inserted + "確認", at: 1200), .continue)
        let r = w.end(.timeout, at: 30000)
        XCTAssertEqual(r.reason, .timeout)
        XCTAssertEqual(r.final, inserted + "確認")
    }

    func testSettleWait() {
        var w = make(initial: inserted)
        _ = w.observe(inserted + "。", at: 29_800)
        XCTAssertFalse(w.canFinishAfterDeadline(deadline: 30_000, now: 30_000))
        XCTAssertTrue(w.canFinishAfterDeadline(deadline: 30_000, now: 30_800))
        _ = w.observe(inserted + "。。", at: 30_700)
        XCTAssertFalse(w.canFinishAfterDeadline(deadline: 30_000, now: 31_000))
        XCTAssertTrue(w.canFinishAfterDeadline(deadline: 30_000, now: 31_500))
    }

    func testLongInsertedTextMatchesByHeadOrTail() {
        let long = String(repeating: "あいうえおかきくけこ", count: 6)
        let w = FieldWatchTracker(before: "", inserted: long, initial: nil, startedAt: 0)
        let edited = "X" + long.dropFirst(5)
        XCTAssertTrue(w.containsInserted(String(edited)))
        XCTAssertFalse(w.containsInserted("まったく別の文"))
    }
}

final class BareFnTests: XCTestCase {
    func testBareFn() {
        XCTAssertTrue(Binding(action: .activate, index: 0, keys: ["Fn"]).isBareFn)
        XCTAssertFalse(Binding(action: .activate, index: 0, keys: ["Fn", "Space"]).isBareFn)
        XCTAssertFalse(Binding(action: .activate, index: 0, keys: ["Control"]).isBareFn)
    }

    func testPlainModifierOnly() {
        XCTAssertTrue(Binding(action: .activate, index: 0, keys: ["Control", "Alt"]).isPlainModifierOnly)
        XCTAssertTrue(Binding(action: .activate, index: 0, keys: ["MetaRight"]).isPlainModifierOnly)
        XCTAssertFalse(Binding(action: .activate, index: 0, keys: ["Fn"]).isPlainModifierOnly)
        XCTAssertFalse(Binding(action: .activate, index: 0, keys: ["Fn", "Shift"]).isPlainModifierOnly)
        XCTAssertFalse(Binding(action: .activate, index: 0, keys: ["Control", "Space"]).isPlainModifierOnly)
    }
}

final class PointerInterruptTests: XCTestCase {
    func testClickInterruptsPlainModifierActivateOnce() {
        var m = HotkeyMatcher(bindings: [Binding(action: .activate, index: 0, keys: ["Control", "Alt"])])
        _ = m.press("ControlLeft")
        XCTAssertEqual(m.press("AltLeft").events, [HotkeyEvent(.activate, .down)])
        XCTAssertTrue(m.holdsPointerInterruptibleActivate)
        XCTAssertEqual(m.interruptOnPointer().events, [HotkeyEvent(.activate, .interrupted)])
        XCTAssertFalse(m.holdsPointerInterruptibleActivate)
        XCTAssertEqual(m.interruptOnPointer().events, [])
        XCTAssertEqual(m.release("AltLeft").events, [HotkeyEvent(.activate, .up)])
    }

    func testSingleCommandIsInterruptible() {
        var m = HotkeyMatcher(bindings: [Binding(action: .activate, index: 0, keys: ["MetaRight"])])
        XCTAssertEqual(m.press("MetaRight").events, [HotkeyEvent(.activate, .down)])
        XCTAssertEqual(m.interruptOnPointer().events, [HotkeyEvent(.activate, .interrupted)])
    }

    func testBareFnIsNotInterruptedByClicks() {
        var m = HotkeyMatcher(bindings: [Binding(action: .activate, index: 0, keys: ["Fn"])])
        XCTAssertEqual(m.press("Fn").events, [HotkeyEvent(.activate, .down)])
        XCTAssertFalse(m.holdsPointerInterruptibleActivate)
        XCTAssertEqual(m.interruptOnPointer().events, [])
        XCTAssertEqual(m.release("Fn").events, [HotkeyEvent(.activate, .up)])
    }

    func testFnWithModifierIsNotInterruptedByClicks() {
        var m = HotkeyMatcher(bindings: [Binding(action: .activate, index: 0, keys: ["Fn", "Control"])])
        _ = m.press("Fn")
        XCTAssertEqual(m.press("ControlLeft").events, [HotkeyEvent(.activate, .down)])
        XCTAssertFalse(m.holdsPointerInterruptibleActivate)
        XCTAssertEqual(m.interruptOnPointer().events, [])
    }

    func testBindingWithCharacterKeyIsNotAffected() {
        var m = HotkeyMatcher(bindings: [Binding(action: .activate, index: 0, keys: ["Control", "Space"])])
        _ = m.press("ControlLeft")
        XCTAssertEqual(m.press("Space").events, [HotkeyEvent(.activate, .down)])
        XCTAssertFalse(m.holdsPointerInterruptibleActivate)
        XCTAssertEqual(m.interruptOnPointer().events, [])
    }
}
