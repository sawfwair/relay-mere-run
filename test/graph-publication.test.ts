import { env } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { publishGraphArtifacts, mergePublications, retainedPublications, saveGraphArtifactUpload } from '../src/relay-graph-publication';
import { handleGetGraphArtifact, handleGetGraphRunManifest } from '../src/relay-api-graph';
import { graphArtifactKey, sha256Hex } from '../src/relay-graph-storage';
import type { RelayContext } from '../src/relay-context';
import type { GraphJob, GraphRunArtifact } from '../src/types';

async function fixture() {
  const bytes = new TextEncoder().encode('early image');
  const digest = await sha256Hex(bytes);
  const jobId = crypto.randomUUID();
  const artifact: GraphRunArtifact = { name: `_live-image-${digest}`, kind: 'graph.node-output',
    path: `.relay-publications/${digest}`, sha256: digest, content_type: 'image/png', size_bytes: bytes.length };
  const job = { job_id: jobId, user_id: jobId, agent_id: 'node', node_token: 'assignment', state: 'running',
    attempt: 1, artifacts: [], artifact_uploads: {}, graph: { nodes: [{ id: 'image' }] },
    job: { graph_fingerprint: 'a'.repeat(64) }, run_manifest: null } as unknown as GraphJob;
  let current = job;
  const save = vi.fn((next: GraphJob) => { current = next; return Promise.resolve(); });
  const ctx = { env, getGraphJob: () => Promise.resolve(current), saveGraphJob: save } as unknown as RelayContext;
  const manifest = { contract_version: 'mere.run/graph-run.v1', job_id: jobId,
    graph_fingerprint: 'a'.repeat(64), state: 'running', nodes: [{ id: 'image', state: 'finished', artifacts: [artifact] }] };
  const request = (artifacts = [artifact], runManifest = manifest) => new Request('https://relay/publications', {
    method: 'PUT', body: JSON.stringify({ artifacts, run_manifest: runManifest }),
  });
  const upload = async () => {
    await env.IMAGES.put(graphArtifactKey(jobId, jobId, digest), bytes, { customMetadata: { sha256: digest } });
    job.artifact_uploads[digest] = { sha256: digest, size_bytes: bytes.length, object_name: digest, part_count: 0, parts: [] };
  };
  return { job, artifact, ctx, manifest, request, upload, bytes, save };
}

describe('early graph publication', () => {
  it('serves verified media and a partial manifest while running and after failure', async () => {
    const f = await fixture();
    expect((await publishGraphArtifacts(f.ctx, f.job, f.request())).status).toBe(400);
    expect(f.job.artifacts).toEqual([]);
    await f.upload();
    expect((await publishGraphArtifacts(f.ctx, f.job, f.request())).status).toBe(200);
    expect(f.job.state).toBe('running');
    expect(f.job.artifacts).toEqual([f.artifact]);
    const manifest = await handleGetGraphRunManifest(f.ctx, f.job.job_id);
    expect(manifest.headers.get('Cache-Control')).toBe('no-store');
    expect(await manifest.json()).toMatchObject({ state: 'running', attempt: 1 });
    for (const state of ['running', 'failed', 'cancelled'] as const) {
      f.job.state = state;
      const response = await handleGetGraphArtifact(f.ctx, f.job.job_id, f.artifact.name);
      expect(response.status).toBe(200);
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(f.bytes);
    }
  });

  it('keeps immutable publications when final artifacts arrive and when retry starts', async () => {
    const f = await fixture(); await f.upload();
    await publishGraphArtifacts(f.ctx, f.job, f.request());
    const final = { ...f.artifact, name: 'image', kind: 'graph.output' };
    expect(mergePublications(f.job, [final])).toEqual([f.artifact, final]);
    f.job.artifacts.push(final);
    expect(retainedPublications(f.job)).toEqual([f.artifact]);
    f.job.state = 'failed'; f.job.agent_id = null;
    const ctx = { ...f.ctx, graphJobs: new Map(), getConnectedAgents: () => new Map(), getNodeRecords: () => Promise.resolve([]) } as unknown as RelayContext;
    // Publication retention is independent of the next worker assignment.
    expect(retainedPublications(f.job)[0].sha256).toBe(f.artifact.sha256);
    expect((await handleGetGraphArtifact(ctx, f.job.job_id, f.artifact.name)).status).toBe(200);
  });

  it.each(['finished', 'failed', 'cancelled'] as const)('rejects publication into a %s job', async (state) => {
    const f = await fixture(); await f.upload(); f.job.state = state;
    expect((await publishGraphArtifacts(f.ctx, f.job, f.request())).status).toBe(409);
    expect(f.save).not.toHaveBeenCalled();
  });

  it('rejects local custody, malformed metadata, foreign nodes, and mismatched manifests', async () => {
    const f = await fixture(); await f.upload();
    f.job.job.data_policy = 'local-custody.v1';
    expect((await publishGraphArtifacts(f.ctx, f.job, f.request())).status).toBe(403);
    f.job.job.data_policy = undefined;
    expect((await publishGraphArtifacts(f.ctx, f.job, f.request([{ ...f.artifact, path: '../private' }]))).status).toBe(400);
    expect((await publishGraphArtifacts(f.ctx, f.job, f.request([{ ...f.artifact, name: f.artifact.name.replace('image', 'foreign') }]))).status).toBe(400);
    expect((await publishGraphArtifacts(f.ctx, f.job, f.request([], { ...f.manifest, job_id: 'another-job' }))).status).toBe(400);
    expect((await publishGraphArtifacts(f.ctx, f.job, new Request('https://relay/publications', { method: 'PUT', body: 'invalid' }))).status).toBe(400);
    expect(f.save).not.toHaveBeenCalled();
  });

  it('rechecks the assignment after asynchronous upload verification', async () => {
    const f = await fixture(); await f.upload();
    const ctx = { ...f.ctx, getGraphJob: () => Promise.resolve({ ...f.job, node_token: 'next-assignment' }) } as RelayContext;
    expect((await publishGraphArtifacts(ctx, f.job, f.request())).status).toBe(409);
    expect(f.save).not.toHaveBeenCalled();
  });

  it('rejects upload completion after cancellation or reassignment', async () => {
    const f = await fixture();
    const upload = { sha256: f.artifact.sha256, size_bytes: f.bytes.length, object_name: f.artifact.sha256, part_count: 0, parts: [] };
    f.job.state = 'cancelled';
    expect(await saveGraphArtifactUpload(f.ctx, f.job.job_id, 'assignment', f.artifact, upload)).toBe(false);
    f.job.state = 'running'; f.job.node_token = 'next';
    expect(await saveGraphArtifactUpload(f.ctx, f.job.job_id, 'assignment', f.artifact, upload)).toBe(false);
    expect(f.save).not.toHaveBeenCalled();
  });

  it('does not serve a previous attempt manifest before a retry publishes', async () => {
    const f = await fixture(); f.job.attempt = 2;
    expect((await handleGetGraphRunManifest(f.ctx, f.job.job_id)).status).toBe(404);
  });
});
