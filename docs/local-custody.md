# Local-custody graph execution

Set `job.data_policy` to `local-custody.v1` for a graph whose source material,
datasets, weights, checkpoints, logs, and per-example results must stay on the
execution node. Relay Node 0.2.20 implements this transport policy around the
existing native graph runtime. The normal portable graph API is unchanged for
jobs without the policy.

## Admission and placement

- A policy-bearing submission is limited to 256,000 UTF-8 JSON bytes, including
  any exact `bundle_documents`. Portable asset groups must be empty.
- Only graph outputs named `receipt` or `report` are permitted. Artifact outputs
  use `application/vnd.mere.identity-receipt+json` or
  `application/vnd.mere.sanitized-report+json`, and each is at most 256,000 bytes.
- A node must advertise `graph_worker.data_policies: ["local-custody.v1"]` and
  meet every provider, model, resource, and required-device constraint. Older
  nodes receive a `data_policy_unsupported` placement blocker.
- The application must pin private local references to their owning device.
  This transport does not move, resolve, or disclose local artifact paths.

## Delivery and recovery

1. Relay keeps the four graph documents in the account's Durable Object while
   queued. It does not write them to R2. Node URLs return `Cache-Control: no-store`.
2. The node verifies all four exact document sizes and SHA-256 digests and checks
   that the job's policy matches the delivery envelope.
3. Before execution, it posts `{ "request_sha256": "<exact request digest>" }`
   to the assignment's `bundle-ack` endpoint. A duplicate acknowledgement is safe.
   Relay removes inputs, arguments, defaults, arbitrary metadata, and exact
   document bytes from both its live object and durable job record.
4. If the node disconnects after acknowledgement, the queued job reports
   `payload_state: "replay_required"`. It cannot be assigned until the account
   resubmits the exact original request with the same ID and idempotency key.
   A changed semantic request returns 409. Retry-only job IDs and timestamps
   never replace the original execution's headers. Each assignment has a new node token and must
   acknowledge again. The maximum assignment budget is three attempts.
   Private `graph_event`, `graph_result`, and `graph_error` messages must echo
   the `assignment_token` from their `graph_request`. Missing/stale tokens are
   ignored, including when the same device reconnects for a later attempt.
5. Terminal jobs remain terminal and report `payload_state: "purged"`. Explicit
   terminal retry requires a new execution; the old receipt is never rewritten.

The TypeScript client exposes `submitGraph`, `commitGraph`, `getGraph`, and
`cancelGraph`. Keep the frozen original submission server-side for exact replay;
do not regenerate timestamps, IDs, provider pins, or document serialization.
The SDK validates returned request/spec digests and terminal receipt linkage.

## Output boundary

The node retains private run files under `MERERUN_NODE_PRIVATE_GRAPH_ROOT`, or
the user's `Library/Application Support/MereRun/private-graph-runs` on macOS
and `.local/share/mere-run-node/private-graph-runs` elsewhere. Each attempt gets
a separate directory; prior attempts are not deleted. The root and attempt
directories are owner-only on Unix. Back up and manage retention locally.

Only declared, rehashed report JSON uploads. Input manifests, actions, event
logs, per-node intermediate artifacts, and arbitrary run-manifest fields do
not. Both Node and Worker enforce the shared aggregate-only grammar: numeric
metrics, bounded structures, constrained identifiers, digests, and opaque
`*-local://kind/<sha256>` references. Four-arm evaluation entries contain only
numeric metric maps. No free-form messages, prompts, responses, file paths, or
credential fields are admitted. This is a structural contract, not a detector
for data deliberately encoded into a number or identifier; providers must also
honor local custody.

If the native graph runtime labels a graph output alias as
`application/octet-stream`, the node recovers its media type only from a
confined, rehashed provider-node artifact with the same name, size, and digest.
Exactly one allowed receipt/report media type must be proven; missing or
ambiguous evidence remains rejected.

Relay stores sanitized reports under their SHA-256, never a mutable output
name. A superseded upload cannot replace terminal report bytes. An upload that
loses its assignment while storing may leave only an unreferenced sanitized
object until ordinary job retention removes it. Assignment checks prevent it
from updating the current job. Multipart uploads are forbidden for this policy.
The durable run manifest contains only contract, execution, graph digest,
terminal state, and Relay attempt number; events contain sequencing, state,
time, type, and an optional constrained node ID.

## Verification and rollout

`test/graph-custody.test.ts` exercises actual Durable Object/R2 boundaries,
acknowledgement, exact replay, stale tokens, account isolation, terminal
retention, and the SDK. Rust graph simulator tests inspect every outbound
request and the retained local files. Both runtimes consume
`test/fixtures/local-custody-reports.json`.

Deploy the Worker first, release/install a capable Node next, then enable
policy-bearing application submissions. Test a real provider workload before
claiming production custody. Tests alone are not an R2 inventory or production
log audit, and opting in does not retroactively remove older portable jobs.
