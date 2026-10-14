import type { GraphBatchRecord, GraphBatchRequest, GraphBatchResponse, GraphBatchStoredItem } from './batch-types';
import type { RelayContext } from './relay-context';
import { graphBatchRequestSchema } from './contracts/batch';
import { parseJson } from './json';
import { readRequestJson } from './json';
import { z } from 'zod';
import { sha256Json } from './execution';
import { batchItems, batchItemKey, BATCH_TERMINAL, getBatch, listBatches, nextBatchItems, refreshBatchItems } from './relay-batch-state';
import { withGraphAdmission } from './relay-admission';
import { graphAssetKey } from './relay-graph-storage';
import { storeBatchAsset } from './relay-batch-assets';
import { fenceBatchCancellation, clearBatchFence, releaseBatchFence, batchFenceToken } from './relay-batch-fence';
import { enforceGraphBatchQuotas, scheduleGraphMaintenance } from './relay-graph-operations';
import { handleCancelGraphJob, handleCommitGraphJob, handleCreateGraphJob, handleRetryGraphJob, validateCreateRequest } from './relay-api-graph';
import { graphPlacementReport } from './relay-queue';

const MAX_REQUEST_BYTES = 8 * 1024 * 1024;

async function readBatchRequest(request: Request): Promise<GraphBatchRequest> {
  const reader: ReadableStreamDefaultReader<Uint8Array> | undefined = request.body?.getReader();
  if (!reader) return parseJson('null', graphBatchRequestSchema);
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size += chunk.value.length;
    if (size > MAX_REQUEST_BYTES) {
      await reader.cancel();
      throw new Error('BATCH_REQUEST_TOO_LARGE');
    }
    chunks.push(chunk.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return parseJson(new TextDecoder().decode(bytes), graphBatchRequestSchema);
}

function validationError(body: GraphBatchRequest): string | null {
  const keys = new Set<string>();
  const ids = new Set<string>();
  const digests = new Map<string, number>();
  for (const item of body.items) {
    if (keys.has(item.key) || ids.has(item.submission.job.job_id) || item.submission.job.job_id === body.batch_id) {
      return 'Batch item keys and job ids must be unique and distinct from the batch id';
    }
    keys.add(item.key); ids.add(item.submission.job.job_id);
    if (item.submission.job.outputs.length > 64) return 'Batch children support at most 64 final outputs';
    if (item.submission.job.data_policy) return 'Batch v1 supports portable graphs only';
    if (item.submission.job.idempotency_key) return 'Batch children use their immutable job ids for idempotency';
    const error = validateCreateRequest(item.submission);
    if (error) return `${item.key}: ${error}`;
    if (new TextEncoder().encode(JSON.stringify(item)).length > 96_000) return 'Batch item exceeds the 96 KB document limit';
    for (const entry of item.submission.assets.groups.flatMap((group) => group.entries)) {
      if (digests.has(entry.digest) && digests.get(entry.digest) !== entry.size_bytes) return 'Conflicting sizes for a shared asset digest';
      digests.set(entry.digest, entry.size_bytes);
    }
  }
  return null;
}

function publicBatch(batch: GraphBatchRecord): Omit<GraphBatchRecord, 'user_id' | 'idempotency_key'> {
  return { schema_version: batch.schema_version, batch_id: batch.batch_id, request_sha256: batch.request_sha256,
    state: batch.state, max_in_flight: batch.max_in_flight, max_attempts: batch.max_attempts,
    item_count: batch.item_count, created_at: batch.created_at, updated_at: batch.updated_at, error: batch.error };
}

async function response(ctx: RelayContext, batch: GraphBatchRecord, includeMissing = false, cursor = 0): Promise<Response> {
  const items = await refreshBatchItems(ctx, batch);
  const counts = { pending: 0, queued: 0, running: 0, finished: 0, failed: 0, cancelled: 0 };
  const results: GraphBatchResponse['items'] = [];
  for (const item of items) {
    const state = item.state;
    const category = ['planned', 'preflighting', 'queued'].includes(state) ? 'queued'
      : state === 'assigned' ? 'running' : state;
    counts[category as keyof typeof counts] += 1;
    if (item.ordinal < cursor || item.ordinal >= cursor + 100) continue;
    const job = item.state === 'pending' ? undefined : await ctx.getGraphJob(item.job_id);
    const result = { key: item.key, ordinal: item.ordinal, job_id: item.job_id, state: item.state,
      attempt: item.attempt, error: item.error, artifacts: item.artifacts };
    results.push({ ...result, ...(job && !BATCH_TERMINAL.has(job.state) ? { placement: graphPlacementReport(ctx, job) } : {}) });
  }
  const header = publicBatch(batch);
  const value: GraphBatchResponse = { ...header, counts, items: results, next_cursor: cursor + 100 < items.length ? cursor + 100 : null };
  if (includeMissing) value.missing_asset_digests = await missingAssets(ctx, batch, items);
  return Response.json(value);
}

async function missingAssets(ctx: RelayContext, batch: GraphBatchRecord, items: GraphBatchStoredItem[]): Promise<string[]> {
  const assets = new Map(items.flatMap((item) => item.submission.assets.groups.flatMap((group) => group.entries))
    .map((entry) => [entry.digest, entry]));
  const missing: string[] = [];
  for (const [digest, entry] of assets) {
    const object = await ctx.env.IMAGES.head(graphAssetKey(batch.user_id, digest));
    if (!object || object.size !== entry.size_bytes || object.customMetadata?.sha256 !== digest) missing.push(digest);
  }
  return missing.sort();
}

async function createBatch(ctx: RelayContext, body: GraphBatchRequest, origin: string): Promise<Response> {
  const error = validationError(body);
  if (error) return Response.json({ error }, { status: 400 });
  const hash = await sha256Json(body);
  const existingId = await ctx.storage.get<string>(`batch-idempotency:${body.idempotency_key}`);
  const existing = await getBatch(ctx, existingId ?? body.batch_id);
  if (existing) {
    return existing.request_sha256 === hash ? response(ctx, existing, existing.state === 'planned')
      : Response.json({ code: 'IDEMPOTENCY_CONFLICT' }, { status: 409 });
  }
  if (await ctx.getGraphJob(body.batch_id) || await ctx.storage.get(`batch-child:${body.batch_id}`)) {
    return Response.json({ code: 'BATCH_ID_CONFLICT' }, { status: 409 });
  }
  const quota = await enforceGraphBatchQuotas(ctx, body.items.map((item) => item.submission), ctx.userId);
  if (quota) return quota;
  const batches = await listBatches(ctx);
  if (batches.filter((batch) => !BATCH_TERMINAL.has(batch.state)).length >= 20) {
    return Response.json({ code: 'batch_active_quota' }, { status: 429 });
  }
  for (const item of body.items) {
    if (await ctx.getGraphJob(item.submission.job.job_id) || await ctx.storage.get(`batch-child:${item.submission.job.job_id}`)
        || await getBatch(ctx, item.submission.job.job_id)) {
      return Response.json({ code: 'BATCH_CHILD_CONFLICT', key: item.key }, { status: 409 });
    }
  }
  const now = new Date().toISOString();
  const batch: GraphBatchRecord = { schema_version: 1, batch_id: body.batch_id, user_id: ctx.userId,
    request_sha256: hash, idempotency_key: body.idempotency_key, state: 'planned',
    max_in_flight: body.max_in_flight, max_attempts: body.max_attempts, item_count: body.items.length,
    created_at: now, updated_at: now, error: null };
  clearBatchFence(ctx.storage, batch.batch_id);
  await ctx.storage.transaction(async (transaction) => {
    await transaction.put(`batch:${batch.batch_id}`, batch);
    await transaction.put(`batch-idempotency:${batch.idempotency_key}`, batch.batch_id);
    for (const [ordinal, item] of body.items.entries()) {
      const stored: GraphBatchStoredItem = { key: item.key, ordinal, job_id: item.submission.job.job_id,
        state: 'pending', submission: { ...item.submission, client_id: `client_${ctx.userId.slice(-8)}`, relay_origin: origin },
        attempt: 0, error: null, artifacts: [] };
      await transaction.put(batchItemKey(batch.batch_id, ordinal), stored);
      await transaction.put(`batch-child:${stored.job_id}`, batch.batch_id);
    }
  });
  await scheduleGraphMaintenance(ctx);
  return response(ctx, batch, true);
}

export async function handleCreateBatch(ctx: RelayContext, request: Request): Promise<Response> {
  try {
    const body = await readBatchRequest(request);
    return await withGraphAdmission(ctx.storage, () => createBatch(ctx, body, new URL(request.url).origin));
  } catch (error) {
    if (error instanceof Error && error.message === 'BATCH_REQUEST_TOO_LARGE') {
      return Response.json({ code: error.message }, { status: 413 });
    }
    throw error;
  }
}

export async function handleGetBatch(ctx: RelayContext, id: string, cursor = 0): Promise<Response> {
  const batch = await getBatch(ctx, id);
  return batch ? response(ctx, batch, batch.state === 'planned', cursor) : Response.json({ error: 'Batch not found' }, { status: 404 });
}

export async function handleListBatches(ctx: RelayContext): Promise<Response> {
  return Response.json({ batches: (await listBatches(ctx)).map(publicBatch) });
}

export async function handleUploadBatchAsset(ctx: RelayContext, id: string, digest: string, request: Request): Promise<Response> {
  const batch = await getBatch(ctx, id);
  if (!batch) return Response.json({ error: 'Batch not found' }, { status: 404 });
  if (batch.state !== 'planned') return Response.json({ error: 'Batch is already committed' }, { status: 409 });
  const entry = (await batchItems(ctx, id)).flatMap((item) => item.submission.assets.groups.flatMap((group) => group.entries))
    .find((asset) => asset.digest === digest);
  if (!entry) return Response.json({ error: 'Undeclared asset' }, { status: 404 });
  if (!(await storeBatchAsset(ctx, batch.user_id, id, digest, entry.size_bytes, entry.content_type, request))) {
    return Response.json({ error: 'Asset size or digest mismatch' }, { status: 400 });
  }
  return Response.json({ digest, stored: true });
}

export async function handleCommitBatch(ctx: RelayContext, id: string): Promise<Response> {
  const batch = await getBatch(ctx, id);
  if (!batch) return Response.json({ error: 'Batch not found' }, { status: 404 });
  if (batch.state === 'planned') {
    const missing = await missingAssets(ctx, batch, await batchItems(ctx, id));
    if (missing.length) return Response.json({ error: 'Batch assets incomplete', missing_asset_digests: missing }, { status: 409 });
    await ctx.storage.transaction(async (transaction) => {
      const current = await transaction.get<GraphBatchRecord>(`batch:${id}`);
      if (current?.state === 'planned') await transaction.put(`batch:${id}`, { ...current, state: 'running', updated_at: new Date().toISOString() });
    });
  }
  await ctx.assignQueuedWork();
  return handleGetBatch(ctx, id);
}

export async function handleCancelBatch(ctx: RelayContext, id: string): Promise<Response> {
  const batch = await getBatch(ctx, id);
  if (!batch) return Response.json({ error: 'Batch not found' }, { status: 404 });
  if (BATCH_TERMINAL.has(batch.state)) return response(ctx, batch);
  const cancellationFence = fenceBatchCancellation(ctx.storage, id);
  const cancelled = await ctx.storage.transaction(async (transaction) => {
    const current = await transaction.get<GraphBatchRecord>(`batch:${id}`);
    if (current && !BATCH_TERMINAL.has(current.state)) {
      current.state = 'cancelled'; current.updated_at = new Date().toISOString();
      await transaction.put(`batch:${id}`, current);
    }
    return current;
  });
  if (cancelled) Object.assign(batch, cancelled);
  if (batch.state !== 'cancelled') releaseBatchFence(ctx.storage, id, cancellationFence);
  if (batch.state === 'cancelled') await cancelBatchChildren(ctx, batch);
  await ctx.assignQueuedWork();
  return response(ctx, batch);
}

async function cancelBatchChildren(ctx: RelayContext, batch: GraphBatchRecord): Promise<void> {
  for (const item of await batchItems(ctx, batch.batch_id)) {
    if (BATCH_TERMINAL.has(item.state)) continue;
    const job = await ctx.getGraphJob(item.job_id);
    if (job) await handleCancelGraphJob(ctx, item.job_id);
    item.state = job?.state ?? 'cancelled';
    item.attempt = job?.attempt ?? item.attempt;
    item.artifacts = job?.artifacts.filter((artifact) => artifact.kind === 'graph.output') ?? item.artifacts;
    item.error = job?.error ?? item.error;
    await ctx.storage.put(batchItemKey(batch.batch_id, item.ordinal), item);
  }
 }

export async function settleCancelledBatches(ctx: RelayContext): Promise<void> {
  for (const batch of await listBatches(ctx)) {
    if (batch.state === 'cancelled') await cancelBatchChildren(ctx, batch);
  }
}

export async function handleRetryBatch(ctx: RelayContext, id: string, request: Request): Promise<Response> {
  const batch = await getBatch(ctx, id);
  const previousFence = batchFenceToken(ctx.storage, id);
  if (!batch) return Response.json({ error: 'Batch not found' }, { status: 404 });
  if (batch.state === 'cancelled' || batch.state === 'planned') return Response.json({ error: 'Only failed batches can be retried' }, { status: 409 });
  const retry = await readRequestJson(request, z.object({ retry_key: z.string().uuid() }).strict());
  if (batch.retry_key === retry.retry_key) return response(ctx, batch);
  const items = await refreshBatchItems(ctx, batch);
  if (batch.state !== 'failed' || !items.some((item) => item.state === 'failed')) {
    return Response.json({ error: 'Batch has no settled failed items to retry' }, { status: 409 });
  }
  const accepted = await ctx.storage.transaction(async (transaction) => {
    const current = await transaction.get<GraphBatchRecord>(`batch:${id}`);
    if (!current || current.state !== 'failed') return false;
    for (const item of items) {
      if (item.state !== 'failed') continue;
      await transaction.put(batchItemKey(id, item.ordinal), { ...item, state: 'pending', error: null });
    }
    await transaction.put(`batch:${id}`, { ...current, state: 'running', retry_key: retry.retry_key,
      updated_at: new Date().toISOString(), error: null });
    return true;
  });
  if (!accepted) return handleGetBatch(ctx, id);
  releaseBatchFence(ctx.storage, id, previousFence);
  await ctx.assignQueuedWork();
  return handleGetBatch(ctx, id);
}

/** Called only by the account's single-flight dispatcher; never performs inference. */
export async function fillBatchWindow(ctx: RelayContext): Promise<void> {
  for (;;) {
    const ready = await nextBatchItems(ctx);
    if (!ready.length) return;
    let admitted = false;
    for (const { batch, item } of ready) {
      if (await admitBatchItem(ctx, batch, item)) admitted = true;
    }
    if (!admitted) return;
  }
}

async function admitBatchItem(ctx: RelayContext, batch: GraphBatchRecord, item: GraphBatchStoredItem): Promise<boolean> {
  if ((await getBatch(ctx, batch.batch_id))?.state !== 'running') return false;
  const existing = await ctx.getGraphJob(item.job_id);
  const created = existing ? null : await handleCreateGraphJob(ctx, item.submission, batch.user_id,
    item.submission.relay_origin ?? '', { batch_id: batch.batch_id, max_attempts: batch.max_attempts });
  if (created && !created.ok) {
    if (created.status === 429 || created.status === 507) {
      item.error = created.status === 429 ? 'GRAPH_ACTIVE_JOB_QUOTA' : 'GRAPH_ACCOUNT_STORAGE_QUOTA';
      await ctx.storage.put(batchItemKey(batch.batch_id, item.ordinal), item);
      return false;
    }
    item.state = 'failed'; item.error = `BATCH_ADMISSION_${created.status}`;
    await ctx.storage.put(batchItemKey(batch.batch_id, item.ordinal), item);
    return false;
  }
  const job = await ctx.getGraphJob(item.job_id);
  if (!job) throw new Error('Batch child was not persisted');
  if ((await getBatch(ctx, batch.batch_id))?.state !== 'running') {
    await handleCancelGraphJob(ctx, item.job_id);
    return false;
  }
  if (job.state === 'failed') {
    const retry = await handleRetryGraphJob(ctx, job.job_id, false, batch.batch_id, batch.max_attempts);
    if (!retry.ok) {
      item.error = `BATCH_RETRY_${retry.status}`;
      await ctx.storage.put(batchItemKey(batch.batch_id, item.ordinal), item);
      return false;
    }
  }
  else if (job.state === 'planned') await handleCommitGraphJob(ctx, job.job_id, false);
  if ((await getBatch(ctx, batch.batch_id))?.state !== 'running') {
    await handleCancelGraphJob(ctx, item.job_id);
    return false;
  }
  const current = await ctx.getGraphJob(item.job_id);
  if (!current) throw new Error('Batch child disappeared');
  item.state = current.state; item.attempt = current.attempt; item.error = current.error;
  item.artifacts = current.artifacts.filter((artifact) => artifact.kind === 'graph.output');
  await ctx.storage.put(batchItemKey(batch.batch_id, item.ordinal), item);
  await ctx.storage.put('relay:batch-admission-turn', batch.batch_id);
  return true;
}

export async function handleGraphBatchRequest(ctx: RelayContext, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (path === '/internal/graph-batches') {
    if (request.method === 'POST') return handleCreateBatch(ctx, request);
    if (request.method === 'GET') return handleListBatches(ctx);
  }
  const match = path.match(/^\/internal\/graph-batches\/([a-f0-9-]{36})(?:\/(commit|retry|assets)(?:\/([a-f0-9]{64}))?)?$/u);
  if (!match) return new Response('Not Found', { status: 404 });
  const [, id, action, digest] = match;
  if (!action && request.method === 'GET') {
    const cursor = z.coerce.number().int().min(0).max(1000).safeParse(url.searchParams.get('cursor') ?? 0);
    if (!cursor.success) return Response.json({ error: 'Invalid batch cursor' }, { status: 400 });
    return handleGetBatch(ctx, id, cursor.data);
  }
  if (!action && request.method === 'DELETE') return handleCancelBatch(ctx, id);
  if (action === 'commit' && request.method === 'POST') return handleCommitBatch(ctx, id);
  if (action === 'retry' && request.method === 'POST') return handleRetryBatch(ctx, id, request);
  if (action === 'assets' && digest && request.method === 'PUT') return handleUploadBatchAsset(ctx, id, digest, request);
  return new Response('Not Found', { status: 404 });
}
