import FluidAudio
import Foundation

let kSampleRate = 16_000

enum AudioError: Error, CustomStringConvertible {
    case badBase64
    case badPcmLength(Int)
    case fileNotFound(String)
    case unreadable(String)

    var description: String {
        switch self {
        case .badBase64: return "pcm is not valid base64"
        case .badPcmLength(let n): return "pcm byte length \(n) is not a multiple of 4 (Float32)"
        case .fileNotFound(let p): return "wav file not found: \(p)"
        case .unreadable(let m): return "cannot read audio: \(m)"
        }
    }
}

/// base64 の Float32 LE（16 kHz モノラル）を復号する。
func decodePcmBase64(_ b64: String) throws -> [Float] {
    guard let data = Data(base64Encoded: b64, options: .ignoreUnknownCharacters) else { throw AudioError.badBase64 }
    guard data.count % 4 == 0 else { throw AudioError.badPcmLength(data.count) }
    let count = data.count / 4
    var out = [Float](repeating: 0, count: count)
    out.withUnsafeMutableBytes { dst in
        data.withUnsafeBytes { src in
            dst.copyMemory(from: src)
        }
    }
    return sanitize(out)
}

/// WAV を読む。16 kHz モノラルの PCM16 / Float32 は自前で読み、それ以外は FluidAudio の AudioConverter（AVAudioFile）で 16 kHz モノラルに変換する。
func readWav(path: String) throws -> [Float] {
    guard FileManager.default.fileExists(atPath: path) else { throw AudioError.fileNotFound(path) }
    let url = URL(fileURLWithPath: path)
    if let samples = try? readSimpleWav(url: url) { return sanitize(samples) }
    do {
        return sanitize(try AudioConverter().resampleAudioFile(url))
    } catch {
        throw AudioError.unreadable("\(error)")
    }
}

private func readSimpleWav(url: URL) throws -> [Float]? {
    let data = try Data(contentsOf: url, options: .mappedIfSafe)
    guard data.count >= 44 else { return nil }
    return data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) -> [Float]? in
        func u32(_ o: Int) -> UInt32 { raw.loadUnaligned(fromByteOffset: o, as: UInt32.self).littleEndian }
        func u16(_ o: Int) -> UInt16 { raw.loadUnaligned(fromByteOffset: o, as: UInt16.self).littleEndian }
        guard u32(0) == 0x4646_4952 /* RIFF */, u32(8) == 0x4556_4157 /* WAVE */ else { return nil }
        var off = 12
        var format: UInt16 = 0
        var channels = 0
        var rate = 0
        var bits = 0
        var dataOff = -1
        var dataLen = 0
        while off + 8 <= raw.count {
            let id = u32(off)
            let len = Int(u32(off + 4))
            let body = off + 8
            if id == 0x2074_6D66 /* fmt  */ && body + 16 <= raw.count {
                format = u16(body)
                channels = Int(u16(body + 2))
                rate = Int(u32(body + 4))
                bits = Int(u16(body + 14))
                if format == 0xFFFE && len >= 26 && body + 26 <= raw.count { format = u16(body + 24) }  // WAVE_FORMAT_EXTENSIBLE
            } else if id == 0x6174_6164 /* data */ {
                dataOff = body
                dataLen = min(len, raw.count - body)
                break
            }
            off = body + len + (len & 1)
        }
        guard dataOff >= 0, rate == kSampleRate, channels >= 1 else { return nil }
        let frameBytes = channels * bits / 8
        guard frameBytes > 0 else { return nil }
        let frames = dataLen / frameBytes
        var out = [Float](repeating: 0, count: frames)
        if format == 1 && bits == 16 {
            for i in 0..<frames {
                var acc: Float = 0
                for c in 0..<channels {
                    acc += Float(raw.loadUnaligned(fromByteOffset: dataOff + i * frameBytes + c * 2, as: Int16.self).littleEndian)
                }
                out[i] = acc / Float(channels) / 32768.0
            }
        } else if format == 3 && bits == 32 {
            for i in 0..<frames {
                var acc: Float = 0
                for c in 0..<channels {
                    acc += raw.loadUnaligned(fromByteOffset: dataOff + i * frameBytes + c * 4, as: Float.self)
                }
                out[i] = acc / Float(channels)
            }
        } else {
            return nil
        }
        return out
    }
}

private func sanitize(_ x: [Float]) -> [Float] {
    if x.allSatisfy({ $0.isFinite }) { return x }
    return x.map { $0.isFinite ? max(-1, min(1, $0)) : 0 }
}

// MARK: - エネルギーによる無音判定、前後の無音の削除、ポーズでの分割

struct VadConfig {
    /// フレーム長（ms）
    var frameMs = 20
    /// 発話とみなす閾値の下限（dBFS）。実際の閾値は「雑音の床 + relDb」と比べて大きい方
    var minThresholdDb: Float = -60
    /// 雑音の床（フレーム dB の 10 パーセンタイル）からの高さ
    var relDb: Float = 15
    /// 閾値の絶対的な下限（dBFS）。これより小さいフレームは常に無音
    var hardFloorDb: Float = -62
    /// フレーム dB の 99 パーセンタイルと 10 パーセンタイルの差がこれ未満なら、
    /// 抑揚のない定常音（空調やホワイトノイズ）とみなして無音扱いにする
    var minDynamicRangeDb: Float = 10
    /// 発話フレームの合計がこれ未満なら無音とみなす（ms）
    var minSpeechMs = 150
    /// 前後の無音を削るときに残す余白（ms）
    var padStartMs = 300
    var padEndMs = 400
}

struct EnergyProfile {
    let frameSamples: Int
    let db: [Float]
    let threshold: Float
    /// p99 - p10（dB）
    let dynamicRange: Float
    var frameCount: Int { db.count }

    init(samples: [Float], config: VadConfig) {
        let fs = kSampleRate * config.frameMs / 1000
        frameSamples = fs
        let n = samples.count / fs
        var dbs = [Float](repeating: -120, count: n)
        samples.withUnsafeBufferPointer { p in
            for i in 0..<n {
                var sum: Float = 0
                let base = i * fs
                for j in 0..<fs {
                    let v = p[base + j]
                    sum += v * v
                }
                let rms = (sum / Float(fs)).squareRoot()
                dbs[i] = 20 * log10(rms + 1e-7)
            }
        }
        db = dbs
        if n == 0 {
            threshold = 0
            dynamicRange = 0
            return
        }
        let sorted = dbs.sorted()
        let floorDb = sorted[min(n - 1, n / 10)]
        let p99 = sorted[min(n - 1, (n * 99) / 100)]
        dynamicRange = p99 - floorDb
        var thr = max(floorDb + config.relDb, config.minThresholdDb)
        // 全体が発話の短いクリップで閾値が発話より上に行かないようにする
        thr = min(thr, p99 - 6)
        // ただし絶対値の下限は割らない（デジタル無音や小さな定常雑音を発話とみなさない）
        threshold = max(thr, config.hardFloorDb)
    }

    func isSpeech(_ i: Int) -> Bool { db[i] >= threshold }

    var speechFrameCount: Int { db.reduce(0) { $0 + ($1 >= threshold ? 1 : 0) } }
}

struct Chunk {
    /// 元の音声内のサンプル位置
    let start: Int
    let end: Int
}

enum SplitMode: String {
    /// 分割しない（15 秒を超える音声は FluidAudio の窓分割に任せる）
    case none
    /// maxChunkSec を超えるときだけ、ポーズで分割する
    case long
    /// minPauseMs 以上のポーズごとに分割する（短すぎる断片は隣とまとめる）
    case pauses
}

struct SegmentPlanConfig {
    /// 前後の無音を削る。評価では、削ると最初の文が落ちる例があり、平均では悪化したので既定は false
    var trim = false
    var split: SplitMode = .long
    /// モデルの窓（15 秒）。long モードでは、これ以下の音声は分割しない
    var windowSec: Double = 15.0
    var maxChunkSec: Double = 14.0
    var minChunkSec: Double = 2.0
    var minPauseMs = 500
}

/// 無音なら nil。そうでなければ書き起こす区間のリストを返す。
func planChunks(samples: [Float], vad: VadConfig, plan: SegmentPlanConfig) -> [Chunk]? {
    let prof = EnergyProfile(samples: samples, config: vad)
    let fs = prof.frameSamples
    guard prof.frameCount > 0 else { return nil }
    let speechFrames = prof.speechFrameCount
    if speechFrames * vad.frameMs < vad.minSpeechMs { return nil }
    if prof.dynamicRange < vad.minDynamicRangeDb { return nil }

    var first = 0
    var last = prof.frameCount - 1
    if plan.trim {
        while first < prof.frameCount && !prof.isSpeech(first) { first += 1 }
        while last > first && !prof.isSpeech(last) { last -= 1 }
    }
    let padS = vad.padStartMs / vad.frameMs
    let padE = vad.padEndMs / vad.frameMs
    let startFrame = plan.trim ? max(0, first - padS) : 0
    let endFrame = plan.trim ? min(prof.frameCount, last + 1 + padE) : prof.frameCount
    let windowFrames = Int(plan.windowSec * 1000) / vad.frameMs
    if plan.split == .none || (plan.split == .long && endFrame - startFrame <= windowFrames) {
        let endSample = plan.trim ? min(samples.count, endFrame * fs) : samples.count
        return [Chunk(start: startFrame * fs, end: endSample)]
    }

    // ポーズ（閾値未満が minPauseMs 以上続く区間）を集める
    let minPauseFrames = max(1, plan.minPauseMs / vad.frameMs)
    var pauses: [(start: Int, end: Int)] = []  // フレーム番号 [start, end)
    var i = first
    while i <= last {
        if !prof.isSpeech(i) {
            var j = i
            while j <= last && !prof.isSpeech(j) { j += 1 }
            if j - i >= minPauseFrames { pauses.append((i, j)) }
            i = j
        } else {
            i += 1
        }
    }

    let maxFrames = Int(plan.maxChunkSec * 1000) / vad.frameMs
    let minFrames = Int(plan.minChunkSec * 1000) / vad.frameMs
    var cuts: [Int] = []  // フレーム番号。区間の境界

    switch plan.split {
    case .none:
        break
    case .pauses:
        var lastCut = startFrame
        for p in pauses {
            let mid = (p.start + p.end) / 2
            if mid - lastCut >= minFrames && endFrame - mid >= minFrames {
                cuts.append(mid)
                lastCut = mid
            }
        }
    case .long:
        break
    }

    // どのモードでも maxChunkSec を超える区間は分割する
    var bounds = [startFrame] + cuts + [endFrame]
    var k = 0
    while k < bounds.count - 1 {
        let a = bounds[k]
        let b = bounds[k + 1]
        if b - a > maxFrames {
            // a + minFrames .. a + maxFrames の中で一番長いポーズの中央、なければ一番静かなフレームで切る
            let lo = a + minFrames
            let hi = a + maxFrames
            var best: Int? = nil
            var bestLen = 0
            for p in pauses where p.end > lo && p.start < hi {
                let s = max(p.start, lo)
                let e = min(p.end, hi)
                if e - s > bestLen {
                    bestLen = e - s
                    best = (s + e) / 2
                }
            }
            if best == nil {
                var minDb: Float = .infinity
                var idx = hi
                for f in max(lo, hi - 150)..<min(hi, prof.frameCount) where prof.db[f] < minDb {
                    minDb = prof.db[f]
                    idx = f
                }
                best = idx
            }
            bounds.insert(best!, at: k + 1)
        } else {
            k += 1
        }
    }

    var chunks: [Chunk] = []
    for k in 0..<(bounds.count - 1) {
        var a = bounds[k]
        var b = bounds[k + 1]
        // 区間の前後に残った長い無音は余白の分だけ残して削る
        if plan.trim {
            var f = a
            while f < b && !prof.isSpeech(f) { f += 1 }
            var l = b - 1
            while l > f && !prof.isSpeech(l) { l -= 1 }
            if f >= b { continue }  // 区間全体が無音
            a = max(a, f - padS)
            b = min(b, l + 1 + padE)
        }
        let s = a * fs
        let e = min(samples.count, b * fs)
        if k == bounds.count - 2 && !plan.trim {
            chunks.append(Chunk(start: s, end: samples.count))
        } else {
            chunks.append(Chunk(start: s, end: e))
        }
    }
    if chunks.isEmpty { return nil }
    return chunks
}
