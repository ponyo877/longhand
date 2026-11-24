import Darwin
import Foundation
import LonghandCore

/// Temporarily sets what the system does when the globe key (Fn) is pressed (AppleFnUsageType) to “Do Nothing” (0).
///
/// Looks up private APIs (TISGetFnUsageType / TISUpdateFnUsageType in HIToolbox) with dlsym. Does nothing if they are not found.
/// The original value is written to a receipt file (~/Library/Application Support/Longhand/globe-receipt.json) before changing it,
/// and restored on exit. After a crash, the next launch reads the receipt and restores it.
final class GlobeController: @unchecked Sendable {
    static let shared = GlobeController()

    private typealias GetFn = @convention(c) () -> Int32
    private typealias UpdateFn = @convention(c) (Int32) -> Int32

    private let lock = NSLock()
    private var getFn: GetFn?
    private var updateFn: UpdateFn?
    /// Receipt for a change this process made and has not restored yet
    private var held: GlobeReceipt?
    /// Whether suppression was requested and the value is actually “Do Nothing”
    private var suppressed = false

    static let doNothing: Int32 = 0

    let receiptURL: URL = {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support")
        return base.appendingPathComponent("Longhand/globe-receipt.json")
    }()

    private init() {
        let path = "/System/Library/Frameworks/Carbon.framework/Versions/A/Frameworks/HIToolbox.framework/Versions/A/HIToolbox"
        let handle = dlopen(path, RTLD_LAZY) ?? dlopen(nil, RTLD_LAZY)
        if let handle {
            if let sym = dlsym(handle, "TISGetFnUsageType") { getFn = unsafeBitCast(sym, to: GetFn.self) }
            if let sym = dlsym(handle, "TISUpdateFnUsageType") { updateFn = unsafeBitCast(sym, to: UpdateFn.self) }
        }
        if getFn == nil || updateFn == nil {
            Log.warn("TISGetFnUsageType/TISUpdateFnUsageType not found; globe suppression unavailable")
        }
    }

    var isAvailable: Bool { getFn != nil && updateFn != nil }

    private func currentValue() -> Int32? {
        if let getFn { return getFn() }
        // For reading only, the preferences file is enough
        let v = CFPreferencesCopyAppValue("AppleFnUsageType" as CFString, "com.apple.HIToolbox" as CFString)
        return (v as? NSNumber)?.int32Value
    }

    private func apply(_ value: Int32) -> Bool {
        guard let updateFn else { return false }
        let status = updateFn(value)
        let now = getFn?()
        Log.info("AppleFnUsageType set to \(value) (status \(status), now \(now.map(String.init) ?? "?"))")
        return now == value
    }

    /// At startup: restores from a receipt left by a previous process, if any
    func recoverStaleReceipt() {
        lock.lock(); defer { lock.unlock() }
        guard let receipt = readReceipt() else { return }
        let alive = Self.isLiveHelper(pid: receipt.pid)
        guard let current = currentValue() else { return }
        let action = GlobePolicy.recovery(receipt: receipt, currentValue: current, ownerAlive: alive)
        Log.info("found globe receipt from pid \(receipt.pid) (original \(receipt.originalValue), current \(current)): \(action)")
        switch action {
        case let .restore(v):
            _ = apply(v)
            removeReceipt()
        case .discard:
            removeReceipt()
        case .leave:
            break
        }
    }

    /// Turns suppression on or off. Returns whether the value ends up as “Do Nothing”
    @discardableResult
    func setSuppressed(_ on: Bool) -> Bool {
        lock.lock(); defer { lock.unlock() }
        if on {
            if held != nil { return suppressed }
            guard isAvailable, let current = currentValue() else {
                suppressed = false
                return false
            }
            if current == Self.doNothing {
                // Already “Do Nothing”. Nothing to restore either (including when another helper owns it)
                suppressed = true
                return true
            }
            if let other = readReceipt(), Self.isLiveHelper(pid: other.pid), other.pid != getpid() {
                // Another helper holds the change but the value is not 0, so the user changed it. Leave it alone
                Log.warn("another helper (pid \(other.pid)) owns the globe receipt; not touching AppleFnUsageType")
                suppressed = false
                return false
            }
            let receipt = GlobeReceipt(originalValue: current, appliedValue: Self.doNothing, pid: getpid(),
                                       createdAt: ISO8601DateFormatter().string(from: Date()))
            guard writeReceipt(receipt) else {
                suppressed = false
                return false
            }
            if apply(Self.doNothing) {
                held = receipt
                suppressed = true
            } else {
                // The change failed. Restore the original if possible and remove the receipt
                if currentValue() != current { _ = apply(current) }
                removeReceipt()
                suppressed = false
            }
            return suppressed
        } else {
            releaseLocked()
            suppressed = false
            return false
        }
    }

    /// Call on exit
    func restore() {
        lock.lock(); defer { lock.unlock() }
        releaseLocked()
    }

    private func releaseLocked() {
        guard let receipt = held else { return }
        held = nil
        let current = currentValue() ?? receipt.appliedValue
        switch GlobePolicy.release(receipt: receipt, currentValue: current) {
        case let .restore(v):
            _ = apply(v)
        case .discard:
            Log.info("AppleFnUsageType changed by the user (\(current)); not restoring")
        case .leave:
            break
        }
        removeReceipt()
    }

    // MARK: - Receipt

    private func readReceipt() -> GlobeReceipt? {
        guard let data = try? Data(contentsOf: receiptURL) else { return nil }
        return try? JSONDecoder().decode(GlobeReceipt.self, from: data)
    }

    private func writeReceipt(_ r: GlobeReceipt) -> Bool {
        do {
            try FileManager.default.createDirectory(at: receiptURL.deletingLastPathComponent(), withIntermediateDirectories: true)
            let data = try JSONEncoder().encode(r)
            try data.write(to: receiptURL, options: .atomic)
            return true
        } catch {
            Log.error("failed to write globe receipt: \(error)")
            return false
        }
    }

    private func removeReceipt() {
        try? FileManager.default.removeItem(at: receiptURL)
    }

    /// Whether the process with pid is alive and is LonghandHelper
    static func isLiveHelper(pid: Int32) -> Bool {
        guard pid > 0, kill(pid, 0) == 0 || errno == EPERM else { return false }
        var buf = [CChar](repeating: 0, count: 256)
        guard proc_name(pid, &buf, UInt32(buf.count)) > 0 else { return false }
        let name = String(decoding: buf.prefix { $0 != 0 }.map { UInt8(bitPattern: $0) }, as: UTF8.self)
        return name == "LonghandHelper"
    }
}
