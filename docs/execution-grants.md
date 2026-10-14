# Scoped background execution

An identity broker may issue server-to-server JWTs restricted to a finite set
of graph executions. Normal account and device tokens retain their existing
contracts. Restricted tokens require:

- issuer matching `BROKER_ORIGIN`, Relay audience, signature, stable subject,
  expiry, and an issued-at time;
- `token_use: "relay_execution"`, `scope: "relay:graph-execution"`, matching
  `client_id` / `azp`, and a maximum five-minute lifetime;
- `relay_execution_grant: { version: 1, id, executions }`, with 1–8 unique job
  IDs and idempotency keys. Each slot also names its provider and node kind;
  `request_sha256` optionally pins the exact immutable request.

The allowlist is limited to graph capabilities, submission of a reserved job,
and that job's status, commit, cancellation, and `receipt` artifact. Every
graph node must match the slot's provider and kind. Account lists, telemetry,
fleet management, uploads, other inference APIs, and node sockets are denied.
The stable JWT subject still selects the account Durable Object; client
headers cannot change ownership. An idempotency replay cannot disclose an
execution outside the grant.

Malformed restricted claims fail closed, including partial claims that could
otherwise be mistaken for an ordinary account token. Restricted tokens must
arrive as Bearer credentials, not browser-session cookies. The broker is
responsible for rechecking the originating app session before each mint.
Revocation stops new minting immediately; existing JWTs expire within five
minutes. Never persist these JWTs or log their claims/body.

Validation: `pnpm verify:fast` covers signed JWTs, scope denials at the actual
Worker route, subject ownership, exact request hashing, provider/kind checks,
and idempotency response confinement. This release changes the Worker only;
no Node binary or public plugin release is needed for this contract.

## Single-chat grants

Version 2 uses `scope: relay:chat-execution` and
`relay_execution_grant: { version: 2, kind: "chat", id, executions: [slot] }`.
Exactly one slot is permitted. It contains:

- `chat_id` in the form `chat_<32 lowercase hex>`;
- exact `idempotency_key`, `request_sha256`, and `execution_spec_sha256`;
- `model_id`, `adapter_manifest_sha256` (null for prompt-only), and
  a positive `max_tokens` ceiling, at most 32768.

This token permits only `POST /api/chat` for the reserved ID and exact
request, `GET /api/chat/<id>`, and `POST /api/chat/<id>/cancel`.
Submission must name the pinned model/adapter and a positive integer token
limit no larger than the ceiling. The canonical runtime projection used to
authorize the request is the same projection used for the receipt digest.
Transport IDs, idempotency keys and the compatibility `use_lora` flag are
excluded from that digest; the exact adapter reference is included.

The broker must bind each dynamically created request to a finite
session-authorized workflow budget before issuing a token. Relay never
accepts a general conversation policy as account-wide authority.
Graph and chat scopes are not interchangeable. Malformed or partial chat
claims cannot fall through to ordinary account authentication.

Reservations atomically persist the chat ID and account-scoped idempotency
mapping. Concurrent retries return one execution. A different request under
the same key or an occupied reserved ID returns 409; an expired/missing
execution behind a retained idempotency record returns 410, not a fresh run.
Once admitted, a node disconnect does not erase an acknowledged reservation.
