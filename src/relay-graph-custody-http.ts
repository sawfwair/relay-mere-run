import type { RelayContext } from './relay-context';
import type { GraphJob, GraphRunArtifact } from './types';
import { custodyArtifactAllowed, hasLocalCustody, MAX_CUSTODY_DOCUMENT_BYTES, purgeGraphPayload,
  sanitizedReportBytes, sanitizedRunManifest } from './relay-graph-custody';
import { graphBundleObject, sha256Hex, storeGraphArtifact, verifiedGraphArtifactUpload } from './relay-graph-storage';
import { enforceGraphArtifactQuota, recordGraphTelemetry } from './relay-graph-operations';

function reply(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

async function activeAssignment(ctx: RelayContext, jobId: string, token: string, requireAck: boolean): Promise<GraphJob | null> {
  const job = await ctx.getGraphJob(jobId);
  if (!job || job.node_token !== token || !job.agent_id
      || !['assigned', 'preflighting', 'running'].includes(job.state)) return null;
  return requireAck && !job.payload_delivered_at ? null : job;
}

async function boundedBody(request: Request): Promise<Uint8Array | null> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const result: ReadableStreamReadResult<unknown> = await reader.read();
    if (result.done) break;
    const value = result.value;
    if (!(value instanceof Uint8Array)) { await reader.cancel(); return null; }
    size += value.byteLength;
    if (size > MAX_CUSTODY_DOCUMENT_BYTES) { await reader.cancel(); return null; }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

async function jsonBody(request: Request): Promise<Record<string, unknown> | null> {
  const bytes = await boundedBody(request);
  if (!bytes) return null;
  try {
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}

async function acknowledgeBundle(ctx: RelayContext, job: GraphJob, request: Request): Promise<Response> {
  const token = job.node_token;
  const body = await jsonBody(request);
  if (!body || body.request_sha256 !== job.request_sha256) return reply({ code: 'BUNDLE_ACK_MISMATCH' }, 409);
  const current = await activeAssignment(ctx, job.job_id, token, false);
  if (!current) return reply({ code: 'BUNDLE_ACK_NOT_ASSIGNED' }, 409);
  current.payload_delivered_at ??= new Date().toISOString();
  purgeGraphPayload(current);
  await ctx.saveGraphJob(current);
  return reply({ acknowledged: true, request_sha256: job.request_sha256 });
}

async function uploadReport(ctx: RelayContext, job: GraphJob, name: string, request: Request): Promise<Response> {
  const token = job.node_token;
  const artifact: GraphRunArtifact = {
    name, kind: request.headers.get('X-Artifact-Kind') || '', path: request.headers.get('X-Artifact-Path') || '',
    content_type: request.headers.get('Content-Type') || '', size_bytes: Number(request.headers.get('X-Artifact-Size')),
    sha256: request.headers.get('X-Artifact-Sha256') || '',
  };
  if (!custodyArtifactAllowed(job, artifact) || request.headers.has('X-Artifact-Part-Index') || request.headers.has('X-Artifact-Part-Count')) {
    return reply({ code: 'LOCAL_CUSTODY_ARTIFACT_DENIED' }, 403);
  }
  const bytes = await boundedBody(request);
  if (!bytes || bytes.byteLength !== artifact.size_bytes || await sha256Hex(bytes) !== artifact.sha256
    || !sanitizedReportBytes(bytes)) return reply({ code: 'LOCAL_CUSTODY_REPORT_INVALID' }, 400);
  return storeReportForAssignment(ctx, job.job_id, token, artifact, bytes);
}

async function storeReportForAssignment(ctx: RelayContext, jobId: string, token: string,
  artifact: GraphRunArtifact, bytes: Uint8Array): Promise<Response> {
  const assigned = await activeAssignment(ctx, jobId, token, true);
  if (!assigned) return reply({ code: 'EXECUTION_NOT_ASSIGNED' }, 409);
  const quota = await enforceGraphArtifactQuota(ctx, assigned, artifact.sha256, bytes.byteLength);
  if (quota) return quota;
  const current = await activeAssignment(ctx, jobId, token, true);
  if (!current) return reply({ code: 'EXECUTION_NOT_ASSIGNED' }, 409);
  await storeGraphArtifact(ctx, current, artifact, bytes.buffer as ArrayBuffer);
  const latest = await activeAssignment(ctx, jobId, token, true);
  if (!latest) return reply({ code: 'EXECUTION_NOT_ASSIGNED' }, 409);
  latest.artifact_uploads[artifact.sha256] = {
    sha256: artifact.sha256, size_bytes: artifact.size_bytes, object_name: artifact.sha256, part_count: 0, parts: [],
  };
  await ctx.saveGraphJob(latest);
  await recordGraphTelemetry(ctx, { artifact_bytes_received: bytes.byteLength });
  return reply({ stored: true, name: artifact.name });
}

export async function handleCustodyNodeRequest(
  ctx: RelayContext, job: GraphJob, action: string, request: Request,
): Promise<Response | null> {
  if (!hasLocalCustody(job)) return null;
  if (['finished', 'failed', 'cancelled'].includes(job.state)) return reply({ code: 'EXECUTION_TERMINAL' }, 410);
  if (!job.agent_id || !['assigned', 'preflighting', 'running'].includes(job.state)) {
    return reply({ code: 'EXECUTION_NOT_ASSIGNED' }, 409);
  }
  if (action === 'bundle-ack' && request.method === 'POST') return acknowledgeBundle(ctx, job, request);
  if (action.startsWith('bundle/') && request.method === 'GET') {
    const object = await graphBundleObject(ctx, job, decodeURIComponent(action.slice(7)));
    if (!object) return reply({ code: 'BUNDLE_UNAVAILABLE' }, 410);
    return new Response(object.body, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  }
  if (!job.payload_delivered_at) return reply({ code: 'BUNDLE_ACK_REQUIRED' }, 409);
  return handleCustodyOutput(ctx, job, action, request);
}

async function handleCustodyOutput(ctx: RelayContext, job: GraphJob, action: string, request: Request): Promise<Response> {
  if (action === 'run-manifest' && request.method === 'PUT') {
    const token = job.node_token;
    const body = await jsonBody(request);
    const manifest = body && sanitizedRunManifest(job, body);
    if (!manifest) return reply({ code: 'LOCAL_CUSTODY_MANIFEST_INVALID' }, 400);
    const current = await activeAssignment(ctx, job.job_id, token, true);
    if (!current) return reply({ code: 'EXECUTION_NOT_ASSIGNED' }, 409);
    current.run_manifest = manifest;
    await ctx.saveGraphJob(current);
    return reply({ stored: true });
  }
  if (action.startsWith('artifact-uploads/') && request.method === 'GET') {
    const upload = await verifiedGraphArtifactUpload(ctx, job, action.slice('artifact-uploads/'.length));
    return upload ? reply(upload) : reply({ code: 'ARTIFACT_NOT_FOUND' }, 404);
  }
  if (action.startsWith('artifacts/') && request.method === 'PUT') {
    return uploadReport(ctx, job, decodeURIComponent(action.slice(10)), request);
  }
  return reply({ code: 'LOCAL_CUSTODY_OPERATION_DENIED' }, 403);
}
