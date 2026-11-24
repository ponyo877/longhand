#include "audio.hpp"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <fstream>

namespace longhand {

bool base64_decode(const std::string & in, std::vector<uint8_t> & out) {
    static int8_t table[256];
    static bool init = false;
    if (!init) {
        std::fill(std::begin(table), std::end(table), (int8_t) -1);
        const char * chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        for (int i = 0; i < 64; ++i) table[(uint8_t) chars[i]] = (int8_t) i;
        table[(uint8_t) '-'] = 62;  // base64url も受け付ける
        table[(uint8_t) '_'] = 63;
        init = true;
    }
    out.clear();
    out.reserve(in.size() * 3 / 4);
    uint32_t acc = 0;
    int bits = 0;
    for (unsigned char c : in) {
        if (c == '=') break;
        if (c == '\n' || c == '\r' || c == ' ' || c == '\t') continue;
        const int8_t v = table[c];
        if (v < 0) return false;
        acc = (acc << 6) | (uint32_t) v;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out.push_back((uint8_t) ((acc >> bits) & 0xFF));
        }
    }
    return true;
}

bool decode_pcm_base64(const std::string & b64, std::vector<float> & out, std::string & err) {
    std::vector<uint8_t> bytes;
    if (!base64_decode(b64, bytes)) {
        err = "pcm is not valid base64";
        return false;
    }
    if (bytes.size() % 4 != 0) {
        err = "pcm byte length is not a multiple of 4 (expected Float32 LE)";
        return false;
    }
    out.resize(bytes.size() / 4);
    if (!out.empty()) std::memcpy(out.data(), bytes.data(), bytes.size());  // Apple Silicon はリトルエンディアン
    for (float & v : out) {
        if (!std::isfinite(v)) v = 0.0f;
    }
    return true;
}

static uint32_t rd_u32(const uint8_t * p) { return p[0] | (p[1] << 8) | (p[2] << 16) | ((uint32_t) p[3] << 24); }
static uint16_t rd_u16(const uint8_t * p) { return (uint16_t) (p[0] | (p[1] << 8)); }

bool read_wav(const std::string & path, std::vector<float> & out, std::string & err) {
    std::ifstream f(path, std::ios::binary);
    if (!f) {
        err = "cannot open wav: " + path;
        return false;
    }
    std::vector<uint8_t> buf((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
    if (buf.size() < 12 || std::memcmp(buf.data(), "RIFF", 4) != 0 || std::memcmp(buf.data() + 8, "WAVE", 4) != 0) {
        err = "not a RIFF/WAVE file";
        return false;
    }
    uint16_t fmt_tag = 0, channels = 0, bits = 0;
    uint32_t rate = 0;
    const uint8_t * data = nullptr;
    size_t data_len = 0;
    size_t pos = 12;
    while (pos + 8 <= buf.size()) {
        const uint8_t * ck = buf.data() + pos;
        uint32_t len = rd_u32(ck + 4);
        size_t body = pos + 8;
        size_t avail = buf.size() - body;
        if (std::memcmp(ck, "fmt ", 4) == 0 && len >= 16 && avail >= 16) {
            fmt_tag = rd_u16(ck + 8);
            channels = rd_u16(ck + 10);
            rate = rd_u32(ck + 12);
            bits = rd_u16(ck + 22);
            if (fmt_tag == 0xFFFE && len >= 26 && avail >= 26) fmt_tag = rd_u16(ck + 32);  // WAVE_FORMAT_EXTENSIBLE
        } else if (std::memcmp(ck, "data", 4) == 0) {
            data = buf.data() + body;
            data_len = std::min<size_t>(len, avail);  // 録音途中のファイル（長さ 0 や過大）にも耐える
            if (len == 0 || len == 0xFFFFFFFF) data_len = avail;
            break;
        }
        pos = body + len + (len & 1);
    }
    if (!data || channels == 0 || rate == 0) {
        err = "wav has no fmt/data chunk";
        return false;
    }
    const bool is_float = fmt_tag == 3;
    if (!((fmt_tag == 1 && (bits == 16 || bits == 24 || bits == 32)) || (is_float && bits == 32))) {
        err = "unsupported wav format (tag=" + std::to_string(fmt_tag) + ", bits=" + std::to_string(bits) + ")";
        return false;
    }
    const size_t bps = bits / 8;
    const size_t frames = data_len / (bps * channels);
    std::vector<float> mono(frames);
    for (size_t i = 0; i < frames; ++i) {
        float acc = 0.0f;
        for (size_t c = 0; c < channels; ++c) {
            const uint8_t * s = data + (i * channels + c) * bps;
            float v;
            if (is_float) {
                std::memcpy(&v, s, 4);
                if (!std::isfinite(v)) v = 0.0f;
            } else if (bits == 16) {
                v = (int16_t) rd_u16(s) / 32768.0f;
            } else if (bits == 24) {
                int32_t x = (s[0] << 8) | (s[1] << 16) | (s[2] << 24);
                v = (x >> 8) / 8388608.0f;
            } else {
                v = (int32_t) rd_u32(s) / 2147483648.0f;
            }
            acc += v;
        }
        mono[i] = acc / channels;
    }
    if (rate == (uint32_t) kSampleRate) {
        out = std::move(mono);
        return true;
    }
    // 線形補間でリサンプリング（アプリは 16 kHz を渡す前提なので、念のための経路）
    const double ratio = (double) rate / kSampleRate;
    const size_t n_out = (size_t) std::floor(frames / ratio);
    out.resize(n_out);
    for (size_t i = 0; i < n_out; ++i) {
        const double src = i * ratio;
        const size_t i0 = (size_t) src;
        const size_t i1 = std::min(i0 + 1, frames - 1);
        const float t = (float) (src - i0);
        out[i] = mono[i0] * (1.0f - t) + mono[i1] * t;
    }
    return true;
}

float peak_dbfs(const float * x, size_t n) {
    float p = 0.0f;
    for (size_t i = 0; i < n; ++i) p = std::max(p, std::fabs(x[i]));
    return p > 0 ? 20.0f * std::log10(p) : -200.0f;
}

float rms_dbfs(const float * x, size_t n) {
    if (n == 0) return -200.0f;
    double s = 0;
    for (size_t i = 0; i < n; ++i) s += (double) x[i] * x[i];
    const double r = std::sqrt(s / n);
    return r > 0 ? 20.0f * (float) std::log10(r) : -200.0f;
}

}  // namespace longhand
