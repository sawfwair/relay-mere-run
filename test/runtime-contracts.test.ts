import { describe, expect, it } from 'vitest';
import { agentMessageSchema } from '../src/contracts/agent';
import { submitGraphJobRequestSchema } from '../src/contracts/graph';
import { submitJobRequestSchema } from '../src/contracts/requests';
import { InvalidJsonError, invalidJsonResponse, parseJson, readRequestJson } from '../src/json';

describe('runtime JSON contracts', () => {
  it('preserves forward-compatible request fields while validating required values', async () => {
    const request = new Request('https://relay/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'hello', future_option: { enabled: true } }),
    });

    await expect(readRequestJson(request, submitJobRequestSchema)).resolves.toMatchObject({
      prompt: 'hello',
      future_option: { enabled: true },
    });
  });

  it('turns a wrong external request shape into an actionable 400 response', async () => {
    const request = new Request('https://relay/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 42 }),
    });

    let caught: unknown;
    try {
      await readRequestJson(request, submitJobRequestSchema);
    } catch (error) {
      caught = error;
    }

    const response = invalidJsonResponse(caught);
    expect(response?.status).toBe(400);
    await expect(response?.json()).resolves.toMatchObject({ error: 'Invalid JSON payload' });
  });

  it('validates end-keyframe requests without silently dropping conditioning', () => {
    expect(submitJobRequestSchema.parse({
      kind: 'video',
      prompt: 'land on the final frame',
      input_image_url: 'https://assets.example/start.png',
      end_image_url: 'https://assets.example/end.png',
      end_image_strength: 0.85,
    })).toMatchObject({
      end_image_url: 'https://assets.example/end.png',
      end_image_strength: 0.85,
    });

    expect(() => submitJobRequestSchema.parse({
      kind: 'video',
      prompt: 'missing start frame',
      end_image_url: 'https://assets.example/end.png',
    })).toThrow(/requires input_image_url or input_image_data/u);
    expect(() => submitJobRequestSchema.parse({
      kind: 'video',
      prompt: 'missing end frame',
      input_image_url: 'https://assets.example/start.png',
      end_image_strength: 0.5,
    })).toThrow(/requires end_image_url/u);
    expect(() => submitJobRequestSchema.parse({
      kind: 'video',
      prompt: 'invalid strength',
      input_image_url: 'https://assets.example/start.png',
      end_image_url: 'https://assets.example/end.png',
      end_image_strength: 1.1,
    })).toThrow();
  });

  it('rejects malformed nested graph documents before queue state is touched', () => {
    expect(() => submitGraphJobRequestSchema.parse({
      job: { contract_version: 'mere.run/job-bundle.v1' },
      graph: { nodes: 'not-an-array' },
      inputs: {},
      assets: { schema_version: 1, groups: [] },
    })).toThrow();
  });

  it('rejects agent messages with a known discriminator and an invalid payload', () => {
    expect(() => agentMessageSchema.parse({
      type: 'progress',
      job_id: 'job-1',
      step: 'halfway',
      total_steps: 10,
    })).toThrow();
  });

  it('accepts typed Node OCR and structured batch-ASR responses', () => {
    expect(agentMessageSchema.parse({
      type: 'ocr_response',
      ocr_id: 'ocr-1',
      owner_user_id: 'user-1',
      text: '# Scanned heading',
      tokens_generated: 0,
    })).toMatchObject({ type: 'ocr_response', text: '# Scanned heading' });

    expect(agentMessageSchema.parse({
      type: 'asr_response',
      asr_id: 'asr-1',
      owner_user_id: 'user-1',
      text: 'Clean transcript.',
      language: 'en',
      duration_seconds: 2.64,
      sentence_alignments: [{
        text: 'Clean transcript.',
        start_seconds: 0,
        duration_seconds: 2.64,
        end_seconds: 2.64,
        tokens: [],
      }],
      speaker_segments: [{
        speaker: 'speaker_0',
        speaker_index: 0,
        start_seconds: 0,
        end_seconds: 2.64,
        duration_seconds: 2.64,
      }],
    })).toMatchObject({
      type: 'asr_response',
      sentence_alignments: [{ text: 'Clean transcript.' }],
      speaker_segments: [{ speaker: 'speaker_0' }],
    });
  });

  it('rejects malformed JSON text and ignores unrelated application errors', () => {
    expect(() => parseJson('{', submitJobRequestSchema)).toThrow(InvalidJsonError);
    expect(invalidJsonResponse(new Error('unrelated'))).toBeNull();
  });
});
