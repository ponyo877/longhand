import Foundation

// 地球儀キー（AppleFnUsageType）を書き換えたときのレシートと、復元の判断。
// 値: 0 = 何もしない、1 = 入力ソースを変更、2 = 絵文字と記号を表示、3 = 音声入力を開始

public struct GlobeReceipt: Codable, Equatable, Sendable {
    public var version: Int
    /// 書き換える前の値
    public var originalValue: Int32
    /// 書き込んだ値（常に 0）
    public var appliedValue: Int32
    /// 書き換えたプロセス
    public var pid: Int32
    public var createdAt: String

    public init(originalValue: Int32, appliedValue: Int32 = 0, pid: Int32, createdAt: String) {
        self.version = 1
        self.originalValue = originalValue
        self.appliedValue = appliedValue
        self.pid = pid
        self.createdAt = createdAt
    }
}

public enum GlobeRecoveryAction: Equatable, Sendable {
    /// 元の値に戻してレシートを消す
    case restore(Int32)
    /// 戻さずにレシートを消す（ユーザーが設定を変えた）
    case discard
    /// 別の生きているヘルパーが持っているので触らない
    case leave
}

public enum GlobePolicy {
    /// 起動時に残っていたレシートの扱い
    public static func recovery(receipt: GlobeReceipt, currentValue: Int32, ownerAlive: Bool) -> GlobeRecoveryAction {
        if ownerAlive { return .leave }
        return release(receipt: receipt, currentValue: currentValue)
    }

    /// 自分が持っているレシートを手放すときの扱い
    public static func release(receipt: GlobeReceipt, currentValue: Int32) -> GlobeRecoveryAction {
        // 途中でユーザーが設定を変えていたら、その値を尊重する
        if currentValue != receipt.appliedValue { return .discard }
        if receipt.originalValue == receipt.appliedValue { return .discard }
        return .restore(receipt.originalValue)
    }
}
