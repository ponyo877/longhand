// SpeechAnalyzer + SpeechTranscriber / DictationTranscriber による書き起こし。
//
// - モデルは OS が管理する（AssetInventory）。未導入なら load で Apple のサーバーから取得する。
// - SpeechAnalyzer は 1 回の解析ごとに作り直す（finish したアナライザは再利用できない）。
//   modelRetention = .processLifetime にして、モデル自体はプロセスが生きている間メモリに残す。

import AVFoundation
import CoreMedia
import Foundation
import Speech

enum TranscriberKind: String {
    case speech
    case dictation
}

struct EngineConfig {
    var kind: TranscriberKind = .speech
    /// DictationTranscriber の句読点（SpeechTranscriber は常に句読点を付けるので無関係）
    var punctuation: Bool = true
    /// DictationTranscriber の contentHints（"shortForm" | "farField" | "atypicalSpeech"）
    var contentHints: [String] = []
    /// これより短い音声は推論せずに空文字を返す
    var minDurationMs: Double = 200
    /// ピークがこれより小さい音声（ほぼ無音）は推論せずに空文字を返す
    var silencePeakDbfs: Double = -50
    /// 末尾に足す無音（ミリ秒）。語尾の取りこぼし対策
    var padMs: Double = 0
    /// 未導入のアセットを load で取得するか
    var installAssets: Bool = true
    /// load の最後に短い推論を 1 回して、初回の遅れをなくすか
    var warmup: Bool = true
    /// 解析ごとに prepareToAnalyze を呼ぶか（呼ばなくても start 時に準備される）
    var prepareEachRequest: Bool = false
    /// 日本語と英字の間などに入る空白を取り除く（英単語どうしの空白は残す）
    var normalizeSpacing: Bool = true
    /// アナライザに渡す 1 バッファの長さ（秒）。0 なら全体を 1 バッファで渡す（長い音声で先頭が欠けるので非推奨）
    var inputChunkSec: Double = 1.0

    static func from(_ options: [String: Any]?) throws -> EngineConfig {
        var c = EngineConfig()
        guard let o = options else { return c }
        if let t = o.string("transcriber") {
            guard let k = TranscriberKind(rawValue: t) else {
                throw AsrError(code: .badRequest, message: "options.transcriber must be \"speech\" or \"dictation\"")
            }
            c.kind = k
        }
        if let v = o.bool("punctuation") { c.punctuation = v }
        if let v = o.stringArray("contentHints") { c.contentHints = v }
        if let v = o.double("minDurationMs") { c.minDurationMs = v }
        if let v = o.double("silencePeakDbfs") { c.silencePeakDbfs = v }
        if let v = o.double("padMs") { c.padMs = max(0, v) }
        if let v = o.bool("installAssets") { c.installAssets = v }
        if let v = o.bool("warmup") { c.warmup = v }
        if let v = o.bool("prepareEachRequest") { c.prepareEachRequest = v }
        if let v = o.bool("normalizeSpacing") { c.normalizeSpacing = v }
        if let v = o.double("inputChunkSec") { c.inputChunkSec = max(0, v) }
        return c
    }
}

struct Segment {
    var start: Double
    var end: Double
    var text: String
}

/// SpeechTranscriber.Result と DictationTranscriber.Result を同じに扱うための共通部分。
protocol TranscriptResult: SpeechModuleResult {
    var text: AttributedString { get }
}

extension SpeechTranscriber.Result: TranscriptResult {}
extension DictationTranscriber.Result: TranscriptResult {}

/// モジュールの結果を最後まで読み、確定した結果だけを区間として返す。
func collectFinalResults<M: SpeechModule>(_ module: M) async throws -> [Segment] where M.Result: TranscriptResult {
    var segments: [Segment] = []
    let debug = ProcessInfo.processInfo.environment["LONGHAND_APPLE_DEBUG"] == "1"
    for try await result in module.results {
        if debug {
            log(String(format: "result final=%d range=%.2f-%.2f fin=%.2f text=%@", result.isFinal ? 1 : 0,
                       result.range.start.seconds, result.range.end.seconds, result.resultsFinalizationTime.seconds,
                       String(String(result.text.characters).prefix(30))))
        }
        guard result.isFinal else { continue }
        let text = String(result.text.characters)
        let range = result.range
        let start = range.start.isNumeric ? range.start.seconds : 0
        let end = range.end.isNumeric ? range.end.seconds : start
        segments.append(Segment(start: start, end: end, text: text))
    }
    return segments
}

func localeFor(language: String) throws -> Locale {
    switch language {
    case "ja", "auto", "": return Locale(identifier: "ja_JP")
    case "en": return Locale(identifier: "en_US")
    default:
        // "ja-JP" や "en_GB" のような指定もそのまま受け付ける
        return Locale(identifier: language)
    }
}

final class AppleSpeechEngine {
    private(set) var config = EngineConfig()
    private(set) var defaultLocale: Locale?
    /// 準備済み（アセット導入済み）のロケールと、そのアナライザ入力形式
    private var preparedFormats: [String: AVAudioFormat] = [:]

    var isLoaded: Bool { defaultLocale != nil }

    // MARK: - モジュールの生成

    private func makeSpeechTranscriber(_ locale: Locale) -> SpeechTranscriber {
        SpeechTranscriber(
            locale: locale,
            transcriptionOptions: [],
            reportingOptions: [],
            attributeOptions: [.audioTimeRange]
        )
    }

    private func makeDictationTranscriber(_ locale: Locale) -> DictationTranscriber {
        var hints: Set<DictationTranscriber.ContentHint> = []
        for h in config.contentHints {
            switch h {
            case "shortForm": hints.insert(.shortForm)
            case "farField": hints.insert(.farField)
            case "atypicalSpeech": hints.insert(.atypicalSpeech)
            default: log("unknown content hint ignored: \(h)")
            }
        }
        return DictationTranscriber(
            locale: locale,
            contentHints: hints,
            transcriptionOptions: config.punctuation ? [.punctuation] : [],
            reportingOptions: [],
            attributeOptions: [.audioTimeRange]
        )
    }

    private func makeModule(_ locale: Locale) -> any SpeechModule {
        switch config.kind {
        case .speech: return makeSpeechTranscriber(locale)
        case .dictation: return makeDictationTranscriber(locale)
        }
    }

    // MARK: - 読み込み

    /// ロケールの対応を確かめ、必要ならアセットを導入し、入力形式を決める。
    private func prepare(locale requested: Locale) async throws -> (Locale, AVAudioFormat) {
        let supported: Locale?
        switch config.kind {
        case .speech:
            guard SpeechTranscriber.isAvailable else {
                throw AsrError(code: .modelNotFound, message: "SpeechTranscriber is not available on this device")
            }
            supported = await SpeechTranscriber.supportedLocale(equivalentTo: requested)
        case .dictation:
            supported = await DictationTranscriber.supportedLocale(equivalentTo: requested)
        }
        guard let locale = supported else {
            throw AsrError(code: .modelNotFound, message: "locale \(requested.identifier) is not supported by \(config.kind.rawValue) transcriber")
        }
        let key = "\(config.kind.rawValue):\(locale.identifier)"
        if let format = preparedFormats[key] { return (locale, format) }

        let module = makeModule(locale)
        let status = await AssetInventory.status(forModules: [module])
        log("asset status for \(key): \(status)")
        if status == .unsupported {
            throw AsrError(code: .modelNotFound, message: "speech assets for \(locale.identifier) are unsupported on this device")
        }
        // 導入済みでも request が返ることがある（その場合 downloadAndInstall はすぐ終わる）
        if let request = try await AssetInventory.assetInstallationRequest(supporting: [module]) {
            guard config.installAssets || status == .installed else {
                throw AsrError(code: .modelNotFound, message: "speech assets for \(locale.identifier) are not installed (installAssets=false)")
            }
            if status != .installed {
                log("downloading speech assets for \(locale.identifier) from Apple (AssetInventory)...")
            }
            let t0 = Date()
            do {
                try await request.downloadAndInstall()
            } catch {
                throw AsrError(code: .modelNotFound, message: "failed to install speech assets for \(locale.identifier): \(error.localizedDescription)")
            }
            log(String(format: "asset installation request finished in %.1f s", Date().timeIntervalSince(t0)))
        }
        // 予約しておくと、OS が容量確保のためにアセットを消しにくくなる
        do {
            let reserved = try await AssetInventory.reserve(locale: locale)
            log("reserve(\(locale.identifier)) -> \(reserved)")
        } catch {
            log("reserve(\(locale.identifier)) failed: \(error.localizedDescription)")
        }
        guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [module]) else {
            throw AsrError(code: .modelNotFound, message: "no compatible audio format for \(locale.identifier)")
        }
        log("analyzer format for \(key): \(format)")
        preparedFormats[key] = format
        return (locale, format)
    }

    func load(language: String, options: [String: Any]?) async throws -> String {
        config = try EngineConfig.from(options)
        preparedFormats.removeAll()
        defaultLocale = nil
        let (locale, _) = try await prepare(locale: try localeFor(language: language))
        defaultLocale = locale
        if config.warmup {
            // 小さなノイズで 1 回解析し、モデルを常駐させる
            let t0 = Date()
            var noise = [Float](repeating: 0, count: Int(SAMPLE_RATE * 0.5))
            for i in noise.indices { noise[i] = Float.random(in: -0.001...0.001) }
            _ = try await analyze(samples: noise, locale: locale, hints: [])
            log(String(format: "warmup done in %.0f ms", Date().timeIntervalSince(t0) * 1000))
        }
        let name = config.kind == .speech ? "SpeechTranscriber" : "DictationTranscriber"
        return "\(name) \(locale.identifier) (Apple on-device)"
    }

    // MARK: - 書き起こし

    struct Output {
        var text: String
        var language: String
        var segments: [Segment]
    }

    func transcribe(samples input: [Float], language: String?, hints: [String]) async throws -> Output {
        guard let defaultLocale else {
            throw AsrError(code: .notLoaded, message: "model is not loaded; send load first")
        }
        var locale = defaultLocale
        if let language, !language.isEmpty, language != "auto" {
            let requested = try localeFor(language: language)
            if requested.language.languageCode != defaultLocale.language.languageCode {
                locale = try await prepare(locale: requested).0
            }
        }
        let langCode = locale.language.languageCode?.identifier ?? "ja"

        let stats = audioStats(input)
        if stats.durationSec * 1000 < config.minDurationMs {
            log(String(format: "audio too short (%.0f ms); returning empty text", stats.durationSec * 1000))
            return Output(text: "", language: langCode, segments: [])
        }
        if stats.peakDbfs < config.silencePeakDbfs {
            log(String(format: "audio is silent (peak %.1f dBFS); returning empty text", stats.peakDbfs))
            return Output(text: "", language: langCode, segments: [])
        }

        var samples = input
        if config.padMs > 0 {
            samples.append(contentsOf: [Float](repeating: 0, count: Int(SAMPLE_RATE * config.padMs / 1000)))
        }
        let cleanedHints = Array(
            hints.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                .filter { !$0.isEmpty }
                .prefix(200)
        )
        let segments = try await analyze(samples: samples, locale: locale, hints: cleanedHints)
            .map { seg -> Segment in
                var text = seg.text.trimmingCharacters(in: .whitespacesAndNewlines)
                if config.normalizeSpacing { text = removeSpacesAroundJapanese(text) }
                return Segment(start: seg.start, end: min(seg.end, stats.durationSec), text: text)
            }
            // 雑音だけの音声で「。」だけが返ることがあるので、文字を含まない区間は捨てる
            .filter { hasLexicalContent($0.text) }
        return Output(text: joinSegments(segments.map(\.text)), language: langCode, segments: segments)
    }

    /// 新しい SpeechAnalyzer を作り、音声 1 本を流して確定結果を集める。
    private func analyze(samples: [Float], locale: Locale, hints: [String]) async throws -> [Segment] {
        let key = "\(config.kind.rawValue):\(locale.identifier)"
        guard let format = preparedFormats[key] else {
            throw AsrError(code: .notLoaded, message: "locale \(locale.identifier) is not prepared")
        }
        let buffer = try convert(makeFloatBuffer(samples), to: format)
        switch config.kind {
        case .speech:
            let module = makeSpeechTranscriber(locale)
            return try await run(module: module, buffer: buffer, format: format, hints: hints)
        case .dictation:
            let module = makeDictationTranscriber(locale)
            return try await run(module: module, buffer: buffer, format: format, hints: hints)
        }
    }

    private func run<M: SpeechModule>(module: M, buffer: AVAudioPCMBuffer, format: AVAudioFormat, hints: [String]) async throws -> [Segment] where M.Result: TranscriptResult {
        let analyzer = SpeechAnalyzer(
            modules: [module],
            options: SpeechAnalyzer.Options(priority: .userInitiated, modelRetention: .processLifetime)
        )
        if !hints.isEmpty {
            // 語彙ヒント。DictationTranscriber では効くが、SpeechTranscriber（macOS 26）では効果が見られなかった
            let context = AnalysisContext()
            context.contextualStrings[.general] = hints
            try await analyzer.setContext(context)
        }
        if config.prepareEachRequest {
            try await analyzer.prepareToAnalyze(in: format)
        }
        let (stream, continuation) = AsyncStream.makeStream(of: AnalyzerInput.self)
        let collector = Task { try await collectFinalResults(module) }
        do {
            try await analyzer.start(inputSequence: stream)
            // 録音全体を 1 つの AnalyzerInput で渡すと、長い音声（173 秒で確認）で先頭の結果が丸ごと出てこない。
            // マイク入力と同じように、開始時刻付きの短いバッファに分けて流す。
            if config.inputChunkSec > 0 {
                for (piece, start) in splitBuffer(buffer, seconds: config.inputChunkSec) {
                    continuation.yield(AnalyzerInput(buffer: piece, bufferStartTime: start))
                }
            } else {
                continuation.yield(AnalyzerInput(buffer: buffer))
            }
            continuation.finish()
            try await analyzer.finalizeAndFinishThroughEndOfInput()
        } catch {
            collector.cancel()
            await analyzer.cancelAndFinishNow()
            throw AsrError(code: .inferenceFailed, message: "speech analysis failed: \(error.localizedDescription)")
        }
        do {
            return try await collector.value
        } catch {
            throw AsrError(code: .inferenceFailed, message: "reading results failed: \(error.localizedDescription)")
        }
    }
}

/// 区間の文字列をつなぐ。日本語は詰め、英数字どうしが接するときだけ空白を入れる。
func joinSegments(_ parts: [String]) -> String {
    var out = ""
    for part in parts where !part.isEmpty {
        if let last = out.unicodeScalars.last, let first = part.unicodeScalars.first,
           isAsciiAlnum(last), isAsciiAlnum(first) {
            out += " "
        }
        out += part
    }
    return out
}

private func isAsciiAlnum(_ s: Unicode.Scalar) -> Bool {
    s.isASCII && (CharacterSet.alphanumerics.contains(s))
}

/// 日本語の文字や全角の記号に接する空白を取り除く。英字どうしの間の空白は残す。
/// SpeechTranscriber は「この PCに入っている Google Chromeっていう」のように英字の前後に空白を入れるため。
func removeSpacesAroundJapanese(_ text: String) -> String {
    let scalars = Array(text.unicodeScalars)
    var out = String.UnicodeScalarView()
    for (i, s) in scalars.enumerated() {
        if s.properties.isWhitespace {
            let prev = out.last
            let next = scalars[(i + 1)...].first { !$0.properties.isWhitespace }
            let touchesJapanese = (prev.map { !$0.isASCII } ?? true) || (next.map { !$0.isASCII } ?? true)
            if touchesJapanese { continue }
            if let p = prev, p.properties.isWhitespace { continue }
        }
        out.append(s)
    }
    return String(out)
}

/// 文字（かな、漢字、英字、数字）を 1 つでも含むか。句読点や記号だけの結果を捨てるのに使う。
func hasLexicalContent(_ text: String) -> Bool {
    text.unicodeScalars.contains { CharacterSet.letters.contains($0) || CharacterSet.decimalDigits.contains($0) }
}

/// バッファを一定の長さに分け、各片の開始時刻と組にして返す。
func splitBuffer(_ buffer: AVAudioPCMBuffer, seconds: Double) -> [(AVAudioPCMBuffer, CMTime)] {
    let format = buffer.format
    let total = Int(buffer.frameLength)
    let step = max(1, Int(format.sampleRate * seconds))
    var pieces: [(AVAudioPCMBuffer, CMTime)] = []
    var offset = 0
    let bytesPerFrame = Int(format.streamDescription.pointee.mBytesPerFrame)
    while offset < total {
        let n = min(step, total - offset)
        let piece = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(n))!
        piece.frameLength = AVAudioFrameCount(n)
        let src = buffer.audioBufferList.pointee.mBuffers
        let dst = piece.mutableAudioBufferList.pointee.mBuffers
        memcpy(dst.mData!, src.mData!.advanced(by: offset * bytesPerFrame), n * bytesPerFrame)
        pieces.append((piece, CMTime(value: CMTimeValue(offset), timescale: CMTimeScale(format.sampleRate))))
        offset += n
    }
    return pieces
}
