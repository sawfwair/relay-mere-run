#!/usr/bin/env node
// Refuses to deploy a Worker configuration that still carries the committed
// placeholder values. The committed wrangler.toml intentionally omits
// production identifiers; shipping it replaces the live Worker's vars with
// placeholders and breaks relay authentication for every paired device
// (incident 2026-08-17). Production deploys pass a private config:
//   node scripts/check-deploy-config.mjs wrangler.production.toml \
//     && wrangler deploy --config wrangler.production.toml
import { readFileSync } from 'node:fs';

const path = process.argv[2] ?? 'wrangler.toml';
let text;
try {
  text = readFileSync(path, 'utf8');
} catch {
  console.error(`deploy guard: cannot read ${path}`);
  process.exit(1);
}

const placeholders = ['identity.example.com', 'replace-with-your', 'localhost:8787'];
const found = placeholders.filter((marker) => text.includes(marker));
if (found.length > 0) {
  console.error(
    `deploy guard: ${path} still contains placeholder configuration (${found.join(', ')}).\n` +
      'Production deploys must use a private Wrangler configuration with real ' +
      'BROKER_ORIGIN, asset URLs, and bucket names. See DECISIONS.md.'
  );
  process.exit(1);
}
console.log(`deploy guard: ${path} carries no known placeholders.`);
