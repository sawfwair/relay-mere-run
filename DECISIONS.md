# Architectural decisions

These records capture non-obvious constraints. Change an accepted decision only
with a replacement record and protocol-level regression tests.

## ADR-001 — Account state is owned by one Durable Object

Status: accepted

Public requests authenticate at the Worker and route to a Durable Object named by
the account user id. That object is the serialization boundary for connected
nodes, queues, leases, stored work, alarms, and fleet policy. Cross-account
results are forwarded to the owner's object rather than mutating foreign state.
This keeps scheduling decisions deterministic and prevents process-local Worker
state from becoming authoritative.

## ADR-002 — Runtime data is parser-first and forward-compatible

Status: accepted

TypeScript types do not validate JSON. HTTP bodies and responses, agent
WebSocket messages, OAuth responses, graph manifests, browser responses, and
public-client responses are parsed from `unknown` through executable contracts.
Public object schemas retain unknown fields so newer senders remain compatible,
while required fields and discriminators must match. Invalid request JSON returns
an actionable 400 before queue or lifecycle mutation; malformed upstream or SDK
responses fail closed.

## ADR-003 — Lease identity protects retry and terminal state

Status: accepted

Lease-aware work may be requeued after a node disconnects. A result from an
expired lease is ignored, and cancellation remains terminal even if a node later
reports success or failure. Do not simplify this to agent-id or job-id matching:
doing so permits stale nodes to overwrite reassigned or cancelled work.

## ADR-004 — Portable graph execution is a two-phase immutable contract

Status: accepted

Graph submission validates and persists canonical documents and asset digests;
commit performs placement and execution. Workers receive byte-stable bundle
documents, verified assets, pinned provider/model requirements, and scoped upload
credentials. Fingerprints, 64-bit numeric bytes, event ordering, quota checks,
multipart verification, and cancellation/retry behavior are protocol, not
implementation detail.

## ADR-005 — Nodes are outbound-only and public uploads remain owner-scoped

Status: accepted

Nodes connect to the relay over authenticated WebSockets and receive relay upload
URLs. Upload URLs carry the owner identity and are routed back to the owning
Durable Object; local filesystem paths are never a remote input contract. This
avoids inbound node exposure and prevents an uploader's account from selecting
the persistence owner.

## ADR-006 — Verification has fast, coverage, and release tiers

Status: accepted

`verify:fast` is the canonical sub-30-second correction loop and pre-push gate.
Coverage is measured separately because instrumentation is slower; Cloudflare
Worker tests use Istanbul because the Workers runtime does not support native V8
coverage. `verify:full` adds production builds plus Swift and warning-denied Rust
checks. CI runs the same named gates rather than maintaining a divergent command
list. A green source gate does not establish that a Worker was deployed or a
desktop artifact was signed and published.

## ADR-007 — Main accepts reviewed, fully verified changes only

Status: accepted

`main` requires the Worker/web, macOS Rust/Swift, and Linux Rust/package checks,
one approving review, dismissal after new commits, resolved conversations, and
linear history. Administrators are included; force-pushes and branch deletion
remain disabled. `scripts/configure-main-protection.sh` is the canonical policy
application path so required check names stay aligned with CI. Repository-plan
or Actions-billing failures are external readiness blockers, not reasons to
weaken or simulate enforcement.

## ADR-008 — Complexity is measured and ratcheted

Status: accepted

TypeScript and TSX use classic McCabe cyclomatic complexity with Radon-style
grades: A 1–5, B 6–10, C 11–20, D 21–30, E 31–40, and F above 40. New functions
must remain at C or better. Existing D–F hotspots have explicit per-function
ceilings in `complexity-baseline.json`; improvement requires lowering or removing
the ceiling, while regression fails the fast gate. Rust uses Clippy's cognitive
complexity lint with warnings denied and a current ceiling of 45, which must be
lowered as hotspots are decomposed. Complexity is a maintainability signal, not
permission to change protocol semantics solely to improve a score.

## Production deploys require a private Wrangler configuration

The committed `wrangler.toml` intentionally carries placeholder identifiers
(`identity.example.com`, a placeholder R2 bucket, localhost URLs) because this
is the open-source distribution. Deploying it verbatim replaces the live
Worker's environment with those placeholders and breaks relay authentication
for every paired device — this happened on 2026-08-17 and was recovered with
`wrangler rollback`. `pnpm run deploy` now runs
`scripts/check-deploy-config.mjs`, which refuses any configuration that still
contains placeholder markers; production deploys set `WRANGLER_CONFIG` to a
private, uncommitted configuration (reconstructable from the live version via
`wrangler versions view <id>`, which lists every var and binding).
