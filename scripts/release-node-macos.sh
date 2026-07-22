#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

VERSION="$(node -p "require('./node/package.json').version")"
ARCH="aarch64"
BUCKET="${NODE_MACOS_R2_BUCKET:-}"
KEY="${NODE_MACOS_R2_KEY:-releases/mere-run-node/macos/mere.run-node-$VERSION-$ARCH-notarized.dmg}"
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

if [[ -z "$SIGNING_IDENTITY" ]]; then
  echo "A Developer ID signing identity is required." >&2
  echo "Set NODE_MACOS_SIGNING_IDENTITY (or APPLE_SIGNING_IDENTITY)." >&2
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

echo "Building Developer ID signed macOS node DMG..."
(cd node && APPLE_SIGNING_IDENTITY="$SIGNING_IDENTITY" ./node_modules/.bin/tauri build --bundles dmg)

if [[ ! -f "$DMG_PATH" ]]; then
  echo "Expected DMG not found: $DMG_PATH" >&2
  exit 1
fi

echo "Verifying Developer ID signature..."
codesign --verify --strict --verbose=2 "$DMG_PATH"

echo "Submitting DMG to Apple notarization..."
xcrun notarytool submit "$DMG_PATH" "${notary_auth_args[@]}" --wait
xcrun stapler staple "$DMG_PATH"
xcrun stapler validate "$DMG_PATH"
spctl --assess --type open --context context:primary-signature --verbose=4 "$DMG_PATH"

size="$(stat -f '%z' "$DMG_PATH")"
sha256="$(shasum -a 256 "$DMG_PATH" | awk '{print $1}')"

echo "Uploading to remote R2..."
echo "  bucket: $BUCKET"
echo "  key:    $KEY"
echo "  file:   $DMG_PATH"
"$WRANGLER_BIN" r2 object put "$BUCKET/$KEY" \
  --file "$DMG_PATH" \
  --content-type "$CONTENT_TYPE" \
  --remote

tmp_dmg="$(mktemp -t mere-run-node-r2-check.XXXXXX.dmg)"
tmp_headers="$(mktemp -t mere-run-node-release-headers.XXXXXX)"
tmp_manifest="$(mktemp -t mere-run-node-release-manifest.XXXXXX.json)"
tmp_remote_manifest="$(mktemp -t mere-run-node-release-manifest-check.XXXXXX.json)"
tmp_catalog="$(mktemp -t mere-run-node-release-catalog.XXXXXX.json)"
cleanup() {
  rm -f "$tmp_dmg" "$tmp_headers" "$tmp_manifest" "$tmp_remote_manifest" "$tmp_catalog"
}
trap cleanup EXIT

echo "Downloading back from remote R2..."
"$WRANGLER_BIN" r2 object get "$BUCKET/$KEY" --remote --file "$tmp_dmg"

if ! cmp -s "$DMG_PATH" "$tmp_dmg"; then
  echo "Remote R2 object differs from local DMG." >&2
  exit 1
fi

echo "Promoting the verified DMG as the latest macOS node release..."
node scripts/node-release-manifest.mjs write \
  "$tmp_manifest" "$VERSION" macos "$ARCH" "$KEY" "$FILENAME" "$CONTENT_TYPE" "$size" "$sha256" dmg
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

echo
echo "Released macOS node DMG"
echo "  local:        $DMG_PATH"
echo "  r2:           $BUCKET/$KEY"
echo "  manifest:     $BUCKET/$MANIFEST_KEY"
echo "  download:     $DOWNLOAD_URL"
echo "  bytes:        $size"
echo "  sha256:       $sha256"
