// 音声の読み込み（WAV、base64 の Float32 PCM）と簡単な信号処理。
#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace longhand {

constexpr int kSampleRate = 16000;

// base64 を復号する。不正な文字があれば false。
bool base64_decode(const std::string & in, std::vector<uint8_t> & out);

// base64 の Float32 LE PCM（16 kHz モノラル）を復号する。
bool decode_pcm_base64(const std::string & b64, std::vector<float> & out, std::string & err);

// WAV を読み、16 kHz モノラルの float に変換する（16/24/32bit PCM、32bit float、多チャンネルは平均、16 kHz 以外は線形補間）。
bool read_wav(const std::string & path, std::vector<float> & out, std::string & err);

// 振幅の指標（dBFS）。
float peak_dbfs(const float * x, size_t n);
float rms_dbfs(const float * x, size_t n);

}  // namespace longhand
