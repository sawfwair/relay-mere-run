import { describe, expect, it } from 'vitest';
import { submitJobRequestSchema } from '../src/contracts/requests';
import { capabilitiesWithModels, closeWebSocket, connectAgent, readJson, submitJob, waitForWebSocketJson } from './helpers';

describe('video request controls', () => {
  it.each([{ memory_policy: 'conservative' }, { max_oom_retries: 1 }, { preflight_required: 'true' }, { steps: 0.5 }])('rejects unsupported or invalid controls %j', (controls) => {
    expect(() => submitJobRequestSchema.parse({ kind: 'video', prompt: 'test', ...controls })).toThrow();
  });
  it('retains supported controls in the actual dispatched request', async () => {
    const user = crypto.randomUUID();
    const agent = await connectAgent(user, { ...capabilitiesWithModels(['video-test']), video_request_controls: 1 } as ReturnType<typeof capabilitiesWithModels>);
    try {
      const response = await submitJob(agent.relay, user, { kind: 'video', prompt: 'test', model: 'video-test', steps: 8, preflight_required: true, max_oom_retries: 0 } as Parameters<typeof submitJob>[2]);
      expect(response.status).toBe(200);
      const status = await readJson<Record<string, unknown>>(await agent.relay.fetch(new Request('https://relay/internal/status')));
      expect(status.video_request_controls).toBe(1);
      const message = await waitForWebSocketJson<Record<string, unknown>>(agent.ws);
      expect(message.request).toMatchObject({ steps: 8, preflight_required: true, max_oom_retries: 0, video_controls_version: 1 });
    } finally { closeWebSocket(agent.ws); }
  });
  it.each([undefined, 'selected'])('cannot dispatch explicit controls to an older Node (target %s)', async (target) => {
    const user = crypto.randomUUID();
    const agent = await connectAgent(user, capabilitiesWithModels(['video-test']), { deviceId: 'selected' });
    try {
      const response = await submitJob(agent.relay, user, { kind: 'video', prompt: 'test', model: 'video-test', steps: 8, required_device_id: target });
      expect(response.status).toBe(503);
      expect(await readJson<Record<string, unknown>>(response)).toMatchObject({ code: 'NO_COMPATIBLE_AGENTS' });
    } finally { closeWebSocket(agent.ws); }
  });
});
