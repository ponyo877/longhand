@preconcurrency import AVFoundation
import AudioToolbox
import CoreAudio
import Foundation
import LonghandCore

/// AVAudioEngine でマイクを録音し、16kHz モノラル Float32 に変換して 100ms（1600 サンプル）ごとに audio_chunk を送る。
///
/// - 制御（start / stop / デバイス変化）は control キューで順に処理する。
/// - 変換とチャンク化は tap のスレッドで行い、セッションの状態は stateLock で守る。
/// - エンジンは同じデバイスなら使い回し、停止後も prepare しておいて次の開始を速くする。
final class AudioCapture: @unchecked Sendable {
    static let shared = AudioCapture()

    private let control = DispatchQueue(label: "longhand.audio.control", qos: .userInitiated)
    private let stateLock = NSLock()

    static let sampleRate: Double = 16000
    static let chunkSamples = 1600

    private let outFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: AudioCapture.sampleRate,
                                          channels: 1, interleaved: false)!

    // control キューだけが触る
    private var engine: AVAudioEngine?
    private var engineDevice: AudioDevices.Device?
    private var configObserver: NSObjectProtocol?
    private var watchdog: DispatchSourceTimer?
    private var configCheck: DispatchWorkItem?
    private var restartTimes: [Double] = []

    // stateLock で守る（tap のスレッドからも触る）
    private var converter: AVAudioConverter?
    private var session: Session?
    private var lastBufferAt: Double = 0
    private var lastBufferDuration: Double = 0.02
    /// 終わったセッション（audio_stop に答えるため）
    private var ended: [Int: (status: String, chunks: Int)] = [:]

    private struct Session {
        let id: Int
        var device: AudioDevices.Device
        /// main が指定したデバイス（nil ならシステム既定に追従）
        let requestedUID: String?
        var seq = 0
        var chunker = AudioChunker(chunkSize: AudioCapture.chunkSamples)
        var failed = false
        let startedAt: Double
        var firstBufferAt: Double?
    }

    // MARK: - 公開 API（stdin スレッドから呼ぶ）

    /// requestId は audio_start の id。audio_started と、開始時の audio_error にそのまま付ける
    func start(sessionId: Int, deviceUID: String?, requestId: String?) {
        control.async { [self] in startOnControl(sessionId: sessionId, deviceUID: deviceUID, requestId: requestId) }
    }

    /// requestId は audio_stop の id。audio_stopped にそのまま付ける
    func stop(sessionId: Int, requestId: String?) {
        control.async { [self] in stopOnControl(sessionId: sessionId, requestId: requestId) }
    }

    /// 終了時。録音中なら止める（audio_stopped は送らない）
    func shutdown() {
        control.sync {
            if let engine, engine.isRunning { engine.stop() }
            stateLock.withLock { session = nil }
        }
    }

    /// デバイス一覧が変わったとき（AudioDevices の監視から呼ぶ）
    func devicesChanged() {
        control.async { [self] in
            guard let s = stateLock.withLock({ session }), !s.failed else { return }
            if AudioDevices.device(uid: s.device.uid) == nil {
                handleDeviceLoss(reason: "device \(s.device.name) disappeared")
            }
        }
    }

    // MARK: - 開始

    private func startOnControl(sessionId: Int, deviceUID: String?, requestId: String?) {
        let sw = Stopwatch()
        if let current = stateLock.withLock({ session }) {
            Log.warn("audio_start(\(sessionId)) while session \(current.id) is active; stopping it first")
            finishSession(status: current.failed ? "incomplete" : "flushed", emitStopped: true)
        }

        // マイクの権限
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized:
            break
        case .notDetermined:
            let sem = DispatchSemaphore(value: 0)
            let granted = LockedValue(false)
            AVCaptureDevice.requestAccess(for: .audio) { ok in
                granted.set(ok)
                sem.signal()
            }
            _ = sem.wait(timeout: .now() + 120)
            if !granted.get() {
                sendError(sessionId, "permission_denied", "microphone permission was not granted", fatal: true, id: requestId)
                return
            }
        default:
            sendError(sessionId, "permission_denied", "microphone permission is denied", fatal: true, id: requestId)
            return
        }

        // デバイスの決定
        var device: AudioDevices.Device?
        if let uid = deviceUID {
            device = AudioDevices.device(uid: uid)
            if device == nil {
                Log.warn("audio device \(uid) not found; falling back to the system default")
            }
        }
        if device == nil { device = AudioDevices.defaultInputDevice() }
        device = device.map(AudioDevices.avoidingClosedLid)
        guard let device else {
            sendError(sessionId, "no_device", "no audio input device is available", fatal: true, id: requestId)
            return
        }

        do {
            try ensureEngine(for: device)
        } catch {
            sendError(sessionId, "engine_failed", "failed to set up audio engine: \(error.localizedDescription)", fatal: true, id: requestId)
            return
        }

        stateLock.withLock {
            converter?.reset()
            session = Session(id: sessionId, device: device, requestedUID: deviceUID, startedAt: Clock.nowMs())
            lastBufferAt = 0
        }
        do {
            try startEngineWithRetry(device: device)
        } catch {
            stateLock.withLock { session = nil }
            teardownEngine()
            sendError(sessionId, "engine_failed", "failed to start audio engine: \(error.localizedDescription)", fatal: true, id: requestId)
            return
        }
        startWatchdog()
        Log.info("audio session \(sessionId) started on \(device.name) [\(device.transport)] in \(sw.elapsedMs)ms")
        Output.shared.send("audio_started", id: requestId, AudioStartedPayload(sessionId: sessionId, deviceId: device.uid,
                                                                 deviceName: device.name, transport: device.transport))
    }

    /// エンジンを始める。デバイスの切り替え直後や他のアプリがマイクを掴んだ直後は一時的に失敗することがあるので、
    /// 100ms おきに最大 5 回試す。失敗したらエンジンを作り直してから試し直す
    static let startAttempts = 5
    static let startRetryIntervalUs: useconds_t = 100_000

    private func startEngineWithRetry(device: AudioDevices.Device) throws {
        var lastError: Error = HelperError("audio engine is not ready")
        for attempt in 1...Self.startAttempts {
            do {
                if engine == nil {
                    try ensureEngine(for: device)
                    stateLock.withLock { converter?.reset() }
                }
                guard let engine else { throw HelperError("audio engine is not ready") }
                try engine.start()
                if attempt > 1 { Log.info("audio engine started on attempt \(attempt)") }
                return
            } catch {
                lastError = error
                Log.warn("audio engine start failed (attempt \(attempt)/\(Self.startAttempts)): \(error.localizedDescription)")
                teardownEngine()
                if attempt < Self.startAttempts { usleep(Self.startRetryIntervalUs) }
            }
        }
        throw lastError
    }

    /// 指定デバイス用のエンジンを用意する（同じデバイスなら使い回す）
    private func ensureEngine(for device: AudioDevices.Device) throws {
        if engine != nil, engineDevice?.id == device.id { return }
        teardownEngine()

        let e = AVAudioEngine()
        let input = e.inputNode
        guard let au = input.audioUnit else { throw HelperError("input node has no audio unit") }
        var devID = device.id
        let st = AudioUnitSetProperty(au, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0,
                                      &devID, UInt32(MemoryLayout<AudioDeviceID>.size))
        guard st == noErr else { throw HelperError("cannot select device \(device.name) (OSStatus \(st))") }

        let hwFormat = input.outputFormat(forBus: 0)
        guard hwFormat.sampleRate > 0, hwFormat.channelCount > 0 else {
            throw HelperError("device \(device.name) reports an invalid format \(hwFormat)")
        }
        guard let conv = AVAudioConverter(from: hwFormat, to: outFormat) else {
            throw HelperError("cannot convert from \(hwFormat)")
        }
        conv.downmix = true
        stateLock.withLock { converter = conv }

        // 20ms 程度のバッファを頼む（実際の大きさは OS が決める）
        let bufferSize = AVAudioFrameCount(max(256, hwFormat.sampleRate * 0.02))
        input.installTap(onBus: 0, bufferSize: bufferSize, format: hwFormat) { [weak self] buffer, _ in
            self?.process(buffer)
        }
        e.prepare()

        configObserver = NotificationCenter.default.addObserver(
            forName: .AVAudioEngineConfigurationChange, object: e, queue: nil
        ) { [weak self] _ in
            guard let self else { return }
            self.control.async { self.scheduleConfigurationCheck() }
        }
        engine = e
        engineDevice = device
        Log.info("audio engine ready for \(device.name): \(Int(hwFormat.sampleRate))Hz x\(hwFormat.channelCount)")
    }

    private func teardownEngine() {
        if let configObserver { NotificationCenter.default.removeObserver(configObserver) }
        configObserver = nil
        if let engine {
            if engine.isRunning { engine.stop() }
            engine.inputNode.removeTap(onBus: 0)
        }
        engine = nil
        engineDevice = nil
        stateLock.withLock { converter = nil }
    }

    // MARK: - 変換（tap のスレッド）

    private final class OnceFlag: @unchecked Sendable { var done = false }

    private func process(_ buffer: AVAudioPCMBuffer) {
        let now = Clock.nowMs()
        stateLock.lock()
        defer { stateLock.unlock() }
        lastBufferAt = now
        lastBufferDuration = Double(buffer.frameLength) / max(1, buffer.format.sampleRate)
        guard var s = session, !s.failed, let converter else { return }
        if s.firstBufferAt == nil {
            s.firstBufferAt = now
            Log.info("audio session \(s.id): first buffer after \(Int(now - s.startedAt))ms (\(buffer.frameLength) frames)")
        }
        let samples = convert(buffer, with: converter, endOfStream: false)
        let chunks = s.chunker.append(samples)
        for c in chunks { emitChunk(&s, c) }
        session = s
    }

    /// endOfStream が true のときは、変換器に残ったサンプルを吐き出させる
    private func convert(_ buffer: AVAudioPCMBuffer?, with converter: AVAudioConverter, endOfStream: Bool) -> [Float] {
        let inFrames = Double(buffer?.frameLength ?? 0)
        let ratio = outFormat.sampleRate / converter.inputFormat.sampleRate
        let capacity = AVAudioFrameCount(inFrames * ratio + 512)
        guard let out = AVAudioPCMBuffer(pcmFormat: outFormat, frameCapacity: capacity) else { return [] }
        let flag = OnceFlag()
        var error: NSError?
        let status = converter.convert(to: out, error: &error) { _, inputStatus in
            if let buffer, !flag.done {
                flag.done = true
                inputStatus.pointee = .haveData
                return buffer
            }
            inputStatus.pointee = endOfStream ? .endOfStream : .noDataNow
            return nil
        }
        if status == .error {
            Log.warn("audio conversion failed: \(error?.localizedDescription ?? "?")")
            return []
        }
        guard let data = out.floatChannelData, out.frameLength > 0 else { return [] }
        return Array(UnsafeBufferPointer(start: data[0], count: Int(out.frameLength)))
    }

    private func emitChunk(_ s: inout Session, _ samples: [Float]) {
        let payload = AudioChunkPayload(
            sessionId: s.id, seq: s.seq, pcm: AudioMath.base64Float32LE(samples),
            rms: Self.round4(AudioMath.rms(samples)), peak: Self.round4(AudioMath.peak(samples))
        )
        s.seq += 1
        Output.shared.send("audio_chunk", payload)
    }

    private static func round4(_ v: Float) -> Double {
        (Double(v) * 10000).rounded() / 10000
    }

    // MARK: - 停止

    private func stopOnControl(sessionId: Int, requestId: String?) {
        guard let s = stateLock.withLock({ session }), s.id == sessionId else {
            let prior = stateLock.withLock { ended.removeValue(forKey: sessionId) }
            Output.shared.send("audio_stopped", id: requestId, AudioStoppedPayload(sessionId: sessionId, status: prior?.status ?? "incomplete",
                                                                     chunks: prior?.chunks ?? 0))
            return
        }
        if !s.failed {
            // 停止要求の時点までの音声が tap に届くのを少し待つ
            let tail = stateLock.withLock { lastBufferDuration }
            let waitMs = min(150, max(30, tail * 1000 + 15))
            usleep(useconds_t(waitMs * 1000))
        }
        finishSession(status: s.failed ? "incomplete" : "flushed", emitStopped: true, requestId: requestId)
    }

    /// エンジンを止め、残りを吐き出してセッションを閉じる
    /// requestId は audio_stop への返答のときだけ渡す（割り込みで閉じるときは nil）
    private func finishSession(status: String, emitStopped: Bool, requestId: String? = nil) {
        stopWatchdog()
        if let engine, engine.isRunning { engine.stop() }
        let result: (id: Int, status: String, chunks: Int)? = stateLock.withLock {
            guard var s = session else { return nil }
            if let converter {
                if !s.failed {
                    let tail = convert(nil, with: converter, endOfStream: true)
                    for c in s.chunker.append(tail) { emitChunk(&s, c) }
                    if let rest = s.chunker.flush() { emitChunk(&s, rest) }
                }
                converter.reset()
            }
            session = nil
            let finalStatus = s.failed ? "incomplete" : status
            if !emitStopped { ended[s.id] = (finalStatus, s.seq) }
            if ended.count > 16 { ended.removeAll() }
            return (s.id, finalStatus, s.seq)
        }
        // 次の開始を速くするため、止めたエンジンを prepare しておく
        engine?.prepare()
        guard let result else { return }
        Log.info("audio session \(result.id) stopped: \(result.status), \(result.chunks) chunks")
        if emitStopped {
            Output.shared.send("audio_stopped", id: requestId, AudioStoppedPayload(sessionId: result.id, status: result.status, chunks: result.chunks))
        }
    }

    // MARK: - デバイスの変化と異常

    /// 構成変更の通知はまとめて（150ms）処理する。macOS では開始直後にも 1 回届くことがある
    /// （入力と出力が別デバイスのとき、エンジンが CADefaultDeviceAggregate を作るため）
    private func scheduleConfigurationCheck() {
        configCheck?.cancel()
        let item = DispatchWorkItem { [weak self] in self?.handleConfigurationChange() }
        configCheck = item
        control.asyncAfter(deadline: .now() + 0.15, execute: item)
    }

    private func handleConfigurationChange() {
        guard let engine, let device = engineDevice else { return }
        let alive = AudioDevices.device(uid: device.uid) != nil
        let changed = inputFormatChanged()
        guard let s = stateLock.withLock({ session }), !s.failed else {
            if !alive || changed {
                Log.info("audio configuration changed while idle; engine will be rebuilt on next start")
                teardownEngine()
            }
            return
        }
        if engine.isRunning && alive && !changed {
            Log.debug("audio configuration change ignored (engine still running)")
            return
        }
        if !alive {
            handleDeviceLoss(reason: "device \(s.device.name) is gone")
            return
        }
        let now = Clock.nowMs()
        restartTimes = restartTimes.filter { now - $0 < 3000 } + [now]
        if restartTimes.count > 3 {
            markFailed(code: "engine_failed", message: "audio engine keeps reconfiguring")
            return
        }
        Log.warn("audio configuration changed during session \(s.id) (running=\(engine.isRunning), formatChanged=\(changed)); restarting")
        restart(on: device, sessionId: s.id, note: nil)
    }

    private func inputFormatChanged() -> Bool {
        guard let engine, let conv = stateLock.withLock({ converter }) else { return true }
        let f = engine.inputNode.outputFormat(forBus: 0)
        return f.sampleRate != conv.inputFormat.sampleRate || f.channelCount != conv.inputFormat.channelCount
    }

    /// 録音中のデバイスが消えた。指定のデバイスで録音していた場合も含め、別の入力に切り替えて続ける
    /// （それまでの音声は捨てない。main には致命的でない device_lost で知らせる）
    private func handleDeviceLoss(reason: String) {
        guard let s = stateLock.withLock({ session }), !s.failed else { return }
        if let next = Self.fallbackInput(excluding: s.device) {
            let what = s.requestedUID == nil ? "default input" : "selected input"
            restart(on: next, sessionId: s.id, note: "\(reason) (\(what)); switched to \(next.name)")
            return
        }
        Log.warn("audio session \(s.id): \(reason); no other input is available")
        markFailed(code: "device_lost", message: reason)
    }

    /// 切り替え先: 既定の入力（消えたデバイスでなければ）、なければ仮想でない生きている入力の最初のもの
    static func fallbackInput(excluding lost: AudioDevices.Device) -> AudioDevices.Device? {
        if let def = AudioDevices.defaultInputDevice(), def.uid != lost.uid, def.isAlive { return AudioDevices.avoidingClosedLid(def) }
        return AudioDevices.list().first { $0.uid != lost.uid && !$0.isVirtual }.map(AudioDevices.avoidingClosedLid)
    }

    private func restart(on device: AudioDevices.Device, sessionId: Int, note: String?) {
        teardownEngine()
        do {
            try ensureEngine(for: device)
            stateLock.withLock {
                converter?.reset()
                session?.device = device
                lastBufferAt = 0
            }
            try startEngineWithRetry(device: device)
            if let note {
                sendError(sessionId, "device_lost", note, fatal: false)
            }
            Log.info("audio session \(sessionId) continues on \(device.name)")
        } catch {
            markFailed(code: "engine_failed", message: "failed to restart audio engine: \(error.localizedDescription)")
        }
    }

    /// セッションを失敗扱いにする（それまでの音声は吐き出す）。audio_stop が来たら incomplete で答える
    private func markFailed(code: String, message: String) {
        guard let id = stateLock.withLock({ session?.id }) else { return }
        sendError(id, code, message, fatal: true)
        stateLock.withLock {
            if var s = session {
                if let rest = s.chunker.flush() { emitChunk(&s, rest) }
                s.failed = true
                session = s
            }
        }
        finishSession(status: "incomplete", emitStopped: false)
        teardownEngine()
    }

    private func startWatchdog() {
        stopWatchdog()
        let timer = DispatchSource.makeTimerSource(queue: control)
        timer.schedule(deadline: .now() + 0.5, repeating: 0.5)
        timer.setEventHandler { [weak self] in self?.checkStall() }
        timer.resume()
        watchdog = timer
    }

    private func stopWatchdog() {
        watchdog?.cancel()
        watchdog = nil
    }

    /// 音声が届かなくなったら（Bluetooth の切断など）異常として扱う
    private func checkStall() {
        let (s, last) = stateLock.withLock { (session, lastBufferAt) }
        guard let s, !s.failed else { return }
        let now = Clock.nowMs()
        let silentFor = last > 0 ? now - last : now - s.startedAt
        let limit: Double = last > 0 ? 2000 : 5000
        guard silentFor > limit else { return }
        if AudioDevices.device(uid: s.device.uid) == nil {
            handleDeviceLoss(reason: "device \(s.device.name) disappeared")
        } else {
            Log.warn("audio session \(s.id): no audio for \(Int(silentFor))ms")
            markFailed(code: "engine_failed", message: "no audio received for \(Int(silentFor)) ms")
        }
    }

    /// id は audio_start への返答として失敗を返すときだけ付ける（録音中の異常は id なしのイベント）
    private func sendError(_ sessionId: Int?, _ code: String, _ message: String, fatal: Bool, id: String? = nil) {
        Log.warn("audio_error \(code): \(message)")
        Output.shared.send("audio_error", id: id, AudioErrorPayload(sessionId: sessionId, code: code, message: message, fatal: fatal))
    }
}

struct HelperError: Error, LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}
