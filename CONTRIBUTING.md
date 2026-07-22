# Contributing

Thanks for helping improve `relay-mere-run`. Bug reports, focused fixes,
documentation improvements, tests, and well-scoped feature proposals are
welcome.

## Before changing behavior

Search existing issues and pull requests first. Open an issue before a large
feature, protocol change, or architectural rewrite so the contract and scope can
be agreed before implementation begins. Security reports belong in the private
channel described in [SECURITY.md](./SECURITY.md), not a public issue.

Read [CODEBASE.md](./CODEBASE.md), [DECISIONS.md](./DECISIONS.md), and the
README for the module you plan to change. Changes to account scoping, leases,
cancellation, graph bundles or fingerprints, upload authorization, public wire
messages, and release promotion require focused regression coverage.

## Development setup

Install Node.js 24, pnpm 10.34.5 through Corepack, Rust stable, and the Xcode
command-line tools on macOS. Then install both JavaScript workspaces:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm --dir node install --frozen-lockfile
```

Run the correction loop while working and the complete gate before requesting
review:

```sh
corepack pnpm verify:fast
corepack pnpm verify:full
```

Linux contributors who cannot run the Swift gate should say so in the pull
request and rely on the required macOS CI job for that evidence.

## Pull requests

Keep each pull request cohesive and explain the user-visible effect, affected
invariants, and verification performed. Add or update tests for behavior
changes. Update documentation when setup, contracts, commands, or operational
boundaries change.

Do not commit credentials, `.env` files, `.dev.vars`, production payloads,
customer data, signing material, or generated build output. Use synthetic test
data and redact logs before attaching them.

By submitting a contribution, you agree that it may be distributed under the
project's [MIT License](./LICENSE).
