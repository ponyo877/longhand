# Contributing to Longhand

Thanks for your interest in Longhand. Bug reports, fixes and measurements are all welcome.

## Development setup

You need an Apple Silicon Mac with macOS 14 or later, Node.js 24, Xcode (Swift 6) and CMake.

```sh
npm install
npm run build:native   # Swift helper + speech recognition workers
npm start              # development mode
```

Useful commands:

| Command | What it does |
|---|---|
| `npm run typecheck` | TypeScript type check |
| `npm run lint` | oxlint and the oxfmt format check |
| `npm run lint:fix` | Apply lint fixes and formatting |
| `npm test` | Unit and integration tests (Vitest) |
| `cd helper && swift test` | Tests for the Swift helper |
| `LONGHAND_DEBUG_SELFTEST=1 npm start` | Start, check the helper, microphone, recognizer and tokenizer, then quit |
| `LONGHAND_DEBUG_CAPTURE=<dir> npm start` | Render every screen and notification to PNG files |

Please run `npm run typecheck`, `npm run lint` and `npm test` before opening a pull request.

## Repository layout

| Path | Contents |
|---|---|
| `src/main/` | Electron main process: dictation session, recognition client, text fixes, formatter, learning, settings |
| `src/renderer/` | React UI: the management window and the floating bar |
| `src/shared/` | Types and protocols shared between processes |
| `helper/` | Swift helper: hotkeys, audio capture, cursor context, paste |
| `asr/` | Speech recognition workers (whisper.cpp, Apple SpeechTranscriber, Parakeet) |
| `scripts/` | Evaluation and build scripts |
| `finetune/` | Experimental Whisper fine-tuning scripts |
| `assets/` | Logo and icon sources |

[docs/architecture.md](docs/architecture.md) explains how the pieces fit together.

## Changing recognition or formatting behavior

Accuracy changes are easy to get wrong, because a change that helps one kind of utterance often hurts another.
Changes to the recognizer, the text fixes, the prompts or the learning logic should come with a measurement from the evaluation harness described in [docs/evaluation.md](docs/evaluation.md).
A change is turned on by default only when it improves the development split beyond chance, does not hurt the holdout split, and does not hurt the public dataset.

## Privacy rules for contributions

- Never commit recordings or transcripts of real people, including your own. Evaluation data lives outside the repository.
- Never log transcript text, API keys or request headers.
- New code must not add network requests. The only allowed destinations are the LLM endpoint the user configured and the model download the user started.

## Commit messages

Write commit messages in English, following [Conventional Commits](https://www.conventionalcommits.org/):

```
fix(format): keep kanji numerals the user restored
```

Common types are `feat`, `fix`, `docs`, `test`, `refactor`, `chore` and `perf`. Use the scope to name the area (`asr`, `format`, `learn`, `helper`, `eval`, `ui`).
Explain why the change is needed in the body when it is not obvious from the subject.

## Code style

- TypeScript is formatted with oxfmt (200 columns) and linted with oxlint.
- Comments and UI strings in the app are written in Japanese, the language of its users. Documentation and commit messages are in English.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
