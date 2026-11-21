import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./node-release-manifest.mjs', import.meta.url));
const version = '0.2.24';
const sha256 = 'a'.repeat(64);
const macosPrefix = 'releases/mere-run-node/macos/';
const archive = `mere.run-node-${version}-aarch64-notarized.dmg`;

function writeManifest(t, key, platform = 'macos', filename = archive) {
  const directory = mkdtempSync(join(tmpdir(), 'node-release-manifest-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const output = join(directory, 'latest.json');
  const arch = platform === 'macos' ? 'aarch64' : 'arm64';
  const contentType = platform === 'macos' ? 'application/x-apple-diskimage' : 'application/vnd.debian.binary-package';
  const result = spawnSync(process.execPath, [
    cli, 'write', output, version, platform, arch, key, filename, contentType, '123', sha256,
  ], { encoding: 'utf8' });
  assert.ifError(result.error);
  return { ...result, manifest: result.status === 0 ? JSON.parse(readFileSync(output, 'utf8')) : null };
}

test('writes a macOS manifest for its checksum-addressed Sparkle DMG', (t) => {
  const key = `${macosPrefix}updates/${sha256}/${archive}`;
  const result = writeManifest(t, key);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.manifest.key, key);
  assert.equal(result.manifest.sha256, sha256);
});

test('rejects unrelated nested paths and mismatched Sparkle checksums or versions', (t) => {
  for (const path of [`nested/${archive}`, `updates/${'b'.repeat(64)}/${archive}`, `updates/${sha256}/${archive.replace(version, '0.2.25')}`]) {
    const result = writeManifest(t, `${macosPrefix}${path}`);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Artifact key must be an immutable object/);
  }
});

test('preserves the legacy macOS and Linux release paths', (t) => {
  const macOS = writeManifest(t, `${macosPrefix}${archive}`);
  assert.equal(macOS.status, 0, macOS.stderr);
  const deb = `mere.run-node-${version}-arm64.deb`;
  const linux = writeManifest(t, `releases/mere-run-node/linux/arm64/deb/${deb}`, 'linux', deb);
  assert.equal(linux.status, 0, linux.stderr);
});
