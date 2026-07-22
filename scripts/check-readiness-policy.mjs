import { readFile } from 'node:fs/promises';

const workflow = await readFile('.github/workflows/ci.yml', 'utf8');
const hooks = await readFile('lefthook.yml', 'utf8');
const protectionScript = await readFile('scripts/configure-main-protection.sh', 'utf8');

const workflowRequirements = [
  '  pull_request:',
  '  push:',
  'name: Worker and web',
  'name: Node Rust (${{ matrix.os }})',
  'os: [macos-latest, ubuntu-22.04]',
  'uses: actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6',
  'uses: actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38 # v6',
  'uses: pnpm/action-setup@0ebf47130e4866e96fce0953f49152a61190b271 # v6',
  'uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7',
  'uses: rustsec/audit-check@69366f33c96575abad1ee0dba8212993eecbe998 # v2.0.0',
  'pnpm audit --prod --audit-level=moderate',
  'pnpm --dir node audit --prod --audit-level=moderate',
  'run: pnpm verify:fast',
  'run: pnpm test:coverage',
  'run: pnpm build:web',
  'run: pnpm --dir node build',
  'run: cargo clippy --manifest-path node/src-tauri/Cargo.toml --all-targets --locked -- -D warnings -D clippy::cognitive_complexity',
  'run: cargo test --manifest-path node/src-tauri/Cargo.toml --locked',
  'run: xcrun swiftc -typecheck clients/swift/MereRunRelayClient.swift',
];

for (const requirement of workflowRequirements) {
  if (!workflow.includes(requirement)) {
    throw new Error(`CI policy is missing: ${requirement.trim()}`);
  }
}

for (const requirement of ['pre-commit:', 'run: pnpm lint', 'run: pnpm typecheck', 'pre-push:', 'run: pnpm verify:fast']) {
  if (!hooks.includes(requirement)) {
    throw new Error(`Hook policy is missing: ${requirement}`);
  }
}

const payloadMatch = protectionScript.match(/<<'JSON'\n(?<payload>\{[\s\S]+?\n\})\nJSON/u);
if (!payloadMatch?.groups?.payload) {
  throw new Error('Main-protection JSON payload was not found');
}

const protection = JSON.parse(payloadMatch.groups.payload);
const expectedChecks = [
  'Worker and web',
  'Node Rust (macos-latest)',
  'Node Rust (ubuntu-22.04)',
];
const configuredChecks = protection.required_status_checks?.contexts;
if (JSON.stringify(configuredChecks) !== JSON.stringify(expectedChecks)) {
  throw new Error('Main-protection checks do not match the CI job names');
}
if (
  protection.required_status_checks?.strict !== true
  || protection.enforce_admins !== true
  || protection.required_pull_request_reviews?.required_approving_review_count !== 1
  || protection.required_pull_request_reviews?.dismiss_stale_reviews !== true
  || protection.required_pull_request_reviews?.require_last_push_approval !== true
  || protection.required_conversation_resolution !== true
  || protection.required_linear_history !== true
  || protection.allow_force_pushes !== false
  || protection.allow_deletions !== false
) {
  throw new Error('Main-protection policy is weaker than the readiness baseline');
}

console.log('Readiness policy check passed: CI, hooks, and main protection are aligned.');
