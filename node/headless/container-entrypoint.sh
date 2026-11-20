#!/bin/sh
set -eu
# Create files as their final owner. RunPod volume mounts can reject chown even
# when the intended unprivileged user is allowed to create private directories.
if [ "$(id -u)" != 10001 ]; then
  exec setpriv --reuid=10001 --regid=10001 --init-groups /usr/local/bin/node-container-entrypoint "$@"
fi
if [ "${1:-}" = "gpu-preflight" ] || [ "${1:-}" = "state-preflight" ]; then
  trap 'status=$?; printf "NODE_QUALIFICATION_EXIT=%s\n" "$status"' EXIT
  printf 'NODE_QUALIFICATION_STAGE=volume-bootstrap\n'
  stat -c 'volume_mode=%a volume_uid=%u volume_gid=%g' /data
  unset MERERUN_NODE_BOOTSTRAP_AUTH
  if [ "$1" = "state-preflight" ]; then
    exec /usr/local/bin/node-gpu-preflight --state-only
  fi
  exec /usr/local/bin/node-gpu-preflight
fi
umask 077
mkdir -p /home/node/.local/share/mere-run-node /data/cache
chmod 700 /home/node/.local/share/mere-run-node
# Fail closed on filesystems that silently ignore POSIX permission changes.
if [ "$(stat -c '%a:%u' /home/node/.local/share/mere-run-node)" != '700:10001' ]; then
  echo 'Node state requires owner-only POSIX permissions' >&2
  exit 1
fi
if [ -n "${MERERUN_NODE_BOOTSTRAP_AUTH:-}" ] && [ ! -s /home/node/.local/share/mere-run-node/auth.json ]; then
  temporary=/home/node/.local/share/mere-run-node/auth.bootstrap.$$
  trap 'rm -f "$temporary"' EXIT
  printf '%s' "$MERERUN_NODE_BOOTSTRAP_AUTH" > "$temporary"
  mv "$temporary" /home/node/.local/share/mere-run-node/auth.json
  trap - EXIT
fi
if [ -f /home/node/.local/share/mere-run-node/auth.json ]; then
  chmod 600 /home/node/.local/share/mere-run-node/auth.json
  if [ "$(stat -c '%a:%u' /home/node/.local/share/mere-run-node/auth.json)" != '600:10001' ]; then
    echo 'Node credentials require owner-only POSIX permissions' >&2
    exit 1
  fi
fi
unset MERERUN_NODE_BOOTSTRAP_AUTH
exec mere-run-node-headless "$@"
