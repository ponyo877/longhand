import AppKit

// LonghandHelper: runs as a child process of the Electron main process and talks JSON Lines over stdin / stdout.
// The main thread runs the NSApplication (.accessory) run loop, and stdin is read on a separate thread.

Probe.runIfRequested()

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
Controller.shared.start()
app.run()
