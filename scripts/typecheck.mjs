import { spawn } from 'node:child_process';
import process from 'node:process';

const projects = [
  ['Worker', ['exec', 'tsc', '-p', 'tsconfig.json', '--noEmit']],
  ['web', ['exec', 'tsc', '-p', 'web/tsconfig.json', '--noEmit']],
  ['TypeScript client', ['exec', 'tsc', '-p', 'clients/typescript/tsconfig.json', '--noEmit']],
  ['tests', ['exec', 'tsc', '-p', 'test/tsconfig.json', '--noEmit']],
  ['node UI', ['--dir', 'node', 'exec', 'tsc']],
];

function checkProject([label, args]) {
  return new Promise((resolve) => {
    const child = spawn('pnpm', args, {
      cwd: process.cwd(),
      env: { ...process.env, FORCE_COLOR: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.on('error', (error) => resolve({ label, exitCode: 1, output: `${output}${error.message}\n` }));
    child.on('close', (exitCode) => resolve({ label, exitCode: exitCode ?? 1, output }));
  });
}

const startedAt = performance.now();
const results = await Promise.all(projects.map(checkProject));
const failures = results.filter(({ exitCode }) => exitCode !== 0);
for (const result of results) {
  console.log(`[${result.label}] ${result.exitCode === 0 ? 'passed' : `failed (${result.exitCode})`}`);
  if (result.output.trim()) process.stdout.write(result.output);
}
const durationSeconds = ((performance.now() - startedAt) / 1000).toFixed(2);
if (failures.length > 0) {
  console.error(`Typecheck failed after ${durationSeconds}s: ${failures.map(({ label }) => label).join(', ')}`);
  process.exit(1);
}
console.log(`Typecheck passed: ${results.length} strict projects in ${durationSeconds}s.`);
