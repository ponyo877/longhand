import Foundation

// AX のテキスト範囲は UTF-16 単位。サロゲートペアを途中で切らないように範囲を調整して切り出す。

public enum TextSlicing {
    /// UTF-16 単位の範囲 [start, end) を、サロゲートペアを割らないように内側へ縮める
    public static func safeRange(in utf16: [UInt16], start: Int, end: Int) -> Range<Int> {
        var s = max(0, min(start, utf16.count))
        var e = max(s, min(end, utf16.count))
        if s < e, s < utf16.count, UTF16.isTrailSurrogate(utf16[s]), s > 0, UTF16.isLeadSurrogate(utf16[s - 1]) {
            s += 1
        }
        if e > s, e < utf16.count, UTF16.isTrailSurrogate(utf16[e]), UTF16.isLeadSurrogate(utf16[e - 1]) {
            e -= 1
        }
        return s..<max(s, e)
    }

    public static func substring(_ string: String, utf16Start start: Int, end: Int) -> String {
        let units = Array(string.utf16)
        let r = safeRange(in: units, start: start, end: end)
        return String(decoding: units[r], as: UTF16.self)
    }

    /// キャレットの手前 maxChars 単位
    public static func before(_ string: String, location: Int, maxChars: Int) -> String {
        substring(string, utf16Start: location - maxChars, end: location)
    }

    /// 位置 location から後ろ maxChars 単位
    public static func after(_ string: String, location: Int, maxChars: Int) -> String {
        substring(string, utf16Start: location, end: location + maxChars)
    }

    /// center を中心に最大 maxChars 単位の窓を切り出す。全体が収まればそのまま返す
    public static func window(_ string: String, center: Int, maxChars: Int) -> String {
        let units = Array(string.utf16)
        if units.count <= maxChars { return string }
        var start = max(0, center - maxChars / 2)
        let end = min(units.count, start + maxChars)
        start = max(0, end - maxChars)
        let r = safeRange(in: units, start: start, end: end)
        return String(decoding: units[r], as: UTF16.self)
    }

    /// 前後の空白・改行の違い、CRLF と LF、Unicode 正規化の違いを無視して比べる（編集モードの選択範囲の確認）
    public static func looselyEqual(_ a: String, _ b: String) -> Bool {
        func norm(_ s: String) -> String {
            s.replacingOccurrences(of: "\r\n", with: "\n")
                .replacingOccurrences(of: "\u{00A0}", with: " ")
                .precomposedStringWithCanonicalMapping
                .trimmingCharacters(in: .whitespacesAndNewlines)
        }
        return norm(a) == norm(b)
    }

    /// 長さの上限で切る（説明やタイトル用）
    public static func truncate(_ s: String, max: Int) -> String {
        if s.count <= max { return s }
        return String(s.prefix(max))
    }
}
