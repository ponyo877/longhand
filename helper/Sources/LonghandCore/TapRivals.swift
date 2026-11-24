// event tap の「先頭の取り合い」の判定（HK-4）。OS から切り離した純粋なロジックで、XCTest で検証する。
//
// HID 層の tap は、先に並んでいるものからイベントを受け取る。前に能動型（listen-only でない）の tap があると、
// その tap がキーを飲み込んだり書き換えたりした後のイベントしか届かない。
// CGGetEventTapList の並び順を処理の順序とみなし、自分の tap より前に競合があれば作り直して先頭に戻る。
// 相手も先頭を取り返しに来る場合に備えて、同じ相手への張り直しには回数の上限を付ける。

/// CGEventTapInformation から必要な項目だけを写したもの
public struct TapEntry: Equatable, Sendable {
    /// kCGHIDEventTap = 0、kCGSessionEventTap = 1、kCGAnnotatedSessionEventTap = 2
    public var tapPoint: UInt32
    /// kCGEventTapOptionDefault = 0（能動型）、kCGEventTapOptionListenOnly = 1
    public var options: UInt32
    public var enabled: Bool
    public var eventsOfInterest: UInt64
    /// tap を作ったプロセス
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
    /// 自分の HID 層の tap より前に並んでいる競合を返す。
    /// - 競合: HID 層、有効、能動型、見るイベントが自分のマスクと重なる、自分以外のプロセス
    /// - 自分の tap に先に行き当たったら nil（先頭にいる）
    /// - 自分の tap が一覧に見つからなければ nil（判断できないので何もしない）
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

/// 同じ相手への張り直しを、windowMs の間に maxMoves 回までに抑える
public struct RivalBackoff: Sendable {
    public enum Decision: Equatable, Sendable {
        /// 張り直してよい
        case move
        /// 上限を超えた。初めて超えたときだけ返す（main に知らせる合図）
        case giveUp
        /// すでに諦めた相手。何もしない
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

    /// 相手のプロセスが終わったとき（同じ PID が別のプロセスに使い回されることに備える）
    public mutating func forget(pid: Int32) {
        moves[pid] = nil
        gaveUp.remove(pid)
    }

    /// 今いるプロセスの一覧に含まれない相手の記録を消す
    public mutating func retain(onlyPids alive: Set<Int32>) {
        for pid in Array(moves.keys) where !alive.contains(pid) { moves[pid] = nil }
        gaveUp = gaveUp.filter { alive.contains($0) }
    }

    public func hasGivenUp(on pid: Int32) -> Bool { gaveUp.contains(pid) }

    /// 記録を持っている相手
    public var trackedPids: Set<Int32> { Set(moves.keys).union(gaveUp) }
}
