# Third-party notices

Longhand is distributed under the [MIT License](LICENSE).
It includes or depends on the following third-party software and models, each under its own license.

## Bundled in the app

| Component | Used for | License |
|---|---|---|
| [whisper.cpp](https://github.com/ggml-org/whisper.cpp) (ggml) | Speech recognition runtime, linked into `longhand-asr-whisper` | MIT, Copyright (c) 2023-2026 The ggml authors |
| [Electron](https://github.com/electron/electron) | Application shell | MIT. Chromium and its components are covered by the `LICENSES.chromium.html` file that ships with Electron |
| [React](https://github.com/facebook/react), React DOM | User interface | MIT |
| [Anthropic TypeScript SDK](https://github.com/anthropics/anthropic-sdk-typescript) | LLM client for the Anthropic provider | Apache-2.0 |
| [Lindera](https://github.com/lindera/lindera) (`lindera-wasm-ipadic-web`) | Japanese tokenizer | MIT. Includes the IPADIC dictionary, distributed under the IPADIC license (Nara Institute of Science and Technology) |
| [FluidAudio](https://github.com/FluidInference/FluidAudio) | Runtime of the optional Parakeet worker, linked into `longhand-asr-parakeet` | Apache-2.0 |

## Models

Models are downloaded by the user, or bundled by `npm run bundle:models` together with a `NOTICE.txt` that names their sources.

| Model | Source | License |
|---|---|---|
| Whisper large-v3-turbo, converted to ggml and quantized | [ggerganov/whisper.cpp](https://huggingface.co/ggerganov/whisper.cpp) on Hugging Face. Original model by OpenAI | MIT |
| Silero VAD, converted to ggml | [ggml-org/whisper-vad](https://huggingface.co/ggml-org/whisper-vad). Original model by the Silero Team | MIT |
| Parakeet TDT 0.6B Japanese, Core ML (optional, not bundled) | [FluidInference/parakeet-0.6b-ja-coreml](https://huggingface.co/FluidInference/parakeet-0.6b-ja-coreml) | See the model card |

## Fonts and artwork

The wordmark in `assets/logo-*.svg` is set in STIX Two Text (SIL Open Font License 1.1) and converted to outlines.
The logo mark is original work and is covered by the Longhand license.

## Development dependencies

Build and test tools (Electron Forge, Vite, TypeScript, Vitest, oxlint, oxfmt, Tailwind CSS and others) are listed in `package.json` and are not shipped in the app, except for code that the bundler includes from the packages above.
Their license texts are available in each package under `node_modules/` after `npm install`.
