# Portable Graph Jobs

The relay brokers immutable `mere.run` workflow bundles as a first-class work
kind. Graph jobs are independent from image, media, chat, and plugin tool jobs.
The complete graph is placed on one compatible node so intermediate artifacts
remain local to that machine.

## Client API

All routes are authenticated and scoped to the caller's relay Durable Object:

```text
POST   /api/graph-jobs
PUT    /api/graph-jobs/:id/assets/:sha256
POST   /api/graph-jobs/:id/commit
GET    /api/graph-jobs/:id
GET    /api/graph-jobs/:id/events
GET    /api/graph-jobs/:id/events             Accept: text/event-stream
GET    /api/graph-jobs/:id/run-manifest
GET    /api/graph-jobs/:id/artifacts/:name
DELETE /api/graph-jobs/:id
POST   /api/graph-jobs/:id/retry
GET    /api/graph-jobs
GET    /api/graph-jobs/capabilities
POST   /api/graph-jobs/preflight
GET    /api/graph-jobs/telemetry
GET    /api/fleet
POST   /api/fleet/nodes/:device-id/refresh
PATCH  /api/fleet/nodes/:device-id
POST   /api/fleet/model-plans
GET    /api/fleet/model-plans
GET    /api/fleet/model-plans/:id
POST   /api/fleet/model-plans/:id/apply
DELETE /api/fleet/model-plans/:id
```

Creation is two phase. `POST /api/graph-jobs` stores and validates the manifests
and returns `missing_asset_digests`. The client uploads only those content
hashes, then calls `commit`. Commit verifies every declared object before the
job can enter the queue. The relay does not fetch client-supplied URLs.

`POST /api/graph-jobs/preflight` accepts the same complete submission document,
performs admission validation, and returns the account fleet's typed placement
report without storing a job, consuming quota, or claiming a Node. This is the
hosted Graph Studio preparation boundary.

The events endpoint returns the worker's Graph Event V1 records as NDJSON by
default. With `Accept: text/event-stream`, it emits `connected`, `graph_event`,
and terminal `done` server-sent events while keeping the underlying event model
unchanged. Relay persistence tracks the worker's monotonic sequence separately
from its retained event array. Progress and heartbeat records are coalesced by
node and phase, and retained history is capped at 512 records. The NDJSON
response exposes first, last, and retained sequence metadata in headers so a
client can detect a compacted prefix without changing the event contract.

## Placement

An eligible node advertises `graph_worker` capabilities including its
authoritative `mere.run graph catalog --json` document, bundle
contract versions, worker version, node kinds, installed model IDs, accelerator
backend and memory, available disk, platform, architecture, and graph providers.
Each external provider capability carries its ID, version, catalog SHA-256, and
node kinds. Placement requires an exact provider version and catalog match in
addition to the union of the graph's other requirements, then assigns the entire
graph to one node. Legacy nodes without graph-worker support remain eligible for
existing work but cannot receive graph jobs. Older graph workers without a
provider inventory can still receive built-in graphs but are ineligible for
provider-qualified graphs.

The capability response aggregates live catalog entries by provider and node
kind. Studio therefore consumes the connected fleet's actual node schemas
instead of shipping a second built-in catalog that can drift behind `mere.run`.

Every graph status response includes a typed placement report with stable node
and device identity, eligible counts, and per-node blocker codes. Blockers cover
busy or policy state, missing graph support, incompatible bundle or worker
versions, missing node kinds and models, missing or mismatched providers,
accelerator backend and memory, and available disk. A queued graph therefore
explains why no node can run it.

Fleet history includes graph jobs alongside image, media, chat, speech,
analysis, and plugin work. Connected nodes can receive `inventory_request` and
reply with `inventory_update`; the relay persists the refreshed hardware,
runtime, model, plugin, capacity, disk, and graph-worker inventory and then
immediately retries queued placement.

Graph nodes retain verified content-addressed input assets between jobs and
advertise a bounded list of cached digests. Placement reports expose cached and
total input bytes for every node. Among otherwise eligible workers, the
scheduler favors the node that can reuse the largest share of input bytes.
Manifests are always downloaded and every reused asset is rehashed before it is
linked into a job bundle; corrupt cache entries are removed and fetched again.

## Model Plans

Fleet model distribution is a separate control-plane contract. Creating a
model plan accepts either an explicit list of canonical model IDs or a source
node whose reported inventory supplies that list, plus one or more target node
IDs. The persisted plan records each target's installed and missing sets but
does not modify a machine.

Applying a plan sends only the currently missing IDs to each online target. A
node preflights every model with the public `mere.run model pull --preflight
--json` contract, pulls sequentially, and returns an outcome for every model.
Nodes are unavailable to the scheduler while an apply attempt is active.
Messages carry the plan attempt number so results from an earlier apply cannot
settle a retry. Cancellation terminates the owned pull process, and completion
triggers a fresh runtime inventory scan.

Model license acceptance is false by default and can be enabled only on the
explicit apply request. Preferred models remain a routing hint and never cause
installation. The dashboard exposes source inventory selection, exact model
and target selection, plan review, apply, and live per-target state.

## Node Protocol

The relay sends `graph_request` with signed URLs for the four bundle documents
and content-addressed assets. The node verifies path, size, and SHA-256 before
launching:

```bash
mere.run graph worker execute --bundle PATH --run-dir PATH --json-stream
```

The node forwards each NDJSON record as `graph_event`, uploads the run manifest,
final outputs, reports, and artifact manifest through relay-owned upload routes,
then sends `graph_result` or `graph_error`. `graph_cancel` requests cooperative
worker cancellation and terminates its owned child process. Agent ownership and
terminal-state checks reject stale or late messages.

Relay validation recognizes built-in `mere.run` nodes directly. External node
kinds are accepted only when the graph names a provider and the immutable job
manifest pins that provider's identity. The relay validates references and
dependency shape without duplicating provider output catalogs; the assigned
worker performs the authoritative typed graph validation from the pinned
provider catalog.

Artifacts up to 8 MiB use one verified upload. Larger artifacts are split into
8 MiB parts; each part carries its own size and SHA-256 and is rejected before
storage if either differs. The relay records complete content by the artifact's
full SHA-256, so final outputs and node-artifact aliases can share one upload.
`graph_result` is accepted only after every unique artifact digest is complete.
Fetch streams the ordered R2 parts as one response with the artifact's original
content type and size, and the client verifies the complete SHA-256 after write.

Automatic recovery requeues a disconnected assignment for at most one retry.
An explicit retry creates another attempt against the same immutable bundle;
materialized seeds therefore remain unchanged.

Artifact upload status is reconstructed from R2-verified parts. A retry queries
that status, skips complete artifacts and matching parts, and uploads only the
missing content. Each completed job records bundle-download, execution, upload,
and total milliseconds plus uploaded and reused artifact bytes and parts.

## Storage Boundaries

Bundle manifests, content-addressed inputs, run reports, and result artifacts
use the relay's existing R2 boundary. Paths are confined to the portable bundle
or run directory, and uploads are accepted only for the assigned owner and
declared artifact metadata. Provider provisioning does not live here; external
GPU providers remain encapsulated by `mere-run-plugins`.

## Operations

Graph admission defaults to 20 active jobs per account, 50 GiB for one job's
inputs, 50 GiB for one job's outputs, and 100 GiB of account graph storage.
These limits are explicit Worker variables in `wrangler.toml`.

A shared Durable Object alarm reconciles assigned or running jobs that have not
updated for six hours. It requeues when the attempt budget permits and otherwise
fails the job. Terminal jobs and their R2 reports and artifacts expire after 30
days; unreferenced content-addressed inputs are removed on the same retention
boundary. Temporary node workspaces are removed after every success, failure,
or cancellation. Verified input assets remain in the node's content-addressed
cache; operators can relocate that cache with `MERERUN_NODE_GRAPH_CACHE`. A
preflight disk guard preserves at least 1 GiB free.

`GET /api/graph-jobs/telemetry` exposes aggregate submissions, quota rejects,
artifact bytes and parts, resumed parts, stale reconciliation, retention
deletions, R2 bytes reclaimed, and the last maintenance timestamp. Per-job
metrics remain on each graph response.

Relay discovery is public at `/.well-known/mere-run-relay`. It advertises the
graph contract and mere.world OAuth device and token endpoints without exposing
credentials or introducing a hosted default in `mere.run`.

## Offline Acceptance

The graph control plane and node data plane have dedicated simulators that do
not read configured relay profiles or connect to registered nodes:

```bash
pnpm test:graph-simulator
pnpm test:node-graph-simulator
```

The workerd simulator covers admission, capability placement, immutable bundle
delivery, event retention, cancellation, retry, resumable artifact upload,
quotas, and stale-work reconciliation. The Rust simulator starts a loopback
relay server and a temporary fake `mere.run` worker, then drives the production
node code through verified bundle download, NDJSON forwarding, artifact and
manifest upload, workspace cleanup, and cooperative cancellation.
