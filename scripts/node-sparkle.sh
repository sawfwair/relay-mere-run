#!/usr/bin/env bash

# Helpers for release-node-macos.sh. The release archive is verified before any
# framework or tool from it can be used.
prepare_node_sparkle() {
  local destination="$1"
  local version='2.10.1'
  local checksum='1a856d2a9edb8e628de88121d7be04cf0e2167f8641650b78fca00b14244cf27'
  local archive="${NODE_MACOS_SPARKLE_ARCHIVE:-$destination/Sparkle.tar.xz}"
  if [[ -z "${NODE_MACOS_SPARKLE_ARCHIVE:-}" ]]; then
    curl --fail --location --silent --show-error --retry 3 \
      "https://github.com/sparkle-project/Sparkle/releases/download/$version/Sparkle-$version.tar.xz" \
      --output "$archive"
  fi
  printf '%s  %s\n' "$checksum" "$archive" | shasum -a 256 --check --status
  tar -xJf "$archive" -C "$destination" ./Sparkle.framework ./bin ./LICENSE
  codesign --verify --deep --strict "$destination/Sparkle.framework"
}

node_sparkle_public_key() {
  node --input-type=module - "$1" <<'JS'
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { readFileSync } from 'node:fs';

const encoded = readFileSync(process.argv[2], 'utf8').trim();
const seed = Buffer.from(encoded, 'base64');
if (seed.length !== 32 || seed.toString('base64') !== encoded) {
  throw new Error('Expected a base64-encoded 32-byte Sparkle Ed25519 seed');
}
// RFC 8410 PKCS#8 prefix for a raw Ed25519 seed.
const der = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]);
const privateKey = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
const publicKey = createPublicKey(privateKey).export({ format: 'jwk' });
console.log(Buffer.from(publicKey.x, 'base64url').toString('base64'));
JS
}

bundle_node_sparkle() {
  local app="$1" sparkle_dir="$2" identity="$3" public_key="$4" feed_url="$5"
  local plist="$app/Contents/Info.plist"
  local framework="$app/Contents/Frameworks/Sparkle.framework"
  local helpers="$framework/Versions/Current"
  local sign=(codesign --force --sign "$identity")
  if [[ "$identity" != '-' ]]; then
    sign+=(--options runtime --timestamp)
  fi

  ditto "$sparkle_dir/Sparkle.framework" "$framework"
  ditto "$sparkle_dir/LICENSE" "$app/Contents/Resources/Sparkle-LICENSE.txt"
  plutil -replace LSMinimumSystemVersion -string '12.0' "$plist"
  plutil -insert SUFeedURL -string "$feed_url" "$plist"
  plutil -insert SUPublicEDKey -string "$public_key" "$plist"
  plutil -insert SUEnableAutomaticChecks -bool YES "$plist"
  plutil -insert SUAutomaticallyUpdate -bool YES "$plist"
  plutil -insert SUVerifyUpdateBeforeExtraction -bool YES "$plist"
  plutil -insert SURequireSignedFeed -bool YES "$plist"
  plutil -insert SUSignedFeedFailureExpirationInterval -integer 0 "$plist"

  "${sign[@]}" "$helpers/Autoupdate"
  "${sign[@]}" "$helpers/Updater.app"
  "${sign[@]}" "$helpers/XPCServices/Installer.xpc"
  "${sign[@]}" --preserve-metadata=entitlements "$helpers/XPCServices/Downloader.xpc"
  "${sign[@]}" "$framework"
  "${sign[@]}" "$app"
  codesign --verify --deep --strict --verbose=2 "$app"
}

generate_node_appcast() {
  local archive="$1" sparkle_dir="$2" key_file="$3" url="$4" version="$5"
  local work_dir feed enclosure signature archive_size
  work_dir="$(dirname "$archive")"
  feed="$work_dir/appcast.xml"
  enclosure='(//*[local-name()="enclosure"])[1]'
  archive_size="$(stat -f '%z' "$archive")"

  "$sparkle_dir/bin/generate_appcast" --ed-key-file "$key_file" \
    --download-url-prefix "${url%/*}/" --link 'https://mere.run' \
    --maximum-deltas 0 --maximum-versions 3 -o "$feed" "$work_dir"
  "$sparkle_dir/bin/sign_update" --ed-key-file "$key_file" --verify "$feed"

  signature="$(xmllint --xpath "string($enclosure/@*[local-name()='edSignature'])" "$feed")"
  if [[ "$(xmllint --xpath "string($enclosure/@url)" "$feed")" != "$url" ||
        "$(xmllint --xpath "string($enclosure/@length)" "$feed")" != "$archive_size" ||
        "$(xmllint --xpath 'string((//*[local-name()="version"])[1])' "$feed")" != "$version" ||
        -z "$signature" ]]; then
    echo 'Sparkle appcast does not match the signed release.' >&2
    return 1
  fi
  "$sparkle_dir/bin/sign_update" --ed-key-file "$key_file" --verify "$archive" "$signature"
}
