import { describe, expect, it } from 'vitest';
import type { FleetModelPlan, FleetSnapshot } from '../src/types';
import {
  capabilitiesWithModels,
  closeWebSocket,
  connectAgent,
  readJson,
  submitAsr,
  submitEmbed,
  submitJob,
  waitForWebSocketJson,
} from './helpers';

type JsonRecord = Record<string, unknown>;

function newUserId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

describe('fleet control plane', () => {
  it('plans and applies an explicit model inventory transfer between nodes', async () => {
    const userId = newUserId('fleet-model-plan');
    const source = await connectAgent(userId, capabilitiesWithModels(['image']), {
      deviceId: 'model-source',
      deviceName: 'Model Source',
      runtime: {
        mere_run_version: 'mere.run 0.22.0',
        installed_models: ['image-klein-nano', 'video-ltx23-a2vid-mlx'],
        inventory_status: 'reported',
      },
    });
    const target = await connectAgent(userId, capabilitiesWithModels(['image']), {
      deviceId: 'model-target',
      deviceName: 'Model Target',
      runtime: {
        mere_run_version: 'mere.run 0.22.0',
        installed_models: ['image-klein-nano'],
        inventory_status: 'reported',
      },
    });

    try {
      const created = await source.relay.fetch(new Request(
        'https://relay/internal/fleet/model-plans',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            source_device_id: 'model-source',
            target_device_ids: ['model-target'],
          }),
        }
      ));
      expect(created.status).toBe(201);
      const plan = await readJson<FleetModelPlan>(created);
      expect(plan).toMatchObject({
        kind: 'mere.run/fleet-model-plan',
        state: 'planned',
        model_ids: ['image-klein-nano', 'video-ltx23-a2vid-mlx'],
        targets: [{
          device_id: 'model-target',
          missing_model_ids: ['video-ltx23-a2vid-mlx'],
          state: 'ready',
        }],
      });

      const applied = await source.relay.fetch(new Request(
        `https://relay/internal/fleet/model-plans/${plan.plan_id}/apply`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ accept_model_licenses: true }),
        }
      ));
      expect(applied.status).toBe(202);
      expect(await waitForWebSocketJson<JsonRecord>(target.ws)).toEqual({
        type: 'model_plan_request',
        plan_id: plan.plan_id,
        attempt: 1,
        model_ids: ['video-ltx23-a2vid-mlx'],
        accept_model_licenses: true,
      });

      target.ws.send(JSON.stringify({
        type: 'model_plan_event',
        plan_id: plan.plan_id,
        attempt: 1,
        model_id: 'video-ltx23-a2vid-mlx',
        phase: 'pulling',
      }));
      target.ws.send(JSON.stringify({
        type: 'model_plan_result',
        plan_id: plan.plan_id,
        attempt: 1,
        results: [{ model_id: 'video-ltx23-a2vid-mlx', state: 'installed' }],
        installed_model_ids: ['image-klein-nano', 'video-ltx23-a2vid-mlx'],
      }));
      expect(await waitForWebSocketJson<JsonRecord>(target.ws)).toEqual({ type: 'inventory_request' });
      await new Promise((resolve) => setTimeout(resolve, 10));

      const finished = await readJson<FleetModelPlan>(await source.relay.fetch(new Request(
        `https://relay/internal/fleet/model-plans/${plan.plan_id}`
      )));
      expect(finished).toMatchObject({
        state: 'finished',
        targets: [{ state: 'finished', missing_model_ids: [] }],
      });
      expect(finished.events.map((event) => event.phase)).toEqual([
        'dispatched',
        'pulling',
        'finished',
      ]);
      const fleet = await readJson<FleetSnapshot>(
        await source.relay.fetch(new Request('https://relay/internal/fleet'))
      );
      expect(fleet.nodes.find((node) => node.device_id === 'model-target')).toMatchObject({
        status: 'online',
        runtime: { installed_models: ['image-klein-nano', 'video-ltx23-a2vid-mlx'] },
      });
    } finally {
      closeWebSocket(source.ws);
      closeWebSocket(target.ws);
    }
  });

  it('persists system, runtime, and telemetry inventory for the account fleet', async () => {
    const userId = newUserId('fleet-inventory');
    const deviceId = 'fleet-mac-studio';
    const { relay, ws } = await connectAgent(
      userId,
      capabilitiesWithModels(['image-klein-9b', 'image']),
      {
        deviceId,
        deviceName: 'Edit Suite',
        system: {
          platform: 'macos',
          architecture: 'aarch64',
          os_version: '15.5',
          cpu_model: 'Apple M4 Max',
          logical_cores: 16,
          memory_total_bytes: 64 * 1024 ** 3,
          accelerators: [{
            backend: 'metal',
            name: 'Apple M4 Max',
            memory_total_bytes: 64 * 1024 ** 3,
          }],
        },
        runtime: {
          mere_run_version: 'mere.run 0.20.0',
          installed_models: ['image-klein-9b', 'text-chat-gemma4-12b-4bit'],
          inventory_status: 'reported',
        },
        capacity: { max_concurrent_jobs: 1 },
      }
    );

    try {
      ws.send(JSON.stringify({
        type: 'ping',
        timestamp_ms: Date.now(),
        telemetry: {
          sampled_at: new Date().toISOString(),
          cpu_load_percent: 18,
          memory_available_bytes: 42 * 1024 ** 3,
          power_source: 'ac',
          thermal_state: 'nominal',
        },
      }));
      expect((await waitForWebSocketJson<JsonRecord>(ws)).type).toBe('pong');

      const response = await relay.fetch(new Request('https://relay/internal/fleet'));
      expect(response.status).toBe(200);
      const fleet = await readJson<FleetSnapshot>(response);
      expect(fleet.summary.total_nodes).toBe(1);
      expect(fleet.summary.online_nodes).toBe(1);
      expect(fleet.summary.installed_models).toBe(2);
      expect(fleet.nodes[0]).toMatchObject({
        device_id: deviceId,
        device_name: 'Edit Suite',
        status: 'online',
        system: { platform: 'macos', architecture: 'aarch64', cpu_model: 'Apple M4 Max' },
        runtime: { mere_run_version: 'mere.run 0.20.0', inventory_status: 'reported' },
        telemetry: { cpu_load_percent: 18, power_source: 'ac', thermal_state: 'nominal' },
      });
    } finally {
      closeWebSocket(ws);
    }
  });

  it('refreshes live node inventory through the relay websocket', async () => {
    const userId = newUserId('fleet-refresh');
    const deviceId = 'refreshable-node';
    const { relay, ws } = await connectAgent(
      userId,
      capabilitiesWithModels(['image']),
      { deviceId }
    );

    try {
      const refresh = await relay.fetch(new Request(
        `https://relay/internal/fleet/nodes/${deviceId}/refresh`,
        { method: 'POST' }
      ));
      expect(refresh.status).toBe(202);
      expect(await waitForWebSocketJson<JsonRecord>(ws)).toEqual({ type: 'inventory_request' });

      ws.send(JSON.stringify({
        type: 'inventory_update',
        capabilities: capabilitiesWithModels(['image', 'image-krea2-raw']),
        system: { platform: 'linux', architecture: 'x86_64', accelerators: [] },
        runtime: {
          mere_run_version: 'mere.run 0.21.0',
          installed_models: ['image-krea2-raw'],
          inventory_status: 'reported',
        },
        capacity: { max_concurrent_jobs: 1, lease_protocol: true },
      }));
      await new Promise((resolve) => setTimeout(resolve, 10));

      const fleet = await readJson<FleetSnapshot>(
        await relay.fetch(new Request('https://relay/internal/fleet'))
      );
      expect(fleet.nodes[0]).toMatchObject({
        device_id: deviceId,
        capabilities: { models: ['image', 'image-krea2-raw'] },
        runtime: { installed_models: ['image-krea2-raw'], inventory_status: 'reported' },
      });
    } finally {
      closeWebSocket(ws);
    }
  });

  it('removes locally busy Animatic nodes from placement without clearing relay ownership', async () => {
    const userId = newUserId('fleet-local-availability');
    const node = await connectAgent(
      userId,
      capabilitiesWithModels(['image', 'image-klein-9b']),
      {
        deviceId: 'animatic-shared-node',
        availability: {
          status: 'busy',
          current_job_id: 'local:animatic:cycle-1',
          source: 'animatic',
        },
      }
    );

    try {
      let fleet = await readJson<FleetSnapshot>(
        await node.relay.fetch(new Request('https://relay/internal/fleet'))
      );
      expect(fleet.nodes[0]).toMatchObject({
        status: 'busy',
        current_job_id: 'local:animatic:cycle-1',
      });

      const submitted = await readJson<JsonRecord>(await submitJob(node.relay, userId, {
        prompt: 'wait for shared accelerator',
        model: 'image-klein-9b',
      }));
      expect(submitted.status).toBe('queued');

      node.ws.send(JSON.stringify({
        type: 'availability_update',
        status: 'online',
        current_job_id: 'local:animatic:cycle-1',
        source: 'animatic',
      }));
      const assignment = await waitForWebSocketJson<JsonRecord>(node.ws);
      expect(assignment).toMatchObject({ type: 'job', job_id: submitted.job_id });

      node.ws.send(JSON.stringify({
        type: 'availability_update',
        status: 'busy',
        current_job_id: 'local:animatic:cycle-race',
        source: 'animatic',
      }));
      await new Promise((resolve) => setTimeout(resolve, 10));
      fleet = await readJson<FleetSnapshot>(
        await node.relay.fetch(new Request('https://relay/internal/fleet'))
      );
      expect(fleet.nodes[0]).toMatchObject({
        status: 'busy',
        current_job_id: submitted.job_id,
      });

      const next = await readJson<JsonRecord>(await submitJob(node.relay, userId, {
        prompt: 'next relay job',
        model: 'image-klein-9b',
      }));
      expect(next.status).toBe('queued');

      node.ws.send(JSON.stringify({
        type: 'result',
        job_id: submitted.job_id,
        lease_id: assignment.lease_id,
        success: true,
        media_url: 'https://assets.example/shared.png',
        content_type: 'image/png',
        output_kind: 'image',
      }));
      const nextAssignment = await waitForWebSocketJson<JsonRecord>(node.ws);
      expect(nextAssignment).toMatchObject({ type: 'job', job_id: next.job_id });

      node.ws.send(JSON.stringify({
        type: 'availability_update',
        status: 'online',
        current_job_id: submitted.job_id,
        source: 'relay',
      }));
      await new Promise((resolve) => setTimeout(resolve, 10));
      fleet = await readJson<FleetSnapshot>(
        await node.relay.fetch(new Request('https://relay/internal/fleet'))
      );
      expect(fleet.nodes[0]).toMatchObject({
        status: 'busy',
        current_job_id: next.job_id,
      });
    } finally {
      closeWebSocket(node.ws);
    }
  });

  it('learns per-model performance from completed embedding work', async () => {
    const userId = newUserId('fleet-embed-performance');
    const model = 'text-embed-qwen3-0.6b';
    const deviceId = 'embed-performance-node';
    const { relay, ws } = await connectAgent(
      userId,
      capabilitiesWithModels(['embed', model]),
      { deviceId }
    );

    try {
      const submitted = await readJson<JsonRecord>(await submitEmbed(relay, userId, {
        texts: ['performance learning'],
        model,
      }));
      await waitForWebSocketJson<JsonRecord>(ws);
      await new Promise((resolve) => setTimeout(resolve, 10));
      ws.send(JSON.stringify({
        type: 'embed_response',
        embed_id: submitted.embed_id,
        model,
        dimensions: 2,
        data: [{ index: 0, embedding: [0.1, 0.2] }],
      }));

      await new Promise((resolve) => setTimeout(resolve, 10));
      const fleet = await readJson<FleetSnapshot>(
        await relay.fetch(new Request('https://relay/internal/fleet'))
      );
      const node = fleet.nodes.find((candidate) => candidate.device_id === deviceId);
      expect(node?.performance.models[model]).toMatchObject({
        successes: 1,
        failures: 0,
      });
      expect(node?.performance.models[model]?.average_generation_time_ms).toBeGreaterThan(0);
      expect(
        fleet.models.find((candidate) => candidate.model === model)?.fastest_average_ms
      ).toBeGreaterThan(0);
    } finally {
      closeWebSocket(ws);
    }
  });

  it('applies node policy and scheduler priority when selecting an eligible node', async () => {
    const userId = newUserId('fleet-policy');
    const capabilities = capabilitiesWithModels(['image-klein-9b', 'image']);
    const first = await connectAgent(userId, capabilities, { deviceId: 'priority-low', deviceName: 'Low priority' });
    const second = await connectAgent(userId, capabilities, { deviceId: 'priority-high', deviceName: 'High priority' });

    try {
      const patchLow = await first.relay.fetch(new Request('https://relay/internal/fleet/nodes/priority-low', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ priority: 5 }),
      }));
      const patchHigh = await first.relay.fetch(new Request('https://relay/internal/fleet/nodes/priority-high', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ priority: 95, display_name: 'Preferred GPU' }),
      }));
      expect(patchLow.status).toBe(200);
      expect(patchHigh.status).toBe(200);

      const submit = await submitJob(first.relay, userId, {
        prompt: 'scheduler priority proof',
        model: 'image-klein-9b',
      });
      expect(submit.status).toBe(200);
      const assignment = await readJson<JsonRecord>(submit);
      expect(assignment.agent_id).toBe(second.agentId);
      const message = await waitForWebSocketJson<JsonRecord>(second.ws);
      expect(message.type).toBe('job');

      const fleet = await readJson<FleetSnapshot>(
        await first.relay.fetch(new Request('https://relay/internal/fleet'))
      );
      expect(fleet.nodes.find((node) => node.device_id === 'priority-high')).toMatchObject({
        device_name: 'Preferred GPU',
        policy: { priority: 95, display_name: 'Preferred GPU' },
      });
    } finally {
      closeWebSocket(first.ws);
      closeWebSocket(second.ws);
    }
  });

  it('rejects malformed fleet policy and scheduler updates', async () => {
    const userId = newUserId('fleet-validation');
    const agent = await connectAgent(userId, capabilitiesWithModels(['image']), {
      deviceId: 'validated-node',
    });

    try {
      const invalidNode = await agent.relay.fetch(new Request(
        'https://relay/internal/fleet/nodes/validated-node',
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: 'false', preferred_models: 'image' }),
        }
      ));
      expect(invalidNode.status).toBe(400);

      const invalidSettings = await agent.relay.fetch(new Request(
        'https://relay/internal/fleet/settings',
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ scheduler_mode: 'random', retry_limit: 'forever' }),
        }
      ));
      expect(invalidSettings.status).toBe(400);

      const fleet = await readJson<FleetSnapshot>(
        await agent.relay.fetch(new Request('https://relay/internal/fleet'))
      );
      expect(fleet.nodes[0].policy.enabled).toBe(true);
      expect(fleet.settings.scheduler_mode).toBe('balanced');
    } finally {
      closeWebSocket(agent.ws);
    }
  });

  it('does not let an incompatible queued job block later runnable work', async () => {
    const userId = newUserId('fleet-queue');
    const image = await connectAgent(
      userId,
      capabilitiesWithModels(['image-klein-9b', 'image']),
      { deviceId: 'image-node' }
    );
    const asr = await connectAgent(
      userId,
      capabilitiesWithModels(['asr']),
      { deviceId: 'asr-node' }
    );

    try {
      const firstImage = await readJson<JsonRecord>(await submitJob(image.relay, userId, {
        prompt: 'occupy image node',
        model: 'image-klein-9b',
      }));
      expect(firstImage.status).toBe('assigned');
      await waitForWebSocketJson(image.ws);

      const firstAsr = await readJson<JsonRecord>(await submitAsr(asr.relay, userId, {
        audio_url: 'https://assets.example/first.wav',
      }));
      expect(firstAsr.status).toBe('assigned');
      await waitForWebSocketJson(asr.ws);

      const queuedImage = await readJson<JsonRecord>(await submitJob(image.relay, userId, {
        prompt: 'older queued image',
        model: 'image-klein-9b',
      }));
      expect(queuedImage.status).toBe('queued');

      const queuedAsr = await readJson<JsonRecord>(await submitAsr(asr.relay, userId, {
        audio_url: 'https://assets.example/second.wav',
      }));
      expect(queuedAsr.status).toBe('queued');

      asr.ws.send(JSON.stringify({
        type: 'asr_response',
        asr_id: firstAsr.asr_id,
        text: 'done',
        language: 'en',
      }));

      const nextAssignment = await waitForWebSocketJson<JsonRecord>(asr.ws);
      expect(nextAssignment.type).toBe('asr_request');
      expect(nextAssignment.asr_id).toBe(queuedAsr.asr_id);
    } finally {
      closeWebSocket(image.ws);
      closeWebSocket(asr.ws);
    }
  });

  it('requeues lease-aware work after disconnect and ignores stale results', async () => {
    const userId = newUserId('fleet-lease');
    const capabilities = capabilitiesWithModels(['image-klein-9b', 'image']);
    const first = await connectAgent(userId, capabilities, {
      deviceId: 'lease-node-first',
      capacity: { max_concurrent_jobs: 1, lease_protocol: true },
    });
    let second: Awaited<ReturnType<typeof connectAgent>> | null = null;

    try {
      const submitted = await readJson<JsonRecord>(await submitJob(first.relay, userId, {
        prompt: 'survive node disconnect',
        model: 'image-klein-9b',
      }));
      const firstAssignment = await waitForWebSocketJson<JsonRecord>(first.ws);
      expect(firstAssignment.type).toBe('job');
      expect(firstAssignment.lease_id).toMatch(/^lease_/);

      closeWebSocket(first.ws);
      await new Promise((resolve) => setTimeout(resolve, 10));

      second = await connectAgent(userId, capabilities, {
        deviceId: 'lease-node-second',
        capacity: { max_concurrent_jobs: 1, lease_protocol: true },
      });
      const retryAssignment = await waitForWebSocketJson<JsonRecord>(second.ws);
      expect(retryAssignment.type).toBe('job');
      expect(retryAssignment.job_id).toBe(submitted.job_id);
      expect(retryAssignment.lease_id).not.toBe(firstAssignment.lease_id);

      await first.relay.fetch(new Request('https://relay/internal/result', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'result',
          job_id: submitted.job_id,
          lease_id: firstAssignment.lease_id,
          success: true,
          media_url: 'https://assets.example/stale.png',
          output_kind: 'image',
          generation_time_ms: 99,
        }),
      }));
      const afterStale = await readJson<JsonRecord>(await first.relay.fetch(
        new Request(`https://relay/internal/job/${String(submitted.job_id)}`)
      ));
      expect(afterStale.status).toBe('assigned');
      expect(afterStale.agent_id).toBe(second.agentId);

      second.ws.send(JSON.stringify({
        type: 'result',
        job_id: submitted.job_id,
        lease_id: retryAssignment.lease_id,
        success: true,
        media_url: 'https://assets.example/current.png',
        content_type: 'image/png',
        output_kind: 'image',
        generation_time_ms: 123,
      }));
      await new Promise((resolve) => setTimeout(resolve, 10));
      const completed = await readJson<JsonRecord>(await first.relay.fetch(
        new Request(`https://relay/internal/job/${String(submitted.job_id)}`)
      ));
      expect(completed.status).toBe('complete');
    } finally {
      closeWebSocket(first.ws);
      if (second) closeWebSocket(second.ws);
    }
  });

  it('does not let a superseded socket tear down work assigned to the replacement connection', async () => {
    const userId = newUserId('fleet-reconnect');
    const deviceId = 'reconnecting-node';
    const capabilities = capabilitiesWithModels(['image-klein-9b', 'image']);
    const first = await connectAgent(userId, capabilities, {
      deviceId,
      capacity: { max_concurrent_jobs: 1, lease_protocol: true },
    });
    let replacement: Awaited<ReturnType<typeof connectAgent>> | null = null;

    try {
      const submitted = await readJson<JsonRecord>(await submitJob(first.relay, userId, {
        prompt: 'stay assigned through reconnect',
        model: 'image-klein-9b',
      }));
      const firstAssignment = await waitForWebSocketJson<JsonRecord>(first.ws);
      expect(firstAssignment.type).toBe('job');

      replacement = await connectAgent(userId, capabilities, {
        deviceId,
        capacity: { max_concurrent_jobs: 1, lease_protocol: true },
      });
      expect(replacement.agentId).toBe(first.agentId);
      const replacementAssignment = await waitForWebSocketJson<JsonRecord>(replacement.ws);
      expect(replacementAssignment.type).toBe('job');
      expect(replacementAssignment.job_id).toBe(submitted.job_id);
      expect(replacementAssignment.lease_id).not.toBe(firstAssignment.lease_id);

      await new Promise((resolve) => setTimeout(resolve, 10));
      const current = await readJson<JsonRecord>(await first.relay.fetch(
        new Request(`https://relay/internal/job/${String(submitted.job_id)}`)
      ));
      expect(current.status).toBe('assigned');

      const fleet = await readJson<FleetSnapshot>(
        await first.relay.fetch(new Request('https://relay/internal/fleet'))
      );
      expect(fleet.nodes.find((node) => node.device_id === deviceId)).toMatchObject({
        status: 'busy',
        current_job_id: submitted.job_id,
      });
    } finally {
      closeWebSocket(first.ws);
      if (replacement) closeWebSocket(replacement.ws);
    }
  });
});
