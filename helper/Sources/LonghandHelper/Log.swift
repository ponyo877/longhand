import Foundation
import LonghandCore

/// ログは標準エラーにだけ出す（標準出力はプロトコル専用）。warn と error は log メッセージとしても main へ送る。
enum Log {
    /// LONGHAND_HELPER_DEBUG=1 でキー入力などの詳細ログを出す
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
    /// 単調増加の時刻（ミリ秒、起動からの経過。スリープ中は進まない）。
    /// Node の process.hrtime はスリープ中も進む（CLOCK_MONOTONIC_RAW）ので、スリープした時間の分だけずれる。比べるのはこの時計どうしだけにする。
    static func nowMs() -> Double {
        Double(clock_gettime_nsec_np(CLOCK_UPTIME_RAW)) / 1_000_000
    }

    /// mach_absolute_time の 1 刻みが何ナノ秒か。Intel では 1/1、Apple Silicon では 125/3（約 41.67 ns）。
    private static let timebase: mach_timebase_info_data_t = {
        var tb = mach_timebase_info_data_t()
        mach_timebase_info(&tb)
        return tb
    }()

    /// CGEvent のタイムスタンプを、nowMs() と同じ基準のミリ秒に直す。
    /// タイムスタンプは mach_absolute_time の刻みで届く。Apple Silicon ではナノ秒ではないので、
    /// そのまま 100 万で割ると、時刻が実際の約 42 分の 1 の速さでしか進まない
    /// （数秒の長押しが 0.4 秒未満の短いタップと判定され、録音が取り消されていた）。
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

/// ミリ秒の経過時間を測る
struct Stopwatch {
    let start = Clock.nowMs()
    var elapsedMs: Int { Int((Clock.nowMs() - start).rounded()) }
    var elapsed: Double { Clock.nowMs() - start }
}
