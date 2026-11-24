# Speech recognition workers

Each recognition engine is a single executable (a worker).
All workers speak the newline-delimited JSON protocol defined in [`src/shared/asr-protocol.ts`](../src/shared/asr-protocol.ts) over stdin and stdout.
The app starts a worker once, loads the model with `load`, and sends one `transcribe` request per recording.

| Worker | Engine | Role |
|---|---|---|
| `build/longhand-asr-whisper` | whisper.cpp v1.9.5 (Metal), large-v3-turbo q8_0, Silero VAD | Default. Most accurate |
| `build/longhand-asr-apple` | Apple SpeechAnalyzer / SpeechTranscriber (macOS 26) | Fast, no model to distribute |
| `build/longhand-asr-parakeet` | FluidAudio 0.18.4, Parakeet TDT 0.6B Japanese (Core ML) | Fast, least accurate of the three |

## Requirements

- Apple Silicon Mac
- Xcode with Swift 6, CMake 3.20 or later, git
- macOS 26 and Xcode 26 for `longhand-asr-apple` only

## Build

```sh
asr/build.sh            # longhand-asr-whisper and longhand-asr-apple
asr/build.sh --all      # also longhand-asr-parakeet
asr/build.sh whisper    # one target: whisper / whisper-coreml / apple / parakeet
```

Binaries are written to `asr/build/` (not tracked by git).
whisper.cpp is not vendored: `asr/whisper/fetch-deps.sh` fetches a pinned tag into `asr/whisper/third_party/`.

- **longhand-asr-whisper** links whisper.cpp statically. Metal shaders are embedded, and it is built with `GGML_NATIVE=OFF` so that it does not depend on the build machine's CPU.
- **longhand-asr-apple** is a thin Swift program. Recognition runs in a system service, and the OS manages the model.
- **longhand-asr-parakeet** is a Swift program built on FluidAudio.

`asr/build.sh` signs the binaries with an Apple Development certificate if one is in the keychain, and ad hoc otherwise.
Set `CODESIGN_IDENTITY` to use a different identity.

## Models

```sh
asr/download-models.sh              # Whisper large-v3-turbo q8_0 and Silero VAD (about 835 MB)
asr/download-models.sh --f16        # also the unquantized Whisper model (about 1.5 GB)
asr/download-models.sh --parakeet   # also the Parakeet Core ML model (about 620 MB)
```

Files are downloaded from Hugging Face at pinned revisions and verified by SHA-256.
Set `LONGHAND_HF_BASE` to use a mirror.
Models are stored in `~/Library/Application Support/Longhand/models/`.
Users of the app do not need this script: the app downloads the default model from its settings screen.

## Protocol

A worker prints `ready` when it starts. The app then sends `load`:

```json
{"type":"load","id":"1","payload":{"modelPath":"<path to ggml-large-v3-turbo-q8_0.bin>","language":"ja","options":{}}}
```

and one `transcribe` per recording:

```json
{"type":"transcribe","id":"2","payload":{"pcm":"<base64 Float32 LE, 16 kHz mono>","language":"ja","hints":["Slack","Electron"]}}
```

- `hints` carries dictionary terms. The whisper worker joins them into one sentence and uses it as the initial prompt.
- `prompt` carries preceding context. It is used when a long recording is transcribed in segments.
- The response contains the text, segments with timestamps, and per-token confidences.

The whisper worker looks for the VAD model next to the Whisper model.
With VAD in its default `trim` mode, leading and trailing silence is removed before decoding.

## Smoke test

```sh
node asr/tools/smoke.mjs --worker asr/build/longhand-asr-whisper --model <path> --hints "Slack,Electron" a.wav b.wav
node asr/tools/smoke.mjs --engine apple a.wav
```

The test also checks that silence yields an empty string, that a request without audio is rejected, and that the worker exits cleanly when stdin closes.
