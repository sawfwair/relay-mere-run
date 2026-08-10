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

Runtime prompt and response text exists in the account Durable Object only
until delivery. The durable queued copy is cleared when assigned, terminal
content is retained in memory for bounded polling, and no chat text is written
to R2. Graph R2 output is limited to explicitly declared artifacts; private
providers should declare only sanitized receipt or report outputs.

## Exact adapter execution

The node advertises adapter manifest digests, not paths. For an exact adapter
request it resolves
`$MERE_RUN_ADAPTER_ROOT/<manifest_sha256>/manifest.json`, confines every file to
that directory, verifies manifest and weight digests, verifies the base model,
and invokes `mere.run text chat --lora`. Missing, mismatched, or unavailable
adapters block placement or fail closed.
