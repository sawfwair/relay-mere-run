#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "Usage: $0 PATH_TO_DEB x86_64|arm64" >&2
  exit 2
fi

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "Debian package verification must run on Linux." >&2
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
artifact="$1"
release_arch="$2"

if [[ ! -f "$artifact" ]]; then
  echo "Debian package not found: $artifact" >&2
  exit 1
fi

case "$release_arch" in
  x86_64) expected_package_arch="amd64" ;;
  arm64) expected_package_arch="arm64" ;;
  *)
    echo "Unsupported release architecture: $release_arch" >&2
    exit 1
    ;;
esac

artifact="$(cd "$(dirname "$artifact")" && pwd)/$(basename "$artifact")"
expected_version="$(cd "$ROOT_DIR" && node -p "require('./node/package.json').version")"
package="$(dpkg-deb --field "$artifact" Package)"
version="$(dpkg-deb --field "$artifact" Version)"
package_arch="$(dpkg-deb --field "$artifact" Architecture)"
depends="$(dpkg-deb --field "$artifact" Depends)"

if [[ "$package" != "mere-run-node" ]]; then
  echo "Expected Debian package name mere-run-node, got $package" >&2
  exit 1
fi
if [[ "$version" != "$expected_version" ]]; then
  echo "Expected Debian package version $expected_version, got $version" >&2
  exit 1
fi
if [[ "$package_arch" != "$expected_package_arch" ]]; then
  echo "Expected Debian architecture $expected_package_arch, got $package_arch" >&2
  exit 1
fi

dependency_names="$(
  printf '%s\n' "$depends" \
    | tr ',' '\n' \
    | sed -E 's/^[[:space:]]+//; s/[[:space:]]*\(.*$//'
)"
required_dependencies=(
  libwebkit2gtk-4.1-0
  libgtk-3-0
  libharfbuzz0b
  libgl1
  libglx0
  libglvnd0
)
for dependency in "${required_dependencies[@]}"; do
  if ! grep -Fxq "$dependency" <<<"$dependency_names"; then
    echo "Debian package is missing required dependency: $dependency" >&2
    exit 1
  fi
done

work_dir="$(mktemp -d -t mere-run-node-deb-check.XXXXXX)"
cleanup() {
  rm -rf "$work_dir"
}
trap cleanup EXIT
dpkg-deb --extract "$artifact" "$work_dir"

if [[ ! -x "$work_dir/usr/bin/mere.run-node" ]]; then
  echo "Debian package does not contain executable usr/bin/mere.run-node" >&2
  exit 1
fi
if [[ ! -x "$work_dir/usr/bin/mere-run-node" ]]; then
  echo "Debian package does not contain compatibility executable usr/bin/mere-run-node" >&2
  exit 1
fi
if ! grep -Fqx 'exec /usr/bin/mere.run-node "$@"' "$work_dir/usr/bin/mere-run-node"; then
  echo "Debian compatibility executable does not forward to mere.run-node" >&2
  exit 1
fi
if [[ ! -f "$work_dir/usr/share/applications/mere.run node.desktop" ]]; then
  echo "Debian package does not contain its desktop entry" >&2
  exit 1
fi

echo "Verified Debian package metadata and payload: $artifact"
