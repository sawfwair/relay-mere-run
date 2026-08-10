import { describe, expect, it } from 'vitest';
import { handleClientApi } from '../src/client-api';
import type { Env } from '../src/types';

interface ForwardedRequest {
  method: string;
  pathname: string;
  search: string;
  body: string;
  contentType: string | null;
  userId: string | null;
}

function routingEnv(
  respond: (request: Request) => Response = () => new Response(null, { status: 204 })
) {
  const forwarded: ForwardedRequest[] = [];
  const stored: Array<{ key: string }> = [];
  const relay = {
    async fetch(request: Request): Promise<Response> {
      forwarded.push({
        method: request.method,
        pathname: new URL(request.url).pathname,
        search: new URL(request.url).search,
        body: request.body
          ? new TextDecoder().decode(await request.arrayBuffer())
          : '',
        contentType: request.headers.get('Content-Type'),
        userId: request.headers.get('X-User-Id'),
      });
      return respond(request);
    },
  };
  const env = {
    MERE_RUN_RELAY: {
      idFromName(name: string) { return name; },
      get() { return relay; },
    },
    IMAGES: {
      put(key: string): Promise<R2Object> {
        stored.push({ key });
        return Promise.resolve({ key } as R2Object);
      },
    },
    MERE_RUN_ASSET_BASE_URL: 'https://assets.example/',
  } as unknown as Env;
  return { env, forwarded, stored };
}

function apiRequest(
  path: string,
  method: string,
  body?: unknown,
  contentType = 'application/json'
): Request {
  return new Request(`https://relay.example/api${path}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': contentType },
    body: body === undefined
      ? undefined
      : contentType === 'application/json'
        ? JSON.stringify(body)
        : body as BodyInit,
  });
}

describe('client API routing', () => {
  it('forwards graph, fleet, and status control-plane routes without changing semantics', async () => {
    const { env, forwarded } = routingEnv();
    const routes = [
      ['GET', '/graph-jobs/capabilities', undefined, '/internal/graph-jobs/capabilities'],
      ['GET', '/graph-jobs/telemetry', undefined, '/internal/graph-jobs/telemetry'],
      ['POST', '/graph-jobs/preflight', {}, '/internal/graph-jobs/preflight'],
      ['GET', '/graph-jobs?limit=7', undefined, '/internal/graph-jobs'],
      ['PUT', `/graph-jobs/job-1/assets/${'a'.repeat(64)}`, 'asset', `/internal/graph-jobs/job-1/assets/${'a'.repeat(64)}`],
      ['POST', '/graph-jobs/job-1/commit', undefined, '/internal/graph-jobs/job-1/commit'],
      ['GET', '/graph-jobs/job-1/events', undefined, '/internal/graph-jobs/job-1/events'],
      ['POST', '/graph-jobs/job-1/retry', undefined, '/internal/graph-jobs/job-1/retry'],
      ['GET', '/graph-jobs/job-1/run-manifest', undefined, '/internal/graph-jobs/job-1/run-manifest'],
      ['GET', '/graph-jobs/job-1/artifacts/output', undefined, '/internal/graph-jobs/job-1/artifacts/output'],
      ['GET', '/graph-jobs/job-1', undefined, '/internal/graph-jobs/job-1'],
      ['DELETE', '/graph-jobs/job-1', undefined, '/internal/graph-jobs/job-1'],
      ['GET', '/status', undefined, '/internal/status'],
      ['GET', '/fleet', undefined, '/internal/fleet'],
      ['PATCH', '/fleet/settings', { scheduler_mode: 'balanced' }, '/internal/fleet/settings'],
      ['PATCH', '/fleet/nodes/device%201', { enabled: true }, '/internal/fleet/nodes/device%201'],
      ['POST', '/fleet/nodes/device%201/refresh', undefined, '/internal/fleet/nodes/device%201/refresh'],
      ['POST', '/fleet/model-plans', { target_device_ids: ['node'] }, '/internal/fleet/model-plans'],
      ['GET', '/fleet/model-plans?limit=3', undefined, '/internal/fleet/model-plans'],
      ['POST', '/fleet/model-plans/plan%201/apply', {}, '/internal/fleet/model-plans/plan%201/apply'],
      ['GET', '/fleet/model-plans/plan%201', undefined, '/internal/fleet/model-plans/plan%201'],
      ['DELETE', '/fleet/model-plans/plan%201', undefined, '/internal/fleet/model-plans/plan%201'],
    ] as const;

    for (const [method, path, body, expectedPath] of routes) {
      const response = await handleClientApi(apiRequest(path, method, body), env, 'user-12345678');
      expect(response.status).toBe(204);
      expect(forwarded.at(-1)?.pathname).toBe(expectedPath);
      expect(forwarded.at(-1)?.method).toBe(method);
    }
    expect(forwarded[3]?.search).toBe('?limit=7');
    expect(forwarded[18]?.search).toBe('?limit=3');
  });

  it('adds relay-owned envelope fields to generation and workload submissions', async () => {
    const { env, forwarded } = routingEnv();
    const submissions = [
      ['/generate', { prompt: 'image' }, '/internal/submit'],
      ['/video', {
        prompt: 'video',
        input_image_url: 'https://assets.example/start.png',
        end_image_url: 'https://assets.example/end.png',
        end_image_strength: 0.8,
      }, '/internal/submit'],
      ['/music', { prompt: 'music' }, '/internal/submit'],
      ['/chat', { messages: [{ role: 'user', content: 'hello' }] }, '/internal/chat/submit'],
      ['/tools/run', { command: 'inspect' }, '/internal/tool/submit'],
      ['/talk', { text: 'hello' }, '/internal/talk/submit'],
      ['/asr', { audio_url: 'https://assets.example/audio.wav' }, '/internal/asr/submit'],
      ['/embed', { texts: ['hello'] }, '/internal/embed/submit'],
      ['/ocr', { image_url: 'https://assets.example/image.png' }, '/internal/ocr/submit'],
    ] as const;

    for (const [path, body, expectedPath] of submissions) {
      const response = await handleClientApi(apiRequest(path, 'POST', body), env, 'user-12345678');
      expect(response.status).toBe(204);
      const call = forwarded.at(-1);
      expect(call?.pathname).toBe(expectedPath);
      expect(JSON.parse(call?.body ?? '{}')).toMatchObject({ client_id: 'client_12345678' });
    }

    expect(JSON.parse(forwarded[1]?.body ?? '{}')).toMatchObject({
      kind: 'video',
      model: 'video-ltx23-av-mlx',
      end_image_url: 'https://assets.example/end.png',
      end_image_strength: 0.8,
    });
    expect(JSON.parse(forwarded[2]?.body ?? '{}')).toMatchObject({
      kind: 'music',
      model: 'music-acestep',
    });
  });

  it('forwards job and modality cancellations plus owner-scoped uploads', async () => {
    const { env, forwarded } = routingEnv();
    const routes = [
      ['DELETE', '/job/job-1', undefined, '/internal/job/job-1'],
      ['DELETE', '/job/job-1/image', undefined, '/internal/job/job-1/image'],
      ['DELETE', '/tools/jobs/tool-1', undefined, '/internal/tool/tool-1'],
      ['GET', '/chat/chat-1', undefined, '/internal/chat/chat-1'],
      ['DELETE', '/talk/talk-1', undefined, '/internal/talk/talk-1'],
      ['DELETE', '/talk/talk-1/audio', undefined, '/internal/talk/talk-1/audio'],
      ['DELETE', '/asr/asr-1', undefined, '/internal/asr/asr-1'],
      ['DELETE', '/embed/embed-1', undefined, '/internal/embed/embed-1'],
      ['DELETE', '/ocr/ocr-1', undefined, '/internal/ocr/ocr-1'],
      ['POST', '/upload/owner%201/job-1', 'image', '/internal/upload/job-1'],
      ['POST', '/tool-upload/owner%201/tool-1/report.json', 'artifact', '/internal/tool-upload/tool-1/report.json'],
      ['POST', '/audio-upload/owner%201/talk-1', 'audio', '/internal/audio-upload/talk-1'],
    ] as const;

    for (const [method, path, body, expectedPath] of routes) {
      const request = body === undefined
        ? apiRequest(path, method)
        : apiRequest(path, method, body, 'application/octet-stream');
      const response = await handleClientApi(request, env, 'uploader');
      expect(response.status).toBe(204);
      expect(forwarded.at(-1)?.pathname).toBe(expectedPath);
    }
    expect(forwarded.at(-3)?.userId).toBe('owner 1');
    expect(forwarded.at(-2)?.userId).toBe('owner 1');
    expect(forwarded.at(-1)?.userId).toBe('owner 1');
  });

  it('stores bounded client media uploads with stable public URLs', async () => {
    const { env, stored } = routingEnv();
    const uploads = [
      ['/input-upload', 'image/jpeg', 'image'],
      ['/asr/input-upload', 'audio/mpeg', 'audio'],
      ['/ocr/input-upload', 'image/png', 'ocr'],
    ] as const;

    for (const [path, contentType, body] of uploads) {
      const response = await handleClientApi(apiRequest(path, 'POST', body, contentType), env, 'user-1');
      expect(response.status).toBe(200);
      const payload: unknown = await response.json();
      expect(payload).toBeTypeOf('object');
      expect(payload).not.toBeNull();
      expect('url' in (payload as Record<string, unknown>)).toBe(true);
      expect((payload as Record<string, unknown>).url).toBeTypeOf('string');
      expect(String((payload as Record<string, unknown>).url)).toContain(
        'https://assets.example/inputs/user-1/'
      );
    }
    expect(stored).toHaveLength(3);
    expect(stored[0]?.key).toMatch(/\.jpg$/);
    expect(stored[1]?.key).toMatch(/\.mp3$/);
    expect(stored[2]?.key).toMatch(/\.png$/);
  });

  it('returns 400 before forwarding invalid request JSON', async () => {
    const { env, forwarded } = routingEnv();
    const response = await handleClientApi(apiRequest('/generate', 'POST', { prompt: 99 }), env, 'user-1');
    expect(response.status).toBe(400);
    expect(forwarded).toHaveLength(0);
  });

  it('validates and returns every persisted workload status shape', async () => {
    const timestamp = '2026-07-22T12:00:00.000Z';
    const responses: Record<string, unknown> = {
      '/internal/job/job-1': {
        job_id: 'job-1',
        user_id: 'user-1',
        client_id: 'client-1',
        agent_id: null,
        status: 'queued',
        request: {
          prompt: 'hello',
          negative_prompt: null,
          width: 1024,
          height: 1024,
          steps: 4,
          seed: null,
          input_image_url: null,
          input_image_data: null,
          input_strength: null,
          reference_image_urls: null,
        },
        progress: null,
        result: null,
        error: null,
        created_at: timestamp,
        assigned_at: null,
        started_at: null,
        completed_at: null,
        direct_image: false,
      },
      '/internal/tool/tool-1': {
        tool_id: 'tool-1',
        user_id: 'user-1',
        client_id: 'client-1',
        agent_id: null,
        status: 'queued',
        request: { plugin: 'tools', command: 'run', inputs: {}, options: {} },
        progress: null,
        result: null,
        error: null,
        created_at: timestamp,
        started_at: null,
        completed_at: null,
      },
      '/internal/talk/talk-1': {
        talk_id: 'talk-1',
        user_id: 'user-1',
        client_id: 'client-1',
        agent_id: null,
        status: 'queued',
        request: {
          text: 'hello',
          voice_description: null,
          speed: 1,
          temperature: 0.7,
          output_format: 'wav',
        },
        result: null,
        error: null,
        created_at: timestamp,
        started_at: null,
        completed_at: null,
        direct_audio: false,
      },
      '/internal/asr/asr-1': {
        asr_id: 'asr-1',
        user_id: 'user-1',
        client_id: 'client-1',
        agent_id: null,
        status: 'queued',
        request: {
          audio_url: 'https://assets/audio.wav',
          language: null,
          task: 'transcribe',
          diarize: false,
          max_tokens: 256,
        },
        result: null,
        error: null,
        created_at: timestamp,
        started_at: null,
        completed_at: null,
      },
      '/internal/embed/embed-1': {
        embed_id: 'embed-1',
        user_id: 'user-1',
        client_id: 'client-1',
        agent_id: null,
        status: 'queued',
        request: { texts: ['hello'], model: 'embed', max_tokens: 256 },
        result: null,
        error: null,
        created_at: timestamp,
        started_at: null,
        completed_at: null,
      },
      '/internal/ocr/ocr-1': {
        ocr_id: 'ocr-1',
        user_id: 'user-1',
        client_id: 'client-1',
        agent_id: null,
        status: 'queued',
        request: { image_url: 'https://assets/image.png', max_tokens: 256, temperature: 0 },
        result: null,
        error: null,
        created_at: timestamp,
        started_at: null,
        completed_at: null,
      },
    };
    const { env } = routingEnv((request) => {
      const body = responses[new URL(request.url).pathname];
      return body ? Response.json(body) : Response.json({ error: 'not found' }, { status: 404 });
    });

    for (const path of [
      '/job/job-1',
      '/tools/jobs/tool-1',
      '/talk/talk-1',
      '/asr/asr-1',
      '/embed/embed-1',
      '/ocr/ocr-1',
    ]) {
      const response = await handleClientApi(apiRequest(path, 'GET'), env, 'user-1');
      expect(response.status).toBe(200);
      const body: unknown = await response.json();
      expect(body).toBeTypeOf('object');
    }

    const missing = await handleClientApi(apiRequest('/unknown', 'GET'), env, 'user-1');
    expect(missing.status).toBe(404);
  });
});
