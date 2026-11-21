#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
source scripts/node-sparkle.sh

VERSION="$(node -p "require('./node/package.json').version")"
ARCH="aarch64"
BUCKET="${NODE_MACOS_R2_BUCKET:-}"
MANIFEST_KEY="${NODE_MACOS_MANIFEST_R2_KEY:-releases/mere-run-node/macos/latest.json}"
CONTENT_TYPE="${NODE_MACOS_CONTENT_TYPE:-application/x-apple-diskimage}"
DOWNLOAD_URL="${NODE_MACOS_DOWNLOAD_URL:-}"
CATALOG_URL="${NODE_RELEASE_CATALOG_URL:-}"
FILENAME="${NODE_MACOS_DOWNLOAD_FILENAME:-mere.run-node-$VERSION-$ARCH.dmg}"
DMG_PATH="${NODE_MACOS_DMG_PATH:-node/src-tauri/target/release/bundle/dmg/mere.run node_${VERSION}_${ARCH}.dmg}"
SIGNING_IDENTITY="${NODE_MACOS_SIGNING_IDENTITY:-${APPLE_SIGNING_IDENTITY:-}}"
NOTARY_PROFILE="${NODE_MACOS_NOTARY_PROFILE:-}"
NOTARY_KEY="${NODE_MACOS_NOTARY_KEY:-${APPLE_API_KEY_PATH:-}}"
NOTARY_KEY_ID="${NODE_MACOS_NOTARY_KEY_ID:-${APPLE_API_KEY:-}}"
NOTARY_ISSUER="${NODE_MACOS_NOTARY_ISSUER:-${APPLE_API_ISSUER:-}}"
SPARKLE_KEY_FILE="${NODE_MACOS_SPARKLE_ED_KEY_FILE:-}"
UPDATE_PREFIX='releases/mere-run-node/macos/updates'

TAURI_BIN="node/node_modules/.bin/tauri"
WRANGLER_BIN="node_modules/.bin/wrangler"

if [[ ! -x "$TAURI_BIN" ]]; then
  echo "Missing $TAURI_BIN. Run: pnpm --dir node install" >&2
  exit 1
fi

if [[ ! -x "$WRANGLER_BIN" ]]; then
  echo "Missing $WRANGLER_BIN. Run: pnpm install" >&2
  exit 1
fi

if [[ -z "$BUCKET" || -z "$DOWNLOAD_URL" || -z "$CATALOG_URL" ]]; then
  echo "NODE_MACOS_R2_BUCKET, NODE_MACOS_DOWNLOAD_URL, and NODE_RELEASE_CATALOG_URL are required." >&2
  exit 1
fi

if [[ -z "$SIGNING_IDENTITY" || "$SIGNING_IDENTITY" == '-' ]]; then
  echo "A Developer ID signing identity is required." >&2
  echo "Set NODE_MACOS_SIGNING_IDENTITY (or APPLE_SIGNING_IDENTITY)." >&2
  exit 1
fi

if [[ ! -r "$SPARKLE_KEY_FILE" ]]; then
  echo 'Set NODE_MACOS_SPARKLE_ED_KEY_FILE to the dedicated Node Sparkle signing key file.' >&2
  exit 1
fi

if [[ ! "$DOWNLOAD_URL" =~ ^https://[^/]+/downloads/mere-run-node/macos/latest$ ]]; then
  echo 'NODE_MACOS_DOWNLOAD_URL must be the HTTPS macOS Node latest route.' >&2
  exit 1
fi
UPDATE_BASE_URL="${DOWNLOAD_URL%/latest}/updates"
FEED_URL="$UPDATE_BASE_URL/appcast.xml"
ARCHIVE_NAME="mere.run-node-$VERSION-$ARCH-notarized.dmg"
if [[ "$(uname -m)" != 'arm64' || ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo 'macOS Node releases require Apple silicon and a three-part numeric version.' >&2
  exit 1
fi

notary_auth_args=()
if [[ -n "$NOTARY_PROFILE" ]]; then
  notary_auth_args+=(--keychain-profile "$NOTARY_PROFILE")
elif [[ -n "$NOTARY_KEY" && -n "$NOTARY_KEY_ID" && -n "$NOTARY_ISSUER" ]]; then
  if [[ ! -f "$NOTARY_KEY" ]]; then
    echo "Notary API key file not found: $NOTARY_KEY" >&2
    exit 1
  fi
  notary_auth_args+=(--key "$NOTARY_KEY" --key-id "$NOTARY_KEY_ID" --issuer "$NOTARY_ISSUER")
else
  echo "Apple notarization credentials are required." >&2
  echo "Set NODE_MACOS_NOTARY_PROFILE, or the NODE_MACOS_NOTARY_KEY, _KEY_ID, and _ISSUER trio." >&2
  exit 1
fi

work_dir="$(mktemp -d -t mere-run-node-release.XXXXXX)"
trap 'rm -rf "$work_dir"' EXIT
sparkle_dir="$work_dir/sparkle"
appcast_dir="$work_dir/appcast"
appcast="$appcast_dir/appcast.xml"
dmg_contents="$work_dir/dmg"
mkdir -p "$sparkle_dir" "$appcast_dir" "$dmg_contents"

echo 'Preparing Sparkle and checking the published feed...'
public_key="$(node_sparkle_public_key "$SPARKLE_KEY_FILE")"
prepare_node_sparkle "$sparkle_dir"
feed_status="$(curl -sS -o "$appcast" -w '%{http_code}' "$FEED_URL")"
case "$feed_status" in
  200)
    "$sparkle_dir/bin/sign_update" --ed-key-file "$SPARKLE_KEY_FILE" --verify "$appcast"
    published_version="$(xmllint --xpath 'string((//*[local-name()="version"])[1])' "$appcast")"
    if ! node -e 'process.exit(process.argv[1].localeCompare(process.argv[2], "en", { numeric: true }) > 0 ? 0 : 1)' \
      "$VERSION" "$published_version"; then
      echo "Release $VERSION must be newer than the published Sparkle version $published_version." >&2
      exit 1
    fi
    ;;
  404) rm -f "$appcast" ;;
  *)
    echo "Expected Sparkle feed or HTTP 404 at $FEED_URL, got $feed_status" >&2
    exit 1
    ;;
esac

echo 'Building the macOS Node app...'
(cd node && ./node_modules/.bin/tauri build --bundles app --no-sign)
app="$dmg_contents/mere.run node.app"
ditto 'node/src-tauri/target/release/bundle/macos/mere.run node.app' "$app"
bundle_node_sparkle "$app" "$sparkle_dir" "$SIGNING_IDENTITY" "$public_key" "$FEED_URL"

echo 'Notarizing the app for updates installed outside the disk image...'
ditto -c -k --keepParent "$app" "$work_dir/app.zip"
xcrun notarytool submit "$work_dir/app.zip" "${notary_auth_args[@]}" --wait
xcrun stapler staple "$app"
xcrun stapler validate "$app"
spctl --assess --type execute --verbose=4 "$app"

echo 'Building the Developer ID signed macOS Node DMG...'
ln -s /Applications "$dmg_contents/Applications"
mkdir -p "$(dirname "$DMG_PATH")"
hdiutil create -ov -volname 'mere.run node' -srcfolder "$dmg_contents" -format UDZO "$DMG_PATH"
codesign --force --timestamp --sign "$SIGNING_IDENTITY" "$DMG_PATH"
codesign --verify --strict --verbose=2 "$DMG_PATH"

echo "Submitting DMG to Apple notarization..."
xcrun notarytool submit "$DMG_PATH" "${notary_auth_args[@]}" --wait
xcrun stapler staple "$DMG_PATH"
xcrun stapler validate "$DMG_PATH"
spctl --assess --type open --context context:primary-signature --verbose=4 "$DMG_PATH"

size="$(stat -f '%z' "$DMG_PATH")"
sha256="$(shasum -a 256 "$DMG_PATH" | awk '{print $1}')"
KEY="$UPDATE_PREFIX/$sha256/$ARCHIVE_NAME"
update_url="$UPDATE_BASE_URL/$sha256/$ARCHIVE_NAME"
ditto "$DMG_PATH" "$appcast_dir/$ARCHIVE_NAME"
generate_node_appcast "$appcast_dir/$ARCHIVE_NAME" "$sparkle_dir" "$SPARKLE_KEY_FILE" "$update_url" "$VERSION"
tmp_manifest="$work_dir/latest.json"
node scripts/node-release-manifest.mjs write \
  "$tmp_manifest" "$VERSION" macos "$ARCH" "$KEY" "$FILENAME" "$CONTENT_TYPE" "$size" "$sha256" dmg

echo "Uploading to remote R2..."
echo "  bucket: $BUCKET"
echo "  key:    $KEY"
echo "  file:   $DMG_PATH"
"$WRANGLER_BIN" r2 object put "$BUCKET/$KEY" \
  --file "$DMG_PATH" \
  --content-type "$CONTENT_TYPE" \
  --remote

tmp_dmg="$work_dir/remote.dmg"
tmp_headers="$work_dir/headers"
tmp_remote_manifest="$work_dir/remote-latest.json"
tmp_catalog="$work_dir/catalog.json"

echo "Downloading back from remote R2..."
"$WRANGLER_BIN" r2 object get "$BUCKET/$KEY" --remote --file "$tmp_dmg"

if ! cmp -s "$DMG_PATH" "$tmp_dmg"; then
  echo "Remote R2 object differs from local DMG." >&2
  exit 1
fi

echo 'Verifying the public Sparkle enclosure before promotion...'
public_sha256="$(curl -fsS "$update_url" | shasum -a 256 | awk '{print $1}')"
if [[ "$public_sha256" != "$sha256" ]]; then
  echo "Public Sparkle enclosure differs from the signed DMG at $update_url" >&2
  exit 1
fi

echo "Promoting the verified DMG as the latest macOS node release..."
"$WRANGLER_BIN" r2 object put "$BUCKET/$MANIFEST_KEY" \
  --file "$tmp_manifest" \
  --content-type "application/json" \
  --remote
"$WRANGLER_BIN" r2 object get "$BUCKET/$MANIFEST_KEY" --remote --file "$tmp_remote_manifest"
if ! cmp -s "$tmp_manifest" "$tmp_remote_manifest"; then
  echo "Remote latest-release manifest differs from the local manifest." >&2
  exit 1
fi

echo "Checking public download route..."
CHECK_URL="$DOWNLOAD_URL?release=$VERSION&sha=${sha256:0:12}"
http_code="$(curl -sS -I -o "$tmp_headers" -w '%{http_code}' "$CHECK_URL")"
if [[ "$http_code" != "200" ]]; then
  echo "Expected $DOWNLOAD_URL to return 200, got $http_code" >&2
  cat "$tmp_headers" >&2
  exit 1
fi

route_key="$(awk 'tolower($1) == "x-release-key:" {print $2}' "$tmp_headers" | tr -d '\r' | tail -n 1)"
if [[ "$route_key" != "$KEY" ]]; then
  echo "Expected X-Release-Key $KEY, got ${route_key:-<missing>}" >&2
  cat "$tmp_headers" >&2
  exit 1
fi

route_version="$(awk 'tolower($1) == "x-release-version:" {print $2}' "$tmp_headers" | tr -d '\r' | tail -n 1)"
if [[ "$route_version" != "$VERSION" ]]; then
  echo "Expected X-Release-Version $VERSION, got ${route_version:-<missing>}" >&2
  cat "$tmp_headers" >&2
  exit 1
fi

route_format="$(awk 'tolower($1) == "x-release-format:" {print $2}' "$tmp_headers" | tr -d '\r' | tail -n 1)"
if [[ "$route_format" != "dmg" ]]; then
  echo "Expected X-Release-Format dmg, got ${route_format:-<missing>}" >&2
  cat "$tmp_headers" >&2
  exit 1
fi

route_type="$(awk 'tolower($1) == "content-type:" {print $2}' "$tmp_headers" | tr -d '\r' | tail -n 1)"
if [[ "$route_type" != "$CONTENT_TYPE" ]]; then
  echo "Expected Content-Type $CONTENT_TYPE, got ${route_type:-<missing>}" >&2
  cat "$tmp_headers" >&2
  exit 1
fi

route_size="$(awk 'tolower($1) == "content-length:" {print $2}' "$tmp_headers" | tr -d '\r' | tail -n 1)"
if [[ "$route_size" != "$size" ]]; then
  echo "Expected Content-Length $size, got ${route_size:-<missing>}" >&2
  cat "$tmp_headers" >&2
  exit 1
fi

echo "Checking public node release catalog..."
curl -fsSL "$CATALOG_URL" -o "$tmp_catalog"
node scripts/node-release-manifest.mjs verify-catalog \
  "$tmp_catalog" "$VERSION" macos "$ARCH" "$KEY" dmg

echo 'Publishing the signed Sparkle feed...'
"$WRANGLER_BIN" r2 object put "$BUCKET/$UPDATE_PREFIX/appcast.xml" \
  --file "$appcast" \
  --content-type 'application/rss+xml; charset=utf-8' \
  --cache-control 'no-store' \
  --remote
curl -fsS "$FEED_URL" -o "$work_dir/public-appcast.xml"
if ! cmp -s "$appcast" "$work_dir/public-appcast.xml"; then
  echo "Public Sparkle feed differs from the signed appcast at $FEED_URL" >&2
  exit 1
fi

echo
echo "Released macOS node DMG"
echo "  local:        $DMG_PATH"
echo "  r2:           $BUCKET/$KEY"
echo "  manifest:     $BUCKET/$MANIFEST_KEY"
echo "  download:     $DOWNLOAD_URL"
echo "  Sparkle feed: $FEED_URL"
echo "  bytes:        $size"
echo "  sha256:       $sha256"
