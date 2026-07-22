import { describe, expect, it, vi } from 'vitest';
import {
  MereRunRelayClient,
  type JobStatusResponse,
  type MereRunRelayAuthorization,
} from '../clients/typescript/MereRunRelayClient';

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function createClient(fetchImpl: typeof fetch): MereRunRelayClient {
  const authorization: MereRunRelayAuthorization = { scheme: 'bearer', token: 'test' };
  return new MereRunRelayClient({
    authorization,
    baseUrl: 'https://relay.example',
    fetchImpl,
    timeoutMs: 2_000,
  });
}

describe('TypeScript client', () => {
  it('handles SSE stream events and resolves final status', async () => {
    const finalStatus: JobStatusResponse = {
      job_id: 'job_1',
      user_id: 'user_1',
      client_id: 'client_1',
      agent_id: 'agent_1',
      status: 'complete',
      request: {
        prompt: 'test',
        negative_prompt: null,
        width: 1024,
        height: 1024,
        steps: 4,
        seed: null,
        input_image_url: null,
        input_image_data: null,
        input_strength: null,
      },
      progress: { step: 4, total_steps: 4 },
      result: {
        image_url: 'https://example.com/image.png',
        seed: 1,
        generation_time_ms: 12,
      },
      error: null,
      created_at: new Date().toISOString(),
      assigned_at: new Date().toISOString(),
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      direct_image: false,
    };

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`event: connected\ndata: ${JSON.stringify({ job_id: 'job_1' })}\n\n`));
        controller.enqueue(encoder.encode(`event: job\ndata: ${JSON.stringify(finalStatus)}\n\n`));
        controller.enqueue(
          encoder.encode(`event: done\ndata: ${JSON.stringify({ job_id: 'job_1', status: 'complete' })}\n\n`)
        );
        controller.close();
      },
    });

    const fetchImpl = vi.fn(() => {
      return Promise.resolve(new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }));
    }) as unknown as typeof fetch;

    const client = createClient(fetchImpl);
    const connected: string[] = [];
    const updates: JobStatusResponse[] = [];
    const doneStatuses: string[] = [];
    const events: string[] = [];

    const result = await client.subscribeJobStream('job_1', {
      onConnected: (event) => connected.push(event.job_id),
      onUpdate: (event) => updates.push(event),
      onDone: (event) => doneStatuses.push(event.status),
      onEvent: (event) => events.push(event.type),
    });

    expect(result.status).toBe('complete');
    expect(connected).toEqual(['job_1']);
    expect(updates).toHaveLength(1);
    expect(doneStatuses).toEqual(['complete']);
    expect(events).toEqual(['connected', 'job', 'done']);
  });

  it('calls cancel endpoints for talk/asr/ocr', async () => {
    const calls: Array<{ path: string; method: string }> = [];
    const fetchImpl = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      calls.push({
        path: new URL(url).pathname,
        method: init?.method || 'GET',
      });
      return Promise.resolve(jsonResponse({ cancelled: true }));
    }) as unknown as typeof fetch;

    const client = createClient(fetchImpl);
    await client.cancelTalk('talk_1');
    await client.cancelAsr('asr_1');
    await client.cancelOcr('ocr_1');

    expect(calls).toEqual([
      { path: '/api/talk/talk_1', method: 'DELETE' },
      { path: '/api/asr/asr_1', method: 'DELETE' },
      { path: '/api/ocr/ocr_1', method: 'DELETE' },
    ]);
  });

  it('treats cancelled as terminal for talk/asr/ocr polling', async () => {
    const counters = new Map<string, number>();
    const timestamp = '2026-07-22T12:00:00.000Z';
    const common = (id: string, status: 'processing' | 'cancelled') => ({
      user_id: 'user_1',
      client_id: 'client_1',
      agent_id: null,
      status,
      result: null,
      error: null,
      created_at: timestamp,
      started_at: null,
      completed_at: status === 'cancelled' ? timestamp : null,
      ...id.startsWith('talk') ? {
        talk_id: id,
        direct_audio: false,
        request: {
          text: 'hello',
          voice_description: null,
          speed: 1,
          temperature: 0.6,
          output_format: 'wav',
        },
      } : id.startsWith('asr') ? {
        asr_id: id,
        request: {
          audio_url: 'https://assets.example/audio.wav',
          language: null,
          task: 'transcribe',
          max_tokens: 512,
        },
      } : {
        ocr_id: id,
        request: {
          image_url: 'https://assets.example/image.png',
          max_tokens: 4096,
          temperature: 0.2,
        },
      },
    });
    const fetchImpl: typeof fetch = vi.fn((input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const path = new URL(url).pathname;
      const count = counters.get(path) ?? 0;
      counters.set(path, count + 1);

      if (path.endsWith('/talk/talk_1')) {
        return Promise.resolve(jsonResponse(common('talk_1', count === 0 ? 'processing' : 'cancelled')));
      }
      if (path.endsWith('/asr/asr_1')) {
        return Promise.resolve(jsonResponse(common('asr_1', count === 0 ? 'processing' : 'cancelled')));
      }
      if (path.endsWith('/ocr/ocr_1')) {
        return Promise.resolve(jsonResponse(common('ocr_1', count === 0 ? 'processing' : 'cancelled')));
      }

      return Promise.resolve(jsonResponse({ status: 'cancelled' }));
    });

    const client = createClient(fetchImpl);

    const talk = await client.pollTalk('talk_1', { intervalMs: 1, timeoutMs: 1_000 });
    const asr = await client.pollAsr('asr_1', { intervalMs: 1, timeoutMs: 1_000 });
    const ocr = await client.pollOcr('ocr_1', { intervalMs: 1, timeoutMs: 1_000 });

    expect(talk.status).toBe('cancelled');
    expect(asr.status).toBe('cancelled');
    expect(ocr.status).toBe('cancelled');
  });
});
