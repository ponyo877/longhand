import Foundation

// The receipt written when the Globe key setting (AppleFnUsageType) is changed, and the decision on restoring it.
// Values: 0 = Do Nothing, 1 = Change Input Source, 2 = Show Emoji & Symbols, 3 = Start Dictation

public struct GlobeReceipt: Codable, Equatable, Sendable {
    public var version: Int
    /// The value before the change
    public var originalValue: Int32
    /// The value written (always 0)
    public var appliedValue: Int32
    /// The process that made the change
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
    /// Restore the original value and delete the receipt
    case restore(Int32)
    /// Delete the receipt without restoring (the user changed the setting)
    case discard
    /// Owned by another live helper, so leave it alone
    case leave
}

public enum GlobePolicy {
    /// What to do with a receipt left over at launch
    public static func recovery(receipt: GlobeReceipt, currentValue: Int32, ownerAlive: Bool) -> GlobeRecoveryAction {
        if ownerAlive { return .leave }
        return release(receipt: receipt, currentValue: currentValue)
    }

    /// What to do when giving up a receipt this process owns
    public static func release(receipt: GlobeReceipt, currentValue: Int32) -> GlobeRecoveryAction {
        // If the user changed the setting in the meantime, respect that value
        if currentValue != receipt.appliedValue { return .discard }
        if receipt.originalValue == receipt.appliedValue { return .discard }
        return .restore(receipt.originalValue)
    }
}
