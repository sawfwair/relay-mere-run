import { z } from 'zod';
import type { FleetModelPlan, FleetSnapshot, SessionResponse } from './types';

const fleetNodePolicySchema = z.object({
  enabled: z.boolean(),
  draining: z.boolean(),
  revoked: z.boolean(),
  priority: z.number(),
  preferred_models: z.array(z.string()),
  display_name: z.string().nullable(),
}).passthrough();

const agentCapabilitiesSchema = z.object({
  models: z.array(z.string()),
  max_resolution: z.number(),
  controlnet: z.boolean(),
  lora: z.boolean(),
  img2img: z.boolean(),
  plugins: z.array(z.object({
    name: z.string(),
    commands: z.array(z.string()),
  }).passthrough()).optional(),
}).passthrough();

const agentSystemSchema = z.object({
  platform: z.string(),
  architecture: z.string(),
  os_version: z.string().optional(),
  hostname: z.string().optional(),
  cpu_model: z.string().optional(),
  logical_cores: z.number().optional(),
  memory_total_bytes: z.number().optional(),
  accelerators: z.array(z.object({
    backend: z.string(),
    name: z.string(),
    memory_total_bytes: z.number().optional(),
    index: z.number().optional(),
  }).passthrough()),
}).passthrough();

const agentRuntimeSchema = z.object({
  mere_run_version: z.string().optional(),
  installed_models: z.array(z.string()),
  inventory_status: z.enum(['reported', 'empty', 'unavailable', 'failed']).optional(),
  diagnostic: z.enum([
    'mere_run_not_found',
    'version_command_unavailable',
    'version_command_failed',
    'version_output_empty',
    'inventory_commands_failed',
  ]).optional(),
}).passthrough();

const telemetrySchema = z.object({
  sampled_at: z.string(),
  cpu_load_percent: z.number().optional(),
  memory_available_bytes: z.number().optional(),
  accelerator_utilization_percent: z.number().optional(),
  accelerator_memory_used_bytes: z.number().optional(),
  accelerator_memory_total_bytes: z.number().optional(),
  power_source: z.string().optional(),
  battery_percent: z.number().optional(),
  low_power_mode: z.boolean().optional(),
  thermal_state: z.string().optional(),
}).passthrough();

export const fleetNodeSchema = z.object({
  agent_id: z.string(),
  device_id: z.string(),
  device_name: z.string(),
  reported_name: z.string(),
  version: z.string(),
  status: z.enum(['online', 'busy', 'offline', 'disabled', 'draining', 'revoked']),
  current_job_id: z.string().nullable(),
  first_seen: z.string(),
  last_seen: z.string(),
  connected_at: z.string().nullable(),
  capabilities: agentCapabilitiesSchema,
  system: agentSystemSchema.optional(),
  runtime: agentRuntimeSchema.optional(),
  telemetry: telemetrySchema.optional(),
  policy: fleetNodePolicySchema,
  performance: z.object({
    models: z.record(z.string(), z.object({
      successes: z.number(),
      failures: z.number(),
      average_generation_time_ms: z.number().nullable(),
      last_generation_time_ms: z.number().nullable(),
      updated_at: z.string(),
    }).passthrough()),
  }).passthrough(),
}).passthrough();

export const fleetSnapshotSchema = z.object({
  generated_at: z.string(),
  settings: z.object({
    scheduler_mode: z.enum(['balanced', 'fastest', 'efficient']),
    retry_limit: z.number(),
    updated_at: z.string(),
  }).passthrough(),
  summary: z.object({
    total_nodes: z.number(),
    online_nodes: z.number(),
    busy_nodes: z.number(),
    available_nodes: z.number(),
    queue_depth: z.number(),
    installed_models: z.number(),
    routable_models: z.number(),
  }).passthrough(),
  nodes: z.array(fleetNodeSchema),
  models: z.array(z.object({
    model: z.string(),
    capable_nodes: z.number(),
    available_nodes: z.number(),
    fastest_average_ms: z.number().nullable(),
  }).passthrough()),
  activity: z.array(z.object({
    id: z.string(),
    kind: z.string(),
    status: z.string(),
    agent_id: z.string().nullable(),
    model: z.string().optional(),
    label: z.string(),
    created_at: z.string(),
    started_at: z.string().nullable(),
    completed_at: z.string().nullable(),
    duration_ms: z.number().nullable(),
    error: z.string().nullable(),
  }).passthrough()),
}).passthrough() satisfies z.ZodType<FleetSnapshot>;

export const fleetSettingsSchema = z.object({
  scheduler_mode: z.enum(['balanced', 'fastest', 'efficient']),
  retry_limit: z.number(),
  updated_at: z.string(),
}).passthrough();

export const fleetRefreshResponseSchema = z.object({
  device_id: z.string(),
  requested: z.boolean(),
}).passthrough();

const modelPlanResultSchema = z.object({
  model_id: z.string(),
  state: z.enum(['installed', 'already_installed', 'failed', 'cancelled']),
  error: z.string().optional(),
}).passthrough();

export const fleetModelPlanSchema = z.object({
  schema_version: z.literal(1),
  kind: z.literal('mere.run/fleet-model-plan'),
  plan_id: z.string(),
  source_device_id: z.string().nullable(),
  model_ids: z.array(z.string()),
  targets: z.array(z.object({
    device_id: z.string(),
    device_name: z.string(),
    installed_model_ids: z.array(z.string()),
    missing_model_ids: z.array(z.string()),
    state: z.enum(['ready', 'noop', 'offline', 'applying', 'finished', 'failed', 'cancelled']),
    results: z.array(modelPlanResultSchema),
    error: z.string().nullable(),
    started_at: z.string().nullable(),
    completed_at: z.string().nullable(),
  }).passthrough()),
  events: z.array(z.object({
    sequence: z.number(),
    created_at: z.string(),
    device_id: z.string(),
    model_id: z.string().optional(),
    phase: z.string(),
    message: z.string().optional(),
  }).passthrough()),
  attempt: z.number(),
  state: z.enum(['planned', 'applying', 'finished', 'failed', 'cancelled']),
  created_at: z.string(),
  updated_at: z.string(),
  applied_at: z.string().nullable(),
  completed_at: z.string().nullable(),
}).passthrough() satisfies z.ZodType<FleetModelPlan>;

export const sessionResponseSchema = z.object({
  authenticated: z.boolean(),
  user: z.object({
    user_id: z.string(),
    email: z.string().optional(),
    name: z.string().optional(),
  }).passthrough().optional(),
}).passthrough() satisfies z.ZodType<SessionResponse>;

export const errorResponseSchema = z.object({ error: z.string().optional() }).passthrough();
