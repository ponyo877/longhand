import ApplicationServices
import CoreGraphics
import Foundation
import LonghandCore

/// Watches the input field after a paste and returns its final content, including the user's edits, in field_watch_result (learning, PST-9).
///
/// - Only one watch runs at a time. LonghandCore's FieldWatchTracker makes the decisions.
/// - Reread interval: 100ms until the pasted text is visible, 150ms while confirming a send, 250ms after a keystroke, 500ms otherwise.
/// - The user's keystrokes come from HotkeyEngine's tap through noteKey. On Return, the field is read before the app gets the key (waiting up to 30ms).
/// - Ends when the focus moves, the element disappears, the field becomes empty (sent), or time is up (waiting up to 1.5 seconds for changes to settle).
final class FieldWatcher: @unchecked Sendable {
    static let shared = FieldWatcher()

    private let queue = DispatchQueue(label: "longhand.fieldwatch", qos: .userInitiated)
    /// Whether a watch is running (so the tap thread can check without going through the queue)
    private let active = LockedValue(false)
    private var current: Watch?

    /// Longest wait for the field read to finish on a Return keyDown
    static let enterReadWaitMs = 30

    struct Request {
        let pasteId: String
        let element: AXRef
        let pid: pid_t
        /// Full text of the field just before the paste
        let before: String
        /// Paste position within before (start of the selection, UTF-16)
        let insertOffset: Int?
        let insertReplacedLength: Int?
        /// The pasted text (without command notation)
        let inserted: String
        /// The read right after the paste
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

    /// Reports that no watch ran because the field is unreadable (so main can clear the watch result it is waiting for)
    func reportUnreadable(pasteId: String, inserted: String) {
        Log.info("field watch for paste \(pasteId) not started: field is unreadable")
        Output.shared.send("field_watch_result", FieldWatchResultPayload(
            pasteId: pasteId, before: "", afterPaste: "", final: "", reason: "unreadable", baseline: "",
            keystrokes: 0, firstKeystrokeMs: nil, lastKeystrokeMs: nil, insertOffset: nil, insertReplacedLength: nil,
            inserted: inserted, settled: false, durationMs: 0, preSend: nil
        ))
    }

    /// Ends the running watch, if any (when a new paste comes, for example). Ends asynchronously so as not to wait for an AX call in progress
    /// (it is still handled before a start called later)
    func cancel() {
        queue.async { [self] in finish(.cancelled) }
    }

    /// A keystroke from the user (called from the tap thread; our own synthesized keys, key repeats and swallowed hotkeys are not passed)
    func noteKey(_ key: String, flags: CGEventFlags, at t: Double) {
        guard active.get() else { return }
        let kind = WatchKey.classify(keyName: key, command: flags.contains(.maskCommand),
                                     control: flags.contains(.maskControl), option: flags.contains(.maskAlternate))
        switch kind {
        case .ignore:
            return
        case .enter:
            // Read before sending empties the field. The app does not get this Return until the tap callback returns
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

    // MARK: - On the queue

    private func poll() {
        guard let w = current else { return }
        let now = Clock.nowMs()
        guard now >= w.nextReadAt else { return }
        let el = w.req.element.element
        // Has the element disappeared?
        let (err, _) = AX.copy(el, kAXRoleAttribute)
        if err == .invalidUIElement {
            return finish(.elementGone)
        }
        // Has the focus moved to another element or app? Even after it moved, read once more at the end if the element is still there
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
