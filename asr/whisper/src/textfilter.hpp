// Removes sentences that were never said (hallucinations) and repetition loops from whisper's output.
#pragma once

#include <string>
#include <vector>

namespace longhand {

std::u32string utf8_to_u32(const std::string & s);
std::string u32_to_utf8(const std::u32string & s);

// Normalization for matching. A simple NFKC-like conversion (full-width alphanumerics to half-width, Latin letters to lowercase),
// then removes spaces, punctuation and symbols. Keeps the long vowel mark 「ー」.
std::u32string normalize_for_match(const std::string & s);

struct SegmentEvidence {
    float no_speech_prob = 0.0f;  // whisper's no_speech probability
    float avg_logprob = 0.0f;     // Mean log probability of the text tokens
    float speech_sec = 0.0f;      // Total length VAD judged to be speech
};

// Returns the reason if the segment should be dropped (empty string to keep it).
std::string hallucination_reason(const std::string & text, const SegmentEvidence & ev, const std::u32string & prompt_norm);

// Collapses a loop where the same unit repeats many times in a row into one (10 or more times for a 1-character unit, 6 or more for 2 or more characters).
std::string collapse_repeats(const std::string & text);

// Joins the segment texts. Inserts a space if both sides of the boundary are alphanumeric; otherwise joins them directly.
std::string join_segments(const std::vector<std::string> & parts);

// Removes leading and trailing whitespace.
std::string trim(const std::string & s);

}  // namespace longhand
