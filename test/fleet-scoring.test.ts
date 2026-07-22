import { describe, expect, it } from 'vitest';
import { scoreAgentForWork } from '../src/relay-fleet';
import type { AgentInfo, PowerSource } from '../src/types';

function agentWithPower(powerSource: PowerSource): AgentInfo {
  return {
    agent_id: `agent-${powerSource}`,
    device_id: `device-${powerSource}`,
    device_name: powerSource,
    version: '0.1.4',
    capabilities: {
      models: ['image-klein-9b'],
      max_resolution: 2048,
      controlnet: false,
      lora: false,
      img2img: true,
    },
    status: 'online',
    current_job_id: null,
    connected_at: new Date(0).toISOString(),
    last_ping: new Date(0).toISOString(),
    telemetry: {
      sampled_at: new Date(0).toISOString(),
      power_source: powerSource,
    },
  };
}

describe('fleet scheduling scores', () => {
  it('treats externally powered Linux desktops like AC-powered nodes', () => {
    const ac = scoreAgentForWork(agentWithPower('ac'), 'image-klein-9b', 'efficient');
    const external = scoreAgentForWork(agentWithPower('external'), 'image-klein-9b', 'efficient');
    const battery = scoreAgentForWork(agentWithPower('battery'), 'image-klein-9b', 'efficient');

    expect(external).toBe(ac);
    expect(external).toBeGreaterThan(battery);
  });
});
