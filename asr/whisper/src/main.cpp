// longhand-asr-whisper: whisper.cpp（Metal）を使う ASR ワーカー。
// src/shared/asr-protocol.ts の stdio JSON Lines プロトコルを話す。
//
// - stdout はプロトコル専用。起動直後に fd 1 を stderr に付け替え、元の stdout は g_out でだけ使う
//   （whisper.cpp や ggml が誤って stdout に書いてもプロトコルが壊れないようにするため）。
// - 要求は 1 件ずつ順に処理する。stdin が EOF になったら終了する。
// - stdin は別のスレッドで読む。cancel だけはそのスレッドで受け、書き起こしの途中でも止められるようにする。

#include "audio.hpp"
#include "textfilter.hpp"

#include "json.hpp"
#include "whisper.h"

#include <unistd.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cstdarg>
#include <cstdio>
#include <cstring>
#include <deque>
#include <iostream>
#include <mutex>
#include <string>
#include <thread>
#include <utility>
#include <vector>

using json = nlohmann::json;
using longhand::kSampleRate;

#ifndef LONGHAND_ASR_WHISPER_VERSION
#define LONGHAND_ASR_WHISPER_VERSION "0.1.0"
#endif

static constexpr int kProtocolVersion = 1;
static constexpr const char * kDefaultInitialPrompt = "";  // 既定はプロンプトなし（ベンチマークの結果。docs/evaluation.md）

static FILE * g_out = nullptr;
static bool g_verbose = false;
static bool g_debug = false;  // result.payload に debug（スキップ理由、捨てた区間など）を付ける。ベンチマーク用

static void logf(const char * fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    fprintf(stderr, "[longhand-asr-whisper] ");
    vfprintf(stderr, fmt, ap);
    fprintf(stderr, "\n");
    va_end(ap);
}

static void send(const json & j) {
    const std::string s = j.dump(-1, ' ', false, json::error_handler_t::replace);
    fwrite(s.data(), 1, s.size(), g_out);
    fputc('\n', g_out);
    fflush(g_out);
}

// UTF-8 の文字が途中で切れていないか（末尾の文字のバイトが揃っているか）
static bool utf8_complete(const std::string & s) {
    int i = (int) s.size() - 1, cont = 0;
    while (i >= 0 && (((unsigned char) s[i]) & 0xC0) == 0x80) { --i; ++cont; }
    if (i < 0) return cont == 0;
    const unsigned char c = (unsigned char) s[i];
    const int need = c < 0x80 ? 0 : (c >> 5) == 0x6 ? 1 : (c >> 4) == 0xE ? 2 : (c >> 3) == 0x1E ? 3 : -1;
    return need == cont;
}

static void send_error(const json & id, const std::string & code, const std::string & message) {
    json j = {{"type", "error"}, {"payload", {{"code", code}, {"message", message}}}};
    if (!id.is_null()) j["id"] = id;
    send(j);
}

static void whisper_log_cb(enum ggml_log_level level, const char * text, void *) {
    if (g_verbose || level >= GGML_LOG_LEVEL_WARN) fputs(text, stderr);
}

static double now_ms() {
    using namespace std::chrono;
    return duration<double, std::milli>(steady_clock::now().time_since_epoch()).count();
}

// ---- 取り消し ---------------------------------------------------------------
// cancel は「それまでに受け取った要求をすべて取り消す」。後から届く要求には効かない。
// 要求には受け取った順に通し番号を振り、処理中の要求の番号が取り消しの範囲に入ったら止める。

static std::atomic<uint64_t> g_received{0};     // 最後に受け取った要求の番号
static std::atomic<uint64_t> g_cancel_upto{0};  // この番号までの要求は取り消す
static std::atomic<uint64_t> g_current{0};      // 処理中の要求の番号（0 = 処理中の要求なし）

static bool cancelled_now() {
    const uint64_t cur = g_current.load();
    return cur != 0 && g_cancel_upto.load() >= cur;
}

// whisper.cpp はエンコーダとデコーダの計算のたびにこれを呼び、true なら打ち切る
static bool abort_cb(void *) { return cancelled_now(); }

// エンコーダを動かす前に呼ばれる。false を返すとエンコードせずに打ち切る
static bool encoder_begin_cb(whisper_context *, whisper_state *, void *) { return !cancelled_now(); }

// デコードの各ステップで、上位の候補を記録する（確信度の低い箇所の別候補を出すため）。
// greedy で best_of=1 のときだけ使う（デコーダが 1 本なので、呼ばれる順がそのままステップの順になる）
struct LogitsTap {
    int top_k = 0;
    int n_vocab = 0;
    whisper_token eot = 0;
    // steps[s]: s 番目のステップの上位候補（テキストのトークンだけ。確率の降順）
    std::vector<std::vector<std::pair<whisper_token, float>>> steps;
    // chosen[s]: s 番目のステップで選ばれたトークン（次のステップが呼ばれたときに分かる）
    std::vector<whisper_token> chosen;
};

static void logits_tap_cb(whisper_context *, whisper_state *, const whisper_token_data * tokens, int n_tokens, float * logits, void * user) {
    auto * tap = static_cast<LogitsTap *>(user);
    if (!tap || tap->top_k <= 0) return;
    // 温度を上げたやり直しと、次の 30 秒窓では、0 から数え直す
    if (n_tokens == 0) {
        tap->steps.clear();
        tap->chosen.clear();
    }
    if ((int) tap->steps.size() != n_tokens) {
        tap->top_k = 0;  // 呼ばれる順がずれた。以後は記録しない（別候補は出さない）
        return;
    }
    if (n_tokens > 0) tap->chosen.push_back(tokens[n_tokens - 1].id);
    float mx = -INFINITY;
    for (int i = 0; i < tap->n_vocab; ++i)
        if (logits[i] > mx) mx = logits[i];
    double sum = 0;
    for (int i = 0; i < tap->n_vocab; ++i)
        if (std::isfinite(logits[i])) sum += std::exp((double) logits[i] - mx);
    // 選ばれた 1 つを除いても top_k 個が残るように、1 つ多く持つ
    const size_t keep = (size_t) tap->top_k + 1;
    std::vector<std::pair<whisper_token, float>> top;
    top.reserve(keep + 1);
    for (int i = 0; i < tap->eot; ++i) {
        const float l = logits[i];
        if (!std::isfinite(l)) continue;
        if (top.size() < keep || l > top.back().second) {
            auto it = std::upper_bound(top.begin(), top.end(), l, [](float v, const std::pair<whisper_token, float> & e) { return v > e.second; });
            top.insert(it, {(whisper_token) i, l});
            if (top.size() > keep) top.pop_back();
        }
    }
    for (auto & e : top) e.second = sum > 0 ? (float) (std::exp((double) e.second - mx) / sum) : 0.0f;
    tap->steps.push_back(std::move(top));
}

// ---- 設定 -----------------------------------------------------------------

struct Config {
    std::string model_path;
    std::string language = "ja";

    int threads = 4;
    bool use_gpu = true;
    bool flash_attn = true;

    int beam_size = 1;                 // 1 なら greedy
    int best_of = 1;
    bool temperature_fallback = true;  // 失敗判定（エントロピー、logprob）時に温度を上げて再デコード
    float no_speech_thold = 0.6f;
    float logprob_thold = -1.0f;
    float entropy_thold = 2.4f;
    bool suppress_nst = true;
    int audio_ctx = 0;                 // 0 = 既定（30 秒窓）。-1 = 音声の長さに合わせて縮める（実験用。速いが精度が落ちうる）
    float audio_ctx_pad_sec = 1.0f;

    // 発話検出（ハルシネーション対策）
    std::string vad_mode = "trim";     // off | gate | trim | filter
    std::string vad_model_path;
    float vad_threshold = 0.5f;
    int vad_min_speech_ms = 250;
    int vad_min_silence_ms = 300;
    int vad_pad_ms = 300;
    int min_duration_ms = 250;         // これより短い音声は推論せず空を返す
    float silence_peak_dbfs = -50.0f;  // ピークがこれ未満なら無音とみなす
    float min_speech_sec = 0.2f;       // VAD の発話合計がこれ未満なら空を返す

    // プロンプト
    std::string initial_prompt = kDefaultInitialPrompt;
    bool hints_in_prompt = true;
    int max_hints = 64;
    bool carry_initial_prompt = true;  // 30 秒を超える音声でも各窓にプロンプトを入れる
    // whisper のプロンプトは最大 223 トークン（n_text_ctx / 2 - 1）で、超えると先頭（辞書語）から切られる。
    // そこで辞書語と直前の区間の書き起こし（transcribe の prompt）に別々の上限を設け、合計も抑える。
    int prompt_max_tokens = 220;
    int hints_max_tokens = 120;
    int context_max_tokens = 100;

    bool filter = true;                // ハルシネーションの語句フィルタと繰り返しの圧縮
    bool warmup = true;
};

template <typename T>
static void opt(const json & o, const char * key, T & dst) {
    if (o.contains(key) && !o[key].is_null()) dst = o[key].get<T>();
}

static void apply_options(Config & c, const json & o) {
    if (!o.is_object()) return;
    opt(o, "threads", c.threads);
    opt(o, "useGpu", c.use_gpu);
    opt(o, "flashAttn", c.flash_attn);
    opt(o, "beamSize", c.beam_size);
    opt(o, "bestOf", c.best_of);
    opt(o, "temperatureFallback", c.temperature_fallback);
    opt(o, "noSpeechThreshold", c.no_speech_thold);
    opt(o, "logprobThreshold", c.logprob_thold);
    opt(o, "entropyThreshold", c.entropy_thold);
    opt(o, "suppressNonSpeech", c.suppress_nst);
    opt(o, "audioCtx", c.audio_ctx);
    opt(o, "audioCtxPadSec", c.audio_ctx_pad_sec);
    opt(o, "vad", c.vad_mode);
    opt(o, "vadModelPath", c.vad_model_path);
    opt(o, "vadThreshold", c.vad_threshold);
    opt(o, "vadMinSpeechMs", c.vad_min_speech_ms);
    opt(o, "vadMinSilenceMs", c.vad_min_silence_ms);
    opt(o, "vadPadMs", c.vad_pad_ms);
    opt(o, "minDurationMs", c.min_duration_ms);
    opt(o, "silencePeakDbfs", c.silence_peak_dbfs);
    opt(o, "minSpeechSec", c.min_speech_sec);
    opt(o, "initialPrompt", c.initial_prompt);
    opt(o, "hintsInPrompt", c.hints_in_prompt);
    opt(o, "maxHints", c.max_hints);
    opt(o, "carryInitialPrompt", c.carry_initial_prompt);
    opt(o, "promptMaxTokens", c.prompt_max_tokens);
    opt(o, "hintsMaxTokens", c.hints_max_tokens);
    opt(o, "contextMaxTokens", c.context_max_tokens);
    c.prompt_max_tokens = std::clamp(c.prompt_max_tokens, 0, 223);
    opt(o, "filter", c.filter);
    opt(o, "warmup", c.warmup);
    if (o.contains("verbose")) g_verbose = o["verbose"].get<bool>();
    if (o.contains("debug")) g_debug = o["debug"].get<bool>();
}

static std::string dirname_of(const std::string & p) {
    const size_t k = p.find_last_of('/');
    return k == std::string::npos ? std::string(".") : p.substr(0, k);
}

static bool file_exists(const std::string & p) { return !p.empty() && access(p.c_str(), R_OK) == 0; }

// ---- エンジン ---------------------------------------------------------------

struct Engine {
    Config cfg;
    whisper_context * ctx = nullptr;
    whisper_vad_context * vctx = nullptr;
    std::string model_desc;

    ~Engine() { unload(); }

    void unload() {
        if (vctx) whisper_vad_free(vctx);
        if (ctx) whisper_free(ctx);
        vctx = nullptr;
        ctx = nullptr;
    }

    // 戻り値: エラーコード（空なら成功）
    std::string load(const Config & c, std::string & err) {
        unload();
        cfg = c;
        if (!file_exists(cfg.model_path)) {
            err = "model file not found: " + cfg.model_path;
            return "model_not_found";
        }
        whisper_context_params cp = whisper_context_default_params();
        cp.use_gpu = cfg.use_gpu;
        cp.flash_attn = cfg.flash_attn;
        ctx = whisper_init_from_file_with_params(cfg.model_path.c_str(), cp);
        if (!ctx) {
            err = "failed to load whisper model: " + cfg.model_path;
            return "model_not_found";
        }
        model_desc = std::string("whisper.cpp ") + whisper_version() + " " + whisper_model_type_readable(ctx) + " " +
                     cfg.model_path.substr(cfg.model_path.find_last_of('/') + 1);

        if (cfg.vad_mode != "off") {
            if (cfg.vad_model_path.empty()) {
                // 既定: モデルと同じフォルダの Silero VAD
                for (const char * name : {"ggml-silero-v6.2.0.bin", "ggml-silero-v5.1.2.bin"}) {
                    const std::string p = dirname_of(cfg.model_path) + "/" + name;
                    if (file_exists(p)) { cfg.vad_model_path = p; break; }
                }
            }
            if (!file_exists(cfg.vad_model_path)) {
                err = "VAD model not found (set options.vadModelPath or options.vad=\"off\"): " + cfg.vad_model_path;
                unload();
                return "model_not_found";
            }
            if (cfg.vad_mode != "filter") {
                whisper_vad_context_params vp = whisper_vad_default_context_params();
                vp.n_threads = std::min(cfg.threads, 4);
                vp.use_gpu = false;  // Silero は小さいので CPU の方が速い
                vctx = whisper_vad_init_from_file_with_params(cfg.vad_model_path.c_str(), vp);
                if (!vctx) {
                    err = "failed to load VAD model: " + cfg.vad_model_path;
                    unload();
                    return "model_not_found";
                }
            }
            model_desc += " + vad(" + cfg.vad_mode + ")";
        }

        if (cfg.warmup) {
            // Metal のパイプライン生成などの初回コストをここで払っておく。
            // VAD を通さずに 1 秒の弱い雑音でエンコーダとデコーダを 1 回ずつ動かす。
            std::vector<float> noise(kSampleRate);
            uint32_t s = 12345;
            for (float & v : noise) {
                s = s * 1664525u + 1013904223u;
                v = ((s >> 9) / 8388608.0f - 1.0f) * 0.003f;
            }
            whisper_full_params wp = make_params(cfg.language, "", 0.0f, cfg.temperature_fallback);
            wp.vad = false;
            whisper_full(ctx, wp, noise.data(), (int) noise.size());
            if (vctx) {
                whisper_vad_params vp = make_vad_params();
                whisper_vad_segments * segs = whisper_vad_segments_from_samples(vctx, vp, noise.data(), (int) noise.size());
                if (segs) whisper_vad_free_segments(segs);
            }
        }
        return "";
    }

    whisper_vad_params make_vad_params() const {
        whisper_vad_params vp = whisper_vad_default_params();
        vp.threshold = cfg.vad_threshold;
        vp.min_speech_duration_ms = cfg.vad_min_speech_ms;
        vp.min_silence_duration_ms = cfg.vad_min_silence_ms;
        vp.speech_pad_ms = cfg.vad_mode == "filter" ? 100 : 30;
        return vp;
    }

    // initial_prompt の文字列は呼び出し側で保持する（params はポインタを持つだけ）
    whisper_full_params make_params(const std::string & language, const std::string & prompt, float temperature, bool fallback) const {
        const bool beam = cfg.beam_size > 1;
        whisper_full_params p = whisper_full_default_params(beam ? WHISPER_SAMPLING_BEAM_SEARCH : WHISPER_SAMPLING_GREEDY);
        p.n_threads = cfg.threads;
        p.translate = false;
        p.no_context = true;  // 前回の書き起こしを次の呼び出しに持ち込まない
        p.no_timestamps = false;
        p.single_segment = false;
        p.print_special = false;
        p.print_progress = false;
        p.print_realtime = false;
        p.print_timestamps = false;
        p.language = (language.empty() || language == "auto") ? "auto" : language.c_str();
        p.detect_language = false;
        p.suppress_blank = true;
        p.suppress_nst = cfg.suppress_nst;
        p.temperature = temperature;
        p.temperature_inc = fallback ? 0.2f : 0.0f;
        p.entropy_thold = cfg.entropy_thold;
        p.logprob_thold = cfg.logprob_thold;
        p.no_speech_thold = cfg.no_speech_thold;
        p.greedy.best_of = std::max(1, cfg.best_of);
        p.beam_search.beam_size = std::max(1, cfg.beam_size);
        p.audio_ctx = cfg.audio_ctx;
        p.initial_prompt = prompt.empty() ? nullptr : prompt.c_str();
        p.carry_initial_prompt = cfg.carry_initial_prompt && !prompt.empty();
        p.vad = cfg.vad_mode == "filter";
        p.vad_model_path = p.vad ? cfg.vad_model_path.c_str() : nullptr;
        p.vad_params = make_vad_params();
        p.abort_callback = abort_cb;
        p.abort_callback_user_data = nullptr;
        p.encoder_begin_callback = encoder_begin_cb;
        p.encoder_begin_callback_user_data = nullptr;
        return p;
    }

    int count_tokens(const std::string & text) const {
        if (text.empty()) return 0;
        std::vector<whisper_token> buf(text.size() + 16);  // バイト単位の BPE なので、トークン数はバイト数を超えない
        const int n = whisper_tokenize(ctx, text.c_str(), buf.data(), (int) buf.size());
        return n < 0 ? -n : n;
    }

    struct Prompt {
        std::string text;     // whisper に渡す全体（辞書語 + initialPrompt + 直前の文脈）
        std::string context;  // そのうち直前の文脈として使った部分（切り詰め後）
        int tokens = 0;
        int hints_used = 0;
        int hints_given = 0;
    };

    // 辞書語を「、」で並べた 1 文を先に置き、直前の区間の書き起こしを最後に置く
    // （whisper はプロンプトを直前の発話として読むので、直前の文脈は音声のすぐ前に来るのがよい）。
    // 直前の文脈は長ければ先頭を落とし、なるべく文や読点の切れ目から始める。
    // 末尾から budget トークンに収まる最長の部分を返す（UTF-8 の文字境界で切る）。
    // 文の途中から始まらないよう、先頭 1/3 以内に句点や読点があれば、その直後から始める
    std::string tail_within(const std::string & text, int budget) const {
        if (budget <= 0) return std::string();
        if (count_tokens(text) <= budget) return text;
        std::vector<size_t> starts;
        for (size_t i = 0; i < text.size(); ++i)
            if ((text[i] & 0xC0) != 0x80) starts.push_back(i);
        size_t lo = 0, hi = starts.size();  // starts[lo..] のどこかで収まる。hi は空文字列
        while (lo < hi) {
            const size_t mid = (lo + hi) / 2;
            if (count_tokens(text.substr(starts[mid])) <= budget) hi = mid; else lo = mid + 1;
        }
        std::string tail = lo < starts.size() ? text.substr(starts[lo]) : std::string();
        size_t cut = std::string::npos;
        for (const char * d : {"。", "？", "！", "?", "!", "、", ","}) {
            const size_t k = tail.find(d);
            if (k != std::string::npos && k < tail.size() / 3) {
                const size_t e = k + std::strlen(d);
                if (cut == std::string::npos || e < cut) cut = e;
            }
        }
        if (cut != std::string::npos) tail = tail.substr(cut);
        return longhand::trim(tail);
    }

    Prompt build_prompt(const std::vector<std::string> & hints, const std::string & context, const std::string & prompt_text) const {
        Prompt pr;
        if (!longhand::trim(prompt_text).empty()) {
            // main の側で組んだ文をそのまま使う。長ければ先頭を落とす（whisper が使うのは末尾だけなので、大事な語は後ろに置いてある）
            pr.text = tail_within(longhand::trim(prompt_text), cfg.prompt_max_tokens);
            for (const auto & h0 : hints) {
                const std::string h = longhand::trim(h0);
                if (h.empty()) continue;
                ++pr.hints_given;
                if (pr.text.find(h) != std::string::npos) ++pr.hints_used;
            }
            pr.tokens = count_tokens(pr.text);
            return pr;
        }
        std::string head;
        if (cfg.hints_in_prompt && !hints.empty()) {
            std::string line;
            for (const auto & h0 : hints) {
                const std::string h = longhand::trim(h0);
                if (h.empty()) continue;
                ++pr.hints_given;
                if (pr.hints_used >= cfg.max_hints) continue;
                const std::string cand = line.empty() ? h : line + "、" + h;
                if (count_tokens(cand + "。") > std::min(cfg.hints_max_tokens, cfg.prompt_max_tokens)) continue;
                line = cand;
                ++pr.hints_used;
            }
            if (!line.empty()) head += line + "。";
        }
        if (!cfg.initial_prompt.empty()) head += cfg.initial_prompt;
        const int head_tokens = count_tokens(head);

        std::string ctx_t = longhand::trim(context);
        const int budget = std::min(cfg.context_max_tokens, cfg.prompt_max_tokens - head_tokens);
        if (budget < 8) {
            ctx_t.clear();
        } else if (count_tokens(ctx_t) > budget) {
            // 末尾から budget に収まる最長の部分を二分探索する（UTF-8 の文字境界で切る）
            std::vector<size_t> starts;
            for (size_t i = 0; i < ctx_t.size(); ++i)
                if ((ctx_t[i] & 0xC0) != 0x80) starts.push_back(i);
            size_t lo = 0, hi = starts.size();  // starts[lo..] のどこかで収まる。hi は空文字列
            while (lo < hi) {
                const size_t mid = (lo + hi) / 2;
                if (count_tokens(ctx_t.substr(starts[mid])) <= budget) hi = mid; else lo = mid + 1;
            }
            std::string tail = lo < starts.size() ? ctx_t.substr(starts[lo]) : std::string();
            // 文の途中から始まらないよう、先頭 1/3 以内に句点や読点があればその直後から始める
            size_t cut = std::string::npos;
            for (const char * d : {"。", "？", "！", "?", "!", "、", ","}) {
                const size_t k = tail.find(d);
                if (k != std::string::npos && k < tail.size() / 3) {
                    const size_t e = k + std::strlen(d);
                    if (cut == std::string::npos || e < cut) cut = e;
                }
            }
            if (cut != std::string::npos) tail = tail.substr(cut);
            ctx_t = longhand::trim(tail);
        }
        pr.context = ctx_t;
        pr.text = head + ctx_t;
        pr.tokens = count_tokens(pr.text);
        return pr;
    }

    struct Result {
        std::string text;
        std::string language;
        json segments = json::array();
        json debug = json::object();
        int hints_used = 0;
        int hints_given = 0;
        /** 語ごとの確信度。[文字列, 確率] の並び（UTF-8 の文字の切れ目でまとめ、確率は最小値） */
        json tokens = json::array();
        /** 確信度の低い箇所の別候補。{index: tokens の添字, candidates: [[文字列, 確率], ...]} の並び */
        json alternatives = json::array();
        /** 条件を変えて聞き直した、文全体の別の仮説。{text, source, temperature?, avgLogprob} の並び */
        json hypotheses = json::array();
    };

    /** transcribe の任意の指定 */
    struct Extras {
        std::string prompt_text;                 // main の側で組んだプロンプト。あれば hints と context からは組まない
        int alt_top_k = 0;                       // 別候補の数（0 なら出さない）
        float alt_below = 0.5f;                  // この確率未満の箇所に別候補を付ける
        bool rehear_no_hints = false;            // プロンプトなしで聞き直す
        std::vector<float> rehear_temperatures;  // 温度を変えて聞き直す
    };

    /** 1 回のデコードの結果 */
    struct Pass {
        std::string text;
        std::string language;
        json segments = json::array();
        json tokens = json::array();
        json alternatives = json::array();
        json dropped = json::array();
        double avg_logprob = 0;
    };

    // 切り出した音声を 1 回デコードし、区間ごとのフィルタを掛けた結果を out に入れる
    bool run_pass(const float * samples, size_t len, size_t off, float speech_sec, const std::string & language, const std::string & prompt,
                  const std::string & context, float temperature, bool fallback, LogitsTap * tap, float alt_below, json & debug, Pass & out,
                  std::string & err) {
        whisper_full_params p = make_params(language, prompt, temperature, fallback);
        if (tap) {
            p.logits_filter_callback = logits_tap_cb;
            p.logits_filter_callback_user_data = tap;
        }
        if (cfg.audio_ctx < 0) {
            // エンコーダの窓（30 秒 = 1500 フレーム）を音声の長さまで縮める。30 秒以上なら既定のまま
            const double sec = (double) len / kSampleRate + cfg.audio_ctx_pad_sec;
            int actx = (int) std::ceil(sec * 50.0);
            actx = ((actx + 31) / 32) * 32;
            p.audio_ctx = actx >= 1500 ? 0 : std::max(actx, 128);
            debug["audioCtx"] = p.audio_ctx;
        }
        if (cancelled_now()) {
            err = "cancelled";
            return false;
        }
        if (whisper_full(ctx, p, samples, (int) len) != 0) {
            err = cancelled_now() ? "cancelled" : "whisper_full failed";
            return false;
        }
        if (cancelled_now()) {
            // 最後のデコードの後に取り消された。結果は捨てる
            err = "cancelled";
            return false;
        }
        if (g_verbose) {
            whisper_print_timings(ctx);
            whisper_reset_timings(ctx);
        }
        if (language == "auto" || language.empty()) out.language = whisper_lang_str(whisper_full_lang_id(ctx));

        // 区間ごとのフィルタ
        const std::u32string prompt_norm = longhand::normalize_for_match(prompt);
        const std::u32string context_norm = longhand::normalize_for_match(context);
        const whisper_token eot = whisper_token_eot(ctx);
        const int nseg = whisper_full_n_segments(ctx);
        std::vector<std::string> kept;
        double lp_all = 0;
        int nt_all = 0;
        // 別候補: 結果のトークンを、記録したステップに順に対応させる（区間の境目の時刻のトークンは結果に入らないので、少し先まで探す）
        bool aligned = tap && tap->top_k > 0;
        size_t step = 0;
        for (int i = 0; i < nseg; ++i) {
            std::string text = longhand::trim(whisper_full_get_segment_text(ctx, i));
            longhand::SegmentEvidence ev;
            ev.no_speech_prob = whisper_full_get_segment_no_speech_prob(ctx, i);
            ev.speech_sec = speech_sec;
            double lp = 0;
            int nt = 0;
            const int m = whisper_full_n_tokens(ctx, i);
            std::vector<int> step_of(m, -1);
            for (int k = 0; k < m; ++k) {
                const whisper_token_data td = whisper_full_get_token_data(ctx, i, k);
                if (td.id < eot) { lp += td.plog; ++nt; }
                if (aligned) {
                    size_t look = step;
                    while (look < tap->chosen.size() && look < step + 6 && tap->chosen[look] != td.id) ++look;
                    if (look < tap->chosen.size() && look < step + 6) {
                        step_of[k] = (int) look;
                        step = look + 1;
                    } else if (look >= tap->chosen.size() && k == m - 1 && i == nseg - 1) {
                        // 最後に選ばれたトークンは、次のステップが無いので記録に無い。別候補を付けないだけでよい
                    } else {
                        aligned = false;
                    }
                }
            }
            ev.avg_logprob = nt > 0 ? (float) (lp / nt) : 0.0f;
            if (cfg.filter) {
                text = longhand::collapse_repeats(text);
                std::string why = longhand::hallucination_reason(text, ev, prompt_norm);
                if (why.empty() && !context_norm.empty()) {
                    // 直前の区間の書き起こしをそのまま繰り返した区間（音声が不明瞭なときに起きうる）
                    const std::u32string tn = longhand::normalize_for_match(text);
                    if (tn.size() >= 10 && tn.size() * 10 >= context_norm.size() * 8 && context_norm.find(tn) != std::u32string::npos)
                        why = "context-echo";
                }
                if (!why.empty()) {
                    out.dropped.push_back({{"text", text}, {"reason", why}, {"noSpeech", ev.no_speech_prob}, {"avgLogprob", ev.avg_logprob}});
                    continue;
                }
            }
            if (text.empty()) continue;
            lp_all += lp;
            nt_all += nt;
            const double t0 = whisper_full_get_segment_t0(ctx, i) / 100.0 + (double) off / kSampleRate;
            const double t1 = whisper_full_get_segment_t1(ctx, i) / 100.0 + (double) off / kSampleRate;
            out.segments.push_back({{"start", std::round(t0 * 100) / 100}, {"end", std::round(t1 * 100) / 100}, {"text", text}});
            kept.push_back(text);
            // 語ごとの確信度（main の textfix が、確信度の低い所だけを直したり、LLM へ回したりするのに使う）。
            // 1 つの文字が複数のトークンに分かれることがあるので、UTF-8 の文字の切れ目までまとめ、確率は最小値を採る。
            // 書き起こしの文字列とは、main の側で文字の並びを突き合わせて対応させる（ここでは区間の繰り返しの除去などを反映しない）
            std::string piece;
            float pmin = 1.0f;
            int piece_tokens = 0;
            int piece_step = -1;
            whisper_token piece_id = 0;
            for (int k = 0; k < m; ++k) {
                const whisper_token_data td = whisper_full_get_token_data(ctx, i, k);
                if (td.id >= eot) continue;
                piece += whisper_full_get_token_text(ctx, i, k);
                pmin = std::min(pmin, td.p);
                if (piece_tokens++ == 0) {
                    piece_step = step_of[k];
                    piece_id = td.id;
                }
                if (utf8_complete(piece)) {
                    out.tokens.push_back(json::array({piece, std::round((double) pmin * 1000.0) / 1000.0}));
                    // 別候補は、1 つのトークンでできた箇所にだけ付ける（複数のトークンにまたがる字は、候補が字の断片になる）
                    if (aligned && piece_tokens == 1 && piece_step >= 0 && piece_step < (int) tap->steps.size() && pmin < alt_below) {
                        json cands = json::array();
                        for (const auto & c : tap->steps[piece_step]) {
                            if (c.first == piece_id || c.second < 0.01f) continue;
                            const std::string ct = whisper_token_to_str(ctx, c.first);
                            if (longhand::trim(ct).empty() || !utf8_complete(ct)) continue;
                            cands.push_back(json::array({ct, std::round((double) c.second * 1000.0) / 1000.0}));
                            if ((int) cands.size() >= tap->top_k) break;
                        }
                        if (!cands.empty()) out.alternatives.push_back({{"index", (int) out.tokens.size() - 1}, {"candidates", cands}});
                    }
                    piece.clear();
                    pmin = 1.0f;
                    piece_tokens = 0;
                    piece_step = -1;
                }
            }
        }
        if (tap && !aligned) out.alternatives = json::array();  // 対応が取れなかった。誤った位置に付けるより、出さない
        out.text = longhand::join_segments(kept);
        if (cfg.filter) out.text = longhand::collapse_repeats(out.text);
        out.avg_logprob = nt_all > 0 ? lp_all / nt_all : 0.0;
        return true;
    }

    bool transcribe(std::vector<float> & audio, const std::string & language, const std::vector<std::string> & hints,
                    const std::string & context, const Extras & ex, Result & r, std::string & err) {
        const size_t n = audio.size();
        const double dur = (double) n / kSampleRate;
        r.language = language == "auto" ? "" : language;
        r.debug["durationSec"] = dur;

        // 1) 短すぎる・無音の音声は推論しない（whisper は無音でも文を出すことがあるため）
        if (n < (size_t) (cfg.min_duration_ms * kSampleRate / 1000)) {
            r.debug["skipped"] = "too-short";
            return true;
        }
        const float peak = longhand::peak_dbfs(audio.data(), n);
        r.debug["peakDbfs"] = peak;
        if (peak < cfg.silence_peak_dbfs) {
            r.debug["skipped"] = "silence";
            return true;
        }

        // 2) VAD（gate: 発話がなければ空、trim: さらに前後の無音を落とす）
        size_t off = 0, len = n;
        float speech_sec = (float) dur;
        if (vctx && (cfg.vad_mode == "gate" || cfg.vad_mode == "trim")) {
            whisper_vad_params vp = make_vad_params();
            whisper_vad_segments * segs = whisper_vad_segments_from_samples(vctx, vp, audio.data(), (int) n);
            if (!segs) {
                err = "VAD failed";
                return false;
            }
            const int ns = whisper_vad_segments_n_segments(segs);
            speech_sec = 0.0f;
            float first = 0, last = 0;
            for (int i = 0; i < ns; ++i) {
                const float t0 = whisper_vad_segments_get_segment_t0(segs, i) / 100.0f;
                const float t1 = whisper_vad_segments_get_segment_t1(segs, i) / 100.0f;
                if (i == 0) first = t0;
                last = t1;
                speech_sec += t1 - t0;
            }
            whisper_vad_free_segments(segs);
            r.debug["vadSegments"] = ns;
            r.debug["speechSec"] = speech_sec;
            if (ns == 0 || speech_sec < cfg.min_speech_sec) {
                r.debug["skipped"] = "no-speech";
                return true;
            }
            if (cfg.vad_mode == "trim") {
                const double pad = cfg.vad_pad_ms / 1000.0;
                const size_t s0 = (size_t) std::max(0.0, (first - pad) * kSampleRate);
                const size_t s1 = (size_t) std::min((double) n, (last + pad) * kSampleRate);
                if (s1 > s0) { off = s0; len = s1 - s0; }
            }
        }

        // 3) whisper
        const Prompt pr = build_prompt(hints, context, ex.prompt_text);
        const std::string & prompt = pr.text;
        if (!prompt.empty()) {
            r.debug["promptTokens"] = pr.tokens;
            if (pr.hints_given) r.debug["hintsUsed"] = std::to_string(pr.hints_used) + "/" + std::to_string(pr.hints_given);
            r.hints_used = pr.hints_used;
            r.hints_given = pr.hints_given;
            if (!context.empty() && !pr.context.empty()) r.debug["contextChars"] = (int) longhand::utf8_to_u32(pr.context).size();
        }
        LogitsTap tap;
        if (ex.alt_top_k > 0 && cfg.beam_size <= 1 && cfg.best_of <= 1) {
            tap.top_k = std::min(ex.alt_top_k, 8);
            tap.n_vocab = whisper_n_vocab(ctx);
            tap.eot = whisper_token_eot(ctx);
        }
        Pass first;
        if (!run_pass(audio.data() + off, len, off, speech_sec, language, prompt, pr.context, 0.0f, cfg.temperature_fallback,
                      tap.top_k > 0 ? &tap : nullptr, ex.alt_below, r.debug, first, err))
            return false;
        if (!first.language.empty()) r.language = first.language;
        r.text = first.text;
        r.segments = first.segments;
        r.tokens = first.tokens;
        r.alternatives = first.alternatives;
        if (!first.dropped.empty()) r.debug["dropped"] = first.dropped;

        // 4) 聞き直し。同じ音声を、プロンプトなしや温度を変えてもう一度デコードし、違う結果だけを別の仮説として返す
        if (!r.text.empty()) {
            auto rehear = [&](const char * source, const std::string & p2, const std::string & c2, float temperature) -> bool {
                Pass alt;
                json scratch = json::object();
                if (!run_pass(audio.data() + off, len, off, speech_sec, language, p2, c2, temperature, false, nullptr, 0.0f, scratch, alt, err)) return false;
                if (alt.text.empty() || alt.text == r.text) return true;
                for (const auto & h : r.hypotheses)
                    if (h.value("text", std::string()) == alt.text) return true;
                json h = {{"text", alt.text}, {"source", source}, {"avgLogprob", std::round(alt.avg_logprob * 1000.0) / 1000.0}};
                if (temperature > 0) h["temperature"] = std::round((double) temperature * 100.0) / 100.0;
                r.hypotheses.push_back(h);
                return true;
            };
            if (ex.rehear_no_hints && !prompt.empty() && !rehear("no-hints", std::string(), std::string(), 0.0f)) return false;
            for (const float t : ex.rehear_temperatures)
                if (t > 0.0f && !rehear("temperature", prompt, pr.context, t)) return false;
        }
        return true;
    }
};

// ---- メインループ -----------------------------------------------------------

static std::vector<std::string> str_list(const json & j) {
    std::vector<std::string> v;
    if (j.is_array())
        for (const auto & e : j)
            if (e.is_string()) v.push_back(e.get<std::string>());
    return v;
}

// stdin を読むスレッドからメインループへ渡す受け箱
struct Inbox {
    std::mutex m;
    std::condition_variable cv;
    std::deque<std::pair<uint64_t, std::string>> q;
    bool eof = false;
};
static Inbox g_inbox;

// cancel はこのスレッドで処理し、それ以外の行は通し番号を付けてメインループへ渡す。
// cancel は短い行なので、長い行（pcm を含む transcribe など）は解析せずにそのまま渡す。
static void reader_loop() {
    std::string line;
    while (std::getline(std::cin, line)) {
        if (line.empty() || line == "\r") continue;
        if (line.size() < 1024) {
            bool is_cancel = false;
            try {
                const json j = json::parse(line);
                is_cancel = j.is_object() && j.contains("type") && j["type"] == "cancel";
            } catch (...) {
                // 解析できない行はメインループでエラーを返す
            }
            if (is_cancel) {
                g_cancel_upto.store(g_received.load());
                if (g_verbose) logf("cancel (up to #%llu)", (unsigned long long) g_cancel_upto.load());
                continue;
            }
        }
        const uint64_t seq = ++g_received;
        {
            std::lock_guard<std::mutex> lk(g_inbox.m);
            g_inbox.q.emplace_back(seq, std::move(line));
        }
        g_inbox.cv.notify_one();
        line.clear();
    }
    {
        std::lock_guard<std::mutex> lk(g_inbox.m);
        g_inbox.eof = true;
    }
    g_inbox.cv.notify_one();
}

// 処理中の要求の番号を、ループの 1 回分だけ設定する（continue で抜けても戻す）
struct CurrentRequest {
    explicit CurrentRequest(uint64_t seq) { g_current.store(seq); }
    ~CurrentRequest() { g_current.store(0); }
};

int main(int argc, char ** argv) {
    // 元の stdout をプロトコル用に複製し、fd 1 は stderr に向ける
    int proto_fd = dup(STDOUT_FILENO);
    g_out = fdopen(proto_fd, "w");
    dup2(STDERR_FILENO, STDOUT_FILENO);
    for (int i = 1; i < argc; ++i) {
        std::string a = argv[i];
        if (a == "--verbose" || a == "-v") g_verbose = true;
        if (a == "--version") {
            fprintf(g_out, "longhand-asr-whisper %s (whisper.cpp %s)\n", LONGHAND_ASR_WHISPER_VERSION, whisper_version());
            fflush(g_out);
            return 0;
        }
    }
    whisper_log_set(whisper_log_cb, nullptr);

    Engine engine;
    bool loaded = false;
    send({{"type", "ready"},
          {"payload", {{"engine", "whisper"}, {"version", std::string(LONGHAND_ASR_WHISPER_VERSION) + "+whisper.cpp-" + whisper_version()},
                       {"protocol", kProtocolVersion}, {"features", json::array({"cancel", "tokens", "promptText", "alternatives", "hypotheses"})}}}});

    std::thread(reader_loop).detach();
    while (true) {
        std::pair<uint64_t, std::string> item;
        {
            std::unique_lock<std::mutex> lk(g_inbox.m);
            g_inbox.cv.wait(lk, [] { return !g_inbox.q.empty() || g_inbox.eof; });
            if (g_inbox.q.empty()) break;  // EOF
            item = std::move(g_inbox.q.front());
            g_inbox.q.pop_front();
        }
        const std::string & line = item.second;
        CurrentRequest current(item.first);
        json msg;
        try {
            msg = json::parse(line);
        } catch (const std::exception & e) {
            send_error(nullptr, "bad_request", std::string("invalid JSON: ") + e.what());
            continue;
        }
        const json id = msg.contains("id") ? msg["id"] : json(nullptr);
        const std::string type = msg.value("type", "");
        const json payload = msg.contains("payload") && msg["payload"].is_object() ? msg["payload"] : json::object();
        try {
            if (type == "ping") {
                send({{"type", "pong"}, {"id", id}, {"payload", json::object()}});
            } else if (type == "load") {
                const double t0 = now_ms();
                Config c;
                c.model_path = payload.value("modelPath", "");
                c.language = payload.value("language", "ja");
                if (payload.contains("options")) apply_options(c, payload["options"]);
                std::string err;
                const std::string code = engine.load(c, err);
                if (!code.empty()) {
                    loaded = false;
                    logf("load failed: %s", err.c_str());
                    send_error(id, code, err);
                    continue;
                }
                loaded = true;
                const double el = now_ms() - t0;
                logf("loaded %s in %.0f ms", engine.model_desc.c_str(), el);
                send({{"type", "loaded"}, {"id", id}, {"payload", {{"elapsedMs", (int64_t) std::llround(el)}, {"model", engine.model_desc}}}});
            } else if (type == "transcribe") {
                if (!loaded) {
                    send_error(id, "not_loaded", "model is not loaded (send load first)");
                    continue;
                }
                if (cancelled_now()) {
                    // 処理を始める前に取り消された
                    send_error(id, "cancelled", "cancelled");
                    continue;
                }
                const double t0 = now_ms();
                std::vector<float> audio;
                std::string err;
                if (payload.contains("pcm") && payload["pcm"].is_string()) {
                    if (!longhand::decode_pcm_base64(payload["pcm"].get<std::string>(), audio, err)) {
                        send_error(id, "bad_request", err);
                        continue;
                    }
                } else if (payload.contains("wavPath") && payload["wavPath"].is_string()) {
                    if (!longhand::read_wav(payload["wavPath"].get<std::string>(), audio, err)) {
                        send_error(id, "bad_request", err);
                        continue;
                    }
                } else {
                    send_error(id, "bad_request", "transcribe needs pcm or wavPath");
                    continue;
                }
                const std::string lang = payload.value("language", engine.cfg.language);
                Engine::Result r;
                Engine::Extras ex;
                ex.prompt_text = payload.value("promptText", "");
                if (payload.contains("alternatives") && payload["alternatives"].is_object()) {
                    ex.alt_top_k = payload["alternatives"].value("topK", 0);
                    ex.alt_below = payload["alternatives"].value("below", 0.5f);
                }
                if (payload.contains("rehear") && payload["rehear"].is_object()) {
                    const json & rh = payload["rehear"];
                    ex.rehear_no_hints = rh.value("noHints", false);
                    if (rh.contains("temperatures") && rh["temperatures"].is_array())
                        for (const auto & e : rh["temperatures"])
                            if (e.is_number()) ex.rehear_temperatures.push_back(e.get<float>());
                }
                if (!engine.transcribe(audio, lang, str_list(payload.value("hints", json::array())),
                                       payload.value("prompt", ""), ex, r, err)) {
                    if (cancelled_now()) {
                        if (g_verbose) logf("transcribe cancelled after %.0f ms", now_ms() - t0);
                        send_error(id, "cancelled", "cancelled");
                    } else {
                        send_error(id, "inference_failed", err);
                    }
                    continue;
                }
                const double el = now_ms() - t0;
                json pl = {{"text", r.text}, {"elapsedMs", (int64_t) std::llround(el)}, {"segments", r.segments}};
                if (!r.language.empty()) pl["language"] = r.language;
                if (!r.tokens.empty()) pl["tokens"] = r.tokens;
                if (!r.alternatives.empty()) pl["alternatives"] = r.alternatives;
                if (!r.hypotheses.empty()) pl["hypotheses"] = r.hypotheses;
                if (r.hints_given > 0) {
                    // 渡した語彙ヒントのうち、プロンプトの上限に収まった数（main の完了ログに出す）
                    pl["hintsUsed"] = r.hints_used;
                    pl["hintsGiven"] = r.hints_given;
                }
                if (g_debug) pl["debug"] = r.debug;
                if (g_verbose) logf("transcribed %.2fs audio in %.0f ms: %s", r.debug.value("durationSec", 0.0), el, r.debug.dump().c_str());
                send({{"type", "result"}, {"id", id}, {"payload", pl}});
            } else {
                send_error(id, "bad_request", "unknown message type: " + type);
            }
        } catch (const std::exception & e) {
            send_error(id, "unknown", e.what());
        }
    }
    return 0;
}
