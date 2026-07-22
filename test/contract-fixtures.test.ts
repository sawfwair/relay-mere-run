import { describe, expect, it } from 'vitest';
import compatibility from './fixtures/graph-v1/graph-compatibility.v1.json';
import assets from './fixtures/graph-v1/parallel-image-video.assets.json';
import inputs from './fixtures/graph-v1/parallel-image-video.inputs.json';
import graph from './fixtures/graph-v1/parallel-image-video.workflow.json';

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
}

async function sha256(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

describe('cross-runtime graph contract fixtures', () => {
  it('matches the canonical Swift and Python fingerprints', async () => {
    expect(compatibility.kind).toBe('mere.run/graph-compatibility');
    expect(graph.nodes.map((node) => node.id)).toEqual(compatibility.canonical_fixture.execution_order);
    expect(await sha256(graph)).toBe(compatibility.canonical_fixture.graph_fingerprint);
    expect(await sha256({ inputs, assets })).toBe(compatibility.canonical_fixture.input_fingerprint);
  });
});
