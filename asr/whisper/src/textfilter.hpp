// whisper の出力から、言っていない文（ハルシネーション）と繰り返しのループを取り除く。
#pragma once

#include <string>
#include <vector>

namespace longhand {

std::u32string utf8_to_u32(const std::string & s);
std::string u32_to_utf8(const std::u32string & s);

// 照合用の正規化。NFKC 相当の簡易変換（全角英数→半角、英字は小文字）をし、空白と句読点・記号を除く。長音符「ー」は残す。
std::u32string normalize_for_match(const std::string & s);

struct SegmentEvidence {
    float no_speech_prob = 0.0f;  // whisper の no_speech 確率
    float avg_logprob = 0.0f;     // テキストトークンの対数確率の平均
    float speech_sec = 0.0f;      // VAD が発話と判定した長さ（全体）
};

// 区間を捨てるべきなら理由を返す（捨てないなら空文字列）。
std::string hallucination_reason(const std::string & text, const SegmentEvidence & ev, const std::u32string & prompt_norm);

// 同じ単位が連続で何度も出るループを 1 回に縮める（単位 1 文字は 10 回以上、2 文字以上は 6 回以上）。
std::string collapse_repeats(const std::string & text);

// 区間のテキストをつなぐ。境界の両側が英数字なら半角スペースを挟み、それ以外は詰める。
std::string join_segments(const std::vector<std::string> & parts);

// 前後の空白を除く。
std::string trim(const std::string & s);

}  // namespace longhand
