import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import LonghandCore

/// 能動型の CGEventTap（HID 層）でキーとマウスボタンを監視し、HotkeyMatcher で判定してホットキーを送る。
///
/// - tap は専用スレッドの CFRunLoop で動かす。コールバックでは判定と送信のキュー投入だけを行い、すぐ返す。
/// - tap が無効化されたら（タイムアウト、ユーザー操作）すぐ有効化し直し、event_tap で知らせる。
/// - アクセシビリティの許可がなく tap を作れなければ event_tap {failed} を送り、2 秒ごとに作り直す。
/// - 自分が合成したイベント（貼り付けの ⌘V など）は eventSourceUserData の印で見分けて無視する。
/// - 1 秒ごとに、自分より前に能動型の tap（他のアプリ）がいないかを確かめ、いれば tap を作り直して先頭に戻る（HK-4）。
///   同じ相手に 60 秒で 3 回取り返されたら、event_tap {rival_in_front} で知らせて取り合いをやめる。
final class HotkeyEngine: @unchecked Sendable {
    static let shared = HotkeyEngine()

    /// 合成イベントに付ける印（"LHND"）
    static let syntheticMarker: Int64 = 0x4C48_4E44

    private let lock = NSLock()
    private var matcher = HotkeyMatcher()
    private var recorder = ShortcutRecorder()
    private var recordingDeadline: Double? // Clock.nowMs() 基準
    private var secureInputPid: Int = 0

    // tap スレッドだけが触る
    private var tap: CFMachPort?
    private var tapSource: CFRunLoopSource?
    private var runLoop: CFRunLoop?
    private var lastRetry: Double = 0
    private var lastHealthCheck: Double = 0
    private var lastSecureCheck: Double = 0
    private var reportedFailure = false
    /// 直近の確認で、自分の tap が HID 層の先頭にいたか（前段の tap によるフラグの書き換えを疑わなくてよいか）
    private var atFront = true
    private var rivalBackoff = RivalBackoff()
    /// ⌃⌥⌘⇧ だけの activate が成立したときのクリックとスクロールの回数（tap スレッドだけが触る）
    private var mouseBaseline: [UInt32]?

    static let recordLeaseMs: Double = 5000
    static let retryIntervalMs: Double = 2000

    static let tapMask: CGEventMask = (1 << CGEventType.keyDown.rawValue)
        | (1 << CGEventType.keyUp.rawValue)
        | (1 << CGEventType.flagsChanged.rawValue)
        | (1 << CGEventType.otherMouseDown.rawValue)
        | (1 << CGEventType.otherMouseUp.rawValue)

    func start() {
        let thread = Thread { [self] in threadMain() }
        thread.name = "longhand.eventtap"
        thread.qualityOfService = .userInteractive
        thread.start()
    }

    // MARK: - main からの操作（stdin スレッドから呼ばれる）

    func configure(bindings: [Binding]) {
        let out = withLock { matcher.setBindings(bindings) }
        emit(out.events, t: Clock.nowMs())
        Log.info("hotkeys configured: " + (bindings.isEmpty ? "(none)" : bindings.map(\.description).joined(separator: ", ")))
    }

    func setPttState(_ state: PttState) {
        withLock { matcher.pttState = state }
    }

    func setRecording(_ active: Bool) {
        let out: MatchOutput = withLock {
            if active {
                let wasActive = recordingDeadline != nil
                recordingDeadline = Clock.nowMs() + Self.recordLeaseMs
                if !wasActive { recorder.reset() }
                return matcher.setRecording(true)
            } else {
                recordingDeadline = nil
                recorder.reset()
                return matcher.setRecording(false)
            }
        }
        emit(out.events, t: Clock.nowMs())
    }

    // MARK: - tap スレッド

    private func threadMain() {
        runLoop = CFRunLoopGetCurrent()
        createTapIfPossible()
        // 定期処理: tap の作り直し・健全性確認、記録モードの期限、押しっぱなしのキーの突き合わせ
        let timer = CFRunLoopTimerCreateWithHandler(kCFAllocatorDefault, CFAbsoluteTimeGetCurrent() + 0.25, 0.25, 0, 0) { [self] _ in
            periodic()
        }
        CFRunLoopAddTimer(runLoop, timer, .commonModes)
        CFRunLoopRun()
    }

    private func createTapIfPossible() {
        lastRetry = Clock.nowMs()
        guard AXIsProcessTrusted() else {
            reportFailure("accessibility permission is not granted")
            return
        }
        guard let (port, source) = makeTap() else {
            reportFailure("CGEvent.tapCreate returned nil")
            return
        }
        tap = port
        tapSource = source
        reportedFailure = false
        atFront = true
        Log.info("event tap enabled (HID level)")
        Output.shared.send("event_tap", EventTapPayload(status: "enabled"))
    }

    /// HID 層の先頭に能動型の tap を作り、この run loop に載せて有効にする
    private func makeTap() -> (CFMachPort, CFRunLoopSource)? {
        let refcon = Unmanaged.passUnretained(self).toOpaque()
        guard let port = CGEvent.tapCreate(
            tap: .cghidEventTap,
            place: .headInsertEventTap,
            options: .defaultTap,
            eventsOfInterest: Self.tapMask,
            callback: { _, type, event, refcon in
                guard let refcon else { return Unmanaged.passUnretained(event) }
                let engine = Unmanaged<HotkeyEngine>.fromOpaque(refcon).takeUnretainedValue()
                return engine.handle(type: type, event: event)
            },
            userInfo: refcon
        ) else { return nil }
        guard let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, port, 0) else {
            CFMachPortInvalidate(port)
            return nil
        }
        CFRunLoopAddSource(runLoop, source, .commonModes)
        CGEvent.tapEnable(tap: port, enable: true)
        return (port, source)
    }

    /// tap を作り直して先頭に戻る。新しい tap を先に作ってから古い tap を外す（その間のキーを取りこぼさないため）。
    /// 押しっぱなしの状態はそのまま引き継ぐ（Fn を押している最中でも録音を止めない）
    private func moveToFront() -> Bool {
        guard let (port, source) = makeTap() else { return false }
        if let old = tap {
            CGEvent.tapEnable(tap: old, enable: false)
            CFMachPortInvalidate(old)
        }
        if let oldSource = tapSource { CFRunLoopRemoveSource(runLoop, oldSource, .commonModes) }
        tap = port
        tapSource = source
        return true
    }

    /// 自分より前に能動型の tap がいないかを確かめ、いれば先頭に戻る（tap スレッドの 1 秒ごとの確認から呼ぶ）
    private func checkFront(now: Double) {
        guard let entries = Self.tapList() else { return }
        rivalBackoff.retain(onlyPids: Set(entries.map(\.tappingPid)).union(rivalBackoff.trackedPids.filter(Self.isAlive)))
        guard let rival = RivalTapFinder.rivalInFront(entries, ownPid: getpid(), ownMask: Self.tapMask) else {
            atFront = true
            return
        }
        let pid = rival.tappingPid
        switch rivalBackoff.decide(rivalPid: pid, now: now) {
        case .move:
            let name = Self.processName(pid)
            if moveToFront() {
                atFront = true
                Log.info("another active event tap was in front (pid \(pid), \(name)); moved our tap to the front")
                Output.shared.send("event_tap", EventTapPayload(status: "moved_to_front", pid: pid, name: name))
            } else {
                atFront = false
                Log.warn("failed to re-create the event tap in front of pid \(pid) (\(name))")
            }
        case .giveUp:
            atFront = false
            let name = Self.processName(pid)
            Log.warn("pid \(pid) (\(name)) keeps taking the front of the event tap queue; giving up")
            Output.shared.send("event_tap", EventTapPayload(status: "rival_in_front", pid: pid, name: name))
        case .ignore:
            atFront = false
        }
    }

    /// CGGetEventTapList の結果（並び順のまま）
    static func tapList() -> [TapEntry]? {
        var count: UInt32 = 0
        guard CGGetEventTapList(0, nil, &count) == .success, count > 0 else { return nil }
        var infos = [CGEventTapInformation](repeating: CGEventTapInformation(), count: Int(count))
        var got: UInt32 = 0
        guard CGGetEventTapList(count, &infos, &got) == .success else { return nil }
        return infos.prefix(Int(got)).map {
            TapEntry(tapPoint: $0.tapPoint.rawValue, options: $0.options.rawValue, enabled: $0.enabled,
                     eventsOfInterest: $0.eventsOfInterest, tappingPid: $0.tappingProcess)
        }
    }

    static func processName(_ pid: Int32) -> String {
        if let app = NSRunningApplication(processIdentifier: pid) {
            return app.localizedName ?? app.bundleIdentifier ?? "pid \(pid)"
        }
        var buf = [CChar](repeating: 0, count: 256)
        guard proc_name(pid, &buf, UInt32(buf.count)) > 0 else { return "pid \(pid)" }
        return String(cString: buf)
    }

    static func isAlive(_ pid: Int32) -> Bool {
        pid > 0 && (kill(pid, 0) == 0 || errno == EPERM)
    }

    private func reportFailure(_ reason: String) {
        // 失敗は状態が変わったときだけ送る（2 秒ごとの再試行で毎回送らない）
        if !reportedFailure {
            reportedFailure = true
            Log.warn("event tap unavailable: \(reason); retrying every 2s")
            Output.shared.send("event_tap", EventTapPayload(status: "failed"))
        }
    }

    private func destroyTap() {
        if let tap {
            CGEvent.tapEnable(tap: tap, enable: false)
            CFMachPortInvalidate(tap)
        }
        if let tapSource { CFRunLoopRemoveSource(runLoop, tapSource, .commonModes) }
        tap = nil
        tapSource = nil
        // 押しっぱなしの状態は信用できないので解放扱いにする
        let (out, updates) = withLock { releaseStaleLocked(matcher.down.sorted()) }
        emitShortcutUpdates(updates)
        emit(out.events, t: Clock.nowMs())
    }

    private func periodic() {
        let now = Clock.nowMs()

        // 記録モードの期限切れ
        let leaseOut: MatchOutput? = withLock {
            if let deadline = recordingDeadline, now > deadline {
                recordingDeadline = nil
                recorder.reset()
                Log.info("record_shortcut lease expired")
                return matcher.setRecording(false)
            }
            return nil
        }
        if let leaseOut { emit(leaseOut.events, t: now) }

        guard let tap else {
            if now - lastRetry >= Self.retryIntervalMs { createTapIfPossible() }
            return
        }

        if now - lastHealthCheck >= 1000 {
            lastHealthCheck = now
            if !AXIsProcessTrusted() {
                Log.warn("accessibility permission was revoked; removing event tap")
                destroyTap()
                reportFailure("accessibility permission revoked")
                return
            }
            if !CGEvent.tapIsEnabled(tap: tap) {
                Log.warn("event tap found disabled; re-enabling")
                CGEvent.tapEnable(tap: tap, enable: true)
                Output.shared.send("event_tap", EventTapPayload(status: "re_enabled"))
            }
            checkFront(now: now)
        }
        checkMouseWhileHolding(now: now)
        reconcile(now: now)
    }

    /// セキュア入力（パスワード欄など）の間は、修飾キー以外のキーイベントが tap に届かない。
    /// 押しっぱなしのキーの解放も届かないので、セキュア入力が始まったら離されたものとして扱う。
    /// （修飾キーの flagsChanged とマウスのイベントは届くので対象外）
    ///
    /// 注: CGEventSource.flagsState / keyState(.hidSystemState) によるポーリングは使わない。
    /// HID 層に能動型の tap があると、合成イベントではこの状態表が更新されないことを確かめたため
    /// （押している Fn を「離された」と誤判定して録音が止まる恐れがある）。
    private func reconcile(now: Double) {
        let down = withLock { matcher.down }
        let keyboardKeys = down.filter { !KeyTable.isModifier($0) && !KeyTable.isMouse($0) }
        guard !keyboardKeys.isEmpty, now - lastSecureCheck >= 500 else { return }
        lastSecureCheck = now
        let pid = Self.secureInputPid()
        let changed = withLock { () -> Bool in
            defer { secureInputPid = pid }
            return secureInputPid != pid
        }
        guard changed, pid != 0 else { return }
        Log.info("secure event input became active (pid \(pid)); releasing held keys: \(keyboardKeys.sorted().joined(separator: ","))")
        let (out, updates) = withLock { releaseStaleLocked(keyboardKeys.sorted()) }
        emitShortcutUpdates(updates)
        emit(out.events, t: now)
    }

    /// 押されていると思っている修飾キーのうち、イベントのフラグ上は離されているものを返す（lock 中に呼ぶ）
    private func staleModifiersLocked(flags: CGEventFlags) -> [String] {
        var stale: [String] = []
        let raw = flags.rawValue
        for key in matcher.down {
            guard let kind = KeyTable.modifierKind(ofPhysical: key) else { continue }
            if !flags.contains(Self.flag(for: kind)) {
                stale.append(key)
            } else if kind != .fn, let mine = Self.deviceBits[key] {
                let sideBits = kind.physicalNames.compactMap { Self.deviceBits[$0] }.reduce(0, |)
                if raw & sideBits != 0 && raw & mine == 0 { stale.append(key) }
            }
        }
        return stale.sorted()
    }

    private func releaseStaleLocked(_ keys: [String]) -> (MatchOutput, [ShortcutUpdate]) {
        guard !keys.isEmpty else { return (MatchOutput(), []) }
        var updates: [ShortcutUpdate] = []
        if recordingDeadline != nil {
            for k in keys { if let u = recorder.release(k) { updates.append(u) } }
        }
        return (matcher.releaseStale(keys), updates)
    }

    private func emitShortcutUpdates(_ updates: [ShortcutUpdate]) {
        for u in updates {
            Output.shared.send("shortcut_keys", ShortcutKeysPayload(keys: u.keys, combo: u.combo, done: u.done))
        }
    }

    static func flag(for kind: ModifierKind) -> CGEventFlags {
        switch kind {
        case .fn: return .maskSecondaryFn
        case .control: return .maskControl
        case .alt: return .maskAlternate
        case .shift: return .maskShift
        case .meta: return .maskCommand
        }
    }

    static func secureInputPid() -> Int {
        guard let dict = CGSessionCopyCurrentDictionary() as? [String: Any] else { return 0 }
        return (dict["kCGSSessionSecureInputPID"] as? Int) ?? 0
    }

    // MARK: - イベント処理（tap のコールバック。速く返すこと）

    private enum Transition {
        case press(String, isRepeat: Bool)
        case release(String)
    }

    // 左右の修飾キーのデバイス依存フラグ（IOKit の NX_DEVICE*KEYMASK）
    private static let deviceBits: [String: UInt64] = [
        "ControlLeft": 0x0000_0001, "ControlRight": 0x0000_2000,
        "ShiftLeft": 0x0000_0002, "ShiftRight": 0x0000_0004,
        "MetaLeft": 0x0000_0008, "MetaRight": 0x0000_0010,
        "AltLeft": 0x0000_0020, "AltRight": 0x0000_0040,
    ]

    fileprivate func handle(type: CGEventType, event: CGEvent) -> Unmanaged<CGEvent>? {
        switch type {
        case .tapDisabledByTimeout, .tapDisabledByUserInput:
            let status = type == .tapDisabledByTimeout ? "disabled_by_timeout" : "disabled_by_user_input"
            Log.warn("event tap \(status); re-enabling")
            Output.shared.send("event_tap", EventTapPayload(status: status))
            if let tap { CGEvent.tapEnable(tap: tap, enable: true) }
            Output.shared.send("event_tap", EventTapPayload(status: "re_enabled"))
            return Unmanaged.passUnretained(event)
        case .keyDown, .keyUp, .flagsChanged, .otherMouseDown, .otherMouseUp:
            break
        default:
            return Unmanaged.passUnretained(event)
        }

        if event.getIntegerValueField(.eventSourceUserData) == Self.syntheticMarker {
            return Unmanaged.passUnretained(event)
        }

        guard let transition = transition(type: type, event: event) else {
            return Unmanaged.passUnretained(event)
        }

        let t = Clock.eventMs(event.timestamp)
        var shortcutUpdate: ShortcutUpdate?
        var staleOut = MatchOutput()
        var staleUpdates: [ShortcutUpdate] = []
        let out: MatchOutput = withLock {
            // flagsChanged のフラグは、その時点の修飾キーの状態を表す。押しているはずの修飾キーが無ければ
            // 解放を取りこぼしている（tap の無効化中に離された、など）。
            // keyDown/keyUp のフラグは前段の tap（他のアプリ）が書き換えることがあるので使わない。
            if type == .flagsChanged {
                var stale = staleModifiersLocked(flags: event.flags)
                if case let .release(key) = transition { stale.removeAll { $0 == key } }
                if case let .press(key, _) = transition { stale.removeAll { $0 == key } }
                if !stale.isEmpty {
                    Log.info("released stale modifiers: \(stale.joined(separator: ","))")
                    (staleOut, staleUpdates) = releaseStaleLocked(stale)
                }
            } else if type == .keyDown, atFront, matcher.down.contains("Fn"),
                      !event.flags.contains(.maskSecondaryFn), Self.isHardwareEvent(event) {
                // 先頭にいるので、keyDown のフラグは前段の tap に書き換えられていない。
                // Fn を押しているはずなのにフラグが無ければ、Fn の解放を取りこぼしている（HK-4）
                Log.info("released stale modifiers on keyDown: Fn")
                (staleOut, staleUpdates) = releaseStaleLocked(["Fn"])
            }
            let recording = recordingDeadline != nil
            switch transition {
            case let .press(key, isRepeat):
                if recording && !isRepeat && Self.isRecordable(key) { shortcutUpdate = recorder.press(key) }
                return matcher.press(key, isRepeat: isRepeat)
            case let .release(key):
                if recording && Self.isRecordable(key) { shortcutUpdate = recorder.release(key) }
                return matcher.release(key)
            }
        }

        if Log.debugEnabled {
            let kc = event.getIntegerValueField(.keyboardEventKeycode)
            let pid = event.getIntegerValueField(.eventSourceUnixProcessID)
            Log.debug("event type=\(type.rawValue) kc=\(kc) \(transition) flags=0x\(String(event.flags.rawValue, radix: 16)) srcPid=\(pid) swallow=\(out.swallow) emits=\(out.events)")
        }

        for u in staleUpdates + (shortcutUpdate.map { [$0] } ?? []) {
            Output.shared.send("shortcut_keys", ShortcutKeysPayload(keys: u.keys, combo: u.combo, done: u.done))
        }
        emit(staleOut.events + out.events, t: t)
        if out.events.contains(HotkeyEvent(.activate, .down)) {
            mouseBaseline = withLock { matcher.holdsPointerInterruptibleActivate } ? Self.mouseCounters() : nil
        }
        // 貼り付け後の監視に、利用者のキー入力を知らせる（Return のときは、アプリに届く前に欄を読む）
        if type == .keyDown, !out.swallow, case let .press(key, isRepeat) = transition, !isRepeat {
            FieldWatcher.shared.noteKey(key, flags: event.flags, at: t)
        }
        return out.swallow ? nil : Unmanaged.passUnretained(event)
    }

    /// ⌃⌥⌘⇧ だけのショートカットを押している間にクリックかスクロールがあれば interrupted を出す（HK-1）。
    /// Fn を含むショートカットは対象外（Fn を押したままクリックして入力位置を決めるのは普通の使い方）。
    /// 左右クリックとスクロールは tap のマスクに入れず、セッションのイベント数を 250ms ごとに比べて知る
    private func checkMouseWhileHolding(now: Double) {
        guard let base = mouseBaseline else { return }
        guard withLock({ matcher.holdsPointerInterruptibleActivate }) else {
            mouseBaseline = nil
            return
        }
        guard Self.mouseCounters() != base else { return }
        mouseBaseline = nil
        let out = withLock { matcher.interruptOnPointer() }
        if !out.events.isEmpty { Log.info("click or scroll while holding a modifier-only shortcut") }
        emit(out.events, t: now)
    }

    private static func mouseCounters() -> [UInt32] {
        [CGEventType.leftMouseDown, .rightMouseDown, .scrollWheel].map {
            CGEventSource.counterForEventType(.combinedSessionState, eventType: $0)
        }
    }

    /// ハードウェアからのイベントか（HID の状態表をソースに持つ）。他のアプリの合成イベントで Fn を外さないため
    private static func isHardwareEvent(_ event: CGEvent) -> Bool {
        event.getIntegerValueField(.eventSourceStateID) == Int64(CGEventSourceStateID.hidSystemState.rawValue)
    }

    private static func isRecordable(_ key: String) -> Bool {
        KeyTable.isValidName(key)
    }

    private func transition(type: CGEventType, event: CGEvent) -> Transition? {
        switch type {
        case .keyDown:
            let code = UInt16(truncatingIfNeeded: event.getIntegerValueField(.keyboardEventKeycode))
            let isRepeat = event.getIntegerValueField(.keyboardEventAutorepeat) != 0
            return .press(Self.keyName(code), isRepeat: isRepeat)
        case .keyUp:
            let code = UInt16(truncatingIfNeeded: event.getIntegerValueField(.keyboardEventKeycode))
            return .release(Self.keyName(code))
        case .flagsChanged:
            let code = UInt16(truncatingIfNeeded: event.getIntegerValueField(.keyboardEventKeycode))
            guard let name = KeyTable.nameByKeyCode[code], let kind = KeyTable.modifierKind(ofPhysical: name) else {
                return nil // CapsLock など
            }
            let flags = event.flags
            let isDown: Bool
            if kind == .fn {
                // Fn は keycode 63 の flagsChanged で判定する（SecondaryFn フラグは矢印キーなどにも付くため単独では使わない）
                isDown = flags.contains(.maskSecondaryFn)
            } else if !flags.contains(Self.flag(for: kind)) {
                isDown = false
            } else {
                let raw = flags.rawValue
                let sideBits = kind.physicalNames.compactMap { Self.deviceBits[$0] }.reduce(0, |)
                if raw & sideBits != 0, let mine = Self.deviceBits[name] {
                    isDown = raw & mine != 0
                } else {
                    // 左右の情報がないイベント（他のソフトの合成など）は、いまの状態を反転させる
                    isDown = !withLock { matcher.down.contains(name) }
                }
            }
            return isDown ? .press(name, isRepeat: false) : .release(name)
        case .otherMouseDown, .otherMouseUp:
            let button = event.getIntegerValueField(.mouseEventButtonNumber)
            guard let name = KeyTable.mouseNameByButton[button] else { return nil }
            return type == .otherMouseDown ? .press(name, isRepeat: false) : .release(name)
        default:
            return nil
        }
    }

    private static func keyName(_ code: UInt16) -> String {
        KeyTable.nameByKeyCode[code] ?? "KeyCode\(code)"
    }

    // MARK: - 送信

    private func emit(_ events: [HotkeyEvent], t: Double) {
        let rounded = (t * 1000).rounded() / 1000
        for e in events {
            Output.shared.send("hotkey", HotkeyPayload(action: e.action.rawValue, phase: e.phase.rawValue, t: rounded))
        }
    }

    private func withLock<R>(_ body: () -> R) -> R {
        lock.lock()
        defer { lock.unlock() }
        return body()
    }
}
