import { z } from 'zod';
import type { GraphBatchRequest, GraphBatchRecord, GraphBatchStoredItem } from '../batch-types';
import { submitGraphJobRequestSchema, graphRunArtifactSchema } from './graph';

export const graphBatchRequestSchema = z.object({
  schema_version: z.literal(1),
  batch_id: z.string().uuid(),
  idempotency_key: z.string().min(1).max(160),
  max_in_flight: z.number().int().min(1).max(20).default(8),
  max_attempts: z.number().int().min(1).max(4).default(1),
  items: z.array(z.object({
    key: z.string().min(1).max(160).regex(/^[A-Za-z0-9_.:-]+$/u),
    submission: submitGraphJobRequestSchema,
  })).min(1).max(1000),
}).strict() satisfies z.ZodType<GraphBatchRequest>;

export const graphBatchRecordSchema = z.object({
  retry_key: z.string().uuid().optional(),
  schema_version: z.literal(1), batch_id: z.string(), user_id: z.string(),
  request_sha256: z.string(), idempotency_key: z.string(),
  state: z.enum(['planned', 'running', 'finished', 'failed', 'cancelled']),
  max_in_flight: z.number(), max_attempts: z.number(), item_count: z.number(),
  created_at: z.string(), updated_at: z.string(), error: z.string().nullable(),
}).strict() satisfies z.ZodType<GraphBatchRecord>;

export const graphBatchStoredItemSchema = z.object({
  key: z.string(), ordinal: z.number(), job_id: z.string(),
  state: z.enum(['pending', 'planned', 'preflighting', 'queued', 'assigned', 'running', 'finished', 'failed', 'cancelled']),
  submission: submitGraphJobRequestSchema,
  attempt: z.number(), error: z.string().nullable(), artifacts: z.array(graphRunArtifactSchema),
}).strict() satisfies z.ZodType<GraphBatchStoredItem>;
