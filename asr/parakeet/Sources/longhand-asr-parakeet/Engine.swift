@preconcurrency import CoreML
import FluidAudio
import Foundation

struct EngineError: Error {
    let code: String
    let message: String
}

struct SegmentOut {
    let start: Double
    let end: Double
    let text: String
}

struct TranscribeOut {
    let text: String
    let segments: [SegmentOut]
    let chunks: Int
}

/// load.options で変えられる設定
struct EngineOptions {
    /// エンコーダの実行先: "ane"（既定、Neural Engine）| "gpu" | "cpu" | "all"
    var computeUnits = "ane"
    var warmup = true
    var vad = VadConfig()
    var plan = SegmentPlanConfig()
    /// 句読点や記号だけの結果は捨てる
    var dropPunctuationOnly = true
    /// 「ピッ。」「フフッ。」のような、短いカタカナの擬音だけの文を捨てる（通知音や笑い声を拾ったもの）
    var dropOnomatopoeia = true

    static func parse(_ o: [String: Any]) -> EngineOptions {
        var r = EngineOptions()
        if let v = o["computeUnits"] as? String { r.computeUnits = v }
        if let v = o["warmup"] as? Bool { r.warmup = v }
        if let v = o["trimSilence"] as? Bool { r.plan.trim = v }
        if let v = o["splitMode"] as? String, let m = SplitMode(rawValue: v) { r.plan.split = m }
        if let v = num(o["maxChunkSec"]) { r.plan.maxChunkSec = min(14.5, max(3, v)) }
        if let v = num(o["minChunkSec"]) { r.plan.minChunkSec = max(0.5, v) }
        if let v = num(o["minPauseMs"]) { r.plan.minPauseMs = Int(v) }
        if let v = num(o["vadMinThresholdDb"]) { r.vad.minThresholdDb = Float(v) }
        if let v = num(o["vadRelDb"]) { r.vad.relDb = Float(v) }
        if let v = num(o["vadHardFloorDb"]) { r.vad.hardFloorDb = Float(v) }
        if let v = num(o["vadMinDynamicRangeDb"]) { r.vad.minDynamicRangeDb = Float(v) }
        if let v = num(o["minSpeechMs"]) { r.vad.minSpeechMs = Int(v) }
        if let v = num(o["padStartMs"]) { r.vad.padStartMs = Int(v) }
        if let v = num(o["padEndMs"]) { r.vad.padEndMs = Int(v) }
        if let v = o["dropPunctuationOnly"] as? Bool { r.dropPunctuationOnly = v }
        if let v = o["dropOnomatopoeia"] as? Bool { r.dropOnomatopoeia = v }
        return r
    }

    private static func num(_ v: Any?) -> Double? {
        if let d = v as? Double { return d }
        if let i = v as? Int { return Double(i) }
        if let n = v as? NSNumber { return n.doubleValue }
        return nil
    }
}

final class ParakeetEngine {
    private var manager: AsrManager?
    private(set) var options = EngineOptions()
    private(set) var modelDescription = ""

    var isLoaded: Bool { manager != nil }

    func load(modelPath: String, options: EngineOptions) async throws {
        let dir = URL(fileURLWithPath: (modelPath as NSString).expandingTildeInPath, isDirectory: true)
        var isDir: ObjCBool = false
        guard !modelPath.isEmpty, FileManager.default.fileExists(atPath: dir.path, isDirectory: &isDir), isDir.boolValue
        else {
            throw EngineError(code: "model_not_found", message: "model directory not found: \(modelPath)")
        }
        let required = ["Preprocessor.mlmodelc", "Encoder.mlmodelc", "Decoderv2.mlmodelc", "Jointerv2.mlmodelc", "vocab.json"]
        let missing = required.filter { !FileManager.default.fileExists(atPath: dir.appendingPathComponent($0).path) }
        if !missing.isEmpty {
            throw EngineError(
                code: "model_not_found", message: "missing in \(dir.path): \(missing.joined(separator: ", "))")
        }

        let encoderUnits: MLComputeUnits
        switch options.computeUnits {
        case "gpu": encoderUnits = .cpuAndGPU
        case "cpu": encoderUnits = .cpuOnly
        case "all": encoderUnits = .all
        default: encoderUnits = .cpuAndNeuralEngine
        }

        let models: AsrModels
        do {
            // ダウンロードやリポジトリの解決をせず、このディレクトリだけから読む
            models = try AsrModels.loadLocal(
                from: dir, version: .tdtJa, encoderComputeUnits: encoderUnits)
        } catch {
            throw EngineError(code: "model_not_found", message: "failed to load models: \(error)")
        }
        if let old = manager { await old.cleanup() }
        let m = AsrManager(config: .default, models: models)
        manager = m
        self.options = options
        modelDescription = "parakeet-tdt_ctc-0.6b-ja (CoreML, encoder=\(options.computeUnits)) @ \(dir.path)"

        if options.warmup {
            // 1 回推論して、Core ML の初回の準備（ANE のプログラム読み込みなど）を済ませる
            var noise = [Float](repeating: 0, count: kSampleRate)
            var seed: UInt32 = 12345
            for i in 0..<noise.count {
                seed = seed &* 1_103_515_245 &+ 12345
                noise[i] = (Float(seed >> 16 & 0x7FFF) / 32768.0 - 0.5) * 0.002
            }
            var state = try TdtDecoderState(decoderLayers: 2)
            _ = try? await m.transcribe(noise, decoderState: &state)
        }
    }

    func transcribe(samples: [Float]) async throws -> TranscribeOut {
        guard let m = manager else { throw EngineError(code: "not_loaded", message: "model is not loaded") }
        guard let chunks = planChunks(samples: samples, vad: options.vad, plan: options.plan) else {
            return TranscribeOut(text: "", segments: [], chunks: 0)
        }
        var texts: [String] = []
        var segments: [SegmentOut] = []
        let minSamples = Int(Double(kSampleRate) * 0.5)
        for c in chunks {
            var piece = Array(samples[c.start..<c.end])
            if piece.count < minSamples {
                // FluidAudio は 0.3 秒未満を受け付けない。短い発話は無音で 0.5 秒まで伸ばす
                piece += [Float](repeating: 0, count: minSamples - piece.count)
            }
            var state = try TdtDecoderState(decoderLayers: 2)
            let r: ASRResult
            do {
                r = try await m.transcribe(piece, decoderState: &state)
            } catch {
                throw EngineError(code: "inference_failed", message: "\(error)")
            }
            let t = r.text.trimmingCharacters(in: .whitespacesAndNewlines)
            if t.isEmpty { continue }
            if options.dropPunctuationOnly && isPunctuationOnly(t) { continue }
            let offset = Double(c.start) / Double(kSampleRate)
            var segs = sentenceSegments(
                result: r, text: t, offset: offset, chunkDuration: Double(c.end - c.start) / Double(kSampleRate))
            var chunkText = t
            if options.dropOnomatopoeia {
                let kept = segs.filter { !isOnomatopoeiaSentence($0.text) }
                if kept.count != segs.count {
                    segs = kept
                    chunkText = removeOnomatopoeiaSentences(t)
                }
            }
            if chunkText.isEmpty || (options.dropPunctuationOnly && isPunctuationOnly(chunkText)) { continue }
            texts.append(chunkText)
            segments.append(contentsOf: segs)
        }
        return TranscribeOut(text: joinTexts(texts), segments: segments, chunks: chunks.count)
    }

    /// トークンの時刻を使って、句点などで文ごとの区間に分ける。うまく対応が取れなければ区間 1 つにする。
    private func sentenceSegments(result r: ASRResult, text: String, offset: Double, chunkDuration: Double)
        -> [SegmentOut]
    {
        let whole = SegmentOut(
            start: round3(offset + (r.tokenTimings?.first?.startTime ?? 0)),
            end: round3(offset + (r.tokenTimings?.last?.endTime ?? chunkDuration)), text: text)
        guard let timings = r.tokenTimings, !timings.isEmpty else { return [whole] }
        let joined = timings.map { $0.token.replacingOccurrences(of: "▁", with: " ") }.joined()
        guard joined.trimmingCharacters(in: .whitespaces) == text else { return [whole] }
        var out: [SegmentOut] = []
        var buf = ""
        var segStart: Double? = nil
        for t in timings {
            let piece = t.token.replacingOccurrences(of: "▁", with: " ")
            if segStart == nil { segStart = t.startTime }
            buf += piece
            if let last = piece.last, "。？！?!".contains(last) {
                let s = buf.trimmingCharacters(in: .whitespaces)
                if !s.isEmpty {
                    out.append(SegmentOut(start: round3(offset + segStart!), end: round3(offset + t.endTime), text: s))
                }
                buf = ""
                segStart = nil
            }
        }
        let rest = buf.trimmingCharacters(in: .whitespaces)
        if !rest.isEmpty, let s = segStart {
            out.append(SegmentOut(start: round3(offset + s), end: round3(offset + timings.last!.endTime), text: rest))
        }
        return out.isEmpty ? [whole] : out
    }
}

func round3(_ v: Double) -> Double { (v * 1000).rounded() / 1000 }

private let onomatopoeiaRegex = try! NSRegularExpression(pattern: "^[\\p{Katakana}ー]{0,3}ッ[。、！？!?.,]*$")

/// 「ピッ。」「ピピッ！」「フフッ。」のような、小さい「ッ」で終わる 4 文字以下のカタカナだけの文か
func isOnomatopoeiaSentence(_ s: String) -> Bool {
    let t = s.trimmingCharacters(in: .whitespaces)
    return onomatopoeiaRegex.firstMatch(in: t, range: NSRange(t.startIndex..., in: t)) != nil
}

/// 文末記号で区切り、擬音だけの文を取り除いてつなぎ直す
func removeOnomatopoeiaSentences(_ s: String) -> String {
    var out = ""
    var cur = ""
    for ch in s {
        cur.append(ch)
        if "。！？!?".contains(ch) {
            if !isOnomatopoeiaSentence(cur) { out += cur }
            cur = ""
        }
    }
    if !cur.isEmpty && !isOnomatopoeiaSentence(cur) { out += cur }
    return out.trimmingCharacters(in: .whitespaces)
}

func isPunctuationOnly(_ s: String) -> Bool {
    s.unicodeScalars.allSatisfy {
        CharacterSet.punctuationCharacters.contains($0) || CharacterSet.symbols.contains($0)
            || CharacterSet.whitespacesAndNewlines.contains($0)
    }
}

/// 区間ごとの文字列をつなぐ。両側が英数字のときだけ空白を入れる。
func joinTexts(_ parts: [String]) -> String {
    var out = ""
    for p in parts {
        if let a = out.unicodeScalars.last, let b = p.unicodeScalars.first,
            a.isASCII && CharacterSet.alphanumerics.contains(a) && b.isASCII && CharacterSet.alphanumerics.contains(b)
        {
            out += " "
        }
        out += p
    }
    return out
}
