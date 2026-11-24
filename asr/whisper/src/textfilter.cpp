#include "textfilter.hpp"

#include <algorithm>
#include <cstdint>

namespace longhand {

std::u32string utf8_to_u32(const std::string & s) {
    std::u32string out;
    out.reserve(s.size());
    size_t i = 0;
    while (i < s.size()) {
        const unsigned char c = s[i];
        char32_t cp;
        int n;
        if (c < 0x80) { cp = c; n = 1; }
        else if ((c >> 5) == 0x6) { cp = c & 0x1F; n = 2; }
        else if ((c >> 4) == 0xE) { cp = c & 0x0F; n = 3; }
        else if ((c >> 3) == 0x1E) { cp = c & 0x07; n = 4; }
        else { ++i; continue; }  // Drop invalid bytes
        if (i + n > s.size()) break;
        bool ok = true;
        for (int k = 1; k < n; ++k) {
            const unsigned char cc = s[i + k];
            if ((cc >> 6) != 0x2) { ok = false; break; }
            cp = (cp << 6) | (cc & 0x3F);
        }
        if (!ok) { ++i; continue; }
        out.push_back(cp);
        i += n;
    }
    return out;
}

std::string u32_to_utf8(const std::u32string & s) {
    std::string out;
    out.reserve(s.size() * 3);
    for (char32_t cp : s) {
        if (cp < 0x80) out.push_back((char) cp);
        else if (cp < 0x800) { out.push_back((char) (0xC0 | (cp >> 6))); out.push_back((char) (0x80 | (cp & 0x3F))); }
        else if (cp < 0x10000) {
            out.push_back((char) (0xE0 | (cp >> 12)));
            out.push_back((char) (0x80 | ((cp >> 6) & 0x3F)));
            out.push_back((char) (0x80 | (cp & 0x3F)));
        } else {
            out.push_back((char) (0xF0 | (cp >> 18)));
            out.push_back((char) (0x80 | ((cp >> 12) & 0x3F)));
            out.push_back((char) (0x80 | ((cp >> 6) & 0x3F)));
            out.push_back((char) (0x80 | (cp & 0x3F)));
        }
    }
    return out;
}

static bool is_punct_or_symbol(char32_t c) {
    if (c < 0x80) return !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'));
    if (c == 0x30FC) return false;                                // Keep the long vowel mark as a letter
    if (c >= 0x3000 && c <= 0x303F) return !(c == 0x3005 || c == 0x3006 || c == 0x3007);  // Keep 々〆〇
    if (c == 0x30FB) return true;                                 // ・
    if (c >= 0x2000 && c <= 0x2BFF) return true;                  // General punctuation, arrows, symbols, ♪ and so on
    if (c >= 0xFE30 && c <= 0xFE4F) return true;
    if (c >= 0x1F000) return true;                                // Emoji
    if (c == 0x00A0 || c == 0x00B7) return true;
    return false;
}

std::u32string normalize_for_match(const std::string & s) {
    std::u32string in = utf8_to_u32(s), out;
    out.reserve(in.size());
    for (char32_t c : in) {
        if (c >= 0xFF01 && c <= 0xFF5E) c = c - 0xFF01 + 0x21;  // Full-width ASCII to half-width
        if (c == 0x3000) c = ' ';
        if (c >= 'A' && c <= 'Z') c = c - 'A' + 'a';
        if (is_punct_or_symbol(c)) continue;
        out.push_back(c);
    }
    return out;
}

namespace {

// Phrases that are always dropped when present (they come from video subtitle data and almost never occur in dictation)
const char * kAlwaysDrop[] = {
    "ご視聴", "ご覧いただきありがとう", "チャンネル登録", "高評価", "字幕", "次回もお楽しみに", "次の動画",
    "おやすみなさいませ", "thanksforwatching", "thankyouforwatching", "subtitlesby", "subtitledby", "amaraorg",
    "pleasesubscribe", "音楽", "拍手",
};

// Phrases dropped only when the whole segment matches and the evidence of speech is weak (people do actually say them)
const char * kDropIfWeak[] = {
    "ありがとうございました", "ありがとうございます", "おやすみなさい", "お疲れ様でした", "それではまた", "ではまた",
    "またね", "バイバイ", "thankyou", "bye", "you", "えー", "あー", "笑",
};

}  // namespace

std::string hallucination_reason(const std::string & text, const SegmentEvidence & ev, const std::u32string & prompt_norm) {
    const std::u32string n = normalize_for_match(text);
    if (n.empty()) return "no-letters";
    for (const char * p : kAlwaysDrop) {
        const std::u32string pn = normalize_for_match(p);
        if (n.find(pn) != std::u32string::npos) return std::string("blocklist:") + p;
    }
    // Weak evidence of speech: likely silence, low confidence, or too many characters for the VAD speech length (Japanese is about 8 to 10 characters per second)
    const bool too_dense = ev.speech_sec > 0.0f && (float) n.size() > ev.speech_sec * 14.0f + 2.0f;
    const bool weak = ev.no_speech_prob > 0.2f || ev.avg_logprob < -0.7f || too_dense;
    if (weak) {
        for (const char * p : kDropIfWeak) {
            if (n == normalize_for_match(p)) return std::string("weak:") + p;
        }
    }
    // Echo of the initial prompt (a segment that outputs 80% or more of the prompt verbatim)
    if (!prompt_norm.empty() && n.size() >= 10 && n.size() * 10 >= prompt_norm.size() * 8 &&
        prompt_norm.find(n) != std::u32string::npos) {
        return "prompt-echo";
    }
    return "";
}

std::string collapse_repeats(const std::string & text) {
    std::u32string s = utf8_to_u32(text);
    bool changed = true;
    int guard = 0;
    while (changed && guard++ < 8) {
        changed = false;
        const size_t n = s.size();
        for (size_t unit = 1; unit <= 24 && !changed; ++unit) {
            const size_t min_reps = unit == 1 ? 10 : 6;
            for (size_t i = 0; i + unit * min_reps <= n && !changed; ++i) {
                size_t reps = 1;
                while (i + unit * (reps + 1) <= n &&
                       std::equal(s.begin() + i, s.begin() + i + unit, s.begin() + i + unit * reps)) {
                    ++reps;
                }
                if (reps >= min_reps) {
                    s.erase(s.begin() + i + unit, s.begin() + i + unit * reps);
                    changed = true;
                }
            }
        }
    }
    return u32_to_utf8(s);
}

std::string trim(const std::string & s) {
    std::u32string u = utf8_to_u32(s);
    auto ws = [](char32_t c) { return c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == 0x3000; };
    size_t b = 0, e = u.size();
    while (b < e && ws(u[b])) ++b;
    while (e > b && ws(u[e - 1])) --e;
    return u32_to_utf8(u.substr(b, e - b));
}

std::string join_segments(const std::vector<std::string> & parts) {
    std::string out;
    auto alnum = [](char32_t c) { return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'); };
    auto latin_punct = [](char32_t c) { return c == '.' || c == ',' || c == '!' || c == '?' || c == ':' || c == ';'; };
    for (const auto & p0 : parts) {
        const std::string p = trim(p0);
        if (p.empty()) continue;
        if (!out.empty()) {
            const std::u32string a = utf8_to_u32(out), b = utf8_to_u32(p);
            const char32_t last = a.back(), first = b.front();
            if ((alnum(last) || latin_punct(last)) && alnum(first)) out += " ";
        }
        out += p;
    }
    return out;
}

}  // namespace longhand
