import { describe, expect, it } from 'vitest';
import { supportsAsr } from '../src/relay-queue';
import type { AgentInfo, Asr } from '../src/types';

function agent(models: string[]): AgentInfo {
  return {
    agent_id: 'agent-diarization',
    device_id: 'device-diarization',
    device_name: 'Diarization node',
    version: '0.2.14',
    capabilities: {
      models,
      max_resolution: 2048,
      controlnet: false,
      lora: false,
      img2img: true,
    },
    runtime: {
      mere_run_version: '0.29.0',
      installed_models: models,
      inventory_status: 'reported',
    },
    status: 'online',
    current_job_id: null,
    connected_at: new Date(0).toISOString(),
    last_ping: new Date(0).toISOString(),
  };
}

function diarizedAsr(): Asr {
  return {
    asr_id: 'asr-diarization',
    user_id: 'user-1',
    client_id: 'client-1',
    agent_id: null,
    status: 'queued',
    request: {
      audio_url: 'https://example.com/audio.wav',
      language: null,
      task: 'transcribe',
      backend: 'auto',
      diarize: true,
      max_tokens: 448,
    },
    result: null,
    error: null,
    created_at: new Date(0).toISOString(),
    started_at: null,
    completed_at: null,
    webhook_url: null,
    webhook_sent: false,
  };
}

describe('diarized ASR routing', () => {
  it('requires both an ASR backend and the installed Sortformer model', () => {
    const asr = diarizedAsr();
    expect(supportsAsr(agent(['speech-asr-qwen3']), asr)).toBe(false);
    expect(supportsAsr(agent(['speech-asr-qwen3', 'speech-diarization-sortformer']), asr)).toBe(true);
  });
});
