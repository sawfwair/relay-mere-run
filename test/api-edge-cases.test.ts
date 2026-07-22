import { env as testEnv } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { readJson } from './helpers';

type JsonRecord = Record<string, unknown>;

function accountRelay(userId: string): DurableObjectStub {
  return testEnv.MERE_RUN_RELAY.get(testEnv.MERE_RUN_RELAY.idFromName(userId));
}

function jsonRequest(userId: string, path: string, method: string, body?: unknown): Request {
  return new Request(`https://relay${path}`, {
    method,
    headers: {
      'X-User-Id': userId,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe('relay API edge cases', () => {
  it('rejects every workload lane without a capable node and leaves no phantom queue entries', async () => {
    const userId = `queued-${crypto.randomUUID()}`;
    const relay = accountRelay(userId);
    const submissions = [
      ['/internal/submit', { client_id: 'client', prompt: 'image' }, 'job_id'],
      ['/internal/chat/submit', {
        client_id: 'client',
        messages: [{ role: 'user', content: 'hello' }],
      }, 'chat_id'],
      ['/internal/talk/submit', { client_id: 'client', text: 'hello' }, 'talk_id'],
      ['/internal/asr/submit', {
        client_id: 'client',
        audio_url: 'https://assets.example/audio.wav',
      }, 'asr_id'],
      ['/internal/embed/submit', { client_id: 'client', texts: ['hello'] }, 'embed_id'],
      ['/internal/ocr/submit', {
        client_id: 'client',
        image_url: 'https://assets.example/image.png',
      }, 'ocr_id'],
      ['/internal/tool/submit', { client_id: 'client', command: 'inspect' }, 'tool_id'],
    ] as const;
    for (const [path, body, idField] of submissions) {
      const response = await relay.fetch(jsonRequest(userId, path, 'POST', body));
      expect(response.status).toBe(503);
      const payload = await readJson<JsonRecord>(response);
      expect(payload.error).toBeTypeOf('string');
      expect(payload[idField]).toBeUndefined();
    }

    const status = await relay.fetch(jsonRequest(userId, '/internal/status', 'GET'));
    expect(status.status).toBe(200);
    await expect(readJson<JsonRecord>(status)).resolves.toMatchObject({ agents: [], queue_depth: 0 });
  });

  it('returns explicit not-found responses for missing persisted work and uploads', async () => {
    const userId = `missing-${crypto.randomUUID()}`;
    const relay = accountRelay(userId);
    const routes = [
      ['GET', '/internal/job/missing'],
      ['GET', '/internal/chat/missing'],
      ['GET', '/internal/talk/missing'],
      ['GET', '/internal/asr/missing'],
      ['GET', '/internal/embed/missing'],
      ['GET', '/internal/ocr/missing'],
      ['GET', '/internal/tool/missing'],
      ['DELETE', '/internal/talk/missing/audio'],
      ['POST', '/internal/audio-upload/missing'],
      ['POST', '/internal/tool-upload/missing/artifact'],
    ] as const;

    for (const [method, path] of routes) {
      const response = await relay.fetch(jsonRequest(userId, path, method));
      expect(response.status).toBe(404);
      const payload = await readJson<JsonRecord>(response);
      expect(payload.error).toBeTypeOf('string');
    }
  });
});
