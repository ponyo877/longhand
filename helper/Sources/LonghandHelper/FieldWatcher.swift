import ApplicationServices
import CoreGraphics
import Foundation
import LonghandCore

/// 貼り付け後に入力欄を監視し、ユーザーの手直しを含む最後の内容を field_watch_result で返す（学習機能、PST-9）。
///
/// - 同時に監視するのは 1 つだけ。判定は LonghandCore の FieldWatchTracker が行う。
/// - 読み直しの間隔: 貼り付けた文字列が見えるまでは 100ms、送信の確かめ中は 150ms、キー入力の 250ms 後、それ以外は 500ms。
/// - 利用者のキー入力は HotkeyEngine の tap から noteKey で受け取る。Return のときは、アプリに届く前に（最大 30ms 待って）欄を読む。
/// - フォーカスが移った、要素が消えた、欄が空になった（送信）、時間が来た（変化が落ち着くのを最大 1.5 秒待つ）で終える。
final class FieldWatcher: @unchecked Sendable {
    static let shared = FieldWatcher()

    private let queue = DispatchQueue(label: "longhand.fieldwatch", qos: .userInitiated)
    /// 監視中か（tap スレッドから、キューに入らずに確かめるため）
    private let active = LockedValue(false)
    private var current: Watch?

    /// Return の keyDown のときに、欄を読み終えるのを待つ上限
    static let enterReadWaitMs = 30

    struct Request {
        let pasteId: String
        let element: AXRef
        let pid: pid_t
        /// 貼り付け直前の欄の全文
        let before: String
        /// before の中での貼り付け位置（選択範囲の先頭、UTF-16）
        let insertOffset: Int?
        let insertReplacedLength: Int?
        /// 貼った文字列（コマンド記法を除く）
        let inserted: String
        /// 貼り付け直後の読み取り
        let initial: String?
        let watchMs: Int
    }

    private final class Watch {
        let req: Request
        var tracker: FieldWatchTracker
        let deadline: Double
        var nextReadAt: Double
        var timer: DispatchSourceTimer?

        init(req: Request, now: Double) {
            self.req = req
            tracker = FieldWatchTracker(before: req.before, inserted: req.inserted, initial: req.initial, startedAt: now)
            deadline = now + Double(req.watchMs)
            nextReadAt = now + 100
        }
    }

    func start(_ req: Request) {
        queue.async { [self] in
            finish(.cancelled)
            let now = Clock.nowMs()
            let w = Watch(req: req, now: now)
            let timer = DispatchSource.makeTimerSource(queue: queue)
            timer.schedule(deadline: .now() + 0.1, repeating: 0.1, leeway: .milliseconds(20))
            timer.setEventHandler { [weak self] in self?.poll() }
            w.timer = timer
            current = w
            active.set(true)
            timer.resume()
            Log.debug("field watch started for paste \(req.pasteId) (\(req.watchMs)ms)")
        }
    }

    /// 欄が読めないので監視しなかったことを知らせる（main が待っている監視の結果を片付けられるように）
    func reportUnreadable(pasteId: String, inserted: String) {
        Log.info("field watch for paste \(pasteId) not started: field is unreadable")
        Output.shared.send("field_watch_result", FieldWatchResultPayload(
            pasteId: pasteId, before: "", afterPaste: "", final: "", reason: "unreadable", baseline: "",
            keystrokes: 0, firstKeystrokeMs: nil, lastKeystrokeMs: nil, insertOffset: nil, insertReplacedLength: nil,
            inserted: inserted, settled: false, durationMs: 0, preSend: nil
        ))
    }

    /// 監視中なら終える（新しい貼り付けが来たときなど）。読み取り中の AX 呼び出しを待たないよう、非同期に終える
    /// （後から呼んだ start より先に処理される）
    func cancel() {
        queue.async { [self] in finish(.cancelled) }
    }

    /// 利用者のキー入力（tap スレッドから呼ぶ。自分の合成、キーリピート、飲み込んだホットキーは渡さない）
    func noteKey(_ key: String, flags: CGEventFlags, at t: Double) {
        guard active.get() else { return }
        let kind = WatchKey.classify(keyName: key, command: flags.contains(.maskCommand),
                                     control: flags.contains(.maskControl), option: flags.contains(.maskAlternate))
        switch kind {
        case .ignore:
            return
        case .enter:
            // 送信で欄が空になる前に読む。tap のコールバックが返るまで、アプリにはこの Return が届かない
            let done = DispatchSemaphore(value: 0)
            queue.async { [self] in
                defer { done.signal() }
                guard let w = current else { return }
                let text = FieldReader.fullText(w.req.element.element)
                w.tracker.enter(text: text, at: t)
                w.nextReadAt = min(w.nextReadAt, Clock.nowMs() + 150)
            }
            if done.wait(timeout: .now() + .milliseconds(Self.enterReadWaitMs)) == .timedOut {
                Log.debug("field read on Return did not finish within \(Self.enterReadWaitMs)ms")
            }
        case .edit, .deletion:
            queue.async { [self] in
                guard let w = current else { return }
                w.tracker.keystroke(kind, at: t)
                w.nextReadAt = min(w.nextReadAt, t + 250)
            }
        }
    }

    // MARK: - キューの中

    private func poll() {
        guard let w = current else { return }
        let now = Clock.nowMs()
        guard now >= w.nextReadAt else { return }
        let el = w.req.element.element
        // 要素が消えたか
        let (err, _) = AX.copy(el, kAXRoleAttribute)
        if err == .invalidUIElement {
            return finish(.elementGone)
        }
        // フォーカスが別の要素・別のアプリに移ったか。移った後でも、要素が残っていれば最後に 1 回読む
        let focusMoved: Bool = {
            if let pid = AX.focusedAppPid(), pid != w.req.pid { return true }
            if let focused = AX.focusedElement(appPid: w.req.pid), !CFEqual(focused, el) { return true }
            return false
        }()
        let text = FieldReader.fullText(el)
        if focusMoved {
            return finish(.focusChanged, finalRead: text)
        }
        if let text, case let .end(result) = w.tracker.observe(text, at: Clock.nowMs()) {
            return send(result)
        }
        let after = Clock.nowMs()
        if after >= w.deadline, w.tracker.canFinishAfterDeadline(deadline: w.deadline, now: after) {
            return finish(.timeout)
        }
        if w.tracker.wantsQuickRead {
            w.nextReadAt = after + 150
        } else if !w.tracker.afterPasteFixed {
            w.nextReadAt = after + 100
        } else if after >= w.deadline {
            w.nextReadAt = after + 250
        } else {
            w.nextReadAt = after + 500
        }
    }

    private func finish(_ reason: FieldWatchTracker.EndReason, finalRead: String? = nil) {
        guard let w = current else { return }
        send(w.tracker.end(reason, at: Clock.nowMs(), finalRead: finalRead))
    }

    private func send(_ r: FieldWatchTracker.Result) {
        guard let w = current else { return }
        w.timer?.cancel()
        current = nil
        active.set(false)
        Log.debug("field watch for paste \(w.req.pasteId) ended: \(r.reason.rawValue) (keystrokes \(r.keystrokes), settled \(r.settled))")
        Output.shared.send("field_watch_result", FieldWatchResultPayload(
            pasteId: w.req.pasteId,
            before: w.req.before,
            afterPaste: r.afterPaste,
            final: r.final,
            reason: r.reason.rawValue,
            baseline: r.baseline,
            keystrokes: r.keystrokes,
            firstKeystrokeMs: r.firstKeystrokeMs.map { $0.rounded() },
            lastKeystrokeMs: r.lastKeystrokeMs.map { $0.rounded() },
            insertOffset: w.req.insertOffset,
            insertReplacedLength: w.req.insertReplacedLength,
            inserted: w.req.inserted,
            settled: r.settled,
            durationMs: Int(r.durationMs.rounded()),
            preSend: r.preSend
        ))
    }
}
