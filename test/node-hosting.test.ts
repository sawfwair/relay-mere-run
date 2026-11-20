import { describe, expect, it } from 'vitest';
import { agentCapabilitiesSchema } from '../src/contracts/agent';
const base = { models: [], max_resolution: 2048, controlnet: false, lora: false, img2img: false };
describe('owner-declared node hosting', () => {
  it('preserves explicit declaration and leaves old inventory unknown', () => {
    expect(agentCapabilitiesSchema.parse(base).hosting).toBeUndefined();
    expect(agentCapabilitiesSchema.parse({ ...base, hosting: { kind: 'runpod', source: 'owner-declared', label: 'My GPU' } }).hosting).toEqual({ kind: 'runpod', source: 'owner-declared', label: 'My GPU' });
  });
  it('rejects unsupported provenance, arbitrary fields, and unbounded labels', () => {
    for (const hosting of [{ kind: 'runpod', source: 'verified' }, { kind: 'linux', source: 'owner-declared' }, { kind: 'runpod', source: 'owner-declared', token: 'secret' }, { kind: 'runpod', source: 'owner-declared', label: 'x'.repeat(81) }]) {
      expect(agentCapabilitiesSchema.safeParse({ ...base, hosting }).success).toBe(false);
    }
  });
});
