import { env as testEnv } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  buildAssetUrl,
  deleteAudio,
  deleteImage,
  generateAudioUploadUrl,
  generateToolUploadUrlBase,
  generateUploadUrl,
  getAndDeleteAudio,
  getAndDeleteImage,
  getAudio,
  getAudioKey,
  getImage,
  getImageKey,
  getInputImageKey,
  getInputImageUrl,
  getJobOutputKey,
  getPublicAudioUrl,
  getPublicImageUrl,
  getPublicJobOutputUrl,
  getPublicToolArtifactUrl,
  getToolArtifactKey,
  storeAudio,
  storeImage,
  storeJobOutput,
  storeToolArtifact,
} from '../src/r2';
import type { Env } from '../src/types';

const env = testEnv as unknown as Env;

describe('R2 media contracts', () => {
  it('derives stable keys, extensions, sanitized artifact names, and upload URLs', () => {
    expect(buildAssetUrl(env, 'relay/u/j.png')).not.toContain('//relay/');
    expect(getImageKey('u', 'j')).toBe('relay/u/j.png');
    expect(getAudioKey('u', 't')).toBe('relay/u/t.wav');
    expect(getInputImageKey('u', 'j')).toBe('inputs-inline/u/j.jpg');
    expect(getInputImageUrl(env, 'u', 'j')).toContain('/inputs-inline/u/j.jpg');
    expect(getPublicImageUrl(env, 'u', 'j')).toContain('/relay/u/j.png');
    expect(getPublicAudioUrl(env, 'u', 't')).toContain('/relay/u/t.wav');

    const extensions = [
      ['video/mp4', 'mp4'],
      ['audio/wav', 'wav'],
      ['audio/x-wav', 'wav'],
      ['audio/mpeg', 'mp3'],
      ['application/json', 'json'],
      ['text/markdown', 'md'],
      ['text/plain', 'txt'],
      ['image/jpeg', 'jpg'],
      ['image/png', 'png'],
    ] as const;
    for (const [contentType, extension] of extensions) {
      expect(getJobOutputKey('u', 'j', contentType)).toBe(`relay/u/j.${extension}`);
      expect(getPublicJobOutputUrl(env, 'u', 'j', contentType)).toContain(`j.${extension}`);
    }

    expect(getToolArtifactKey('u', 'tool', ' report / final ', 'application/json'))
      .toBe('relay/u/tool/report-final.json');
    expect(getToolArtifactKey('u', 'tool', 'report.md', 'text/plain'))
      .toBe('relay/u/tool/report.md');
    expect(getToolArtifactKey('u', 'tool', '***', 'image/png'))
      .toBe('relay/u/tool/artifact.png');
    expect(getToolArtifactKey('u', 'tool', 'a'.repeat(200), 'text/plain')).toHaveLength(
      'relay/u/tool/'.length + 160 + '.txt'.length
    );
    expect(getPublicToolArtifactUrl(env, 'u', 'tool', 'report', 'application/json'))
      .toContain('/relay/u/tool/report.json');

    expect(generateUploadUrl('https://relay.example', 'owner one', 'job'))
      .toBe('https://relay.example/api/upload/owner%20one/job');
    expect(generateToolUploadUrlBase('https://relay.example', 'owner one', 'tool'))
      .toBe('https://relay.example/api/tool-upload/owner%20one/tool');
    expect(generateAudioUploadUrl('https://relay.example', 'owner one', 'talk'))
      .toBe('https://relay.example/api/audio-upload/owner%20one/talk');
  });

  it('stores, reads, base64-encodes, and deletes image and audio payloads', async () => {
    const suffix = crypto.randomUUID();
    const bytes = new Uint8Array([0, 1, 2, 253, 254, 255]).buffer;
    const imageId = `image-${suffix}`;
    const talkId = `talk-${suffix}`;

    await expect(storeImage(env, 'r2-test', imageId, bytes)).resolves.toContain(
      `/relay/r2-test/${imageId}.png`
    );
    await expect(getImage(env, 'r2-test', imageId)).resolves.toBe('AAEC/f7/');
    await expect(getAndDeleteImage(env, 'r2-test', imageId)).resolves.toBe('AAEC/f7/');
    await expect(getImage(env, 'r2-test', imageId)).resolves.toBeNull();
    await expect(deleteImage(env, 'r2-test', imageId)).resolves.toBe(true);

    await expect(storeAudio(env, 'r2-test', talkId, bytes)).resolves.toContain(
      `/relay/r2-test/${talkId}.wav`
    );
    await expect(getAudio(env, 'r2-test', talkId)).resolves.toBe('AAEC/f7/');
    await expect(getAndDeleteAudio(env, 'r2-test', talkId)).resolves.toBe('AAEC/f7/');
    await expect(getAudio(env, 'r2-test', talkId)).resolves.toBeNull();
    await expect(deleteAudio(env, 'r2-test', talkId)).resolves.toBe(true);
  });

  it('stores typed job outputs and tool artifacts with normalized fallback media types', async () => {
    const suffix = crypto.randomUUID();
    const bytes = new Uint8Array([4, 5, 6]).buffer;

    await expect(storeJobOutput(env, 'r2-test', `job-${suffix}`, bytes, 'video/mp4'))
      .resolves.toContain('.mp4');
    await expect(storeJobOutput(env, 'r2-test', `fallback-${suffix}`, bytes, ''))
      .resolves.toContain('.png');
    await expect(storeToolArtifact(env, 'r2-test', `tool-${suffix}`, 'result', bytes, 'text/markdown'))
      .resolves.toContain('/result.md');
    await expect(storeToolArtifact(env, 'r2-test', `fallback-${suffix}`, 'result', bytes, ''))
      .resolves.toContain('/result.png');
  });
});
