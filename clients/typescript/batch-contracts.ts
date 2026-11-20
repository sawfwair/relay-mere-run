import { z } from 'zod';
import type { GraphSubmission } from './graph-contracts';

export interface GraphBatchSubmission {
  schema_version: 1;
  batch_id: string;
  idempotency_key: string;
  max_in_flight: number;
  max_attempts: number;
  items: Array<{ key: string; submission: GraphSubmission }>;
}

const batchItemSchema = z.object({
  key: z.string(), ordinal: z.number().int().nonnegative(), job_id: z.string().uuid(),
  state: z.enum(['pending', 'planned', 'preflighting', 'queued', 'assigned', 'running', 'finished', 'failed', 'cancelled']),
  attempt: z.number().int().nonnegative(), error: z.string().nullable(),
  artifacts: z.array(z.object({ name: z.string(), kind: z.string(), path: z.string(), content_type: z.string(),
    size_bytes: z.number().int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/u) })),
  placement: z.object({ connected_nodes: z.number(), graph_worker_nodes: z.number(), eligible_nodes: z.number(),
    diagnostic: z.string().nullable(), nodes: z.array(z.object({ agent_id: z.string(), device_id: z.string(),
      device_name: z.string(), status: z.enum(['online', 'busy']), eligible: z.boolean(),
      cached_input_bytes: z.number(), total_input_bytes: z.number(), blockers: z.array(z.object({ code: z.string(), message: z.string() })) })) }).optional(),
});

export const graphBatchResponseSchema = z.object({
  schema_version: z.literal(1), batch_id: z.string().uuid(), request_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  state: z.enum(['planned', 'running', 'finished', 'failed', 'cancelled']),
  max_in_flight: z.number().int().min(1).max(20), max_attempts: z.number().int().min(1).max(4), item_count: z.number().int().min(1).max(1000),
  created_at: z.string(), updated_at: z.string(), error: z.string().nullable(),
  counts: z.object({ pending: z.number().int().nonnegative(), queued: z.number().int().nonnegative(), running: z.number().int().nonnegative(),
    finished: z.number().int().nonnegative(), failed: z.number().int().nonnegative(), cancelled: z.number().int().nonnegative() }),
  items: z.array(batchItemSchema), missing_asset_digests: z.array(z.string().regex(/^[a-f0-9]{64}$/u)).optional(),
  next_cursor: z.number().int().min(1).max(1000).nullable().optional(),
}).refine((value) => value.items.length <= value.item_count
  && Object.values(value.counts).reduce((sum, count) => sum + count, 0) === value.item_count
  && new Set(value.items.map((item) => item.key)).size === value.items.length
  && new Set(value.items.map((item) => item.job_id)).size === value.items.length);

export type GraphBatchResponse = z.infer<typeof graphBatchResponseSchema>;
export function isGraphBatchResponse(value: unknown): value is GraphBatchResponse {
  return graphBatchResponseSchema.safeParse(value).success;
}
