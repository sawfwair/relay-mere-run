# Durable graph batches

Use graph batches to distribute independent inputs across your account's fleet.
Each child executes its complete immutable workflow graph on one worker. Intermediate
artifacts stay there. A batch does not divide a graph or model across devices.

## Submit a batch

Materialize one portable bundle per input. Pin child job IDs, fingerprints, model and
provider requirements, and seeds. Include exact `bundle_documents` to preserve
canonical bytes and 64-bit numbers. Item keys and job IDs must be unique. Children
cannot carry separate idempotency keys.

`POST /api/graph-batches` accepts:

```typescript
{
  schema_version: 1,
  batch_id: "0e4aaf62-4a42-4c21-aea5-d5c6d08a0f01",
  idempotency_key: "render-scenes-001",
  max_in_flight: 8,
  max_attempts: 1,
  items: [{ key: "scene-001", submission: resolvedGraphJob }]
}
```

`resolvedGraphJob` is the same complete validated `job`, `graph`, `inputs`, `assets`,
and optional `bundle_documents` object accepted by `POST /api/graph-jobs`.

1. Create the batch and retain the exact request for replay.
2. Upload each returned `missing_asset_digests` entry once through
   `PUT /api/graph-batches/:id/assets/:sha256`. Undeclared, corrupt, or incomplete assets fail verification.
3. Send `POST /api/graph-batches/:id/commit`.
4. Inspect `GET /api/graph-batches/:id`. The batch continues when your client disconnects.

Repeat the original create request to resume uploads. A batch ID or idempotency key
with different content returns 409. Repeating commit does not create more children.

## Admission and placement

The parent persists all item descriptors before activating a bounded window of
children. Planned, queued, assigned, and running children share the account's active
graph quota with ordinary jobs. Faster workers receive more items as they finish.

Admission prefers pending items compatible with connected workers. Blocked items can
wait for inventory changes. Dispatch rotates between batches and ordinary work,
preserving FIFO order within each group. Existing fleet policy and asset-cache
locality guide worker selection. Required device pins and secret names still apply.
Models are not installed automatically.

Batch children require `graph_worker.assignment_tokens: true`. The desktop Node
advertises this because it echoes attempt tokens on events, results, and errors.
Legacy workers remain eligible for ordinary jobs. The account dispatcher reserves
the worker before asynchronous bundle preparation. Durable records reconstruct the
queue after hibernation and reconcile missing workers against the attempt budget.

## Failure, retry, and cancellation

`max_attempts` includes the first attempt and defaults to one. Enable additional
attempts only for replay-safe workflows. Disconnects and stale assignments can
restart an entire graph within this budget. Model errors fail the child. Old
assignment tokens cannot settle a newer attempt or authorize uploads. Execution can
occur more than once during disconnects; only the active assignment can publish completion.

To retry settled failed items, send `POST /api/graph-batches/:id/retry` with:

```json
{ "retry_key": "5f5e5cce-46b6-4e12-94cc-9cd52f45c910" }
```

Reuse the retry key if the response is lost. Successful items retain their outputs
and attempts. Failed items reuse their immutable bundles and receive another attempt
budget. Cancelled batches and cancelled items cannot be retried.

`DELETE /api/graph-batches/:id` persists terminal cancellation before stopping
admission and cancelling unfinished children. Running slots remain occupied until
cancellation settles. Maintenance resumes interrupted cancellation. Completed
outputs remain available.

## Results and limits

Inspection returns `counts` for pending, queued, running, finished, failed, and
cancelled items. `items` stays in submission order and contains keys, child job IDs,
attempts, errors, placement diagnostics, and verified final output metadata. Download
outputs through the ordinary graph artifact API. Inspection returns at most 100 items
per page. Follow `next_cursor` with `GET /api/graph-batches/:id?cursor=:ordinal`.
Counts cover the entire batch. The Swift and TypeScript clients assemble the ordered
index and reject incomplete or duplicated pages. `GET /api/graph-batches` lists parents.

Batch v1 supports portable bundles and rejects local-custody submissions.

- One batch contains 1–1000 items, with 1–20 in-flight children and 1–4 attempts.
- Create requests are limited to 8 MiB; each item descriptor is limited to 96 KB.
- A child declares at most 64 final outputs; its final output index is limited to 32 KB.
- An account retains at most 20 nonterminal batches and 16 MiB of batch descriptors.
- Existing graph input, output, active-job, and account-storage quotas apply. Pending
  inputs reserve storage before admission.
- Terminal batches and their children use the configured graph retention period.

## Qualification

`test/graph-batches.test.ts` uses the local Workers runtime and simulated outbound
node sockets. It covers fan-out, bounded admission, whole-graph delivery, verified
results, replay, token fencing, shared assets, isolation, cancellation, legacy
compatibility, quotas, and fairness. Ordinary graph and native Node simulator tests
remain required. These tests establish control-plane and protocol behavior. Real
checkpoint execution, physical fleet throughput, and deployed Worker and Node builds
need separate qualification.

The October 14, 2026 local qualification used Node.js 24.19.0 on Apple Silicon:

- `corepack pnpm verify:full` passed: 228 Worker tests, 5 Node UI tests,
  standalone Swift typechecking, both web builds, Rust formatting and Clippy,
  and 148 native Node tests (6 ignored).
- Worker coverage passed the repository thresholds: 82.77% statements,
  75.49% branches, 91% functions, and 85.84% lines.
- `corepack pnpm check:opensource` passed.
- The batch simulator delivered 100 independent two-node graphs across three
  workers with an in-flight window of four. Additional cases covered cold
  reconstruction, disconnect retries, stale-token rejection, interrupted
  cancellation, failed-only retry, and a 205-item paged result index.

Roll out the Relay Worker and a rebuilt desktop Node together. Batch dispatch
requires the advertised assignment-token capability; an older deployed Node
build does not gain that capability from a server update.
