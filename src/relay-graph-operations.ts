import type { RelayContext } from './relay-context';
import { GRAPH_MAINTENANCE_ALARM_KEY, scheduleNextRelayAlarm } from './relay-alarm';
import { releaseAgent } from './relay-lifecycle';
import { buildGraphReceipt } from './relay-receipts';
import type { GraphJob, SubmitGraphJobRequest } from './types';

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
): Promise<Response | null> {
  const configured = limits(ctx);
  const jobs = [...(await ctx.storage.list<GraphJob>({ prefix: 'graph:' })).values()];
  const activeCount = jobs.filter((job) => ACTIVE_GRAPH_STATES.has(job.state)).length;
  if (activeCount >= configured.maxActiveJobs) {
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
  const reservedAssets = uniqueAssetSizes(jobs, body);
  const reservedBytes = [...reservedAssets]
    .filter(([digest]) => !storedAssetDigests.has(digest))
    .reduce((total, [, size]) => total + size, 0);
  const storedBytes = [...assetObjects, ...jobObjects].reduce((total, object) => total + object.size, 0);
  const projectedBytes = storedBytes + reservedBytes;
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
  const stored = await ctx.storage.list<GraphJob>({ prefix: 'graph:' });
  const jobs = [...stored.values()];
  let staleJobsRequeued = 0;
  let staleJobsFailed = 0;
  for (const job of jobs) {
    if (!['assigned', 'running', 'preflighting'].includes(job.state)) continue;
    if (now - Date.parse(job.updated_at) <= configured.staleMilliseconds) continue;
    if (job.agent_id) {
      const agent = ctx.getConnectedAgents().get(job.agent_id);
      try { agent?.ws.send(JSON.stringify({ type: 'graph_cancel', job_id: job.job_id })); } catch { /* reconnect cleanup follows */ }
      releaseAgent(ctx, job.agent_id);
    }
    job.agent_id = null;
    job.assigned_at = null;
    job.started_at = null;
    job.updated_at = new Date(now).toISOString();
    if (job.attempt < job.max_attempts) {
      job.state = 'queued';
      job.error = null;
      job.assigned_device_id = undefined;
      staleJobsRequeued += 1;
    } else {
      job.state = 'failed';
      job.error = 'Graph job became stale while assigned to a worker';
      job.completed_at = job.updated_at;
      job.execution_receipt = await buildGraphReceipt(
        job,
        'failed',
        job.completed_at,
        { error: job.error },
      );
      staleJobsFailed += 1;
    }
    await ctx.saveGraphJob(job);
    if (job.state === 'failed') await ctx.scheduleGraphWebhookIfNeeded(job);
  }

  const retentionCutoff = now - configured.retentionMilliseconds;
  const retainedJobs = jobs.filter((job) => {
    const completedAt = job.completed_at ? Date.parse(job.completed_at) : Number.POSITIVE_INFINITY;
    return !TERMINAL_GRAPH_STATES.has(job.state) || completedAt >= retentionCutoff;
  });
  const expiredJobs = jobs.filter((job) => !retainedJobs.includes(job));
  let deletedObjects = 0;
  let deletedBytes = 0;
  for (const job of expiredJobs) {
    const objects = await listR2Objects(ctx, `${graphJobsPrefix(job.user_id)}${job.job_id}/`);
    deletedObjects += objects.length;
    deletedBytes += objects.reduce((total, object) => total + object.size, 0);
    await deleteR2Objects(ctx, objects);
    await ctx.storage.delete(`graph:${job.job_id}`);
    ctx.graphJobs.delete(job.job_id);
  }

  const referencedDigests = new Set(uniqueAssetSizes(retainedJobs).keys());
  const ownerUserId = retainedJobs[0]?.user_id ?? expiredJobs[0]?.user_id ?? ctx.userId;
  const assetObjects = ownerUserId ? await listR2Objects(ctx, graphAssetsPrefix(ownerUserId)) : [];
  const expiredAssets = assetObjects.filter((object) => {
    const digest = object.key.split('/').at(-1) || '';
    return !referencedDigests.has(digest) && object.uploaded.getTime() < retentionCutoff;
  });
  deletedObjects += expiredAssets.length;
  deletedBytes += expiredAssets.reduce((total, object) => total + object.size, 0);
  await deleteR2Objects(ctx, expiredAssets);

  await recordGraphTelemetry(ctx, {
    stale_jobs_requeued: staleJobsRequeued,
    stale_jobs_failed: staleJobsFailed,
    retained_jobs_deleted: expiredJobs.length,
    r2_objects_deleted: deletedObjects,
    r2_bytes_deleted: deletedBytes,
    last_maintenance_at: new Date(now).toISOString(),
  });
  await ctx.assignQueuedWork();
  const remaining = await ctx.storage.list<GraphJob>({ prefix: 'graph:', limit: 1 });
  if (remaining.size > 0) {
    await scheduleGraphMaintenance(ctx, now);
  } else {
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
