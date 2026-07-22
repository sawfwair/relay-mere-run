#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 PATH_TO_APPIMAGE" >&2
  exit 2
fi

artifact="$1"
if [[ ! -f "$artifact" ]]; then
  echo "AppImage not found: $artifact" >&2
  exit 1
fi

artifact="$(cd "$(dirname "$artifact")" && pwd)/$(basename "$artifact")"
work_dir="$(mktemp -d -t mere-run-node-appimage-check.XXXXXX)"
cleanup() {
  rm -rf "$work_dir"
}
trap cleanup EXIT

(
  cd "$work_dir"
  "$artifact" --appimage-extract >/dev/null
)

app_dir="$work_dir/squashfs-root"
binary="$app_dir/usr/bin/mere.run-node"
if [[ ! -x "$binary" ]]; then
  echo "AppImage does not contain the expected executable: usr/bin/mere.run-node" >&2
  exit 1
fi

required_libraries=(
  libharfbuzz.so.0
  libGL.so.1
  libGLX.so.0
  libGLdispatch.so.0
)

for soname in "${required_libraries[@]}"; do
  if [[ ! -f "$app_dir/usr/lib/$soname" ]]; then
    echo "AppImage is missing required bundled library: $soname" >&2
    exit 1
  fi
done

unresolved="$(ldd "$binary" | awk '$2 == "=>" && $3 == "not" && $4 == "found" { print $1 }')"
if [[ -n "$unresolved" ]]; then
  echo "AppImage executable has unresolved libraries:" >&2
  while IFS= read -r soname; do
    printf '  %s\n' "$soname" >&2
  done <<<"$unresolved"
  exit 1
fi

echo "Verified portable AppImage dependencies: $artifact"
