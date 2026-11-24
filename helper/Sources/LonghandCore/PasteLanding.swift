// Decides whether a paste landed (PST-3, PST-4). Pure logic kept apart from the OS, verified with XCTest.
//
// There are two clues.
// - Whether the target read the clipboard (seen through the data request for lazily provided data)
// - Whether the field read through AX changed since before the paste
// In Electron and similar apps the AX value can update late, so the field may show no change even when the paste worked.
// So "read but no visible change" is not treated as a failure but as read, and unconfirmed is used
// only when "not read, and no change even after sending ⌘V again".

public enum PasteLanding: String, Sendable {
    /// The field change was confirmed through AX
    case confirmed
    /// No visible change in the field, but the clipboard was read (the paste most likely worked)
    case read
    /// Not read, and the field did not change even after resending
    case unconfirmed
    /// A field AX cannot read, or not checked
    case unknown

    /// Decides the result of a checked paste
    /// - changed: whether the field change was confirmed (including the check after resending)
    /// - read: whether the clipboard was read at any point before or after resending
    public static func classify(changed: Bool, read: Bool) -> PasteLanding {
        if changed { return .confirmed }
        return read ? .read : .unconfirmed
    }

    /// Whether to send ⌘V again. Only when it was not read and the field did not change (if it was read, it might paste twice)
    public static func shouldResend(changed: Bool, read: Bool) -> Bool {
        !changed && !read
    }
}
