import Foundation
import LonghandCore

// src/shared/protocol.ts の Swift 版。protocol.ts を変えたらここも合わせる。

let protocolVersion = 1
let helperVersion: String = {
    (Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String) ?? "0.0.0-dev"
}()

// MARK: - 受信

struct InEnvelopeHeader: Decodable {
    let type: String
    let id: String?
}

private struct PayloadBox<P: Decodable>: Decodable {
    let payload: P?
}

/// エンベロープから payload を取り出す。payload がなければ {} として解釈する
func decodePayload<P: Decodable>(_ type: P.Type, from data: Data) throws -> P {
    let box = try JSONDecoder().decode(PayloadBox<P>.self, from: data)
    if let p = box.payload { return p }
    return try JSONDecoder().decode(P.self, from: Data("{}".utf8))
}

struct ConfigurePayload: Decodable {
    var hotkeys: [String: [[String]]]?
    var suppressGlobe: Bool?
    /// Chromium 系ブラウザに AXEnhancedUserInterface を立ててよいか（省略時 true）
    var chromiumEnhancedUI: Bool?
}

struct StateSyncPayload: Decodable {
    var ptt: String
}

struct AudioStartPayload: Decodable {
    var sessionId: Int
    var deviceId: String?
}

struct AudioStopPayload: Decodable {
    var sessionId: Int
}

struct GetContextPayload: Decodable {
    var includeField: Bool?
    var includeHost: Bool?
    var maxContextChars: Int?
}

struct PastePayload: Decodable {
    var pasteId: String
    var text: String
    var expectSelectedText: String?
    var expectBundleId: String?
    var verifyLanding: Bool?
    var avoidClipboardHistory: Bool?
    var watchMs: Int?
}

struct PermissionsPayload: Decodable {
    var prompt: String?
}

struct RecordShortcutPayload: Decodable {
    var active: Bool
}

// MARK: - 送信

struct EmptyPayload: Codable, Sendable {}

struct ReadyPayload: Encodable, Sendable {
    let version: String
    let `protocol`: Int
    let pid: Int32
}

struct ConfiguredPayload: Encodable, Sendable {
    let ok: Bool
    let errors: [String]
    let globeSuppressed: Bool
}

struct HotkeyPayload: Encodable, Sendable {
    let action: String
    let phase: String
    let t: Double
}

struct AudioStartedPayload: Encodable, Sendable {
    let sessionId: Int
    let deviceId: String
    let deviceName: String
    let transport: String
}

struct AudioChunkPayload: Encodable, Sendable {
    let sessionId: Int
    let seq: Int
    let pcm: String
    let rms: Double
    let peak: Double
}

struct AudioStoppedPayload: Encodable, Sendable {
    let sessionId: Int
    let status: String
    let chunks: Int
}

struct AudioErrorPayload: Encodable, Sendable {
    let sessionId: Int?
    let code: String
    let message: String
    let fatal: Bool

    // sessionId が nil でも "sessionId": null を出す（protocol.ts は number | null）
    enum CodingKeys: String, CodingKey { case sessionId, code, message, fatal }
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(sessionId, forKey: .sessionId)
        try c.encode(code, forKey: .code)
        try c.encode(message, forKey: .message)
        try c.encode(fatal, forKey: .fatal)
    }
}

struct AudioDevicePayload: Encodable, Sendable, Equatable {
    let id: String
    let name: String
    let isDefault: Bool
    let transport: String
    let isVirtual: Bool
}

struct AudioDevicesPayload: Encodable, Sendable {
    let devices: [AudioDevicePayload]
}

struct AppInfoPayload: Encodable, Sendable, Equatable {
    let name: String
    let bundleId: String
    let pid: Int32
}

struct FieldInfoPayload: Encodable, Sendable {
    var role: String
    var subrole: String?
    var description: String?
    var isSecure: Bool
    var editable: Bool
    var beforeCursor: String?
    var afterCursor: String?
    var selectedText: String?
    var totalLength: Int?
}

struct ContextPayload: Encodable, Sendable {
    var app: AppInfoPayload
    var host: String?
    var windowTitle: String?
    var field: FieldInfoPayload?
    var canPaste: String
    var elapsedMs: Int
}

struct PasteAckPayload: Encodable, Sendable {
    let pasteId: String
    let success: Bool
    let failureReason: String?
    let landed: String
    let retried: Bool
    let elapsedMs: Int
    /// 最初の ⌘V を投入した時刻（Clock.nowMs() の基準。hotkey の t と同じ）。⌘V を送る前に失敗したら nil
    let keyPostedAt: Double?
    /// paste 要求を受け取ってから最初の ⌘V を投入するまで
    let keyPostedAfterMs: Double?
    /// 貼り付け前の AX の読み取りにかかった時間
    let preReadMs: Double?
}

struct FieldWatchResultPayload: Encodable, Sendable {
    let pasteId: String
    let before: String
    let afterPaste: String
    let final: String
    let reason: String
    let baseline: String
    let keystrokes: Int
    let firstKeystrokeMs: Double?
    let lastKeystrokeMs: Double?
    let insertOffset: Int?
    let insertReplacedLength: Int?
    let inserted: String
    let settled: Bool
    let durationMs: Int
    /// enter と sent のとき、送信で欄が空になる直前の読み取り（final と同じ値）
    let preSend: String?
}

struct PermissionsResultPayload: Encodable, Sendable {
    let accessibility: Bool
    let microphone: String
}

struct ShortcutKeysPayload: Encodable, Sendable {
    let keys: [String]
    let combo: [String]
    let done: Bool
}

struct FrontAppPayload: Encodable, Sendable {
    let name: String
    let bundleId: String
    let pid: Int32
    let isElectron: Bool
}

struct EventTapPayload: Encodable, Sendable {
    let status: String
    /// moved_to_front と rival_in_front のときの相手のプロセス
    var pid: Int32? = nil
    var name: String? = nil
}

struct HelperLogPayload: Encodable, Sendable {
    let level: String
    let message: String
}

struct ErrorPayload: Encodable, Sendable {
    let code: String
    let message: String
}
