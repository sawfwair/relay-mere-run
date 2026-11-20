import { describe, expect, it } from 'vitest';
import { capabilitiesWithModels, closeWebSocket, connectAgent, readJson, submitJob, waitForWebSocketJson } from './helpers';
type RecordValue = Record<string, unknown>;
const capability = () => capabilitiesWithModels(['image-test']);
describe('required node placement', () => {
  it('rejects a foreign owner node and mismatched owner even when another capable node is online', async () => {
    const user = crypto.randomUUID();
    const own = await connectAgent(user, capability(), { deviceId: 'own' });
    const foreign = await connectAgent(crypto.randomUUID(), capability(), { deviceId: 'foreign' });
    try {
      expect((await submitJob(own.relay, user, { prompt: 'test', model: 'image-test', required_device_id: 'foreign' })).status).toBe(403);
      expect((await submitJob(own.relay, 'other-owner', { prompt: 'test', model: 'image-test', required_device_id: 'own' })).status).toBe(403);
    } finally { closeWebSocket(own.ws); closeWebSocket(foreign.ws); }
  });
  it('never falls back from a busy selected node to another online node', async () => {
    const user = crypto.randomUUID();
    const selected = await connectAgent(user, capability(), { deviceId: 'selected', availability: { status: 'busy', source: 'test', current_job_id: 'local:test:busy' } });
    const other = await connectAgent(user, capability(), { deviceId: 'other' });
    try {
      const response = await submitJob(selected.relay, user, { prompt: 'test', model: 'image-test', required_device_id: 'selected' });
      expect(await readJson<RecordValue>(response)).toMatchObject({ status: 'queued' });
      selected.ws.send(JSON.stringify({ type: 'availability_update', status: 'online', source: 'test', current_job_id: 'local:test:busy' }));
      expect((await waitForWebSocketJson<RecordValue>(selected.ws)).type).toBe('job');
    } finally { closeWebSocket(selected.ws); closeWebSocket(other.ws); }
  });
  it('rejects unsupported selected nodes even if another node supports the model', async () => {
    const user = crypto.randomUUID();
    const selected = await connectAgent(user, capabilitiesWithModels(['text']), { deviceId: 'selected' });
    const other = await connectAgent(user, capability(), { deviceId: 'other' });
    try {
      const response = await submitJob(selected.relay, user, { prompt: 'test', model: 'image-test', required_device_id: 'selected' });
      expect(response.status).toBe(503);
      expect(await readJson<RecordValue>(response)).toMatchObject({ code: 'NO_COMPATIBLE_AGENTS' });
    } finally { closeWebSocket(selected.ws); closeWebSocket(other.ws); }
  });
  it('respects disabled capacity policy without falling back to an eligible peer', async () => {
    const user = crypto.randomUUID();
    const selected = await connectAgent(user, capability(), { deviceId: 'selected' });
    const other = await connectAgent(user, capability(), { deviceId: 'other' });
    try {
      expect((await selected.relay.fetch(new Request('https://relay/internal/fleet/nodes/selected', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: false }) }))).status).toBe(200);
      expect((await submitJob(selected.relay, user, { prompt: 'test', model: 'image-test', required_device_id: 'selected' })).status).toBe(503);
    } finally { closeWebSocket(selected.ws); closeWebSocket(other.ws); }
  });
  it('retains the device constraint on lease recovery and accepts only the same device reconnecting', async () => {
    const user = crypto.randomUUID();
    const options = { deviceId: 'selected', capacity: { max_concurrent_jobs: 1, lease_protocol: true } };
    const selected = await connectAgent(user, capability(), options);
    const other = await connectAgent(user, capability(), { deviceId: 'other' });
    let reconnected: Awaited<ReturnType<typeof connectAgent>> | undefined;
    try {
      const submitted = await readJson<RecordValue>(await submitJob(selected.relay, user, { prompt: 'test', model: 'image-test', required_device_id: 'selected' }));
      const first = await waitForWebSocketJson<RecordValue>(selected.ws);
      closeWebSocket(selected.ws);
      await new Promise((resolve) => setTimeout(resolve, 30));
      const status = await readJson<RecordValue>(await selected.relay.fetch(new Request(`https://relay/internal/job/${String(submitted.job_id)}`)));
      expect(status).toMatchObject({ status: 'queued', agent_id: null });
      reconnected = await connectAgent(user, capability(), options);
      const second = await waitForWebSocketJson<RecordValue>(reconnected.ws);
      expect(second.job_id).toBe(submitted.job_id);
      expect(second.lease_id).not.toBe(first.lease_id);
    } finally { closeWebSocket(selected.ws); closeWebSocket(other.ws); if (reconnected) closeWebSocket(reconnected.ws); }
  });
});
