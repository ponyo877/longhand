import Foundation

// Groups 16 kHz mono Float32 samples into chunks of a fixed size (1600 = 100 ms by default).

public struct AudioChunker: Sendable {
    public let chunkSize: Int
    private var buffer: [Float] = []

    public init(chunkSize: Int = 1600) {
        precondition(chunkSize > 0)
        self.chunkSize = chunkSize
        buffer.reserveCapacity(chunkSize * 2)
    }

    public var pendingCount: Int { buffer.count }

    /// Appends samples and returns the completed chunks
    public mutating func append(_ samples: [Float]) -> [[Float]] {
        buffer.append(contentsOf: samples)
        var chunks: [[Float]] = []
        while buffer.count >= chunkSize {
            chunks.append(Array(buffer[0..<chunkSize]))
            buffer.removeFirst(chunkSize)
        }
        return chunks
    }

    /// Takes out the remaining samples (fewer than chunkSize). nil if there are none
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

    /// Base64 of little-endian Float32
    public static func base64Float32LE(_ samples: [Float]) -> String {
        var data = Data(capacity: samples.count * 4)
        for s in samples {
            var le = s.bitPattern.littleEndian
            withUnsafeBytes(of: &le) { data.append(contentsOf: $0) }
        }
        return data.base64EncodedString()
    }

    /// Turns base64 back into a Float32 array (for tests and diagnostics)
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
