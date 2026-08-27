import { z } from 'zod';
import type {
  GraphErrorMessage,
  GraphEventMessage,
  GraphExecutionMetrics,
  GraphResultMessage,
  GraphRunArtifact,
  GraphRunEvent,
  SubmitGraphJobRequest,
  WorkflowAssetManifest,
  WorkflowGraphDocument,
  WorkflowJobManifest,
} from '../types';
import { unknownRecordSchema, workflowValueSchema } from './primitives';

const graphProviderSchema = z.object({
  id: z.string(),
  version: z.string(),
  catalog_sha256: z.string(),
  node_kinds: z.array(z.string()),
}).passthrough();

const workflowModelSchema = z.object({
  id: z.string(),
  repository: z.string().optional(),
  revision: z.string().optional(),
  catalog_sha256: z.string(),
  install_manifest_sha256: z.string().optional(),
}).passthrough();

const workflowRequirementsSchema = z.object({
  minimum_mere_run_version: z.string(),
  node_kinds: z.array(z.string()),
  model_ids: z.array(z.string()),
  models: z.array(workflowModelSchema).optional(),
  providers: z.array(graphProviderSchema).optional(),
  secret_names: z.array(z.string()).optional(),
  accelerator_backends: z.array(z.string()),
  minimum_accelerator_memory_bytes: z.number().optional(),
  minimum_system_memory_bytes: z.number().optional(),
  minimum_disk_bytes: z.number().optional(),
  minimum_cpu_cores: z.number().optional(),
  network_access: z.boolean().optional(),
  required_device_id: z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u).optional(),
}).passthrough();

export const workflowJobManifestSchema = z.object({
  contract_version: z.string(),
  job_id: z.string(),
  created_at: z.string(),
  graph_fingerprint: z.string(),
  input_fingerprint: z.string(),
  requirements: workflowRequirementsSchema,
  outputs: z.array(z.object({ name: z.string(), reference: z.string() }).passthrough()),
  execution_spec_sha256: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  identity: z.object({
    persona_id: z.string().min(1),
    version_id: z.string().min(1),
    deployment_id: z.string().min(1),
  }).passthrough().optional(),
  idempotency_key: z.string().min(1).max(160).optional(),
  webhook_url: z.string().url().max(2048).optional(),
  data_policy: z.literal('local-custody.v1').optional(),
}).passthrough() satisfies z.ZodType<WorkflowJobManifest>;

const workflowInputDefinitionSchema = z.object({
  type: z.enum([
    'string', 'integer', 'number', 'boolean', 'enum', 'json', 'asset',
    'asset_directory', 'asset_collection', 'asset_array',
  ]),
  required: z.boolean().optional(),
  default: workflowValueSchema.optional(),
  values: z.array(z.string()).optional(),
  content_types: z.array(z.string()).optional(),
}).passthrough();

const workflowGraphNodeSchema = z.object({
  id: z.string(),
  kind: z.string(),
  provider: z.string().optional(),
  arguments: z.record(z.string(), workflowValueSchema),
  depends_on: z.array(z.string()).optional(),
  execution: z.object({
    max_attempts: z.number().optional(),
    timeout_seconds: z.number().optional(),
    cache: z.enum(['auto', 'never', 'refresh']).optional(),
  }).passthrough().optional(),
}).passthrough();

export const workflowGraphDocumentSchema = z.object({
  schema_version: z.number(),
  kind: z.string(),
  name: z.string(),
  inputs: z.record(z.string(), workflowInputDefinitionSchema),
  nodes: z.array(workflowGraphNodeSchema),
  outputs: z.record(z.string(), workflowValueSchema),
  execution: z.object({ max_parallel_nodes: z.number().optional() }).passthrough().optional(),
  metadata: z.record(z.string(), workflowValueSchema).optional(),
}).passthrough() satisfies z.ZodType<WorkflowGraphDocument>;

export const workflowAssetManifestSchema = z.object({
  schema_version: z.number(),
  groups: z.array(z.object({
    name: z.string(),
    kind: z.enum(['asset', 'asset_directory']),
    entries: z.array(z.object({
      path: z.string(),
      digest: z.string(),
      size_bytes: z.number(),
      content_type: z.string(),
    }).passthrough()),
  }).passthrough()),
}).passthrough() satisfies z.ZodType<WorkflowAssetManifest>;

export const submitGraphJobRequestSchema = z.object({
  job: workflowJobManifestSchema,
  graph: workflowGraphDocumentSchema,
  inputs: z.record(z.string(), workflowValueSchema),
  assets: workflowAssetManifestSchema,
  bundle_documents: z.record(z.string(), z.string()).optional(),
  client_id: z.string().optional(),
  relay_origin: z.string().optional(),
}).passthrough() satisfies z.ZodType<SubmitGraphJobRequest>;

export const graphRunEventSchema = z.object({
  sequence: z.number(),
  created_at: z.string(),
  type: z.string(),
  state: z.enum(['planned', 'preflighting', 'queued', 'assigned', 'running', 'finished', 'failed', 'cancelled']),
  node_id: z.string().optional(),
  phase: z.string().optional(),
  message: z.string().optional(),
}).passthrough() satisfies z.ZodType<GraphRunEvent>;

export const graphRunArtifactSchema = z.object({
  name: z.string(),
  kind: z.string(),
  path: z.string(),
  content_type: z.string(),
  size_bytes: z.number(),
  sha256: z.string(),
}).passthrough() satisfies z.ZodType<GraphRunArtifact>;

export const graphExecutionMetricsSchema = z.object({
  bundle_bytes_downloaded: z.number(),
  download_ms: z.number(),
  execution_ms: z.number(),
  upload_ms: z.number(),
  total_ms: z.number(),
  artifact_bytes_uploaded: z.number(),
  artifact_parts_uploaded: z.number(),
  artifact_bytes_reused: z.number(),
  artifact_parts_reused: z.number(),
}).passthrough() satisfies z.ZodType<GraphExecutionMetrics>;

export const graphEventMessageSchema = z.object({
  type: z.literal('graph_event'),
  job_id: z.string(),
  owner_user_id: z.string().optional(),
  assignment_token: z.string().regex(/^[a-f0-9]{32}$/u).optional(),
  event: graphRunEventSchema,
}).passthrough() satisfies z.ZodType<GraphEventMessage>;

export const graphResultMessageSchema = z.object({
  type: z.literal('graph_result'),
  job_id: z.string(),
  owner_user_id: z.string().optional(),
  assignment_token: z.string().regex(/^[a-f0-9]{32}$/u).optional(),
  run_manifest: unknownRecordSchema,
  artifacts: z.array(graphRunArtifactSchema),
  metrics: graphExecutionMetricsSchema.optional(),
}).passthrough() satisfies z.ZodType<GraphResultMessage>;

export const graphErrorMessageSchema = z.object({
  type: z.literal('graph_error'),
  job_id: z.string(),
  owner_user_id: z.string().optional(),
  assignment_token: z.string().regex(/^[a-f0-9]{32}$/u).optional(),
  error: z.string(),
}).passthrough() satisfies z.ZodType<GraphErrorMessage>;

export const runManifestSchema = unknownRecordSchema;
