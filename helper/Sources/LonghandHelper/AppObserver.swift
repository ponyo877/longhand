import AppKit
import ApplicationServices
import Foundation

/// 前面アプリの変化を監視して front_app を送る。Electron 製アプリと Chromium 系ブラウザには
/// AXManualAccessibility = true を設定して、アクセシビリティツリーを作らせる。
/// Chromium 系ブラウザが AXManualAccessibility に対応しないと答えたときは、代わりに AXEnhancedUserInterface を立てる（CTX-5）。
/// 起動直後は AX が応答しないことがあるので、成功するかフォーカス中の要素が取れるまで 250ms おきに最大 40 回試す。
/// AXEnhancedUserInterface はウィンドウ整列ツールの動きを妨げることがあるので、configure の chromiumEnhancedUI で切れる。
@MainActor
final class AppObserver {
    static let shared = AppObserver()

    private var observers: [NSObjectProtocol] = []
    private let axQueue = DispatchQueue(label: "longhand.ax.enabler", qos: .utility)
    nonisolated(unsafe) private var enabledPids: Set<pid_t> = [] // axQueue だけが触る
    private var electronCache: [String: Bool] = [:]

    /// configure の chromiumEnhancedUI（既定 true）
    nonisolated static let enhancedUIAllowed = LockedValue(true)
    nonisolated static let enhancedUIRetryMs = 250
    nonisolated static let enhancedUIMaxAttempts = 40
    /// pid → Chromium 系か Electron か（ContextGatherer がメインスレッドの外から引く）
    nonisolated private static let chromiumLikeCache = LockedValue<[pid_t: Bool]>([:])

    nonisolated static let chromiumBundleIds: Set<String> = [
        "com.google.Chrome", "com.google.Chrome.beta", "com.google.Chrome.dev", "com.google.Chrome.canary",
        "org.chromium.Chromium", "com.microsoft.edgemac", "com.microsoft.edgemac.Beta", "com.microsoft.edgemac.Dev",
        "com.brave.Browser", "com.brave.Browser.beta", "company.thebrowser.Browser", "company.thebrowser.dia",
        "com.vivaldi.Vivaldi", "com.operasoftware.Opera",
    ]

    func start() {
        let center = NSWorkspace.shared.notificationCenter
        observers.append(center.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { note in
            guard let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else { return }
            MainActor.assumeIsolated { AppObserver.shared.activated(app) }
        })
        observers.append(center.addObserver(forName: NSWorkspace.didLaunchApplicationNotification, object: nil, queue: .main) { note in
            guard let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else { return }
            MainActor.assumeIsolated { _ = AppObserver.shared.prepareAccessibility(app) }
        })
        observers.append(center.addObserver(forName: NSWorkspace.didTerminateApplicationNotification, object: nil, queue: .main) { note in
            guard let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else { return }
            let pid = app.processIdentifier
            MainActor.assumeIsolated { AppObserver.shared.forget(pid) }
        })
        // 起動時点で動いているアプリにも設定する
        for app in NSWorkspace.shared.runningApplications where app.activationPolicy == .regular {
            prepareAccessibility(app)
        }
        if let front = NSWorkspace.shared.frontmostApplication { activated(front) }
    }

    private func activated(_ app: NSRunningApplication) {
        let isElectron = prepareAccessibility(app)
        let payload = FrontAppPayload(name: app.localizedName ?? "", bundleId: app.bundleIdentifier ?? "",
                                      pid: app.processIdentifier, isElectron: isElectron)
        Log.debug("front_app \(payload.bundleId) pid=\(payload.pid) electron=\(isElectron)")
        Output.shared.send("front_app", payload)
    }

    /// Electron なら true を返す
    @discardableResult
    private func prepareAccessibility(_ app: NSRunningApplication) -> Bool {
        let isElectron = isElectronApp(app)
        let isChromium = app.bundleIdentifier.map(Self.chromiumBundleIds.contains) ?? false
        guard isElectron || isChromium else { return false }
        let pid = app.processIdentifier
        let name = app.bundleIdentifier ?? app.localizedName ?? "\(pid)"
        axQueue.async { [self] in
            guard !enabledPids.contains(pid), AXIsProcessTrusted() else { return }
            let el = AX.app(pid)
            let err = AX.set(el, "AXManualAccessibility", kCFBooleanTrue)
            if err == .success {
                enabledPids.insert(pid)
                Log.debug("AXManualAccessibility enabled for \(name)")
            } else {
                Log.debug("AXManualAccessibility failed for \(name): \(err.rawValue)")
                // 失敗したアプリ（Chromium の一部の版など）は何度も試さない
                if err == .attributeUnsupported || err == .actionUnsupported {
                    enabledPids.insert(pid)
                    if isChromium && !isElectron && Self.enhancedUIAllowed.get() {
                        enableEnhancedUI(pid: pid, name: name, attempt: 1)
                    }
                }
            }
        }
        return isElectron
    }

    /// AXEnhancedUserInterface を立てる（axQueue の上で呼ぶ）
    nonisolated private func enableEnhancedUI(pid: pid_t, name: String, attempt: Int) {
        guard Self.enhancedUIAllowed.get(), NSRunningApplication(processIdentifier: pid) != nil else { return }
        let el = AX.app(pid)
        let err = AX.set(el, "AXEnhancedUserInterface", kCFBooleanTrue)
        if err == .success || AX.element(el, kAXFocusedUIElementAttribute) != nil {
            Log.info("AXEnhancedUserInterface enabled for \(name) (attempt \(attempt), result \(err.rawValue))")
            return
        }
        guard attempt < Self.enhancedUIMaxAttempts else {
            Log.info("AXEnhancedUserInterface could not be enabled for \(name): \(err.rawValue)")
            return
        }
        axQueue.asyncAfter(deadline: .now() + .milliseconds(Self.enhancedUIRetryMs)) { [self] in
            enableEnhancedUI(pid: pid, name: name, attempt: attempt + 1)
        }
    }

    private func forget(_ pid: pid_t) {
        axQueue.async { [self] in enabledPids.remove(pid) }
        Self.chromiumLikeCache.update { $0[pid] = nil }
    }

    /// Chromium 系ブラウザか Electron 製アプリか（どのスレッドからでも呼べる）
    nonisolated static func isChromiumLike(pid: pid_t) -> Bool {
        if let cached = chromiumLikeCache.get()[pid] { return cached }
        guard let app = NSRunningApplication(processIdentifier: pid) else { return false }
        var result = app.bundleIdentifier.map(chromiumBundleIds.contains) ?? false
        if !result, let url = app.bundleURL {
            result = FileManager.default.fileExists(atPath: url.appendingPathComponent("Contents/Frameworks/Electron Framework.framework").path)
        }
        chromiumLikeCache.update { $0[pid] = result }
        return result
    }

    private func isElectronApp(_ app: NSRunningApplication) -> Bool {
        guard let url = app.bundleURL else { return false }
        let key = url.path
        if let cached = electronCache[key] { return cached }
        let fw = url.appendingPathComponent("Contents/Frameworks/Electron Framework.framework").path
        let result = FileManager.default.fileExists(atPath: fw)
        electronCache[key] = result
        return result
    }
}
