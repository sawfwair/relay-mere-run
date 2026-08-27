# Scoped background graph execution

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
