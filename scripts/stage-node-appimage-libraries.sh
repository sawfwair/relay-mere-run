#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAGING_DIR="$ROOT_DIR/node/src-tauri/.bundle-libs"

if [[ "$(uname -s)" != "Linux" ]]; then
  exit 0
fi

required_libraries=(
  libharfbuzz.so.0
  libGL.so.1
  libGLX.so.0
  libGLdispatch.so.0
)

resolve_library() {
  local soname="$1"
  local path

  path="$(
    ldconfig -p | awk -v soname="$soname" '
      $1 == soname && !found { path = $NF; found = 1 }
      END { if (found) print path }
    '
  )"
  if [[ -z "$path" || ! -f "$path" ]]; then
    echo "Required AppImage library is not installed: $soname" >&2
    exit 1
  fi

  printf '%s' "$path"
}

rm -rf "$STAGING_DIR"
mkdir -p "$STAGING_DIR"

for soname in "${required_libraries[@]}"; do
  source_path="$(resolve_library "$soname")"
  cp -L "$source_path" "$STAGING_DIR/$soname"
done

echo "Staged portable AppImage libraries in $STAGING_DIR"
