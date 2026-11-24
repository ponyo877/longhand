// longhand-asr-parakeet
//
// ASR worker that speaks the stdio JSON Lines protocol of src/shared/asr-protocol.ts.
// Runs Parakeet-TDT 0.6B Japanese with FluidAudio (Core ML).
// stdout is for the protocol only; logs go to stderr. Exits when stdin reaches EOF.

import FluidAudio
import Foundation

let kWorkerVersion = "0.1.0 (FluidAudio 0.18.4)"
let kProtocolVersion = 1

func log(_ s: String) {
    FileHandle.standardError.write(Data("[longhand-asr-parakeet] \(s)\n".utf8))
}

let stdoutLock = NSLock()
func send(_ obj: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: obj, options: [.withoutEscapingSlashes]) else {
        log("failed to encode a message")
        return
    }
    stdoutLock.lock()
    defer { stdoutLock.unlock() }
    data.withUnsafeBytes { p in _ = fwrite(p.baseAddress, 1, p.count, stdout) }
    fputc(0x0A, stdout)
    fflush(stdout)
}

func sendError(id: String?, code: String, message: String) {
    var msg: [String: Any] = ["type": "error", "payload": ["code": code, "message": message]]
    if let id { msg["id"] = id }
    send(msg)
}

/// Reads stdin one line at a time on a dedicated thread and feeds the lines into an AsyncStream (to read long base64 lines efficiently).
func stdinLines() -> AsyncStream<String> {
    AsyncStream { continuation in
        let thread = Thread {
            while let line = readLine(strippingNewline: true) {
                continuation.yield(line)
            }
            continuation.finish()
        }
        thread.stackSize = 1 << 20
        thread.start()
    }
}

func elapsedMs(since start: DispatchTime) -> Int {
    Int((DispatchTime.now().uptimeNanoseconds - start.uptimeNanoseconds) / 1_000_000)
}

@main
struct Main {
    static func main() async {
        // Suppress FluidAudio's info / debug logs (they may contain transcripts)
        setvbuf(stdout, nil, _IOFBF, 1 << 16)
        AppLogger.minimumLevel = .warning
        AppLogger.mirrorsToConsole = true

        let engine = ParakeetEngine()
        send([
            "type": "ready",
            "payload": ["engine": "parakeet-coreml", "version": kWorkerVersion, "protocol": kProtocolVersion],
        ])

        for await line in stdinLines() {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.isEmpty { continue }
            guard let data = trimmed.data(using: .utf8),
                let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                let type = obj["type"] as? String
            else {
                sendError(id: nil, code: "bad_request", message: "invalid JSON message")
                continue
            }
            let id = obj["id"] as? String
            let payload = obj["payload"] as? [String: Any] ?? [:]
            switch type {
            case "ping":
                send(["type": "pong", "id": id ?? "", "payload": [String: Any]()])
            case "load":
                await handleLoad(engine: engine, id: id, payload: payload)
            case "transcribe":
                await handleTranscribe(engine: engine, id: id, payload: payload)
            default:
                sendError(id: id, code: "bad_request", message: "unknown message type: \(type)")
            }
        }
        log("stdin closed; exiting")
        exit(0)
    }

    static func handleLoad(engine: ParakeetEngine, id: String?, payload: [String: Any]) async {
        let start = DispatchTime.now()
        let modelPath = payload["modelPath"] as? String ?? ""
        let language = payload["language"] as? String ?? "ja"
        if language != "ja" {
            log("warning: this model is Japanese-only; language=\(language) is treated as ja")
        }
        let options = EngineOptions.parse(payload["options"] as? [String: Any] ?? [:])
        do {
            try await engine.load(modelPath: modelPath, options: options)
            let ms = elapsedMs(since: start)
            log("loaded in \(ms) ms: \(engine.modelDescription)")
            send(["type": "loaded", "id": id ?? "", "payload": ["elapsedMs": ms, "model": engine.modelDescription]])
        } catch let e as EngineError {
            sendError(id: id, code: e.code, message: e.message)
        } catch {
            sendError(id: id, code: "unknown", message: "\(error)")
        }
    }

    static func handleTranscribe(engine: ParakeetEngine, id: String?, payload: [String: Any]) async {
        guard engine.isLoaded else {
            sendError(id: id, code: "not_loaded", message: "send load first")
            return
        }
        let start = DispatchTime.now()
        let samples: [Float]
        do {
            if let pcm = payload["pcm"] as? String {
                samples = try decodePcmBase64(pcm)
            } else if let path = payload["wavPath"] as? String {
                samples = try readWav(path: path)
            } else {
                sendError(id: id, code: "bad_request", message: "either pcm or wavPath is required")
                return
            }
        } catch {
            sendError(id: id, code: "bad_request", message: "\(error)")
            return
        }
        // hints / prompt: this model has no mechanism for vocabulary hints, so they are accepted and ignored
        do {
            let out = try await engine.transcribe(samples: samples)
            let ms = elapsedMs(since: start)
            log(
                String(
                    format: "transcribed %.2f s audio in %d ms (%d chunk(s), %d chars)",
                    Double(samples.count) / Double(kSampleRate), ms, out.chunks, out.text.count))
            send([
                "type": "result", "id": id ?? "",
                "payload": [
                    "text": out.text,
                    "language": "ja",
                    "elapsedMs": ms,
                    "segments": out.segments.map { ["start": $0.start, "end": $0.end, "text": $0.text] },
                ] as [String: Any],
            ])
        } catch let e as EngineError {
            sendError(id: id, code: e.code, message: e.message)
        } catch {
            sendError(id: id, code: "inference_failed", message: "\(error)")
        }
    }
}
