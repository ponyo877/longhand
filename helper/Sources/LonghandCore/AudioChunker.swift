import Foundation

// 16kHz モノラル Float32 のサンプルを一定数（既定 1600 = 100ms）ずつのチャンクにまとめる。

public struct AudioChunker: Sendable {
    public let chunkSize: Int
    private var buffer: [Float] = []

    public init(chunkSize: Int = 1600) {
        precondition(chunkSize > 0)
        self.chunkSize = chunkSize
        buffer.reserveCapacity(chunkSize * 2)
    }

    public var pendingCount: Int { buffer.count }

    /// サンプルを追加し、揃ったチャンクを返す
    public mutating func append(_ samples: [Float]) -> [[Float]] {
        buffer.append(contentsOf: samples)
        var chunks: [[Float]] = []
        while buffer.count >= chunkSize {
            chunks.append(Array(buffer[0..<chunkSize]))
            buffer.removeFirst(chunkSize)
        }
        return chunks
    }

    /// 残りのサンプル（chunkSize 未満）を取り出す。なければ nil
    public mutating func flush() -> [Float]? {
        guard !buffer.isEmpty else { return nil }
        defer { buffer.removeAll(keepingCapacity: true) }
        return buffer
    }

    public mutating func reset() {
        buffer.removeAll(keepingCapacity: true)
    }
}

public enum AudioMath {
    public static func rms(_ samples: [Float]) -> Float {
        guard !samples.isEmpty else { return 0 }
        var sum: Double = 0
        for s in samples { sum += Double(s) * Double(s) }
        return Float(min(1.0, (sum / Double(samples.count)).squareRoot()))
    }

    public static func peak(_ samples: [Float]) -> Float {
        var p: Float = 0
        for s in samples { p = max(p, abs(s)) }
        return min(1, p)
    }

    /// Float32 リトルエンディアンの base64
    public static func base64Float32LE(_ samples: [Float]) -> String {
        var data = Data(capacity: samples.count * 4)
        for s in samples {
            var le = s.bitPattern.littleEndian
            withUnsafeBytes(of: &le) { data.append(contentsOf: $0) }
        }
        return data.base64EncodedString()
    }

    /// base64 を Float32 の配列に戻す（テスト・診断用）
    public static func decodeFloat32LE(_ base64: String) -> [Float]? {
        guard let data = Data(base64Encoded: base64), data.count % 4 == 0 else { return nil }
        var out = [Float](repeating: 0, count: data.count / 4)
        data.withUnsafeBytes { raw in
            for i in 0..<out.count {
                let bits = raw.loadUnaligned(fromByteOffset: i * 4, as: UInt32.self)
                out[i] = Float(bitPattern: UInt32(littleEndian: bits))
            }
        }
        return out
    }
}
