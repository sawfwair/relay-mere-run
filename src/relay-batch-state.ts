import { graphCapabilityBlockers } from './relay-queue';
import { graphPlacementRecord } from './relay-graph-record';
import { agentCanAcceptWork } from './relay-fleet';
import type { GraphBatchRecord, GraphBatchStoredItem } from './batch-types';
import { graphBatchRecordSchema, graphBatchStoredItemSchema } from './contracts/batch';
import type { RelayContext } from './relay-context';

export const BATCH_TERMINAL = new Set(['finished', 'failed', 'cancelled']);
export function batchItemKey(batchId: string, ordinal: number): string {
  return `batch-item:${batchId}:${String(ordinal).padStart(4, '0')}`;
}

export async function getBatch(ctx: RelayContext, id: string): Promise<GraphBatchRecord | undefined> {
  const value = await ctx.storage.get<unknown>(`batch:${id}`);
  return value === undefined ? undefined : graphBatchRecordSchema.parse(value);
}

export async function listBatches(ctx: RelayContext): Promise<GraphBatchRecord[]> {
  const records = await ctx.storage.list<unknown>({ prefix: 'batch:' });
  return [...records.values()].map((value) => graphBatchRecordSchema.parse(value));
}

export async function batchItems(ctx: RelayContext, id: string): Promise<GraphBatchStoredItem[]> {
  const items: GraphBatchStoredItem[] = [];
  for await (const item of storedBatchItems(ctx.storage, `batch-item:${id}:`)) items.push(item);
  return items;
}

export async function* storedBatchItems(storage: DurableObjectStorage, prefix = 'batch-item:'): AsyncGenerator<GraphBatchStoredItem> {
  let startAfter: string | undefined;
  for (;;) {
    const records = await storage.list<unknown>({ prefix, limit: 32, startAfter });
    for (const [key, value] of records) { startAfter = key; yield graphBatchStoredItemSchema.parse(value); }
    if (records.size < 32) return;
  }
}

export async function refreshBatchItems(ctx: RelayContext, batch: GraphBatchRecord): Promise<GraphBatchStoredItem[]> {
  const items = await batchItems(ctx, batch.batch_id);
  for (const item of items) {
    if (item.state === 'pending' || BATCH_TERMINAL.has(item.state)) continue;
    const job = await ctx.getGraphJob(item.job_id);
    if (!job) continue;
    item.state = job.state;
    item.attempt = job.attempt;
    item.error = job.error;
    item.artifacts = job.artifacts.filter((artifact) => artifact.kind === 'graph.output');
    await ctx.storage.transaction(async (transaction) => {
      const key = batchItemKey(batch.batch_id, item.ordinal);
      const current = await transaction.get<GraphBatchStoredItem>(key);
      if (current && BATCH_TERMINAL.has(current.state)) Object.assign(item, current);
      else await transaction.put(key, item);
    });
  }
  if (batch.state === 'running' && items.every((item) => BATCH_TERMINAL.has(item.state))) {
    const completed = items.some((item) => item.state !== 'finished') ? 'failed' : 'finished';
    await ctx.storage.transaction(async (transaction) => {
      const current = await transaction.get<GraphBatchRecord>(`batch:${batch.batch_id}`);
      if (current?.state === 'running') {
        current.state = completed; current.updated_at = new Date().toISOString();
        await transaction.put(`batch:${batch.batch_id}`, current);
        Object.assign(batch, current);
      } else if (current) Object.assign(batch, current);
    });
  }
  return items;
}

/** One child from each batch per round prevents a large batch consuming the window. */
export async function nextBatchItems(ctx: RelayContext): Promise<Array<{ batch: GraphBatchRecord; item: GraphBatchStoredItem }>> {
  const ready: Array<{ batch: GraphBatchRecord; item: GraphBatchStoredItem }> = [];
  const batches = await listBatches(ctx);
  const last = await ctx.storage.get<string>('relay:batch-admission-turn');
  const start = last ? (batches.findIndex((batch) => batch.batch_id === last) + 1) % Math.max(1, batches.length) : 0;
  for (const batch of [...batches.slice(start), ...batches.slice(0, start)]) {
    if (batch.state !== 'running') continue;
    const items = await refreshBatchItems(ctx, batch);
    const active = items.filter((item) => item.state !== 'pending' && !BATCH_TERMINAL.has(item.state)).length;
    if (active >= batch.max_in_flight) continue;
    const pending = items.filter((candidate) => candidate.state === 'pending');
    const item = pending.find((candidate) => hasCompatibleNode(ctx, candidate)) ?? pending[0];
    if (item) ready.push({ batch, item });
  }
  return ready;
}

export async function pruneBatches(ctx: RelayContext, cutoff: number): Promise<void> {
  for (const batch of await listBatches(ctx)) {
    if (!BATCH_TERMINAL.has(batch.state) || Date.parse(batch.updated_at) >= cutoff) continue;
    const items = await batchItems(ctx, batch.batch_id);
    await ctx.storage.transaction(async (transaction) => {
      const current = await transaction.get<GraphBatchRecord>(`batch:${batch.batch_id}`);
      if (!current || !BATCH_TERMINAL.has(current.state) || Date.parse(current.updated_at) >= cutoff) return;
      for (const item of items) {
        await transaction.delete(batchItemKey(batch.batch_id, item.ordinal));
        await transaction.delete(`batch-child:${item.job_id}`);
      }
      await transaction.delete(`batch:${batch.batch_id}`);
      await transaction.delete(`batch-idempotency:${batch.idempotency_key}`);
    });
  }
}

function hasCompatibleNode(ctx: RelayContext, item: GraphBatchStoredItem): boolean {
  const graph = { ...graphPlacementRecord(item.submission, ctx.userId), requires_assignment_token: true };
  return [...ctx.getConnectedAgents().values()].some((agent) => agentCanAcceptWork(agent.info)
    && graphCapabilityBlockers(agent.info, graph).length === 0);
}
