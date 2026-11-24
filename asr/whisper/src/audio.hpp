// Audio loading (WAV, base64 Float32 PCM) and simple signal processing.
#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace longhand {

constexpr int kSampleRate = 16000;

// Decodes base64. Returns false on an invalid character.
bool base64_decode(const std::string & in, std::vector<uint8_t> & out);

// Decodes base64 Float32 LE PCM (16 kHz mono).
bool decode_pcm_base64(const std::string & b64, std::vector<float> & out, std::string & err);

// Reads a WAV and converts it to 16 kHz mono float (16/24/32-bit PCM or 32-bit float; multiple channels are averaged; rates other than 16 kHz use linear interpolation).
bool read_wav(const std::string & path, std::vector<float> & out, std::string & err);

// Amplitude measures (dBFS).
float peak_dbfs(const float * x, size_t n);
float rms_dbfs(const float * x, size_t n);

}  // namespace longhand
