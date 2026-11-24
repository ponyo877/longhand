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

/// Decodes base64 Float32 LE (16 kHz mono).
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

/// Reads a WAV. 16 kHz mono PCM16 / Float32 is read directly; anything else is converted to 16 kHz mono with FluidAudio's AudioConverter (AVAudioFile).
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

// MARK: - Energy-based silence detection, trimming leading and trailing silence, splitting at pauses

struct VadConfig {
    /// Frame length (ms)
    var frameMs = 20
    /// Lower bound of the speech threshold (dBFS). The actual threshold is the larger of this and "noise floor + relDb"
    var minThresholdDb: Float = -60
    /// Height above the noise floor (the 10th percentile of frame dB)
    var relDb: Float = 15
    /// Absolute lower bound of the threshold (dBFS). Frames below this are always silence
    var hardFloorDb: Float = -62
    /// If the difference between the 99th and 10th percentiles of frame dB is below this,
    /// the audio is taken as a flat steady sound (air conditioning or white noise) and treated as silence
    var minDynamicRangeDb: Float = 10
    /// Treated as silence if the total of speech frames is below this (ms)
    var minSpeechMs = 150
    /// Margin kept when trimming leading and trailing silence (ms)
    var padStartMs = 300
    var padEndMs = 400
}

struct EnergyProfile {
    let frameSamples: Int
    let db: [Float]
    let threshold: Float
    /// p99 - p10 (dB)
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
        // Keep the threshold from rising above the speech in a short clip that is all speech
        thr = min(thr, p99 - 6)
        // But never go below the absolute lower bound (so digital silence and faint steady noise are not taken as speech)
        threshold = max(thr, config.hardFloorDb)
    }

    func isSpeech(_ i: Int) -> Bool { db[i] >= threshold }

    var speechFrameCount: Int { db.reduce(0) { $0 + ($1 >= threshold ? 1 : 0) } }
}

struct Chunk {
    /// Sample positions in the original audio
    let start: Int
    let end: Int
}

enum SplitMode: String {
    /// Do not split (audio longer than 15 seconds is left to FluidAudio's window splitting)
    case none
    /// Split at pauses only when longer than maxChunkSec
    case long
    /// Split at every pause of minPauseMs or longer (pieces that are too short are merged with a neighbor)
    case pauses
}

struct SegmentPlanConfig {
    /// Trim leading and trailing silence. In evaluation, trimming sometimes lost the first sentence and was worse on average, so the default is false
    var trim = false
    var split: SplitMode = .long
    /// The model's window (15 seconds). In long mode, audio this long or shorter is not split
    var windowSec: Double = 15.0
    var maxChunkSec: Double = 14.0
    var minChunkSec: Double = 2.0
    var minPauseMs = 500
}

/// nil for silence. Otherwise returns the list of chunks to transcribe.
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

    // Collect pauses (stretches below the threshold lasting minPauseMs or longer)
    let minPauseFrames = max(1, plan.minPauseMs / vad.frameMs)
    var pauses: [(start: Int, end: Int)] = []  // Frame numbers [start, end)
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
    var cuts: [Int] = []  // Frame numbers of the chunk boundaries

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

    // In every mode, split chunks longer than maxChunkSec
    var bounds = [startFrame] + cuts + [endFrame]
    var k = 0
    while k < bounds.count - 1 {
        let a = bounds[k]
        let b = bounds[k + 1]
        if b - a > maxFrames {
            // Cut at the middle of the longest pause within a + minFrames .. a + maxFrames, or else at the quietest frame
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
        // Trim long silence left at either end of the chunk, keeping only the margin
        if plan.trim {
            var f = a
            while f < b && !prof.isSpeech(f) { f += 1 }
            var l = b - 1
            while l > f && !prof.isSpeech(l) { l -= 1 }
            if f >= b { continue }  // The whole chunk is silence
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
