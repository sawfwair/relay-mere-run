import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { MereRunRelay } from '../src/MereRunRelay';
import type { Job, JobStatusResponse } from '../src/types';
import { capabilitiesWithModels, closeWebSocket, connectAgent, readJson, submitJob, waitForWebSocketJson } from './helpers';

// Direct delivery may exceed the Durable Object per-value limit. Inline bytes
// belong to the warm response; the terminal receipt must still survive restart.
describe('direct image completion persistence', () => {
  it.each(['image_data', 'media_data'] as const)('retains completed state after large %s delivery and object reconstruction', async (field) => {
    const owner = `direct-image-owner-${crypto.randomUUID()}`;
    const agent = await connectAgent(owner, capabilitiesWithModels(['image-test']));
    try {
      const submitted = await readJson<{ job_id: string }>(await submitJob(agent.relay, owner, {
        prompt: 'test', model: 'image-test', direct_image: true,
      }));
      await waitForWebSocketJson(agent.ws);
      const outcome = await runInDurableObject(agent.relay, async (_instance, state) => {
        const active = new MereRunRelay(state, env);
        const socket = state.getWebSockets()[0];
        await active.webSocketMessage(socket, JSON.stringify({ type: 'progress', job_id: submitted.job_id, step: 1, total_steps: 4 }));
        // Miniflare does not enforce the production KV-backed DO 128 KiB value limit.
        // https://developers.cloudflare.com/durable-objects/api/legacy-kv-storage-api/
        const originalPut = state.storage.put.bind(state.storage);
        const put = vi.spyOn(state.storage, 'put').mockImplementation(async (...args) => {
          const value = typeof args[0] === 'string' ? args[1] : args[0];
          if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 128 * 1024) {
            throw new RangeError('KV-backed Durable Object value exceeds 128 KiB');
          }
          return Reflect.apply(originalPut, state.storage, args);
        });
        const image = Array.from({ length: 15_000 }, () => crypto.randomUUID().replaceAll('-', '')).join('');
        await active.webSocketMessage(socket, JSON.stringify({ type: 'result', job_id: submitted.job_id,
          success: true, [field]: image, seed: 42, generation_time_ms: 100 }));
        put.mockRestore();
        const request = () => new Request(`https://relay/internal/job/${submitted.job_id}`);
        const warm = await readJson<JobStatusResponse>(await active.fetch(request()));
        const stored = await state.storage.get<Job>(`job:${submitted.job_id}`);
        const fresh = new MereRunRelay(state, env);
        const restored = await readJson<JobStatusResponse>(await fresh.fetch(request()));
        return { warmStatus: warm.status, deliveredBytes: warm.result?.image_data?.length,
          storedSeed: stored?.result?.seed, storedStatus: stored?.status, restoredStatus: restored.status,
          persistedInlineBytes: (stored?.result?.image_data?.length ?? 0) + (stored?.result?.media_data?.length ?? 0) };
      });
      expect(outcome.warmStatus).toBe('complete');
      expect(outcome.deliveredBytes).toBe(480_000);
      expect(outcome.storedStatus).toBe('complete');
      expect(outcome.storedSeed).toBe(42);
      expect(outcome.restoredStatus).toBe('complete');
      expect(outcome.persistedInlineBytes).toBe(0);
    } finally { closeWebSocket(agent.ws); }
  });
});
