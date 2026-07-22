# relay-mere-run

Purpose:
- Cloudflare Worker, Durable Object relay, and authenticated fleet console for remote image/chat/talk/asr/embed/ocr flows.
- `relay.mere.run` is the same-account compute control plane: it persists node inventory and history, reports hardware/runtime/model/telemetry data, exposes job activity, and applies operator scheduling policy.

Entry points:
- `index.ts` routes HTTP and websocket traffic
- `auth.ts` authenticates bearer/license/api-key requests
- `client-api.ts` implements the HTTP API surface
- `MereRunRelay.ts` is the Durable Object state machine
- `relay-fleet.ts` owns persistent fleet records, performance history, and scheduler scoring
- `relay-api-fleet.ts` exposes account-scoped fleet snapshots and policy updates
- `web-auth.ts` implements the mere.world OIDC PKCE browser session
- `web/` is the authenticated React fleet console and public node-download surface
- `contracts/` contains executable request, response, graph, fleet, and agent-message schemas
- `json.ts` is the only sanctioned JSON decode helper; callers must provide a runtime parser

Key invariants:
- `MereRunRelay.ts` owns mutable relay state.
- `client-api.ts` should adapt HTTP into DO operations, not duplicate scheduling logic.
- Fleet state is account-scoped and survives node disconnects; a disconnected node is historical capacity, not an active scheduler target.
- Old agents remain compatible. Lease-aware agents may be retried safely after disconnect; late results from expired leases are ignored.
- Keep request/response parsing typed at the boundary.

Module flow:
- `index.ts` -> public auth/routing -> `client-api.ts` -> account Durable Object
- `MereRunRelay.ts` -> route/agent composition -> feature handlers -> queue/lifecycle/storage
- Feature handlers may depend on queue, lifecycle, fleet, webhook, and R2 primitives; those primitives must not import API routers.
- `corepack pnpm check:architecture` enforces an acyclic production runtime graph.

Validation:
- `corepack pnpm verify:fast` for the normal edit loop and pre-push gate
- `corepack pnpm test:coverage` for the enforced Worker coverage floor
- `corepack pnpm verify:full` for builds plus Swift and warning-denied Rust checks

Safe to edit:
- Isolated endpoint behavior, auth rules, and DO logic with matching regression tests

Do not touch casually:
- Websocket message contracts, queue ownership rules, or cancellation/late-result handling without updating regression coverage
