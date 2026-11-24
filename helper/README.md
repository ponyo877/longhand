# LonghandHelper

LonghandHelper is the part of Longhand that talks to macOS.
It is a small Swift app without a window, started by the Electron main process, and it communicates over stdin and stdout with newline-delimited JSON (see [`src/shared/protocol.ts`](../src/shared/protocol.ts)).

It is a separate signed bundle so that the microphone and accessibility permissions stay attached to it across rebuilds of the main app.

## What it does

| Area | Details |
|---|---|
| Hotkeys | A session-level event tap recognizes hold, double-tap and chord shortcuts, including `fn` alone. It can suppress the system action of the globe key while a shortcut uses it |
| Recording | Captures the selected input device, converts to 16 kHz mono Float32 and streams chunks |
| Context | Reads the focused app, the browser domain, and the text before and after the cursor through the Accessibility API. Secure text fields are never read |
| Paste | Puts the text on the pasteboard, posts `⌘V`, verifies that the text landed, and restores the previous pasteboard contents |
| Watching edits | After a paste, reports how the user changed the inserted text, so the app can learn from corrections |

## Layout

| Path | Contents |
|---|---|
| `Sources/LonghandCore/` | Pure logic with unit tests: hotkey matching, shortcut recording, paste tokens, audio chunking, text slicing |
| `Sources/LonghandHelper/` | macOS integration: event tap, audio capture, accessibility, paste |
| `Tests/LonghandCoreTests/` | Tests for `LonghandCore` |
| `Resources/` | `Info.plist` and entitlements |
| `tools/harness.mjs` | A small driver for exercising the helper by hand |

## Build and test

```sh
./build.sh      # release build, assembles build/LonghandHelper.app and signs it
swift test      # unit tests
```

The bundle is signed with an Apple Development certificate if one is in the keychain, and ad hoc otherwise.
Set `LONGHAND_SIGN_IDENTITY` to choose an identity.
Signing with the same certificate keeps the permissions granted in System Settings valid across rebuilds.

## Permissions

- **Microphone**, for recording.
- **Accessibility**, for the event tap, reading the text field and pasting.

## Known limitations

- If another app installs an event tap in front of the helper, that app sees key events first. The helper moves its tap back to the front up to three times, then reports `rival_in_front` and stops competing.
- Some Chromium versions do not report the selection range of `contenteditable` elements correctly, so the text around the cursor may be unavailable there.
