import { z } from 'zod';
import type {
  ApplyFleetModelPlanRequest,
  FleetSettings,
  SubmitFleetModelPlanRequest,
} from '../types';
import type { FleetNodePolicyPatch } from '../relay-fleet';

export const submitFleetModelPlanRequestSchema = z.object({
  source_device_id: z.string().optional(),
  target_device_ids: z.array(z.string()),
  model_ids: z.array(z.string()).optional(),
}).passthrough() satisfies z.ZodType<SubmitFleetModelPlanRequest>;

export const applyFleetModelPlanRequestSchema = z.object({
  accept_model_licenses: z.boolean().optional(),
}).passthrough() satisfies z.ZodType<ApplyFleetModelPlanRequest>;

export const fleetSettingsPatchSchema = z.object({
  scheduler_mode: z.enum(['balanced', 'fastest', 'efficient']).optional(),
  retry_limit: z.number().optional(),
  updated_at: z.string().optional(),
}).passthrough() satisfies z.ZodType<Partial<FleetSettings>>;

export const fleetNodePolicyPatchSchema = z.object({
  enabled: z.boolean().optional(),
  draining: z.boolean().optional(),
  revoked: z.boolean().optional(),
  priority: z.number().optional(),
  preferred_models: z.array(z.string()).optional(),
  display_name: z.string().nullable().optional(),
}).passthrough() satisfies z.ZodType<FleetNodePolicyPatch>;
