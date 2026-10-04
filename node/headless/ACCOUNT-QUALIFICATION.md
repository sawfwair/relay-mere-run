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
owned-resource cleanup still apply. Existing registry/image arguments remain
required. `--state-only` and `--restart-probe` cannot be combined with account mode.

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

The controller and Relay qualifier have offline API tests. Until the dedicated
grant is approved and the live chain runs, no account result is qualified.
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

The hook's nine offline tests cover successful contract sequencing, owner/device/
agent mismatch, missing placement support, invalid rendered frame count,
ambiguous mutation replay refusal, origin protection and polling bounds. Syntax
and ESLint checks passed. Together with nine controller and eight Relay API tests,
these are harness evidence only; the real account chain remains pending.

The latest enrollment ended with the broker's `expired_token` response at about
15:28 UTC on 2026-10-04 without producing `auth.json`. No replacement grant or
paid Pod was created. Request a fresh grant when the owner is ready to approve.
