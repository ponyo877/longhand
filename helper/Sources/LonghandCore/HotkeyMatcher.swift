// ホットキーの判定（状態機械）。OS のイベントから切り離した純粋なロジックで、XCTest で検証する。
//
// 規則:
// - Binding は「押されているキーがちょうどその Binding のキーだけ」になった瞬間に成立し、phase "down" を出す。
//   成立のきっかけは押下だけ。キーを離した結果として短い Binding がちょうど成立しても発火しない
//   （Fn+Space から Space だけ離しても activate は発火しない）。
// - 文字キーやマウスボタンを含む Binding は、修飾キー以外のキーの押下でだけ成立する
//   （Space を押したまま Fn を押しても Fn+Space は成立しない）。
// - 成立した Binding は、そのキーのどれかが離されるまで「保持中」とし、離された時点で "up" を出す。
// - 保持中にほかのキーが押されたとき:
//   - そのキーで、保持中の Binding を含むより長い Binding がちょうど成立したら（Fn → Fn+Space）、
//     長いほうの "down" だけを出す。短いほうは保持を続け、"up" も "interrupted" も出さない。
//     短いほうの "up" は、それ自身のキー（Fn）が離されたときに出す。
//     Fn → Space → Space を離す → Fn を離す、の順なら activate:down, lock:down, lock:up, activate:up になる。
//   - そうでなければ、activate に限り "interrupted" を 1 回だけ出す（Fn+Delete など）。保持は続ける。
// - 飲み込み: Binding を成立させた修飾キー以外のキー（Fn+Space の Space など）は、押下・リピート・解放をすべて飲み込む。
//   cancel の Binding は PTT がセッション中（inactive 以外）のときだけ飲み込む。修飾キーは決して飲み込まない。
// - recording（ショートカット記録中）は判定を止め、修飾キー以外のキーをすべて飲み込む。

public struct HotkeyEvent: Equatable, Sendable, CustomStringConvertible {
    public let action: HotkeyAction
    public let phase: HotkeyPhase

    public init(_ action: HotkeyAction, _ phase: HotkeyPhase) {
        self.action = action
        self.phase = phase
    }

    public var description: String { "\(action.rawValue):\(phase.rawValue)" }
}

public struct MatchOutput: Equatable, Sendable {
    public var events: [HotkeyEvent] = []
    /// このイベントを飲み込むか
    public var swallow: Bool = false

    public init(events: [HotkeyEvent] = [], swallow: Bool = false) {
        self.events = events
        self.swallow = swallow
    }
}

public struct HotkeyMatcher: Sendable {
    public private(set) var bindings: [Binding] = []
    /// いま押されている物理キー
    public private(set) var down: Set<String> = []
    /// 押下を飲み込んだキー（リピートと解放も飲み込む）
    public private(set) var swallowed: Set<String> = []
    /// 保持中の Binding（bindings の添字 → interrupted を出したか）
    private var held: [Int: Bool] = [:]
    /// 保持中の Binding が成立した順番。同時に離れたときは新しいものから "up" を出す（lock:up → activate:up）
    private var firedOrder: [Int: Int] = [:]
    private var orderCounter = 0

    public var pttState: PttState = .inactive
    public private(set) var recording = false

    public init(bindings: [Binding] = []) {
        self.bindings = bindings
    }

    /// 保持中の Binding
    public var heldBindings: [Binding] { held.keys.sorted().map { bindings[$0] } }

    /// 保持中の添字を、新しく成立したものから順に返す
    private var heldNewestFirst: [Int] {
        held.keys.sorted { (firedOrder[$0] ?? 0) > (firedOrder[$1] ?? 0) }
    }

    // MARK: - 設定

    /// Binding を差し替える。保持中のものには "up" を出す
    public mutating func setBindings(_ newBindings: [Binding]) -> MatchOutput {
        let out = releaseAllHeld()
        bindings = newBindings
        return out
    }

    /// 記録モードの切り替え。入るときは保持中の Binding に "up" を出す
    public mutating func setRecording(_ on: Bool) -> MatchOutput {
        guard on != recording else { return MatchOutput() }
        recording = on
        return on ? releaseAllHeld() : MatchOutput()
    }

    private mutating func releaseAllHeld() -> MatchOutput {
        var out = MatchOutput()
        for idx in heldNewestFirst {
            out.events.append(HotkeyEvent(bindings[idx].action, .up))
        }
        held.removeAll()
        firedOrder.removeAll()
        return out
    }

    // MARK: - 入力

    /// ⌃⌥⌘⇧ だけの activate を、まだ interrupted を出さずに保持しているか
    public var holdsPointerInterruptibleActivate: Bool {
        held.contains { idx, interrupted in
            !interrupted && bindings[idx].action == .activate && bindings[idx].isPlainModifierOnly
        }
    }

    /// 保持中の、⌃⌥⌘⇧ だけの activate に "interrupted" を 1 回出す。
    /// 押している間にクリックやスクロールがあったとき（⌘ を押したままのクリックなど。HK-1）。Fn を含むものには出さない
    public mutating func interruptOnPointer() -> MatchOutput {
        var out = MatchOutput()
        for idx in held.keys.sorted() where held[idx] == false {
            let b = bindings[idx]
            guard b.action == .activate, b.isPlainModifierOnly else { continue }
            held[idx] = true
            if out.events.isEmpty { out.events.append(HotkeyEvent(.activate, .interrupted)) }
        }
        return out
    }

    /// キーの押下。isRepeat はキーリピート（kCGKeyboardEventAutorepeat）
    public mutating func press(_ key: String, isRepeat: Bool = false) -> MatchOutput {
        if isRepeat {
            return MatchOutput(swallow: swallowed.contains(key))
        }
        var out = MatchOutput()
        if down.contains(key) {
            // 解放を取りこぼしていた。いったん離したことにしてから押下として扱う
            out = release(key)
        }
        down.insert(key)
        let isModifierKey = KeyTable.isModifier(key)

        if recording {
            if !isModifierKey {
                swallowed.insert(key)
                out.swallow = true
            }
            return out
        }

        // この押下でちょうど成立する Binding（保持中のものを除く）
        var fired: [Int] = []
        for (idx, b) in bindings.enumerated() where held[idx] == nil {
            if b.hasNonModifier && isModifierKey { continue }
            if b.isExactlySatisfied(by: down) { fired.append(idx) }
        }

        // 保持中の Binding への影響。押下で別の Binding が成立したなら（fired は down にちょうど一致するので、
        // 保持中の b を包含する長い Binding）何も出さない。b の "up" は b 自身のキーが離されたときに出す
        for idx in held.keys.sorted() {
            let b = bindings[idx]
            if b.isExactlySatisfied(by: down) { continue } // 左右両方の修飾キーなど
            if fired.isEmpty && b.action == .activate && held[idx] == false {
                held[idx] = true
                out.events.append(HotkeyEvent(.activate, .interrupted))
            }
        }

        for idx in fired {
            held[idx] = false
            orderCounter += 1
            firedOrder[idx] = orderCounter
            out.events.append(HotkeyEvent(bindings[idx].action, .down))
        }

        if !isModifierKey && fired.contains(where: { shouldSwallow(bindings[$0]) }) {
            swallowed.insert(key)
            out.swallow = true
        }
        return out
    }

    /// キーの解放
    public mutating func release(_ key: String) -> MatchOutput {
        var out = MatchOutput()
        out.swallow = swallowed.remove(key) != nil
        guard down.remove(key) != nil else { return out }
        for idx in heldNewestFirst where !bindings[idx].isHeld(by: down) {
            held[idx] = nil
            firedOrder[idx] = nil
            out.events.append(HotkeyEvent(bindings[idx].action, .up))
        }
        return out
    }

    /// 押されていると思っているが実際には離されていたキーを解放する（取りこぼし対策）
    public mutating func releaseStale(_ keys: [String]) -> MatchOutput {
        var out = MatchOutput()
        for key in keys {
            let r = release(key)
            out.events.append(contentsOf: r.events)
        }
        return out
    }

    private func shouldSwallow(_ b: Binding) -> Bool {
        switch b.action {
        case .cancel: return pttState != .inactive
        case .activate, .lock, .pasteLast: return true
        }
    }
}
