import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { ESLint } from 'eslint';

const workspace = process.cwd();
const baseline = JSON.parse(await readFile('complexity-baseline.json', 'utf8'));
if (baseline.schema !== 1 || !Number.isInteger(baseline.maximumNewComplexity)) {
  throw new Error('complexity-baseline.json does not match schema 1');
}

const eslint = new ESLint({
  overrideConfig: [{
    files: [
      'src/**/*.{ts,tsx}',
      'web/src/**/*.{ts,tsx}',
      'clients/typescript/**/*.{ts,tsx}',
      'node/src/**/*.{ts,tsx}',
    ],
    rules: {
      complexity: ['error', { max: 0, variant: 'classic' }],
    },
  }],
});
const results = await eslint.lintFiles(['.']);

const lintResults = results.map((result) => {
  const messages = result.messages.filter(({ ruleId }) => ruleId !== 'complexity');
  return {
    ...result,
    messages,
    errorCount: messages.filter(({ severity }) => severity === 2).length,
    fatalErrorCount: messages.filter(({ fatal }) => fatal).length,
    warningCount: messages.filter(({ severity }) => severity === 1).length,
    fixableErrorCount: messages.filter(({ severity, fix }) => severity === 2 && fix).length,
    fixableWarningCount: messages.filter(({ severity, fix }) => severity === 1 && fix).length,
  };
});
const lintErrors = lintResults.reduce((total, { errorCount }) => total + errorCount, 0);
const lintWarnings = lintResults.reduce((total, { warningCount }) => total + warningCount, 0);
if (lintErrors > 0 || lintWarnings > 0) {
  const formatter = await eslint.loadFormatter('stylish');
  const formatted = await formatter.format(lintResults);
  if (formatted.trim()) console.error(formatted);
}

const functions = [];
for (const result of results) {
  const file = path.relative(workspace, result.filePath);
  for (const message of result.messages) {
    if (message.ruleId !== 'complexity') continue;
    const match = message.message.match(/^(?<label>.+) has a complexity of (?<value>\d+)\./u);
    if (!match?.groups) throw new Error(`Could not parse ESLint complexity message: ${message.message}`);
    functions.push({
      key: `${file}::${match.groups.label}`,
      file,
      label: match.groups.label,
      line: message.line,
      complexity: Number(match.groups.value),
    });
  }
}

const rankFor = (complexity) => {
  if (complexity <= 5) return 'A';
  if (complexity <= 10) return 'B';
  if (complexity <= 20) return 'C';
  if (complexity <= 30) return 'D';
  if (complexity <= 40) return 'E';
  return 'F';
};

const ranks = { A: 0, B: 0, C: 0, D: 0, E: 0, F: 0 };
for (const entry of functions) ranks[rankFor(entry.complexity)] += 1;

const currentHotspots = functions.filter(({ complexity }) => complexity > baseline.maximumNewComplexity);
const duplicateHotspotKeys = currentHotspots
  .map(({ key }) => key)
  .filter((key, index, keys) => keys.indexOf(key) !== index);
if (duplicateHotspotKeys.length > 0) {
  throw new Error(`Hotspot keys must be unique; duplicate: ${duplicateHotspotKeys[0]}`);
}
const currentByKey = new Map(currentHotspots.map((entry) => [entry.key, entry]));
const failures = [];
for (const entry of currentHotspots) {
  const ceiling = baseline.hotspots[entry.key];
  if (ceiling === undefined) {
    failures.push(`${entry.file}:${entry.line} ${entry.label} is a new ${rankFor(entry.complexity)} hotspot at ${entry.complexity}`);
  } else if (entry.complexity > ceiling) {
    failures.push(`${entry.file}:${entry.line} ${entry.label} increased from ${ceiling} to ${entry.complexity}`);
  } else if (entry.complexity < ceiling) {
    failures.push(`${entry.file}:${entry.line} ${entry.label} improved from ${ceiling} to ${entry.complexity}; lower its baseline`);
  }
}
for (const [key] of Object.entries(baseline.hotspots)) {
  if (!currentByKey.has(key)) failures.push(`${key} is no longer above C; remove its stale baseline`);
}

const sortedHotspots = [...currentHotspots].sort(
  (left, right) => right.complexity - left.complexity || left.key.localeCompare(right.key)
);
console.log(
  `Cyclomatic complexity (classic McCabe): ${functions.length} functions; `
  + `A ${ranks.A}, B ${ranks.B}, C ${ranks.C}, D ${ranks.D}, E ${ranks.E}, F ${ranks.F}.`
);
for (const entry of sortedHotspots) {
  console.log(`  ${rankFor(entry.complexity)} ${String(entry.complexity).padStart(3)}  ${entry.file}:${entry.line}  ${entry.label}`);
}

if (lintErrors > 0 || lintWarnings > 0) {
  console.error(`Lint gate failed: ${lintErrors} errors and ${lintWarnings} warnings.`);
}
if (failures.length > 0) {
  for (const failure of failures) console.error(`Complexity gate failed: ${failure}`);
}
if (lintErrors > 0 || lintWarnings > 0 || failures.length > 0) {
  process.exit(1);
}
console.log('Lint passed with zero warnings.');
console.log(`Complexity ratchet passed: new functions must remain at C (<=${baseline.maximumNewComplexity}) or better.`);
