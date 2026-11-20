#!/bin/bash
set -euo pipefail
# Explicit qualification mode; the normal entrypoint still runs the shared Node.
# No --allow-unsupported or license acceptance override is used.
trap 'status=$?; printf "NODE_QUALIFICATION_EXIT=%s\n" "$status"' EXIT
output=/data/cache/qualification
mkdir -p "$output"
if [ "${1:-}" != '--state-only' ]; then
printf 'NODE_QUALIFICATION_STAGE=hardware\n'
nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv,noheader
/opt/mere-run/mere.run --version
if [ ! -f "$output/completed" ]; then
  printf 'NODE_QUALIFICATION_STAGE=model-preflight\n'
  timeout 120 /opt/mere-run/mere.run model pull image-zimage-nano --preflight --json
  printf 'NODE_QUALIFICATION_STAGE=model-pull\n'
  # CR-only progress can exceed the provider's log-frame limit. Keep the full
  # local download log and emit only its final lines to the bounded log stream.
  if ! timeout 2400 /opt/mere-run/mere.run model pull image-zimage-nano > "$output/model-pull.log" 2>&1; then
    tr '\r' '\n' < "$output/model-pull.log" | tail -20
    exit 1
  fi
  tr '\r' '\n' < "$output/model-pull.log" | tail -3
  printf 'NODE_QUALIFICATION_STAGE=model-info\n'
  /opt/mere-run/mere.run model info image-zimage-nano --json
  printf 'NODE_QUALIFICATION_STAGE=image-smoke\n'
  timeout 600 /opt/mere-run/mere.run image generate --model image-zimage-nano \
    --prompt 'A simple watercolor illustration of a red sailboat on calm blue water, no text' \
    --width 512 --height 512 --steps 4 --seed 42 --output "$output/smoke.png"
  sha256sum "$output/smoke.png" > "$output/smoke.sha256"
  touch "$output/completed"
fi
sha256sum -c "$output/smoke.sha256"
cat "$output/smoke.sha256"
ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of json "$output/smoke.png"
printf 'NODE_QUALIFICATION_STAGE=image-smoke-passed\n'
fi
printf 'NODE_QUALIFICATION_STAGE=private-state\n'
# No account token: exercise exactly the entrypoint's private-directory checks.
unset MERERUN_NODE_BOOTSTRAP_AUTH
/usr/local/bin/node-container-entrypoint --help > "$output/headless-help.txt"
umask 077
marker=/home/node/.local/share/mere-run-node/qualification-marker
if [ -f "$marker" ]; then
  test "$(stat -c '%a:%u' "$marker")" = '600:10001'
  printf 'NODE_QUALIFICATION_PRIVATE_STATE_RESTORED=%s\n' "$(cat "$marker")"
else
  head -c 32 /dev/urandom | sha256sum | cut -d' ' -f1 > "$marker"
  test "$(stat -c '%a:%u' "$marker")" = '600:10001'
  printf 'NODE_QUALIFICATION_PRIVATE_STATE_CREATED=%s\n' "$(cat "$marker")"
fi
printf 'NODE_QUALIFICATION_STAGE=passed\n'
