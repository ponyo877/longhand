import Foundation

// AX text ranges are in UTF-16 units. Ranges are adjusted before slicing so that surrogate pairs are never split.

public enum TextSlicing {
    /// Shrinks the UTF-16 range [start, end) inward so that it does not split a surrogate pair
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

    /// maxChars units before the caret
    public static func before(_ string: String, location: Int, maxChars: Int) -> String {
        substring(string, utf16Start: location - maxChars, end: location)
    }

    /// maxChars units after position location
    public static func after(_ string: String, location: Int, maxChars: Int) -> String {
        substring(string, utf16Start: location, end: location + maxChars)
    }

    /// Cuts a window of at most maxChars units centered on center. Returns the whole string if it fits
    public static func window(_ string: String, center: Int, maxChars: Int) -> String {
        let units = Array(string.utf16)
        if units.count <= maxChars { return string }
        var start = max(0, center - maxChars / 2)
        let end = min(units.count, start + maxChars)
        start = max(0, end - maxChars)
        let r = safeRange(in: units, start: start, end: end)
        return String(decoding: units[r], as: UTF16.self)
    }

    /// Compares while ignoring differences in surrounding whitespace and newlines, CRLF versus LF, and Unicode normalization (for checking the selection in edit mode)
    public static func looselyEqual(_ a: String, _ b: String) -> Bool {
        func norm(_ s: String) -> String {
            s.replacingOccurrences(of: "\r\n", with: "\n")
                .replacingOccurrences(of: "\u{00A0}", with: " ")
                .precomposedStringWithCanonicalMapping
                .trimmingCharacters(in: .whitespacesAndNewlines)
        }
        return norm(a) == norm(b)
    }

    /// Cuts at the length limit (for descriptions and titles)
    public static func truncate(_ s: String, max: Int) -> String {
        if s.count <= max { return s }
        return String(s.prefix(max))
    }
}
