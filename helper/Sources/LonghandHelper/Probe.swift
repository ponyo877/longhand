import AppKit
import ApplicationServices
import Foundation

/// For development: `LonghandHelper --probe-context <bundleId|pid>` writes what get_context would return for the given app (it does
/// not have to be in front) as one line of JSON to stdout, then exits. Lets you check AX reads without moving the focus.
enum Probe {
    static func runIfRequested() {
        let args = CommandLine.arguments
        guard let i = args.firstIndex(of: "--probe-context"), i + 1 < args.count else { return }
        let target = args[i + 1]
        let app: NSRunningApplication?
        if let pid = pid_t(target) {
            app = NSRunningApplication(processIdentifier: pid)
        } else {
            app = NSRunningApplication.runningApplications(withBundleIdentifier: target).first
        }
        guard let app else {
            FileHandle.standardError.write(Data("app not found: \(target)\n".utf8))
            exit(1)
        }
        AX.configureGlobalTimeout()
        let pid = app.processIdentifier
        let isElectron = app.bundleURL.map {
            FileManager.default.fileExists(atPath: $0.appendingPathComponent("Contents/Frameworks/Electron Framework.framework").path)
        } ?? false
        if isElectron || AppObserver.chromiumBundleIds.contains(app.bundleIdentifier ?? "") {
            let err = AX.set(AX.app(pid), "AXManualAccessibility", kCFBooleanTrue)
            FileHandle.standardError.write(Data("AXManualAccessibility(\(app.bundleIdentifier ?? "?"), electron=\(isElectron)) -> \(err.rawValue)\n".utf8))
            usleep(300_000)
        }
        let ctx = ContextGatherer.gather(includeField: true, includeHost: true, maxContextChars: 200, targetPid: pid)
        let enc = JSONEncoder()
        enc.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        if let data = try? enc.encode(ctx) {
            FileHandle.standardOutput.write(data + Data([0x0A]))
        }
        exit(0)
    }
}
