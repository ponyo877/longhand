// Checks, with the real pointer and the window server's hit testing, whether the floating bar's window takes mouse input or passes it to the app below (for development).
//
//   swiftc -O helper/tools/pointer-check.swift -o /tmp/pointer-check
//   /tmp/pointer-check grid            without moving the pointer, check whether grid points inside the bar's window pass clicks to the app below
//   /tmp/pointer-check hover           rest the pointer on the bar (bottom center of the window) for about a second and show who receives input while on it and after leaving
//   /tmp/pointer-check hold <x> <y> <seconds>  keep the pointer still on a point of the screen and record the receiver every 0.1 s.
//                                             Given the position of the notification that LONGHAND_DEBUG_SELFTEST=mouse-hold npm start writes to the log,
//                                             this shows how long it takes to go back to passing input through after the notification disappears
//
// Sends no clicks and no scrolls. The pointer is moved back to where it was when done.
// Because it moves the pointer, the terminal app running this tool needs the Accessibility permission.
// Hit testing uses NSWindow.windowNumber(at:belowWindowWithWindowNumber:) (the window that would receive a mouse press at that point),
// which reflects ignoresMouseEvents. NSApplication must be created first to inspect other apps' windows.
import AppKit
import CoreGraphics

_ = NSApplication.shared
let screenH = NSScreen.screens[0].frame.height

/** Number of the window that receives a click at that point (coordinates have their origin at the top left of the screen) */
func hitWindow(_ p: CGPoint) -> Int { NSWindow.windowNumber(at: NSPoint(x: p.x, y: screenH - p.y), belowWindowWithWindowNumber: 0) }
func ownerName(_ window: Int) -> String {
  let list = CGWindowListCopyWindowInfo([.optionIncludingWindow], CGWindowID(window)) as? [[String: Any]] ?? []
  return list.first?[kCGWindowOwnerName as String] as? String ?? "?"
}
func move(_ p: CGPoint) { CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left)?.post(tap: .cghidEventTap) }
func sleepMs(_ ms: Int) { usleep(useconds_t(ms * 1000)) }
/** Approaches in small steps, to resemble a real movement */
func approach(_ p: CGPoint) {
  for i in 0..<10 { move(CGPoint(x: p.x - 50 + CGFloat(i) * 5, y: p.y - 30 + CGFloat(i) * 3)); sleepMs(15) }
  move(p)
}

/** The floating bar's window (the 400×260 window in the frontmost layer, owned by Electron in development and by Longhand when packaged) */
func floater() -> (id: Int, frame: CGRect)? {
  let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] ?? []
  for w in list {
    let owner = w[kCGWindowOwnerName as String] as? String ?? ""
    guard owner == "Electron" || owner == "Longhand", (w[kCGWindowLayer as String] as? Int ?? 0) >= 1000, let b = w[kCGWindowBounds as String] as? [String: CGFloat] else { continue }
    return (w[kCGWindowNumber as String] as? Int ?? 0, CGRect(x: b["X"] ?? 0, y: b["Y"] ?? 0, width: b["Width"] ?? 0, height: b["Height"] ?? 0))
  }
  return nil
}

let args = CommandLine.arguments
let mode = args.count > 1 ? args[1] : ""
let start = CGEvent(source: nil)?.location ?? .zero

switch mode {
case "grid":
  guard let f = floater() else { print("Floating bar window not found"); exit(1) }
  var taken = 0, total = 0
  for y in stride(from: f.frame.minY + 6, to: f.frame.maxY, by: 12) {
    for x in stride(from: f.frame.minX + 6, to: f.frame.maxX, by: 12) {
      total += 1
      if hitWindow(CGPoint(x: x, y: y)) == f.id { taken += 1 }
    }
  }
  print("Window \(Int(f.frame.minX)),\(Int(f.frame.minY)) \(Int(f.frame.width))x\(Int(f.frame.height)): points taken by the bar \(taken)/\(total) (should be 0 if the pointer is outside)")
case "hover":
  guard let f = floater() else { print("Floating bar window not found"); exit(1) }
  // The idle bar sits 8 px above the bottom edge of the window and is 10 px tall
  let bar = CGPoint(x: f.frame.midX, y: f.frame.maxY - 13)
  let before = ownerName(hitWindow(bar))
  approach(bar)
  sleepMs(600)
  let on = hitWindow(bar) == f.id
  move(start)
  sleepMs(1200)
  let after = ownerName(hitWindow(bar))
  print("Receiver before hovering: \(before), bar receives while hovering: \(on), receiver after leaving: \(after)")
case "hold":
  guard args.count >= 5, let x = Double(args[2]), let y = Double(args[3]), let secs = Double(args[4]) else { print("usage: pointer-check hold <x> <y> <seconds>"); exit(2) }
  let p = CGPoint(x: x, y: y)
  let id = floater()?.id ?? -1
  approach(p)
  var seq = ""
  var last = -1.0
  let t0 = Date()
  while Date().timeIntervalSince(t0) < secs {
    sleepMs(100)
    let mine = hitWindow(p) == id
    seq += mine ? "K" : "."
    if mine { last = Date().timeIntervalSince(t0) }
  }
  move(start)
  print("Receiver every 0.1 s (K: the bar's window, .: the app below)")
  print(seq)
  print(String(format: "The bar's window last received input at %.1f s", last))
default:
  print("usage: pointer-check grid | hover | hold <x> <y> <seconds>")
  exit(2)
}
