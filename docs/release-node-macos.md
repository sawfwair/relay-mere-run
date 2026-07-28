# Release the macOS node DMG

The macOS node app is a Tauri bundle under `node/`. The public download route is
served by the Worker at:

```text
https://relay.mere.run/downloads/mere-run-node/macos/latest
```

That route reads the latest DMG from the `IMAGES` R2 binding:

```text
bucket: <your-release-bucket>
key:    releases/mere-run-node/macos/mere.run-node-<version>-aarch64-notarized.dmg
latest: releases/mere-run-node/macos/latest.json
type:   application/x-apple-diskimage
```

Run the release from the repo root with a Developer ID Application identity and
notarytool credentials. A saved keychain profile is the simplest setup:

```sh
NODE_MACOS_SIGNING_IDENTITY='Developer ID Application: Example (TEAMID1234)' \
NODE_MACOS_NOTARY_PROFILE=mere-run-notary \
NODE_MACOS_R2_BUCKET='<your-release-bucket>' \
NODE_MACOS_DOWNLOAD_URL='https://relay.example.com/downloads/mere-run-node/macos/latest' \
NODE_RELEASE_CATALOG_URL='https://relay.example.com/.well-known/mere-run-node/releases.json' \
  ./scripts/release-node-macos.sh
```

App Store Connect API credentials are also supported through
`NODE_MACOS_NOTARY_KEY`, `NODE_MACOS_NOTARY_KEY_ID`, and
`NODE_MACOS_NOTARY_ISSUER`.

The script:

1. Builds and Developer ID signs the Tauri DMG.
2. Submits the DMG to Apple, staples the ticket, validates the ticket, and
   requires Gatekeeper acceptance.
3. Uploads the notarized DMG to remote R2 with `wrangler r2 object put --remote`.
4. Downloads the object back from remote R2 and byte-compares it with the local
   DMG.
5. Promotes that immutable object by updating `macos/latest.json` with its
   version, size, checksum, and publication time.
6. Sends `HEAD` to the public download route and checks status, content type,
   content length, version, and `X-Release-Key`.
7. Confirms the public Node release catalog advertises the same build. The
   `mere.run` downloads page reads this catalog live, so publishing does not
   require a site edit or redeploy.
8. Prints the final byte count and SHA-256 digest.

The app version and default object name are read from `node/package.json`; no
Worker or downloads-page edit is required for a normal version bump. The release
command also accepts overrides:

```sh
VERSION="$(node -p "require('./node/package.json').version")"
NODE_MACOS_R2_BUCKET='<your-release-bucket>' \
NODE_MACOS_R2_KEY="releases/mere-run-node/macos/mere.run-node-${VERSION}-aarch64-notarized.dmg" \
NODE_MACOS_DMG_PATH="node/src-tauri/target/release/bundle/dmg/mere.run node_${VERSION}_aarch64.dmg" \
./scripts/release-node-macos.sh
```

`pnpm run release:node:macos` is also available as a package-script alias when
the local pnpm install policy is already approved.

Public object keys are immutable release records. Bump the app version and key
for a new build instead of overwriting a previously verified object. Only the
small `latest.json` channel manifest is replaced during promotion.
