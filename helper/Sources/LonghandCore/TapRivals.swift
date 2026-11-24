// Decides the "fight for the front" between event taps (HK-4). Pure logic kept apart from the OS, verified with XCTest.
//
// HID-level taps receive events in the order they are lined up. If an active (not listen-only) tap is ahead of ours,
// we only get events after that tap has swallowed or rewritten keys.
// We take the order of CGGetEventTapList as the processing order, and if a rival is ahead of our tap, recreate ours to get back to the front.
// In case the rival also fights to get the front back, re-creating against the same rival is capped.

/// The fields we need, copied from CGEventTapInformation
public struct TapEntry: Equatable, Sendable {
    /// kCGHIDEventTap = 0, kCGSessionEventTap = 1, kCGAnnotatedSessionEventTap = 2
    public var tapPoint: UInt32
    /// kCGEventTapOptionDefault = 0 (active), kCGEventTapOptionListenOnly = 1
    public var options: UInt32
    public var enabled: Bool
    public var eventsOfInterest: UInt64
    /// The process that created the tap
    public var tappingPid: Int32

    public init(tapPoint: UInt32, options: UInt32, enabled: Bool, eventsOfInterest: UInt64, tappingPid: Int32) {
        self.tapPoint = tapPoint
        self.options = options
        self.enabled = enabled
        self.eventsOfInterest = eventsOfInterest
        self.tappingPid = tappingPid
    }

    public static let hidTapPoint: UInt32 = 0
    public static let defaultOptions: UInt32 = 0
}

public enum RivalTapFinder {
    /// Returns a rival lined up ahead of our HID-level tap.
    /// - Rival: HID level, enabled, active, events of interest overlapping our mask, another process
    /// - nil if our own tap comes first (we are at the front)
    /// - nil if our tap is not in the list (we cannot tell, so do nothing)
    public static func rivalInFront(_ entries: [TapEntry], ownPid: Int32, ownMask: UInt64) -> TapEntry? {
        var candidate: TapEntry?
        for e in entries where e.tapPoint == TapEntry.hidTapPoint {
            if e.tappingPid == ownPid {
                return candidate
            }
            if candidate == nil, e.enabled, e.options == TapEntry.defaultOptions,
               e.eventsOfInterest & ownMask != 0 {
                candidate = e
            }
        }
        return nil
    }
}

/// Limits re-creating against the same rival to maxMoves times within windowMs
public struct RivalBackoff: Sendable {
    public enum Decision: Equatable, Sendable {
        /// OK to re-create
        case move
        /// Over the limit. Returned only the first time (the signal to tell main)
        case giveUp
        /// A rival we already gave up on. Do nothing
        case ignore
    }

    public let maxMoves: Int
    public let windowMs: Double
    private var moves: [Int32: [Double]] = [:]
    private var gaveUp: Set<Int32> = []

    public init(maxMoves: Int = 3, windowMs: Double = 60_000) {
        self.maxMoves = maxMoves
        self.windowMs = windowMs
    }

    public mutating func decide(rivalPid: Int32, now: Double) -> Decision {
        if gaveUp.contains(rivalPid) { return .ignore }
        let recent = (moves[rivalPid] ?? []).filter { now - $0 < windowMs }
        if recent.count >= maxMoves {
            gaveUp.insert(rivalPid)
            moves[rivalPid] = nil
            return .giveUp
        }
        moves[rivalPid] = recent + [now]
        return .move
    }

    /// When the rival process exits (in case the same PID is reused by another process)
    public mutating func forget(pid: Int32) {
        moves[pid] = nil
        gaveUp.remove(pid)
    }

    /// Drops records of rivals not in the list of running processes
    public mutating func retain(onlyPids alive: Set<Int32>) {
        for pid in Array(moves.keys) where !alive.contains(pid) { moves[pid] = nil }
        gaveUp = gaveUp.filter { alive.contains($0) }
    }

    public func hasGivenUp(on pid: Int32) -> Bool { gaveUp.contains(pid) }

    /// Rivals we hold records for
    public var trackedPids: Set<Int32> { Set(moves.keys).union(gaveUp) }
}
