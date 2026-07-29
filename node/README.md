# mere.run node

A cross-platform Tauri desktop app that turns any device with `mere.run`
installed into a **local processing node** for the [mere.run relay](../). It connects
to `relay.mere.run` as a device agent, advertises the models the machine has,
and services image, speech synthesis, ASR, embedding, and plugin tool jobs by
driving local `mere.run` plus installed `mere-*` companion plugins — so any app
that submits jobs to the relay (animatic included) can be served from this
device.

It also advertises the public graph-worker contract. Portable graph jobs are
downloaded with strict size and SHA-256 verification, executed through
`mere.run graph worker execute --json-stream`, and returned with the same run
manifest, events, reports, and artifacts produced by local or SSH execution.

Runs anywhere `mere.run` runs: Apple Silicon, x86 + CUDA, arm64 + CUDA.

## How it works

The Rust core (`src-tauri/src/`) is the relay device agent:

- `protocol.rs` — wire types mirroring `relay-mere-run/src/types.ts`.
- `agent.rs` — opens a WebSocket to `wss://relay.mere.run/agent` with
  `Authorization: Bearer <token>`, sends `auth` + capabilities, then for each
  `job`, `chat_request`, `talk_request`, `asr_request`, `embed_request`, or
  `tool_request` message drives `mere.run` or the requested plugin, streams
  progress, uploads results to the relay upload URL, and replies with the
  matching result/error message. It reports hardware, runtime, installed-model
  inventory, capacity, and live power/memory/thermal telemetry; pings every 20s
  and auto-reconnects. The relay can request a live inventory rescan without
  reconnecting the node.
- `hardware.rs` — inventories CPU, memory, Apple Metal/unified memory,
  NVIDIA CUDA/VRAM, ROCm, power, battery, and thermal state using portable OS
  data plus vendor tools when available.
- `mererun.rs` — wraps the local `mere.run` binary
  (`mere.run image generate --prompt … --model … --output … --width … --height …
  --seed … [--ref-image …]`, `mere.run speech synthesize`,
  `mere.run speech transcribe --backend …`, and `mere.run text embed`) and
  discovers models/capabilities via `mere.run`.
  Live ASR advertises only installed Parakeet and Qwen backends. Relay resolves
  automatic stream tickets to a ready backend before audio starts, while
  explicit requests remain pinned through the Node protocol and child command.
- `plugins.rs` — scans `PATH`, `~/.local/bin`, `~/bin`, `/opt/homebrew/bin`, and
  `/usr/local/bin` for `mere-*` executables that answer `manifest --json`,
  advertises their commands in relay capabilities, runs assigned tool requests,
  and uploads every artifact listed in the plugin run manifest.
- `native_video.rs` — provides the built-in, typed `preview_subject_masks`,
  `prepare_subject_masks`, and `generate_subject_video` Relay tools. These call
  the installed native Swift/MLX `mere.run` commands directly; no companion
  plugin or Python runtime is involved.
- `graph.rs` — verifies and materializes immutable workflow bundles, launches
  the public graph worker, forwards its NDJSON events, uploads run artifacts,
  and cooperatively cancels the worker process. Large graph artifacts are
  uploaded in independently verified 8 MiB parts, with duplicate content sent
  only once even when it appears as both a final output and node artifact.
  Interrupted uploads resume from relay-verified parts; temporary workspaces
  are removed on every outcome and disk admission preserves a free-space reserve.
- `lib.rs` — Tauri commands `start_node` / `stop_node` / `node_running` /
  `discover_models`, streaming `node:status` / `node:job` / `node:log` events to
  the UI. Stop drains the current job; sign-out cancels active child processes
  before clearing the broker session, so a stalled render cannot trap the UI.
  While the Relay supervisor is active, macOS holds a native process activity
  that prevents App Nap without overriding the operator's system sleep policy.

The React console (`src/App.tsx`) is a calm dashboard: connection status, the
device's models, a live job feed, and a log.

## Run

```sh
pnpm install
pnpm tauri dev      # desktop window
pnpm tauri build    # bundle
```

## Release Builds

The public node downloads are served by the Worker from R2:

```text
https://relay.mere.run/downloads/mere-run-node/macos/latest
https://relay.mere.run/downloads/mere-run-node/linux/x86_64/deb/latest
https://relay.mere.run/downloads/mere-run-node/linux/x86_64/latest
https://relay.mere.run/downloads/mere-run-node/linux/arm64/deb/latest
https://relay.mere.run/downloads/mere-run-node/linux/arm64/latest
```

Build, upload to remote R2, download-compare the object, and smoke-check the
public route from the repo root.

```sh
./scripts/release-node-macos.sh
./scripts/release-node-linux-deb.sh # recommended Ubuntu/Debian package
./scripts/release-node-linux.sh    # run on x86_64 or arm64 Linux
```

Linux artifacts are architecture-specific. Debian packages are the recommended
Ubuntu/Debian install and AppImages remain the portable fallback. Arm64 is a
first-class release target for DGX Spark/Blackwell-class machines. Details live in
[`../docs/release-node-macos.md`](../docs/release-node-macos.md) and
[`../docs/release-node-linux.md`](../docs/release-node-linux.md). User-visible
changes are recorded in [`CHANGELOG.md`](CHANGELOG.md).

On Ubuntu with NVIDIA GB10 graphics, install `libnvidia-egl-gbm1` for WebKitGTK
hardware rendering. The app automatically uses a compatible renderer when that
bridge is absent. AppImages must be launched as the desktop user, never with
`sudo`.

## Plugins

Install companion plugins where the node process can find them on `PATH`. For
Animatic production tools:

```sh
pipx install "git+https://github.com/sawfwair/mere-run-plugins.git@main#subdirectory=packages/mere-animatic-tools"
pipx install "git+https://github.com/sawfwair/mere-run-plugins.git@main#subdirectory=packages/mere-vfx-tools"
```

During development, point the node at a checkout-built executable:

```sh
export MERE_ANIMATIC_TOOLS_BIN=/path/to/mere-animatic-tools
export MERE_VFX_TOOLS_BIN=/path/to/mere-vfx-tools
```

When `mere-animatic-tools` is available, the node advertises all ten Animatic
production commands to the relay. Animatic's Run Node panel then enables the
Production Tools launcher.

When `mere-vfx-tools` is available, the node advertises every VFX workflow as a
separate capability. Tool requests may bind signed inputs with `{"$asset": 0}`
or `{"$assetDirectory": [0, 1]}`. The node downloads those assets into the
temporary job directory, resolves the bindings to local paths before launching
the plugin, removes remote URLs from the localized request, and expands
directory outputs into individually uploadable artifacts. Remote inputs must be
HTTPS URLs; relay requests cannot name workstation paths. Downloads reject
redirects and artifact uploads stream from disk so long videos and EXR sequences
do not need to fit in memory.

## Sign in

Auth is brokered through **mere.world** via the OAuth 2.0 device-authorization
grant (RFC 8628) — the same flow merekit-console uses, no pasted tokens:

1. Click **Sign in with mere.world**. The node requests a device + user code and
   opens `mere.world/device` in your browser.
2. Approve the displayed code. The node polls the broker, receives a brokered
   access token, and persists it (per-OS app config dir).
3. **Start node** connects to the relay with that token; the relay validates it
   against `mere.world/oauth/userinfo`.

While connected, the node continues checking the broker token and refreshes it
before expiry, with bounded requests and retryable handling for transient broker
failures. The node remains the sole owner of its rotating refresh token and
atomically rewrites the saved token set. Applications submit work through Relay;
they never copy, rotate, or persist the Node refresh token. Revoked or otherwise
terminal sessions are cleared and require a new device approval.

Approve as many machines as you like under the same mere.world account — each one
joins that account's agent **pool** in the relay, which spreads jobs across them.
Open `https://relay.mere.run` with that account to inspect every current or
previously-seen node, see its hardware and models, change priority or preferred
models, drain/disable/revoke it, and choose balanced, fastest, or
power-efficient scheduling.

## Status / TODO

Working: connect, auth, capability advertise, persistent hardware/runtime/model
inventory and telemetry, lease-aware retry, image/music/video jobs via
`mere.run`, correct img2img (`--input`/`--strength`), chat via `mere.run text
chat`, Qwen speech synthesis, batch and live ASR with explicit Parakeet/Qwen
routing, optional native Sortformer speaker diarization for batch ASR, embedding via `mere.run text embed`, plugin tool jobs via installed
`mere-*` companions, result routing (POST outputs to relay upload endpoints,
then send the returned public URLs), per-step image progress, ping, reconnect,
live UI.

Notes / next:
- `mere.run api serve` is **chat/embedding only** — there is no warm image
  server to wrap, so spawning `mere.run image generate` per image job is the
  correct path for image.
- Handle the remaining OCR modality routed by the relay.
- Real `capabilities` (max_resolution, lora, controlnet) probed from `mere.run`
  rather than hard-coded defaults.
