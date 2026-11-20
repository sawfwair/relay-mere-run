import { env as testEnv, runDurableObjectAlarm, runInDurableObject, SELF } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { handleClientApi } from '../src/client-api';
import { validateCreateRequest } from '../src/relay-api-graph';
import { buildGraphWebhookPayload } from '../src/relay-webhooks';
import { graphArtifactKey } from '../src/relay-graph-storage';
import type { RelayContext } from '../src/relay-context';
import type {
  AgentCapabilities,
  Env,
  GraphJob,
  GraphRunArtifact,
  SubmitGraphJobRequest,
} from '../src/types';
import canonicalLoRAGraph from './fixtures/graph-v1/lora-sample.workflow.json';
import canonicalParallelGraph from './fixtures/graph-v1/parallel-image-video.workflow.json';
import {
  closeWebSocket,
  connectAgent,
  readJson,
  waitForWebSocketJson,
} from './helpers';

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function graphCapabilities(
  models: string[],
  providers: NonNullable<AgentCapabilities['graph_worker']>['providers'] = [],
  cachedAssetDigests: string[] = [],
): AgentCapabilities {
  return {
    models,
    max_resolution: 2048,
    controlnet: false,
    lora: true,
    img2img: true,
    graph_worker: {
      schema_version: 1,
      worker_version: '0.3.0',
      contract_versions: ['mere.run/job-bundle.v1'],
      platform: 'linux',
      architecture: 'x86_64',
      accelerator_backend: 'cuda',
      memory_bytes: 24 * 1024 * 1024 * 1024,
      system_memory_bytes: 64 * 1024 * 1024 * 1024,
      logical_cpu_cores: 16,
      available_disk_bytes: 100 * 1024 * 1024 * 1024,
      network_access: true,
      node_kinds: [
        'image.train-lora',
        'image.generate',
        'video.generate',
        ...providers.flatMap((provider) => provider.node_kinds),
      ],
      installed_model_ids: models,
      available_secret_names: [],
      cached_asset_digests: cachedAssetDigests,
      providers,
      catalog: {
        graph_kind: 'mere.run/workflow-graph',
        graph_schema_version: 1,
        job_contract_version: 'mere.run/job-bundle.v1',
        nodes: [{
          kind: 'image.generate',
          title: 'Generate image',
          provider: { id: 'mere.run', version: '0.3.0' },
          inputs: [],
          outputs: [{ name: 'image', type: 'asset' }],
        }],
        providers: [],
      },
    },
  };
}

interface GraphFixture {
  digest: string;
  jobId: string;
  body: SubmitGraphJobRequest;
}

async function graphFixture(asset: Uint8Array): Promise<GraphFixture> {
  const digest = await sha256(asset);
  const jobId = crypto.randomUUID();
  return {
    digest,
    jobId,
    body: {
      job: {
        contract_version: 'mere.run/job-bundle.v1',
        job_id: jobId,
        created_at: '2026-07-15T12:00:00Z',
        graph_fingerprint: 'a'.repeat(64),
        input_fingerprint: 'b'.repeat(64),
        requirements: {
          minimum_mere_run_version: '0.3.0',
          node_kinds: ['image.train-lora'],
          model_ids: ['image-klein-9b'],
          models: [],
          providers: [],
          accelerator_backends: ['cuda', 'metal'],
        },
        outputs: [{ name: 'adapter', reference: 'nodes.train.outputs.adapter' }],
      },
      graph: {
        schema_version: 1,
        kind: 'mere.run/workflow-graph',
        name: 'train-style',
        inputs: { data: { type: 'asset_directory' } },
        nodes: [{
          id: 'train',
          kind: 'image.train-lora',
          arguments: { data: { $ref: 'inputs.data' }, seed: 7 },
        }],
        outputs: { adapter: { $ref: 'nodes.train.outputs.adapter' } },
      },
      inputs: { data: 'asset://data' },
      assets: {
        schema_version: 1,
        groups: [{
          name: 'data',
          kind: 'asset_directory',
          entries: [{ path: 'frame.png', digest, size_bytes: asset.byteLength, content_type: 'image/png' }],
        }],
      },
      client_id: 'test-client',
      relay_origin: 'https://relay',
    },
  };
}

async function publishEarlyImage(base: string, fixture: GraphFixture): Promise<GraphRunArtifact> {
  const bytes = new Uint8Array([51, 52, 53]);
  const digest = await sha256(bytes);
  const artifact: GraphRunArtifact = { name: `_live-generate-${digest}`, kind: 'graph.node-output',
    path: `.relay-publications/${digest}`, sha256: digest, size_bytes: bytes.length, content_type: 'image/png' };
  const uploaded = await SELF.fetch(`${base}/artifacts/${artifact.name}`, { method: 'PUT',
    headers: { 'Content-Type': artifact.content_type, 'X-Artifact-Size': String(bytes.length),
      'X-Artifact-Sha256': digest, 'X-Artifact-Path': artifact.path, 'X-Artifact-Kind': artifact.kind }, body: bytes });
  expect(uploaded.status).toBe(200);
  const published = await SELF.fetch(`${base}/publications`, { method: 'PUT', body: JSON.stringify({ artifacts: [artifact],
    run_manifest: { contract_version: 'mere.run/graph-run.v1', job_id: fixture.jobId,
      graph_fingerprint: fixture.body.job.graph_fingerprint, state: 'running', nodes: [{ id: 'generate', state: 'finished', artifacts: [artifact] }] } }) });
  expect(published.status).toBe(200);
  return artifact;
}

function makeAssetless(body: SubmitGraphJobRequest): void {
  body.graph = {
    schema_version: 1,
    kind: 'mere.run/workflow-graph',
    name: 'generate-image',
    inputs: { prompt: { type: 'string' } },
    nodes: [{
      id: 'generate',
      kind: 'image.generate',
      arguments: { prompt: { $ref: 'inputs.prompt' }, seed: 7 },
    }],
    outputs: { image: { $ref: 'nodes.generate.outputs.image' } },
  };
  body.inputs = { prompt: 'fixture image' };
  body.assets.groups = [];
  body.job.requirements.node_kinds = ['image.generate'];
  body.job.outputs = [{ name: 'image', reference: 'nodes.generate.outputs.image' }];
}

function makeDatasetProviderGraph(body: SubmitGraphJobRequest, catalogSHA256: string): void {
  body.graph.nodes = [{
    id: 'prepare',
    kind: 'dataset.prepare',
    provider: 'mere-dataset-tools',
    arguments: { directory: { $ref: 'inputs.data' }, maximum_images: 3 },
  }];
  body.graph.outputs = {
    'contact-sheet': { $ref: 'nodes.prepare.outputs.contact_sheet' },
  };
  body.job.requirements.node_kinds = ['dataset.prepare'];
  body.job.requirements.model_ids = [];
  body.job.requirements.models = [];
  body.job.requirements.providers = [{
    id: 'mere-dataset-tools',
    version: '0.2.0',
    catalog_sha256: catalogSHA256,
    node_kinds: ['dataset.prepare'],
  }];
  body.job.outputs = [{
    name: 'contact-sheet',
    reference: 'nodes.prepare.outputs.contact_sheet',
  }];
}

function encodeBundleDocument(value: unknown): string {
  return btoa(typeof value === 'string' ? value : JSON.stringify(value));
}

function sortJsonKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonKeys);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortJsonKeys(entry)]),
  );
}

const BUILTIN_NODE_OUTPUT_CASES = [
  ['text.value', 'text'],
  ['integer.value', 'value'],
  ['number.value', 'value'],
  ['boolean.value', 'value'],
  ['json.value', 'value'],
  ['seed.value', 'seed'],
  ['choice.value', 'value'],
  ['text.join', 'text'],
  ['text.template', 'text'],
  ['text.enhance', 'text'],
  ['image.describe', 'text'],
  ['vision.ground', 'image'],
  ['vision.ground', 'detections'],
  ['image.train-lora', 'adapter'],
  ['image.generate', 'image'],
  ['video.generate', 'video'],
] as const;

describe('portable graph jobs', () => {
  it.each(BUILTIN_NODE_OUTPUT_CASES)(
    'accepts the current mere.run built-in contract for %s',
    async (kind, output) => {
      const fixture = await graphFixture(new Uint8Array([1]));
      fixture.body.graph = {
        schema_version: 1,
        kind: 'mere.run/workflow-graph',
        name: `builtin-${kind.replace('.', '-')}`,
        inputs: {},
        nodes: [{ id: 'builtin', kind, arguments: {} }],
        outputs: { result: { $ref: `nodes.builtin.outputs.${output}` } },
      };
      fixture.body.inputs = {};
      fixture.body.assets.groups = [];
      fixture.body.job.requirements.node_kinds = [kind];
      fixture.body.job.outputs = [{
        name: 'result',
        reference: `nodes.builtin.outputs.${output}`,
      }];

      expect(validateCreateRequest(fixture.body)).toBeNull();
    },
  );

  it('rejects graph webhook targets that are not public HTTPS origins', async () => {
    const fixture = await graphFixture(new Uint8Array([1]));
    fixture.body.job.webhook_url = 'http://127.0.0.1/internal';
    expect(validateCreateRequest(fixture.body)).toBe(
      'graph webhook_url must be a public HTTPS origin'
    );
    fixture.body.job.webhook_url = 'https://identity.example/hooks/relay';
    expect(validateCreateRequest(fixture.body)).toBeNull();
  });

  it('embeds only verified sanitized receipt JSON in terminal graph webhooks', async () => {
    const userId = `graph-webhook-receipt-${crypto.randomUUID()}`;
    const jobId = crypto.randomUUID();
    const receipt = {
      schema: 'identity.provider-receipt.v1',
      request_sha256: 'a'.repeat(64),
      result_sha256: 'b'.repeat(64),
      provider_catalog_sha256: 'c'.repeat(64),
    };
    const bytes = new TextEncoder().encode(JSON.stringify(receipt));
    const digest = await sha256(bytes);
    const artifact: GraphRunArtifact = {
      name: 'receipt',
      kind: 'graph.output',
      path: 'outputs/receipt.json',
      content_type: 'application/vnd.mere.identity-receipt+json',
      size_bytes: bytes.byteLength,
      sha256: digest,
    };
    await testEnv.IMAGES.put(graphArtifactKey(userId, jobId, 'receipt'), bytes, {
      customMetadata: { sha256: digest },
    });
    const payload = await buildGraphWebhookPayload(
      { env: testEnv } as unknown as RelayContext,
      {
        job_id: jobId,
        job: (await graphFixture(new Uint8Array([1]))).body.job,
        user_id: userId,
        state: 'finished',
        artifacts: [artifact],
        artifact_uploads: {},
        run_manifest: { state: 'finished' },
      } as unknown as GraphJob,
    );
    expect(payload).toMatchObject({
      sanitized_outputs: {
        receipt: {
          artifact: { sha256: digest, size_bytes: bytes.byteLength },
          value: receipt,
        },
      },
    });

    const unsafe = new TextEncoder().encode(JSON.stringify({ ...receipt, raw_prompt: 'private' }));
    const unsafeDigest = await sha256(unsafe);
    await testEnv.IMAGES.put(graphArtifactKey(userId, jobId, 'receipt'), unsafe, {
      customMetadata: { sha256: unsafeDigest },
    });
    const unsafePayload = await buildGraphWebhookPayload(
      { env: testEnv } as unknown as RelayContext,
      {
        job_id: jobId,
        job: (await graphFixture(new Uint8Array([1]))).body.job,
        user_id: userId,
        state: 'finished',
        artifacts: [{ ...artifact, sha256: unsafeDigest, size_bytes: unsafe.byteLength }],
        artifact_uploads: {},
        run_manifest: { state: 'finished' },
      } as unknown as GraphJob,
    );
    expect(unsafePayload).not.toHaveProperty('sanitized_outputs');
  });

  it('surfaces the live node catalog through account-scoped fleet capabilities', async () => {
    const userId = `graph-catalog-${crypto.randomUUID()}`;
    const { ws } = await connectAgent(userId, graphCapabilities([]), { deviceId: 'catalog-node' });
    try {
      const response = await handleClientApi(
        new Request('https://relay/api/graph-jobs/capabilities'),
        testEnv as unknown as Env,
        userId,
      );
      expect(response.status).toBe(200);
      expect(await readJson(response)).toMatchObject({
        catalog: {
          graph_kind: 'mere.run/workflow-graph',
          nodes: [{ kind: 'image.generate', title: 'Generate image' }],
        },
      });

      const fixture = await graphFixture(new Uint8Array([1]));
      makeAssetless(fixture.body);
      fixture.body.job.requirements.model_ids = [];
      const preflight = await handleClientApi(
        new Request('https://relay/api/graph-jobs/preflight', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(fixture.body),
        }),
        testEnv as unknown as Env,
        userId,
      );
      expect(preflight.status).toBe(200);
      expect(await readJson(preflight)).toMatchObject({ placement: { eligible_nodes: 1 } });
      const jobs = await handleClientApi(
        new Request('https://relay/api/graph-jobs'),
        testEnv as unknown as Env,
        userId,
      );
      expect(await readJson(jobs)).toEqual({ jobs: [] });
    } finally {
      closeWebSocket(ws);
    }
  });

  it('prefers an eligible graph worker that already caches the input assets', async () => {
    const userId = `graph-cache-placement-${crypto.randomUUID()}`;
    const asset = new Uint8Array([4, 8, 15, 16, 23, 42]);
    const fixture = await graphFixture(asset);
    const uncached = await connectAgent(
      userId,
      graphCapabilities(['image-klein-9b']),
      { deviceId: 'uncached-graph-node' }
    );
    const cached = await connectAgent(
      userId,
      graphCapabilities(['image-klein-9b'], [], [fixture.digest]),
      { deviceId: 'cached-graph-node' }
    );

    try {
      const created = await uncached.relay.fetch(new Request('https://relay/internal/graph-jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-User-Id': userId },
        body: JSON.stringify(fixture.body),
      }));
      expect(created.status).toBe(201);
      const status = await uncached.relay.fetch(new Request(
        `https://relay/internal/graph-jobs/${fixture.jobId}`
      ));
      const createdBody = await readJson<{
        placement: { nodes: Array<Record<string, unknown>> };
      }>(status);
      expect(
        createdBody.placement.nodes.find((node) => node.device_id === 'cached-graph-node')
      ).toMatchObject({
        cached_input_bytes: asset.byteLength,
        total_input_bytes: asset.byteLength,
      });
      const upload = await uncached.relay.fetch(new Request(
        `https://relay/internal/graph-jobs/${fixture.jobId}/assets/${fixture.digest}`,
        { method: 'PUT', body: asset }
      ));
      expect(upload.status).toBe(200);
      const committed = await uncached.relay.fetch(new Request(
        `https://relay/internal/graph-jobs/${fixture.jobId}/commit`,
        { method: 'POST' }
      ));
      expect((await readJson<{ agent_id: string | null }>(committed)).agent_id).toBe(cached.agentId);
      expect((await waitForWebSocketJson<Record<string, unknown>>(cached.ws)).type)
        .toBe('graph_request');
    } finally {
      closeWebSocket(uncached.ws);
      closeWebSocket(cached.ws);
    }
  });

  it('deduplicates graph submissions by account-scoped idempotency key', async () => {
    const userId = `graph-idempotency-${crypto.randomUUID()}`;
    const { relay, ws } = await connectAgent(userId, graphCapabilities(['image-klein-9b']));
    const first = await graphFixture(new Uint8Array([1]));
    first.body.job.idempotency_key = 'identity:logical-job-1';
    const repeated = structuredClone(first.body);
    repeated.job.job_id = crypto.randomUUID();
    try {
      const submit = (body: SubmitGraphJobRequest) => relay.fetch(new Request(
        'https://relay/internal/graph-jobs',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-User-Id': userId },
          body: JSON.stringify(body),
        }
      ));
      expect((await readJson<{ job_id: string }>(await submit(first.body))).job_id).toBe(first.jobId);
      const duplicate = await submit(repeated);
      expect(duplicate.status).toBe(200);
      expect((await readJson<{ job_id: string }>(duplicate)).job_id).toBe(first.jobId);

      repeated.job.input_fingerprint = 'c'.repeat(64);
      const conflict = await submit(repeated);
      expect(conflict.status).toBe(409);
      await expect(readJson(conflict)).resolves.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    } finally {
      closeWebSocket(ws);
    }
  });

  it('reports system memory, CPU, disk, and network resource blockers', async () => {
    const userId = `graph-resource-placement-${crypto.randomUUID()}`;
    const capabilities = graphCapabilities(['image-klein-9b']);
    const worker = capabilities.graph_worker!;
    worker.system_memory_bytes = 8 * 1024 * 1024 * 1024;
    worker.logical_cpu_cores = 4;
    worker.available_disk_bytes = 10 * 1024 * 1024 * 1024;
    worker.network_access = false;
    const { relay, ws } = await connectAgent(userId, capabilities, { deviceId: 'small-offline-node' });
    const fixture = await graphFixture(new Uint8Array([1]));
    const body = fixture.body as unknown as SubmitGraphJobRequest;
    makeAssetless(body);
    body.job.requirements.minimum_system_memory_bytes = 16 * 1024 * 1024 * 1024;
    body.job.requirements.minimum_cpu_cores = 8;
    body.job.requirements.minimum_disk_bytes = 20 * 1024 * 1024 * 1024;
    body.job.requirements.network_access = true;
    try {
      const create = await relay.fetch(new Request('https://relay/internal/graph-jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-User-Id': userId },
        body: JSON.stringify(body),
      }));
      expect(create.status).toBe(201);
      const commit = await readJson<{ placement: { nodes: Array<{ blockers: Array<{ code: string }> }> } }>(
        await relay.fetch(new Request(`https://relay/internal/graph-jobs/${fixture.jobId}/commit`, { method: 'POST' }))
      );
      expect(commit.placement.nodes[0].blockers.map((blocker) => blocker.code)).toEqual(expect.arrayContaining([
        'system_memory_insufficient',
        'cpu_capacity_insufficient',
        'disk_space_insufficient',
        'network_access_unavailable',
      ]));
    } finally {
      closeWebSocket(ws);
    }
  });

  it('keeps secret values out of graph jobs and places only on nodes with the named secret', async () => {
    const userId = `graph-secret-placement-${crypto.randomUUID()}`;
    const catalogSHA256 = 'f'.repeat(64);
    const provider = {
      id: 'mere-dataset-tools',
      version: '0.2.0',
      catalog_sha256: catalogSHA256,
      node_kinds: ['dataset.prepare'],
    };
    const capabilities = graphCapabilities([], [provider]);
    const { relay, ws } = await connectAgent(userId, capabilities, { deviceId: 'secretless-node' });
    const asset = new Uint8Array([7, 7, 7]);
    const fixture = await graphFixture(asset);
    const body = fixture.body as unknown as SubmitGraphJobRequest;
    makeDatasetProviderGraph(body, catalogSHA256);
    body.graph.nodes[0].arguments.api_token = { $secret: 'dataset-token' };
    body.graph.nodes[0].execution = { cache: 'never' };
    body.job.requirements.secret_names = ['dataset-token'];
    try {
      const create = await relay.fetch(new Request('https://relay/internal/graph-jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-User-Id': userId },
        body: JSON.stringify(body),
      }));
      expect(create.status).toBe(201);
      await relay.fetch(new Request(
        `https://relay/internal/graph-jobs/${fixture.jobId}/assets/${fixture.digest}`,
        { method: 'PUT', body: asset }
      ));
      const commit = await readJson<{ placement: { nodes: Array<{ blockers: Array<{ code: string }> }> } }>(
        await relay.fetch(new Request(`https://relay/internal/graph-jobs/${fixture.jobId}/commit`, { method: 'POST' }))
      );
      expect(commit.placement.nodes[0].blockers).toContainEqual(expect.objectContaining({ code: 'secret_missing' }));
      expect(JSON.stringify(body)).not.toContain('MERERUN_SECRET_DATASET_TOKEN');
    } finally {
      closeWebSocket(ws);
    }
  });

  it('accepts the canonical cross-runtime LoRA graph fixture', async () => {
    const userId = `graph-fixture-${crypto.randomUUID()}`;
    const { relay, ws } = await connectAgent(userId, graphCapabilities(['image-klein-9b']));
    const asset = new Uint8Array([5, 4, 3, 2, 1]);
    const fixture = await graphFixture(asset);
    const body = structuredClone(fixture.body) as unknown as SubmitGraphJobRequest;
    body.graph = structuredClone(canonicalLoRAGraph) as unknown as SubmitGraphJobRequest['graph'];
    body.inputs = { dataset: 'asset://dataset', prompt: 'a cobalt ceramic fox' };
    body.assets.groups[0].name = 'dataset';
    body.job.requirements.node_kinds = ['image.train-lora', 'image.generate'];
    body.job.outputs = [
      { name: 'adapter', reference: 'nodes.train-style.outputs.adapter' },
      { name: 'sample', reference: 'nodes.sample-style.outputs.image' },
    ];

    try {
      const response = await relay.fetch(new Request('https://relay/internal/graph-jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-User-Id': userId },
        body: JSON.stringify(body),
      }));
      expect(response.status).toBe(201);
      expect((await readJson<Record<string, unknown>>(response)).job_id).toBe(fixture.jobId);
    } finally {
      closeWebSocket(ws);
    }
  });

  it('accepts the canonical cross-runtime parallel graph fixture', async () => {
    const userId = `graph-parallel-fixture-${crypto.randomUUID()}`;
    const { relay, ws } = await connectAgent(userId, graphCapabilities([]));
    const fixture = await graphFixture(new Uint8Array([1]));
    const body = fixture.body as unknown as SubmitGraphJobRequest;
    makeAssetless(body);
    body.graph = canonicalParallelGraph as SubmitGraphJobRequest['graph'];
    body.inputs = { prompt: 'two cobalt ceramic forms' };
    body.job.requirements.node_kinds = ['image.generate', 'video.generate'];
    body.job.requirements.model_ids = [];
    body.job.outputs = [
      { name: 'primary-image', reference: 'nodes.image-a.outputs.image' },
      { name: 'secondary-image', reference: 'nodes.image-b.outputs.image' },
      { name: 'video', reference: 'nodes.video.outputs.video' },
    ];

    try {
      const response = await relay.fetch(new Request('https://relay/internal/graph-jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-User-Id': userId },
        body: JSON.stringify(body),
      }));
      expect(response.status).toBe(201);
      expect((await readJson<Record<string, unknown>>(response)).job_id).toBe(fixture.jobId);
    } finally {
      closeWebSocket(ws);
    }
  });

  it('runs the two-phase graph contract independently from plugin tool jobs', async () => {
    const userId = `graph-${crypto.randomUUID()}`;
    const { relay, ws } = await connectAgent(userId, graphCapabilities(['image-klein-9b']));
    const asset = new Uint8Array([1, 2, 3, 4, 5]);
    const fixture = await graphFixture(asset);
    try {
      const create = await relay.fetch(new Request('https://relay/internal/graph-jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-User-Id': userId },
        body: JSON.stringify(fixture.body),
      }));
      expect(create.status).toBe(201);
      expect(await readJson(create)).toMatchObject({
        job_id: fixture.jobId,
        state: 'planned',
        missing_asset_digests: [fixture.digest],
      });

      const rejected = await relay.fetch(new Request(
        `https://relay/internal/graph-jobs/${fixture.jobId}/assets/${fixture.digest}`,
        { method: 'PUT', body: new Uint8Array([9, 9, 9, 9, 9]) }
      ));
      expect(rejected.status).toBe(400);
      expect(await readJson<Record<string, string>>(rejected)).toEqual({ error: 'Asset SHA-256 mismatch' });

      const upload = await relay.fetch(new Request(
        `https://relay/internal/graph-jobs/${fixture.jobId}/assets/${fixture.digest}`,
        { method: 'PUT', body: asset }
      ));
      expect(upload.status).toBe(200);

      const commit = await relay.fetch(new Request(
        `https://relay/internal/graph-jobs/${fixture.jobId}/commit`,
        { method: 'POST' }
      ));
      expect(commit.status).toBe(200);
      expect((await readJson<Record<string, unknown>>(commit)).state).toBe('assigned');

      const request = await waitForWebSocketJson<{
        type: string;
        job_id: string;
        bundle_files: Array<{ path: string; url: string; sha256: string }>;
        upload_url_base: string;
      }>(ws);
      expect(request.type).toBe('graph_request');
      expect(request.job_id).toBe(fixture.jobId);
      expect(request.bundle_files.map((file) => file.path)).toEqual([
        'assets.json',
        `assets/sha256/${fixture.digest}`,
        'graph.json',
        'inputs.json',
        'job.json',
      ]);

      for (const file of request.bundle_files) {
        const response = await SELF.fetch(file.url);
        expect(response.status).toBe(200);
        expect(await sha256(new Uint8Array(await response.arrayBuffer()))).toBe(file.sha256);
      }

      ws.send(JSON.stringify({
        type: 'graph_event',
        job_id: fixture.jobId,
        owner_user_id: userId,
        event: {
          sequence: 0,
          created_at: '2026-07-15T12:01:00Z',
          type: 'run_started',
          state: 'running',
        },
      }));
      await vi.waitFor(async () => {
        const response = await relay.fetch(new Request(`https://relay/internal/graph-jobs/${fixture.jobId}/events`));
        const eventText = new TextDecoder().decode(await response.arrayBuffer());
        expect(eventText).toContain('"type":"run_started"');
      });

      const artifactBytes = new Uint8Array([8, 7, 6]);
      const artifact: GraphRunArtifact = {
        name: 'adapter',
        kind: 'graph.output',
        path: 'outputs/adapter.safetensors',
        content_type: 'application/x-safetensors',
        size_bytes: artifactBytes.byteLength,
        sha256: await sha256(artifactBytes),
      };
      const artifactUpload = await SELF.fetch(`${request.upload_url_base}/artifacts/adapter`, {
        method: 'PUT',
        headers: {
          'Content-Type': artifact.content_type,
          'X-Artifact-Size': String(artifact.size_bytes),
          'X-Artifact-Sha256': artifact.sha256,
          'X-Artifact-Path': artifact.path,
          'X-Artifact-Kind': artifact.kind,
        },
        body: artifactBytes,
      });
      expect(artifactUpload.status).toBe(200);

      const runManifest = {
        contract_version: 'mere.run/graph-run.v1',
        job_id: fixture.jobId,
        graph_fingerprint: fixture.body.job.graph_fingerprint,
        state: 'finished',
        outputs: [artifact],
      };
      const manifestUpload = await SELF.fetch(`${request.upload_url_base}/run-manifest`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(runManifest),
      });
      expect(manifestUpload.status).toBe(200);

      const metrics = {
        bundle_bytes_downloaded: 1024,
        download_ms: 10,
        execution_ms: 20,
        upload_ms: 30,
        total_ms: 60,
        artifact_bytes_uploaded: artifact.size_bytes,
        artifact_parts_uploaded: 1,
        artifact_bytes_reused: 0,
        artifact_parts_reused: 0,
      };

      ws.send(JSON.stringify({
        type: 'graph_result',
        job_id: fixture.jobId,
        owner_user_id: userId,
        run_manifest: runManifest,
        artifacts: [artifact],
        metrics,
      }));
      await vi.waitFor(async () => {
        const response = await relay.fetch(new Request(`https://relay/internal/graph-jobs/${fixture.jobId}`));
        const status = await readJson<Record<string, unknown>>(response);
        expect(status.state).toBe('finished');
        expect(status.artifacts).toEqual([artifact]);
        expect(status.metrics).toEqual(metrics);
      });
      expect((await waitForWebSocketJson<{ type: string }>(ws)).type).toBe('inventory_request');

      const fetched = await relay.fetch(new Request(
        `https://relay/internal/graph-jobs/${fixture.jobId}/artifacts/adapter`
      ));
      expect(fetched.status).toBe(200);
      expect(new Uint8Array(await fetched.arrayBuffer())).toEqual(artifactBytes);

      const sseResponse = await handleClientApi(new Request(
        `https://relay/api/graph-jobs/${fixture.jobId}/events`,
        { headers: { Accept: 'text/event-stream' } }
      ), testEnv as unknown as Env, userId);
      expect(sseResponse.headers.get('Content-Type')).toContain('text/event-stream');
      const sse = await new Response(sseResponse.body).text();
      expect(sse.indexOf('event: connected')).toBeGreaterThanOrEqual(0);
      expect(sse.indexOf('event: graph_event')).toBeGreaterThan(sse.indexOf('event: connected'));
      expect(sse.indexOf('event: done')).toBeGreaterThan(sse.indexOf('event: graph_event'));
      expect(sse).toContain('"state":"finished"');
    } finally {
      closeWebSocket(ws);
    }
  });

  it('assembles verified artifact parts and reuses content for artifact aliases', async () => {
    const userId = `graph-parts-${crypto.randomUUID()}`;
    const { relay, ws } = await connectAgent(userId, graphCapabilities(['image-klein-9b']));
    const fixture = await graphFixture(new Uint8Array([1]));
    makeAssetless(fixture.body as unknown as SubmitGraphJobRequest);
    try {
      await relay.fetch(new Request('https://relay/internal/graph-jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-User-Id': userId },
        body: JSON.stringify(fixture.body),
      }));
      await relay.fetch(new Request(
        `https://relay/internal/graph-jobs/${fixture.jobId}/commit`,
        { method: 'POST' },
      ));
      const request = await waitForWebSocketJson<{ upload_url_base: string }>(ws);

      const artifactBytes = new Uint8Array([10, 20, 30, 40, 50, 60, 70]);
      const artifact: GraphRunArtifact = {
        name: 'image',
        kind: 'graph.output',
        path: 'outputs/image.png',
        content_type: 'image/png',
        size_bytes: artifactBytes.byteLength,
        sha256: await sha256(artifactBytes),
      };
      const chunks = [artifactBytes.slice(0, 4), artifactBytes.slice(4)];
      const rejectedPart = await SELF.fetch(`${request.upload_url_base}/artifacts/image`, {
        method: 'PUT',
        headers: {
          'Content-Type': artifact.content_type,
          'X-Artifact-Size': String(artifact.size_bytes),
          'X-Artifact-Sha256': artifact.sha256,
          'X-Artifact-Path': artifact.path,
          'X-Artifact-Kind': artifact.kind,
          'X-Artifact-Part-Index': '0',
          'X-Artifact-Part-Count': String(chunks.length),
          'X-Artifact-Part-Size': String(chunks[0].byteLength),
          'X-Artifact-Part-Sha256': await sha256(chunks[0]),
        },
        body: new Uint8Array(chunks[0].byteLength),
      });
      expect(rejectedPart.status).toBe(400);
      expect(await readJson<Record<string, string>>(rejectedPart)).toEqual({
        error: 'Graph artifact part verification failed',
      });

      for (const [index, chunk] of chunks.entries()) {
        const upload = await SELF.fetch(`${request.upload_url_base}/artifacts/image`, {
          method: 'PUT',
          headers: {
            'Content-Type': artifact.content_type,
            'X-Artifact-Size': String(artifact.size_bytes),
            'X-Artifact-Sha256': artifact.sha256,
            'X-Artifact-Path': artifact.path,
            'X-Artifact-Kind': artifact.kind,
            'X-Artifact-Part-Index': String(index),
            'X-Artifact-Part-Count': String(chunks.length),
            'X-Artifact-Part-Size': String(chunk.byteLength),
            'X-Artifact-Part-Sha256': await sha256(chunk),
          },
          body: chunk,
        });
        expect(upload.status).toBe(200);
        expect((await readJson<Record<string, unknown>>(upload)).complete).toBe(index === chunks.length - 1);
        const status = await SELF.fetch(
          `${request.upload_url_base}/artifact-uploads/${artifact.sha256}`,
        );
        expect(status.status).toBe(200);
        expect(await readJson(status)).toMatchObject({
          sha256: artifact.sha256,
          size_bytes: artifact.size_bytes,
          part_count: chunks.length,
          complete: index === chunks.length - 1,
        });
      }

      const alias: GraphRunArtifact = {
        ...artifact,
        name: '_node-generate-image',
        kind: 'image',
        path: 'nodes/000-generate/artifacts/image.png',
      };
      const runManifest = {
        contract_version: 'mere.run/graph-run.v1',
        job_id: fixture.jobId,
        graph_fingerprint: fixture.body.job.graph_fingerprint,
        state: 'finished',
        outputs: [artifact],
      };
      ws.send(JSON.stringify({
        type: 'graph_result',
        job_id: fixture.jobId,
        owner_user_id: userId,
        run_manifest: runManifest,
        artifacts: [artifact, alias],
      }));
      await vi.waitFor(async () => {
        const response = await relay.fetch(new Request(`https://relay/internal/graph-jobs/${fixture.jobId}`));
        expect((await readJson<Record<string, unknown>>(response)).state).toBe('finished');
      });

      for (const name of [artifact.name, alias.name]) {
        const fetched = await relay.fetch(new Request(
          `https://relay/internal/graph-jobs/${fixture.jobId}/artifacts/${name}`,
        ));
        expect(fetched.status).toBe(200);
        expect(fetched.headers.get('Content-Length')).toBe(String(artifactBytes.byteLength));
        expect(new Uint8Array(await fetched.arrayBuffer())).toEqual(artifactBytes);
      }
    } finally {
      closeWebSocket(ws);
    }
  });

  it('delivers canonical manifest bytes without rounding 64-bit seeds', async () => {
    const userId = `graph-int64-${crypto.randomUUID()}`;
    const { relay, ws } = await connectAgent(userId, graphCapabilities(['image-klein-9b']));
    const fixture = await graphFixture(new Uint8Array([1]));
    makeAssetless(fixture.body as unknown as SubmitGraphJobRequest);
    const body = fixture.body as unknown as SubmitGraphJobRequest;
    const exactSeed = '1205675978010373390';
    body.graph.nodes[0].arguments.seed = Number(exactSeed);
    const graphDocument = JSON.stringify(body.graph).replace(
      String(Number(exactSeed)),
      exactSeed,
    );
    body.bundle_documents = {
      'job.json': encodeBundleDocument(body.job),
      'graph.json': encodeBundleDocument(graphDocument),
      'inputs.json': encodeBundleDocument(body.inputs),
      'assets.json': encodeBundleDocument(body.assets),
    };

    try {
      const create = await relay.fetch(new Request('https://relay/internal/graph-jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-User-Id': userId },
        body: JSON.stringify(body),
      }));
      expect(create.status).toBe(201);
      const commit = await relay.fetch(new Request(
        `https://relay/internal/graph-jobs/${fixture.jobId}/commit`,
        { method: 'POST' },
      ));
      expect(commit.status).toBe(200);
      const request = await waitForWebSocketJson<{
        bundle_files: Array<{ path: string; url: string }>;
      }>(ws);
      const graphFile = request.bundle_files.find((file) => file.path === 'graph.json');
      expect(graphFile).toBeDefined();
      const delivered = await SELF.fetch(graphFile!.url);

      expect(delivered.status).toBe(200);
      expect(await delivered.text()).toContain(`"seed":${exactSeed}`);
    } finally {
      closeWebSocket(ws);
    }
  });

  it('accepts canonical bundle documents independent of object key order', async () => {
    const userId = `graph-bundle-order-${crypto.randomUUID()}`;
    const { relay, ws } = await connectAgent(userId, graphCapabilities(['image-klein-9b']));
    const fixture = await graphFixture(new Uint8Array([1]));
    makeAssetless(fixture.body);
    fixture.body.bundle_documents = {
      'job.json': encodeBundleDocument(sortJsonKeys(fixture.body.job)),
      'graph.json': encodeBundleDocument(sortJsonKeys(fixture.body.graph)),
      'inputs.json': encodeBundleDocument(sortJsonKeys(fixture.body.inputs)),
      'assets.json': encodeBundleDocument(sortJsonKeys(fixture.body.assets)),
    };

    try {
      const create = await relay.fetch(new Request('https://relay/internal/graph-jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-User-Id': userId },
        body: JSON.stringify(fixture.body),
      }));

      expect(create.status).toBe(201);
    } finally {
      closeWebSocket(ws);
    }
  });

  it('rejects bundle documents whose semantic contents differ from the request', async () => {
    const userId = `graph-bundle-tamper-${crypto.randomUUID()}`;
    const { relay, ws } = await connectAgent(userId, graphCapabilities(['image-klein-9b']));
    const fixture = await graphFixture(new Uint8Array([1]));
    makeAssetless(fixture.body);
    fixture.body.bundle_documents = {
      'job.json': encodeBundleDocument(sortJsonKeys(fixture.body.job)),
      'graph.json': encodeBundleDocument(sortJsonKeys({
        ...fixture.body.graph,
        name: 'tampered-graph-name',
      })),
      'inputs.json': encodeBundleDocument(sortJsonKeys(fixture.body.inputs)),
      'assets.json': encodeBundleDocument(sortJsonKeys(fixture.body.assets)),
    };

    try {
      const create = await relay.fetch(new Request('https://relay/internal/graph-jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-User-Id': userId },
        body: JSON.stringify(fixture.body),
      }));

      expect(create.status).toBe(400);
      expect(await readJson(create)).toEqual({ error: 'invalid bundle documents' });
    } finally {
      closeWebSocket(ws);
    }
  });

  it('keeps graph jobs queued when only legacy nodes are connected', async () => {
    const userId = `graph-legacy-${crypto.randomUUID()}`;
    const legacyCapabilities: AgentCapabilities = {
      models: ['image-klein-9b'],
      max_resolution: 2048,
      controlnet: false,
      lora: true,
      img2img: true,
    };
    const { relay, ws } = await connectAgent(userId, legacyCapabilities);
    const fixture = await graphFixture(new Uint8Array([4, 3, 2, 1]));
    makeAssetless(fixture.body as unknown as SubmitGraphJobRequest);
    try {
      await relay.fetch(new Request('https://relay/internal/graph-jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-User-Id': userId },
        body: JSON.stringify(fixture.body),
      }));
      const commit = await relay.fetch(new Request(
        `https://relay/internal/graph-jobs/${fixture.jobId}/commit`,
        { method: 'POST' }
      ));
      expect(commit.status).toBe(200);
      const response = await readJson<Record<string, unknown>>(commit);
      expect(response.state).toBe('queued');
      expect(response.placement).toMatchObject({
        connected_nodes: 1,
        graph_worker_nodes: 0,
        eligible_nodes: 0,
        diagnostic: 'Connected nodes do not advertise graph worker support',
        nodes: [{
          eligible: false,
          blockers: [{ code: 'graph_worker_missing' }],
        }],
      });

      const fleet = await readJson<{ activity: Array<Record<string, unknown>> }>(
        await relay.fetch(new Request('https://relay/internal/fleet'))
      );
      expect(fleet.activity).toContainEqual(expect.objectContaining({
        id: fixture.jobId,
        kind: 'graph',
        status: 'queued',
        label: 'generate-image',
      }));
    } finally {
      closeWebSocket(ws);
    }
  });

  it('reports the exact model preventing graph placement', async () => {
    const userId = `graph-placement-${crypto.randomUUID()}`;
    const { relay, ws } = await connectAgent(userId, graphCapabilities([]), {
      deviceId: 'missing-model-node',
      deviceName: 'CUDA runner',
    });
    const fixture = await graphFixture(new Uint8Array([9]));
    makeAssetless(fixture.body as unknown as SubmitGraphJobRequest);
    try {
      await relay.fetch(new Request('https://relay/internal/graph-jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-User-Id': userId },
        body: JSON.stringify(fixture.body),
      }));
      const response = await readJson<Record<string, unknown>>(await relay.fetch(new Request(
        `https://relay/internal/graph-jobs/${fixture.jobId}/commit`,
        { method: 'POST' }
      )));
      expect(response).toMatchObject({
        state: 'queued',
        placement: {
          graph_worker_nodes: 1,
          eligible_nodes: 0,
          nodes: [{
            device_id: 'missing-model-node',
            device_name: 'CUDA runner',
            blockers: [{
              code: 'model_missing',
              message: 'Required model image-klein-9b is not installed',
            }],
          }],
        },
      });
    } finally {
      closeWebSocket(ws);
    }
  });

  it('pins private graph artifacts to their owning Relay device', async () => {
    const userId = `graph-device-pin-${crypto.randomUUID()}`;
    const other = await connectAgent(userId, graphCapabilities(['image-klein-9b']), {
      deviceId: 'other-graph-node',
    });
    const owner = await connectAgent(userId, graphCapabilities(['image-klein-9b']), {
      deviceId: 'artifact-owner-node',
    });
    const fixture = await graphFixture(new Uint8Array([9, 9, 9]));
    makeAssetless(fixture.body);
    fixture.body.job.requirements.required_device_id = 'artifact-owner-node';
    try {
      const create = await owner.relay.fetch(new Request('https://relay/internal/graph-jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-User-Id': userId },
        body: JSON.stringify(fixture.body),
      }));
      expect(create.status).toBe(201);
      const commit = await readJson<{
        agent_id: string | null;
        placement: { nodes: Array<{ device_id: string; blockers: Array<{ code: string }> }> };
      }>(await owner.relay.fetch(new Request(
        `https://relay/internal/graph-jobs/${fixture.jobId}/commit`,
        { method: 'POST' },
      )));
      expect(commit.agent_id).toBe(owner.agentId);
      expect(commit.placement.nodes.find((node) => node.device_id === 'other-graph-node')?.blockers)
        .toContainEqual(expect.objectContaining({ code: 'required_device_mismatch' }));
      expect((await waitForWebSocketJson<{ type: string; job_id: string }>(owner.ws)))
        .toMatchObject({ type: 'graph_request', job_id: fixture.jobId });
    } finally {
      closeWebSocket(other.ws);
      closeWebSocket(owner.ws);
    }
  });

  it('schedules external node kinds only on the exact pinned graph provider', async () => {
    const userId = `graph-provider-${crypto.randomUUID()}`;
    const catalogSHA256 = 'c'.repeat(64);
    const provider = {
      id: 'mere-dataset-tools',
      version: '0.2.0',
      catalog_sha256: catalogSHA256,
      node_kinds: ['dataset.prepare'],
    };
    const { relay, ws } = await connectAgent(userId, graphCapabilities([], [provider]));
    const fixture = await graphFixture(new Uint8Array([9, 8, 7]));
    const body = fixture.body as unknown as SubmitGraphJobRequest;
    makeDatasetProviderGraph(body, catalogSHA256);
    try {
      const create = await relay.fetch(new Request('https://relay/internal/graph-jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-User-Id': userId },
        body: JSON.stringify(body),
      }));
      expect(create.status).toBe(201);
      await relay.fetch(new Request(
        `https://relay/internal/graph-jobs/${fixture.jobId}/assets/${fixture.digest}`,
        { method: 'PUT', body: new Uint8Array([9, 8, 7]) },
      ));
      const commit = await readJson<Record<string, unknown>>(await relay.fetch(new Request(
        `https://relay/internal/graph-jobs/${fixture.jobId}/commit`,
        { method: 'POST' },
      )));
      expect(commit).toMatchObject({
        state: 'assigned',
        placement: { eligible_nodes: 0 },
      });
      expect((await waitForWebSocketJson<{ type: string; job_id: string }>(ws))).toMatchObject({
        type: 'graph_request',
        job_id: fixture.jobId,
      });
    } finally {
      closeWebSocket(ws);
    }
  });

  it('reports an exact provider pin mismatch during placement', async () => {
    const userId = `graph-provider-mismatch-${crypto.randomUUID()}`;
    const requiredCatalog = 'd'.repeat(64);
    const { relay, ws } = await connectAgent(userId, graphCapabilities([], [{
      id: 'mere-dataset-tools',
      version: '0.1.0',
      catalog_sha256: 'e'.repeat(64),
      node_kinds: ['dataset.prepare'],
    }]));
    const asset = new Uint8Array([6, 5, 4]);
    const fixture = await graphFixture(asset);
    const body = fixture.body as unknown as SubmitGraphJobRequest;
    makeDatasetProviderGraph(body, requiredCatalog);
    try {
      await relay.fetch(new Request('https://relay/internal/graph-jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-User-Id': userId },
        body: JSON.stringify(body),
      }));
      await relay.fetch(new Request(
        `https://relay/internal/graph-jobs/${fixture.jobId}/assets/${fixture.digest}`,
        { method: 'PUT', body: asset },
      ));
      const commit = await readJson<Record<string, unknown>>(await relay.fetch(new Request(
        `https://relay/internal/graph-jobs/${fixture.jobId}/commit`,
        { method: 'POST' },
      )));
      expect(commit).toMatchObject({
        state: 'queued',
        placement: {
          eligible_nodes: 0,
          nodes: [{
            blockers: [{
              code: 'graph_provider_mismatch',
              message: `Graph provider mere-dataset-tools does not match required version 0.2.0 and catalog ${requiredCatalog}`,
            }],
          }],
        },
      });
    } finally {
      closeWebSocket(ws);
    }
  });

  it('keeps event sequencing monotonic while bounding retained relay history', async () => {
    const userId = `graph-events-${crypto.randomUUID()}`;
    const { relay, ws } = await connectAgent(userId, graphCapabilities(['image-klein-9b']));
    const fixture = await graphFixture(new Uint8Array([1]));
    makeAssetless(fixture.body as unknown as SubmitGraphJobRequest);
    try {
      await relay.fetch(new Request('https://relay/internal/graph-jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-User-Id': userId },
        body: JSON.stringify(fixture.body),
      }));
      await relay.fetch(new Request(
        `https://relay/internal/graph-jobs/${fixture.jobId}/commit`,
        { method: 'POST' },
      ));
      await waitForWebSocketJson(ws);

      for (let sequence = 0; sequence <= 520; sequence++) {
        ws.send(JSON.stringify({
          type: 'graph_event',
          job_id: fixture.jobId,
          owner_user_id: userId,
          event: {
            sequence,
            created_at: '2026-07-15T12:01:00Z',
            type: sequence === 0 ? 'run_started' : 'node_metric',
            state: 'running',
            node_id: sequence === 0 ? undefined : 'generate',
          },
        }));
      }
      ws.send(JSON.stringify({
        type: 'graph_event',
        job_id: fixture.jobId,
        owner_user_id: userId,
        event: {
          sequence: 521,
          created_at: '2026-07-15T12:02:00Z',
          type: 'node_finished',
          state: 'running',
          node_id: 'generate',
        },
      }));

      await vi.waitFor(async () => {
        const response = await relay.fetch(new Request(
          `https://relay/internal/graph-jobs/${fixture.jobId}/events`,
        ));
        expect(response.headers.get('X-Graph-Event-Retained')).toBe('512');
        expect(response.headers.get('X-Graph-Event-Last-Sequence')).toBe('521');
        const eventText = new TextDecoder().decode(await response.arrayBuffer());
        const events = eventText.trim().split('\n').map((line): unknown => JSON.parse(line) as unknown);
        expect(events).toHaveLength(512);
        expect(events.at(-1)).toMatchObject({ sequence: 521, type: 'node_finished' });
      }, { timeout: 10_000 });
    } finally {
      closeWebSocket(ws);
    }
  });

  it('keeps cancellation terminal when a worker reports a late result', async () => {
    const userId = `graph-cancel-${crypto.randomUUID()}`;
    const { relay, ws } = await connectAgent(userId, graphCapabilities(['image-klein-9b']));
    const fixture = await graphFixture(new Uint8Array([1]));
    makeAssetless(fixture.body as unknown as SubmitGraphJobRequest);
    try {
      await relay.fetch(new Request('https://relay/internal/graph-jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-User-Id': userId },
        body: JSON.stringify(fixture.body),
      }));
      await relay.fetch(new Request(`https://relay/internal/graph-jobs/${fixture.jobId}/commit`, { method: 'POST' }));
      await waitForWebSocketJson(ws);

      const cancelled = await relay.fetch(new Request(`https://relay/internal/graph-jobs/${fixture.jobId}`, { method: 'DELETE' }));
      expect((await readJson<Record<string, unknown>>(cancelled)).state).toBe('cancelled');
      expect((await waitForWebSocketJson<{ type: string }>(ws)).type).toBe('graph_cancel');

      ws.send(JSON.stringify({
        type: 'graph_result',
        job_id: fixture.jobId,
        run_manifest: {
          contract_version: 'mere.run/graph-run.v1',
          job_id: fixture.jobId,
          graph_fingerprint: fixture.body.job.graph_fingerprint,
          state: 'finished',
        },
        artifacts: [],
      }));
      await vi.waitFor(async () => {
        const status = await relay.fetch(new Request(`https://relay/internal/graph-jobs/${fixture.jobId}`));
        expect((await readJson<Record<string, unknown>>(status)).state).toBe('cancelled');
      });
    } finally {
      closeWebSocket(ws);
    }
  });

  it('retries the same immutable bundle after cancellation settles', async () => {
    const userId = `graph-retry-${crypto.randomUUID()}`;
    const { relay, ws } = await connectAgent(userId, graphCapabilities(['image-klein-9b']));
    const fixture = await graphFixture(new Uint8Array([1]));
    makeAssetless(fixture.body as unknown as SubmitGraphJobRequest);
    try {
      await relay.fetch(new Request('https://relay/internal/graph-jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-User-Id': userId },
        body: JSON.stringify(fixture.body),
      }));
      await relay.fetch(new Request(`https://relay/internal/graph-jobs/${fixture.jobId}/commit`, { method: 'POST' }));
      const firstRequest = await waitForWebSocketJson<{
        type: string;
        bundle_files: Array<{ path: string; sha256: string }>;
        upload_url_base: string;
      }>(ws);
      expect(firstRequest.type).toBe('graph_request');
      const earlyImage = await publishEarlyImage(firstRequest.upload_url_base, fixture);
      const earlyUrl = `https://relay/internal/graph-jobs/${fixture.jobId}/artifacts/${earlyImage.name}`;
      expect(new Uint8Array(await (await relay.fetch(new Request(earlyUrl))).arrayBuffer())).toEqual(new Uint8Array([51, 52, 53]));

      const partialArtifact = new Uint8Array([11, 22, 33, 44]);
      const partialDigest = await sha256(partialArtifact);
      const firstPart = partialArtifact.slice(0, 2);
      const partialUpload = await SELF.fetch(`${firstRequest.upload_url_base}/artifacts/image`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'image/png',
          'X-Artifact-Size': String(partialArtifact.byteLength),
          'X-Artifact-Sha256': partialDigest,
          'X-Artifact-Path': 'outputs/image.png',
          'X-Artifact-Kind': 'graph.output',
          'X-Artifact-Part-Index': '0',
          'X-Artifact-Part-Count': '2',
          'X-Artifact-Part-Size': String(firstPart.byteLength),
          'X-Artifact-Part-Sha256': await sha256(firstPart),
        },
        body: firstPart,
      });
      expect(partialUpload.status).toBe(200);

      await relay.fetch(new Request(`https://relay/internal/graph-jobs/${fixture.jobId}`, { method: 'DELETE' }));
      expect((await waitForWebSocketJson<{ type: string }>(ws)).type).toBe('graph_cancel');
      const settling = await relay.fetch(new Request(
        `https://relay/internal/graph-jobs/${fixture.jobId}/retry`,
        { method: 'POST' }
      ));
      expect(settling.status).toBe(409);

      ws.send(JSON.stringify({
        type: 'graph_error',
        job_id: fixture.jobId,
        owner_user_id: userId,
        error: 'Cancellation acknowledged',
      }));
      await vi.waitFor(async () => {
        const status = await relay.fetch(new Request(`https://relay/internal/graph-jobs/${fixture.jobId}`));
        expect((await readJson<Record<string, unknown>>(status)).agent_id).toBeNull();
      });

      const retried = await relay.fetch(new Request(
        `https://relay/internal/graph-jobs/${fixture.jobId}/retry`,
        { method: 'POST' }
      ));
      expect(retried.status).toBe(200);
      const retriedStatus = await readJson<Record<string, unknown>>(retried);
      expect(retriedStatus.state).toBe('assigned');
      expect(retriedStatus.attempt).toBe(2);
      expect(retriedStatus.artifacts).toEqual([earlyImage]);
      expect(new Uint8Array(await (await relay.fetch(new Request(earlyUrl))).arrayBuffer())).toEqual(new Uint8Array([51, 52, 53]));
      const secondRequest = await waitForWebSocketJson<{
        type: string;
        bundle_files: Array<{ path: string; sha256: string }>;
        upload_url_base: string;
      }>(ws);
      expect(secondRequest.type).toBe('graph_request');
      expect((await SELF.fetch(`${firstRequest.upload_url_base}/publications`, { method: 'PUT', body: '{}' })).status).toBe(404);
      expect(secondRequest.bundle_files.map(({ path, sha256 }) => ({ path, sha256 })))
        .toEqual(firstRequest.bundle_files.map(({ path, sha256 }) => ({ path, sha256 })));
      const resumed = await SELF.fetch(
        `${secondRequest.upload_url_base}/artifact-uploads/${partialDigest}`,
      );
      expect(resumed.status).toBe(200);
      expect(await readJson(resumed)).toMatchObject({
        sha256: partialDigest,
        size_bytes: partialArtifact.byteLength,
        part_count: 2,
        complete: false,
        parts: [{ index: 0, size_bytes: firstPart.byteLength, sha256: await sha256(firstPart) }],
      });

      const secondPart = partialArtifact.slice(2);
      const completedUpload = await SELF.fetch(`${secondRequest.upload_url_base}/artifacts/image`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'image/png',
          'X-Artifact-Size': String(partialArtifact.byteLength),
          'X-Artifact-Sha256': partialDigest,
          'X-Artifact-Path': 'outputs/image.png',
          'X-Artifact-Kind': 'graph.output',
          'X-Artifact-Part-Index': '1',
          'X-Artifact-Part-Count': '2',
          'X-Artifact-Part-Size': String(secondPart.byteLength),
          'X-Artifact-Part-Sha256': await sha256(secondPart),
        },
        body: secondPart,
      });
      expect(completedUpload.status).toBe(200);
      expect(await readJson(completedUpload)).toMatchObject({ complete: true });

      const artifact: GraphRunArtifact = {
        name: 'image',
        kind: 'graph.output',
        path: 'outputs/image.png',
        content_type: 'image/png',
        size_bytes: partialArtifact.byteLength,
        sha256: partialDigest,
      };
      const runManifest = {
        contract_version: 'mere.run/graph-run.v1',
        job_id: fixture.jobId,
        graph_fingerprint: fixture.body.job.graph_fingerprint,
        state: 'finished',
        attempt: 1,
        outputs: [artifact],
      };
      const manifestUpload = await SELF.fetch(`${secondRequest.upload_url_base}/run-manifest`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(runManifest),
      });
      expect(manifestUpload.status).toBe(200);

      ws.send(JSON.stringify({
        type: 'graph_result',
        job_id: fixture.jobId,
        owner_user_id: userId,
        run_manifest: runManifest,
        artifacts: [artifact],
      }));
      await vi.waitFor(async () => {
        const response = await relay.fetch(new Request(`https://relay/internal/graph-jobs/${fixture.jobId}`));
        expect((await readJson<Record<string, unknown>>(response)).state).toBe('finished');
      });

      const fetchedManifest = await relay.fetch(new Request(
        `https://relay/internal/graph-jobs/${fixture.jobId}/run-manifest`,
      ));
      expect(fetchedManifest.status).toBe(200);
      expect(await readJson(fetchedManifest)).toMatchObject({ attempt: 2 });
    } finally {
      closeWebSocket(ws);
    }
  });

  it('enforces active-job, input, account, and output storage quotas', async () => {
    const activeUserId = `graph-active-quota-${crypto.randomUUID()}`;
    const activeRelay = testEnv.MERE_RUN_RELAY.get(testEnv.MERE_RUN_RELAY.idFromName(activeUserId));
    for (let index = 0; index < 20; index += 1) {
      const fixture = await graphFixture(new Uint8Array([index]));
      makeAssetless(fixture.body as unknown as SubmitGraphJobRequest);
      const response = await activeRelay.fetch(new Request('https://relay/internal/graph-jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-User-Id': activeUserId },
        body: JSON.stringify(fixture.body),
      }));
      expect(response.status).toBe(201);
    }
    const activeOverflow = await graphFixture(new Uint8Array([99]));
    makeAssetless(activeOverflow.body as unknown as SubmitGraphJobRequest);
    const activeRejected = await activeRelay.fetch(new Request('https://relay/internal/graph-jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-User-Id': activeUserId },
      body: JSON.stringify(activeOverflow.body),
    }));
    expect(activeRejected.status).toBe(429);
    expect(await readJson(activeRejected)).toMatchObject({ code: 'graph_active_job_quota', limit: 20 });

    const inputUserId = `graph-input-quota-${crypto.randomUUID()}`;
    const inputRelay = testEnv.MERE_RUN_RELAY.get(testEnv.MERE_RUN_RELAY.idFromName(inputUserId));
    const inputFixture = await graphFixture(new Uint8Array([1]));
    inputFixture.body.assets.groups[0].entries[0].size_bytes = 50 * 1024 ** 3 + 1;
    const inputRejected = await inputRelay.fetch(new Request('https://relay/internal/graph-jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-User-Id': inputUserId },
      body: JSON.stringify(inputFixture.body),
    }));
    expect(inputRejected.status).toBe(413);
    expect(await readJson(inputRejected)).toMatchObject({ code: 'graph_job_input_quota' });

    const accountUserId = `graph-account-quota-${crypto.randomUUID()}`;
    const accountRelay = testEnv.MERE_RUN_RELAY.get(testEnv.MERE_RUN_RELAY.idFromName(accountUserId));
    for (const [index, digestCharacter] of ['a', 'b', 'c'].entries()) {
      const fixture = await graphFixture(new Uint8Array([index]));
      fixture.body.assets.groups[0].entries[0].digest = digestCharacter.repeat(64);
      fixture.body.assets.groups[0].entries[0].size_bytes = 40 * 1024 ** 3;
      const response = await accountRelay.fetch(new Request('https://relay/internal/graph-jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-User-Id': accountUserId },
        body: JSON.stringify(fixture.body),
      }));
      expect(response.status).toBe(index < 2 ? 201 : 507);
      if (index === 2) expect(await readJson(response)).toMatchObject({ code: 'graph_account_storage_quota' });
    }

    const outputUserId = `graph-output-quota-${crypto.randomUUID()}`;
    const { relay: outputRelay, ws } = await connectAgent(outputUserId, graphCapabilities(['image-klein-9b']));
    const outputFixture = await graphFixture(new Uint8Array([1]));
    makeAssetless(outputFixture.body as unknown as SubmitGraphJobRequest);
    try {
      await outputRelay.fetch(new Request('https://relay/internal/graph-jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-User-Id': outputUserId },
        body: JSON.stringify(outputFixture.body),
      }));
      await outputRelay.fetch(new Request(
        `https://relay/internal/graph-jobs/${outputFixture.jobId}/commit`,
        { method: 'POST' },
      ));
      const request = await waitForWebSocketJson<{ upload_url_base: string }>(ws);
      const rejected = await SELF.fetch(`${request.upload_url_base}/artifacts/oversized`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Artifact-Size': String(50 * 1024 ** 3 + 1),
          'X-Artifact-Sha256': 'd'.repeat(64),
          'X-Artifact-Path': 'outputs/oversized.bin',
          'X-Artifact-Kind': 'graph.output',
        },
        body: new Uint8Array(),
      });
      expect(rejected.status).toBe(413);
      expect(await readJson(rejected)).toMatchObject({ code: 'graph_job_output_quota' });
    } finally {
      closeWebSocket(ws);
    }
  });

  it('reconciles stale work and removes expired graph jobs plus R2 objects', async () => {
    const userId = `graph-maintenance-${crypto.randomUUID()}`;
    const relay = testEnv.MERE_RUN_RELAY.get(testEnv.MERE_RUN_RELAY.idFromName(userId));
    const staleFixture = await graphFixture(new Uint8Array([1]));
    makeAssetless(staleFixture.body as unknown as SubmitGraphJobRequest);
    const expiredFixture = await graphFixture(new Uint8Array([2]));
    makeAssetless(expiredFixture.body as unknown as SubmitGraphJobRequest);
    for (const fixture of [staleFixture, expiredFixture]) {
      const created = await relay.fetch(new Request('https://relay/internal/graph-jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-User-Id': userId },
        body: JSON.stringify(fixture.body),
      }));
      expect(created.status).toBe(201);
    }
    const r2Key = `graph-jobs/${encodeURIComponent(userId)}/${expiredFixture.jobId}/run.json`;
    await testEnv.IMAGES.put(r2Key, new Uint8Array([1, 2, 3]));
    await runInDurableObject(relay, async (_instance, state) => {
      const stale = await state.storage.get<GraphJob>(`graph:${staleFixture.jobId}`);
      const expired = await state.storage.get<GraphJob>(`graph:${expiredFixture.jobId}`);
      expect(stale).toBeDefined();
      expect(expired).toBeDefined();
      await state.storage.put(`graph:${staleFixture.jobId}`, {
        ...stale!,
        state: 'running',
        attempt: 1,
        max_attempts: 1,
        updated_at: '2020-01-01T00:00:00Z',
      });
      await state.storage.put(`graph:${expiredFixture.jobId}`, {
        ...expired!,
        state: 'finished',
        completed_at: '2020-01-01T00:00:00Z',
        updated_at: '2020-01-01T00:00:00Z',
      });
      await state.storage.put('graph-maintenance:next', Date.now() - 1);
    });

    await runDurableObjectAlarm(relay);

    const staleStatus = await relay.fetch(new Request(
      `https://relay/internal/graph-jobs/${staleFixture.jobId}`,
    ));
    expect(await readJson(staleStatus)).toMatchObject({
      state: 'failed',
      error: 'Graph job became stale while assigned to a worker',
      execution_receipt: {
        schema: 'relay.execution-receipt.v1',
        execution_id: staleFixture.jobId,
        state: 'failed',
        error_code: 'EXECUTION_FAILED',
      },
    });
    const expiredStatus = await relay.fetch(new Request(
      `https://relay/internal/graph-jobs/${expiredFixture.jobId}`,
    ));
    expect(expiredStatus.status).toBe(404);
    expect(await testEnv.IMAGES.head(r2Key)).toBeNull();
    const telemetry = await relay.fetch(new Request('https://relay/internal/graph-jobs/telemetry'));
    expect(await readJson(telemetry)).toMatchObject({
      submissions: 2,
      stale_jobs_failed: 1,
      retained_jobs_deleted: 1,
      r2_objects_deleted: 1,
      r2_bytes_deleted: 3,
    });
  });
});
