import { z } from 'zod';
import { graphBatchResponseSchema } from './batch-contracts';

const fields = graphBatchResponseSchema.shape;
const summary = z.object({ schema_version: fields.schema_version, batch_id: fields.batch_id,
  request_sha256: fields.request_sha256, state: fields.state, max_in_flight: fields.max_in_flight,
  max_attempts: fields.max_attempts, item_count: fields.item_count, created_at: fields.created_at,
  updated_at: fields.updated_at, error: fields.error });
const list = z.object({ batches: z.array(summary) });
export type GraphBatchSummary = z.infer<typeof summary>;
export function isGraphBatchList(value: unknown): value is { batches: GraphBatchSummary[] } {
  return list.safeParse(value).success;
}
