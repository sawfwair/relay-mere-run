import type { IdentityExecutionReference, RelayExecutionReceipt } from './MereRunRelayClient';

export type GraphDataPolicy = 'local-custody.v1';
export type GraphPayloadState = 'available' | 'delivered' | 'replay_required' | 'purged';
export type GraphExecutionState = 'planned' | 'preflighting' | 'queued' | 'assigned' | 'running' | 'finished' | 'failed' | 'cancelled';

export interface GraphProviderRequirement {
  id: string;
  version: string;
  catalog_sha256: string;
  node_kinds: string[];
}

/** Graph documents are validated by Relay and the native graph runtime. */
export interface GraphSubmission {
  client_id?: string;
  job: {
    contract_version: string;
    job_id: string;
    created_at: string;
    graph_fingerprint: string;
    input_fingerprint: string;
    data_policy?: GraphDataPolicy;
    execution_spec_sha256?: string;
    identity?: IdentityExecutionReference;
    idempotency_key?: string;
    webhook_url?: string;
    requirements: {
      minimum_mere_run_version: string;
      node_kinds: string[];
      model_ids: string[];
      providers?: GraphProviderRequirement[];
      accelerator_backends: string[];
      required_device_id?: string;
      secret_names?: string[];
      minimum_accelerator_memory_bytes?: number;
      minimum_system_memory_bytes?: number;
      minimum_disk_bytes?: number;
      minimum_cpu_cores?: number;
      network_access?: boolean;
      models?: Array<{ id: string; catalog_sha256: string; repository?: string; revision?: string; install_manifest_sha256?: string }>;
    };
    outputs: Array<{ name: string; reference: string }>;
  };
  graph: { schema_version: number; kind: string; name: string; inputs: object; nodes: object[]; outputs: object;
    execution?: { max_parallel_nodes?: number }; metadata?: object };
  inputs: object;
  assets: { schema_version: number; groups: Array<{ name: string; kind: 'asset' | 'asset_directory';
    entries: Array<{ path: string; digest: string; size_bytes: number; content_type: string }> }> };
  bundle_documents?: Record<string, string>;
}

export interface GraphStatusResponse {
  job_id: string;
  state: GraphExecutionState;
  request_sha256: string | null;
  execution_spec_sha256: string | null;
  data_policy?: GraphDataPolicy;
  payload_state?: GraphPayloadState;
  execution_receipt: RelayExecutionReceipt | null;
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function digest(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}

function receiptProvenance(value: Record<string, unknown>): boolean {
  const digests = ['execution_spec_sha256', 'adapter_manifest_sha256', 'provider_catalog_sha256', 'output_sha256'];
  const identifiers = ['provider_version', 'device_id', 'error_code'];
  const fields = new Set(['schema', 'execution_id', 'request_sha256', 'model_id', 'provider_id',
    'started_at', 'completed_at', 'duration_ms', 'state', ...digests, ...identifiers]);
  return Object.keys(value).every((field) => fields.has(field))
    && digests.every((field) => value[field] === undefined || digest(value[field]))
    && identifiers.every((field) => value[field] === undefined || typeof value[field] === 'string')
    && (value.duration_ms === undefined || (typeof value.duration_ms === 'number' && Number.isFinite(value.duration_ms) && value.duration_ms >= 0));
}

function receipt(value: unknown): value is RelayExecutionReceipt {
  if (!record(value)) return false;
  return value.schema === 'relay.execution-receipt.v1' && typeof value.execution_id === 'string'
    && digest(value.request_sha256) && typeof value.model_id === 'string' && typeof value.provider_id === 'string'
    && (value.started_at === null || typeof value.started_at === 'string') && typeof value.completed_at === 'string'
    && ['complete', 'failed', 'cancelled'].includes(String(value.state)) && receiptProvenance(value);
}

function graphReceiptMatches(value: Record<string, unknown>): boolean {
  const terminal: Record<string, string> = { finished: 'complete', failed: 'failed', cancelled: 'cancelled' };
  const expected = terminal[String(value.state)];
  if (!expected) return value.execution_receipt === null;
  const result = value.execution_receipt;
  if (!receipt(result) || result.execution_id !== value.job_id) return false;
  return result.state === expected
    && (value.request_sha256 === null || result.request_sha256 === value.request_sha256)
    && (value.execution_spec_sha256 === null || result.execution_spec_sha256 === value.execution_spec_sha256)
    && (result.state !== 'complete' || digest(result.output_sha256));
}

export function isGraphStatusResponse(value: unknown): value is GraphStatusResponse {
  if (!record(value)) return false;
  return typeof value.job_id === 'string'
    && ['planned', 'preflighting', 'queued', 'assigned', 'running', 'finished', 'failed', 'cancelled'].includes(String(value.state))
    && (value.request_sha256 === null || digest(value.request_sha256))
    && (value.execution_spec_sha256 === null || digest(value.execution_spec_sha256))
    && (value.data_policy === undefined || value.data_policy === 'local-custody.v1')
    && (value.payload_state === undefined || (typeof value.payload_state === 'string'
      && ['available', 'delivered', 'replay_required', 'purged'].includes(value.payload_state)))
    && graphReceiptMatches(value);
}
