import { z } from 'zod';
import { parseJson, readRequestJson } from './json';
import { runManifestSchema } from './contracts/graph';
import type { RelayContext } from './relay-context';
import type { GraphArtifactUpload, GraphJob, GraphRunArtifact } from './types';
import { hasLocalCustody } from './relay-graph-custody';
import { graphRunManifestKey, hasStoredGraphArtifact } from './relay-graph-storage';

const artifactSchema = z.object({
  name: z.string().max(160).regex(/^_live-[a-z][a-z0-9-]*-[a-f0-9]{64}$/u),
  kind: z.enum(['graph.node-output', 'graph.preview']),
  path: z.string().regex(/^\.relay-publications\/[a-f0-9]{64}$/u),
  content_type: z.string().min(1).max(200),
  size_bytes: z.number().int().nonnegative().safe(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
});
const publicationSchema = z.object({
  artifacts: z.array(artifactSchema).max(512),
  run_manifest: z.record(z.string(), z.unknown()),
});

export function isPublishedArtifact(artifact: GraphRunArtifact): boolean {
  return artifact.name.startsWith('_live-')
    && ['graph.node-output', 'graph.preview'].includes(artifact.kind);
}

export function retainedPublications(job: GraphJob): GraphRunArtifact[] {
  return hasLocalCustody(job) ? [] : job.artifacts.filter(isPublishedArtifact);
}

export function mergePublications(job: GraphJob, artifacts: GraphRunArtifact[]): GraphRunArtifact[] {
  return [...new Map([...retainedPublications(job), ...artifacts].map((item) => [item.name, item])).values()];
}

function active(job: GraphJob, token: string): boolean {
  return job.node_token === token && !!job.agent_id && ['assigned', 'preflighting', 'running'].includes(job.state);
}

function validManifest(job: GraphJob, manifest: Record<string, unknown>): boolean {
  return manifest.contract_version === 'mere.run/graph-run.v1' && manifest.job_id === job.job_id
    && manifest.graph_fingerprint === job.job.graph_fingerprint;
}

function validPublication(job: GraphJob, artifact: GraphRunArtifact): boolean {
  return artifact.path === `.relay-publications/${artifact.sha256}`
    && job.graph.nodes.some((node) => artifact.name === `_live-${node.id}-${artifact.sha256}`);
}

export async function publishGraphArtifacts(ctx: RelayContext, job: GraphJob, request: Request): Promise<Response> {
  if (hasLocalCustody(job)) return Response.json({ error: 'Early media is unavailable for local-custody jobs' }, { status: 403 });
  const token = job.node_token;
  if (!active(job, token)) return Response.json({ error: 'Graph assignment is not active' }, { status: 409 });
  const publication = await readRequestJson(request, publicationSchema).catch(() => null);
  if (!publication || !validManifest(job, publication.run_manifest)) {
    return Response.json({ error: 'Invalid graph publication' }, { status: 400 });
  }
  for (const artifact of publication.artifacts) {
    if (!validPublication(job, artifact) || !await hasStoredGraphArtifact(ctx, job, artifact)) {
      return Response.json({ error: 'Graph publication contains an unverified artifact' }, { status: 400 });
    }
  }
  // Upload verification yields. Recheck assignment and terminal state before
  // making anything visible; an earlier attempt cannot publish into a retry.
  const current = await ctx.getGraphJob(job.job_id);
  if (!current || !active(current, token)) return Response.json({ error: 'Graph assignment changed' }, { status: 409 });
  const artifacts = mergePublications(current, publication.artifacts);
  if (artifacts.length > 2048) return Response.json({ error: 'Graph publication limit reached' }, { status: 409 });
  current.artifacts = artifacts;
  current.run_manifest = { ...publication.run_manifest, attempt: current.attempt };
  current.updated_at = new Date().toISOString();
  await ctx.saveGraphJob(current);
  return Response.json({ stored: true }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function handlePublicGraphPublication(ctx: RelayContext, job: GraphJob, action: string, request: Request): Promise<Response | null> {
  if (request.method !== 'PUT') return null;
  if (action === 'publications') return publishGraphArtifacts(ctx, job, request);
  if (action !== 'run-manifest') return null;
  const body = await request.text();
  const manifest = ((): Record<string, unknown> | null => { try { return parseJson(body, runManifestSchema); } catch { return null; } })();
  if (!manifest) return Response.json({ error: 'Invalid run manifest JSON' }, { status: 400 });
  job.run_manifest = manifest;
  await ctx.env.IMAGES.put(graphRunManifestKey(job.user_id, job.job_id), body, { httpMetadata: { contentType: 'application/json' } });
  await ctx.saveGraphJob(job);
  return Response.json({ stored: true });
}

export async function saveGraphArtifactUpload(
  ctx: RelayContext, jobId: string, token: string, artifact: GraphRunArtifact, upload: GraphArtifactUpload,
): Promise<boolean> {
  const current = await ctx.getGraphJob(jobId);
  if (!current || current.node_token !== token) return false;
  if (isPublishedArtifact(artifact) && !active(current, token)) return false;
  current.artifact_uploads ??= {};
  current.artifact_uploads[artifact.sha256] = upload;
  await ctx.saveGraphJob(current);
  return true;
}
