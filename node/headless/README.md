# Headless Node qualification

The `mere-run-node-headless` binary runs the same Relay agent, device authorization,
refresh lifecycle, work gate, native runtime adapters, lease messages, cancellation
handlers, and artifact upload code as the desktop Node. It has no Tauri, GTK, or
webview dependency. The desktop application remains a client of the shared core
through the `NodeEvents` adapter.

## Run locally

```bash
cargo build --locked --manifest-path node/headless/Cargo.toml
node/headless/target/debug/mere-run-node-headless enroll --state-dir /private/node-state
MERERUN_BIN=/absolute/path/mere.run node/headless/target/debug/mere-run-node-headless run --state-dir /private/node-state
node/headless/target/debug/mere-run-node-headless health --state-dir /private/node-state
node/headless/target/debug/mere-run-node-headless drain --state-dir /private/node-state
node/headless/target/debug/mere-run-node-headless resume --state-dir /private/node-state
```

Enrollment prints the verification URL and user code and waits for explicit
account approval. Access/refresh tokens are saved through the existing atomic
owner-only token writer. Use a dedicated state directory: do not copy a running
desktop Node's refresh token. A file lock prevents concurrent daemons/enrollment
from sharing one identity. The random device identity persists across restarts.

`MERERUN_NODE_RELAY_URL` selects Relay (WSS required except loopback tests).
`MERERUN_NODE_NAME` labels the node. The daemon advertises the shared core's
measured inventory; naming a GPU or installing this binary does not qualify a
model. `health` returns a nonzero exit when disconnected, draining, stopped, or
when its heartbeat is more than five seconds old. State includes current work;
operational logs omit prompts, bearer tokens, signed URLs, and raw provider errors.

Drain intent persists on disk. The shared work gate blocks queued work while
draining. SIGTERM/Ctrl-C also begins a drain and keeps the Relay connection alive
until active work releases its permit, allowing result upload before shutdown.
An externally forced kill remains an interruption: recovery still depends on
Relay's lease and artifact protocol.

## Container

Build from the `node` directory with a separate build context containing the
published `mere-run-0.60.1-linux-x86_64-cuda.tar.gz` artifact. The Dockerfile verifies
its SHA256, pins Rust/CUDA base-image digests, compiles the daemon for Linux amd64,
and runs as UID 10001. It does not compile the CUDA runtime on paid GPU time.

```bash
cd node
docker buildx build --platform linux/amd64 --load -f headless/Dockerfile \
  --build-context runtime=/absolute/pinned-runtime-directory \
  -t mere-run-node-headless:qualification .
docker run --rm --platform linux/amd64 mere-run-node-headless:qualification --help
```

The account entrypoint drops to UID 10001 and creates private state at
`/home/node/.local/share/mere-run-node` on the container filesystem. The RunPod
`/data` volume is reserved for model caches: the live provider mount ignored
required ownership/permission changes and was rejected before any account token
was written. State/auth must verify actual 700/600 modes and UID 10001. Local
capability-restricted and chmod-ignore regressions pass. Standalone daemon
initialization also verifies actual directory ownership and mode, so terminal
enrollment cannot trust an ineffective chmod. A credential-free live provider restart restored the identical private 600
marker after the directory passed its 700 ownership check; stop, replacement, or deletion may
lose container-local identity and require dedicated re-enrollment. Do not claim
persistent account identity on the cache volume.

Optional `MERERUN_NODE_BOOTSTRAP_AUTH` supplies an enrolled token set once, only
when the private auth file is absent; it is removed from the daemon environment
and never baked into the image. Existing rotated tokens are preserved while
that private filesystem remains available. `/data/cache/models` stores models and
`/data/cache/hub` stores downloads. FFmpeg and the CUDA
12.9 development headers support media encoding and runtime JIT. The image itself
publishes no model HTTP API or management port.

## Evidence and limits

On October 4, 2026, native `cargo check` passed and the reused execution-core suite
passed 130 tests with six explicitly live tests ignored. Additional headless tests
exercise a real loopback WebSocket authentication handshake, lease-protocol
advertisement, drain availability, and shutdown without any desktop runtime.
A failing regression established that queued work ignored drain; acquisition now
checks acceptance atomically after obtaining the semaphore and waits for resume.

Linux amd64 daemon cross-build and container entrypoint smoke passed. Runtime
loader smoke exposed a CUDA ABI mismatch in the initial base; the image must
match the pinned published artifact, not current source documentation.
A real A40/driver 580.159.04 run passed the pinned model support gates and
generated a 512×512 PNG with native MLX CUDA. The retained log records its SHA256
and dimensions; the PNG itself was deleted with the Pod, so visual quality was
not reviewed. Real account enrollment, Relay artifact delivery, revocation, and
account interruption recovery still need their own receipts. Image cancellation now has an active per-job watch registry, cancellation before
the work gate, explicit subprocess lifetime cleanup (including Unix process groups),
and cancellation-result suppression. A reproduced real child-process regression
and the shared-core suite pass; live remote cancellation still needs a receipt. This is a qualification
binary, not a claim that every desktop capability now works on CUDA.

## Bounded RunPod preflight

`gpu-preflight.sh` is an explicit container command that checks NVIDIA hardware,
prints the pinned CLI version and model preflight, downloads `image-zimage-nano`,
and generates one 512×512 image with a fixed seed. It uses the runtime's normal
support/license gates. It never enrolls a Node and cannot qualify Relay delivery. `state-preflight`
skips model work and checks private state only. `qualify-runpod.py --state-only
--restart-probe` requires a matching private marker after an explicit provider
restart; it still deletes its owned resources on failure.

`qualify-runpod.py` requires `--execute`, an immutable image reference, and a
short-lived pull-only registry password file. It selects one secure A40 only
when the current GPU quote is at most US$1/hour, requests a one-hour provider
termination deadline, and deletes its own Pod and registry credential. It
records a private receipt and logs, reconciles an ambiguous creation by unique
name without replaying it, and preserves unrelated account resources. The
elapsed-rate estimate is not a substitute for final provider billing. Its five
mock API tests cover successful cleanup, ambiguous creation recovery, oversized SSE progress, private marker restart and mismatch rejection, and secret
exclusion: `python3 -m unittest discover -s node/headless -p 'test_*.py'`.

The model source pinned by the v0.60.1 catalog is
`filipstrand/Z-Image-Turbo-mflux-4bit` at
`b3a8f31115a11f2f9e2fa0bfbc8d78dcc3e6568b`. Local catalog preflight reports
5,907,440,828 download bytes and 8,054,924,476 required bytes. That catalogue
inspection used a temporary CUDA driver stub only to load the CLI on the Mac's
Docker VM; no model was executed by that inspection. The independent live A40 run provided the actual NVIDIA driver and completed
inference without those local inspection stubs.

## Declared hosting

Set `MERERUN_NODE_HOSTING_KIND` explicitly to `workstation`, `runpod`, `other`, or `unknown`. Optionally set `MERERUN_NODE_HOSTING_LABEL` to a label of at most 80 characters with no control characters. Invalid configuration fails before headless startup. Omitted configuration remains unknown: the daemon never infers a provider or region from Linux, a GPU name, hostname, or device name.

The shared enrollment and inventory protocol carries `capabilities.hosting` with `source: "owner-declared"`. Relay validates that bounded declaration and returns it in the authenticated account's status inventory. It is an owner's declaration, not provider verification. The label is descriptive configuration; never place credentials in it. Canceling an inference job does not stop a RunPod Pod or its storage billing.

The final private image is
`sha256:21785e06c41070a20920db75827fde153690548036aa42b4db3f3fc06e438671`,
Linux daemon SHA256
`c0e33f6bf004a83b4b666f5c717cc657b58c5f4c2dcb6dab6c9bf35aca409c7b`.
It adds standalone permission verification after the live predecessor-image
checks. Its native suite, cross-build, and local container checks pass. The
Animatic `reports/roadmap-qualification/headless-container.json` receipt records
that qualification boundary and links the exact live GPU/state image digests.
All four qualification Pods and provider registry-auth entries were deleted.
Elapsed-rate compute was US$0.1619; final billing/storage records were pending.

## Approved account run

See [ACCOUNT-QUALIFICATION.md](ACCOUNT-QUALIFICATION.md) for the bounded real-Node
controller, exact-node Relay qualifier, scoped revocation, and application hook
contract. The controller/client offline suite passes 17 tests. It rejects a
missing or wrong-scope grant and checks live placement support before rental.
No account run has occurred while approval remains absent. The CLI prints the
broker's actual grant expiry; the earlier ten-minute approval estimate was not
a measured server lifetime.
