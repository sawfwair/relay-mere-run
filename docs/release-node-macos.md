# Release the macOS Node app

The macOS Node app ships as a Developer ID signed, notarized disk image for
Apple silicon with macOS 12 or later. The Relay Worker serves the installer and
Sparkle feed from its `IMAGES` R2 binding.

- [Latest macOS installer](https://relay.mere.run/downloads/mere-run-node/macos/latest)
- [Sparkle appcast](https://relay.mere.run/downloads/mere-run-node/macos/updates/appcast.xml)

Deploy the Relay Worker with the update routes before publishing the first
Sparkle release. Users install the first Sparkle-enabled build manually. After
that, Sparkle checks daily by default and installs downloaded updates when the
node is idle. **Help > Check for Updates…** runs a manual check.

## Release credentials

Use an Apple silicon Mac with a Developer ID Application identity, a saved
notarytool profile, and Wrangler access to the release bucket. Keep a dedicated
Node Ed25519 key separate from Studio's. To provision it once, use the pinned
Sparkle distribution's `bin/generate_keys --account com.mere.run.node` and export
it with `bin/generate_keys --account com.mere.run.node -x <private-key-file>`.
Store the file outside the repo with restricted permissions and a secure backup.
Pass the same key to every release so installed copies can verify updates.

```sh
NODE_MACOS_SIGNING_IDENTITY='Developer ID Application: Example (TEAMID1234)' \
NODE_MACOS_NOTARY_PROFILE=mere-run-notary \
NODE_MACOS_SPARKLE_ED_KEY_FILE='/secure/location/node-sparkle-ed25519-key' \
NODE_MACOS_R2_BUCKET='<your-release-bucket>' \
NODE_MACOS_DOWNLOAD_URL='https://relay.mere.run/downloads/mere-run-node/macos/latest' \
NODE_RELEASE_CATALOG_URL='https://relay.mere.run/.well-known/mere-run-node/releases.json' \
  ./scripts/release-node-macos.sh
```

Use `NODE_MACOS_NOTARY_KEY`, `NODE_MACOS_NOTARY_KEY_ID`, and
`NODE_MACOS_NOTARY_ISSUER` together to authenticate with an App Store Connect API
key. `NODE_MACOS_DMG_PATH` controls the local output path.
`NODE_MACOS_SPARKLE_ARCHIVE` can point to a predownloaded copy of the pinned
Sparkle archive. The script checks its SHA-256 before extracting it.

## What the release script publishes

Advance the version in `node/package.json`, `node/src-tauri/tauri.conf.json`,
`node/src-tauri/Cargo.toml`, and its lockfile for each release. Run releases one
at a time against a given bucket.

1. Verify the existing appcast against the signing key and check that the new
   version is higher.
2. Build the Tauri app, embed and sign Sparkle and its helpers, then notarize and
   staple the app and DMG.
3. Generate and verify a signed appcast for the final notarized DMG. The appcast
   references the immutable object at
   `releases/mere-run-node/macos/updates/<sha256>/mere.run-node-<version>-aarch64-notarized.dmg`.
4. Upload the DMG and verify the bytes from R2 and the public enclosure URL.
5. Update `releases/mere-run-node/macos/latest.json` and verify the installer
   route and public release catalog. The `mere.run` downloads page reads that
   catalog live.
6. Publish `releases/mere-run-node/macos/updates/appcast.xml` and verify the
   public feed matches the signed bytes.
