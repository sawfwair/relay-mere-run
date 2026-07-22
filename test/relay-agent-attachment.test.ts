import { describe, expect, it } from 'vitest';
import {
  agentAttachmentByteLength,
  compactAgentInfoForAttachment,
  MAX_WEBSOCKET_ATTACHMENT_BYTES,
} from '../src/relay-agent-attachment';
import type { AgentInfo } from '../src/types';

describe('Relay agent attachment inventory', () => {
  it('retains placement-critical commands under Cloudflare attachment limits', () => {
    const info: AgentInfo = {
      agent_id: 'agent_inventory_limit',
      device_id: 'node_inventory_limit',
      device_name: 'inventory limit',
      version: '0.2.9',
      status: 'online',
      current_job_id: null,
      connected_at: '2026-07-21T00:00:00.000Z',
      last_ping: '2026-07-21T00:00:00.000Z',
      capabilities: {
        models: ['video-ltx23-av-mlx', 'vision-segment-sam31'],
        max_resolution: 2048,
        controlnet: false,
        lora: false,
        img2img: true,
        plugins: [{
          name: 'mere-animatic-tools',
          version: '0.2.0',
          executable: 'mere-animatic-tools',
          description: 'x'.repeat(2_000),
          commands: ['build-set-proxy', 'solve-set-lighting', 'render-set-plate'],
          capabilities: Array.from({ length: 300 }, (_, index) => `capability-${index}`),
        }],
        graph_worker: {
          schema_version: 1,
          worker_version: '0.2.9',
          contract_versions: ['mere.run/job-bundle.v1'],
          platform: 'darwin',
          architecture: 'arm64',
          accelerator_backend: 'metal',
          memory_bytes: 128 * 1024 ** 3,
          node_kinds: ['image.generate'],
          installed_model_ids: ['video-ltx23-av-mlx'],
          cached_asset_digests: Array.from({ length: 500 }, (_, index) =>
            index.toString(16).padStart(64, '0')
          ),
          providers: [],
          catalog: { nodes: Array.from({ length: 300 }, (_, index) => ({ kind: `node.${index}` })) },
        },
      },
      runtime: {
        mere_run_version: '0.11.0',
        installed_models: ['video-ltx23-av-mlx', 'vision-segment-sam31'],
        inventory_status: 'reported',
      },
      capacity: { max_concurrent_jobs: 1, lease_protocol: true },
    };

    expect(agentAttachmentByteLength(info)).toBeGreaterThan(MAX_WEBSOCKET_ATTACHMENT_BYTES);
    const compact = compactAgentInfoForAttachment(info);
    expect(agentAttachmentByteLength(compact)).toBeLessThanOrEqual(MAX_WEBSOCKET_ATTACHMENT_BYTES);
    expect(compact.capabilities.plugins?.[0].commands).toEqual([
      'build-set-proxy',
      'solve-set-lighting',
      'render-set-plate',
    ]);
    expect(compact.capabilities.plugins?.[0].capabilities).toEqual([]);
    expect(compact.capabilities.graph_worker?.catalog).toBeUndefined();
    expect(compact.capabilities.graph_worker?.cached_asset_digests?.length).toBeLessThanOrEqual(32);
  });
});
