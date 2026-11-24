# Releasing

Longhand is distributed as a signed and notarized app on [GitHub Releases](https://github.com/ponyo877/longhand/releases).
macOS opens a downloaded app without warnings only when it is signed with a Developer ID certificate and notarized by Apple, so a release needs a membership in the [Apple Developer Program](https://developer.apple.com/programs/).

Pushing a version tag starts the [release workflow](../.github/workflows/release.yml).
It builds the native parts and the app, signs every executable, has Apple notarize the app and the disk image, and attaches them to a draft release.
A maintainer checks the draft and publishes it.

## What a release contains

| File | Contents |
|---|---|
| `Longhand-<version>-arm64.dmg` | Disk image with the app. Signed, notarized and stapled |
| `Longhand-darwin-arm64-<version>.zip` | The same app as a zip archive |
| `SHA256SUMS.txt` | SHA-256 checksums of the two files above |

The speech model is not included. The app downloads it on first launch, as in a source build.

## One-time setup

### 1. Certificate

In the Apple Developer account, create a **Developer ID Application** certificate (Certificates, Identifiers & Profiles > Certificates).
Install it in your login keychain, then export it with its private key from Keychain Access as a `.p12` file protected by a password.

### 2. Notarization key

In App Store Connect, create an API key with the **Developer** role (Users and Access > Integrations > App Store Connect API > Team Keys).
Download the `.p8` file (it can be downloaded only once) and note the key ID and the issuer ID.

### 3. Repository secrets

In the repository settings (Secrets and variables > Actions), add:

| Secret | Value |
|---|---|
| `MACOS_CERTIFICATE_P12` | The `.p12` file, base64-encoded: `base64 -i certificate.p12 \| pbcopy` |
| `MACOS_CERTIFICATE_PASSWORD` | The password of the `.p12` file |
| `APPLE_API_KEY_P8` | The `.p8` file, base64-encoded: `base64 -i AuthKey_XXXXXXXXXX.p8 \| pbcopy` |
| `APPLE_API_KEY_ID` | The key ID, for example `XXXXXXXXXX` |
| `APPLE_API_ISSUER` | The issuer ID (a UUID) |

The workflow stops with a list of the missing secrets if any is not set.
It imports the certificate into a temporary keychain and deletes the keychain and the key file when it finishes.

## Making a release

1. Update `version` in `package.json` (and `package-lock.json` with `npm install --package-lock-only`), and commit.
2. Tag the commit and push the tag:

   ```sh
   git tag v0.2.0
   git push origin v0.2.0
   ```

3. Wait for the **Release** workflow to finish. It fails if the tag does not match the version in `package.json`.
4. Open the draft release, download the disk image, and check it on a Mac (see below).
5. Edit the generated notes if needed, and publish the draft.

To rebuild a tag, run the workflow by hand (Actions > Release > Run workflow) and enter the tag.
Delete the old draft first.

## Building a release locally

`scripts/release.sh` runs the same steps on your Mac and writes the files to `out/release/`.
It needs the Developer ID certificate in your keychain and one set of notarization credentials in the environment:

```sh
# Store the credentials once in the keychain
xcrun notarytool store-credentials longhand --key AuthKey_XXXXXXXXXX.p8 --key-id XXXXXXXXXX --issuer <issuer-id>

APPLE_KEYCHAIN_PROFILE=longhand bash scripts/release.sh
```

| Credentials | Environment variables |
|---|---|
| Keychain profile | `APPLE_KEYCHAIN_PROFILE` |
| App Store Connect API key | `APPLE_API_KEY` (path to the `.p8` file), `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` |
| Apple ID | `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` |

`--skip-native` reuses `helper/build` and `asr/build` instead of rebuilding them.

The script sets `LONGHAND_RELEASE=1`.
With it, `forge.config.mts` refuses to build unless the app is signed with a Developer ID certificate and notarization credentials are present, so an unsigned or development-signed build cannot end up in a release.
Without it, `npm run make` signs with whatever certificate the keychain has and notarizes only when both a Developer ID certificate and credentials are available.

## How signing works

- `helper/build.sh` and `asr/build.sh` sign the native parts with a development certificate, so that macOS keeps permissions across rebuilds during development.
- When the app is packaged, `@electron/osx-sign` signs every executable in the bundle again with the chosen certificate, the hardened runtime and a secure timestamp.
  Electron's executables get `resources/entitlements.mac.plist` (JIT and microphone), the Swift helper gets `helper/Resources/LonghandHelper.entitlements` (microphone), and the speech recognition workers get no entitlements.
- `@electron/notarize` submits the app with `notarytool` and staples the ticket.
  `scripts/release.sh` then signs, notarizes and staples the disk image, and checks that every executable has the hardened runtime and a timestamp.

## Checking a build

On a Mac other than the build machine, or after downloading the file from the draft release:

```sh
spctl --assess --type open --context context:primary-signature -v Longhand-*.dmg   # accepted, source=Notarized Developer ID
xcrun stapler validate Longhand-*.dmg
```

Open the disk image, copy the app to Applications, and start it.
macOS should ask only for the microphone and accessibility permissions, with no warning about an unidentified developer.

If notarization fails, the log explains which file was rejected:

```sh
xcrun notarytool history --keychain-profile longhand
xcrun notarytool log <submission-id> --keychain-profile longhand
```
