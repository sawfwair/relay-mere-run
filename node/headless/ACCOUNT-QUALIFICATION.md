# Approved account qualification

The GPU model and private container-state restart probes are complete. They do
not prove an account-scoped job. The next run uses the same headless agent and
pinned CUDA runtime, with a dedicated device grant approved by the owner.

## Prerequisites

- The dedicated `enroll --state-dir PATH` command must have written its own
  owner-only `auth.json`. Never copy a desktop refresh token or share a refresh
  identity between running daemons. The CLI now prints the broker's actual grant
  expiry; its local fallback is not the broker's configured lifetime. Current
  source gives approval codes a 30-minute default and access JWTs 15 minutes.
  The controller requires at least ten minutes of initial access lifetime and
  never rotates the Node's refresh token on the host; only the remote daemon
  owns that rotation. Exchange into a separate Animatic CLI session for longer
  application work, and never reuse a stale local refresh token after rotation.
- Relay `/api/status` must authenticate the grant and advertise
  `placement_constraints: ["required_device_id"]`. The controller checks this
  before creating a registry credential or renting a Pod. Legacy `agent_id`
  preference alone can fall back and is insufficient.
- Use a digest-pinned image and a fresh short-lived, pull-only registry password
  file. The earlier qualification's local pull credential was deleted.
- FFmpeg must be installed on the controller host for full artifact decoding.
- For the Animatic chain, obtain an Animatic-scoped session through its supported
  broker token exchange from the approved Node access token. Do not use the Node
  bearer directly as an Animatic API credential.

## Bounded controller

`qualify-runpod.py --execute --node-auth-file PATH` runs the normal daemon rather
than `gpu-preflight`. It privately supplies the dedicated grant to the existing
atomic container bootstrap, discovers only its unique qualification Node name,
then starts `qualify-relay.py`. Other Nodes are not selected or modified. Its
one-hour provider deadline, rate limits, unknown-create reconciliation, and
owned-resource cleanup still apply. The image defaults to the immutable `release-image.json` pin. An explicit
`--image` override requires a full SHA256 digest; mutable tags are rejected before
provider requests. Registry credential arguments remain required. `--state-only` and `--restart-probe` cannot be combined with account mode.

### Account storage allocation

Account runs request an **80 GB container disk and a 120 GB cache volume**.
Standalone GPU and private-state probes retain their 30 GB container disk and
70 GB cache volume. The receipt records the requested sizes under `storage`.
The one-hour deadline, US$1/hour GPU quote limit, US$1.10/hour assigned total-rate
limit, and existing spending bound still apply. This is a provider allocation
change; it does not require a new Node image.

The pinned runtime is `v0.60.1`. Its selected LTX payload already includes the
quantized Gemma 4 text encoder; do not add the separate upstream BF16 encoder
size to the download estimate. Pinned payload sizes checked on October 12 are:

| Payload | Bytes | GiB |
| --- | ---: | ---: |
| Complete `video-ltx25-distilled-bf16` selection | 53,878,517,792 | 50.178 |
| Selected `image-zimage-nano` files | 5,907,440,828 | 5.502 |
| Both installed payloads | 59,785,958,620 | 55.680 |
| Largest LTX download, `distilled-transformer-bf16.safetensors` | 37,985,685,664 | 35.377 |

The LTX selection and total are defined in
[`LTX25Resources.swift` at v0.60.1](https://github.com/sawfwair/mere-run/blob/v0.60.1/Sources/MereRunCore/LTX/LTX25Resources.swift).
Its pinned repository revision is
[`cf8a174746cd14796c81ca2b54e035dc32e69bd8`](https://huggingface.co/Sawfwair/LTX-2.5-Distilled-BF16-MLX-Q4-Text/tree/cf8a174746cd14796c81ca2b54e035dc32e69bd8).
The largest file size comes from that revision's public tree metadata for
`.mere-run/ltx25-native-v1/distilled-transformer-bf16.safetensors`.
The image total is the sum of the 16 files selected by
`ManagedModelCatalog+Image.swift` at
[`b3a8f31115a11f2f9e2fa0bfbc8d78dcc3e6568b`](https://huggingface.co/filipstrand/Z-Image-Turbo-mflux-4bit/tree/b3a8f31115a11f2f9e2fa0bfbc8d78dcc3e6568b).
The catalog's conservative image estimate is 20,538,488,559 bytes; it is not the
measured selected payload. Summing that estimate with LTX gives 69.306 GiB,
rather than the actual selected 55.680 GiB.

Linux `HubSnapshot.swift` downloads each complete file through a Foundation
download task, retains it in `FileManager.default.temporaryDirectory`, and then
moves it into the Hub cache. The pinned image does not override `TMPDIR`, so its
cache environment variables do not move this temporary download off the
container filesystem. A 30 GB root cannot hold the 35.377 GiB transformer even
before container overhead. The 80 GB root leaves more than 20 GiB of headroom
above that file, treating provider GB as decimal conservatively. The 120 GB
cache exceeds both selected payloads plus another largest-file allowance.
Final Hub references use hard links, with symlink fallback, rather than a
required second copy of every payload. The model pull disk check also requires
an estimated download plus 20 percent safety margin on the cache filesystem.

This is a source-and-metadata sizing finding. The interrupted live run did not
expose a remote `ENOSPC` error or filesystem measurements, so it does not prove
that storage caused the observed delay. Node model plans run
`model pull --quiet`, capture stdout and stderr until the child exits, and
publish a `pulling` event without streaming byte progress. Silence while that
event remains active does not establish a stalled transfer. The account hook's
polling deadline and the controller deadline remain separate limits.

The default Relay qualifier installs only `image-zimage-nano` through the real
model-plan protocol with license acceptance disabled, requests one 512×512
four-step image, receives and fully decodes the uploaded PNG, cancels a second
job after it reaches `generating`, checks released availability and absence of a
late result, then revokes the dedicated fleet Node. Every request carries the
required device constraint and every result must match its owner and agent.
An ambiguous submission is recorded and never automatically repeated.

`qualify-relay.py` may also be run separately with `--execute`, `--auth-file`,
`--device-id`, `--expected-node-name`, and a fresh `--receipt-dir`. Add
`--revoke-owned-node` only at the end of all work on that Node. Optional
`--revoke-refresh-token` calls the broker's revocation endpoint for the dedicated
device refresh token and requires an actual `invalid_grant` response on a later
refresh attempt. This does not instantly invalidate the existing access JWT.
Do not revoke before the Animatic token exchange and application checks finish.
The optional check refuses the original local token once the remote daemon may
have reached its refresh window; revoking a stale replaced token would not prove
that the current remote credential was revoked.

The Animatic account hook supplies `--access-token-provider` as a JSON argument
array invoking its own `--relay-access-token` mode. Before every Relay API call,
including model installation polling and final cleanup, the qualifier obtains
a fresh access token from that independent Animatic CLI session. Provider output
stays on a captured pipe, must match the original owner, identify `animatic-cli`,
and retain at least 60 seconds of access lifetime. Provider errors do not echo
stdout/stderr. No API mutation is automatically retried on an auth or network
failure. This provider never reads or rotates the remote Node refresh token.
Without a provider, the standalone qualifier retains its initial Node access
JWT and is bounded by that JWT's lifetime.

On interruption the parent hook terminates the owned qualifier process group,
including any token-provider descendant, before resolving credentials for
cleanup. It reads the child's durable receipt and reconciles known Relay job
and model-plan IDs before fleet revocation and logout. Cleanup refuses another
owner's job, another Node's job, or a model plan shared with another Node.
An indeterminate submission without a saved ID remains an explicit reconciliation
error, never authorization to submit replacement work.

## Animatic hook contract

Pass `--account-hook /absolute/executable` to run the full application chain
instead of the default Relay-only probe. The controller executes it directly,
without a shell command string. It receives these environment variables:

| Variable | Value |
| --- | --- |
| `QUALIFICATION_NODE_ID` | The exact connected owned device |
| `QUALIFICATION_NODE_NAME` | Unique qualification Pod/Node name |
| `QUALIFICATION_NODE_AUTH_FILE` | Dedicated local approved grant file |
| `QUALIFICATION_POD_ID` | Owned RunPod ID |
| `QUALIFICATION_REPORT_DIR` | Directory for the hook receipt/artifacts |
| `QUALIFICATION_RELAY_SCRIPT` | Absolute path to the reviewed Relay qualifier |

The hook must finish within the remaining controller deadline and write
`receipt.json` in its report directory with `status: "passed"`,
`artifactDelivered: true`, and `animaticDeliveryQualified: true`. Exit zero alone
cannot pass. Never print tokens, raw provider responses, or signed asset URLs.

The application proof should exchange the access token into an isolated Animatic
CLI config, verify the same owner, and use an authorized qualification project.
Its real request is
`POST /api/scenes/:scene/storyboard/frames/:frame/regenerate` with
`required_device_id`, `model: "image-zimage-nano"`, `generate_images: true`, and
`defer_to_executor: true`. Verify the returned version, exact requested/resolved
Node metadata, signed Relay completion callback, durable asset, selection after
reload, and a rendered/downloaded cut. The callback needs reachable application
ingress; a local service-identity fixture does not establish this user chain.
Then complete cancellation/revocation and return control for Pod cleanup.

## Remaining evidence boundaries

The controller and Relay qualifier have offline API tests. Account-approved
image generation, cancellation, persistent Animatic selection, and decoded
still-hold export passed on October 6 and October 12. Motion delivery and live
lease interruption recovery remain unqualified.
Cancellation checks Relay's terminal state, output suppression, and released
availability; remote GPU-process termination still needs telemetry or process
evidence. Fleet-node revocation, refresh-token revocation, account admission
revocation, and loss/recovery of a live lease are separate claims.

Account state is private container-local storage. An explicit provider restart
preserved its test marker, but stop, replacement, or deletion may require fresh
enrollment. `/data` is model cache only. The controller deletes owned Pods and
their attached disks; there is no warm paid Pod waiting for user approval.

## Concrete Animatic hook

The Animatic repository now provides executable
`scripts/qualification/runpod-account-hook.mjs`. Pass its absolute path through
`--account-hook`; the controller supplies `QUALIFICATION_RELAY_SCRIPT` with the
adjacent Relay qualifier's absolute path. `ANIMATIC_QUALIFICATION_ORIGIN` defaults
to `https://animatic.mere.run` and requires HTTPS.

The hook exchanges only the approved Node **access** token using Animatic's
existing `login({nodeOnly:true})` helper, verifies the same owner through broker
userinfo, and keeps its independent Animatic refresh family in a private config
beside the dedicated Node grant. It never rotates the Node refresh token on the
controller. It runs the image/cancellation Relay proof, then creates an isolated
Animatic project, uploads the first PNG as a frame seed, and requests a new frame
through Animatic with the required device ID. It checks the generation job's
owner, device, transport and exact Relay agent, the completed saved version and
new durable asset, and selection after reload.

The current cut renderer accepts video sources. The hook therefore encodes the
newly delivered PNG into a deterministic three-second still hold with FFmpeg,
imports that explicitly labeled conversion, saves a 24 fps cut, renders it,
downloads its MP4, and requires full decoding, 72 frames and three seconds. This
does **not** claim Node video generation or motion quality. It preserves both the
source image and delivered cut in the receipt directory.

Each mutation is attempted once with an in-flight stage saved first. A receipt
already present stops execution; reconcile saved IDs before a new run. Redirects
are refused for authenticated requests and downloads must stay on their origin.
Failures and signals attempt known-job cancellation, exact owned fleet-node
revocation, and the independent Animatic refresh session's revocation. Provider
cleanup remains enforced by the parent deadline even if those API cleanup calls
cannot finish. Cleanup failures prevent a passing receipt. The dedicated project
and its media remain for review.

Offline tests cover contract sequencing, owner/device/agent mismatch, placement
support, delivered frame counts, ambiguous mutation replay refusal, origin
protection, polling bounds, and interrupted cleanup. Live results are recorded
separately in [Animatic PR #113](https://github.com/a-github-name/animatic/pull/113).

On October 12, the pinned image passed the image-to-export path. LTX installation
was canceled after the root-disk sizing flaw was verified; no motion request was
submitted and no remote disk-full error was observed. The dedicated Node, Pod,
and temporary registry entry were cleaned up. The bootstrap refresh token was
no longer usable after remote token rotation. Another isolated run requires a
fresh approved Node session and the corrected storage allocation. Never refresh
the host bootstrap copy while its remote Node is active.
