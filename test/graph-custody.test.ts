import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { closeWebSocket, connectAgent, readJson, waitForWebSocketJson } from './helpers';
import { sha256Json } from '../src/execution';
import { sha256Hex } from '../src/relay-graph-storage';
import { LOCAL_CUSTODY_POLICY, sanitizedReportBytes } from '../src/relay-graph-custody';
import type { AgentCapabilities, GraphJob, GraphRequestMessage, SubmitGraphJobRequest } from '../src/types';
import reportCases from './fixtures/local-custody-reports.json';
import { MereRunRelayClient } from '../clients/typescript/MereRunRelayClient';
import { isGraphStatusResponse } from '../clients/typescript/graph-contracts';
import { handleCustodyNodeRequest } from '../src/relay-graph-custody-http';
import type { RelayContext } from '../src/relay-context';
import { handleGraphResult } from '../src/relay-api-graph';

const marker = 'PRIVATE INPUT must never reach an object bucket';
const provider = { id: 'mere-example-tools', version: '1.0.0', catalog_sha256: 'a'.repeat(64), node_kinds: ['example.receipt'] };
function capabilities(supported = true): AgentCapabilities {
  return { models: [], max_resolution: 0, controlnet: false, lora: false, img2img: false,
    graph_worker: { schema_version: 1, worker_version: '0.45.0', contract_versions: ['mere.run/job-bundle.v1'],
      data_policies: supported ? [LOCAL_CUSTODY_POLICY] : [], platform: 'linux', architecture: 'x86_64',
      accelerator_backend: 'cpu', memory_bytes: 8_000_000_000, node_kinds: provider.node_kinds,
      installed_model_ids: [], providers: [provider] } };
}

async function fixture(): Promise<SubmitGraphJobRequest> {
  const graph = { schema_version: 1, kind: 'mere.run/workflow-graph', name: marker,
    inputs: { payload: { type: 'json' as const } }, metadata: { private: marker },
    nodes: [{ id: 'execute', kind: 'example.receipt', provider: provider.id, arguments: { payload: { $ref: 'inputs.payload' } } }],
    outputs: { receipt: { $ref: 'nodes.execute.outputs.receipt' } } };
  const inputs = { payload: { prompt: marker, source_ref: `example-local://sources/${'b'.repeat(64)}` } };
  return { job: { contract_version: 'mere.run/job-bundle.v1', job_id: crypto.randomUUID(), created_at: '2026-08-27T00:00:00Z',
    graph_fingerprint: await sha256Json(graph), input_fingerprint: await sha256Json(inputs),
    data_policy: LOCAL_CUSTODY_POLICY, idempotency_key: crypto.randomUUID(),
    requirements: { minimum_mere_run_version: '0.40.0', node_kinds: provider.node_kinds, model_ids: [],
      providers: [provider], accelerator_backends: ['cpu'] }, outputs: [{ name: 'receipt', reference: 'nodes.execute.outputs.receipt' }] },
  graph, inputs, assets: { schema_version: 1, groups: [] } };
}

async function setup(supported = true) {
  const owner = `custody-${crypto.randomUUID()}`;
  const agent = await connectAgent(owner, capabilities(supported), { deviceId: 'custody-node' });
  const body = await fixture();
  const api = (path: string, method = 'GET', value?: unknown) => agent.relay.fetch(new Request(`https://relay/internal/graph-jobs${path}`, {
    method, headers: { 'X-User-Id': owner, 'Content-Type': 'application/json' },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }),
  }));
  const snapshot = () => runInDurableObject(agent.relay, async (_instance, state) => state.storage.get<GraphJob>(`graph:${body.job.job_id}`));
  const status = async () => readJson<Record<string, unknown>>(await api(`/${body.job.job_id}`));
  return { ...agent, owner, body, api, snapshot, status,
    inventory: async () => (await env.IMAGES.list({ prefix: `graph-jobs/${encodeURIComponent(owner)}/` })).objects,
    submit: async () => { expect((await api('', 'POST', body)).status).toBe(201); expect((await api(`/${body.job.job_id}/commit`, 'POST')).status).toBe(200); },
    assigned: () => waitForWebSocketJson<GraphRequestMessage>(agent.ws),
  };
}

async function nodeRequest(message: GraphRequestMessage, suffix: string, method = 'GET', body?: unknown, headers = {}) {
  return SELF.fetch(new Request(`${message.upload_url_base}/${suffix}`, { method,
    headers: { 'Content-Type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  }));
}

async function acknowledge(message: GraphRequestMessage) {
  return nodeRequest(message, 'bundle-ack', 'POST', { request_sha256: message.request_sha256 });
}

describe('local-custody graph transport', () => {
  it('requires an explicitly capable node and rejects portable assets or unknown policies', async () => {
    const f = await setup(false);
    try {
      await f.submit();
      expect(await f.status()).toMatchObject({ state: 'queued', data_policy: LOCAL_CUSTODY_POLICY,
        placement: { eligible_nodes: 0, nodes: [{ blockers: [{ code: 'data_policy_unsupported' }] }] } });
      expect(await f.inventory()).toEqual([]);
      const invalid = await fixture();
      invalid.assets.groups = [{ name: 'data', kind: 'asset_directory', entries: [] }];
      expect((await f.api('', 'POST', invalid)).status).toBe(400);
      expect((await f.api('', 'POST', { ...invalid, job: { ...invalid.job, data_policy: 'unknown' } })).status).toBe(400);
      expect((await f.api(`/${f.body.job.job_id}`, 'DELETE')).status).toBe(200);
      expect(JSON.stringify(await f.snapshot())).not.toContain(marker);
    } finally { closeWebSocket(f.ws); }
  });

  it('serves exact verified bytes without R2, purges after ACK, and persists only validated reports', async () => {
    const f = await setup();
    try {
      f.body.bundle_documents = Object.fromEntries(['job', 'graph', 'inputs', 'assets'].map((key) => [
        `${key}.json`, btoa(JSON.stringify(f.body[key as 'job' | 'graph' | 'inputs' | 'assets'], null, 2)),
      ]));
      await f.submit();
      const message = await f.assigned();
      expect(message.data_policy).toBe(LOCAL_CUSTODY_POLICY);
      expect(await f.inventory()).toEqual([]);
      for (const file of message.bundle_files) {
        const response = await SELF.fetch(new Request(file.url));
        expect(response.headers.get('Cache-Control')).toBe('no-store');
        const bytes = new Uint8Array(await response.arrayBuffer());
        expect(await sha256Hex(bytes)).toBe(file.sha256);
        expect(bytes.byteLength).toBe(file.size_bytes);
      }
      expect((await nodeRequest(message, 'bundle-ack', 'POST', { request_sha256: 'f'.repeat(64) })).status).toBe(409);
      expect(JSON.stringify(await f.snapshot())).toContain(marker);
      expect((await acknowledge(message)).status).toBe(200);
      expect((await acknowledge(message)).status).toBe(200);
      expect((await SELF.fetch(new Request(message.bundle_files[0].url))).status).toBe(410);
      expect(JSON.stringify(await f.snapshot())).not.toContain(marker);
      expect(await f.status()).toMatchObject({ payload_state: 'delivered' });

      const report = { schema: 'example.provider-receipt.v1', state: 'complete', request_sha256: message.request_sha256,
        dataset_sha256: 'b'.repeat(64), dataset_ref: `example-local://datasets/${'b'.repeat(64)}`, counts: { accepted: 2 } };
      const content = JSON.stringify(report);
      const artifact = { name: 'receipt', kind: 'graph.output', path: 'outputs/receipt.json',
        content_type: 'application/vnd.mere.identity-receipt+json', size_bytes: new TextEncoder().encode(content).byteLength,
        sha256: await sha256Hex(new TextEncoder().encode(content)) };
      const headers = { 'X-Artifact-Kind': artifact.kind, 'X-Artifact-Path': artifact.path,
        'Content-Type': artifact.content_type, 'X-Artifact-Size': String(artifact.size_bytes), 'X-Artifact-Sha256': artifact.sha256 };
      expect((await nodeRequest(message, 'artifacts/receipt', 'PUT', content, { ...headers, 'X-Artifact-Part-Index': '0' })).status).toBe(403);
      expect((await nodeRequest(message, 'artifacts/receipt', 'PUT', 'x'.repeat(256_001), headers)).status).toBe(400);
      expect((await nodeRequest(message, 'artifacts/_manifest-inputs', 'PUT', content, headers)).status).toBe(403);
      const unsafe = JSON.stringify({ ...report, raw_prompt: marker });
      expect((await nodeRequest(message, 'artifacts/receipt', 'PUT', unsafe, { ...headers,
        'X-Artifact-Size': String(unsafe.length), 'X-Artifact-Sha256': await sha256Hex(new TextEncoder().encode(unsafe)) })).status).toBe(400);
      expect(await f.inventory()).toEqual([]);
      expect((await nodeRequest(message, 'artifacts/receipt', 'PUT', content, headers)).status).toBe(200);
      const manifest = { contract_version: 'mere.run/graph-run.v1', job_id: f.body.job.job_id,
        graph_fingerprint: f.body.job.graph_fingerprint, state: 'finished', raw_prompt: marker };
      expect((await nodeRequest(message, 'run-manifest', 'PUT', manifest)).status).toBe(200);
      f.ws.send(JSON.stringify({ type: 'graph_result', job_id: f.body.job.job_id, assignment_token: message.assignment_token,
        run_manifest: manifest, artifacts: [artifact] }));
      await vi.waitFor(async () => expect(await f.status()).toMatchObject({ state: 'finished', payload_state: 'purged' }));
      const status = await f.status();
      expect(status.execution_receipt).toMatchObject({ request_sha256: message.request_sha256,
        output_sha256: await sha256Json({ run_manifest: status.run_manifest,
          artifacts: [{ name: artifact.name, sha256: artifact.sha256, size_bytes: artifact.size_bytes }] }) });
      expect(JSON.stringify(await f.snapshot())).not.toContain(marker);
      expect((await f.inventory()).map((object) => object.key)).toEqual([expect.stringContaining(`/artifacts/${artifact.sha256}`)]);
      expect((await nodeRequest(message, 'artifacts/receipt', 'PUT', content, headers)).status).toBe(410);
    } finally { closeWebSocket(f.ws); }
  });

  it('recovers an acknowledged disconnect only from the exact request and revokes the old upload token', async () => {
    const f = await setup();
    let replacement: Awaited<ReturnType<typeof connectAgent>> | undefined;
    try {
      await f.submit();
      const first = await f.assigned();
      expect((await acknowledge(first)).status).toBe(200);
      closeWebSocket(f.ws);
      await vi.waitFor(async () => expect(await f.status()).toMatchObject({ state: 'queued', payload_state: 'replay_required' }));
      expect((await acknowledge(first)).status).toBe(409);
      expect((await nodeRequest(first, 'artifacts/receipt', 'PUT', {})).status).toBe(409);
      expect((await f.api('', 'POST', { ...f.body, inputs: { payload: { prompt: 'altered' } } })).status).toBe(409);
      expect(JSON.stringify(await f.snapshot())).not.toContain(marker);
      const replay = { ...f.body, job: { ...f.body.job, job_id: crypto.randomUUID(), created_at: '2026-08-28T00:00:00Z' } };
      const restored = await f.api('', 'POST', replay);
      expect(restored.status).toBe(200);
      expect(await restored.json()).toMatchObject({ job_id: f.body.job.job_id });
      expect((await f.snapshot())?.job).toMatchObject({ job_id: f.body.job.job_id, created_at: f.body.job.created_at,
        idempotency_key: f.body.job.idempotency_key });
      replacement = await connectAgent(f.owner, capabilities(), { deviceId: 'replacement' });
      const second = await waitForWebSocketJson<GraphRequestMessage>(replacement.ws);
      expect(second.job_id).toBe(first.job_id);
      expect(second.request_sha256).toBe(first.request_sha256);
      expect(second.upload_url_base).not.toBe(first.upload_url_base);
      expect(second.assignment_token).not.toBe(first.assignment_token);
      const manifest = second.bundle_files.find((file) => file.path === 'job.json');
      expect(manifest).toBeDefined();
      expect(await (await SELF.fetch(new Request(manifest!.url))).json()).toMatchObject({ job_id: f.body.job.job_id,
        created_at: f.body.job.created_at });
      expect((await acknowledge(first)).status).toBe(404);
      expect((await nodeRequest(second, 'run-manifest', 'PUT', {})).status).toBe(409);
      expect((await acknowledge(second)).status).toBe(200);
      const event = { sequence: 0, type: 'job_state', state: 'running', created_at: '2026-08-27T01:00:00Z' };
      replacement.ws.send(JSON.stringify({ type: 'graph_event', job_id: second.job_id,
        assignment_token: first.assignment_token, event }));
      replacement.ws.send(JSON.stringify({ type: 'graph_result', job_id: second.job_id,
        assignment_token: first.assignment_token, run_manifest: {}, artifacts: [] }));
      replacement.ws.send(JSON.stringify({ type: 'graph_error', job_id: second.job_id,
        assignment_token: first.assignment_token, error: marker }));
      replacement.ws.send(JSON.stringify({ type: 'graph_error', job_id: second.job_id, error: marker }));
      replacement.ws.send(JSON.stringify({ type: 'graph_event', job_id: second.job_id,
        assignment_token: second.assignment_token, event }));
      await vi.waitFor(async () => expect(await f.status()).toMatchObject({ state: 'running' }));
      expect((await f.snapshot())?.last_event_sequence).toBe(0);
      expect(await f.inventory()).toEqual([]);
      expect((await f.api(`/${f.body.job.job_id}`, 'DELETE')).status).toBe(200);
      expect(JSON.stringify(await f.snapshot())).not.toContain(marker);
    } finally { closeWebSocket(f.ws); if (replacement) closeWebSocket(replacement.ws); }
  });

  it('rejects free-form report fields, private paths, credentials, and large/deep reports', () => {
    const allowed = { schema: 'example.report.v1', source_digests: ['a'.repeat(64)], metrics: { safety: 1 }, passed: true };
    const check = (value: unknown) => sanitizedReportBytes(new TextEncoder().encode(JSON.stringify(value)));
    expect(check(allowed)).toBe(true);
    for (const extra of [{ prompt: marker }, { message: marker }, { model: '/private/model' }, { token: 'sensitive' },
      { dataset_ref: 'file:///private/path' }, { counts: { safe: { unexpected: 'free text' } } }, { source_digests: ['wrong'] }]) {
      expect(check({ ...allowed, ...extra })).toBe(false);
    }
    expect(check({ counts: Array.from({ length: 257 }, () => 1) })).toBe(false);
    expect(check({ model_id: 'a'.repeat(256_000) })).toBe(false);
    let deep: unknown = { count: 1 };
    for (let i = 0; i < 17; i++) deep = { nested: deep };
    expect(check(deep)).toBe(false);
  });

  it.each(reportCases)('uses the shared Node/Worker report grammar: $name', ({ report, valid }) => {
    expect(sanitizedReportBytes(new TextEncoder().encode(JSON.stringify(report)))).toBe(valid);
  });

  it('rejects cross-account node URLs and purges on failure even after a cache reload', async () => {
    const f = await setup();
    try {
      await f.submit();
      const message = await f.assigned();
      const forged = message.bundle_files[0].url.replace(encodeURIComponent(f.owner), 'another-account');
      expect((await SELF.fetch(new Request(forged))).status).toBe(404);
      expect((await acknowledge(message)).status).toBe(200);
      await runInDurableObject(f.relay, (instance) => {
        (instance as unknown as { graphJobs: Map<string, GraphJob> }).graphJobs.clear();
      });
      expect(await f.status()).toMatchObject({ payload_state: 'delivered' });
      expect(JSON.stringify(await f.snapshot())).not.toContain(marker);
      f.ws.send(JSON.stringify({ type: 'graph_error', job_id: f.body.job.job_id, assignment_token: message.assignment_token, error: marker }));
      await vi.waitFor(async () => expect(await f.status()).toMatchObject({ state: 'failed', payload_state: 'purged' }));
      expect(JSON.stringify(await f.snapshot())).not.toContain(marker);
      expect(await f.inventory()).toEqual([]);
      expect((await f.api('', 'POST', f.body)).status).toBe(200);
      expect(await f.status()).toMatchObject({ state: 'failed', payload_state: 'purged' });
      expect((await f.api(`/${f.body.job.job_id}/retry`, 'POST')).status).toBe(409);
    } finally { closeWebSocket(f.ws); }
  });

  it('round-trips the typed SDK against real graph handlers without changing replay bytes', async () => {
    const f = await setup(false);
    const calls: string[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      const request = new Request(url, init);
      expect(request.headers.get('Authorization')).toBe('Bearer test-server-token');
      expect(request.headers.get('Cookie')).toBeNull();
      const body = typeof init.body === 'string' ? init.body : undefined;
      if (body) calls.push(body);
      return f.api(new URL(url).pathname.replace('/api/graph-jobs', ''), init.method, body ? JSON.parse(body) as unknown : undefined);
    }) as unknown as typeof fetch;
    const client = new MereRunRelayClient({ baseUrl: 'https://relay', authorization: 'test-server-token', fetchImpl });
    try {
      const first = await client.submitGraph(f.body);
      expect(first).toMatchObject({ job_id: f.body.job.job_id, data_policy: LOCAL_CUSTODY_POLICY, payload_state: 'available' });
      expect((await client.submitGraph(f.body)).request_sha256).toBe(first.request_sha256);
      expect(calls[0]).toBe(calls[1]);
      expect((await client.commitGraph(first.job_id)).state).toBe('queued');
      expect((await client.getGraph(first.job_id)).state).toBe('queued');
      const cancelled = await client.cancelGraph(first.job_id);
      expect(cancelled).toMatchObject({ state: 'cancelled', payload_state: 'purged', execution_receipt: { state: 'cancelled' } });
      expect(isGraphStatusResponse({ ...cancelled, execution_receipt: null })).toBe(false);
      expect(isGraphStatusResponse({ ...cancelled, state: 'running' })).toBe(false);
      expect(isGraphStatusResponse({ ...cancelled, execution_receipt: { ...cancelled.execution_receipt, request_sha256: 'e'.repeat(64) } })).toBe(false);
    } finally { closeWebSocket(f.ws); }
  });

  it.each(['cancelled', 'reassigned', 'missing-after-reassignment'])('ignores a result superseded during artifact verification: %s', async (transition) => {
    const f = await setup();
    try {
      await f.submit();
      const message = await f.assigned();
      expect((await acknowledge(message)).status).toBe(200);
      let current = structuredClone((await f.snapshot())!);
      const artifact = { name: 'receipt', kind: 'graph.output', path: 'outputs/receipt.json',
        content_type: 'application/vnd.mere.identity-receipt+json', size_bytes: 42, sha256: 'a'.repeat(64) };
      current.artifact_uploads[artifact.sha256] = { sha256: artifact.sha256, size_bytes: artifact.size_bytes,
        object_name: artifact.sha256, part_count: 0, parts: [] };
      let release!: (value: unknown) => void;
      let entered!: () => void;
      const checking = new Promise<void>((resolve) => { entered = resolve; });
      const checked = new Promise<unknown>((resolve) => { release = resolve; });
      const saved = vi.fn();
      const ctx = { getGraphJob: () => Promise.resolve(current), saveGraphJob: saved,
        env: { IMAGES: { head: () => { entered(); return checked; } } },
      } as unknown as RelayContext;
      const pending = handleGraphResult(ctx, { type: 'graph_result', job_id: current.job_id,
        assignment_token: message.assignment_token, artifacts: [artifact],
        run_manifest: { contract_version: 'mere.run/graph-run.v1', job_id: current.job_id,
          graph_fingerprint: current.job.graph_fingerprint, state: 'finished' },
      }, current.agent_id);
      await checking;
      current = { ...current, state: transition === 'cancelled' ? 'cancelled' : 'assigned',
        node_token: transition === 'cancelled' ? current.node_token : 'c'.repeat(32) };
      release(transition === 'missing-after-reassignment' ? null : { size: artifact.size_bytes, customMetadata: { sha256: artifact.sha256 } });
      await pending;
      expect(saved).not.toHaveBeenCalled();
      expect(current.state).toBe(transition === 'cancelled' ? 'cancelled' : 'assigned');
      expect(current.artifacts).toEqual([]);
      expect((await f.api(`/${message.job_id}`, 'DELETE')).status).toBe(200);
    } finally { closeWebSocket(f.ws); }
  });

  it.each(['bundle-ack', 'run-manifest', 'artifacts/receipt'])('rechecks the assignment after reading a streamed %s body', async (action) => {
    const f = await setup();
    try {
      await f.submit();
      const message = await f.assigned();
      expect((await acknowledge(message)).status).toBe(200);
      const original = (await f.snapshot())!;
      let current = structuredClone(original);
      const saved = vi.fn();
      const ctx = { getGraphJob: () => Promise.resolve(current), saveGraphJob: saved } as unknown as RelayContext;
      const content = JSON.stringify(action === 'bundle-ack' ? { request_sha256: message.request_sha256 }
        : action === 'run-manifest' ? { contract_version: 'mere.run/graph-run.v1', job_id: original.job_id,
          graph_fingerprint: original.job.graph_fingerprint, state: 'finished' }
          : { schema: 'example.receipt.v1', counts: { accepted: 2 } });
      const bytes = new TextEncoder().encode(content);
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      let reading!: () => void;
      const started = new Promise<void>((resolve) => { reading = resolve; });
      const body = new ReadableStream<Uint8Array>({ start(stream) { controller = stream; }, pull() { reading(); } });
      const request = new Request('https://relay/private-upload', { method: action === 'bundle-ack' ? 'POST' : 'PUT', body,
        headers: { 'Content-Type': 'application/vnd.mere.identity-receipt+json', 'X-Artifact-Kind': 'graph.output',
          'X-Artifact-Path': 'outputs/receipt.json', 'X-Artifact-Size': String(bytes.byteLength), 'X-Artifact-Sha256': await sha256Hex(bytes) } });
      const pending = handleCustodyNodeRequest(ctx, original, action, request);
      await started;
      current = { ...structuredClone(original), node_token: 'new-assignment-token', attempt: original.attempt + 1,
        payload_redacted: false, inputs: { private: marker } };
      delete current.payload_delivered_at;
      controller.enqueue(bytes);
      controller.close();
      expect((await pending)?.status).toBe(409);
      expect(saved).not.toHaveBeenCalled();
      expect(current.inputs).toEqual({ private: marker });
      expect(await f.inventory()).toEqual([]);
      expect((await f.api(`/${original.job_id}`, 'DELETE')).status).toBe(200);
    } finally { closeWebSocket(f.ws); }
  });
});
