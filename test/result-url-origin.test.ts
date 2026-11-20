import { describe, expect, it, vi } from 'vitest';
import { NOT_RELAY_ASSET_ERROR } from '../src/r2';
import {
  capabilitiesWithModels,
  capabilitiesWithPlugin,
  closeWebSocket,
  connectAgent,
  readJson,
  relayAssetUrl,
  submitJob,
  submitTalk,
  submitTool,
  waitForWebSocketJson,
} from './helpers';

type JsonRecord = Record<string, unknown>;

function newUserId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

// A node uploads its output to the relay and reports the URL the relay
// returned. Any other URL in a result must not reach the job owner or their
// webhook receiver as though the relay had stored it.
describe('result URLs a node reports', () => {
  it.each([
    ['another host', () => 'https://attacker.example/relay/x/out.png'],
    ['a private address', () => 'http://169.254.169.254/latest/meta-data'],
    ["another account's stored object", () => relayAssetUrl(newUserId('someone-else'), 'out.png')],
  ])('fails a job whose result names %s', async (_label, foreignUrl) => {
    const userId = newUserId('result-url-job');
    const { relay, ws } = await connectAgent(userId, capabilitiesWithModels(['image-klein-9b']));
    try {
      const submitted = await readJson<JsonRecord>(await submitJob(relay, userId, { prompt: 'result url check' }));
      await waitForWebSocketJson<JsonRecord>(ws);
      ws.send(JSON.stringify({ type: 'result', job_id: submitted.job_id, success: true, media_url: foreignUrl(), content_type: 'image/png' }));

      await vi.waitFor(async () => {
        const status = await readJson<JsonRecord>(await relay.fetch(new Request(`https://relay/internal/job/${String(submitted.job_id)}`)));
        expect(status).toMatchObject({ status: 'failed', error: NOT_RELAY_ASSET_ERROR });
        expect(status.result ?? null).toBeNull();
      });
    } finally {
      closeWebSocket(ws);
    }
  });

  it('completes a job whose result is the object the relay stored for its owner', async () => {
    const userId = newUserId('result-url-own');
    const { relay, ws } = await connectAgent(userId, capabilitiesWithModels(['image-klein-9b']));
    try {
      const submitted = await readJson<JsonRecord>(await submitJob(relay, userId, { prompt: 'own result' }));
      await waitForWebSocketJson<JsonRecord>(ws);
      const url = relayAssetUrl(userId, `${String(submitted.job_id)}.png`);
      ws.send(JSON.stringify({ type: 'result', job_id: submitted.job_id, success: true, image_url: url, content_type: 'image/png' }));

      await vi.waitFor(async () => {
        const status = await readJson<JsonRecord>(await relay.fetch(new Request(`https://relay/internal/job/${String(submitted.job_id)}`)));
        expect(status).toMatchObject({ status: 'complete', result: { image_url: url, media_url: url } });
      });
    } finally {
      closeWebSocket(ws);
    }
  });

  it('fails a talk whose audio URL the relay did not issue', async () => {
    const userId = newUserId('result-url-talk');
    const { relay, ws } = await connectAgent(userId, capabilitiesWithModels(['talk-nano']));
    try {
      const submitted = await readJson<JsonRecord>(await submitTalk(relay, userId, { text: 'Hello world' }));
      await waitForWebSocketJson<JsonRecord>(ws);
      ws.send(JSON.stringify({ type: 'talk_response', talk_id: submitted.talk_id, owner_user_id: userId, audio_url: 'https://attacker.example/audio.wav', duration_seconds: 1 }));

      await vi.waitFor(async () => {
        const status = await readJson<JsonRecord>(await relay.fetch(new Request(`https://relay/internal/talk/${String(submitted.talk_id)}`)));
        expect(status).toMatchObject({ status: 'failed', error: NOT_RELAY_ASSET_ERROR });
      });
    } finally {
      closeWebSocket(ws);
    }
  });

  it('fails a tool run when any artifact URL is not one the relay issued', async () => {
    const userId = newUserId('result-url-tool');
    const { relay, ws } = await connectAgent(userId, capabilitiesWithPlugin({ name: 'mere-animatic-tools', commands: ['character-knockout'] }));
    try {
      const submitted = await readJson<JsonRecord>(await submitTool(relay, userId, {
        plugin: 'mere-animatic-tools', command: 'character-knockout', inputs: { prompt: 'artifact url check' },
      }));
      const toolId = String(submitted.tool_id);
      await waitForWebSocketJson<JsonRecord>(ws);
      ws.send(JSON.stringify({
        type: 'tool_result',
        tool_id: toolId,
        artifacts: [
          { name: 'report.json', kind: 'json', content_type: 'application/json', url: relayAssetUrl(userId, `${toolId}/report.json`) },
          { name: 'mask.png', kind: 'image', content_type: 'image/png', url: 'https://attacker.example/mask.png' },
        ],
      }));

      await vi.waitFor(async () => {
        const status = await readJson<JsonRecord>(await relay.fetch(new Request(`https://relay/internal/tool/${toolId}`)));
        expect(status).toMatchObject({ status: 'failed', error: NOT_RELAY_ASSET_ERROR });
        expect(status.result ?? null).toBeNull();
      });
    } finally {
      closeWebSocket(ws);
    }
  });
});
