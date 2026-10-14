import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { MereRunRelay } from '../src/MereRunRelay';
import { handleClientApi } from '../src/client-api';
import { sha256Hex } from '../src/relay-graph-storage';
import type { GraphBatchRequest, GraphBatchResponse, GraphBatchRecord } from '../src/batch-types';
import type { AgentCapabilities, GraphJob, GraphRequestMessage } from '../src/types';
import { closeWebSocket, connectAgent, getRelay, readJson, waitForWebSocketJson } from './helpers';

function capabilities(tokens = true): AgentCapabilities {
  return { models: ['image-test'], max_resolution: 2048, controlnet: false, lora: false, img2img: true,
    graph_worker: { assignment_tokens: tokens, schema_version: 1, worker_version: '1.0.0',
      contract_versions: ['mere.run/job-bundle.v1'], platform: 'darwin', architecture: 'arm64',
      accelerator_backend: 'metal', memory_bytes: 32 * 1024 ** 3, installed_model_ids: ['image-test'],
      node_kinds: ['image.generate', 'text.value'], providers: [] } };
}

function batch(count = 6, window = 4, attempts = 2): GraphBatchRequest {
  const batchId = crypto.randomUUID();
  return { schema_version: 1, batch_id: batchId, idempotency_key: batchId, max_in_flight: window, max_attempts: attempts,
    items: Array.from({ length: count }, (_, index): GraphBatchRequest['items'][number] => ({ key: `item-${index}`, submission: {
      job: { contract_version: 'mere.run/job-bundle.v1', job_id: crypto.randomUUID(), created_at: '2026-10-14T12:00:00Z',
        graph_fingerprint: 'a'.repeat(64), input_fingerprint: 'b'.repeat(64),
        requirements: { minimum_mere_run_version: '0.3.0', node_kinds: ['text.value', 'image.generate'],
          model_ids: ['image-test'], accelerator_backends: ['metal'] },
        outputs: [{ name: 'image', reference: 'nodes.generate.outputs.image' }] },
      graph: { schema_version: 1, kind: 'mere.run/workflow-graph', name: 'whole-graph', inputs: { prompt: { type: 'string' } },
        nodes: [{ id: 'text', kind: 'text.value', arguments: { value: { $ref: 'inputs.prompt' } } },
          { id: 'generate', kind: 'image.generate', arguments: { prompt: { $ref: 'nodes.text.outputs.text' }, model: 'image-test', seed: index + 1 } }],
        outputs: { image: { $ref: 'nodes.generate.outputs.image' } } },
      inputs: { prompt: `image ${index}` }, assets: { schema_version: 1, groups: [] },
    } })) };
}

async function api(owner: string, path: string, method = 'GET', body?: unknown): Promise<Response> {
  return handleClientApi(new Request(`https://relay/api/graph-batches${path}`, {
    method, body: body === undefined ? undefined : JSON.stringify(body), headers: { 'Content-Type': 'application/json' },
  }), env, owner);
}

async function status(owner: string, id: string): Promise<GraphBatchResponse> {
  return readJson(await api(owner, `/${id}`));
}

async function waitState(owner: string, id: string, condition: (value: GraphBatchResponse) => boolean): Promise<GraphBatchResponse> {
  for (let index = 0; index < 100; index += 1) {
    const value = await status(owner, id);
    if (condition(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Batch did not reach expected state');
}

async function nextGraphRequest(ws: WebSocket): Promise<GraphRequestMessage> {
  for (let index = 0; index < 10; index += 1) {
    const message = await waitForWebSocketJson<GraphRequestMessage | { type: 'inventory_request' }>(ws);
    if (message.type === 'graph_request') return message;
    expect(message.type).toBe('inventory_request');
  }
  throw new Error('No graph assignment');
}

async function finish(ws: WebSocket, request: GraphRequestMessage): Promise<void> {
  const bytes = new Uint8Array([1, 2, 3]);
  const digest = await sha256Hex(bytes);
  const artifact = { name: 'image', kind: 'graph.output', path: 'image.png', content_type: 'image/png', size_bytes: bytes.length, sha256: digest };
  const uploaded = await SELF.fetch(new Request(`${request.upload_url_base}/artifacts/image`, {
    method: 'PUT', body: bytes, headers: { 'X-Artifact-Size': String(bytes.length), 'X-Artifact-Sha256': digest,
      'X-Artifact-Path': artifact.path, 'X-Artifact-Kind': artifact.kind, 'Content-Type': artifact.content_type },
  }));
  expect(uploaded.status).toBe(200);
  ws.send(JSON.stringify({ type: 'graph_result', job_id: request.job_id, assignment_token: request.assignment_token,
    artifacts: [artifact], run_manifest: { contract_version: 'mere.run/graph-run.v1', job_id: request.job_id,
      graph_fingerprint: 'a'.repeat(64), state: 'finished' } }));
}

describe('durable graph batch qualification', () => {
  it('fans 100 independent whole graphs across three nodes and refills a bounded window', async () => {
    const owner = crypto.randomUUID(); const body = batch(100);
    const agents = await Promise.all([connectAgent(owner, capabilities()), connectAgent(owner, capabilities()), connectAgent(owner, capabilities())]);
    try {
      expect((await api(owner, '', 'POST', body)).status).toBe(200);
      expect((await api(owner, `/${body.batch_id}/commit`, 'POST')).status).toBe(200);
      const requests = await Promise.all(agents.map((agent) => nextGraphRequest(agent.ws)));
      expect(new Set(requests.map((request) => request.job_id)).size).toBe(3);
      expect((await status(owner, body.batch_id)).counts).toEqual({ pending: 96, queued: 1, running: 3, finished: 0, failed: 0, cancelled: 0 });
      for (const request of requests) {
        const graph = request.bundle_files.find((file) => file.path === 'graph.json');
        expect(graph).toBeDefined();
        const document = await SELF.fetch(new Request(graph!.url));
        expect((await readJson<{ nodes: unknown[] }>(document)).nodes.length).toBe(2);
      }
      await finish(agents[0].ws, requests[0]);
      const next = await nextGraphRequest(agents[0].ws);
      expect(requests.map((request) => request.job_id)).not.toContain(next.job_id);
      const after = await waitState(owner, body.batch_id, (value) => value.counts.finished === 1 && value.counts.pending === 95);
      expect(after.items[0].key).toBe('item-0');
      expect(after.items.find((item) => item.job_id === requests[0].job_id)?.artifacts[0].sha256).toHaveLength(64);
      expect(after.counts.running).toBe(3);
    } finally { agents.forEach((agent) => closeWebSocket(agent.ws)); }
  });

  it('replays submission and concurrent commits without duplicate children or worker assignments', async () => {
    const owner = crypto.randomUUID(); const body = batch(5, 3);
    const agents = await Promise.all([connectAgent(owner, capabilities()), connectAgent(owner, capabilities())]);
    try {
      const submissions = await Promise.all(Array.from({ length: 5 }, () => api(owner, '', 'POST', body)));
      expect(submissions.every((response) => response.ok)).toBe(true);
      await Promise.all(Array.from({ length: 5 }, () => api(owner, `/${body.batch_id}/commit`, 'POST')));
      const messages = await Promise.all(agents.map((agent) => nextGraphRequest(agent.ws)));
      expect(new Set(messages.map((message) => message.job_id)).size).toBe(2);
      await expect(waitForWebSocketJson(agents[0].ws, 30)).rejects.toThrow('Timed out');
      const stats = await runInDurableObject(agents[0].relay, async (_instance, state) => ({
        children: (await state.storage.list({ prefix: 'graph:' })).size,
        batches: (await state.storage.list({ prefix: 'batch:' })).size,
      }));
      expect(stats).toEqual({ children: 3, batches: 1 });
      body.items[0].submission.inputs.prompt = 'different';
      expect((await api(owner, '', 'POST', body)).status).toBe(409);
    } finally { agents.forEach((agent) => closeWebSocket(agent.ws)); }
  });

  it('reassigns a disconnected child with a new token and rejects stale or tokenless completion', async () => {
    const owner = crypto.randomUUID(); const body = batch(1, 1, 2);
    const first = await connectAgent(owner, capabilities());
    await api(owner, '', 'POST', body); await api(owner, `/${body.batch_id}/commit`, 'POST');
    const old = await nextGraphRequest(first.ws);
    closeWebSocket(first.ws);
    const second = await connectAgent(owner, capabilities());
    try {
      const next = await nextGraphRequest(second.ws);
      expect(next.job_id).toBe(old.job_id); expect(next.assignment_token).not.toBe(old.assignment_token);
      second.ws.send(JSON.stringify({ type: 'graph_error', job_id: next.job_id, assignment_token: old.assignment_token, error: 'STALE' }));
      second.ws.send(JSON.stringify({ type: 'graph_error', job_id: next.job_id, error: 'TOKENLESS' }));
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect((await status(owner, body.batch_id)).items[0]).toMatchObject({ state: 'assigned', attempt: 2, error: null });
      await finish(second.ws, next);
      expect((await waitState(owner, body.batch_id, (value) => value.state === 'finished')).counts.finished).toBe(1);
    } finally { closeWebSocket(second.ws); }
  });

  it('keeps batch cancellation terminal and waits for running workers to release their slots', async () => {
    const owner = crypto.randomUUID(); const body = batch(4, 2);
    const agent = await connectAgent(owner, capabilities());
    try {
      await api(owner, '', 'POST', body); await api(owner, `/${body.batch_id}/commit`, 'POST');
      const request = await nextGraphRequest(agent.ws);
      await api(owner, `/${body.batch_id}`, 'DELETE');
      expect(await waitForWebSocketJson(agent.ws)).toMatchObject({ type: 'graph_cancel', job_id: request.job_id });
      agent.ws.send(JSON.stringify({ type: 'graph_error', job_id: request.job_id, assignment_token: request.assignment_token, error: 'CANCELLED' }));
      expect((await status(owner, body.batch_id))).toMatchObject({ state: 'cancelled', counts: { pending: 0, cancelled: 4 } });
      expect((await api(owner, `/${body.batch_id}/retry`, 'POST')).status).toBe(409);
      expect((await api(owner, `/${body.batch_id}/commit`, 'POST')).status).toBe(200);
      expect((await status(owner, body.batch_id)).state).toBe('cancelled');
    } finally { closeWebSocket(agent.ws); }
  });

  it('restores a committed batch and queued child after a cold Durable Object instance', async () => {
    const owner = crypto.randomUUID(); const body = batch(3, 1);
    await api(owner, '', 'POST', body); await api(owner, `/${body.batch_id}/commit`, 'POST');
    const relay = getRelay(owner);
    await runInDurableObject(relay, async (_instance, state) => {
      const restored = new MereRunRelay(state, env);
      await restored.fetch(new Request('https://relay/internal/status', { headers: { 'X-User-Id': owner } }));
      expect((await state.storage.list<GraphJob>({ prefix: 'graph:' })).size).toBe(1);
    });
    const agent = await connectAgent(owner, capabilities());
    try {
      const request = await nextGraphRequest(agent.ws);
      expect(request.job_id).toBe(body.items[0].submission.job.job_id);
    } finally { closeWebSocket(agent.ws); }
  });

  it('isolates accounts and gates legacy workers, duplicate items, and local-custody payloads', async () => {
    const owner = crypto.randomUUID(); const body = batch(2);
    const agent = await connectAgent(owner, capabilities(false));
    try {
      await api(owner, '', 'POST', body); await api(owner, `/${body.batch_id}/commit`, 'POST');
      expect((await status(owner, body.batch_id)).counts.queued).toBe(2);
      expect((await status(owner, body.batch_id)).items[0].placement).toMatchObject({ eligible_nodes: 0,
        nodes: [{ blockers: [{ code: 'assignment_tokens_required', message: 'Batch jobs require attempt-token-aware workers' }] }] });
      expect((await api(crypto.randomUUID(), `/${body.batch_id}`)).status).toBe(404);
      expect((await api(crypto.randomUUID(), `/${body.batch_id}`, 'DELETE')).status).toBe(404);
      const invalid = batch(2); invalid.items[1].key = invalid.items[0].key;
      expect((await api(owner, '', 'POST', invalid)).status).toBe(400);
      invalid.items[1].key = 'other'; invalid.items[0].submission.job.data_policy = 'local-custody.v1';
      expect((await api(owner, '', 'POST', invalid)).status).toBe(400);
    } finally { closeWebSocket(agent.ws); }
  });
  it('finishes every child out of order while preserving the ordered verified result index', async () => {
    const owner = crypto.randomUUID(); const body = batch(5, 3);
    const a = await connectAgent(owner, capabilities()); const b = await connectAgent(owner, capabilities());
    try {
      await api(owner, '', 'POST', body); await api(owner, `/${body.batch_id}/commit`, 'POST');
      let ar = await nextGraphRequest(a.ws);
      let br = await nextGraphRequest(b.ws);
      await finish(b.ws, br); br = await nextGraphRequest(b.ws);
      await finish(a.ws, ar); ar = await nextGraphRequest(a.ws);
      await finish(b.ws, br); br = await nextGraphRequest(b.ws);
      await finish(a.ws, ar); await finish(b.ws, br);
      const done = await waitState(owner, body.batch_id, (value) => value.state === 'finished');
      expect(done.counts).toEqual({ pending: 0, queued: 0, running: 0, finished: 5, failed: 0, cancelled: 0 });
      expect(done.items.map((item) => item.key)).toEqual(body.items.map((item) => item.key));
      expect(done.items.every((item) => item.artifacts[0]?.kind === 'graph.output')).toBe(true);
    } finally { closeWebSocket(a.ws); closeWebSocket(b.ws); }
  });

  it('retries failed items alone and preserves successful siblings and immutable bundle bytes', async () => {
    const owner = crypto.randomUUID(); const body = batch(2, 2, 1);
    const agent = await connectAgent(owner, capabilities());
    try {
      await api(owner, '', 'POST', body); await api(owner, `/${body.batch_id}/commit`, 'POST');
      const first = await nextGraphRequest(agent.ws);
      await finish(agent.ws, first);
      const second = await nextGraphRequest(agent.ws);
      agent.ws.send(JSON.stringify({ type: 'graph_error', job_id: second.job_id, assignment_token: second.assignment_token, error: 'MODEL_FAILURE' }));
      const failed = await waitState(owner, body.batch_id, (value) => value.state === 'failed');
      expect(failed.counts).toMatchObject({ finished: 1, failed: 1 });
      const retry = { retry_key: crypto.randomUUID() };
      await api(owner, `/${body.batch_id}/retry`, 'POST', retry);
      expect((await api(owner, `/${body.batch_id}/retry`, 'POST', retry)).status).toBe(200);
      const retried = await nextGraphRequest(agent.ws);
      expect(retried.job_id).toBe(second.job_id);
      expect(retried.assignment_token).not.toBe(second.assignment_token);
      expect(retried.bundle_files.map((file) => [file.path, file.sha256])).toEqual(second.bundle_files.map((file) => [file.path, file.sha256]));
      await finish(agent.ws, retried);
      const done = await waitState(owner, body.batch_id, (value) => value.state === 'finished');
      expect(done.items.find((item) => item.job_id === first.job_id)?.attempt).toBe(1);
      expect(done.items.find((item) => item.job_id === second.job_id)?.attempt).toBe(2);
    } finally { closeWebSocket(agent.ws); }
  });

  it('shares one verified asset across children and refuses incomplete, corrupt, or undeclared uploads', async () => {
    const owner = crypto.randomUUID(); const body = batch(2);
    const bytes = new Uint8Array([8, 9]); const digest = await sha256Hex(bytes);
    for (const item of body.items) {
      item.submission.graph.inputs.source = { type: 'asset' };
      item.submission.inputs.source = 'asset://source';
      item.submission.assets.groups = [{ name: 'source', kind: 'asset', entries: [{ path: 'source.png',
        digest, size_bytes: bytes.length, content_type: 'image/png' }] }];
    }
    const created = await readJson<GraphBatchResponse>(await api(owner, '', 'POST', body));
    expect(created.missing_asset_digests).toEqual([digest]);
    expect((await api(owner, `/${body.batch_id}/commit`, 'POST')).status).toBe(409);
    const upload = (hash: string, data: Uint8Array) => handleClientApi(new Request(`https://relay/api/graph-batches/${body.batch_id}/assets/${hash}`,
      { method: 'PUT', body: data }), env, owner);
    expect((await upload('c'.repeat(64), bytes)).status).toBe(404);
    expect((await upload(digest, new Uint8Array([9, 9]))).status).toBe(400);
    expect((await upload(digest, bytes)).status).toBe(200);
    expect((await status(owner, body.batch_id)).missing_asset_digests).toEqual([]);
    expect((await api(owner, `/${body.batch_id}/commit`, 'POST')).status).toBe(200);
  });

  it('respects the account active-job limit and fills the next slot after a standalone cancellation', async () => {
    const owner = crypto.randomUUID(); const body = batch(2, 2);
    const singles = batch(20).items;
    for (const item of singles) {
      const result = await handleClientApi(new Request('https://relay/api/graph-jobs', { method: 'POST', body: JSON.stringify(item.submission) }), env, owner);
      expect(result.status).toBe(201);
    }
    expect((await api(owner, '', 'POST', body)).status).toBe(200);
    await api(owner, `/${body.batch_id}/commit`, 'POST');
    expect((await status(owner, body.batch_id)).counts.pending).toBe(2);
    await handleClientApi(new Request(`https://relay/api/graph-jobs/${singles[0].submission.job.job_id}`, { method: 'DELETE' }), env, owner);
    expect((await waitState(owner, body.batch_id, (value) => value.counts.queued === 1)).counts.pending).toBe(1);
  });

  it('admits compatible later items ahead of blocked inputs and fairly shares one worker between batches', async () => {
    const owner = crypto.randomUUID(); const first = batch(3, 1); const second = batch(2, 1);
    first.items[0].submission.job.requirements.model_ids = ['missing-model'];
    await api(owner, '', 'POST', first); await api(owner, '', 'POST', second);
    const agent = await connectAgent(owner, capabilities());
    try {
      await api(owner, `/${first.batch_id}/commit`, 'POST');
      const request = await nextGraphRequest(agent.ws);
      expect(request.job_id).toBe(first.items[1].submission.job.job_id);
      await api(owner, `/${second.batch_id}/commit`, 'POST');
      await finish(agent.ws, request);
      const next = await nextGraphRequest(agent.ws);
      expect(next.job_id).toBe(second.items[0].submission.job.job_id);
    } finally { closeWebSocket(agent.ws); }
  });
  it('pages large result indexes without changing item order or aggregate counts', async () => {
    const owner = crypto.randomUUID(); const body = batch(205, 1);
    const created = await readJson<GraphBatchResponse>(await api(owner, '', 'POST', body));
    expect(created.items.length).toBe(100); expect(created.next_cursor).toBe(100);
    expect(created.counts.pending).toBe(205);
    const middle = await readJson<GraphBatchResponse>(await api(owner, `/${body.batch_id}?cursor=100`));
    const last = await readJson<GraphBatchResponse>(await api(owner, `/${body.batch_id}?cursor=200`));
    expect(middle.next_cursor).toBe(200); expect(last.next_cursor).toBeNull();
    expect([...created.items, ...middle.items, ...last.items].map((item) => item.key)).toEqual(body.items.map((item) => item.key));
    expect((await api(owner, `/${body.batch_id}?cursor=invalid`)).status).toBe(400);
    expect((await api(owner, '', 'GET')).status).toBe(200);
  });

  it('rejects empty and oversized create requests without persisting a partial parent', async () => {
    const owner = crypto.randomUUID();
    expect((await api(owner, '', 'POST')).status).toBe(400);
    const oversized = await handleClientApi(new Request('https://relay/api/graph-batches', { method: 'POST',
      body: ' '.repeat(8 * 1024 * 1024 + 1) }), env, owner);
    expect(oversized.status).toBe(413);
    const parents = await runInDurableObject(getRelay(owner), async (_instance, state) => state.storage.list({ prefix: 'batch:' }));
    expect(parents.size).toBe(0);
  });

  it('resumes interrupted cancellation from durable state after reconstruction', async () => {
    const owner = crypto.randomUUID(); const body = batch(3, 2);
    const agent = await connectAgent(owner, capabilities());
    try {
      await api(owner, '', 'POST', body); await api(owner, `/${body.batch_id}/commit`, 'POST');
      const request = await nextGraphRequest(agent.ws);
      await runInDurableObject(agent.relay, async (_instance, state) => {
        const stored = await state.storage.get<GraphBatchRecord>(`batch:${body.batch_id}`);
        if (!stored) throw new Error('missing parent');
        await state.storage.put(`batch:${body.batch_id}`, { ...stored, state: 'cancelled' });
        const restored = new MereRunRelay(state, env);
        await restored.fetch(new Request('https://relay/internal/status', { headers: { 'X-User-Id': owner } }));
        const child = await state.storage.get<GraphJob>(`graph:${request.job_id}`);
        expect(child?.state).toBe('cancelled');
        const socket = state.getWebSockets()[0];
        await restored.webSocketMessage(socket, JSON.stringify({ type: 'graph_error', job_id: request.job_id,
          assignment_token: request.assignment_token, error: 'CANCELLED' }));
        expect((await state.storage.get<GraphJob>(`graph:${request.job_id}`))?.state).toBe('cancelled');
      });
      expect(await waitForWebSocketJson(agent.ws)).toMatchObject({ type: 'graph_cancel', job_id: request.job_id });
      expect((await status(owner, body.batch_id)).counts).toMatchObject({ pending: 0, queued: 0, cancelled: 3 });
    } finally { closeWebSocket(agent.ws); }
  });

  it('restarts a missing worker assignment after a cold reconstruction and resets event sequencing', async () => {
    const owner = crypto.randomUUID(); const body = batch(1, 1, 2);
    await api(owner, '', 'POST', body); await api(owner, `/${body.batch_id}/commit`, 'POST');
    const relay = getRelay(owner);
    await runInDurableObject(relay, async (_instance, state) => {
      const key = `graph:${body.items[0].submission.job.job_id}`;
      const job = await state.storage.get<GraphJob>(key);
      if (!job) throw new Error('missing child');
      await state.storage.put(key, { ...job, state: 'running', agent_id: 'missing-worker', attempt: 1, last_event_sequence: 9 });
      const restored = new MereRunRelay(state, env);
      await restored.fetch(new Request('https://relay/internal/status', { headers: { 'X-User-Id': owner } }));
      expect(await state.storage.get<GraphJob>(key)).toMatchObject({ state: 'queued', agent_id: null, last_event_sequence: -1 });
    });
  });
});
