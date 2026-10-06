import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { MereRunRelay } from '../src/MereRunRelay';
import { capabilitiesWithModels, closeWebSocket, connectAgent, readJson, waitForWebSocketJson } from './helpers';

// Reconstruct the JS instance while retaining the real DurableObjectState and
// accepted WebSocket attachments, as Cloudflare does after hibernation.
describe('required node placement after hibernation', () => {
  it('accepts the owner after status still reports its connected target', async () => {
    const owner = `hibernated-owner-${crypto.randomUUID()}`;
    const device = `hibernated-node-${crypto.randomUUID()}`;
    const agent = await connectAgent(owner, capabilitiesWithModels(['image-test']), { deviceId: device });
    try {
      const outcome = await runInDurableObject(agent.relay, async (_instance, state) => {
        const restored = new MereRunRelay(state, env);
        const status = await readJson<{ agents: { device_id: string }[] }>(
          await restored.fetch(new Request('https://relay/internal/status', { headers: { 'X-User-Id': owner } }))
        );
        const submitted = await restored.fetch(new Request('https://relay/internal/submit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-User-Id': owner },
          body: JSON.stringify({ client_id: 'hibernation-test', prompt: 'test', model: 'image-test', required_device_id: device }),
        }));
        return { devices: status.agents.map((item) => item.device_id), status: submitted.status, body: await submitted.json() };
      });
      expect(outcome.devices).toContain(device);
      expect(outcome.status).toBe(200);
      expect(outcome.body).toMatchObject({ status: 'assigned' });
      expect(await waitForWebSocketJson<{ type: string }>(agent.ws)).toMatchObject({ type: 'job' });
    } finally {
      closeWebSocket(agent.ws);
    }
  });
  it('rejects a forged owner on a legacy cold object without rebinding it', async () => {
    const owner = `legacy-owner-${crypto.randomUUID()}`;
    const device = `legacy-node-${crypto.randomUUID()}`;
    const agent = await connectAgent(owner, capabilitiesWithModels(['image-test']), { deviceId: device });
    try {
      const outcome = await runInDurableObject(agent.relay, async (_instance, state) => {
        await state.storage.delete('relay:owner');
        const restored = new MereRunRelay(state, env);
        const request = (subject: string) => new Request('https://relay/internal/submit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-User-Id': subject },
          body: JSON.stringify({ client_id: 'legacy-test', prompt: 'test', model: 'image-test', required_device_id: device }),
        });
        const rejected = await restored.fetch(request('forged-owner'));
        const before = await state.storage.list({ prefix: 'job:' });
        const accepted = await restored.fetch(request(owner));
        return { rejected: rejected.status, rejectedBody: await rejected.json(), jobsBefore: before.size,
          accepted: accepted.status, retained: await state.storage.get('relay:owner') };
      });
      expect(outcome).toMatchObject({ rejected: 403, rejectedBody: { code: 'OWNER_SCOPE_MISMATCH' }, jobsBefore: 0, accepted: 200, retained: owner });
      await waitForWebSocketJson(agent.ws);
    } finally { closeWebSocket(agent.ws); }
  });

  it('restores the owner for socket events without an HTTP request', async () => {
    const owner = `socket-owner-${crypto.randomUUID()}`;
    const device = `socket-node-${crypto.randomUUID()}`;
    const capabilities = capabilitiesWithModels(['image-test']);
    const agent = await connectAgent(owner, capabilities, { deviceId: device });
    try {
      await runInDurableObject(agent.relay, async (_instance, state) => {
        const restored = new MereRunRelay(state, env);
        const socket = state.getWebSockets()[0];
        await restored.webSocketMessage(socket, JSON.stringify({ type: 'auth', device_id: device,
          device_name: 'restored-node', version: 'test', capabilities }));
      });
      expect(await waitForWebSocketJson(agent.ws)).toMatchObject({ type: 'auth_result', success: true, user_id: owner });
    } finally { closeWebSocket(agent.ws); }
  });

  it('fails closed when persisted ownership does not match the object identity', async () => {
    const owner = `persisted-owner-${crypto.randomUUID()}`;
    const agent = await connectAgent(owner, capabilitiesWithModels(['image-test']));
    try {
      const status = await runInDurableObject(agent.relay, async (_instance, state) => {
        await state.storage.put('relay:owner', 'other-account');
        const restored = new MereRunRelay(state, env);
        return (await restored.fetch(new Request('https://relay/internal/status', { headers: { 'X-User-Id': owner } }))).status;
      });
      expect(status).toBe(403);
    } finally { closeWebSocket(agent.ws); }
  });

});
