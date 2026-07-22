#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "Linux node releases must be built on Linux, ideally on the target architecture." >&2
  echo "Use an x86_64 Linux host for x86_64 and an arm64/aarch64 Linux host for DGX Spark/Blackwell-class ARM targets." >&2
  exit 1
fi

detect_arch() {
  case "$(uname -m)" in
    x86_64 | amd64) printf 'x86_64' ;;
    aarch64 | arm64) printf 'arm64' ;;
    *)
      echo "Unsupported Linux architecture: $(uname -m)" >&2
      exit 1
      ;;
  esac
}

ARCH="${NODE_LINUX_ARCH:-$(detect_arch)}"
case "$ARCH" in
  x86_64 | arm64) ;;
  aarch64) ARCH="arm64" ;;
  *)
    echo "Unsupported NODE_LINUX_ARCH: $ARCH. Use x86_64 or arm64." >&2
    exit 1
    ;;
esac

VERSION="$(node -p "require('./node/package.json').version")"
FORMAT="${NODE_LINUX_FORMAT:-appimage}"
BUCKET="${NODE_LINUX_R2_BUCKET:-}"
CATALOG_URL="${NODE_RELEASE_CATALOG_URL:-}"
WRANGLER_BIN="node_modules/.bin/wrangler"
TAURI_BIN="node/node_modules/.bin/tauri"

case "$FORMAT" in
  appimage)
    BUNDLE_TARGET="appimage"
    BUNDLE_PATH="appimage"
    ARTIFACT_PATTERN="*.AppImage"
    ARTIFACT_LABEL="AppImage"
    DEFAULT_KEY="releases/mere-run-node/linux/$ARCH/mere.run-node-$VERSION-$ARCH.AppImage"
    DEFAULT_MANIFEST_KEY="releases/mere-run-node/linux/$ARCH/latest.json"
    DEFAULT_CONTENT_TYPE="application/octet-stream"
    DEFAULT_FILENAME="mere.run-node-$VERSION-$ARCH.AppImage"
    ;;
  deb)
    BUNDLE_TARGET="deb"
    BUNDLE_PATH="deb"
    ARTIFACT_PATTERN="*.deb"
    ARTIFACT_LABEL="Debian package"
    if [[ "$ARCH" == "x86_64" ]]; then
      package_arch="amd64"
    else
      package_arch="arm64"
    fi
    DEFAULT_KEY="releases/mere-run-node/linux/$ARCH/deb/mere.run-node-$VERSION-$package_arch.deb"
    DEFAULT_MANIFEST_KEY="releases/mere-run-node/linux/$ARCH/deb/latest.json"
    DEFAULT_CONTENT_TYPE="application/vnd.debian.binary-package"
    DEFAULT_FILENAME="mere.run-node-$VERSION-$package_arch.deb"
    ;;
  *)
    echo "Unsupported NODE_LINUX_FORMAT: $FORMAT. Use appimage or deb." >&2
    exit 1
    ;;
esac

KEY="${NODE_LINUX_R2_KEY:-$DEFAULT_KEY}"
MANIFEST_KEY="${NODE_LINUX_MANIFEST_R2_KEY:-$DEFAULT_MANIFEST_KEY}"
CONTENT_TYPE="${NODE_LINUX_CONTENT_TYPE:-$DEFAULT_CONTENT_TYPE}"
DOWNLOAD_URL="${NODE_LINUX_DOWNLOAD_URL:-}"
FILENAME="${NODE_LINUX_DOWNLOAD_FILENAME:-$DEFAULT_FILENAME}"

if [[ ! -x "$TAURI_BIN" ]]; then
  echo "Missing $TAURI_BIN. Run: pnpm --dir node install" >&2
  exit 1
fi

if [[ ! -x "$WRANGLER_BIN" ]]; then
  echo "Missing $WRANGLER_BIN. Run: pnpm install" >&2
  exit 1
fi

if [[ -z "$BUCKET" || -z "$DOWNLOAD_URL" || -z "$CATALOG_URL" ]]; then
  echo "NODE_LINUX_R2_BUCKET, NODE_LINUX_DOWNLOAD_URL, and NODE_RELEASE_CATALOG_URL are required." >&2
  exit 1
fi

build_args=(build --bundles "$BUNDLE_TARGET")
if [[ -n "${NODE_LINUX_TAURI_TARGET:-}" ]]; then
  build_args+=(--target "$NODE_LINUX_TAURI_TARGET")
fi

echo "Building Linux $ARCH node $ARTIFACT_LABEL..."
(cd node && ./node_modules/.bin/tauri "${build_args[@]}")

if [[ -n "${NODE_LINUX_ARTIFACT_PATH:-}" ]]; then
  artifact="$NODE_LINUX_ARTIFACT_PATH"
else
  artifact="$(
    find node/src-tauri/target -path "*/release/bundle/$BUNDLE_PATH/$ARTIFACT_PATTERN" -type f -printf '%T@ %p\n' 2>/dev/null \
      | sort -nr \
      | sed -n '1s/^[^ ]* //p'
  )"
fi

if [[ -z "$artifact" || ! -f "$artifact" ]]; then
  echo "Expected $ARTIFACT_LABEL not found. Set NODE_LINUX_ARTIFACT_PATH to override." >&2
  exit 1
fi

if [[ "$FORMAT" == "appimage" ]]; then
  ./scripts/verify-node-appimage.sh "$artifact"
else
  ./scripts/verify-node-deb.sh "$artifact" "$ARCH"
fi

size="$(stat -c '%s' "$artifact")"
sha256="$(sha256sum "$artifact" | awk '{print $1}')"

echo "Uploading to remote R2..."
echo "  bucket: $BUCKET"
echo "  key:    $KEY"
echo "  file:   $artifact"
"$WRANGLER_BIN" r2 object put "$BUCKET/$KEY" \
  --file "$artifact" \
  --content-type "$CONTENT_TYPE" \
  --remote

tmp_artifact="$(mktemp -t mere-run-node-linux-r2-check.XXXXXX)"
tmp_headers="$(mktemp -t mere-run-node-linux-release-headers.XXXXXX)"
tmp_manifest="$(mktemp -t mere-run-node-linux-release-manifest.XXXXXX.json)"
tmp_remote_manifest="$(mktemp -t mere-run-node-linux-release-manifest-check.XXXXXX.json)"
tmp_catalog="$(mktemp -t mere-run-node-linux-release-catalog.XXXXXX.json)"
cleanup() {
  rm -f "$tmp_artifact" "$tmp_headers" "$tmp_manifest" "$tmp_remote_manifest" "$tmp_catalog"
}
trap cleanup EXIT

echo "Downloading back from remote R2..."
"$WRANGLER_BIN" r2 object get "$BUCKET/$KEY" --remote --file "$tmp_artifact"

if ! cmp -s "$artifact" "$tmp_artifact"; then
  echo "Remote R2 object differs from local $ARTIFACT_LABEL." >&2
  exit 1
fi

echo "Promoting the verified $ARTIFACT_LABEL as the latest Linux $ARCH node release..."
node scripts/node-release-manifest.mjs write \
  "$tmp_manifest" "$VERSION" linux "$ARCH" "$KEY" "$FILENAME" "$CONTENT_TYPE" "$size" "$sha256" "$FORMAT"
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

route_arch="$(awk 'tolower($1) == "x-release-arch:" {print $2}' "$tmp_headers" | tr -d '\r' | tail -n 1)"
if [[ "$route_arch" != "$ARCH" ]]; then
  echo "Expected X-Release-Arch $ARCH, got ${route_arch:-<missing>}" >&2
  cat "$tmp_headers" >&2
  exit 1
fi

route_format="$(awk 'tolower($1) == "x-release-format:" {print $2}' "$tmp_headers" | tr -d '\r' | tail -n 1)"
if [[ "$route_format" != "$FORMAT" ]]; then
  echo "Expected X-Release-Format $FORMAT, got ${route_format:-<missing>}" >&2
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
  "$tmp_catalog" "$VERSION" linux "$ARCH" "$KEY" "$FORMAT"

echo
echo "Released Linux $ARCH node $ARTIFACT_LABEL"
echo "  local:        $artifact"
echo "  r2:           $BUCKET/$KEY"
echo "  manifest:     $BUCKET/$MANIFEST_KEY"
echo "  download:     $DOWNLOAD_URL"
echo "  bytes:        $size"
echo "  sha256:       $sha256"
