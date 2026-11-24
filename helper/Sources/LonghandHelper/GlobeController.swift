import Darwin
import Foundation
import LonghandCore

/// 地球儀キー（Fn）を押したときのシステム動作（AppleFnUsageType）を、一時的に「何もしない」（0）にする。
///
/// 非公開 API（HIToolbox の TISGetFnUsageType / TISUpdateFnUsageType）を dlsym で引く。見つからなければ何もしない。
/// 元の値はレシートファイル（~/Library/Application Support/Longhand/globe-receipt.json）に書いてから書き換え、
/// 終了時に戻す。クラッシュしたときは、次回起動時にレシートを見て戻す。
final class GlobeController: @unchecked Sendable {
    static let shared = GlobeController()

    private typealias GetFn = @convention(c) () -> Int32
    private typealias UpdateFn = @convention(c) (Int32) -> Int32

    private let lock = NSLock()
    private var getFn: GetFn?
    private var updateFn: UpdateFn?
    /// 自分が書き換えて、まだ戻していないときのレシート
    private var held: GlobeReceipt?
    /// suppress を求められていて、実際に「何もしない」になっているか
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
        // 読むだけなら設定ファイルでも分かる
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

    /// 起動時: 前回のプロセスが残したレシートがあれば戻す
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

    /// suppress の切り替え。結果として「何もしない」になっているかを返す
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
                // 元から「何もしない」。戻す必要もない（別のヘルパーが持っている場合も含む）
                suppressed = true
                return true
            }
            if let other = readReceipt(), Self.isLiveHelper(pid: other.pid), other.pid != getpid() {
                // 別のヘルパーが書き換え中なのに値が 0 でない＝ユーザーが変えた。触らない
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
                // 書き換えに失敗した。可能なら元に戻してレシートを消す
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

    /// 終了時に呼ぶ
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

    // MARK: - レシート

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

    /// pid のプロセスが生きていて、LonghandHelper であるか
    static func isLiveHelper(pid: Int32) -> Bool {
        guard pid > 0, kill(pid, 0) == 0 || errno == EPERM else { return false }
        var buf = [CChar](repeating: 0, count: 256)
        guard proc_name(pid, &buf, UInt32(buf.count)) > 0 else { return false }
        let name = String(decoding: buf.prefix { $0 != 0 }.map { UInt8(bitPattern: $0) }, as: UTF8.self)
        return name == "LonghandHelper"
    }
}
