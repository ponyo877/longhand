@preconcurrency import AVFoundation
import AppKit
import ApplicationServices
import Foundation
import LonghandCore

/// stdin から受けたメッセージを各モジュールへ振り分ける。終了処理も受け持つ。
final class Controller: @unchecked Sendable {
    static let shared = Controller()

    private let contextQueue = DispatchQueue(label: "longhand.context", qos: .userInitiated)
    private let miscQueue = DispatchQueue(label: "longhand.misc", qos: .utility)
    private let shuttingDown = LockedValue(false)

    // MARK: - 起動

    @MainActor
    func start() {
        signal(SIGPIPE, SIG_IGN)
        AX.configureGlobalTimeout()
        GlobeController.shared.recoverStaleReceipt()
        AudioDevices.startMonitoring { devices in
            Output.shared.send("audio_devices_changed", AudioDevicesPayload(devices: devices))
            AudioCapture.shared.devicesChanged()
        }
        Output.shared.onBrokenPipe { Controller.shared.shutdown(reason: "stdout closed") }
        installSignalHandlers()

        Log.info("LonghandHelper \(helperVersion) started (pid \(getpid()), trusted=\(AX.isTrusted()), debug=\(Log.debugEnabled))")
        Output.shared.send("ready", ReadyPayload(version: helperVersion, protocol: protocolVersion, pid: getpid()))
        // event_tap などの通知は ready の後に出す
        HotkeyEngine.shared.start()
        AppObserver.shared.start()
        startStdinReader()
    }

    private func startStdinReader() {
        let thread = Thread { [self] in
            while let line = readLine(strippingNewline: true) {
                if line.isEmpty { continue }
                handle(line: line)
            }
            shutdown(reason: "stdin closed")
        }
        thread.name = "longhand.stdin"
        thread.qualityOfService = .userInitiated
        thread.start()
    }

    nonisolated(unsafe) private var signalSources: [DispatchSourceSignal] = []

    @MainActor
    private func installSignalHandlers() {
        for sig in [SIGTERM, SIGINT, SIGHUP] {
            signal(sig, SIG_IGN)
            let src = DispatchSource.makeSignalSource(signal: sig, queue: .main)
            src.setEventHandler { Controller.shared.shutdown(reason: "signal \(sig)") }
            src.resume()
            signalSources.append(src)
        }
    }

    // MARK: - 振り分け

    func handle(line: String) {
        let data = Data(line.utf8)
        let header: InEnvelopeHeader
        do {
            header = try JSONDecoder().decode(InEnvelopeHeader.self, from: data)
        } catch {
            Log.warn("bad message: \(error) — \(line.prefix(200))")
            Output.shared.sendError(id: nil, code: "bad_request", message: "invalid JSON envelope")
            return
        }
        let id = header.id
        do {
            switch header.type {
            case "ping":
                Output.shared.send("pong", id: id, EmptyPayload())

            case "configure":
                let p = try decodePayload(ConfigurePayload.self, from: data)
                // 後続のメッセージ（record_shortcut など）との順序を保つため、終わるまで待つ
                DispatchQueue.main.sync { MainActor.assumeIsolated { self.configure(p, id: id) } }

            case "state_sync":
                let p = try decodePayload(StateSyncPayload.self, from: data)
                guard let state = PttState(rawValue: p.ptt) else {
                    throw HelperError("unknown ptt state \(p.ptt)")
                }
                HotkeyEngine.shared.setPttState(state)

            case "audio_start":
                let p = try decodePayload(AudioStartPayload.self, from: data)
                AudioCapture.shared.start(sessionId: p.sessionId, deviceUID: p.deviceId, requestId: id)

            case "audio_stop":
                let p = try decodePayload(AudioStopPayload.self, from: data)
                AudioCapture.shared.stop(sessionId: p.sessionId, requestId: id)

            case "list_audio_devices":
                miscQueue.async {
                    Output.shared.send("audio_devices", id: id, AudioDevicesPayload(devices: AudioDevices.payloads()))
                }

            case "get_context":
                let p = try decodePayload(GetContextPayload.self, from: data)
                contextQueue.async {
                    let ctx = ContextGatherer.gather(includeField: p.includeField ?? false, includeHost: p.includeHost ?? false,
                                                     maxContextChars: p.maxContextChars ?? 1000)
                    Output.shared.send("context", id: id, ctx)
                }

            case "paste":
                let p = try decodePayload(PastePayload.self, from: data)
                Paster.shared.paste(p, requestId: id)

            case "permissions":
                let p = try decodePayload(PermissionsPayload.self, from: data)
                permissions(prompt: p.prompt, id: id)

            case "record_shortcut":
                let p = try decodePayload(RecordShortcutPayload.self, from: data)
                HotkeyEngine.shared.setRecording(p.active)

            case "shutdown":
                shutdown(reason: "shutdown requested")

            default:
                Output.shared.sendError(id: id, code: "unknown_type", message: "unknown message type: \(header.type)")
            }
        } catch {
            Log.warn("bad payload for \(header.type): \(error)")
            Output.shared.sendError(id: id, code: "bad_request", message: "invalid payload for \(header.type): \(error.localizedDescription)")
        }
    }

    @MainActor
    private func configure(_ p: ConfigurePayload, id: String?) {
        let parsed = BindingParser.parse(p.hotkeys ?? [:])
        AppObserver.enhancedUIAllowed.set(p.chromiumEnhancedUI ?? true)
        HotkeyEngine.shared.configure(bindings: parsed.bindings)
        // 地球儀キーの動作を止めるのは、設定がオンで、かつ Fn だけのショートカットがあるときだけ（HK-6）
        let wantGlobeOff = (p.suppressGlobe ?? false) && parsed.bindings.contains { $0.isBareFn }
        if (p.suppressGlobe ?? false) && !wantGlobeOff { Log.info("configure: no Fn-only shortcut; globe key is left as is") }
        let globe = GlobeController.shared.setSuppressed(wantGlobeOff)
        if !parsed.errors.isEmpty { Log.warn("configure: " + parsed.errors.joined(separator: "; ")) }
        Output.shared.send("configured", id: id, ConfiguredPayload(ok: parsed.errors.isEmpty, errors: parsed.errors, globeSuppressed: globe))
    }

    private func permissions(prompt: String?, id: String?) {
        miscQueue.async {
            var accessibility = AX.isTrusted()
            if prompt == "accessibility" && !accessibility {
                accessibility = Paster.onMain { AX.isTrusted(prompt: true) }
            }
            if prompt == "microphone" && AVCaptureDevice.authorizationStatus(for: .audio) == .notDetermined {
                let sem = DispatchSemaphore(value: 0)
                AVCaptureDevice.requestAccess(for: .audio) { _ in sem.signal() }
                _ = sem.wait(timeout: .now() + 120)
            }
            Output.shared.send("permissions", id: id, PermissionsResultPayload(accessibility: accessibility, microphone: Self.microphoneStatus()))
        }
    }

    static func microphoneStatus() -> String {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: return "granted"
        case .denied: return "denied"
        case .restricted: return "restricted"
        case .notDetermined: return "undetermined"
        @unknown default: return "undetermined"
        }
    }

    // MARK: - 終了

    /// 後始末（地球儀キー設定の復元、録音の停止）をして終了する。どのスレッドから呼んでもよい
    func shutdown(reason: String) {
        let already = shuttingDown.update { v -> Bool in defer { v = true }; return v }
        if already { return }
        Log.info("shutting down: \(reason)")
        // メインスレッドが詰まっていても 3 秒で必ず終わる
        Thread.detachNewThread {
            Thread.sleep(forTimeInterval: 3)
            Log.warn("forced exit after timeout")
            Log.flush()
            exit(0)
        }
        DispatchQueue.main.async {
            GlobeController.shared.restore()
            AudioCapture.shared.shutdown()
            Output.shared.flush()
            Log.flush()
            exit(0)
        }
    }
}
