import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import ts from 'typescript';

const workspace = process.cwd();
const sourceRoots = ['src', 'web/src', 'clients/typescript', 'node/src'];
const sourceExtensions = new Set(['.ts', '.tsx']);

async function sourceFiles(directory) {
  const absolute = path.join(workspace, directory);
  const entries = await readdir(absolute, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(absolute, entry.name);
    if (entry.isDirectory()) return sourceFiles(path.relative(workspace, entryPath));
    return sourceExtensions.has(path.extname(entry.name)) ? [entryPath] : [];
  }));
  return nested.flat();
}

async function resolveRelativeImport(fromFile, specifier) {
  const candidate = path.resolve(path.dirname(fromFile), specifier);
  const candidates = path.extname(candidate)
    ? [candidate, candidate.replace(/\.js$/u, '.ts'), candidate.replace(/\.js$/u, '.tsx')]
    : [`${candidate}.ts`, `${candidate}.tsx`, path.join(candidate, 'index.ts'), path.join(candidate, 'index.tsx')];
  for (const file of candidates) {
    try {
      if ((await stat(file)).isFile()) return file;
    } catch {
      // Try the next TypeScript resolution candidate.
    }
  }
  return null;
}

async function runtimeImports(file) {
  const sourceText = await readFile(file, 'utf8');
  const source = ts.createSourceFile(
    file,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const imports = [];
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
    if (statement.isTypeOnly || statement.importClause?.isTypeOnly) continue;
    if (!statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const specifier = statement.moduleSpecifier.text;
    if (!specifier.startsWith('.')) continue;
    const resolved = await resolveRelativeImport(file, specifier);
    if (resolved) imports.push(resolved);
  }
  return imports;
}

const files = (await Promise.all(sourceRoots.map(sourceFiles))).flat();
const graph = new Map();
for (const file of files) graph.set(file, await runtimeImports(file));

const visited = new Set();
const active = new Set();
const stack = [];

function findCycle(file) {
  if (active.has(file)) {
    const start = stack.indexOf(file);
    return [...stack.slice(start), file];
  }
  if (visited.has(file)) return null;
  visited.add(file);
  active.add(file);
  stack.push(file);
  for (const dependency of graph.get(file) ?? []) {
    const cycle = findCycle(dependency);
    if (cycle) return cycle;
  }
  stack.pop();
  active.delete(file);
  return null;
}

for (const file of files) {
  const cycle = findCycle(file);
  if (!cycle) continue;
  const display = cycle.map((entry) => path.relative(workspace, entry)).join(' -> ');
  console.error(`Runtime import cycle detected: ${display}`);
  process.exit(1);
}

console.log(`Architecture check passed: ${files.length} production modules, no runtime import cycles.`);
