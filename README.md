# relay-mere-run

`relay-mere-run` is the account-scoped control plane between Mere clients and
outbound-only `mere.run` compute nodes. A Cloudflare Worker authenticates public
requests, one Durable Object per account owns scheduling and durable work state,
R2 stores media and graph artifacts, and the Tauri node executes accepted work
locally. The repository also contains the fleet web console and public Swift and
TypeScript clients.

The relay exists to make private compute usable from remote applications without
opening inbound ports on the node. Its critical guarantees are account isolation,
capability-aware placement, lease-safe retries, terminal cancellation, validated
wire contracts, and immutable portable graph bundles.

## Project status

The source is available under the [MIT License](./LICENSE). Sawfwair operates the
hosted `relay.mere.run` service and its `mere.world` identity boundary; opening
the source does not grant access to those production systems or their data.

The repository supports local development, automated tests, and native builds.
Self-hosting requires a Cloudflare account with Workers, Durable Objects, R2, and
a compatible JWT/OAuth broker. The checked-in `wrangler.toml` documents the
maintained deployment topology with local or placeholder values. Account IDs,
production routes, bucket names, Secrets Store IDs, and secret values belong in
a private deployment configuration and must not be committed.

## Start here

- [CODEBASE.md](./CODEBASE.md) — orientation and change boundaries in under 500 tokens.
- [DECISIONS.md](./DECISIONS.md) — architectural choices that should not be rediscovered.
- [src/README.md](./src/README.md) — Worker and Durable Object module map.
- [web/README.md](./web/README.md) — fleet-console ownership and response-boundary rules.
- [node/README.md](./node/README.md) — native node architecture and local development.
- [docs/graph-jobs.md](./docs/graph-jobs.md) — portable graph contract.
- [docs/identity-execution.md](./docs/identity-execution.md) — immutable identity execution and receipt contracts.
- [clients/README.md](./clients/README.md) — public client surfaces.
- [CONTRIBUTING.md](./CONTRIBUTING.md) — development and pull-request expectations.
- [SECURITY.md](./SECURITY.md) — private vulnerability reporting.

## Prerequisites

- Node.js 24
- Corepack with pnpm 10.34.5 (the repository pins the current pnpm 10 line in `package.json`)
- Rust stable and Cargo for the Tauri core
- Xcode command-line tools on macOS for the Swift client gate

Install both JavaScript workspaces:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm --dir node install --frozen-lockfile
```

No production secret value belongs in source, fixtures, documentation, or a
handoff. Local Worker tests use the non-production bindings in
`wrangler.test.toml`.

## Verification

Use the canonical gates instead of assembling ad hoc command lists:

```sh
corepack pnpm verify:fast   # lint, TS, architecture/complexity/policy, Worker + node tests
corepack pnpm test:coverage # enforced Worker coverage floor and HTML/LCOV output
corepack pnpm verify:full   # fast gate + web/node builds + Swift + Rust gates
corepack pnpm check:opensource # community, metadata, CSP, and supply-chain policy
```

`verify:fast` runs independent static gates concurrently before the Worker
integration suite. It is the pre-push hook and is designed to finish in under 30
seconds with labeled, aggregated failures.
The five strict TypeScript projects are also checked concurrently.
`verify:full` is the release/CI parity gate. Rust runs formatting, Clippy with
warnings denied, and locked tests. TypeScript checks the Worker, browser, public
client, tests, and node UI under strict mode. Swift is type-checked separately.
`check:complexity` reports classic McCabe A–F grades and rejects new functions
above C or any change to a reviewed hotspot ceiling. Rust Clippy separately
denies cognitive complexity above the repository threshold.
The normal lint command includes this report in the same AST traversal.

Hosted CI also audits both pnpm lockfiles and the Rust lockfile. Maintainers can
run the same dependency audit locally after installing
[`cargo-audit`](https://github.com/RustSec/rustsec/tree/main/cargo-audit):

```sh
corepack pnpm audit:dependencies
```

GitHub Actions is the required hosted gate. An administrator can apply the
reviewed `main` policy with `corepack pnpm configure:main-protection`. The
guarded script requires the three CI jobs, one approving review, resolved
conversations, linear history, and blocks force-pushes and branch deletion. A
workflow that GitHub rejects before its first step is not a passing check.

## Development

```sh
corepack pnpm dev             # build the web console and start Wrangler
corepack pnpm test:watch      # focused Worker test loop
corepack pnpm --dir node tauri dev
```

The Worker entry point is `src/index.ts`; the account state machine is
`src/MereRunRelay.ts`. Public JSON must be decoded through a schema in
`src/contracts/` and `src/json.ts`. Do not parse a payload and assert a TypeScript
type at an HTTP, WebSocket, storage-manifest, OAuth, browser, or client boundary.

## Change safety

Normal endpoint and UI changes should include a focused test plus
`verify:fast`. Changes to wire messages, queue ownership, leases, cancellation,
graph fingerprints/bundles, upload authorization, account routing, or release
publishing require explicit regression coverage and a review against
[DECISIONS.md](./DECISIONS.md). Source checks do not prove a deployed Worker or a
published desktop artifact; deployment and release evidence remain separate.

## Contributing and support

Use GitHub issues for reproducible bugs and focused feature proposals. Read
[CONTRIBUTING.md](./CONTRIBUTING.md) before making a behavioral or protocol
change. Report suspected vulnerabilities privately as described in
[SECURITY.md](./SECURITY.md), never in a public issue.

## License

Copyright 2026 Sawfwair Inc. and mere.run contributors. Released under the
[MIT License](./LICENSE).
