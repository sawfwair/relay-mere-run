import { env as testEnv, runDurableObjectAlarm, runInDurableObject, SELF } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleClientApi } from '../src/client-api';
import type { Env, JobStatusResponse, ToolStatusResponse } from '../src/types';
import {
  capabilitiesWithPlugin,
  capabilitiesWithModels,
  closeWebSocket,
  connectAgent,
  readJson,
  submitAsr,
  submitChat,
  submitEmbed,
  submitJob,
  submitOcr,
  submitTalk,
  submitTool,
  waitForWebSocketJson,
} from './helpers';

type JsonRecord = Record<string, unknown>;

async function signWebhook(secret: string, timestamp: string, rawBody: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signatureBuffer = await crypto.subtle.sign('HMAC', key, encoder.encode(`${timestamp}.${rawBody}`));
  const hex = Array.from(new Uint8Array(signatureBuffer), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `v1=${hex}`;
}

function testWebhookSigningSecret(): string {
  const secret = testEnv.WEBHOOK_SIGNING_SECRET;
  if (typeof secret !== 'string') {
    throw new TypeError('wrangler.test.toml must bind WEBHOOK_SIGNING_SECRET as a string');
  }
  return secret;
}

function newUserId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('relay regressions', () => {
  it('accepts oversized inventory updates without losing tool placement or the durable graph catalog', async () => {
    const userId = newUserId('inventory-attachment');
    const { relay, ws } = await connectAgent(userId, capabilitiesWithModels([]));
    const graphCatalog = {
      nodes: Array.from({ length: 300 }, (_, index) => ({
        kind: `test.node.${index}`,
        provider: { id: 'mere-test' },
      })),
    };
    const capabilities = {
      ...capabilitiesWithPlugin({
        name: 'mere-animatic-tools',
        commands: ['build-set-proxy', 'solve-set-lighting', 'render-set-plate'],
        capabilities: Array.from({ length: 300 }, (_, index) => `capability-${index}`),
      }),
      graph_worker: {
        schema_version: 1,
        worker_version: '0.2.9',
        contract_versions: ['mere.run/job-bundle.v1'],
        platform: 'darwin',
        architecture: 'arm64',
        accelerator_backend: 'metal',
        memory_bytes: 128 * 1024 ** 3,
        node_kinds: ['image.generate'],
        installed_model_ids: [],
        cached_asset_digests: Array.from({ length: 500 }, (_, index) =>
          index.toString(16).padStart(64, '0')
        ),
        providers: [{
          id: 'mere-test',
          version: '1.0.0',
          catalog_sha256: 'a'.repeat(64),
          node_kinds: ['test.node.0'],
        }],
        catalog: graphCatalog,
      },
    };
    ws.send(JSON.stringify({
      type: 'inventory_update',
      capabilities,
      system: { platform: 'darwin', architecture: 'arm64', accelerators: [] },
      runtime: { installed_models: [], inventory_status: 'empty' },
      capacity: { max_concurrent_jobs: 1, lease_protocol: true },
    }));

    let fleet: { nodes: Array<{ capabilities: typeof capabilities }> } | null = null;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const response = await relay.fetch(new Request('https://relay/internal/fleet'));
      const current = await readJson<{ nodes: Array<{ capabilities: typeof capabilities }> }>(response);
      if (current.nodes[0]?.capabilities.plugins?.[0]?.commands.includes('build-set-proxy')) {
        fleet = current;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(fleet?.nodes[0].capabilities.plugins?.[0].capabilities).toHaveLength(300);
    const graphResponse = await relay.fetch(
      new Request('https://relay/internal/graph-jobs/capabilities')
    );
    const graph = await readJson<{ catalog?: { nodes?: unknown[] } }>(graphResponse);
    expect(graph.catalog?.nodes).toHaveLength(300);

    const toolResponse = await submitTool(relay, userId, {
      plugin: 'mere-animatic-tools',
      command: 'build-set-proxy',
      inputs: {},
      options: {},
    });
    expect(toolResponse.status).toBe(200);
    expect((await readJson<{ status: string }>(toolResponse)).status).toBe('assigned');
    closeWebSocket(ws);
  });

  it('serves immutable relay and client input media from the bound R2 bucket', async () => {
    const key = 'relay/test-user/tool_test/report.json';
    const bytes = new TextEncoder().encode('{"ok":true}');
    await testEnv.IMAGES.put(key, bytes, {
      httpMetadata: { contentType: 'application/json' },
    });

    const head = await SELF.fetch(new Request(`https://relay/media/${key}`, { method: 'HEAD' }));
    expect(head.status).toBe(200);
    expect(head.headers.get('Content-Type')).toBe('application/json');
    expect(head.headers.get('Content-Length')).toBe(String(bytes.byteLength));
    expect(head.headers.get('Cache-Control')).toContain('immutable');

    const get = await SELF.fetch(`https://relay/media/${key}`);
    expect(get.status).toBe(200);
    expect(new Uint8Array(await get.arrayBuffer())).toEqual(bytes);

    const range = await SELF.fetch(
      new Request(`https://relay/media/${key}`, { headers: { Range: 'bytes=2-5' } })
    );
    expect(range.status).toBe(206);
    expect(range.headers.get('Content-Range')).toBe(`bytes 2-5/${bytes.byteLength}`);
    expect(new TextDecoder().decode(await range.arrayBuffer())).toBe('ok":');

    const missing = await SELF.fetch('https://relay/media/relay/test-user/missing.png');
    expect(missing.status).toBe(404);

    const inputMedia = [
      { key: 'inputs/test-user/capture.wav', contentType: 'audio/wav', bytes: new Uint8Array([82, 73, 70, 70]) },
      { key: 'inputs-inline/test-user/source.jpg', contentType: 'image/jpeg', bytes: new Uint8Array([255, 216, 255]) },
    ];
    for (const input of inputMedia) {
      await testEnv.IMAGES.put(input.key, input.bytes, {
        httpMetadata: { contentType: input.contentType },
      });
      const response = await SELF.fetch(`https://relay/media/${input.key}`);
      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toBe(input.contentType);
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(input.bytes);
    }

    const invalid = await SELF.fetch('https://relay/media/releases/private.dmg');
    expect(invalid.status).toBe(404);
  });

  it('serves node downloads as platform and architecture specific artifacts', async () => {
    const version = '0.9.0';
    const arm64Key = `releases/mere-run-node/linux/arm64/mere.run-node-${version}-arm64.AppImage`;
    const x86Key = `releases/mere-run-node/linux/x86_64/mere.run-node-${version}-x86_64.AppImage`;
    const arm64DebKey = `releases/mere-run-node/linux/arm64/deb/mere.run-node-${version}-arm64.deb`;
    const x86DebKey = `releases/mere-run-node/linux/x86_64/deb/mere.run-node-${version}-amd64.deb`;
    const arm64Bytes = new Uint8Array([1, 2, 3, 4]);
    const x86Bytes = new Uint8Array([5, 6, 7]);
    const arm64DebBytes = new Uint8Array([8, 9]);
    const x86DebBytes = new Uint8Array([10, 11, 12]);

    const unpublishedDeb = await SELF.fetch(
      new Request('https://relay/downloads/mere-run-node/linux/arm64/deb/latest', { method: 'HEAD' })
    );
    expect(unpublishedDeb.status).toBe(404);

    await testEnv.IMAGES.put(arm64Key, arm64Bytes, {
      httpMetadata: { contentType: 'application/octet-stream' },
    });
    await testEnv.IMAGES.put(x86Key, x86Bytes, {
      httpMetadata: { contentType: 'application/octet-stream' },
    });
    await testEnv.IMAGES.put(arm64DebKey, arm64DebBytes, {
      httpMetadata: { contentType: 'application/vnd.debian.binary-package' },
    });
    await testEnv.IMAGES.put(x86DebKey, x86DebBytes, {
      httpMetadata: { contentType: 'application/vnd.debian.binary-package' },
    });
    const manifest = (arch: 'arm64' | 'x86_64', key: string) =>
      JSON.stringify({
        schema_version: 1,
        product: 'mere-run-node',
        version,
        platform: 'linux',
        arch,
        key,
        filename: `mere.run-node-${version}-${arch}.AppImage`,
        content_type: 'application/octet-stream',
        size: arch === 'arm64' ? arm64Bytes.byteLength : x86Bytes.byteLength,
        sha256: 'a'.repeat(64),
        published_at: '2026-07-14T12:00:00Z',
      });
    await testEnv.IMAGES.put(
      'releases/mere-run-node/linux/arm64/latest.json',
      manifest('arm64', arm64Key)
    );
    await testEnv.IMAGES.put(
      'releases/mere-run-node/linux/x86_64/latest.json',
      manifest('x86_64', x86Key)
    );
    const debManifest = (arch: 'arm64' | 'x86_64', key: string, filenameArch: 'arm64' | 'amd64', size: number) =>
      JSON.stringify({
        schema_version: 1,
        product: 'mere-run-node',
        version,
        platform: 'linux',
        arch,
        format: 'deb',
        key,
        filename: `mere.run-node-${version}-${filenameArch}.deb`,
        content_type: 'application/vnd.debian.binary-package',
        size,
        sha256: 'b'.repeat(64),
        published_at: '2026-07-14T12:00:00Z',
      });
    await testEnv.IMAGES.put(
      'releases/mere-run-node/linux/arm64/deb/latest.json',
      debManifest('arm64', arm64DebKey, 'arm64', arm64DebBytes.byteLength)
    );
    await testEnv.IMAGES.put(
      'releases/mere-run-node/linux/x86_64/deb/latest.json',
      debManifest('x86_64', x86DebKey, 'amd64', x86DebBytes.byteLength)
    );

    const arm64Head = await SELF.fetch(
      new Request('https://relay/downloads/mere-run-node/linux/arm64/latest', { method: 'HEAD' })
    );
    expect(arm64Head.status).toBe(200);
    expect(arm64Head.headers.get('Content-Type')).toBe('application/octet-stream');
    expect(arm64Head.headers.get('Content-Length')).toBe(String(arm64Bytes.byteLength));
    expect(arm64Head.headers.get('Content-Disposition')).toBe(
      `attachment; filename="mere.run-node-${version}-arm64.AppImage"`
    );
    expect(arm64Head.headers.get('X-Release-Key')).toBe(arm64Key);
    expect(arm64Head.headers.get('X-Release-Platform')).toBe('linux');
    expect(arm64Head.headers.get('X-Release-Arch')).toBe('arm64');
    expect(arm64Head.headers.get('X-Release-Format')).toBe('appimage');
    expect(arm64Head.headers.get('X-Release-Version')).toBe(version);
    expect(arm64Head.headers.get('X-Release-Sha256')).toBe('a'.repeat(64));
    expect(arm64Head.headers.get('Cache-Control')).toBe('no-store');

    const arm64AliasHead = await SELF.fetch(
      new Request('https://relay/downloads/mere-run-node/linux/aarch64/latest', { method: 'HEAD' })
    );
    expect(arm64AliasHead.status).toBe(200);
    expect(arm64AliasHead.headers.get('X-Release-Key')).toBe(arm64Key);
    expect(arm64AliasHead.headers.get('X-Release-Arch')).toBe('arm64');

    const x86Head = await SELF.fetch(
      new Request('https://relay/downloads/mere-run-node/linux/x86_64/latest', { method: 'HEAD' })
    );
    expect(x86Head.status).toBe(200);
    expect(x86Head.headers.get('Content-Length')).toBe(String(x86Bytes.byteLength));
    expect(x86Head.headers.get('X-Release-Key')).toBe(x86Key);
    expect(x86Head.headers.get('X-Release-Arch')).toBe('x86_64');

    const arm64DebHead = await SELF.fetch(
      new Request('https://relay/downloads/mere-run-node/linux/arm64/deb/latest', { method: 'HEAD' })
    );
    expect(arm64DebHead.status).toBe(200);
    expect(arm64DebHead.headers.get('Content-Type')).toBe('application/vnd.debian.binary-package');
    expect(arm64DebHead.headers.get('Content-Length')).toBe(String(arm64DebBytes.byteLength));
    expect(arm64DebHead.headers.get('Content-Disposition')).toBe(
      `attachment; filename="mere.run-node-${version}-arm64.deb"`
    );
    expect(arm64DebHead.headers.get('X-Release-Key')).toBe(arm64DebKey);
    expect(arm64DebHead.headers.get('X-Release-Format')).toBe('deb');
    expect(arm64DebHead.headers.get('X-Release-Sha256')).toBe('b'.repeat(64));

    const x86DebAliasHead = await SELF.fetch(
      new Request('https://relay/downloads/mere-run-node/linux/amd64/deb/latest', { method: 'HEAD' })
    );
    expect(x86DebAliasHead.status).toBe(200);
    expect(x86DebAliasHead.headers.get('X-Release-Key')).toBe(x86DebKey);
    expect(x86DebAliasHead.headers.get('X-Release-Arch')).toBe('x86_64');

    const arm64Get = await SELF.fetch('https://relay/downloads/mere-run-node/linux/arm64/latest');
    expect(arm64Get.status).toBe(200);
    expect(new Uint8Array(await arm64Get.arrayBuffer())).toEqual(arm64Bytes);

    const catalogResponse = await SELF.fetch('https://relay/.well-known/mere-run-node/releases.json');
    expect(catalogResponse.status).toBe(200);
    const catalog = await readJson<{ product: string; releases: Array<Record<string, unknown>> }>(catalogResponse);
    expect(catalog.product).toBe('mere-run-node');
    expect(catalog.releases).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          version,
          arch: 'arm64',
          format: 'appimage',
          recommended: false,
          download_url: 'https://relay.mere.run/downloads/mere-run-node/linux/arm64/latest',
          source: 'r2-release-manifest',
        }),
        expect.objectContaining({
          version,
          arch: 'x86_64',
          format: 'appimage',
          recommended: false,
          download_url: 'https://relay.mere.run/downloads/mere-run-node/linux/x86_64/latest',
          source: 'r2-release-manifest',
        }),
        expect.objectContaining({
          version,
          arch: 'arm64',
          format: 'deb',
          recommended: true,
          download_url: 'https://relay.mere.run/downloads/mere-run-node/linux/arm64/deb/latest',
          source: 'r2-release-manifest',
        }),
        expect.objectContaining({
          version,
          arch: 'x86_64',
          format: 'deb',
          recommended: true,
          download_url: 'https://relay.mere.run/downloads/mere-run-node/linux/x86_64/deb/latest',
          source: 'r2-release-manifest',
        }),
      ])
    );

    const genericLinux = await SELF.fetch('https://relay/downloads/mere-run-node/linux/latest');
    expect(genericLinux.status).toBe(404);
  });

  it('routes DELETE /internal/job/:id/image before cancel handler', async () => {
    const userId = newUserId('route-precedence');
    const { relay, ws } = await connectAgent(userId, capabilitiesWithModels(['image-klein-9b']));
    try {
      const submitResponse = await submitJob(relay, userId, {
        prompt: 'route precedence test',
        width: 1024,
        height: 1024,
      });
      expect(submitResponse.status).toBe(200);
      const submitJson = await readJson<JsonRecord>(submitResponse);
      const jobId = String(submitJson.job_id);
      expect(jobId.startsWith('job_')).toBe(true);
      expect(submitJson.status).toBe('assigned');

      const assignedMessage = await waitForWebSocketJson<JsonRecord>(ws);
      expect(assignedMessage.type).toBe('job');
      expect(assignedMessage.job_id).toBe(jobId);

      const deleteImageResponse = await relay.fetch(
        new Request(`https://relay/internal/job/${jobId}/image`, { method: 'DELETE' })
      );
      expect(deleteImageResponse.status).toBe(200);
      expect(await readJson<JsonRecord>(deleteImageResponse)).toEqual({ deleted: true });

      const statusResponse = await relay.fetch(new Request(`https://relay/internal/job/${jobId}`));
      expect(statusResponse.status).toBe(200);
      const statusJson = await readJson<JobStatusResponse>(statusResponse);
      expect(statusJson.status).toBe('assigned');
    } finally {
      closeWebSocket(ws);
    }
  });

  it('persists advancing per-step progress for polling clients', async () => {
    const userId = newUserId('progress-steps');
    const { relay, ws } = await connectAgent(userId, capabilitiesWithModels(['image-klein-9b']));
    try {
      const submitResponse = await submitJob(relay, userId, {
        prompt: 'stepwise progress',
        steps: 4,
      });
      expect(submitResponse.status).toBe(200);
      const submitJson = await readJson<JsonRecord>(submitResponse);
      const jobId = String(submitJson.job_id);

      const assigned = await waitForWebSocketJson<JsonRecord>(ws);
      expect(assigned.type).toBe('job');
      const leaseId = assigned.lease_id as string;

      for (let step = 1; step <= 4; step++) {
        ws.send(
          JSON.stringify({
            type: 'progress',
            job_id: jobId,
            lease_id: leaseId,
            step,
            total_steps: 4,
          })
        );

        await vi.waitFor(async () => {
          const statusResponse = await relay.fetch(new Request(`https://relay/internal/job/${jobId}`));
          expect(statusResponse.status).toBe(200);
          const statusJson = await readJson<JobStatusResponse>(statusResponse);
          expect(statusJson.status).toBe('generating');
          expect(statusJson.progress).toEqual({ step, total_steps: 4 });
        });
      }
    } finally {
      closeWebSocket(ws);
    }
  });

  it('enforces capability-aware scheduling', async () => {
    const incompatibleUserId = newUserId('capability-incompatible');
    const { relay: incompatibleRelay, ws: incompatibleWs } = await connectAgent(
      incompatibleUserId,
      capabilitiesWithModels(['asr'])
    );
    try {
      const incompatibleSubmit = await submitTalk(incompatibleRelay, incompatibleUserId, {
        text: 'Should be rejected for talk',
      });
      expect(incompatibleSubmit.status).toBe(503);
      const incompatibleJson = await readJson<JsonRecord>(incompatibleSubmit);
      expect(incompatibleJson.code).toBe('NO_COMPATIBLE_AGENTS');
    } finally {
      closeWebSocket(incompatibleWs);
    }

    const compatibleUserId = newUserId('capability-compatible');
    const { relay: compatibleRelay, ws: compatibleWs } = await connectAgent(
      compatibleUserId,
      capabilitiesWithModels(['talk-nano'])
    );
    try {
      const compatibleSubmit = await submitTalk(compatibleRelay, compatibleUserId, {
        text: 'Should assign for talk',
      });
      expect(compatibleSubmit.status).toBe(200);
      const compatibleJson = await readJson<JsonRecord>(compatibleSubmit);
      expect(compatibleJson.status).toBe('assigned');
      expect(String(compatibleJson.agent_id).startsWith('agent_')).toBe(true);
    } finally {
      closeWebSocket(compatibleWs);
    }
  });

  it('routes music and video jobs to matching media capabilities', async () => {
    const targets = [
      {
        label: 'music',
        path: '/api/music',
        capability: 'music',
        contentType: 'audio/wav',
        mediaUrl: 'https://assets.example/song.wav',
      },
      {
        label: 'video',
        path: '/api/video',
        capability: 'video',
        contentType: 'video/mp4',
        mediaUrl: 'https://assets.example/clip.mp4',
      },
    ] as const;

    for (const target of targets) {
      const userId = newUserId(`media-${target.label}`);
      const { ws } = await connectAgent(userId, capabilitiesWithModels([target.capability]));
      try {
        const submitResponse = await handleClientApi(
          new Request(`https://relay${target.path}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: `${target.label} capability test` }),
          }),
          testEnv as unknown as Env,
          userId
        );
        expect(submitResponse.status).toBe(200);
        const submitJson = await readJson<JsonRecord>(submitResponse);
        const jobId = String(submitJson.job_id);

        const assignment = await waitForWebSocketJson<JsonRecord>(ws);
        expect(assignment.type).toBe('job');
        expect(assignment.job_id).toBe(jobId);
        expect((assignment.request as JsonRecord).kind).toBe(target.label);

        ws.send(
          JSON.stringify({
            type: 'result',
            job_id: jobId,
            success: true,
            media_url: target.mediaUrl,
            content_type: target.contentType,
            output_kind: target.label,
            generation_time_ms: 25,
          })
        );

        await vi.waitFor(async () => {
          const statusResponse = await handleClientApi(
            new Request(`https://relay/api/job/${jobId}`),
            testEnv as unknown as Env,
            userId
          );
          const statusJson = await readJson<JobStatusResponse>(statusResponse);
          expect(statusJson.status).toBe('complete');
          expect(statusJson.result?.media_url).toBe(target.mediaUrl);
          expect(statusJson.result?.content_type).toBe(target.contentType);
          expect(statusJson.result?.output_kind).toBe(target.label);
        });
      } finally {
        closeWebSocket(ws);
      }
    }
  });

  it('persists chat state on submit and assignment', async () => {
    const userId = newUserId('chat-persist');
    const { relay, ws } = await connectAgent(userId, capabilitiesWithModels(['text-chat-gemma4-turbo']));
    try {
      const firstSubmit = await submitChat(relay, userId, {
        messages: [{ role: 'user', content: 'first chat' }],
      });
      expect(firstSubmit.status).toBe(200);
      const firstJson = await readJson<JsonRecord>(firstSubmit);
      const firstChatId = String(firstJson.chat_id);
      expect(firstJson.status).toBe('assigned');

      const firstAssignedMessage = await waitForWebSocketJson<JsonRecord>(ws);
      expect(firstAssignedMessage.type).toBe('chat_request');
      expect(firstAssignedMessage.chat_id).toBe(firstChatId);

      const secondSubmit = await submitChat(relay, userId, {
        messages: [{ role: 'user', content: 'second chat' }],
      });
      expect(secondSubmit.status).toBe(200);
      const secondJson = await readJson<JsonRecord>(secondSubmit);
      const secondChatId = String(secondJson.chat_id);
      expect(secondJson.status).toBe('queued');

      const stored = await runInDurableObject(relay, async (_instance, state) => {
        const first = await state.storage.get<JsonRecord>(`chat:${firstChatId}`);
        const second = await state.storage.get<JsonRecord>(`chat:${secondChatId}`);
        return { first, second };
      });

      expect(stored.first?.status).toBe('processing');
      expect(stored.second?.status).toBe('queued');
    } finally {
      closeWebSocket(ws);
    }
  });

  it('persists successful and failed chat completions from agent messages', async () => {
    const userId = newUserId('chat-terminal');
    const { relay, ws } = await connectAgent(userId, capabilitiesWithModels(['text']));
    try {
      const completedSubmit = await readJson<JsonRecord>(await submitChat(relay, userId, {
        messages: [{ role: 'user', content: 'complete this chat' }],
        model: 'text',
      }));
      const completedId = String(completedSubmit.chat_id);
      await waitForWebSocketJson<JsonRecord>(ws);
      ws.send(JSON.stringify({
        type: 'chat_response',
        chat_id: completedId,
        response: 'done',
        tokens_generated: 3,
      }));
      await vi.waitFor(async () => {
        const status = await readJson<JsonRecord>(await relay.fetch(new Request(
          `https://relay/internal/chat/${completedId}`
        )));
        expect(status).toMatchObject({ status: 'complete', response: 'done', tokens_generated: 3 });
      });

      const failedSubmit = await readJson<JsonRecord>(await submitChat(relay, userId, {
        messages: [{ role: 'user', content: 'fail this chat' }],
        model: 'text',
      }));
      const failedId = String(failedSubmit.chat_id);
      await waitForWebSocketJson<JsonRecord>(ws);
      ws.send(JSON.stringify({ type: 'chat_error', chat_id: failedId, error: 'synthetic failure' }));
      await vi.waitFor(async () => {
        const status = await readJson<JsonRecord>(await relay.fetch(new Request(
          `https://relay/internal/chat/${failedId}`
        )));
        expect(status).toMatchObject({ status: 'failed', error: 'synthetic failure' });
      });
    } finally {
      closeWebSocket(ws);
    }
  });

  it('persists tool progress and terminal errors from agent messages', async () => {
    const userId = newUserId('tool-error');
    const { relay, ws } = await connectAgent(userId, capabilitiesWithPlugin({
      name: 'mere-animatic-tools',
      commands: ['delivery-prep'],
    }));
    try {
      const submitted = await readJson<JsonRecord>(await submitTool(relay, userId, {
        plugin: 'mere-animatic-tools',
        command: 'delivery-prep',
      }));
      const toolId = String(submitted.tool_id);
      await waitForWebSocketJson<JsonRecord>(ws);

      ws.send(JSON.stringify({
        type: 'tool_progress',
        tool_id: toolId,
        step: 2,
        total_steps: 4,
        message: 'halfway',
      }));
      await vi.waitFor(async () => {
        const status = await readJson<JsonRecord>(await relay.fetch(new Request(
          `https://relay/internal/tool/${toolId}`
        )));
        expect(status.progress).toMatchObject({ step: 2, total_steps: 4, message: 'halfway' });
      });

      ws.send(JSON.stringify({ type: 'tool_error', tool_id: toolId, error: 'synthetic failure' }));
      await vi.waitFor(async () => {
        const status = await readJson<JsonRecord>(await relay.fetch(new Request(
          `https://relay/internal/tool/${toolId}`
        )));
        expect(status).toMatchObject({ status: 'failed', error: 'synthetic failure' });
      });
    } finally {
      closeWebSocket(ws);
    }
  });

  it('assigns plugin tool jobs and stores uploaded artifacts', async () => {
    const userId = newUserId('tool-lane');
    const { relay, ws } = await connectAgent(
      userId,
      capabilitiesWithPlugin({
        name: 'mere-animatic-tools',
        commands: ['character-knockout', 'delivery-prep'],
      })
    );
    try {
      const submitResponse = await submitTool(relay, userId, {
        plugin: 'mere-animatic-tools',
        command: 'character-knockout',
        inputs: { prompt: 'knock out a lead character' },
      });
      expect(submitResponse.status).toBe(200);
      const submitJson = await readJson<JsonRecord>(submitResponse);
      const toolId = String(submitJson.tool_id);
      expect(toolId.startsWith('tool_')).toBe(true);
      expect(submitJson.status).toBe('assigned');

      const assignedMessage = await waitForWebSocketJson<JsonRecord>(ws);
      expect(assignedMessage.type).toBe('tool_request');
      expect(assignedMessage.tool_id).toBe(toolId);
      expect(assignedMessage.upload_url_base).toContain(`/api/tool-upload/${encodeURIComponent(userId)}/${toolId}`);
      expect((assignedMessage.request as JsonRecord).command).toBe('character-knockout');

      const uploadResponse = await SELF.fetch(
        new Request(`https://relay/api/tool-upload/${encodeURIComponent(userId)}/${toolId}/report.json`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ok: true }),
        })
      );
      expect(uploadResponse.status).toBe(200);
      const uploadJson = await readJson<JsonRecord>(uploadResponse);
      expect(String(uploadJson.url)).toContain(`/media/relay/${userId}/${toolId}/report.json`);

      ws.send(
        JSON.stringify({
          type: 'tool_result',
          tool_id: toolId,
          artifacts: [
            {
              name: 'report.json',
              kind: 'json',
              label: 'tool-result',
              content_type: 'application/json',
              url: uploadJson.url,
            },
          ],
          run_manifest: { runId: toolId, status: 'succeeded' },
        })
      );

      await vi.waitFor(async () => {
        const statusResponse = await handleClientApi(
          new Request(`https://relay/api/tools/jobs/${toolId}`),
          testEnv as unknown as Env,
          userId
        );
        const statusJson = await readJson<ToolStatusResponse>(statusResponse);
        expect(statusJson.status).toBe('complete');
        expect(statusJson.result?.artifacts[0]?.url).toBe(uploadJson.url);
      });
    } finally {
      closeWebSocket(ws);
    }
  });

  it('streams SSE job events with connected/job/done semantics', async () => {
    const userId = newUserId('sse');
    const { relay, ws } = await connectAgent(userId, capabilitiesWithModels(['image-klein-9b']));
    try {
      const submitResponse = await submitJob(relay, userId, {
        prompt: 'sse stream regression',
      });
      expect(submitResponse.status).toBe(200);
      const submitJson = await readJson<JsonRecord>(submitResponse);
      const jobId = String(submitJson.job_id);

      const jobMessage = await waitForWebSocketJson<JsonRecord>(ws);
      expect(jobMessage.type).toBe('job');
      expect(jobMessage.job_id).toBe(jobId);

      ws.send(
        JSON.stringify({
          type: 'result',
          job_id: jobId,
          success: true,
          image_url: 'https://example.com/image.png',
          seed: 1337,
          generation_time_ms: 42,
        })
      );

      const sseResponse = await handleClientApi(
        new Request(`https://relay/api/job/${jobId}/stream`, { method: 'GET' }),
        testEnv as unknown as Env,
        userId
      );
      expect(sseResponse.status).toBe(200);
      expect(sseResponse.headers.get('Content-Type')).toContain('text/event-stream');

      const sseText = await new Response(sseResponse.body).text();
      const connectedIndex = sseText.indexOf('event: connected');
      const jobIndex = sseText.indexOf('event: job');
      const doneIndex = sseText.indexOf('event: done');

      expect(connectedIndex).toBeGreaterThanOrEqual(0);
      expect(jobIndex).toBeGreaterThan(connectedIndex);
      expect(doneIndex).toBeGreaterThan(jobIndex);
      expect(sseText).toContain('"status":"complete"');
    } finally {
      closeWebSocket(ws);
    }
  });

  it('signs and dispatches successful job webhooks, marking webhook_sent', async () => {
    const userId = newUserId('webhook-signature');
    const { relay, ws } = await connectAgent(userId, capabilitiesWithModels(['image-klein-9b']));
    const outboundCalls: Array<{ url: string; headers: Headers; body: string }> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      outboundCalls.push({
        url: typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url,
        headers: new Headers(init?.headers),
        body: typeof init?.body === 'string' ? init.body : '',
      });
      return Promise.resolve(new Response('ok', { status: 200 }));
    });

    try {
      const submitResponse = await submitJob(relay, userId, {
        prompt: 'webhook signature',
        webhook_url: 'https://hooks.example/signature',
      });
      const submitJson = await readJson<JsonRecord>(submitResponse);
      const jobId = String(submitJson.job_id);
      await waitForWebSocketJson<JsonRecord>(ws); // job assignment

      ws.send(
        JSON.stringify({
          type: 'result',
          job_id: jobId,
          success: true,
          image_url: 'https://example.com/image.png',
          seed: 9,
          generation_time_ms: 12,
        })
      );

      await vi.waitFor(() => {
        expect(outboundCalls.length).toBe(1);
      });

      const webhookCall = outboundCalls[0];
      expect(webhookCall.url).toBe('https://hooks.example/signature');
      expect(webhookCall.headers.get('X-MereRunRelay-Event')).toBe('job.completed');
      const timestamp = webhookCall.headers.get('X-MereRunRelay-Timestamp');
      expect(timestamp).toBeTruthy();
      const signature = webhookCall.headers.get('X-MereRunRelay-Signature');
      const expected = await signWebhook(testWebhookSigningSecret(), String(timestamp), webhookCall.body);
      expect(signature).toBe(expected);

      const statusResponse = await relay.fetch(new Request(`https://relay/internal/job/${jobId}`));
      const statusJson = await readJson<JobStatusResponse>(statusResponse);
      expect(statusJson.status).toBe('complete');

      const stored = await runInDurableObject(relay, async (_instance, state) =>
        state.storage.get<JsonRecord>(`job:${jobId}`)
      );
      expect(stored?.webhook_sent).toBe(true);
    } finally {
      closeWebSocket(ws);
    }
  });

  it('retries failed webhooks with alarms and eventually marks success', async () => {
    const userId = newUserId('webhook-retry-success');
    const { relay, ws } = await connectAgent(userId, capabilitiesWithModels(['image-klein-9b']));
    let callCount = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      callCount += 1;
      if (callCount < 3) {
        return Promise.resolve(new Response('fail', { status: 500 }));
      }
      return Promise.resolve(new Response('ok', { status: 200 }));
    });

    try {
      const submitResponse = await submitJob(relay, userId, {
        prompt: 'webhook retries',
        webhook_url: 'https://hooks.example/retry-success',
      });
      const submitJson = await readJson<JsonRecord>(submitResponse);
      const jobId = String(submitJson.job_id);
      await waitForWebSocketJson<JsonRecord>(ws); // job assignment

      ws.send(
        JSON.stringify({
          type: 'result',
          job_id: jobId,
          success: true,
          image_url: 'https://example.com/image.png',
          seed: 1,
          generation_time_ms: 7,
        })
      );

      await vi.waitFor(() => {
        expect(callCount).toBe(1);
      });

      expect(await runDurableObjectAlarm(relay)).toBe(true);
      expect(await runDurableObjectAlarm(relay)).toBe(true);
      expect(callCount).toBe(3);

      const storedJob = await runInDurableObject(relay, async (_instance, state) =>
        state.storage.get<JsonRecord>(`job:${jobId}`)
      );
      expect(storedJob?.webhook_sent).toBe(true);

      const pendingState = await runInDurableObject(relay, async (_instance, state) =>
        state.storage.get(`webhook:${jobId}`)
      );
      expect(pendingState).toBeUndefined();
    } finally {
      closeWebSocket(ws);
    }
  });

  it('stops webhook retries at max attempts', async () => {
    const userId = newUserId('webhook-retry-max');
    const { relay, ws } = await connectAgent(userId, capabilitiesWithModels(['image-klein-9b']));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let callCount = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      callCount += 1;
      return Promise.resolve(new Response('fail', { status: 500 }));
    });

    try {
      const submitResponse = await submitJob(relay, userId, {
        prompt: 'webhook max retries',
        webhook_url: 'https://hooks.example/retry-max',
      });
      const submitJson = await readJson<JsonRecord>(submitResponse);
      const jobId = String(submitJson.job_id);
      await waitForWebSocketJson<JsonRecord>(ws); // job assignment

      ws.send(
        JSON.stringify({
          type: 'result',
          job_id: jobId,
          success: true,
          image_url: 'https://example.com/image.png',
          seed: 1,
          generation_time_ms: 7,
        })
      );

      await vi.waitFor(() => {
        expect(callCount).toBe(1);
      });

      for (let i = 0; i < 10; i += 1) {
        const ran = await runDurableObjectAlarm(relay);
        if (!ran) {
          break;
        }
      }

      expect(callCount).toBe(5);
      const storedJob = await runInDurableObject(relay, async (_instance, state) =>
        state.storage.get<JsonRecord>(`job:${jobId}`)
      );
      expect(storedJob?.webhook_sent).toBe(false);
      const pendingState = await runInDurableObject(relay, async (_instance, state) =>
        state.storage.get(`webhook:${jobId}`)
      );
      expect(pendingState).toBeUndefined();
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining(`Webhook delivery exhausted retries for job ${jobId}`)
      );
    } finally {
      closeWebSocket(ws);
    }
  });

  it('dispatches cancelled-job webhooks', async () => {
    const userId = newUserId('webhook-cancelled');
    const { relay, ws } = await connectAgent(userId, capabilitiesWithModels(['image-klein-9b']));
    const events: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((_input: RequestInfo | URL, init?: RequestInit) => {
      events.push(new Headers(init?.headers).get('X-MereRunRelay-Event') || '');
      return Promise.resolve(new Response('ok', { status: 200 }));
    });

    try {
      const submitResponse = await submitJob(relay, userId, {
        prompt: 'cancel webhook',
        webhook_url: 'https://hooks.example/cancelled',
      });
      const submitJson = await readJson<JsonRecord>(submitResponse);
      const jobId = String(submitJson.job_id);
      await waitForWebSocketJson<JsonRecord>(ws); // job assignment

      const cancelResponse = await relay.fetch(
        new Request(`https://relay/internal/job/${jobId}`, { method: 'DELETE' })
      );
      expect(cancelResponse.status).toBe(200);
      expect(await readJson<JsonRecord>(cancelResponse)).toEqual({ cancelled: true });

      await vi.waitFor(() => {
        expect(events).toEqual(['job.cancelled']);
      });

      const statusResponse = await relay.fetch(new Request(`https://relay/internal/job/${jobId}`));
      const status = await readJson<JobStatusResponse>(statusResponse);
      expect(status.status).toBe('cancelled');

      const storedJob = await runInDurableObject(relay, async (_instance, state) =>
        state.storage.get<JsonRecord>(`job:${jobId}`)
      );
      expect(storedJob?.webhook_sent).toBe(true);
    } finally {
      closeWebSocket(ws);
    }
  });

  it('persists and returns ASR alignments when provided', async () => {
    const userId = newUserId('asr-alignments');
    const { relay, ws } = await connectAgent(userId, capabilitiesWithModels(['asr']));
    try {
      const submitResponse = await submitAsr(relay, userId, {
        audio_url: 'https://example.com/audio.wav',
        task: 'transcribe',
      });
      expect(submitResponse.status).toBe(200);
      const submitJson = await readJson<JsonRecord>(submitResponse);
      const asrId = String(submitJson.asr_id);
      expect(submitJson.status).toBe('assigned');

      const assignment = await waitForWebSocketJson<JsonRecord>(ws);
      expect(assignment.type).toBe('asr_request');
      expect(assignment.asr_id).toBe(asrId);

      const tokenAlignments = [
        {
          id: 0,
          text: 'hello',
          start_seconds: 0.0,
          duration_seconds: 0.4,
          end_seconds: 0.4,
        },
      ];
      const sentenceAlignments = [
        {
          text: 'hello',
          start_seconds: 0.0,
          duration_seconds: 0.4,
          end_seconds: 0.4,
          tokens: tokenAlignments,
        },
      ];

      ws.send(
        JSON.stringify({
          type: 'asr_response',
          asr_id: asrId,
          owner_user_id: userId,
          text: 'hello',
          language: 'en',
          duration_seconds: 0.4,
          token_alignments: tokenAlignments,
          sentence_alignments: sentenceAlignments,
        })
      );

      await vi.waitFor(async () => {
        const statusResponse = await relay.fetch(new Request(`https://relay/internal/asr/${asrId}`));
        const status = await readJson<JsonRecord>(statusResponse);
        expect(status.status).toBe('complete');
        expect(status.result).toEqual({
          text: 'hello',
          language: 'en',
          duration_seconds: 0.4,
          token_alignments: tokenAlignments,
          sentence_alignments: sentenceAlignments,
        });
      });
    } finally {
      closeWebSocket(ws);
    }
  });

  it('signs and dispatches successful ASR webhooks', async () => {
    const userId = newUserId('asr-webhook');
    const { relay, ws } = await connectAgent(userId, capabilitiesWithModels(['asr']));
    const outboundCalls: Array<{ url: string; headers: Headers; body: string }> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      outboundCalls.push({
        url: typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url,
        headers: new Headers(init?.headers),
        body: typeof init?.body === 'string' ? init.body : '',
      });
      return Promise.resolve(new Response('ok', { status: 200 }));
    });

    try {
      const submitResponse = await submitAsr(relay, userId, {
        audio_url: 'https://example.com/audio.wav',
        task: 'transcribe',
        webhook_url: 'https://hooks.example/asr',
      });
      const submitJson = await readJson<JsonRecord>(submitResponse);
      const asrId = String(submitJson.asr_id);
      await waitForWebSocketJson<JsonRecord>(ws);

      ws.send(
        JSON.stringify({
          type: 'asr_response',
          asr_id: asrId,
          owner_user_id: userId,
          text: 'hello media',
          language: 'en',
          duration_seconds: 1.2,
        })
      );

      await vi.waitFor(() => {
        expect(outboundCalls.length).toBe(1);
      });

      const webhookCall = outboundCalls[0];
      expect(webhookCall.url).toBe('https://hooks.example/asr');
      expect(webhookCall.headers.get('X-MereRunRelay-Event')).toBe('asr.completed');
      const timestamp = webhookCall.headers.get('X-MereRunRelay-Timestamp');
      const signature = webhookCall.headers.get('X-MereRunRelay-Signature');
      expect(signature).toBe(await signWebhook(testWebhookSigningSecret(), String(timestamp), webhookCall.body));
      expect(JSON.parse(webhookCall.body)).toMatchObject({
        asr_id: asrId,
        status: 'complete',
        result: { text: 'hello media' },
      });

      const stored = await runInDurableObject(relay, async (_instance, state) =>
        state.storage.get<JsonRecord>(`asr:${asrId}`)
      );
      expect(stored?.webhook_sent).toBe(true);
    } finally {
      closeWebSocket(ws);
    }
  });

  it('signs and dispatches successful embed webhooks', async () => {
    const userId = newUserId('embed-webhook');
    const { relay, ws } = await connectAgent(userId, capabilitiesWithModels(['embed', 'text-embed-qwen3-0.6b']));
    const outboundCalls: Array<{ url: string; headers: Headers; body: string }> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      outboundCalls.push({
        url: typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url,
        headers: new Headers(init?.headers),
        body: typeof init?.body === 'string' ? init.body : '',
      });
      return Promise.resolve(new Response('ok', { status: 200 }));
    });

    try {
      const submitResponse = await submitEmbed(relay, userId, {
        texts: ['alpha', 'beta'],
        model: 'text-embed-qwen3-0.6b',
        webhook_url: 'https://hooks.example/embed',
      });
      const submitJson = await readJson<JsonRecord>(submitResponse);
      const embedId = String(submitJson.embed_id);
      await waitForWebSocketJson<JsonRecord>(ws);

      ws.send(
        JSON.stringify({
          type: 'embed_response',
          embed_id: embedId,
          owner_user_id: userId,
          model: 'text-embed-qwen3-0.6b',
          dimensions: 2,
          data: [
            { index: 0, embedding: [0.1, 0.2] },
            { index: 1, embedding: [0.3, 0.4] },
          ],
        })
      );

      await vi.waitFor(() => {
        expect(outboundCalls.length).toBe(1);
      });

      const webhookCall = outboundCalls[0];
      expect(webhookCall.url).toBe('https://hooks.example/embed');
      expect(webhookCall.headers.get('X-MereRunRelay-Event')).toBe('embed.completed');
      const timestamp = webhookCall.headers.get('X-MereRunRelay-Timestamp');
      const signature = webhookCall.headers.get('X-MereRunRelay-Signature');
      expect(signature).toBe(await signWebhook(testWebhookSigningSecret(), String(timestamp), webhookCall.body));
      expect(JSON.parse(webhookCall.body)).toMatchObject({
        embed_id: embedId,
        status: 'complete',
        result: { dimensions: 2 },
      });

      const stored = await runInDurableObject(relay, async (_instance, state) =>
        state.storage.get<JsonRecord>(`embed:${embedId}`)
      );
      expect(stored?.webhook_sent).toBe(true);
    } finally {
      closeWebSocket(ws);
    }
  });

  it('persists embed failures reported by the assigned node', async () => {
    const userId = newUserId('embed-error');
    const { relay, ws } = await connectAgent(userId, capabilitiesWithModels(['text-embed-qwen3-0.6b']));
    try {
      const submitted = await readJson<JsonRecord>(await submitEmbed(relay, userId, {
        texts: ['failure path'],
        model: 'text-embed-qwen3-0.6b',
      }));
      const embedId = String(submitted.embed_id);
      await waitForWebSocketJson<JsonRecord>(ws);
      ws.send(JSON.stringify({
        type: 'embed_error',
        embed_id: embedId,
        owner_user_id: userId,
        error: 'synthetic failure',
      }));

      await vi.waitFor(async () => {
        const status = await readJson<JsonRecord>(await relay.fetch(new Request(
          `https://relay/internal/embed/${embedId}`
        )));
        expect(status).toMatchObject({ status: 'failed', error: 'synthetic failure' });
      });
    } finally {
      closeWebSocket(ws);
    }
  });

  const cancelTargets = [
    {
      name: 'talk',
      capabilities: capabilitiesWithModels(['talk-nano']),
      submit: submitTalk,
      payload: { text: 'Hello world' },
      idField: 'talk_id',
      requestType: 'talk_request',
      cancelType: 'talk_cancel',
      successMessage: (id: string, userId: string) => ({
        type: 'talk_response',
        talk_id: id,
        owner_user_id: userId,
        audio_url: 'https://example.com/audio.wav',
        duration_seconds: 1.2,
        sample_rate: 24000,
        output_format: 'wav',
      }),
      errorMessage: (id: string, userId: string) => ({
        type: 'talk_error',
        talk_id: id,
        owner_user_id: userId,
        error: 'synthetic failure',
      }),
      path: (id: string) => `/internal/talk/${id}`,
      terminalError: 'Talk request already completed',
    },
    {
      name: 'asr',
      capabilities: capabilitiesWithModels(['asr']),
      submit: submitAsr,
      payload: { audio_url: 'https://example.com/audio.wav', task: 'transcribe' as const },
      idField: 'asr_id',
      requestType: 'asr_request',
      cancelType: 'asr_cancel',
      successMessage: (id: string, userId: string) => ({
        type: 'asr_response',
        asr_id: id,
        owner_user_id: userId,
        text: 'hello',
        language: 'en',
        duration_seconds: 1.1,
      }),
      errorMessage: (id: string, userId: string) => ({
        type: 'asr_error',
        asr_id: id,
        owner_user_id: userId,
        error: 'synthetic failure',
      }),
      path: (id: string) => `/internal/asr/${id}`,
      terminalError: 'ASR request already completed',
    },
    {
      name: 'ocr',
      capabilities: capabilitiesWithModels(['ocr']),
      submit: submitOcr,
      payload: { image_url: 'https://example.com/image.png' },
      idField: 'ocr_id',
      requestType: 'ocr_request',
      cancelType: 'ocr_cancel',
      successMessage: (id: string, userId: string) => ({
        type: 'ocr_response',
        ocr_id: id,
        owner_user_id: userId,
        text: 'hello',
        tokens_generated: 12,
      }),
      errorMessage: (id: string, userId: string) => ({
        type: 'ocr_error',
        ocr_id: id,
        owner_user_id: userId,
        error: 'synthetic failure',
      }),
      path: (id: string) => `/internal/ocr/${id}`,
      terminalError: 'OCR request already completed',
    },
  ] as const;

  for (const target of cancelTargets) {
    it(`provides full cancel parity for ${target.name}, including late-result hardening`, async () => {
      const userId = newUserId(`cancel-${target.name}`);
      const { relay, ws } = await connectAgent(userId, target.capabilities);
      try {
        const firstSubmit = await target.submit(relay, userId, target.payload as never);
        expect(firstSubmit.status).toBe(200);
        const firstJson = await readJson<JsonRecord>(firstSubmit);
        const firstId = String(firstJson[target.idField]);
        expect(firstJson.status).toBe('assigned');
        const firstAssigned = await waitForWebSocketJson<JsonRecord>(ws);
        expect(firstAssigned.type).toBe(target.requestType);
        expect(firstAssigned[target.idField]).toBe(firstId);

        const secondSubmit = await target.submit(relay, userId, target.payload as never);
        expect(secondSubmit.status).toBe(200);
        const secondJson = await readJson<JsonRecord>(secondSubmit);
        const secondId = String(secondJson[target.idField]);
        expect(secondJson.status).toBe('queued');

        const cancelQueued = await relay.fetch(
          new Request(`https://relay${target.path(secondId)}`, { method: 'DELETE' })
        );
        expect(cancelQueued.status).toBe(200);
        expect(await readJson<JsonRecord>(cancelQueued)).toEqual({ cancelled: true });

        const queuedStatusResponse = await relay.fetch(new Request(`https://relay${target.path(secondId)}`));
        expect(queuedStatusResponse.status).toBe(200);
        const queuedStatus = await readJson<JsonRecord>(queuedStatusResponse);
        expect(queuedStatus.status).toBe('cancelled');

        const repeatedCancel = await relay.fetch(
          new Request(`https://relay${target.path(secondId)}`, { method: 'DELETE' })
        );
        expect(repeatedCancel.status).toBe(200);
        expect(await readJson<JsonRecord>(repeatedCancel)).toEqual({ cancelled: true });

        const notFoundCancel = await relay.fetch(
          new Request(`https://relay${target.path(`${target.name}_missing`)}`, { method: 'DELETE' })
        );
        expect(notFoundCancel.status).toBe(404);

        const cancelProcessing = await relay.fetch(
          new Request(`https://relay${target.path(firstId)}`, { method: 'DELETE' })
        );
        expect(cancelProcessing.status).toBe(200);
        expect(await readJson<JsonRecord>(cancelProcessing)).toEqual({ cancelled: true });

        const cancelMessage = await waitForWebSocketJson<JsonRecord>(ws);
        expect(cancelMessage.type).toBe(target.cancelType);
        expect(cancelMessage[target.idField]).toBe(firstId);

        ws.send(JSON.stringify(target.successMessage(firstId, userId)));
        ws.send(JSON.stringify(target.errorMessage(firstId, userId)));

        const cancelledStatusResponse = await relay.fetch(new Request(`https://relay${target.path(firstId)}`));
        const cancelledStatus = await readJson<JsonRecord>(cancelledStatusResponse);
        expect(cancelledStatus.status).toBe('cancelled');
        expect(cancelledStatus.error).toBe('Cancelled by client');

        const completedSubmit = await target.submit(relay, userId, target.payload as never);
        expect(completedSubmit.status).toBe(200);
        const completedJson = await readJson<JsonRecord>(completedSubmit);
        const completedId = String(completedJson[target.idField]);
        await waitForWebSocketJson<JsonRecord>(ws); // request
        ws.send(JSON.stringify(target.successMessage(completedId, userId)));

        const cancelCompleted = await relay.fetch(
          new Request(`https://relay${target.path(completedId)}`, { method: 'DELETE' })
        );
        expect(cancelCompleted.status).toBe(400);
        const cancelCompletedJson = await readJson<JsonRecord>(cancelCompleted);
        expect(cancelCompletedJson.cancelled).toBe(false);
        expect(cancelCompletedJson.error).toBe(target.terminalError);

        const failedSubmit = await target.submit(relay, userId, target.payload as never);
        expect(failedSubmit.status).toBe(200);
        const failedJson = await readJson<JsonRecord>(failedSubmit);
        const failedId = String(failedJson[target.idField]);
        await waitForWebSocketJson<JsonRecord>(ws); // request
        ws.send(JSON.stringify(target.errorMessage(failedId, userId)));

        const cancelFailed = await relay.fetch(
          new Request(`https://relay${target.path(failedId)}`, { method: 'DELETE' })
        );
        expect(cancelFailed.status).toBe(400);
        const cancelFailedJson = await readJson<JsonRecord>(cancelFailed);
        expect(cancelFailedJson.cancelled).toBe(false);
        expect(cancelFailedJson.error).toBe(target.terminalError);
      } finally {
        closeWebSocket(ws);
      }
    });
  }
});
