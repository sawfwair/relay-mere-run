import type { GraphJob, GraphRunArtifact, GraphRunEvent, SubmitGraphJobRequest } from './types';
import { sanitizedTerminalError } from './execution';

export const LOCAL_CUSTODY_POLICY = 'local-custody.v1';
export const MAX_CUSTODY_DOCUMENT_BYTES = 256_000;
const IDENTIFIER = /^[A-Za-z0-9_.:-]{1,160}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const TERMINAL = new Set(['finished', 'failed', 'cancelled']);
const REPORT_TYPES = new Set(['application/vnd.mere.identity-receipt+json', 'application/vnd.mere.sanitized-report+json']);
const EVALUATION_ARMS = new Set(['base_neutral', 'base_prompt', 'adapter_neutral', 'adapter_prompt']);

export function hasLocalCustody(job: Pick<GraphJob, 'job'>): boolean {
  return job.job.data_policy === LOCAL_CUSTODY_POLICY;
}

export function matchesCustodyAssignment(job: GraphJob, token: string | undefined): boolean {
  if (!hasLocalCustody(job) && token === undefined) return true;
  return !!job.agent_id && typeof token === 'string' && job.node_token === token;
}

export function custodySubmissionError(body: SubmitGraphJobRequest): string | null {
  if (body.job.data_policy === undefined) return null;
  if (body.job.data_policy !== LOCAL_CUSTODY_POLICY) return 'Unsupported graph data policy';
  if (body.assets.groups.length) return 'Local custody forbids portable artifact uploads';
  if (!body.job.outputs.length || body.job.outputs.some((output) => !['receipt', 'report'].includes(output.name))) {
    return 'Local custody permits only declared receipt/report outputs';
  }
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  return bytes.byteLength > MAX_CUSTODY_DOCUMENT_BYTES ? 'Local-custody request exceeds its size limit' : null;
}

export function custodyPayloadState(job: GraphJob): 'available' | 'delivered' | 'replay_required' | 'purged' | undefined {
  if (!hasLocalCustody(job)) return undefined;
  if (TERMINAL.has(job.state)) return 'purged';
  if (!job.payload_redacted) return 'available';
  return ['planned', 'queued'].includes(job.state) ? 'replay_required' : 'delivered';
}

/** Preserve routing/provenance, not arbitrary graph defaults, arguments,
 * metadata, input values, or exact uploaded document bytes. Mutate the live
 * object too, so neither the in-memory cache nor durable storage keeps them. */
export function purgeGraphPayload(job: GraphJob): void {
  if (!hasLocalCustody(job)) return;
  job.inputs = {};
  job.graph = {
    schema_version: job.graph.schema_version, kind: job.graph.kind, name: 'local-custody',
    inputs: {}, outputs: {}, nodes: job.graph.nodes.map((node) => ({
      id: node.id, kind: node.kind, ...(node.provider ? { provider: node.provider } : {}), arguments: {},
    })),
  };
  const manifest = job.job;
  const requirements = manifest.requirements;
  job.job = {
    contract_version: manifest.contract_version, job_id: manifest.job_id, created_at: manifest.created_at,
    graph_fingerprint: manifest.graph_fingerprint, input_fingerprint: manifest.input_fingerprint,
    data_policy: LOCAL_CUSTODY_POLICY, outputs: manifest.outputs.map(({ name, reference }) => ({ name, reference })),
    requirements: {
      minimum_mere_run_version: requirements.minimum_mere_run_version,
      node_kinds: requirements.node_kinds, model_ids: requirements.model_ids,
      providers: requirements.providers?.map(({ id, version, catalog_sha256, node_kinds }) => ({ id, version, catalog_sha256, node_kinds })),
      accelerator_backends: requirements.accelerator_backends,
      required_device_id: requirements.required_device_id,
      secret_names: requirements.secret_names,
      minimum_accelerator_memory_bytes: requirements.minimum_accelerator_memory_bytes,
      minimum_system_memory_bytes: requirements.minimum_system_memory_bytes,
      minimum_disk_bytes: requirements.minimum_disk_bytes,
      minimum_cpu_cores: requirements.minimum_cpu_cores,
      network_access: requirements.network_access,
    },
    execution_spec_sha256: manifest.execution_spec_sha256,
    identity: manifest.identity && {
      persona_id: manifest.identity.persona_id, version_id: manifest.identity.version_id, deployment_id: manifest.identity.deployment_id,
    },
    idempotency_key: manifest.idempotency_key,
  };
  job.assets = { schema_version: 1, groups: [] };
  delete job.bundle_documents;
  job.payload_redacted = true;
}

export function prepareGraphForStorage(job: GraphJob): GraphJob {
  if (!hasLocalCustody(job)) return job;
  job.events = job.events.map(sanitizedGraphEvent);
  job.error = job.error ? sanitizedTerminalError(job.error) : null;
  job.artifacts = job.artifacts.map(({ name, kind, path, content_type, size_bytes, sha256 }) => ({ name, kind, path, content_type, size_bytes, sha256 }));
  if (job.metrics) {
    const m = job.metrics;
    job.metrics = { bundle_bytes_downloaded: m.bundle_bytes_downloaded, download_ms: m.download_ms,
      execution_ms: m.execution_ms, upload_ms: m.upload_ms, total_ms: m.total_ms,
      artifact_bytes_uploaded: m.artifact_bytes_uploaded, artifact_parts_uploaded: m.artifact_parts_uploaded,
      artifact_bytes_reused: m.artifact_bytes_reused, artifact_parts_reused: m.artifact_parts_reused };
  }
  if (TERMINAL.has(job.state)) purgeGraphPayload(job);
  return job;
}

export function restoreGraphPayload(job: GraphJob, body: SubmitGraphJobRequest): boolean {
  if (!hasLocalCustody(job) || !job.payload_redacted || !['planned', 'queued'].includes(job.state)) return false;
  // These headers do not participate in semantic idempotency. A retry may
  // supply fresh headers, but it must not rename the original execution.
  job.job = { ...body.job, job_id: job.job.job_id, created_at: job.job.created_at,
    idempotency_key: job.job.idempotency_key };
  job.graph = body.graph;
  job.inputs = body.inputs;
  job.assets = body.assets;
  job.bundle_documents = body.bundle_documents;
  job.payload_redacted = false;
  delete job.payload_delivered_at;
  return true;
}

function safeReportString(value: string, key: string): boolean {
  if (key.endsWith('_sha256') || key === 'sha256' || key === 'source_digests') return SHA256.test(value);
  if (key.endsWith('_ref') || key === 'ref') return /^[a-z][a-z0-9+.-]*-local:\/\/[a-z]+\/[a-f0-9]{64}$/u.test(value);
  const identifiers = /(?:^|_)(?:id|kind|version|model|arm|metric|provider|framework|runtime|privacy|state|schema)$/u;
  return identifiers.test(key) && IDENTIFIER.test(value);
}

/** Aggregate-only grammar: no free-form strings, diagnostic text, paths,
 * source contents, prompts, responses, credentials, or opaque extra fields. */
function safeReportValue(value: unknown, key: string, depth: number): boolean {
  if (depth > 16 || !/^[a-z][a-z0-9_]{0,95}$/u.test(key)) return false;
  if (EVALUATION_ARMS.has(key)) return numericArmMetrics(value);
  if (/(?:^|_)(?:raw|prompt|response|secret|credential|token|checkpoint|weights?|logs?|content|text|messages|inputs|arguments|path)(?:_|$)/u.test(key)) {
    // Numeric aggregate metrics are not raw inference content.
    return typeof value === 'number' && Number.isFinite(value);
  }
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') return safeReportString(value, key);
  if (Array.isArray(value)) return value.length <= 256 && value.every((entry) => safeReportValue(entry, key, depth + 1));
  if (!value || typeof value !== 'object') return false;
  const entries = Object.entries(value);
  return entries.length <= 256 && entries.every(([child, entry]) => safeReportValue(entry, child, depth + 1));
}

function numericArmMetrics(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  return entries.length <= 256 && entries.every(([key, metric]) => /^[a-z][a-z0-9_]{0,95}$/u.test(key)
    && typeof metric === 'number' && Number.isFinite(metric));
}

export function sanitizedReportBytes(bytes: Uint8Array): boolean {
  if (!bytes.byteLength || bytes.byteLength > MAX_CUSTODY_DOCUMENT_BYTES) return false;
  try {
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
    return !!value && typeof value === 'object' && !Array.isArray(value)
      && safeReportValue(value, 'report', 0);
  } catch { return false; }
}

export function custodyArtifactAllowed(job: GraphJob, artifact: GraphRunArtifact): boolean {
  return artifact.kind === 'graph.output' && REPORT_TYPES.has(artifact.content_type)
    && job.job.outputs.some((output) => output.name === artifact.name)
    && ['receipt', 'report'].includes(artifact.name)
    && artifact.path === `outputs/${artifact.name}.json`
    && Number.isSafeInteger(artifact.size_bytes) && artifact.size_bytes > 0
    && artifact.size_bytes <= MAX_CUSTODY_DOCUMENT_BYTES && SHA256.test(artifact.sha256);
}

export function sanitizedGraphEvent(event: GraphRunEvent): GraphRunEvent {
  return {
    sequence: event.sequence, created_at: Number.isFinite(Date.parse(event.created_at))
      ? new Date(event.created_at).toISOString() : new Date().toISOString(), state: event.state,
    type: ['job_state', 'node_state', 'node_started', 'node_completed', 'node_failed', 'progress'].includes(event.type)
      ? event.type : 'progress',
    ...(event.node_id && IDENTIFIER.test(event.node_id) ? { node_id: event.node_id } : {}),
  };
}

export function sanitizedRunManifest(job: GraphJob, value: Record<string, unknown>): Record<string, unknown> | null {
  if (value.contract_version !== 'mere.run/graph-run.v1' || value.job_id !== job.job_id
    || value.graph_fingerprint !== job.job.graph_fingerprint || !TERMINAL.has(String(value.state))) return null;
  return {
    contract_version: 'mere.run/graph-run.v1', job_id: job.job_id,
    graph_fingerprint: job.job.graph_fingerprint, state: value.state,
  };
}
