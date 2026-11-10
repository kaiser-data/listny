# Releasing Listny

## Cut a release

1. Update `version` in `package.json`, run `npm install --package-lock-only`, and add a section to `CHANGELOG.md`.
2. Run `npm run check`.
3. Commit, then tag and push:

   ```bash
   git tag v0.2.0
   git push origin main v0.2.0
   ```

4. The **Release** workflow builds `Listny-<version>-arm64.dmg`, `Listny-<version>-x64.dmg`, the matching zips and `SHA256SUMS.txt`, and attaches them to a GitHub release with generated notes. It fails if the tag and the `package.json` version differ.

To build the same files locally: `npm run dist:release`.

## Homebrew

`packaging/homebrew/listny.rb` is a cask template. To offer `brew install --cask kaiser-data/tap/listny`:

1. Create the repository `kaiser-data/homebrew-tap` and copy the file to `Casks/listny.rb`.
2. After each release, set `version` and the two `sha256` values from `SHA256SUMS.txt`.

The cask removes the quarantine attribute after install because the app is not notarized. Homebrew's own cask repository no longer accepts apps that fail Gatekeeper, so a tap is the only route until Listny is notarized.

## Signing and notarization

Release builds are signed ad hoc by `build/sign.cjs`. That has two costs for users: macOS blocks the first start until the quarantine attribute is removed, and Microphone and Accessibility permissions may be asked for again after an update.

Both go away with an Apple Developer ID certificate (Apple Developer Program, paid yearly) and notarization. That needs:

- the Developer ID Application certificate available to the build (locally in the keychain, in CI as a secret),
- `LISTNY_SIGN_IDENTITY` set to its name, plus the hardened runtime and microphone entitlement in the signing step,
- a notarization step (`xcrun notarytool submit … --wait`, then `xcrun stapler staple`) before the DMG is uploaded.

None of this is set up yet.
