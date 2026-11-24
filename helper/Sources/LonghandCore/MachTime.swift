import Foundation

/// mach_absolute_time の刻みをミリ秒に直す。
/// CGEvent のタイムスタンプはこの刻みで届く。1 刻みの長さは機種で違い、
/// Intel では 1 ns、Apple Silicon では 125/3 ns である（mach_timebase_info で分かる）。
public enum MachTime {
    public static func ticksToMs(_ ticks: UInt64, numer: UInt32, denom: UInt32) -> Double {
        guard denom != 0 else { return Double(ticks) / 1_000_000 }
        return Double(ticks) * Double(numer) / Double(denom) / 1_000_000
    }
}
