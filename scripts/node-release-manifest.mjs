#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';

const fail = (message) => {
  console.error(message);
  process.exit(1);
};

const inferFormat = (platform, filename) => {
  if (platform === 'macos') return 'dmg';
  if (filename.endsWith('.deb')) return 'deb';
  return 'appimage';
};

const validateRelease = ({ version, platform, arch, format, key, filename, contentType, size, sha256 }) => {
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) fail(`Invalid version: ${version}`);
  if (!['macos', 'linux'].includes(platform)) fail(`Invalid platform: ${platform}`);
  if (!['aarch64', 'x86_64', 'arm64'].includes(arch)) fail(`Invalid architecture: ${arch}`);
  if (!['dmg', 'appimage', 'deb'].includes(format)) fail(`Invalid release format: ${format}`);
  if ((platform === 'macos') !== (format === 'dmg')) fail(`Invalid ${format} format for platform ${platform}`);
  const expectedPrefix = platform === 'macos'
    ? 'releases/mere-run-node/macos/'
    : `releases/mere-run-node/linux/${arch}/${format === 'deb' ? 'deb/' : ''}`;
  const relativeKey = key.slice(expectedPrefix.length);
  if (
    !key.startsWith(expectedPrefix) ||
    !relativeKey ||
    relativeKey.includes('/') ||
    key.includes('..') ||
    key.endsWith('/latest.json')
  ) {
    fail(`Artifact key must be an immutable object under ${expectedPrefix}`);
  }
  if (!filename || /[/\r\n"]/u.test(filename)) fail(`Invalid filename: ${filename}`);
  const expectedExtension = { dmg: '.dmg', appimage: '.AppImage', deb: '.deb' }[format];
  if (!filename.endsWith(expectedExtension)) fail(`Expected ${format} filename ending in ${expectedExtension}`);
  const expectedContentType = {
    dmg: 'application/x-apple-diskimage',
    appimage: 'application/octet-stream',
    deb: 'application/vnd.debian.binary-package',
  }[format];
  if (contentType !== expectedContentType) fail(`Expected content type ${expectedContentType}`);
  if (!Number.isSafeInteger(size) || size <= 0) fail(`Invalid artifact size: ${size}`);
  if (!/^[a-f0-9]{64}$/.test(sha256)) fail('SHA-256 must be 64 lowercase hexadecimal characters');
};

const [command, ...args] = process.argv.slice(2);

if (command === 'write') {
  if (args.length !== 9 && args.length !== 10) {
    fail('Usage: node-release-manifest.mjs write OUTPUT VERSION PLATFORM ARCH KEY FILENAME CONTENT_TYPE SIZE SHA256 [FORMAT]');
  }
  const [output, version, platform, arch, key, filename, contentType, rawSize, sha256, requestedFormat] = args;
  const format = requestedFormat || inferFormat(platform, filename);
  const release = { version, platform, arch, format, key, filename, contentType, size: Number(rawSize), sha256 };
  validateRelease(release);
  writeFileSync(
    output,
    `${JSON.stringify({
      schema_version: 1,
      product: 'mere-run-node',
      version,
      platform,
      arch,
      format,
      key,
      filename,
      content_type: contentType,
      size: release.size,
      sha256,
      published_at: new Date().toISOString(),
    }, null, 2)}\n`,
  );
  process.exit(0);
}

if (command === 'verify-catalog') {
  if (args.length !== 5 && args.length !== 6) {
    fail('Usage: node-release-manifest.mjs verify-catalog CATALOG VERSION PLATFORM ARCH KEY [FORMAT]');
  }
  const [catalogPath, version, platform, arch, key, format] = args;
  const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
  const releases = Array.isArray(catalog?.releases) ? catalog.releases : [];
  const match = releases.find((release) =>
    release?.version === version &&
    release?.platform === platform &&
    release?.arch === arch &&
    (!format || release?.format === format) &&
    release?.source === 'r2-release-manifest'
  );
  if (!match) fail(`Public catalog does not advertise mere-run-node ${version} ${platform}/${arch}`);
  const verifyUrl = new URL(match.download_url);
  verifyUrl.searchParams.set('release', version);
  verifyUrl.searchParams.set('arch', arch);
  const response = await fetch(verifyUrl, { method: 'HEAD' });
  if (!response.ok) fail(`Catalog download URL returned ${response.status}: ${match.download_url}`);
  if (response.headers.get('X-Release-Key') !== key) {
    fail(`Catalog download resolves to ${response.headers.get('X-Release-Key') || '<missing>'}, expected ${key}`);
  }
  process.exit(0);
}

fail('Expected command: write or verify-catalog');
