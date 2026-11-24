import Foundation
import LonghandCore

/// Logs go to stderr only (stdout is reserved for the protocol). warn and error are also sent to main as log messages.
enum Log {
    /// LONGHAND_HELPER_DEBUG=1 turns on detailed logs such as key input
    static let debugEnabled: Bool = {
        let v = ProcessInfo.processInfo.environment["LONGHAND_HELPER_DEBUG"] ?? ""
        return v == "1" || v.lowercased() == "true"
    }()

    private static let queue = DispatchQueue(label: "longhand.stderr", qos: .utility)

    static func debug(_ message: @autoclosure () -> String) {
        guard debugEnabled else { return }
        write("DEBUG", message())
    }

    static func info(_ message: String) {
        write("INFO", message)
    }

    static func warn(_ message: String) {
        write("WARN", message)
        Output.shared.send("log", HelperLogPayload(level: "warn", message: message))
    }

    static func error(_ message: String) {
        write("ERROR", message)
        Output.shared.send("log", HelperLogPayload(level: "error", message: message))
    }

    private static func write(_ level: String, _ message: String) {
        let ts = Clock.wallTimestamp()
        let line = "\(ts) [LonghandHelper] \(level) \(message)\n"
        queue.async {
            FileHandle.standardError.write(Data(line.utf8))
        }
    }

    static func flush() {
        queue.sync {}
    }
}

enum Clock {
    /// Monotonic time (milliseconds since boot; does not advance during sleep).
    /// Node's process.hrtime keeps advancing during sleep (CLOCK_MONOTONIC_RAW), so the two drift apart by the time asleep. Only compare this clock with itself.
    static func nowMs() -> Double {
        Double(clock_gettime_nsec_np(CLOCK_UPTIME_RAW)) / 1_000_000
    }

    /// How many nanoseconds one mach_absolute_time tick is. 1/1 on Intel, 125/3 (about 41.67 ns) on Apple Silicon.
    private static let timebase: mach_timebase_info_data_t = {
        var tb = mach_timebase_info_data_t()
        mach_timebase_info(&tb)
        return tb
    }()

    /// Converts a CGEvent timestamp to milliseconds on the same base as nowMs().
    /// Timestamps arrive in mach_absolute_time ticks. On Apple Silicon these are not nanoseconds, so
    /// dividing by one million as is makes time run at only about 1/42 of the real speed
    /// (a hold of several seconds was judged a short tap under 0.4 seconds, and the recording was canceled).
    static func eventMs(_ timestamp: UInt64) -> Double {
        timestamp == 0 ? nowMs() : MachTime.ticksToMs(timestamp, numer: timebase.numer, denom: timebase.denom)
    }

    static func wallTimestamp() -> String {
        var tv = timeval()
        gettimeofday(&tv, nil)
        var tmv = tm()
        var secs = tv.tv_sec
        localtime_r(&secs, &tmv)
        return String(format: "%02d:%02d:%02d.%03d", tmv.tm_hour, tmv.tm_min, tmv.tm_sec, Int(tv.tv_usec / 1000))
    }
}

/// Measures elapsed time in milliseconds
struct Stopwatch {
    let start = Clock.nowMs()
    var elapsedMs: Int { Int((Clock.nowMs() - start).rounded()) }
    var elapsed: Double { Clock.nowMs() - start }
}
