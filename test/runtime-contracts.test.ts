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

  it('rejects malformed JSON text and ignores unrelated application errors', () => {
    expect(() => parseJson('{', submitJobRequestSchema)).toThrow(InvalidJsonError);
    expect(invalidJsonResponse(new Error('unrelated'))).toBeNull();
  });
});
