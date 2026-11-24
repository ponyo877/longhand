// Entry point of longhand-asr-apple. Reads requests from stdin one line at a time and handles them in order.

import Foundation

@main
struct LonghandAsrApple {
    static func main() async {
        // If the parent exits first and stdout closes, treat it as a write error instead of dying from SIGPIPE
        signal(SIGPIPE, SIG_IGN)

        let writer = ProtocolWriter()
        let engine = AppleSpeechEngine()
        writer.send(type: "ready", id: nil, payload: [
            "engine": "apple-speech",
            "version": WORKER_VERSION,
            "protocol": ASR_PROTOCOL_VERSION,
        ])
        log("ready (pid \(ProcessInfo.processInfo.processIdentifier))")

        for await line in stdinLines() {
            let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.isEmpty { continue }
            await handle(line: trimmed, engine: engine, writer: writer)
        }
        log("stdin closed; exiting")
        exit(0)
    }

    static func handle(line: String, engine: AppleSpeechEngine, writer: ProtocolWriter) async {
        guard let data = line.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data),
              let msg = obj as? [String: Any]
        else {
            writer.sendError(id: nil, AsrError(code: .badRequest, message: "invalid JSON line"))
            return
        }
        let id = msg.string("id")
        let type = msg.string("type") ?? ""
        let payload = msg.dict("payload") ?? [:]

        do {
            switch type {
            case "ping":
                writer.send(type: "pong", id: id, payload: [:])

            case "load":
                let t0 = Date()
                let language = payload.string("language") ?? "ja"
                let model = try await engine.load(language: language, options: payload.dict("options"))
                let ms = Date().timeIntervalSince(t0) * 1000
                log(String(format: "loaded %@ in %.0f ms", model, ms))
                writer.send(type: "loaded", id: id, payload: ["elapsedMs": round(ms), "model": model])

            case "transcribe":
                guard engine.isLoaded else {
                    throw AsrError(code: .notLoaded, message: "model is not loaded; send load first")
                }
                let t0 = Date()
                let samples: [Float]
                if let pcm = payload.string("pcm") {
                    samples = try decodePcmBase64(pcm)
                } else if let path = payload.string("wavPath") {
                    samples = try loadAudioFile(path: path)
                } else {
                    throw AsrError(code: .badRequest, message: "transcribe needs pcm or wavPath")
                }
                let out = try await engine.transcribe(
                    samples: samples,
                    language: payload.string("language"),
                    hints: payload.stringArray("hints") ?? []
                )
                let ms = Date().timeIntervalSince(t0) * 1000
                log(String(format: "transcribed %.2f s audio in %.0f ms (%d segments)",
                           Double(samples.count) / SAMPLE_RATE, ms, out.segments.count))
                writer.send(type: "result", id: id, payload: [
                    "text": out.text,
                    "language": out.language,
                    "elapsedMs": round(ms),
                    "segments": out.segments.map { seg in
                        [
                            "start": (seg.start * 1000).rounded() / 1000,
                            "end": (seg.end * 1000).rounded() / 1000,
                            "text": seg.text,
                        ] as [String: Any]
                    },
                ])

            default:
                throw AsrError(code: .badRequest, message: "unknown message type: \(type)")
            }
        } catch let e as AsrError {
            log("error (\(e.code.rawValue)): \(e.message)")
            writer.sendError(id: id, e)
        } catch {
            log("error: \(error)")
            writer.sendError(id: id, AsrError(code: .unknown, message: String(describing: error)))
        }
    }
}
