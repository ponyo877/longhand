// The stdio JSON Lines protocol of src/shared/asr-protocol.ts.
// stdout is for the protocol only. All logs go to stderr.

import Foundation

let ASR_PROTOCOL_VERSION = 1
let WORKER_VERSION = "0.1.0"

/// Logs to stderr. Never writes to stdout.
func log(_ message: String) {
    let line = "[longhand-asr-apple] \(message)\n"
    FileHandle.standardError.write(line.data(using: .utf8)!)
}

enum AsrErrorCode: String {
    case notLoaded = "not_loaded"
    case badRequest = "bad_request"
    case modelNotFound = "model_not_found"
    case inferenceFailed = "inference_failed"
    case unknown = "unknown"
}

struct AsrError: Error {
    let code: AsrErrorCode
    let message: String
}

/// Keeps all writes to stdout in one place (one message per line, flushed on every write).
final class ProtocolWriter: @unchecked Sendable {
    private let lock = NSLock()
    private let out = FileHandle.standardOutput

    func send(type: String, id: String?, payload: [String: Any]) {
        var envelope: [String: Any] = ["type": type, "payload": payload]
        if let id { envelope["id"] = id }
        guard JSONSerialization.isValidJSONObject(envelope),
              var data = try? JSONSerialization.data(withJSONObject: envelope, options: [.withoutEscapingSlashes])
        else {
            log("failed to serialize message of type \(type)")
            return
        }
        data.append(0x0A)
        lock.lock()
        defer { lock.unlock() }
        out.write(data)
    }

    func sendError(id: String?, _ error: AsrError) {
        send(type: "error", id: id, payload: ["code": error.code.rawValue, "message": error.message])
    }
}

/// Reads stdin one line at a time on a dedicated thread and feeds the lines into an AsyncStream.
/// readLine() is based on getline, so it is fast even for base64 lines of tens of MB. Closes the stream at EOF.
func stdinLines() -> AsyncStream<String> {
    AsyncStream { continuation in
        let thread = Thread {
            while let line = readLine(strippingNewline: true) {
                continuation.yield(line)
            }
            continuation.finish()
        }
        thread.name = "longhand-asr-apple.stdin"
        thread.stackSize = 1 << 20
        thread.start()
    }
}

// MARK: - Reading the payload

extension Dictionary where Key == String, Value == Any {
    func string(_ key: String) -> String? { self[key] as? String }
    func bool(_ key: String) -> Bool? {
        if let b = self[key] as? Bool { return b }
        if let n = self[key] as? NSNumber { return n.boolValue }
        return nil
    }
    func double(_ key: String) -> Double? {
        if let n = self[key] as? NSNumber { return n.doubleValue }
        if let s = self[key] as? String { return Double(s) }
        return nil
    }
    func stringArray(_ key: String) -> [String]? {
        guard let arr = self[key] as? [Any] else { return nil }
        return arr.compactMap { $0 as? String }
    }
    func dict(_ key: String) -> [String: Any]? { self[key] as? [String: Any] }
}
