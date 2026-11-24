import AppKit

// LonghandHelper: Electron main の子プロセスとして動き、stdin / stdout の JSON Lines で通信する。
// メインスレッドで NSApplication（.accessory）の run loop を回し、stdin は別スレッドで読む。

Probe.runIfRequested()

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
Controller.shared.start()
app.run()
