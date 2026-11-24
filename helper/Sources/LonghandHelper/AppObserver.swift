import AppKit
import ApplicationServices
import Foundation

/// Watches for changes of the frontmost app and sends front_app. Sets AXManualAccessibility = true on Electron apps and
/// Chromium-based browsers so that they build their accessibility tree.
/// When a Chromium-based browser answers that it does not support AXManualAccessibility, sets AXEnhancedUserInterface instead (CTX-5).
/// AX may not respond right after launch, so it tries every 250ms, up to 40 times, until it succeeds or the focused element can be read.
/// AXEnhancedUserInterface can get in the way of window tiling tools, so configure's chromiumEnhancedUI can turn it off.
@MainActor
final class AppObserver {
    static let shared = AppObserver()

    private var observers: [NSObjectProtocol] = []
    private let axQueue = DispatchQueue(label: "longhand.ax.enabler", qos: .utility)
    nonisolated(unsafe) private var enabledPids: Set<pid_t> = [] // Only axQueue touches this
    private var electronCache: [String: Bool] = [:]

    /// configure's chromiumEnhancedUI (true by default)
    nonisolated static let enhancedUIAllowed = LockedValue(true)
    nonisolated static let enhancedUIRetryMs = 250
    nonisolated static let enhancedUIMaxAttempts = 40
    /// pid → whether it is Chromium-based or Electron (ContextGatherer looks it up off the main thread)
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
        // Also set it on apps already running at startup
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

    /// Returns true for Electron
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
                // Do not keep retrying apps where it failed (some Chromium versions, for example)
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

    /// Sets AXEnhancedUserInterface (call on axQueue)
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

    /// Whether it is a Chromium-based browser or an Electron app (callable from any thread)
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
