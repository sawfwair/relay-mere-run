import { access, readFile } from 'node:fs/promises';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const requiredFiles = [
  'LICENSE',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'CODE_OF_CONDUCT.md',
  '.github/PULL_REQUEST_TEMPLATE.md',
  '.github/ISSUE_TEMPLATE/bug_report.yml',
  '.github/ISSUE_TEMPLATE/feature_request.yml',
  '.github/ISSUE_TEMPLATE/config.yml',
  '.github/dependabot.yml',
];

await Promise.all(requiredFiles.map(async (path) => {
  await access(path);
  const contents = await readFile(path, 'utf8');
  assert(contents.trim().length > 0, `${path} must not be empty`);
}));

const [
  license,
  rootPackageText,
  nodePackageText,
  cargoManifest,
  tauriConfigText,
  gitignore,
  workflow,
  dependabot,
  nodeHtml,
  productionWrangler,
  testWrangler,
] = await Promise.all([
  readFile('LICENSE', 'utf8'),
  readFile('package.json', 'utf8'),
  readFile('node/package.json', 'utf8'),
  readFile('node/src-tauri/Cargo.toml', 'utf8'),
  readFile('node/src-tauri/tauri.conf.json', 'utf8'),
  readFile('.gitignore', 'utf8'),
  readFile('.github/workflows/ci.yml', 'utf8'),
  readFile('.github/dependabot.yml', 'utf8'),
  readFile('node/index.html', 'utf8'),
  readFile('wrangler.toml', 'utf8'),
  readFile('wrangler.test.toml', 'utf8'),
]);

assert(license.startsWith('MIT License\n'), 'LICENSE must contain the project MIT license');

for (const [path, text] of [['package.json', rootPackageText], ['node/package.json', nodePackageText]]) {
  const manifest = JSON.parse(text);
  assert(manifest.private === true, `${path} must prevent accidental registry publication`);
  assert(manifest.license === 'MIT', `${path} must declare the MIT license`);
  assert(manifest.repository?.url === 'git+https://github.com/sawfwair/relay-mere-run.git', `${path} repository metadata is missing or incorrect`);
  assert(typeof manifest.description === 'string' && manifest.description.length > 20, `${path} must describe the package`);
}

for (const requirement of [
  'license = "MIT"',
  'repository = "https://github.com/sawfwair/relay-mere-run"',
  'homepage = "https://mere.run"',
]) {
  assert(cargoManifest.includes(requirement), `Cargo metadata is missing: ${requirement}`);
}

const tauriConfig = JSON.parse(tauriConfigText);
const csp = tauriConfig.app?.security?.csp;
assert(csp && typeof csp === 'object', 'Tauri CSP must be enabled');
assert(csp['default-src']?.includes("'self'"), 'Tauri default-src must be self-restricted');
assert(csp['connect-src'] === 'ipc: http://ipc.localhost', 'Tauri connect-src must be IPC-only');

for (const pattern of [
  '.npmrc',
  '.env',
  '.env.*',
  '.dev.vars',
  '.dev.vars.*',
  '*.pem',
  '*.key',
  '*.p12',
  '*.pfx',
  '*.jks',
  '*.keystore',
  '*.mobileprovision',
  '*.provisionprofile',
  'node/src-tauri/target/',
]) {
  assert(gitignore.split('\n').includes(pattern), `.gitignore must include ${pattern}`);
}

for (const requirement of [
  'actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6',
  'actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38 # v6',
  'pnpm/action-setup@0ebf47130e4866e96fce0953f49152a61190b271 # v6',
  'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7',
  'rustsec/audit-check@69366f33c96575abad1ee0dba8212993eecbe998 # v2.0.0',
  'pnpm audit --prod --audit-level=moderate',
  'pnpm --dir node audit --prod --audit-level=moderate',
]) {
  assert(workflow.includes(requirement), `CI supply-chain policy is missing: ${requirement}`);
}

for (const requirement of [
  'package-ecosystem: npm',
  'directory: /node',
  'package-ecosystem: cargo',
  'directory: /node/src-tauri',
  'package-ecosystem: github-actions',
]) {
  assert(dependabot.includes(requirement), `Dependabot policy is missing: ${requirement}`);
}

assert(!nodeHtml.includes('/vite.svg'), 'Node must not ship the Vite starter favicon');
assert(nodeHtml.includes('/app-icon.svg'), 'Node must use the project icon');
await access('node/src/assets/react.svg')
  .then(() => { throw new Error('Node must not retain the React starter logo'); })
  .catch((error) => {
    if (error?.code !== 'ENOENT') throw error;
  });
assert(!/^\s*(?:WEBHOOK_SIGNING_SECRET|ASR_STREAM_TICKET_SECRET)\s*=/mu.test(productionWrangler), 'Production Wrangler config must not contain secret values');
for (const forbidden of [
  'account_id',
  'store_id',
  'relay.mere.run',
  'mere.world',
]) {
  assert(!productionWrangler.includes(forbidden), `Public Wrangler config must not contain deployment value: ${forbidden}`);
}
assert(productionWrangler.includes('bucket_name = "replace-with-your-r2-bucket"'), 'Public Wrangler config must use an R2 placeholder');
assert(testWrangler.includes('WEBHOOK_SIGNING_SECRET = "test-'), 'Test secret fixtures must be visibly synthetic');
assert(testWrangler.includes('ASR_STREAM_TICKET_SECRET = "test-'), 'Test ticket secret must be visibly synthetic');

console.log(`Open-source policy passed: ${requiredFiles.length} community files, package metadata, CSP, dependency automation, and secret-file guards are present.`);
