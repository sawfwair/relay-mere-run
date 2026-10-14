# Immutable identity execution

Relay can broker an immutable identity or agent specification without knowing
the calling product's private schema. The Worker accepts short-lived
`mere.world` JWTs for audience `mere-run-relay`; application cookies and service
credentials are never accepted by Relay or forwarded to a node.

## Chat request

`POST /api/chat` supports these identity fields in addition to the normal text
request:

- `execution_spec_sha256`: canonical SHA-256 of the caller-owned immutable spec;
- `identity`: exact persona, version, and deployment IDs;
- `adapter`: exact `{ manifest_sha256, base_model_id, scale }`;
- `required_device_id`: optional compatible node pin;
- `idempotency_key`: account-scoped logical execution key.
- `chat_id`: optional broker-reserved `chat_<32 lowercase hex>` ID;
  required when submitting with a single-chat execution grant.

`use_lora` remains wire-compatible. `true` without `adapter` fails with
`ADAPTER_REFERENCE_REQUIRED`; Relay never silently downgrades to prompt-only.
Repeating an idempotency key with the same request returns the original
execution. Reusing it for different content returns `409 IDEMPOTENCY_CONFLICT`.
Graph submissions provide the same behavior through a complete canonical
request digest and optional `job.requirements.required_device_id`.

## Execution receipt

Terminal chat and graph responses include `relay.execution-receipt.v1` with the
execution, request and optional execution-spec digests; exact model and adapter
digest; provider/catalog and device identity; timing; terminal state; output
digest; and structured error code. A receipt never contains prompts, responses,
source text, filesystem paths, credentials, or private logs.

Only the authenticated node assigned to a processing chat may report its
result or error. A queued chat cannot be completed, and terminal states and
receipts are immutable: duplicate or contradictory node messages are ignored,
including after the in-memory response has expired. This binding uses the
authenticated WebSocket attachment, not an actor identifier in the payload.
Device and runtime provenance is captured when the chat is assigned, so a
disconnect or later inventory update cannot erase or relabel the receipt.
Chats cancelled before assignment have no execution node or start time.

Runtime prompt and response text exists in the account Durable Object only
until delivery. The durable queued copy is cleared when assigned, terminal
content is retained in memory for bounded polling, and no chat text is written
to R2. Private graph inputs additionally require the explicit
[`local-custody.v1` policy](local-custody.md) and a compatible Node; merely
declaring sanitized outputs does not protect inputs in the portable transport.

## Exact adapter execution

The node advertises adapter manifest digests, not paths. For an exact adapter
request it resolves
`$MERE_RUN_ADAPTER_ROOT/<manifest_sha256>/manifest.json`, confines every file to
that directory, verifies manifest and weight digests, verifies the base model,
and invokes `mere.run text chat --lora`. Missing, mismatched, or unavailable
adapters block placement or fail closed.
