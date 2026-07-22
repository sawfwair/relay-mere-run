import { spawn } from 'node:child_process';
import process from 'node:process';

const checks = [
  ['lint', ['lint']],
  ['typecheck', ['typecheck']],
  ['architecture', ['check:architecture']],
  ['policy', ['check:policy']],
  ['open source policy', ['check:opensource']],
  ['node tests', ['test:node']],
];
const workerCheck = ['worker tests', ['test']];

function runCheck([label, args]) {
  return new Promise((resolve) => {
    const child = spawn('pnpm', args, {
      cwd: process.cwd(),
      env: { ...process.env, FORCE_COLOR: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => resolve({ label, exitCode: 1, stdout, stderr: `${stderr}${error.message}\n` }));
    child.on('close', (exitCode) => resolve({ label, exitCode: exitCode ?? 1, stdout, stderr }));
  });
}

const startedAt = performance.now();
const staticResults = await Promise.all(checks.map(runCheck));
const workerResult = await runCheck(workerCheck);
const results = [...staticResults, workerResult];
for (const result of results) {
  const status = result.exitCode === 0 ? 'passed' : `failed (${result.exitCode})`;
  console.log(`\n[${result.label}] ${status}`);
  if (result.stdout.trim()) process.stdout.write(result.stdout);
  if (result.stderr.trim()) process.stderr.write(result.stderr);
}

const failures = results.filter(({ exitCode }) => exitCode !== 0);
const durationSeconds = ((performance.now() - startedAt) / 1000).toFixed(2);
if (failures.length > 0) {
  console.error(`\nFast verification failed after ${durationSeconds}s: ${failures.map(({ label }) => label).join(', ')}`);
  process.exit(1);
}
console.log(`\nFast verification passed: ${results.length} gates (lint includes complexity) in ${durationSeconds}s.`);
