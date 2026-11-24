// Loading and converting input audio. The internal format is always a 16 kHz mono Float32 array.

import AVFoundation
import Foundation

let SAMPLE_RATE: Double = 16_000

/// Decodes base64 Float32 little-endian PCM (16 kHz mono) back into an array.
func decodePcmBase64(_ base64: String) throws -> [Float] {
    guard let data = Data(base64Encoded: base64, options: [.ignoreUnknownCharacters]) else {
        throw AsrError(code: .badRequest, message: "pcm is not valid base64")
    }
    guard data.count % 4 == 0 else {
        throw AsrError(code: .badRequest, message: "pcm byte length \(data.count) is not a multiple of 4 (Float32)")
    }
    let count = data.count / 4
    var samples = [Float](repeating: 0, count: count)
    samples.withUnsafeMutableBytes { dst in
        _ = data.copyBytes(to: dst)
    }
    // Apple Silicon is little-endian, so no conversion is needed
    for i in 0..<count where !samples[i].isFinite { samples[i] = 0 }
    return samples
}

/// Reads a WAV (or another format AVAudioFile can read) and returns it as 16 kHz mono Float32.
func loadAudioFile(path: String) throws -> [Float] {
    let url = URL(fileURLWithPath: path)
    guard FileManager.default.fileExists(atPath: path) else {
        throw AsrError(code: .badRequest, message: "wavPath not found: \(path)")
    }
    let file: AVAudioFile
    do {
        file = try AVAudioFile(forReading: url)
    } catch {
        throw AsrError(code: .badRequest, message: "cannot open audio file: \(error.localizedDescription)")
    }
    let srcFormat = file.processingFormat
    let frames = AVAudioFrameCount(file.length)
    if frames == 0 { return [] }
    guard let buffer = AVAudioPCMBuffer(pcmFormat: srcFormat, frameCapacity: frames) else {
        throw AsrError(code: .badRequest, message: "cannot allocate audio buffer")
    }
    do {
        try file.read(into: buffer)
    } catch {
        throw AsrError(code: .badRequest, message: "cannot read audio file: \(error.localizedDescription)")
    }
    if srcFormat.sampleRate == SAMPLE_RATE, srcFormat.channelCount == 1,
       srcFormat.commonFormat == .pcmFormatFloat32, let ch = buffer.floatChannelData {
        return Array(UnsafeBufferPointer(start: ch[0], count: Int(buffer.frameLength)))
    }
    // Convert to 16 kHz mono Float32 if the sample rate or channel count differs
    let target = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: SAMPLE_RATE, channels: 1, interleaved: false)!
    let converted = try convert(buffer, to: target)
    guard let ch = converted.floatChannelData else { return [] }
    return Array(UnsafeBufferPointer(start: ch[0], count: Int(converted.frameLength)))
}

/// Turns a 16 kHz mono Float32 array into an AVAudioPCMBuffer.
func makeFloatBuffer(_ samples: [Float]) -> AVAudioPCMBuffer {
    let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: SAMPLE_RATE, channels: 1, interleaved: false)!
    let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(max(samples.count, 1)))!
    buffer.frameLength = AVAudioFrameCount(samples.count)
    samples.withUnsafeBufferPointer { src in
        if let base = src.baseAddress, samples.count > 0 {
            buffer.floatChannelData![0].update(from: base, count: samples.count)
        }
    }
    return buffer
}

/// Converts in one go with AVAudioConverter (assumes a whole file is passed at once).
func convert(_ input: AVAudioPCMBuffer, to format: AVAudioFormat) throws -> AVAudioPCMBuffer {
    if input.format == format { return input }
    guard let converter = AVAudioConverter(from: input.format, to: format) else {
        throw AsrError(code: .inferenceFailed, message: "cannot create converter \(input.format) -> \(format)")
    }
    let ratio = format.sampleRate / input.format.sampleRate
    let capacity = AVAudioFrameCount(Double(input.frameLength) * ratio + 1024)
    guard let output = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else {
        throw AsrError(code: .inferenceFailed, message: "cannot allocate converted buffer")
    }
    var consumed = false
    var convError: NSError?
    let status = converter.convert(to: output, error: &convError) { _, outStatus in
        if consumed {
            outStatus.pointee = .endOfStream
            return nil
        }
        consumed = true
        outStatus.pointee = .haveData
        return input
    }
    if status == .error {
        throw AsrError(code: .inferenceFailed, message: "audio conversion failed: \(convError?.localizedDescription ?? "unknown")")
    }
    return output
}

struct AudioStats {
    let durationSec: Double
    let peak: Float
    let rms: Float

    var peakDbfs: Double { peak > 0 ? 20 * log10(Double(peak)) : -200 }
    var rmsDbfs: Double { rms > 0 ? 20 * log10(Double(rms)) : -200 }
}

func audioStats(_ samples: [Float]) -> AudioStats {
    var peak: Float = 0
    var sumSq: Double = 0
    for s in samples {
        let a = abs(s)
        if a > peak { peak = a }
        sumSq += Double(s) * Double(s)
    }
    let rms = samples.isEmpty ? 0 : Float((sumSq / Double(samples.count)).squareRoot())
    return AudioStats(durationSec: Double(samples.count) / SAMPLE_RATE, peak: peak, rms: rms)
}
