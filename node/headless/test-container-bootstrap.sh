#!/bin/bash
set -euo pipefail
image=${1:?Pass the built qualification image tag}
fixture=$(mktemp -d)
trap 'rm -f "$fixture/preflight.sh" "$fixture/daemon.sh" "$fixture/chmod"; rmdir "$fixture"' EXIT
cat > "$fixture/preflight.sh" <<'SCRIPT'
#!/bin/sh
set -eu
test "$(id -u)" = 10001
mkdir -p /data/cache/qualification
test -w /data/cache/qualification
test ! -e /data/state
printf 'Unprivileged GPU-only bootstrap passed without ownership mutation\n'
SCRIPT
cat > "$fixture/daemon.sh" <<'SCRIPT'
#!/bin/sh
set -eu
test "$(id -u)" = 10001
test "$(stat -c '%a:%u' /home/node/.local/share/mere-run-node)" = '700:10001'
test "$(stat -c '%a:%u' /home/node/.local/share/mere-run-node/auth.json)" = '600:10001'
test "$(cat /home/node/.local/share/mere-run-node/auth.json)" = 'fixture-token-set'
test -z "${MERERUN_NODE_BOOTSTRAP_AUTH:-}"
printf 'Private state created as final owner without CHOWN capability\n'
SCRIPT
printf '#!/bin/sh\nexit 0\n' > "$fixture/chmod"
chmod 755 "$fixture/preflight.sh" "$fixture/daemon.sh" "$fixture/chmod"
common=(--rm --platform linux/amd64 --cap-drop CHOWN --tmpfs /data:mode=0777
  -v "$PWD/node/headless/container-entrypoint.sh:/usr/local/bin/node-container-entrypoint:ro")
docker run "${common[@]}" -v "$fixture/preflight.sh:/usr/local/bin/node-gpu-preflight:ro" "$image" gpu-preflight
docker run "${common[@]}" -e MERERUN_NODE_BOOTSTRAP_AUTH=fixture-token-set \
  -v "$fixture/daemon.sh:/usr/local/bin/mere-run-node-headless:ro" "$image" run --state-dir /home/node/.local/share/mere-run-node
# A filesystem ignoring chmod must not receive account credentials.
if docker run "${common[@]}" -v "$fixture/chmod:/usr/local/bin/chmod:ro" \
  -e MERERUN_NODE_BOOTSTRAP_AUTH=fixture-token-set --entrypoint /bin/sh "$image" \
  -c 'mkdir -p /home/node/.local/share; mkdir -m777 /home/node/.local/share/mere-run-node; exec /usr/local/bin/node-container-entrypoint run --state-dir /home/node/.local/share/mere-run-node'; then
  echo 'Unsafe private-state bootstrap unexpectedly succeeded' >&2
  exit 1
fi
