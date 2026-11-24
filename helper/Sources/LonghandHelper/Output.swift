import Foundation

/// Writes to stdout (reserved for the protocol). Every line goes through one serial queue, so lines never interleave.
final class Output: Sendable {
    static let shared = Output()

    private let queue = DispatchQueue(label: "longhand.stdout", qos: .userInteractive)
    /// Called when a write fails (the parent closed the pipe)
    private let brokenPipeHandler = LockedValue<(@Sendable () -> Void)?>(nil)
    private let broken = LockedValue(false)

    func onBrokenPipe(_ handler: @escaping @Sendable () -> Void) {
        brokenPipeHandler.set(handler)
    }

    func send<P: Encodable>(_ type: String, id: String? = nil, _ payload: P) {
        let envelope = OutEnvelope(type: type, id: id, payload: payload)
        let data: Data
        do {
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.withoutEscapingSlashes]
            data = try encoder.encode(envelope) + Data([0x0A])
        } catch {
            Log.error("encode failed for \(type): \(error)")
            return
        }
        queue.async { [self] in write(data) }
    }

    func sendError(id: String?, code: String, message: String) {
        send("error", id: id, ErrorPayload(code: code, message: message))
    }

    /// Waits until every queued line has been written
    func flush() {
        queue.sync {}
    }

    private func write(_ data: Data) {
        if broken.get() { return }
        let ok = data.withUnsafeBytes { raw -> Bool in
            guard var p = raw.baseAddress else { return true }
            var remaining = raw.count
            while remaining > 0 {
                let n = Darwin.write(STDOUT_FILENO, p, remaining)
                if n < 0 {
                    if errno == EINTR || errno == EAGAIN { continue }
                    return false
                }
                remaining -= n
                p = p.advanced(by: n)
            }
            return true
        }
        if !ok {
            broken.set(true)
            Log.warn("stdout closed (errno \(errno)); shutting down")
            brokenPipeHandler.get()?()
        }
    }
}

private struct OutEnvelope<P: Encodable>: Encodable {
    let type: String
    let id: String?
    let payload: P
}

/// A value guarded by a lock (a small box to meet Swift 6's Sendable requirements)
final class LockedValue<T>: @unchecked Sendable {
    private var value: T
    private let lock = NSLock()

    init(_ value: T) { self.value = value }

    func get() -> T {
        lock.lock(); defer { lock.unlock() }
        return value
    }

    func set(_ newValue: T) {
        lock.lock(); defer { lock.unlock() }
        value = newValue
    }

    @discardableResult
    func update<R>(_ body: (inout T) -> R) -> R {
        lock.lock(); defer { lock.unlock() }
        return body(&value)
    }
}
