// フローティングバーのウィンドウが、マウスの操作を受け取るか下のアプリに通すかを、実際のポインタとウィンドウサーバーの当たり判定で確かめる（開発用）。
//
//   swiftc -O helper/tools/pointer-check.swift -o /tmp/pointer-check
//   /tmp/pointer-check grid            ポインタを動かさずに、バーのウィンドウの中の格子点が、クリックを下のアプリに通すかを見る
//   /tmp/pointer-check hover           ポインタをバー（ウィンドウの下端の中央）に 1 秒ほど乗せ、乗せているあいだと離れた後の受け取り手を見る
//   /tmp/pointer-check hold <x> <y> <秒>  ポインタを画面の点に置いたまま動かさず、0.1 秒ごとの受け取り手を記録する。
//                                      LONGHAND_DEBUG_SELFTEST=mouse-hold npm start がログに書く通知の位置を渡すと、
//                                      通知が消えた後に、通す状態へ戻るまでの時間が分かる
//
// クリックもスクロールも送らない。ポインタは、終わったら元の位置に戻す。
// ポインタを動かすので、この道具を動かす端末のアプリに、アクセシビリティの許可が要る。
// 当たり判定は NSWindow.windowNumber(at:belowWindowWithWindowNumber:)（その点でマウスを押したときに受け取るウィンドウ）で、
// ignoresMouseEvents を反映する。ほかのアプリのウィンドウを調べるには、先に NSApplication を作っておく必要がある。
import AppKit
import CoreGraphics

_ = NSApplication.shared
let screenH = NSScreen.screens[0].frame.height

/** その点でクリックを受け取るウィンドウの番号（座標は、画面の左上が原点） */
func hitWindow(_ p: CGPoint) -> Int { NSWindow.windowNumber(at: NSPoint(x: p.x, y: screenH - p.y), belowWindowWithWindowNumber: 0) }
func ownerName(_ window: Int) -> String {
  let list = CGWindowListCopyWindowInfo([.optionIncludingWindow], CGWindowID(window)) as? [[String: Any]] ?? []
  return list.first?[kCGWindowOwnerName as String] as? String ?? "?"
}
func move(_ p: CGPoint) { CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left)?.post(tap: .cghidEventTap) }
func sleepMs(_ ms: Int) { usleep(useconds_t(ms * 1000)) }
/** 少しずつ近づけて、実際の動きに近づける */
func approach(_ p: CGPoint) {
  for i in 0..<10 { move(CGPoint(x: p.x - 50 + CGFloat(i) * 5, y: p.y - 30 + CGFloat(i) * 3)); sleepMs(15) }
  move(p)
}

/** フローティングバーのウィンドウ（開発版は Electron、パッケージ版は Longhand が持つ、いちばん手前の層の 400×260 のウィンドウ） */
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
  guard let f = floater() else { print("フローティングバーのウィンドウが見つかりません"); exit(1) }
  var taken = 0, total = 0
  for y in stride(from: f.frame.minY + 6, to: f.frame.maxY, by: 12) {
    for x in stride(from: f.frame.minX + 6, to: f.frame.maxX, by: 12) {
      total += 1
      if hitWindow(CGPoint(x: x, y: y)) == f.id { taken += 1 }
    }
  }
  print("ウィンドウ \(Int(f.frame.minX)),\(Int(f.frame.minY)) \(Int(f.frame.width))x\(Int(f.frame.height))：バーが受け取った点 \(taken)/\(total)（ポインタが外にあれば 0 のはず）")
case "hover":
  guard let f = floater() else { print("フローティングバーのウィンドウが見つかりません"); exit(1) }
  // 待機中のバーは、ウィンドウの下端から 8 px 上に、高さ 10 px で出ている
  let bar = CGPoint(x: f.frame.midX, y: f.frame.maxY - 13)
  let before = ownerName(hitWindow(bar))
  approach(bar)
  sleepMs(600)
  let on = hitWindow(bar) == f.id
  move(start)
  sleepMs(1200)
  let after = ownerName(hitWindow(bar))
  print("乗せる前の受け取り手: \(before)、乗せているあいだバーが受け取る: \(on)、離れた後の受け取り手: \(after)")
case "hold":
  guard args.count >= 5, let x = Double(args[2]), let y = Double(args[3]), let secs = Double(args[4]) else { print("使い方: pointer-check hold <x> <y> <秒>"); exit(2) }
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
  print("0.1 秒ごとの受け取り手（K: バーのウィンドウ、.: 下のアプリ）")
  print(seq)
  print(String(format: "最後にバーのウィンドウが受け取っていたのは %.1f 秒", last))
default:
  print("使い方: pointer-check grid | hover | hold <x> <y> <秒>")
  exit(2)
}
