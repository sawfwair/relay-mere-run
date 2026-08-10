// Environment bindings
export interface Env {
  MERE_RUN_RELAY: DurableObjectNamespace;
  IMAGES: R2Bucket;
  ASSETS?: Fetcher;
  MERE_RUN_WEB_URL: string;
  MERE_RUN_ASSET_BASE_URL: string;
  BROKER_ORIGIN: string;
  // Plain string when set as a var/worker-secret; a Secrets Store binding hands
  // over a { get() } accessor instead — signWebhookPayload() resolves both.
  WEBHOOK_SIGNING_SECRET: string | { get(): Promise<string> };
  WEBHOOK_TIMEOUT_MS: string;
  WEBHOOK_MAX_ATTEMPTS: string;
  GRAPH_MAX_ACTIVE_JOBS?: string;
  GRAPH_MAX_ACCOUNT_STORAGE_BYTES?: string;
  GRAPH_MAX_JOB_INPUT_BYTES?: string;
  GRAPH_MAX_JOB_OUTPUT_BYTES?: string;
  GRAPH_JOB_RETENTION_DAYS?: string;
  GRAPH_STALE_JOB_SECONDS?: string;
  GRAPH_MAINTENANCE_INTERVAL_SECONDS?: string;
  ASR_STREAMING_ENABLED?: string;
  ASR_STREAM_TICKET_SECRET?: string | { get(): Promise<string> };
}

// Agent capabilities reported on connect
export interface AgentCapabilities {
  models: string[];
  max_resolution: number;
  controlnet: boolean;
  lora: boolean;
  text_adapters?: TextAdapterCapability[];
  img2img: boolean;
  plugins?: PluginCapability[];
  graph_worker?: GraphWorkerCapabilities;
  asr_streaming?: AsrStreamingCapabilities;
}

export interface TextAdapterCapability {
  manifest_sha256: string;
  base_model_id: string;
}

export interface AsrStreamingCapabilities {
  protocols: number[];
  input_formats: string[];
  max_sessions: number;
  backends?: AsrBackend[];
}

export type AsrBackend = 'auto' | 'parakeet' | 'qwen';

export interface GraphWorkerCapabilities {
  schema_version: number;
  worker_version: string;
  contract_versions: string[];
  platform: string;
  architecture: string;
  accelerator_backend: string;
  memory_bytes: number;
  system_memory_bytes?: number;
  logical_cpu_cores?: number;
  available_disk_bytes?: number;
  network_access?: boolean;
  node_kinds: string[];
  installed_model_ids: string[];
  available_secret_names?: string[];
  cached_asset_digests?: string[];
  providers: GraphProviderCapability[];
  /** The authoritative `mere.run graph catalog --json` document from the node. */
  catalog?: Record<string, unknown>;
}

export interface GraphProviderCapability {
  id: string;
  version: string;
  catalog_sha256: string;
  node_kinds: string[];
}

export type AcceleratorBackend = 'metal' | 'cuda' | 'rocm' | 'cpu' | 'unknown';
export type PowerSource = 'ac' | 'external' | 'battery' | 'unknown';
export type ThermalState = 'nominal' | 'fair' | 'serious' | 'critical' | 'unknown';
export type ModelInventoryStatus = 'reported' | 'empty' | 'unavailable' | 'failed';
export type RuntimeDiagnostic =
  | 'mere_run_not_found'
  | 'version_command_unavailable'
  | 'version_command_failed'
  | 'version_output_empty'
  | 'inventory_commands_failed';

export interface AgentAcceleratorInfo {
  backend: AcceleratorBackend;
  name: string;
  memory_total_bytes?: number;
  index?: number;
}

export interface AgentSystemInfo {
  platform: string;
  architecture: string;
  os_version?: string;
  hostname?: string;
  cpu_model?: string;
  logical_cores?: number;
  memory_total_bytes?: number;
  accelerators: AgentAcceleratorInfo[];
}

export interface AgentRuntimeInfo {
  mere_run_version?: string;
  installed_models: string[];
  inventory_status?: ModelInventoryStatus;
  diagnostic?: RuntimeDiagnostic;
}

export interface AgentCapacity {
  max_concurrent_jobs: number;
  lease_protocol?: boolean;
}

export interface AgentTelemetry {
  sampled_at: string;
  cpu_load_percent?: number;
  memory_available_bytes?: number;
  accelerator_utilization_percent?: number;
  accelerator_memory_used_bytes?: number;
  accelerator_memory_total_bytes?: number;
  power_source?: PowerSource;
  battery_percent?: number;
  low_power_mode?: boolean;
  thermal_state?: ThermalState;
}

export interface FleetNodePolicy {
  enabled: boolean;
  draining: boolean;
  revoked: boolean;
  priority: number;
  preferred_models: string[];
  display_name: string | null;
}

export interface ModelPerformance {
  successes: number;
  failures: number;
  average_generation_time_ms: number | null;
  last_generation_time_ms: number | null;
  updated_at: string;
}

export interface FleetNodePerformance {
  models: Record<string, ModelPerformance>;
}

export type FleetNodeStatus = 'online' | 'busy' | 'offline' | 'disabled' | 'draining' | 'revoked';

export interface FleetNodeRecord {
  agent_id: string;
  device_id: string;
  device_name: string;
  reported_name: string;
  version: string;
  status: FleetNodeStatus;
  current_job_id: string | null;
  first_seen: string;
  last_seen: string;
  connected_at: string | null;
  capabilities: AgentCapabilities;
  system?: AgentSystemInfo;
  runtime?: AgentRuntimeInfo;
  capacity?: AgentCapacity;
  telemetry?: AgentTelemetry;
  policy: FleetNodePolicy;
  performance: FleetNodePerformance;
}

export type SchedulerMode = 'balanced' | 'fastest' | 'efficient';

export interface FleetSettings {
  scheduler_mode: SchedulerMode;
  retry_limit: number;
  updated_at: string;
}

export interface FleetActivity {
  id: string;
  kind: 'image' | 'music' | 'video' | 'chat' | 'talk' | 'asr' | 'embed' | 'ocr' | 'tool' | 'graph';
  status: string;
  agent_id: string | null;
  model?: string;
  label: string;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  duration_ms: number | null;
  error: string | null;
}

export interface FleetModelCoverage {
  model: string;
  capable_nodes: number;
  available_nodes: number;
  fastest_average_ms: number | null;
}

export interface FleetSnapshot {
  generated_at: string;
  settings: FleetSettings;
  summary: {
    total_nodes: number;
    online_nodes: number;
    busy_nodes: number;
    available_nodes: number;
    queue_depth: number;
    installed_models: number;
    routable_models: number;
  };
  nodes: FleetNodeRecord[];
  models: FleetModelCoverage[];
  activity: FleetActivity[];
}

export type FleetModelPlanState = 'planned' | 'applying' | 'finished' | 'failed' | 'cancelled';
export type FleetModelTargetState =
  | 'ready'
  | 'noop'
  | 'offline'
  | 'applying'
  | 'finished'
  | 'failed'
  | 'cancelled';
export type FleetModelResultState = 'installed' | 'already_installed' | 'failed' | 'cancelled';

export interface FleetModelApplyResult {
  model_id: string;
  state: FleetModelResultState;
  error?: string;
}

export interface FleetModelPlanEvent {
  sequence: number;
  created_at: string;
  device_id: string;
  model_id?: string;
  phase: string;
  message?: string;
}

export interface FleetModelPlanTarget {
  device_id: string;
  device_name: string;
  installed_model_ids: string[];
  missing_model_ids: string[];
  state: FleetModelTargetState;
  results: FleetModelApplyResult[];
  error: string | null;
  started_at: string | null;
  completed_at: string | null;
}

export interface FleetModelPlan {
  schema_version: 1;
  kind: 'mere.run/fleet-model-plan';
  plan_id: string;
  source_device_id: string | null;
  model_ids: string[];
  targets: FleetModelPlanTarget[];
  events: FleetModelPlanEvent[];
  attempt: number;
  state: FleetModelPlanState;
  created_at: string;
  updated_at: string;
  applied_at: string | null;
  completed_at: string | null;
}

export interface SubmitFleetModelPlanRequest {
  source_device_id?: string;
  target_device_ids: string[];
  model_ids?: string[];
}

export interface ApplyFleetModelPlanRequest {
  accept_model_licenses?: boolean;
}

export interface PluginCapability {
  name: string;
  version?: string;
  executable?: string;
  description?: string;
  commands: string[];
  capabilities: string[];
}

// Agent info tracked by relay
export interface AgentInfo {
  agent_id: string;
  device_id: string;
  device_name: string;
  version: string;
  capabilities: AgentCapabilities;
  status: 'online' | 'busy';
  current_job_id: string | null;
  connected_at: string;
  last_ping: string;
  system?: AgentSystemInfo;
  runtime?: AgentRuntimeInfo;
  capacity?: AgentCapacity;
  telemetry?: AgentTelemetry;
  policy?: FleetNodePolicy;
  performance?: FleetNodePerformance;
}

// Generation request parameters
export interface JobRequest {
  kind?: 'image' | 'music' | 'video';
  prompt: string;
  negative_prompt: string | null;
  width: number;
  height: number;
  steps: number;
  seed: number | null;
  input_image_url: string | null;
  input_image_data: string | null; // base64 JPEG for img2img
  input_strength: number | null;
  // Identity-locking reference images (character refs), passed to the model as
  // --ref-image. Distinct from input_image_* (img2img). URLs the agent fetches.
  reference_image_urls: string[] | null;
  model?: string;
  duration_seconds?: number;
  fps?: number;
  num_frames?: number;
  lyrics?: string;
  // Source audio for native audio-to-video lanes (LTX 2.3 A2Vid). The agent
  // downloads the URL and passes it to the runtime with the segment start.
  input_audio_url?: string;
  audio_start_seconds?: number;
  audio_end_seconds?: number;
  // Optional end keyframe (video only): conditions the final frame. The agent
  // downloads the URL and passes it as --end-image. Requires a URL or inline
  // start image; strength is bounded to the inclusive range 0...1.
  end_image_url?: string;
  end_image_strength?: number;
}

// Job tracked by relay
export interface Job {
  job_id: string;
  user_id: string;
  client_id: string;
  agent_id: string | null;
  status: 'queued' | 'assigned' | 'generating' | 'complete' | 'failed' | 'cancelled';
  request: JobRequest;
  progress: { step: number; total_steps: number } | null;
  result: {
    image_url?: string;
    image_data?: string;
    media_url?: string;
    media_data?: string;
    content_type?: string;
    output_kind?: 'image' | 'music' | 'video';
    seed: number;
    generation_time_ms: number;
  } | null;
  error: string | null;
  created_at: string;
  assigned_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  upload_url: string;
  direct_image: boolean;
  webhook_url: string | null;
  webhook_sent: boolean;
  attempts: number;
  max_attempts: number;
  lease_id: string | null;
  lease_aware: boolean;
}

// MARK: - Tool/Plugin Types

export interface ToolInputAsset {
  name?: string;
  url?: string;
  path?: string;
  content_type?: string;
  metadata?: Record<string, unknown>;
}

export interface ToolRequest {
  plugin: string;
  command: string;
  inputs: Record<string, unknown>;
  options: Record<string, unknown>;
  assets?: ToolInputAsset[];
}

export interface ToolArtifact {
  name: string;
  kind: string;
  label?: string;
  content_type: string;
  url?: string;
  bytes?: number;
  sha256?: string;
  metadata?: Record<string, unknown>;
}

export interface Tool {
  tool_id: string;
  user_id: string;
  client_id: string;
  agent_id: string | null;
  status: 'queued' | 'processing' | 'complete' | 'failed' | 'cancelled';
  request: ToolRequest;
  progress: { step: number; total_steps: number; message?: string } | null;
  result: {
    artifacts: ToolArtifact[];
    run_manifest?: Record<string, unknown>;
    summary?: Record<string, unknown>;
  } | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  upload_url_base: string;
  webhook_url: string | null;
  webhook_sent: boolean;
}

// MARK: - Portable Graph Jobs

export type GraphRunState =
  | 'planned'
  | 'preflighting'
  | 'queued'
  | 'assigned'
  | 'running'
  | 'finished'
  | 'failed'
  | 'cancelled';

export type WorkflowValue =
  | null
  | string
  | number
  | boolean
  | WorkflowValue[]
  | { [key: string]: WorkflowValue };

export interface WorkflowGraphNode {
  id: string;
  kind: string;
  provider?: string;
  arguments: Record<string, WorkflowValue>;
  depends_on?: string[];
  execution?: {
    max_attempts?: number;
    timeout_seconds?: number;
    cache?: 'auto' | 'never' | 'refresh';
  };
}

export type WorkflowInputType =
  | 'string'
  | 'integer'
  | 'number'
  | 'boolean'
  | 'enum'
  | 'json'
  | 'asset'
  | 'asset_directory'
  | 'asset_collection'
  | 'asset_array';

export interface WorkflowInputDefinition {
  type: WorkflowInputType;
  required?: boolean;
  default?: WorkflowValue;
  values?: string[];
  content_types?: string[];
}

export interface WorkflowGraphDocument {
  schema_version: number;
  kind: string;
  name: string;
  inputs: Record<string, WorkflowInputDefinition>;
  nodes: WorkflowGraphNode[];
  outputs: Record<string, WorkflowValue>;
  execution?: { max_parallel_nodes?: number };
  metadata?: Record<string, WorkflowValue>;
}

export interface WorkflowJobRequirements {
  minimum_mere_run_version: string;
  node_kinds: string[];
  model_ids: string[];
  models?: WorkflowModelProvenance[];
  providers?: GraphProviderCapability[];
  secret_names?: string[];
  accelerator_backends: string[];
  minimum_accelerator_memory_bytes?: number;
  minimum_system_memory_bytes?: number;
  minimum_disk_bytes?: number;
  minimum_cpu_cores?: number;
  network_access?: boolean;
  required_device_id?: string;
}

export interface WorkflowModelProvenance {
  id: string;
  repository?: string;
  revision?: string;
  catalog_sha256: string;
  install_manifest_sha256?: string;
}

export interface WorkflowJobManifest {
  contract_version: string;
  job_id: string;
  created_at: string;
  graph_fingerprint: string;
  input_fingerprint: string;
  requirements: WorkflowJobRequirements;
  outputs: Array<{ name: string; reference: string }>;
  execution_spec_sha256?: string;
  identity?: IdentityExecutionReference;
  idempotency_key?: string;
  webhook_url?: string;
}

export interface WorkflowAssetEntry {
  path: string;
  digest: string;
  size_bytes: number;
  content_type: string;
}

export interface WorkflowAssetManifest {
  schema_version: number;
  groups: Array<{
    name: string;
    kind: 'asset' | 'asset_directory';
    entries: WorkflowAssetEntry[];
  }>;
}

export interface GraphRunArtifact {
  name: string;
  kind: string;
  path: string;
  content_type: string;
  size_bytes: number;
  sha256: string;
}

export interface GraphArtifactPart {
  index: number;
  size_bytes: number;
  sha256: string;
}

export interface GraphArtifactUpload {
  sha256: string;
  size_bytes: number;
  object_name?: string;
  part_count: number;
  parts: GraphArtifactPart[];
}

export interface GraphRunEvent {
  sequence: number;
  created_at: string;
  type: string;
  state: GraphRunState;
  node_id?: string;
  phase?: string;
  message?: string;
}

export interface GraphJob {
  job_id: string;
  user_id: string;
  client_id: string;
  agent_id: string | null;
  state: GraphRunState;
  job: WorkflowJobManifest;
  graph: WorkflowGraphDocument;
  inputs: Record<string, WorkflowValue>;
  assets: WorkflowAssetManifest;
  missing_asset_digests: string[];
  events: GraphRunEvent[];
  last_event_sequence?: number;
  artifacts: GraphRunArtifact[];
  artifact_uploads: Record<string, GraphArtifactUpload>;
  run_manifest: Record<string, unknown> | null;
  metrics: GraphExecutionMetrics | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  assigned_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  attempt: number;
  max_attempts: number;
  node_token: string;
  relay_origin: string;
  execution_receipt?: RelayExecutionReceipt;
  request_sha256?: string;
  assigned_device_id?: string;
  webhook_url?: string | null;
  webhook_sent?: boolean;
}

export interface GraphExecutionMetrics {
  bundle_bytes_downloaded: number;
  download_ms: number;
  execution_ms: number;
  upload_ms: number;
  total_ms: number;
  artifact_bytes_uploaded: number;
  artifact_parts_uploaded: number;
  artifact_bytes_reused: number;
  artifact_parts_reused: number;
}

export interface GraphPlacementBlocker {
  code: string;
  message: string;
}

export interface GraphPlacementNode {
  agent_id: string;
  device_id: string;
  device_name: string;
  status: AgentInfo['status'];
  eligible: boolean;
  blockers: GraphPlacementBlocker[];
  cached_input_bytes: number;
  total_input_bytes: number;
}

export interface GraphPlacementReport {
  connected_nodes: number;
  graph_worker_nodes: number;
  eligible_nodes: number;
  diagnostic: string | null;
  nodes: GraphPlacementNode[];
}

export interface SubmitGraphJobRequest {
  job: WorkflowJobManifest;
  graph: WorkflowGraphDocument;
  inputs: Record<string, WorkflowValue>;
  assets: WorkflowAssetManifest;
  bundle_documents?: Record<string, string>;
  client_id?: string;
  relay_origin?: string;
}

export interface GraphBundleFile {
  path: string;
  url: string;
  sha256: string;
  size_bytes: number;
}

export interface GraphRequestMessage {
  type: 'graph_request';
  job_id: string;
  client_id: string;
  owner_user_id: string;
  bundle_files: GraphBundleFile[];
  upload_url_base: string;
}

export interface GraphEventMessage {
  type: 'graph_event';
  job_id: string;
  owner_user_id?: string;
  event: GraphRunEvent;
}

export interface GraphResultMessage {
  type: 'graph_result';
  job_id: string;
  owner_user_id?: string;
  run_manifest: Record<string, unknown>;
  artifacts: GraphRunArtifact[];
  metrics?: GraphExecutionMetrics;
}

export interface GraphErrorMessage {
  type: 'graph_error';
  job_id: string;
  owner_user_id?: string;
  error: string;
}

export interface GraphCancelMessage {
  type: 'graph_cancel';
  job_id: string;
}

// WebSocket messages: Agent → Relay
export interface AuthMessage {
  type: 'auth';
  device_id: string;
  device_name: string;
  version: string;
  capabilities: AgentCapabilities;
  system?: AgentSystemInfo;
  runtime?: AgentRuntimeInfo;
  capacity?: AgentCapacity;
  availability?: {
    status: 'online' | 'busy';
    current_job_id?: string;
    source: string;
  };
}

export interface ProgressMessage {
  type: 'progress';
  job_id: string;
  step: number;
  total_steps: number;
  preview_base64?: string;
  lease_id?: string;
}

export interface ResultMessage {
  type: 'result';
  job_id: string;
  owner_user_id?: string; // For cross-DO routing
  success: boolean;
  image_url?: string;
  image_data?: string; // base64 PNG when direct_image is true
  media_url?: string;
  media_data?: string;
  content_type?: string;
  output_kind?: 'image' | 'music' | 'video';
  seed?: number;
  generation_time_ms?: number;
  error?: string;
  lease_id?: string;
}

export interface ToolProgressMessage {
  type: 'tool_progress';
  tool_id: string;
  step: number;
  total_steps: number;
  message?: string;
}

export interface ToolResultMessage {
  type: 'tool_result';
  tool_id: string;
  owner_user_id?: string;
  artifacts: ToolArtifact[];
  run_manifest?: Record<string, unknown>;
  summary?: Record<string, unknown>;
}

export interface ToolErrorMessage {
  type: 'tool_error';
  tool_id: string;
  owner_user_id?: string;
  error: string;
}

export interface PingMessage {
  type: 'ping';
  timestamp_ms: number;
  telemetry?: AgentTelemetry;
}

export interface InventoryUpdateMessage {
  type: 'inventory_update';
  capabilities: AgentCapabilities;
  system: AgentSystemInfo;
  runtime: AgentRuntimeInfo;
  capacity: AgentCapacity;
}

export interface AvailabilityUpdateMessage {
  type: 'availability_update';
  status: 'online' | 'busy';
  current_job_id?: string;
  source: string;
}

export interface AsrStreamEventMessage {
  type: 'asr_stream_event';
  session_id: string;
  event: Record<string, unknown>;
}

export interface ModelPlanEventMessage {
  type: 'model_plan_event';
  plan_id: string;
  attempt: number;
  model_id?: string;
  phase: string;
  message?: string;
}

export interface ModelPlanResultMessage {
  type: 'model_plan_result';
  plan_id: string;
  attempt: number;
  results: FleetModelApplyResult[];
  installed_model_ids: string[];
}

export type AgentMessage =
  | AuthMessage
  | ProgressMessage
  | ResultMessage
  | ToolProgressMessage
  | ToolResultMessage
  | ToolErrorMessage
  | GraphEventMessage
  | GraphResultMessage
  | GraphErrorMessage
  | InventoryUpdateMessage
  | AvailabilityUpdateMessage
  | AsrStreamEventMessage
  | ModelPlanEventMessage
  | ModelPlanResultMessage
  | PingMessage
  | ChatResponseMessage
  | ChatErrorMessage
  | TalkResponseMessage
  | TalkErrorMessage
  | AsrResponseMessage
  | AsrErrorMessage
  | EmbedResponseMessage
  | EmbedErrorMessage
  | OcrResponseMessage
  | OcrErrorMessage;

// WebSocket messages: Relay → Agent
export interface AuthResultMessage {
  type: 'auth_result';
  success: boolean;
  agent_id: string;
  user_id: string;
}

export interface JobMessage {
  type: 'job';
  job_id: string;
  lease_id: string;
  client_id: string;
  owner_user_id: string; // Job owner's userId for result routing
  upload_url: string;
  direct_image: boolean; // if true, agent sends base64 instead of uploading
  request: JobRequest;
}

export interface ToolRequestMessage {
  type: 'tool_request';
  tool_id: string;
  client_id: string;
  owner_user_id: string;
  upload_url_base: string;
  request: ToolRequest;
}

export interface CancelMessage {
  type: 'cancel';
  job_id: string;
}

export interface TalkCancelMessage {
  type: 'talk_cancel';
  talk_id: string;
}

export interface AsrCancelMessage {
  type: 'asr_cancel';
  asr_id: string;
}

export interface EmbedCancelMessage {
  type: 'embed_cancel';
  embed_id: string;
}

export interface OcrCancelMessage {
  type: 'ocr_cancel';
  ocr_id: string;
}

export interface ToolCancelMessage {
  type: 'tool_cancel';
  tool_id: string;
}

export interface DisconnectMessage {
  type: 'disconnect';
  reason: string;
}

export interface PongMessage {
  type: 'pong';
}

export interface InventoryRequestMessage {
  type: 'inventory_request';
}

export interface ModelPlanRequestMessage {
  type: 'model_plan_request';
  plan_id: string;
  attempt: number;
  model_ids: string[];
  accept_model_licenses: boolean;
}

export interface ModelPlanCancelMessage {
  type: 'model_plan_cancel';
  plan_id: string;
}

export type RelayMessage =
  | AuthResultMessage
  | JobMessage
  | CancelMessage
  | TalkCancelMessage
  | AsrCancelMessage
  | EmbedCancelMessage
  | OcrCancelMessage
  | ToolCancelMessage
  | DisconnectMessage
  | PongMessage
  | InventoryRequestMessage
  | ModelPlanRequestMessage
  | ModelPlanCancelMessage
  | ChatRequestMessage
  | ChatCancelMessage
  | TalkRequestMessage
  | AsrRequestMessage
  | EmbedRequestMessage
  | OcrRequestMessage
  | ToolRequestMessage
  | GraphRequestMessage
  | GraphCancelMessage;

// HTTP API request/response types
export interface SubmitJobRequest {
  kind?: 'image' | 'music' | 'video';
  prompt: string;
  negative_prompt?: string;
  width?: number;
  height?: number;
  steps?: number;
  seed?: number;
  input_image_url?: string;
  input_image_data?: string; // base64 JPEG for img2img
  input_strength?: number;
  reference_image_urls?: string[]; // identity-locking refs, passed as --ref-image
  agent_id?: string;
  webhook_url?: string;
  direct_image?: boolean; // if true, return base64 instead of R2 URL
  model?: string;
  duration_seconds?: number;
  fps?: number;
  num_frames?: number;
  lyrics?: string;
  input_audio_url?: string;
  audio_start_seconds?: number;
  audio_end_seconds?: number;
  // Optional end keyframe for video. Requires a URL or inline start image;
  // strength is bounded to the inclusive range 0...1.
  end_image_url?: string;
  end_image_strength?: number;
}

export type SubmitVideoRequest = SubmitJobRequest;
export type SubmitMusicRequest = SubmitJobRequest;

export interface StatusResponse {
  agents: Array<{
    agent_id: string;
    device_name: string;
    status: 'online' | 'busy' | 'offline';
    last_seen: string;
    current_job_id: string | null;
    capabilities: AgentCapabilities;
  }>;
  queue_depth: number;
}

export interface SubmitJobResponse {
  job_id: string;
  status: 'assigned' | 'queued';
  agent_id?: string;
  position?: number;
  estimated_time_ms: number;
}

export interface JobStatusResponse {
  job_id: string;
  user_id: string;
  client_id: string;
  agent_id: string | null;
  status: Job['status'];
  request: JobRequest;
  progress: { step: number; total_steps: number } | null;
  result: Job['result'];
  error: string | null;
  created_at: string;
  assigned_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  direct_image: boolean;
}

export interface SubmitToolRequest {
  plugin?: string;
  command: string;
  inputs?: Record<string, unknown>;
  options?: Record<string, unknown>;
  assets?: ToolInputAsset[];
  agent_id?: string;
  webhook_url?: string;
}

export interface SubmitToolResponse {
  tool_id: string;
  status: 'assigned' | 'queued';
  agent_id?: string;
  position?: number;
  estimated_time_ms: number;
}

export interface ToolStatusResponse {
  tool_id: string;
  user_id: string;
  client_id: string;
  agent_id: string | null;
  status: Tool['status'];
  request: ToolRequest;
  progress: Tool['progress'];
  result: Tool['result'];
  error: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

// Auth result from hosted relay account authentication
export interface AuthResult {
  user_id: string;
  email?: string;
  name?: string;
}

// MARK: - Chat Types

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  image_url?: string;
}

export interface TextAdapterReference {
  manifest_sha256: string;
  base_model_id: string;
  scale?: number;
}

export interface IdentityExecutionReference {
  persona_id: string;
  version_id: string;
  deployment_id: string;
}

export interface RelayExecutionReceipt {
  schema: 'relay.execution-receipt.v1';
  execution_id: string;
  request_sha256: string;
  execution_spec_sha256?: string;
  model_id: string;
  adapter_manifest_sha256?: string;
  provider_id: string;
  provider_version?: string;
  provider_catalog_sha256?: string;
  device_id?: string;
  started_at: string | null;
  completed_at: string;
  duration_ms?: number;
  state: 'complete' | 'failed' | 'cancelled';
  output_sha256?: string;
  error_code?: string;
}

export interface Chat {
  chat_id: string;
  user_id: string;
  client_id: string;
  agent_id: string | null;
  status: 'queued' | 'processing' | 'complete' | 'failed' | 'cancelled';
  messages: ChatMessage[];
  max_tokens?: number;
  temperature?: number;
  requires_json?: boolean;
  use_lora?: boolean;
  adapter?: TextAdapterReference;
  required_device_id?: string;
  execution_spec_sha256?: string;
  identity?: IdentityExecutionReference;
  idempotency_key?: string;
  request_sha256: string;
  model?: string;
  response: string | null;
  tokens_generated: number | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  execution_receipt: RelayExecutionReceipt | null;
}

// WebSocket messages: Relay → Agent (Chat)
export interface ChatRequestMessage {
  type: 'chat_request';
  chat_id: string;
  client_id: string;
  messages: ChatMessage[];
  max_tokens?: number;
  temperature?: number;
  requires_json?: boolean;
  use_lora?: boolean;
  adapter?: TextAdapterReference;
  model?: string;
}

export interface ChatCancelMessage {
  type: 'chat_cancel';
  chat_id: string;
}

// WebSocket messages: Agent → Relay (Chat)
export interface ChatResponseMessage {
  type: 'chat_response';
  chat_id: string;
  response: string;
  tokens_generated?: number;
}

export interface ChatErrorMessage {
  type: 'chat_error';
  chat_id: string;
  error: string;
}

// HTTP API types for chat
export interface SubmitChatRequest {
  messages: ChatMessage[];
  max_tokens?: number;
  temperature?: number;
  requires_json?: boolean;
  use_lora?: boolean;
  adapter?: TextAdapterReference;
  required_device_id?: string;
  execution_spec_sha256?: string;
  identity?: IdentityExecutionReference;
  idempotency_key?: string;
  model?: string;
}

export interface SubmitChatResponse {
  chat_id: string;
  status: 'assigned' | 'queued' | 'complete' | 'failed' | 'cancelled';
  agent_id?: string;
  position?: number;
}

export interface ChatStatusResponse {
  chat_id: string;
  user_id: string;
  client_id: string;
  agent_id: string | null;
  status: Chat['status'];
  messages: ChatMessage[];
  response: string | null;
  tokens_generated: number | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  execution_receipt: RelayExecutionReceipt | null;
}

// MARK: - Talk/TTS Types

export interface TalkRequest {
  text: string;
  voice_description: string | null;
  speed: number;
  temperature: number;
  output_format: 'wav';
}

export interface Talk {
  talk_id: string;
  user_id: string;
  client_id: string;
  agent_id: string | null;
  status: 'queued' | 'processing' | 'complete' | 'failed' | 'cancelled';
  request: TalkRequest;
  result: {
    audio_url?: string;
    audio_data?: string;
    duration_seconds: number;
    sample_rate: number;
    output_format: 'wav';
  } | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  upload_url: string;
  direct_audio: boolean;
}

// WebSocket messages: Relay → Agent (Talk/TTS)
export interface TalkRequestMessage {
  type: 'talk_request';
  talk_id: string;
  client_id: string;
  owner_user_id: string;
  upload_url: string;
  direct_audio: boolean;
  request: TalkRequest;
}

// WebSocket messages: Agent → Relay (Talk/TTS)
export interface TalkResponseMessage {
  type: 'talk_response';
  talk_id: string;
  owner_user_id?: string;
  audio_url?: string;
  audio_data?: string;
  duration_seconds?: number;
  sample_rate?: number;
  output_format?: 'wav';
}

export interface TalkErrorMessage {
  type: 'talk_error';
  talk_id: string;
  owner_user_id?: string;
  error: string;
}

// HTTP API types for talk/tts
export interface SubmitTalkRequest {
  text: string;
  voice_description?: string;
  speed?: number;
  temperature?: number;
  output_format?: 'wav';
  direct_audio?: boolean;
}

export interface SubmitTalkResponse {
  talk_id: string;
  status: 'assigned' | 'queued';
  agent_id?: string;
  position?: number;
}

export interface TalkStatusResponse {
  talk_id: string;
  user_id: string;
  client_id: string;
  agent_id: string | null;
  status: Talk['status'];
  request: TalkRequest;
  result: Talk['result'];
  error: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  direct_audio: boolean;
}

// MARK: - ASR Types

export interface AsrRequest {
  audio_url: string;
  language: string | null;
  task: 'transcribe' | 'translate';
  backend?: AsrBackend;
  diarize: boolean;
  max_tokens: number;
}

export interface AsrTokenAlignment {
  id?: number;
  text: string;
  start_seconds: number;
  duration_seconds: number;
  end_seconds: number;
}

export interface AsrSentenceAlignment {
  text: string;
  start_seconds: number;
  duration_seconds: number;
  end_seconds: number;
  tokens: AsrTokenAlignment[];
}

export interface AsrSpeakerSegment {
  speaker: string;
  speaker_index: number;
  start_seconds: number;
  end_seconds: number;
  duration_seconds: number;
}

export interface Asr {
  asr_id: string;
  user_id: string;
  client_id: string;
  agent_id: string | null;
  status: 'queued' | 'processing' | 'complete' | 'failed' | 'cancelled';
  request: AsrRequest;
  result: {
    text: string;
    language: string | null;
    duration_seconds: number;
    token_alignments?: AsrTokenAlignment[];
    sentence_alignments?: AsrSentenceAlignment[];
    speaker_segments?: AsrSpeakerSegment[];
  } | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  webhook_url: string | null;
  webhook_sent: boolean;
}

// WebSocket messages: Relay → Agent (ASR)
export interface AsrRequestMessage {
  type: 'asr_request';
  asr_id: string;
  client_id: string;
  owner_user_id: string;
  request: AsrRequest;
}

// WebSocket messages: Agent → Relay (ASR)
export interface AsrResponseMessage {
  type: 'asr_response';
  asr_id: string;
  owner_user_id?: string;
  text: string;
  language?: string;
  duration_seconds?: number;
  token_alignments?: AsrTokenAlignment[];
  sentence_alignments?: AsrSentenceAlignment[];
  speaker_segments?: AsrSpeakerSegment[];
}

export interface AsrErrorMessage {
  type: 'asr_error';
  asr_id: string;
  owner_user_id?: string;
  error: string;
}

// HTTP API types for ASR
export interface SubmitAsrRequest {
  audio_url: string;
  language?: string;
  task?: 'transcribe' | 'translate';
  backend?: AsrBackend;
  diarize?: boolean;
  max_tokens?: number;
  webhook_url?: string;
}

export interface SubmitAsrResponse {
  asr_id: string;
  status: 'assigned' | 'queued';
  agent_id?: string;
  position?: number;
}

export interface AsrStatusResponse {
  asr_id: string;
  user_id: string;
  client_id: string;
  agent_id: string | null;
  status: Asr['status'];
  request: AsrRequest;
  result: Asr['result'];
  error: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

// MARK: - Embed Types

export interface EmbedRequest {
  texts: string[];
  model: string;
  max_tokens: number;
}

export interface EmbedDataRow {
  index: number;
  embedding: number[];
}

export interface Embed {
  embed_id: string;
  user_id: string;
  client_id: string;
  agent_id: string | null;
  status: 'queued' | 'processing' | 'complete' | 'failed' | 'cancelled';
  request: EmbedRequest;
  result: {
    model: string;
    dimensions: number;
    data: EmbedDataRow[];
  } | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  webhook_url: string | null;
  webhook_sent: boolean;
}

// WebSocket messages: Relay → Agent (Embed)
export interface EmbedRequestMessage {
  type: 'embed_request';
  embed_id: string;
  client_id: string;
  owner_user_id: string;
  request: EmbedRequest;
}

// WebSocket messages: Agent → Relay (Embed)
export interface EmbedResponseMessage {
  type: 'embed_response';
  embed_id: string;
  owner_user_id?: string;
  model?: string;
  dimensions?: number;
  data: EmbedDataRow[];
}

export interface EmbedErrorMessage {
  type: 'embed_error';
  embed_id: string;
  owner_user_id?: string;
  error: string;
}

// HTTP API types for Embed
export interface SubmitEmbedRequest {
  texts: string[];
  model?: string;
  max_tokens?: number;
  webhook_url?: string;
}

export interface SubmitEmbedResponse {
  embed_id: string;
  status: 'assigned' | 'queued';
  agent_id?: string;
  position?: number;
}

export interface EmbedStatusResponse {
  embed_id: string;
  user_id: string;
  client_id: string;
  agent_id: string | null;
  status: Embed['status'];
  request: EmbedRequest;
  result: Embed['result'];
  error: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

// MARK: - OCR Types

export interface OcrRequest {
  image_url: string;
  max_tokens: number;
  temperature: number;
}

export interface Ocr {
  ocr_id: string;
  user_id: string;
  client_id: string;
  agent_id: string | null;
  status: 'queued' | 'processing' | 'complete' | 'failed' | 'cancelled';
  request: OcrRequest;
  result: {
    text: string;
    tokens_generated: number;
  } | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

// WebSocket messages: Relay → Agent (OCR)
export interface OcrRequestMessage {
  type: 'ocr_request';
  ocr_id: string;
  client_id: string;
  owner_user_id: string;
  request: OcrRequest;
}

// WebSocket messages: Agent → Relay (OCR)
export interface OcrResponseMessage {
  type: 'ocr_response';
  ocr_id: string;
  owner_user_id?: string;
  text: string;
  tokens_generated?: number;
}

export interface OcrErrorMessage {
  type: 'ocr_error';
  ocr_id: string;
  owner_user_id?: string;
  error: string;
}

// HTTP API types for OCR
export interface SubmitOcrRequest {
  image_url: string;
  max_tokens?: number;
  temperature?: number;
}

export interface SubmitOcrResponse {
  ocr_id: string;
  status: 'assigned' | 'queued';
  agent_id?: string;
  position?: number;
}

export interface OcrStatusResponse {
  ocr_id: string;
  user_id: string;
  client_id: string;
  agent_id: string | null;
  status: Ocr['status'];
  request: OcrRequest;
  result: Ocr['result'];
  error: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

export interface CancelTalkResponse {
  cancelled: boolean;
}

export interface CancelAsrResponse {
  cancelled: boolean;
}

export interface CancelEmbedResponse {
  cancelled: boolean;
}

export interface CancelOcrResponse {
  cancelled: boolean;
}
