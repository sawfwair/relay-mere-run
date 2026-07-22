import { z } from 'zod';
import type { WorkflowValue } from '../types';

export const unknownRecordSchema = z.record(z.string(), z.unknown());

export const workflowValueSchema: z.ZodType<WorkflowValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.string(),
    z.number(),
    z.boolean(),
    z.array(workflowValueSchema),
    z.record(z.string(), workflowValueSchema),
  ])
);

export const clientIdSchema = z.string();
export const relayOriginSchema = z.string().optional();

export const optionalStringSchema = z.string().optional();
export const nullableStringSchema = z.string().nullable();
export const optionalNumberSchema = z.number().optional();
