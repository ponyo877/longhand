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
| `LONGHAND_DEBUG_SELFTEST=e2e npm start` | Dictate end to end without a keyboard or microphone, then quit (see below) |
| `LONGHAND_DEBUG_CAPTURE=<dir> npm start` | Render every screen and notification to PNG files |

Please run `npm run typecheck`, `npm run lint` and `npm test` before opening a pull request.

### End-to-end self-test

`LONGHAND_DEBUG_SELFTEST=e2e npm start` checks the whole dictation path on a real Mac without anyone pressing keys or speaking.
It opens a small window with a text field, plays synthetic speech from macOS `say` into the recognizer, presses the hotkeys virtually, and checks what is pasted: hold to talk, hands-free, cancel, paste last, and, with `LONGHAND_SELFTEST_LLM=saved`, formatting and edit mode with your saved LLM connection.
It prints one line per scenario, writes a JSON report, and exits with code 0 when every scenario passed.

- No key event is posted to the system and the microphone is never opened, so other apps listening on the same key are not triggered. Matching a physical key to a shortcut is covered by the Swift tests, and `LONGHAND_DEBUG_SELFTEST=1` checks that the microphone delivers audio.
- It runs in a temporary profile in the system's temporary folder, so your settings, dictionary and history are not touched. The profile is left in place so you can read its logs. Speech models are read from your profile.
- It refuses to start while Longhand is running. Accessibility permission for the helper is required, as for normal use.
- The window takes focus for about half a minute. Every paste is pinned to the test window, so typing elsewhere can make the test fail but cannot put text into another app.

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

## Releases

Signed and notarized builds are published from version tags by the release workflow. [docs/releasing.md](docs/releasing.md) describes the one-time setup and the steps.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
