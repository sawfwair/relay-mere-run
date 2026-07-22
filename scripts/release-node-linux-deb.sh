#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_LINUX_FORMAT=deb exec "$ROOT_DIR/scripts/release-node-linux.sh" "$@"
