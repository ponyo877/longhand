@preconcurrency import AVFoundation
import AudioToolbox
import CoreAudio
import Foundation
import LonghandCore

/// Records the microphone with AVAudioEngine, converts it to 16kHz mono Float32 and sends an audio_chunk every 100ms (1600 samples).
///
/// - Control (start / stop / device changes) is handled in order on the control queue.
/// - Conversion and chunking run on the tap thread, and stateLock guards the session state.
/// - The engine is reused for the same device and stays prepared after stopping, so the next start is faster.
final class AudioCapture: @unchecked Sendable {
    static let shared = AudioCapture()

    private let control = DispatchQueue(label: "longhand.audio.control", qos: .userInitiated)
    private let stateLock = NSLock()

    static let sampleRate: Double = 16000
    static let chunkSamples = 1600

    private let outFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: AudioCapture.sampleRate,
                                          channels: 1, interleaved: false)!

    // Only the control queue touches these
    private var engine: AVAudioEngine?
    private var engineDevice: AudioDevices.Device?
    private var configObserver: NSObjectProtocol?
    private var watchdog: DispatchSourceTimer?
    private var configCheck: DispatchWorkItem?
    private var restartTimes: [Double] = []

    // Guarded by stateLock (the tap thread touches these too)
    private var converter: AVAudioConverter?
    private var session: Session?
    private var lastBufferAt: Double = 0
    private var lastBufferDuration: Double = 0.02
    /// Sessions that have ended (to answer audio_stop)
    private var ended: [Int: (status: String, chunks: Int)] = [:]

    private struct Session {
        let id: Int
        var device: AudioDevices.Device
        /// The device main asked for (nil follows the system default)
        let requestedUID: String?
        var seq = 0
        var chunker = AudioChunker(chunkSize: AudioCapture.chunkSamples)
        var failed = false
        let startedAt: Double
        var firstBufferAt: Double?
    }

    // MARK: - Public API (called from the stdin thread)

    /// requestId is the id of audio_start. It is attached as is to audio_started and to an audio_error at start
    func start(sessionId: Int, deviceUID: String?, requestId: String?) {
        control.async { [self] in startOnControl(sessionId: sessionId, deviceUID: deviceUID, requestId: requestId) }
    }

    /// requestId is the id of audio_stop. It is attached as is to audio_stopped
    func stop(sessionId: Int, requestId: String?) {
        control.async { [self] in stopOnControl(sessionId: sessionId, requestId: requestId) }
    }

    /// On exit. Stops recording if it is running (does not send audio_stopped)
    func shutdown() {
        control.sync {
            if let engine, engine.isRunning { engine.stop() }
            stateLock.withLock { session = nil }
        }
    }

    /// When the device list changes (called from AudioDevices' monitoring)
    func devicesChanged() {
        control.async { [self] in
            guard let s = stateLock.withLock({ session }), !s.failed else { return }
            if AudioDevices.device(uid: s.device.uid) == nil {
                handleDeviceLoss(reason: "device \(s.device.name) disappeared")
            }
        }
    }

    // MARK: - Start

    private func startOnControl(sessionId: Int, deviceUID: String?, requestId: String?) {
        let sw = Stopwatch()
        if let current = stateLock.withLock({ session }) {
            Log.warn("audio_start(\(sessionId)) while session \(current.id) is active; stopping it first")
            finishSession(status: current.failed ? "incomplete" : "flushed", emitStopped: true)
        }

        // Microphone permission
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

        // Choose the device
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

    /// Starts the engine. It can fail for a moment right after a device switch or right after another app grabs the microphone, so
    /// it tries every 100ms, up to 5 times. After a failure it rebuilds the engine before trying again
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

    /// Sets up the engine for the given device (reused for the same device)
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

        // Ask for buffers of about 20ms (the OS decides the actual size)
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

    // MARK: - Conversion (tap thread)

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

    /// When endOfStream is true, drains the samples left in the converter
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

    // MARK: - Stop

    private func stopOnControl(sessionId: Int, requestId: String?) {
        guard let s = stateLock.withLock({ session }), s.id == sessionId else {
            let prior = stateLock.withLock { ended.removeValue(forKey: sessionId) }
            Output.shared.send("audio_stopped", id: requestId, AudioStoppedPayload(sessionId: sessionId, status: prior?.status ?? "incomplete",
                                                                     chunks: prior?.chunks ?? 0))
            return
        }
        if !s.failed {
            // Wait a little for the audio up to the stop request to reach the tap
            let tail = stateLock.withLock { lastBufferDuration }
            let waitMs = min(150, max(30, tail * 1000 + 15))
            usleep(useconds_t(waitMs * 1000))
        }
        finishSession(status: s.failed ? "incomplete" : "flushed", emitStopped: true, requestId: requestId)
    }

    /// Stops the engine, drains the rest and closes the session
    /// requestId is passed only when answering audio_stop (nil when closing because of an interruption)
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
        // Prepare the stopped engine so the next start is faster
        engine?.prepare()
        guard let result else { return }
        Log.info("audio session \(result.id) stopped: \(result.status), \(result.chunks) chunks")
        if emitStopped {
            Output.shared.send("audio_stopped", id: requestId, AudioStoppedPayload(sessionId: result.id, status: result.status, chunks: result.chunks))
        }
    }

    // MARK: - Device changes and failures

    /// Configuration change notifications are coalesced (150ms). On macOS one can also arrive right after starting
    /// (when input and output are different devices, because the engine creates CADefaultDeviceAggregate)
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

    /// The recording device disappeared. Switches to another input and continues, even if a specific device was selected
    /// (audio so far is kept. main is told with a non-fatal device_lost)
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

    /// Where to switch: the default input (unless it is the lost device), otherwise the first live input that is not virtual
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

    /// Marks the session as failed (audio so far is flushed). Answers incomplete when audio_stop comes
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

    /// Treats it as a failure when audio stops arriving (a Bluetooth disconnect, for example)
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

    /// id is attached only when returning a failure as the answer to audio_start (failures during recording are events without an id)
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
