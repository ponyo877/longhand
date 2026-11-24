import Foundation

/// Converts mach_absolute_time ticks to milliseconds.
/// CGEvent timestamps arrive in these ticks. The length of one tick depends on the machine:
/// 1 ns on Intel and 125/3 ns on Apple Silicon (mach_timebase_info tells which).
public enum MachTime {
    public static func ticksToMs(_ ticks: UInt64, numer: UInt32, denom: UInt32) -> Double {
        guard denom != 0 else { return Double(ticks) / 1_000_000 }
        return Double(ticks) * Double(numer) / Double(denom) / 1_000_000
    }
}
