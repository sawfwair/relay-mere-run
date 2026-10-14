import type { RelayContext } from './relay-context';
import { GRAPH_MAINTENANCE_ALARM_KEY, scheduleNextRelayAlarm } from './relay-alarm';
import { releaseAgent, resetGraphAttempt } from './relay-lifecycle';
import { buildGraphReceipt } from './relay-receipts';
import type { GraphJob, SubmitGraphJobRequest } from './types';
import { listBatches, pruneBatches, storedBatchItems } from './relay-batch-state';
import { storedGraphJobs } from './relay-graph-record';

const TERMINAL_GRAPH_STATES = new Set(['finished', 'failed', 'cancelled']);
const ACTIVE_GRAPH_STATES = new Set(['planned', 'preflighting', 'queued', 'assigned', 'running']);
const GRAPH_TELEMETRY_KEY = 'graph-telemetry';

export interface GraphRelayTelemetry {
  submissions: number;
  quota_rejections: number;
  artifact_bytes_received: number;
  artifact_parts_received: number;
  resumed_parts_reported: number;
  stale_jobs_requeued: number;
  stale_jobs_failed: number;
  retained_jobs_deleted: number;
  r2_objects_deleted: number;
  r2_bytes_deleted: number;
  last_maintenance_at: string | null;
}

interface GraphLimits {
  maxActiveJobs: number;
  maxAccountStorageBytes: number;
  maxJobInputBytes: number;
  maxJobOutputBytes: number;
  retentionMilliseconds: number;
  staleMilliseconds: number;
  maintenanceIntervalMilliseconds: number;
}

function positiveInteger(value: string | undefined, fallback: number, maximum: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

function limits(ctx: RelayContext): GraphLimits {
  return {
    maxActiveJobs: positiveInteger(ctx.env.GRAPH_MAX_ACTIVE_JOBS, 20, 10_000),
    maxAccountStorageBytes: positiveInteger(
      ctx.env.GRAPH_MAX_ACCOUNT_STORAGE_BYTES,
      100 * 1024 ** 3,
      Number.MAX_SAFE_INTEGER,
    ),
    maxJobInputBytes: positiveInteger(
      ctx.env.GRAPH_MAX_JOB_INPUT_BYTES,
      50 * 1024 ** 3,
      Number.MAX_SAFE_INTEGER,
    ),
    maxJobOutputBytes: positiveInteger(
      ctx.env.GRAPH_MAX_JOB_OUTPUT_BYTES,
      50 * 1024 ** 3,
      Number.MAX_SAFE_INTEGER,
    ),
    retentionMilliseconds: positiveInteger(ctx.env.GRAPH_JOB_RETENTION_DAYS, 30, 3_650) * 24 * 60 * 60 * 1_000,
    staleMilliseconds: positiveInteger(ctx.env.GRAPH_STALE_JOB_SECONDS, 21_600, 604_800) * 1_000,
    maintenanceIntervalMilliseconds: positiveInteger(
      ctx.env.GRAPH_MAINTENANCE_INTERVAL_SECONDS,
      900,
      86_400,
    ) * 1_000,
  };
}

function graphAssetsPrefix(userId: string): string {
  return `graph-assets/${encodeURIComponent(userId)}/`;
}

function graphJobsPrefix(userId: string): string {
  return `graph-jobs/${encodeURIComponent(userId)}/`;
}

async function listR2Objects(ctx: RelayContext, prefix: string): Promise<R2Object[]> {
  const objects: R2Object[] = [];
  let cursor: string | undefined;
  do {
    const page = await ctx.env.IMAGES.list({ prefix, cursor });
    objects.push(...page.objects);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return objects;
}

async function deleteR2Objects(ctx: RelayContext, objects: R2Object[]): Promise<void> {
  for (let index = 0; index < objects.length; index += 1_000) {
    await ctx.env.IMAGES.delete(objects.slice(index, index + 1_000).map((object) => object.key));
  }
}

function uniqueAssetSizes(jobs: Iterable<GraphJob>, extra?: SubmitGraphJobRequest): Map<string, number> {
  const sizes = new Map<string, number>();
  for (const job of jobs) {
    for (const entry of job.assets.groups.flatMap((group) => group.entries)) {
      sizes.set(entry.digest, entry.size_bytes);
    }
  }
  if (extra) {
    for (const entry of extra.assets.groups.flatMap((group) => group.entries)) {
      sizes.set(entry.digest, entry.size_bytes);
    }
  }
  return sizes;
}

async function graphStorageInventory(ctx: RelayContext): Promise<{ activeCount: number; assetSizes: Map<string, number> }> {
  let activeCount = 0;
  const assetSizes = new Map<string, number>();
  for await (const job of storedGraphJobs(ctx.storage)) {
    if (ACTIVE_GRAPH_STATES.has(job.state)) activeCount += 1;
    for (const entry of job.assets.groups.flatMap((group) => group.entries)) {
      assetSizes.set(entry.digest, Math.max(assetSizes.get(entry.digest) ?? 0, entry.size_bytes));
    }
  }
  return { activeCount, assetSizes };
}

function quotaResponse(
  code: string,
  message: string,
  status: number,
  detail: Record<string, number>,
): Response {
  return Response.json({ error: message, code, ...detail }, { status });
}

export async function enforceGraphSubmissionQuotas(
  ctx: RelayContext,
  body: SubmitGraphJobRequest,
  userId: string,
  batchOnly = false,
  extraMetadataBytes = 0,
): Promise<Response | null> {
  const configured = limits(ctx);
  const inventory = await graphStorageInventory(ctx);
  const activeCount = inventory.activeCount;
  if (!batchOnly && activeCount >= configured.maxActiveJobs) {
    await recordGraphTelemetry(ctx, { quota_rejections: 1 });
    return quotaResponse(
      'graph_active_job_quota',
      'The relay account has reached its active graph job limit.',
      429,
      { active_jobs: activeCount, limit: configured.maxActiveJobs },
    );
  }

  const inputSizes = uniqueAssetSizes([], body);
  const inputBytes = [...inputSizes.values()].reduce((total, size) => total + size, 0);
  if (inputBytes > configured.maxJobInputBytes) {
    await recordGraphTelemetry(ctx, { quota_rejections: 1 });
    return quotaResponse(
      'graph_job_input_quota',
      'The graph job exceeds the portable input limit.',
      413,
      { requested_bytes: inputBytes, limit_bytes: configured.maxJobInputBytes },
    );
  }

  const assetObjects = await listR2Objects(ctx, graphAssetsPrefix(userId));
  const jobObjects = await listR2Objects(ctx, graphJobsPrefix(userId));
  const storedAssetDigests = new Set(assetObjects.map((object) => object.key.split('/').at(-1) || ''));
  const reservedAssets = inventory.assetSizes;
  for (const [digest, size] of uniqueAssetSizes([], body)) reservedAssets.set(digest, Math.max(reservedAssets.get(digest) ?? 0, size));
  let metadataBytes = 0;
  for await (const item of storedBatchItems(ctx.storage)) {
    metadataBytes += new TextEncoder().encode(JSON.stringify(item)).length;
    for (const entry of item.submission.assets.groups.flatMap((group) => group.entries)) {
      reservedAssets.set(entry.digest, Math.max(reservedAssets.get(entry.digest) ?? 0, entry.size_bytes));
    }
  }
  const reservedBytes = [...reservedAssets]
    .filter(([digest]) => !storedAssetDigests.has(digest))
    .reduce((total, [, size]) => total + size, 0);
  const storedBytes = [...assetObjects, ...jobObjects].reduce((total, object) => total + object.size, 0);
  const projectedBytes = storedBytes + reservedBytes + metadataBytes + extraMetadataBytes;
  if (projectedBytes > configured.maxAccountStorageBytes) {
    await recordGraphTelemetry(ctx, { quota_rejections: 1 });
    return quotaResponse(
      'graph_account_storage_quota',
      'The relay account would exceed its graph storage quota.',
      507,
      { projected_bytes: projectedBytes, limit_bytes: configured.maxAccountStorageBytes },
    );
  }
  return null;
}

export async function enforceGraphBatchQuotas(
  ctx: RelayContext, bodies: SubmitGraphJobRequest[], userId: string,
): Promise<Response | null> {
  const configured = limits(ctx);
  const encodeSize = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).length;
  let metadataBytes = 0;
  for await (const item of storedBatchItems(ctx.storage)) metadataBytes += encodeSize(item.submission) + 1024;
  const newMetadataBytes = bodies.reduce((sum, body) => sum + encodeSize(body) + 1024, 0);
  if (metadataBytes + newMetadataBytes > 16 * 1024 * 1024) {
    return quotaResponse('batch_manifest_quota', 'Account batch manifests exceed 16 MiB', 429,
      { requested_bytes: metadataBytes + newMetadataBytes, limit_bytes: 16 * 1024 * 1024 });
  }
  for (const body of bodies) {
    const bytes = [...uniqueAssetSizes([], body).values()].reduce((sum, size) => sum + size, 0);
    if (bytes > configured.maxJobInputBytes) return quotaResponse('graph_job_input_quota', 'Batch child exceeds input quota', 413,
      { requested_bytes: bytes, limit_bytes: configured.maxJobInputBytes });
  }
  const union = { ...bodies[0], assets: { schema_version: 1, groups: bodies.flatMap((body) => body.assets.groups) } };
  const proxy: RelayContext = { ...ctx, env: { ...ctx.env, GRAPH_MAX_JOB_INPUT_BYTES: String(configured.maxAccountStorageBytes) } };
  return enforceGraphSubmissionQuotas(proxy, union, userId, true, newMetadataBytes);
}

export async function enforceGraphArtifactQuota(
  ctx: RelayContext,
  job: GraphJob,
  digest: string,
  sizeBytes: number,
): Promise<Response | null> {
  const configured = limits(ctx);
  if (job.artifact_uploads?.[digest]) return null;
  const outputBytes = Object.values(job.artifact_uploads ?? {})
    .reduce((total, upload) => total + upload.size_bytes, 0) + sizeBytes;
  if (outputBytes > configured.maxJobOutputBytes) {
    await recordGraphTelemetry(ctx, { quota_rejections: 1 });
    return quotaResponse(
      'graph_job_output_quota',
      'The graph job exceeds its output storage limit.',
      413,
      { projected_bytes: outputBytes, limit_bytes: configured.maxJobOutputBytes },
    );
  }
  const [assetObjects, jobObjects] = await Promise.all([
    listR2Objects(ctx, graphAssetsPrefix(job.user_id)),
    listR2Objects(ctx, graphJobsPrefix(job.user_id)),
  ]);
  const storedBytes = [...assetObjects, ...jobObjects].reduce((total, object) => total + object.size, 0);
  if (storedBytes + sizeBytes > configured.maxAccountStorageBytes) {
    await recordGraphTelemetry(ctx, { quota_rejections: 1 });
    return quotaResponse(
      'graph_account_storage_quota',
      'The relay account would exceed its graph storage quota.',
      507,
      { projected_bytes: storedBytes + sizeBytes, limit_bytes: configured.maxAccountStorageBytes },
    );
  }
  return null;
}

export async function scheduleGraphMaintenance(ctx: RelayContext, now = Date.now()): Promise<void> {
  const next = now + limits(ctx).maintenanceIntervalMilliseconds;
  await ctx.storage.put(GRAPH_MAINTENANCE_ALARM_KEY, next);
  await scheduleNextRelayAlarm(ctx);
}

export async function handleGraphMaintenanceAlarm(ctx: RelayContext, now = Date.now()): Promise<void> {
  const scheduled = await ctx.storage.get<number>(GRAPH_MAINTENANCE_ALARM_KEY);
  if (scheduled === undefined || scheduled > now) return;
  const configured = limits(ctx);
  const cutoff = now - configured.retentionMilliseconds;
  await pruneBatches(ctx, cutoff);
  const batchIDs = new Set((await listBatches(ctx)).map((batch) => batch.batch_id));
  const digests = new Set<string>();
  const stats = { stale_jobs_requeued: 0, stale_jobs_failed: 0, retained_jobs_deleted: 0, r2_objects_deleted: 0, r2_bytes_deleted: 0 };
  let owner = ctx.userId;
  for await (const job of storedGraphJobs(ctx.storage)) {
    owner ||= job.user_id;
    const recovery = await reconcileStaleGraph(ctx, job, now, configured.staleMilliseconds);
    if (recovery === 'queued') stats.stale_jobs_requeued += 1;
    if (recovery === 'failed') stats.stale_jobs_failed += 1;
    if (retainGraphJob(job, batchIDs, cutoff)) {
      for (const digest of uniqueAssetSizes([job]).keys()) digests.add(digest);
    } else {
      const objects = await listR2Objects(ctx, `${graphJobsPrefix(job.user_id)}${job.job_id}/`);
      stats.r2_objects_deleted += objects.length;
      stats.r2_bytes_deleted += objects.reduce((sum, object) => sum + object.size, 0);
      await deleteR2Objects(ctx, objects);
      await ctx.storage.delete(`graph:${job.job_id}`);
      ctx.graphJobs.delete(job.job_id);
      stats.retained_jobs_deleted += 1;
    }
  }
  await retainBatchAssetDigests(ctx, digests);
  const assets = owner ? await listR2Objects(ctx, graphAssetsPrefix(owner)) : [];
  const expired = assets.filter((object) => !digests.has(object.key.split('/').at(-1) || '') && object.uploaded.getTime() < cutoff);
  stats.r2_objects_deleted += expired.length;
  stats.r2_bytes_deleted += expired.reduce((sum, object) => sum + object.size, 0);
  await deleteR2Objects(ctx, expired);
  await recordGraphTelemetry(ctx, { ...stats, last_maintenance_at: new Date(now).toISOString() });
  await ctx.assignQueuedWork();
  await rescheduleGraphMaintenance(ctx, now);
}

async function reconcileStaleGraph(ctx: RelayContext, job: GraphJob, now: number, staleMilliseconds: number): Promise<'queued' | 'failed' | null> {
  if (!['assigned', 'running', 'preflighting'].includes(job.state) || now - Date.parse(job.updated_at) <= staleMilliseconds) return null;
  cancelStaleAssignment(ctx, job);
  job.agent_id = null; job.assigned_at = null; job.started_at = null; job.updated_at = new Date(now).toISOString();
  if (job.attempt < job.max_attempts) {
    resetGraphAttempt(job); job.state = 'queued'; job.error = null; job.assigned_device_id = undefined;
  } else {
    job.state = 'failed'; job.error = 'Graph job became stale while assigned to a worker'; job.completed_at = job.updated_at;
    job.execution_receipt = await buildGraphReceipt(job, 'failed', job.completed_at, { error: job.error });
  }
  await ctx.saveGraphJob(job);
  if (job.state === 'failed') await ctx.scheduleGraphWebhookIfNeeded(job);
  return job.state;
}

function retainGraphJob(job: GraphJob, batchIDs: Set<string>, cutoff: number): boolean {
  return !!(job.batch_id && batchIDs.has(job.batch_id)) || !TERMINAL_GRAPH_STATES.has(job.state)
    || !job.completed_at || Date.parse(job.completed_at) >= cutoff;
}

function cancelStaleAssignment(ctx: RelayContext, job: GraphJob): void {
  if (!job.agent_id) return;
  const agent = ctx.getConnectedAgents().get(job.agent_id);
  try {
    agent?.ws.send(JSON.stringify({ type: 'graph_cancel', job_id: job.job_id }));
    if (job.batch_id) agent?.ws.close(4002, 'Graph assignment became stale');
  } catch { /* disconnect handling reconciles the assignment */ }
  if (!job.batch_id) releaseAgent(ctx, job.agent_id);
}

async function rescheduleGraphMaintenance(ctx: RelayContext, now: number): Promise<void> {
  const graphs = await ctx.storage.list({ prefix: 'graph:', limit: 1 });
  const batches = await ctx.storage.list({ prefix: 'batch:', limit: 1 });
  if (graphs.size || batches.size) await scheduleGraphMaintenance(ctx, now);
  else {
    await ctx.storage.delete(GRAPH_MAINTENANCE_ALARM_KEY);
    await scheduleNextRelayAlarm(ctx);
  }
}

export async function graphRelayTelemetry(ctx: RelayContext): Promise<GraphRelayTelemetry> {
  return (await ctx.storage.get<GraphRelayTelemetry>(GRAPH_TELEMETRY_KEY)) ?? emptyTelemetry();
}

export async function recordGraphTelemetry(
  ctx: RelayContext,
  increments: Partial<GraphRelayTelemetry>,
): Promise<void> {
  const current = await graphRelayTelemetry(ctx);
  const next = { ...current };
  const counters = [
    'submissions',
    'quota_rejections',
    'artifact_bytes_received',
    'artifact_parts_received',
    'resumed_parts_reported',
    'stale_jobs_requeued',
    'stale_jobs_failed',
    'retained_jobs_deleted',
    'r2_objects_deleted',
    'r2_bytes_deleted',
  ] as const;
  for (const key of counters) {
    next[key] += increments[key] ?? 0;
  }
  if (increments.last_maintenance_at !== undefined) {
    next.last_maintenance_at = increments.last_maintenance_at;
  }
  await ctx.storage.put(GRAPH_TELEMETRY_KEY, next);
}

function emptyTelemetry(): GraphRelayTelemetry {
  return {
    submissions: 0,
    quota_rejections: 0,
    artifact_bytes_received: 0,
    artifact_parts_received: 0,
    resumed_parts_reported: 0,
    stale_jobs_requeued: 0,
    stale_jobs_failed: 0,
    retained_jobs_deleted: 0,
    r2_objects_deleted: 0,
    r2_bytes_deleted: 0,
    last_maintenance_at: null,
  };
}

async function retainBatchAssetDigests(ctx: RelayContext, digests: Set<string>): Promise<void> {
  for await (const item of storedBatchItems(ctx.storage)) {
    for (const entry of item.submission.assets.groups.flatMap((group) => group.entries)) digests.add(entry.digest);
  }
}
