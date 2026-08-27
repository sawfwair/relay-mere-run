import { z } from 'zod';
import type {
  AgentCapabilities,
  AgentMessage,
  AgentRuntimeInfo,
  AgentSystemInfo,
  AgentTelemetry,
  AuthMessage,
  InventoryUpdateMessage,
  PingMessage,
} from '../types';
import {
  graphErrorMessageSchema,
  graphEventMessageSchema,
  graphResultMessageSchema,
} from './graph';
import {
  asrErrorMessageSchema,
  asrResponseMessageSchema,
  chatErrorMessageSchema,
  chatResponseMessageSchema,
  embedErrorMessageSchema,
  embedResponseMessageSchema,
  ocrErrorMessageSchema,
  ocrResponseMessageSchema,
  resultMessageSchema,
  talkErrorMessageSchema,
  talkResponseMessageSchema,
  toolArtifactSchema,
  toolErrorMessageSchema,
  toolResultMessageSchema,
} from './messages';
import { unknownRecordSchema } from './primitives';

const graphProviderCapabilitySchema = z.object({
  id: z.string(),
  version: z.string(),
  catalog_sha256: z.string(),
  node_kinds: z.array(z.string()),
}).passthrough();

const graphWorkerCapabilitiesSchema = z.object({
  schema_version: z.number(),
  worker_version: z.string(),
  contract_versions: z.array(z.string()),
  data_policies: z.array(z.string()).optional(),
  platform: z.string(),
  architecture: z.string(),
  accelerator_backend: z.string(),
  memory_bytes: z.number(),
  system_memory_bytes: z.number().optional(),
  logical_cpu_cores: z.number().optional(),
  available_disk_bytes: z.number().optional(),
  network_access: z.boolean().optional(),
  node_kinds: z.array(z.string()),
  installed_model_ids: z.array(z.string()),
  available_secret_names: z.array(z.string()).optional(),
  cached_asset_digests: z.array(z.string()).optional(),
  providers: z.array(graphProviderCapabilitySchema),
  catalog: unknownRecordSchema.optional(),
}).passthrough();

const pluginCapabilitySchema = z.object({
  name: z.string(),
  version: z.string().optional(),
  executable: z.string().optional(),
  description: z.string().optional(),
  commands: z.array(z.string()),
  capabilities: z.array(z.string()),
}).passthrough();

export const agentCapabilitiesSchema = z.object({
  models: z.array(z.string()),
  max_resolution: z.number(),
  controlnet: z.boolean(),
  lora: z.boolean(),
  text_adapters: z.array(z.object({
    manifest_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    base_model_id: z.string(),
  }).passthrough()).optional(),
  img2img: z.boolean(),
  plugins: z.array(pluginCapabilitySchema).optional(),
  graph_worker: graphWorkerCapabilitiesSchema.optional(),
  asr_streaming: z.object({
    protocols: z.array(z.number()),
    input_formats: z.array(z.string()),
    max_sessions: z.number(),
    backends: z.array(z.enum(['auto', 'parakeet', 'qwen'])).optional(),
  }).passthrough().optional(),
}).passthrough() satisfies z.ZodType<AgentCapabilities>;

const acceleratorInfoSchema = z.object({
  backend: z.enum(['metal', 'cuda', 'rocm', 'cpu', 'unknown']),
  name: z.string(),
  memory_total_bytes: z.number().optional(),
  index: z.number().optional(),
}).passthrough();

export const agentSystemInfoSchema = z.object({
  platform: z.string(),
  architecture: z.string(),
  os_version: z.string().optional(),
  hostname: z.string().optional(),
  cpu_model: z.string().optional(),
  logical_cores: z.number().optional(),
  memory_total_bytes: z.number().optional(),
  accelerators: z.array(acceleratorInfoSchema),
}).passthrough() satisfies z.ZodType<AgentSystemInfo>;

export const agentRuntimeInfoSchema = z.object({
  mere_run_version: z.string().optional(),
  installed_models: z.array(z.string()),
  inventory_status: z.enum(['reported', 'empty', 'unavailable', 'failed']).optional(),
  diagnostic: z.enum([
    'mere_run_not_found', 'version_command_unavailable', 'version_command_failed',
    'version_output_empty', 'inventory_commands_failed',
  ]).optional(),
}).passthrough() satisfies z.ZodType<AgentRuntimeInfo>;

const agentCapacitySchema = z.object({
  max_concurrent_jobs: z.number(),
  lease_protocol: z.boolean().optional(),
}).passthrough();

export const agentTelemetrySchema = z.object({
  sampled_at: z.string(),
  cpu_load_percent: z.number().optional(),
  memory_available_bytes: z.number().optional(),
  accelerator_utilization_percent: z.number().optional(),
  accelerator_memory_used_bytes: z.number().optional(),
  accelerator_memory_total_bytes: z.number().optional(),
  power_source: z.enum(['ac', 'external', 'battery', 'unknown']).optional(),
  battery_percent: z.number().optional(),
  low_power_mode: z.boolean().optional(),
  thermal_state: z.enum(['nominal', 'fair', 'serious', 'critical', 'unknown']).optional(),
}).passthrough() satisfies z.ZodType<AgentTelemetry>;

export const authMessageSchema = z.object({
  type: z.literal('auth'),
  device_id: z.string(),
  device_name: z.string(),
  version: z.string(),
  capabilities: agentCapabilitiesSchema,
  system: agentSystemInfoSchema.optional(),
  runtime: agentRuntimeInfoSchema.optional(),
  capacity: agentCapacitySchema.optional(),
  availability: z.object({
    status: z.enum(['online', 'busy']),
    current_job_id: z.string().optional(),
    source: z.string(),
  }).passthrough().optional(),
}).passthrough() satisfies z.ZodType<AuthMessage>;

const progressMessageSchema = z.object({
  type: z.literal('progress'),
  job_id: z.string(),
  step: z.number(),
  total_steps: z.number(),
  preview_base64: z.string().optional(),
  lease_id: z.string().optional(),
}).passthrough();

const pingMessageSchema = z.object({
  type: z.literal('ping'),
  timestamp_ms: z.number(),
  telemetry: agentTelemetrySchema.optional(),
}).passthrough() satisfies z.ZodType<PingMessage>;

const inventoryUpdateMessageSchema = z.object({
  type: z.literal('inventory_update'),
  capabilities: agentCapabilitiesSchema,
  system: agentSystemInfoSchema,
  runtime: agentRuntimeInfoSchema,
  capacity: agentCapacitySchema,
}).passthrough() satisfies z.ZodType<InventoryUpdateMessage>;

const availabilityUpdateMessageSchema = z.object({
  type: z.literal('availability_update'),
  status: z.enum(['online', 'busy']),
  current_job_id: z.string().optional(),
  source: z.string(),
}).passthrough();

const toolProgressMessageSchema = z.object({
  type: z.literal('tool_progress'),
  tool_id: z.string(),
  step: z.number(),
  total_steps: z.number(),
  message: z.string().optional(),
}).passthrough();

const modelPlanResultSchema = z.object({
  model_id: z.string(),
  state: z.enum(['installed', 'already_installed', 'failed', 'cancelled']),
  error: z.string().optional(),
}).passthrough();

const modelPlanEventMessageSchema = z.object({
  type: z.literal('model_plan_event'),
  plan_id: z.string(),
  attempt: z.number(),
  model_id: z.string().optional(),
  phase: z.string(),
  message: z.string().optional(),
}).passthrough();

const modelPlanResultMessageSchema = z.object({
  type: z.literal('model_plan_result'),
  plan_id: z.string(),
  attempt: z.number(),
  results: z.array(modelPlanResultSchema),
  installed_model_ids: z.array(z.string()),
}).passthrough();

const asrStreamEventMessageSchema = z.object({
  type: z.literal('asr_stream_event'),
  session_id: z.string(),
  event: unknownRecordSchema,
}).passthrough();

export const agentMessageSchema = z.discriminatedUnion('type', [
  authMessageSchema,
  progressMessageSchema,
  resultMessageSchema,
  pingMessageSchema,
  inventoryUpdateMessageSchema,
  availabilityUpdateMessageSchema,
  chatResponseMessageSchema,
  chatErrorMessageSchema,
  talkResponseMessageSchema,
  talkErrorMessageSchema,
  asrResponseMessageSchema,
  asrErrorMessageSchema,
  embedResponseMessageSchema,
  embedErrorMessageSchema,
  ocrResponseMessageSchema,
  ocrErrorMessageSchema,
  toolProgressMessageSchema,
  toolResultMessageSchema,
  toolErrorMessageSchema,
  graphEventMessageSchema,
  graphResultMessageSchema,
  graphErrorMessageSchema,
  modelPlanEventMessageSchema,
  modelPlanResultMessageSchema,
  asrStreamEventMessageSchema,
]) satisfies z.ZodType<AgentMessage>;

export { toolArtifactSchema };
