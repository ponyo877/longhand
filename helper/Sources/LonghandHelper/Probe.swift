import AppKit
import ApplicationServices
import Foundation

/// 開発用: `LonghandHelper --probe-context <bundleId|pid>` で、指定したアプリ（前面でなくてよい）の
/// get_context 相当の結果を 1 行の JSON で標準出力に出して終了する。フォーカスを動かさずに AX の読み取りを確かめられる。
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
