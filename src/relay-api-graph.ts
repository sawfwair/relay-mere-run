import type { RelayContext } from './relay-context';
import type {
  GraphErrorMessage,
  GraphEventMessage,
  GraphJob,
  GraphResultMessage,
  GraphRunArtifact,
  GraphWorkerCapabilities,
  SubmitGraphJobRequest,
} from './types';
import { parseJson } from './json';
import { unknownJsonSchema } from './contracts/responses';
import {
  assignGraphToAgent,
  graphPlacementReport,
  supportsGraph,
} from './relay-queue';
import { releaseAgent } from './relay-lifecycle';
import { listFleetNodes } from './relay-fleet';
import {
  enforceGraphArtifactQuota,
  enforceGraphSubmissionQuotas,
  graphRelayTelemetry,
  recordGraphTelemetry,
  scheduleGraphMaintenance,
} from './relay-graph-operations';
import {
  graphArtifactResponse,
  graphArtifactObjectName,
  graphAssetKey,
  graphBundleObject,
  graphRunManifestKey,
  hasStoredGraphArtifact,
  materializeRelayBundle,
  sha256Hex,
  storeGraphArtifact,
  storeGraphArtifactPart,
  storeSubmittedBundleDocuments,
  verifiedGraphArtifactUpload,
} from './relay-graph-storage';
import { buildGraphReceipt } from './relay-receipts';
import { custodyArtifactAllowed, custodyPayloadState, custodySubmissionError, hasLocalCustody, matchesCustodyAssignment,
  restoreGraphPayload, sanitizedGraphEvent, sanitizedRunManifest } from './relay-graph-custody';
import { handlePublicGraphPublication, mergePublications, retainedPublications, saveGraphArtifactUpload } from './relay-graph-publication';
import { handleCustodyNodeRequest } from './relay-graph-custody-http';
import { graphRequestContent, sanitizedTerminalError, sha256Json } from './execution';

const CONTRACT_VERSION = 'mere.run/job-bundle.v1';
const GRAPH_KIND = 'mere.run/workflow-graph';
const ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const PORT_ID_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const JOB_ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const PROVIDER_ID_PATTERN = /^mere-[a-z0-9-]+$/;
const DEVICE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const RUN_STATES = new Set(['planned', 'preflighting', 'queued', 'assigned', 'running', 'finished', 'failed', 'cancelled']);
const INPUT_TYPES = new Set([
  'string',
  'integer',
  'number',
  'boolean',
  'enum',
  'json',
  'asset',
  'asset_directory',
  'asset_collection',
  'asset_array',
]);
// The complete built-in catalog of mere.run 0.40.1, generated from
// `mere.run graph catalog --json` (kind -> output names). Keep in sync
// with the runtime's WorkflowNodeRegistry when the vocabulary grows;
// placement still gates each job on the kinds a live worker advertises.
const BUILTIN_NODE_OUTPUTS: Readonly<Record<string, readonly string[]>> = {
  'audio.enhance': ['audio'],
  'boolean.value': ['value'],
  'choice.value': ['value'],
  'image.describe': ['text'],
  'image.generate': ['image'],
  'image.train-lora': ['adapter'],
  'integer.value': ['value'],
  'json.value': ['value'],
  'music.generate': ['audio'],
  'music.separate': ['stems'],
  'music.transcribe': ['transcription'],
  'number.value': ['value'],
  'seed.value': ['seed'],
  'sfx.generate': ['audio'],
  'speech.diarize': ['segments'],
  'speech.synthesize': ['audio'],
  'speech.transcribe': ['text'],
  'text.anonymize': ['text'],
  'text.embed': ['embeddings'],
  'text.enhance': ['text'],
  'text.generate': ['text'],
  'text.join': ['text'],
  'text.template': ['text'],
  'text.value': ['text'],
  'video.generate': ['video'],
  'vision.caption': ['captions'],
  'vision.geometry': ['geometry'],
  'vision.ground': ['image', 'detections', 'masks'],
  'vision.image-to-3d': ['mesh'],
  'vision.ocr': ['text'],
  'vision.segment': ['image', 'segments', 'masks'],
  'vision.track': ['video', 'tracks', 'masks'],
};
const MAX_RETAINED_GRAPH_EVENTS = 512;
// node_output_delta carries the node's accumulated text so far, so keeping
// only the latest per node loses nothing and keeps retention bounded while
// clients render live generation.
const COALESCED_GRAPH_EVENT_TYPES = new Set(['node_progress', 'node_heartbeat', 'node_output_delta']);
const BUNDLE_DOCUMENT_VALUES = {
  'job.json': 'job',
  'graph.json': 'graph',
  'inputs.json': 'inputs',
  'assets.json': 'assets',
} as const;
const MAX_ARTIFACT_PART_BYTES = 16 * 1024 * 1024;
const MAX_ARTIFACT_PARTS = 16_384;

interface GraphIdempotencyRecord {
  job_id: string;
  request_sha256: string;
}

function jsonValuesEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => jsonValuesEqual(value, right[index]));
  }
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key) => (
      Object.prototype.hasOwnProperty.call(rightRecord, key)
      && jsonValuesEqual(leftRecord[key], rightRecord[key])
    ));
}

function decodeBundleDocuments(body: SubmitGraphJobRequest): Record<string, Uint8Array> | null {
  if (!body.bundle_documents) return null;
  const documents: Record<string, Uint8Array> = {};
  try {
    for (const [path, valueKey] of Object.entries(BUNDLE_DOCUMENT_VALUES)) {
      const encoded = body.bundle_documents[path];
      if (typeof encoded !== 'string' || !encoded) return null;
      const binary = atob(encoded);
      const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
      const parsed = parseJson(new TextDecoder().decode(bytes), unknownJsonSchema);
      if (!jsonValuesEqual(parsed, body[valueKey])) return null;
      documents[path] = bytes;
    }
  } catch {
    return null;
  }
  return documents;
}

function graphResponse(ctx: RelayContext, job: GraphJob): Record<string, unknown> {
  return {
    job_id: job.job_id,
    state: job.state,
    request_sha256: job.request_sha256 ?? null,
    execution_spec_sha256: job.job.execution_spec_sha256 ?? null,
    ...(hasLocalCustody(job) ? { data_policy: job.job.data_policy, payload_state: custodyPayloadState(job) } : {}),
    agent_id: job.agent_id,
    created_at: job.created_at,
    updated_at: job.updated_at,
    assigned_at: job.assigned_at,
    started_at: job.started_at,
    completed_at: job.completed_at,
    attempt: job.attempt,
    run_manifest: job.run_manifest,
    artifacts: job.artifacts,
    error: job.error,
    metrics: job.metrics,
    execution_receipt: job.execution_receipt ?? null,
    placement: graphPlacementReport(ctx, job),
  };
}

function referenceStrings(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(referenceStrings);
  if (!value || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length === 1 && typeof record.$ref === 'string') return [record.$ref];
  return Object.values(record).flatMap(referenceStrings);
}

function secretNames(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(secretNames);
  if (!value || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length === 1 && typeof record.$secret === 'string') return [record.$secret];
  return Object.values(record).flatMap(secretNames);
}

function parseNodeReference(reference: string): { nodeId: string; output: string } | null {
  const match = reference.match(/^nodes\.([a-z][a-z0-9-]{0,63})\.outputs\.([a-z][a-z0-9_]{0,63})$/);
  return match ? { nodeId: match[1], output: match[2] } : null;
}

function isConfinedPath(path: string): boolean {
  const segments = path.split('/');
  return Boolean(path) && !path.startsWith('/') && segments.every((segment) => segment && segment !== '.' && segment !== '..');
}

function inputValueMatches(value: unknown, type: string, values?: string[]): boolean {
  switch (type) {
    case 'string': return typeof value === 'string';
    case 'integer': return Number.isSafeInteger(value);
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'boolean': return typeof value === 'boolean';
    case 'enum': return typeof value === 'string' && (!values || values.includes(value));
    case 'json': return true;
    case 'asset':
    case 'asset_directory': return typeof value === 'string';
    case 'asset_collection':
    case 'asset_array': return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
    default: return false;
  }
}

function providerRequirements(body: SubmitGraphJobRequest): Map<string, GraphWorkerCapabilities['providers'][number]> | null {
  const providers = body.job.requirements.providers ?? [];
  const byId = new Map<string, GraphWorkerCapabilities['providers'][number]>();
  for (const provider of providers) {
    if (!PROVIDER_ID_PATTERN.test(provider.id)
        || !provider.version
        || !DIGEST_PATTERN.test(provider.catalog_sha256)
        || !Array.isArray(provider.node_kinds)
        || provider.node_kinds.length === 0
        || byId.has(provider.id)) return null;
    byId.set(provider.id, provider);
  }
  return byId;
}

function nodeOutputExists(
  node: SubmitGraphJobRequest['graph']['nodes'][number],
  output: string,
): boolean {
  if (!PORT_ID_PATTERN.test(output)) return false;
  if (!node.provider || node.provider === 'mere.run') {
    return BUILTIN_NODE_OUTPUTS[node.kind]?.includes(output) ?? false;
  }
  return true;
}

function retainGraphEvent(job: GraphJob, event: GraphEventMessage['event']): void {
  if (COALESCED_GRAPH_EVENT_TYPES.has(event.type)) {
    const phase = event.phase ?? '';
    const previous = job.events.findIndex((candidate) => {
      const candidatePhase = candidate.phase ?? '';
      return candidate.type === event.type
        && candidate.node_id === event.node_id
        && candidatePhase === phase;
    });
    if (previous >= 0) job.events.splice(previous, 1);
  }
  job.events.push(event);
  while (job.events.length > MAX_RETAINED_GRAPH_EVENTS) {
    const coalescible = job.events.findIndex((candidate) => COALESCED_GRAPH_EVENT_TYPES.has(candidate.type));
    job.events.splice(coalescible >= 0 ? coalescible : 0, 1);
  }
}

function requestAssignedNodeInventory(ctx: RelayContext, agentId: string | null): void {
  if (!agentId) return;
  try {
    ctx.getConnectedAgents().get(agentId)?.ws.send(JSON.stringify({ type: 'inventory_request' }));
  } catch (error) {
    console.error(`Failed to refresh graph node inventory for ${agentId}:`, error);
  }
}

function validateDeviceAndResourceRequirements(body: SubmitGraphJobRequest): string | null {
  const requiredDeviceId = body.job.requirements.required_device_id;
  if (requiredDeviceId !== undefined && !DEVICE_ID_PATTERN.test(requiredDeviceId)) {
    return 'invalid required graph device id';
  }
  const positiveRequirements = [
    body.job.requirements.minimum_accelerator_memory_bytes,
    body.job.requirements.minimum_system_memory_bytes,
    body.job.requirements.minimum_disk_bytes,
    body.job.requirements.minimum_cpu_cores,
  ];
  if (positiveRequirements.some((value) => value !== undefined && (!Number.isSafeInteger(value) || value <= 0))) {
    return 'graph resource requirements must be positive integers';
  }
  return validateWebhookUrl(body.job.webhook_url);
}

function validateWebhookUrl(value: string | undefined): string | null {
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'graph webhook_url must be a public HTTPS origin';
  }
  const hostname = url.hostname.toLowerCase();
  const isIpLiteral = /^\[.*\]$/u.test(hostname) || /^\d{1,3}(?:\.\d{1,3}){3}$/u.test(hostname);
  if (
    url.protocol !== 'https:'
    || url.username
    || url.password
    || isIpLiteral
    || !hostname.includes('.')
    || hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || hostname.endsWith('.local')
    || hostname.endsWith('.internal')
  ) return 'graph webhook_url must be a public HTTPS origin';
  return null;
}

export function validateCreateRequest(body: SubmitGraphJobRequest): string | null {
  if (body.job?.contract_version !== CONTRACT_VERSION) return `contract_version must be ${CONTRACT_VERSION}`;
  if (!JOB_ID_PATTERN.test(body.job.job_id)) return 'job_id must be a lowercase UUID';
  if (body.graph?.schema_version !== 1 || body.graph.kind !== GRAPH_KIND) return 'unsupported workflow graph contract';
  if (!body.graph.name?.trim()) return 'graph name is required';
  if (!Array.isArray(body.graph.nodes) || body.graph.nodes.length === 0) return 'graph must contain nodes';
  const graphParallelism = body.graph.execution?.max_parallel_nodes;
  if (graphParallelism !== undefined
      && (!Number.isSafeInteger(graphParallelism) || graphParallelism < 1 || graphParallelism > 32)) {
    return 'graph max_parallel_nodes must be between 1 and 32';
  }
  if (body.assets?.schema_version !== 1 || !Array.isArray(body.assets.groups)) return 'invalid asset manifest';
  if (body.bundle_documents && !decodeBundleDocuments(body)) return 'invalid bundle documents';
  const providers = providerRequirements(body);
  if (!providers) return 'invalid or duplicate graph provider requirement';
  const requiredSecrets = body.job.requirements.secret_names ?? [];
  if (!Array.isArray(requiredSecrets)
      || new Set(requiredSecrets).size !== requiredSecrets.length
      || requiredSecrets.some((name) => !ID_PATTERN.test(name))) return 'invalid graph secret requirements';
  const requirementsError = validateDeviceAndResourceRequirements(body);
  if (requirementsError) return requirementsError;

  for (const [name, definition] of Object.entries(body.graph.inputs)) {
    if (!ID_PATTERN.test(name) || !definition || !INPUT_TYPES.has(definition.type)) return `invalid graph input: ${name}`;
    const supplied = Object.prototype.hasOwnProperty.call(body.inputs, name) ? body.inputs[name] : definition.default;
    if (supplied === undefined && definition.required !== false) return `missing graph input: ${name}`;
    if (supplied !== undefined && !inputValueMatches(supplied, definition.type, definition.values)) {
      return `graph input type mismatch: ${name}`;
    }
  }
  for (const name of Object.keys(body.inputs)) {
    if (!Object.prototype.hasOwnProperty.call(body.graph.inputs, name)) return `unknown graph input: ${name}`;
  }

  const nodes = new Map<string, (typeof body.graph.nodes)[number]>();
  const requiredProviderIds = new Set<string>();
  for (const node of body.graph.nodes) {
    if (!ID_PATTERN.test(node.id) || nodes.has(node.id)) return `invalid or duplicate node id: ${node.id}`;
    const policy = node.execution;
    if (policy?.max_attempts !== undefined
        && (!Number.isSafeInteger(policy.max_attempts) || policy.max_attempts < 1 || policy.max_attempts > 10)) {
      return `invalid max_attempts for node: ${node.id}`;
    }
    if (policy?.timeout_seconds !== undefined
        && (!Number.isSafeInteger(policy.timeout_seconds)
          || policy.timeout_seconds < 1
          || policy.timeout_seconds > 604800)) {
      return `invalid timeout_seconds for node: ${node.id}`;
    }
    if (policy?.cache !== undefined && !['auto', 'never', 'refresh'].includes(policy.cache)) {
      return `invalid cache policy for node: ${node.id}`;
    }
    if (secretNames(node.arguments).length > 0 && policy?.cache !== 'never') {
      return `secret-bound node must disable caching: ${node.id}`;
    }
    const providerId = node.provider ?? 'mere.run';
    if (providerId === 'mere.run') {
      if (!BUILTIN_NODE_OUTPUTS[node.kind]) return `unsupported built-in graph node kind: ${node.kind}`;
    } else {
      const provider = providers.get(providerId);
      if (!provider || !provider.node_kinds.includes(node.kind)) {
        return `graph node provider does not declare node kind: ${providerId}/${node.kind}`;
      }
      requiredProviderIds.add(providerId);
    }
    nodes.set(node.id, node);
  }
  const boundSecrets = [...new Set(body.graph.nodes.flatMap((node) => secretNames(node.arguments)))].sort();
  if (JSON.stringify(boundSecrets) !== JSON.stringify([...requiredSecrets].sort())) {
    return 'job secret requirements do not match graph bindings';
  }
  if (secretNames(body.graph.inputs).length > 0
      || secretNames(body.inputs).length > 0
      || secretNames(body.graph.outputs).length > 0
      || secretNames(body.graph.metadata).length > 0) {
    return 'secret references may appear only in node arguments';
  }
  if (providers.size !== requiredProviderIds.size
      || [...providers.keys()].some((provider) => !requiredProviderIds.has(provider))) {
    return 'job provider requirements do not match graph nodes';
  }
  const requiredKinds = [...new Set(body.graph.nodes.map((node) => node.kind))].sort();
  if (JSON.stringify(requiredKinds) !== JSON.stringify([...body.job.requirements.node_kinds].sort())) {
    return 'job node requirements do not match graph nodes';
  }

  const dependencies = new Map<string, Set<string>>();
  for (const node of body.graph.nodes) {
    const deps = new Set(node.depends_on ?? []);
    for (const reference of referenceStrings(node.arguments)) {
      if (reference.startsWith('inputs.')) {
        if (!Object.prototype.hasOwnProperty.call(body.graph.inputs, reference.slice('inputs.'.length))) {
          return `unknown graph input reference: ${reference}`;
        }
        continue;
      }
      const parsed = parseNodeReference(reference);
      const source = parsed ? nodes.get(parsed.nodeId) : undefined;
      if (!parsed || !source || !nodeOutputExists(source, parsed.output)) {
        return `unknown graph node output reference: ${reference}`;
      }
      deps.add(parsed.nodeId);
    }
    for (const dependency of deps) if (!nodes.has(dependency)) return `unknown node dependency: ${dependency}`;
    dependencies.set(node.id, deps);
  }
  const remaining = new Map([...dependencies].map(([id, deps]) => [id, new Set(deps)]));
  while (remaining.size > 0) {
    const next = body.graph.nodes.find((node) => remaining.get(node.id)?.size === 0);
    if (!next) return 'workflow graph contains a cycle';
    remaining.delete(next.id);
    for (const deps of remaining.values()) deps.delete(next.id);
  }
  for (const [name, value] of Object.entries(body.graph.outputs)) {
    if (!ID_PATTERN.test(name)) return `invalid graph output id: ${name}`;
    const references = referenceStrings(value);
    const parsed = references.length === 1 ? parseNodeReference(references[0]) : null;
    const source = parsed ? nodes.get(parsed.nodeId) : undefined;
    if (!parsed || !source || !nodeOutputExists(source, parsed.output)) {
      return 'graph outputs must reference known node outputs';
    }
  }
  const expectedOutputs = Object.entries(body.graph.outputs)
    .map(([name, value]) => ({ name, reference: referenceStrings(value)[0] }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const declaredOutputs = [...body.job.outputs].sort((left, right) => left.name.localeCompare(right.name));
  if (JSON.stringify(expectedOutputs) !== JSON.stringify(declaredOutputs)) return 'job outputs do not match graph outputs';

  const assetNames = new Set<string>();
  for (const group of body.assets.groups) {
    if (!ID_PATTERN.test(group.name) || assetNames.has(group.name)) return `invalid or duplicate asset group: ${group.name}`;
    assetNames.add(group.name);
    if (!Array.isArray(group.entries) || group.entries.length === 0) return `asset group ${group.name} is empty`;
    for (const entry of group.entries) {
      if (!DIGEST_PATTERN.test(entry.digest)) return `invalid asset digest: ${entry.digest}`;
      if (!Number.isSafeInteger(entry.size_bytes) || entry.size_bytes < 0) return `invalid asset size: ${entry.path}`;
      if (!isConfinedPath(entry.path)) {
        return `invalid asset path: ${entry.path}`;
      }
    }
  }
  for (const [name, definition] of Object.entries(body.graph.inputs)) {
    if (definition.type !== 'asset' && definition.type !== 'asset_directory') continue;
    if (body.inputs[name] !== `asset://${name}`) return `portable asset input must use asset://${name}`;
    const group = body.assets.groups.find((candidate) => candidate.name === name);
    if (!group || group.kind !== definition.type) return `asset manifest is missing graph input: ${name}`;
  }
  return custodySubmissionError(body);
}

export function handlePreflightGraphJob(ctx: RelayContext, body: SubmitGraphJobRequest): Response {
  const error = validateCreateRequest(body);
  if (error) return Response.json({ error }, { status: 400 });
  const createdAt = new Date().toISOString();
  const graph: GraphJob = {
    job_id: body.job.job_id,
    user_id: ctx.userId,
    client_id: body.client_id ?? 'graph-studio',
    agent_id: null,
    state: 'preflighting',
    job: body.job,
    graph: body.graph,
    inputs: body.inputs,
    assets: body.assets,
    missing_asset_digests: [],
    events: [],
    artifacts: [],
    artifact_uploads: {},
    run_manifest: null,
    metrics: null,
    error: null,
    created_at: createdAt,
    updated_at: createdAt,
    assigned_at: null,
    started_at: null,
    completed_at: null,
    attempt: 0,
    max_attempts: 1,
    node_token: '',
    relay_origin: '',
    webhook_url: body.job.webhook_url ?? null,
    webhook_sent: false,
  };
  return Response.json({ placement: graphPlacementReport(ctx, graph) }, {
    headers: { 'Cache-Control': 'no-store' },
  });
}

async function missingDigests(ctx: RelayContext, job: GraphJob): Promise<string[]> {
  const entries = job.assets.groups.flatMap((group) => group.entries);
  const unique = new Map(entries.map((entry) => [entry.digest, entry]));
  const missing: string[] = [];
  for (const entry of unique.values()) {
    const object = await ctx.env.IMAGES.head(graphAssetKey(job.user_id, entry.digest));
    if (!object || object.size !== entry.size_bytes || object.customMetadata?.sha256 !== entry.digest) {
      missing.push(entry.digest);
    }
  }
  return missing.sort();
}

async function repeatedGraphSubmission(
  ctx: RelayContext,
  body: SubmitGraphJobRequest,
  requestSha256: string,
): Promise<Response | null> {
  const idempotencyKey = body.job.idempotency_key?.trim();
  if (idempotencyKey) {
    const record = await ctx.storage.get<GraphIdempotencyRecord>(`graph-idempotency:${idempotencyKey}`);
    if (record) {
      const matches = record.request_sha256 === requestSha256;
      const original = matches ? await ctx.getGraphJob(record.job_id) : null;
      if (original) return recoverGraphReplay(ctx, original, body);
      return Response.json({
        error: 'Idempotency key was already used for a different graph request.',
        code: 'IDEMPOTENCY_CONFLICT',
      }, { status: 409 });
    }
  }
  const existing = await ctx.getGraphJob(body.job.job_id);
  if (!existing) return null;
  if (existing.request_sha256 === requestSha256) {
    return recoverGraphReplay(ctx, existing, body);
  }
  return Response.json({
    error: 'Graph job id was already used for a different immutable bundle',
    code: 'IDEMPOTENCY_CONFLICT',
  }, { status: 409 });
}

async function recoverGraphReplay(ctx: RelayContext, job: GraphJob, body: SubmitGraphJobRequest): Promise<Response> {
  if (restoreGraphPayload(job, body)) {
    await ctx.saveGraphJob(job);
    if (job.state === 'queued') await assignGraphToAgent(ctx, job);
  }
  return Response.json(graphResponse(ctx, job));
}

export async function handleCreateGraphJob(
  ctx: RelayContext,
  body: SubmitGraphJobRequest,
  userId: string,
  origin: string,
): Promise<Response> {
  const error = validateCreateRequest(body);
  if (error) return Response.json({ error }, { status: 400 });
  const requestSha256 = await sha256Json(graphRequestContent(body));
  const idempotencyKey = body.job.idempotency_key?.trim();
  const replay = await repeatedGraphSubmission(ctx, body, requestSha256);
  if (replay) return replay;
  const quota = await enforceGraphSubmissionQuotas(ctx, body, userId);
  if (quota) return quota;

  const createdAt = new Date().toISOString();
  const graph: GraphJob = {
    job_id: body.job.job_id,
    user_id: userId,
    client_id: body.client_id || `client_${userId.slice(-8)}`,
    agent_id: null,
    state: 'planned',
    job: body.job,
    graph: body.graph,
    inputs: body.inputs,
    assets: body.assets,
    missing_asset_digests: [],
    events: [],
    last_event_sequence: -1,
    artifacts: [],
    artifact_uploads: {},
    run_manifest: null,
    metrics: null,
    error: null,
    created_at: createdAt,
    updated_at: createdAt,
    assigned_at: null,
    started_at: null,
    completed_at: null,
    attempt: 0,
    max_attempts: 1,
    node_token: crypto.randomUUID().replaceAll('-', ''),
    relay_origin: body.relay_origin || origin,
    webhook_url: body.job.webhook_url ?? null,
    webhook_sent: false,
    request_sha256: requestSha256,
    ...(body.job.data_policy ? { bundle_documents: body.bundle_documents, max_attempts: 3 } : {}),
  };
  const bundleDocuments = decodeBundleDocuments(body);
  if (bundleDocuments) await storeSubmittedBundleDocuments(ctx, graph, bundleDocuments);
  graph.missing_asset_digests = await missingDigests(ctx, graph);
  await ctx.saveGraphJob(graph);
  if (idempotencyKey) {
    await ctx.storage.put(`graph-idempotency:${idempotencyKey}`, {
      job_id: graph.job_id,
      request_sha256: requestSha256,
    } satisfies GraphIdempotencyRecord);
  }
  await recordGraphTelemetry(ctx, { submissions: 1 });
  await scheduleGraphMaintenance(ctx);
  return Response.json({
    ...graphResponse(ctx, graph),
    missing_asset_digests: graph.missing_asset_digests,
  }, { status: 201 });
}

export async function handleUploadGraphAsset(
  ctx: RelayContext,
  jobId: string,
  digest: string,
  request: Request,
): Promise<Response> {
  const job = await ctx.getGraphJob(jobId);
  if (!job) return Response.json({ error: 'Graph job not found' }, { status: 404 });
  if (job.state !== 'planned') return Response.json({ error: 'Graph job is already committed' }, { status: 409 });
  if (hasLocalCustody(job)) return Response.json({ code: 'LOCAL_CUSTODY_ASSET_DENIED' }, { status: 403 });
  const declared = job.assets.groups.flatMap((group) => group.entries).find((entry) => entry.digest === digest);
  if (!declared) return Response.json({ error: 'Asset digest is not declared by this job' }, { status: 404 });
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength !== declared.size_bytes) return Response.json({ error: 'Asset size mismatch' }, { status: 400 });
  if (await sha256Hex(bytes) !== digest) return Response.json({ error: 'Asset SHA-256 mismatch' }, { status: 400 });
  await ctx.env.IMAGES.put(graphAssetKey(job.user_id, digest), bytes, {
    httpMetadata: { contentType: declared.content_type || 'application/octet-stream' },
    customMetadata: { sha256: digest },
  });
  job.missing_asset_digests = job.missing_asset_digests.filter((candidate) => candidate !== digest);
  job.updated_at = new Date().toISOString();
  await ctx.saveGraphJob(job);
  return Response.json({ digest, stored: true });
}

export async function handleCommitGraphJob(ctx: RelayContext, jobId: string): Promise<Response> {
  const job = await ctx.getGraphJob(jobId);
  if (!job) return Response.json({ error: 'Graph job not found' }, { status: 404 });
  if (job.state !== 'planned') return Response.json(graphResponse(ctx, job));
  job.missing_asset_digests = await missingDigests(ctx, job);
  if (job.missing_asset_digests.length > 0) {
    await ctx.saveGraphJob(job);
    return Response.json({ error: 'Graph job assets are incomplete', missing_asset_digests: job.missing_asset_digests }, { status: 409 });
  }
  await materializeRelayBundle(ctx, job);
  job.state = 'queued';
  job.updated_at = new Date().toISOString();
  await ctx.saveGraphJob(job);
  await assignGraphToAgent(ctx, job);
  return Response.json(graphResponse(ctx, job));
}

export async function handleGetGraphJob(ctx: RelayContext, jobId: string): Promise<Response> {
  const job = await ctx.getGraphJob(jobId);
  return job ? Response.json(graphResponse(ctx, job)) : Response.json({ error: 'Graph job not found' }, { status: 404 });
}

export async function handleListGraphJobs(ctx: RelayContext, limit: number): Promise<Response> {
  const stored = await ctx.storage.list<GraphJob>({ prefix: 'graph:' });
  const jobs = [...stored.values()]
    .sort((left, right) => right.created_at.localeCompare(left.created_at))
    .slice(0, Math.max(1, Math.min(500, limit)))
    .map((job) => graphResponse(ctx, job));
  return Response.json({ jobs });
}

export async function handleGraphEvents(ctx: RelayContext, jobId: string): Promise<Response> {
  const job = await ctx.getGraphJob(jobId);
  if (!job) return Response.json({ error: 'Graph job not found' }, { status: 404 });
  const body = job.events.map((event) => JSON.stringify(event)).join('\n');
  return new Response(body ? `${body}\n` : '', {
    headers: {
      'Content-Type': 'application/x-ndjson',
      'X-Graph-Event-First-Sequence': String(job.events.at(0)?.sequence ?? -1),
      'X-Graph-Event-Last-Sequence': String(job.last_event_sequence ?? job.events.at(-1)?.sequence ?? -1),
      'X-Graph-Event-Retained': String(job.events.length),
    },
  });
}

export async function handleCancelGraphJob(ctx: RelayContext, jobId: string): Promise<Response> {
  const job = await ctx.getGraphJob(jobId);
  if (!job) return Response.json({ error: 'Graph job not found' }, { status: 404 });
  if (job.state === 'finished' || job.state === 'failed' || job.state === 'cancelled') return Response.json(graphResponse(ctx, job));
  if (job.agent_id) {
    const agent = ctx.getConnectedAgents().get(job.agent_id);
    try {
      agent?.ws.send(JSON.stringify({ type: 'graph_cancel', job_id: jobId }));
    } catch (error) {
      console.error(`Failed to cancel graph ${jobId}:`, error);
    }
    if (!agent) job.agent_id = null;
  }
  job.state = 'cancelled';
  job.error = 'Cancelled by client';
  job.completed_at = new Date().toISOString();
  job.updated_at = job.completed_at;
  job.execution_receipt = await buildGraphReceipt(job, 'cancelled', job.completed_at, {
    error: job.error,
  });
  await ctx.saveGraphJob(job);
  ctx.graphJobs.delete(jobId);
  await ctx.scheduleGraphWebhookIfNeeded(job);
  return Response.json(graphResponse(ctx, job));
}

export async function handleRetryGraphJob(ctx: RelayContext, jobId: string): Promise<Response> {
  const job = await ctx.getGraphJob(jobId);
  if (!job) return Response.json({ error: 'Graph job not found' }, { status: 404 });
  if (hasLocalCustody(job)) return Response.json({ code: 'TERMINAL_RETRY_REQUIRES_NEW_EXECUTION' }, { status: 409 });
  if (!['failed', 'cancelled'].includes(job.state)) return Response.json({ error: 'Only failed or cancelled graph jobs can be retried' }, { status: 409 });
  if (job.state === 'cancelled' && job.agent_id) {
    return Response.json({ error: 'Graph cancellation is still settling on its worker' }, { status: 409 });
  }
  job.state = 'queued';
  job.agent_id = null;
  job.error = null;
  job.assigned_at = null;
  job.started_at = null;
  job.completed_at = null;
  job.execution_receipt = undefined;
  job.updated_at = new Date().toISOString();
  job.events = [];
  job.last_event_sequence = -1;
  job.artifacts = retainedPublications(job);
  job.run_manifest = null;
  job.metrics = null;
  await ctx.saveGraphJob(job);
  await assignGraphToAgent(ctx, job);
  return Response.json(graphResponse(ctx, job));
}

export async function handleGraphEvent(
  ctx: RelayContext,
  message: GraphEventMessage,
  agentId: string | null = null,
): Promise<void> {
  const job = await ctx.getGraphJob(message.job_id);
  if (!job) return;
  if (!matchesCustodyAssignment(job, message.assignment_token)) return;
  if (hasLocalCustody(job)) message = { ...message, event: sanitizedGraphEvent(message.event) };
  if (agentId && job.agent_id !== agentId) return;
  if (['finished', 'failed', 'cancelled'].includes(job.state)) return;
  if (!Number.isSafeInteger(message.event.sequence)
      || typeof message.event.type !== 'string'
      || !RUN_STATES.has(message.event.state)
      || Number.isNaN(Date.parse(message.event.created_at))) return;
  const lastSequence = job.last_event_sequence ?? job.events.at(-1)?.sequence ?? -1;
  if (message.event.sequence !== lastSequence + 1) return;
  retainGraphEvent(job, message.event);
  job.last_event_sequence = message.event.sequence;
  job.state = hasLocalCustody(job) || ['finished', 'failed', 'cancelled'].includes(message.event.state) ? 'running' : message.event.state;
  if (!job.started_at && message.event.state === 'running') job.started_at = message.event.created_at;
  job.updated_at = new Date().toISOString();
  await ctx.saveGraphJob(job);
}

function validArtifactMetadata(artifact: GraphRunArtifact): boolean {
  return typeof artifact.name === 'string' && !!artifact.name && !artifact.name.includes('/')
    && typeof artifact.kind === 'string' && !!artifact.kind
    && typeof artifact.content_type === 'string' && !!artifact.content_type
    && typeof artifact.path === 'string' && !artifact.path.includes('\\') && isConfinedPath(artifact.path)
    && Number.isSafeInteger(artifact.size_bytes) && artifact.size_bytes >= 0
    && DIGEST_PATTERN.test(artifact.sha256);
}

async function graphArtifactError(ctx: RelayContext, job: GraphJob, artifacts: GraphRunArtifact[]): Promise<string | null> {
  const verifiedDigests = new Map<string, number>();
  for (const artifact of artifacts) {
    if (!validArtifactMetadata(artifact)) return `Invalid artifact metadata: ${artifact.name || 'unnamed'}`;
    const verifiedSize = verifiedDigests.get(artifact.sha256);
    if (verifiedSize !== undefined && verifiedSize !== artifact.size_bytes) return `Artifact aliases disagree on size: ${artifact.name}`;
    if (verifiedSize === undefined && !await hasStoredGraphArtifact(ctx, job, artifact)) return `Missing or invalid uploaded artifact: ${artifact.name}`;
    verifiedDigests.set(artifact.sha256, artifact.size_bytes);
  }
  return null;
}

async function graphResultTarget(ctx: RelayContext, job: GraphJob, token: string): Promise<GraphJob | null> {
  const current = await ctx.getGraphJob(job.job_id);
  return current && current.node_token === token && current.agent_id
    && (!hasLocalCustody(current) || current.payload_delivered_at)
    && ['assigned', 'preflighting', 'running'].includes(current.state) ? current : null;
}

export async function handleGraphResult(
  ctx: RelayContext,
  message: GraphResultMessage,
  agentId: string | null = null,
): Promise<void> {
  const job = await ctx.getGraphJob(message.job_id);
  if (!job) return;
  if (!matchesCustodyAssignment(job, message.assignment_token)) return;
  const assignmentToken = job.node_token;
  if (agentId && job.agent_id !== agentId) return;
  if (job.state === 'cancelled') {
    releaseAgent(ctx, job.agent_id);
    job.agent_id = null;
    await ctx.saveGraphJob(job);
    await ctx.assignQueuedWork();
    return;
  }
  if (job.state === 'finished' || job.state === 'failed') return;
  const safeManifest = hasLocalCustody(job) ? sanitizedRunManifest(job, message.run_manifest) : message.run_manifest;
  if (!safeManifest || (hasLocalCustody(job) && (!job.payload_delivered_at
      || message.artifacts.some((artifact) => !custodyArtifactAllowed(job, artifact))))) {
    await handleGraphError(ctx, { type: 'graph_error', job_id: job.job_id, assignment_token: assignmentToken,
      error: 'LOCAL_CUSTODY_RESULT_INVALID' }, agentId);
    return;
  }
  const manifest: Record<string, unknown> = {
    ...safeManifest,
    attempt: job.attempt,
  };
  if (manifest.contract_version !== 'mere.run/graph-run.v1'
      || manifest.job_id !== job.job_id
      || manifest.graph_fingerprint !== job.job.graph_fingerprint
      || manifest.state !== 'finished') {
    await handleGraphError(ctx, { type: 'graph_error', job_id: job.job_id, assignment_token: assignmentToken,
      error: 'Worker returned an invalid graph run manifest' }, agentId);
    return;
  }
  const names = new Set(message.artifacts.map((artifact) => artifact.name));
  if (names.size !== message.artifacts.length
      || job.job.outputs.some((output) => !message.artifacts.some((artifact) => artifact.name === output.name && artifact.kind === 'graph.output'))) {
    await handleGraphError(ctx, { type: 'graph_error', job_id: job.job_id, assignment_token: assignmentToken,
      error: 'Worker did not return every declared graph output' }, agentId);
    return;
  }
  const artifactError = await graphArtifactError(ctx, job, message.artifacts);
  if (artifactError) {
    await handleGraphError(ctx, { type: 'graph_error', job_id: job.job_id, assignment_token: assignmentToken,
      error: artifactError }, agentId);
    return;
  }
  const completedAt = new Date().toISOString();
  const completion = { run_manifest: manifest, artifacts: message.artifacts, metrics: message.metrics ?? null,
    state: 'finished' as const, error: null, completed_at: completedAt, updated_at: completedAt };
  const executionReceipt = await buildGraphReceipt({ ...job, ...completion }, 'complete', completedAt, {
    output: {
      run_manifest: manifest,
      artifacts: message.artifacts.map((artifact) => ({
        name: artifact.name,
        sha256: artifact.sha256,
        size_bytes: artifact.size_bytes,
      })),
    },
  });
  // R2 verification and digest calculation yield. Never let a superseded
  // result overwrite cancellation, a new assignment, or its terminal receipt.
  const current = await graphResultTarget(ctx, job, assignmentToken);
  if (!current) return;
  Object.assign(current, completion, { artifacts: mergePublications(current, message.artifacts), execution_receipt: executionReceipt });
  releaseAgent(ctx, current.agent_id);
  if (!hasLocalCustody(current)) await ctx.env.IMAGES.put(
    graphRunManifestKey(current.user_id, current.job_id),
    JSON.stringify(manifest),
    { httpMetadata: { contentType: 'application/json' } },
  );
  await ctx.saveGraphJob(current);
  requestAssignedNodeInventory(ctx, current.agent_id);
  ctx.graphJobs.delete(current.job_id);
  await ctx.scheduleGraphWebhookIfNeeded(current);
  await ctx.assignQueuedWork();
}

export async function handleGraphError(
  ctx: RelayContext,
  message: GraphErrorMessage,
  agentId: string | null = null,
): Promise<void> {
  const job = await ctx.getGraphJob(message.job_id);
  if (!job) return;
  if (!matchesCustodyAssignment(job, message.assignment_token)) return;
  if (agentId && job.agent_id !== agentId) return;
  if (job.state === 'cancelled') {
    releaseAgent(ctx, job.agent_id);
    job.agent_id = null;
    await ctx.saveGraphJob(job);
    await ctx.assignQueuedWork();
    return;
  }
  if (job.state === 'finished' || job.state === 'failed') return;
  releaseAgent(ctx, job.agent_id);
  job.state = 'failed';
  job.error = sanitizedTerminalError(message.error);
  job.completed_at = new Date().toISOString();
  job.updated_at = job.completed_at;
  job.execution_receipt = await buildGraphReceipt(job, 'failed', job.completed_at, {
    error: job.error,
  });
  await ctx.saveGraphJob(job);
  ctx.graphJobs.delete(job.job_id);
  await ctx.scheduleGraphWebhookIfNeeded(job);
  await ctx.assignQueuedWork();
}

export async function handleGraphNodeRequest(
  ctx: RelayContext,
  jobId: string,
  token: string,
  action: string,
  request: Request,
): Promise<Response> {
  const job = await ctx.getGraphJob(jobId);
  if (!job || job.node_token !== token) return Response.json({ error: 'Graph node token is invalid' }, { status: 404 });
  const custody = await handleCustodyNodeRequest(ctx, job, action, request);
  if (custody) return custody;
  if (action.startsWith('bundle/') && request.method === 'GET') {
    const path = decodeURIComponent(action.slice('bundle/'.length));
    const object = await graphBundleObject(ctx, job, path);
    if (!object) return Response.json({ error: 'Bundle file not found' }, { status: 404 });
    return new Response(object.body, { headers: { 'Content-Type': object.httpMetadata?.contentType || 'application/octet-stream' } });
  }
  const publication = await handlePublicGraphPublication(ctx, job, action, request);
  if (publication) return publication;
  if (action.startsWith('artifact-uploads/') && request.method === 'GET') {
    const digest = decodeURIComponent(action.slice('artifact-uploads/'.length));
    if (!DIGEST_PATTERN.test(digest)) {
      return Response.json({ error: 'Invalid graph artifact digest' }, { status: 400 });
    }
    const upload = await verifiedGraphArtifactUpload(ctx, job, digest);
    if (upload && !upload.complete && upload.parts.length > 0) {
      await recordGraphTelemetry(ctx, { resumed_parts_reported: upload.parts.length });
    }
    return upload
      ? Response.json(upload, { headers: { 'Cache-Control': 'no-store' } })
      : Response.json({ error: 'Graph artifact upload not found' }, { status: 404 });
  }
  if (action.startsWith('artifacts/') && request.method === 'PUT') {
    const name = decodeURIComponent(action.slice('artifacts/'.length));
    const size = Number(request.headers.get('X-Artifact-Size'));
    const sha256 = request.headers.get('X-Artifact-Sha256') || '';
    const path = request.headers.get('X-Artifact-Path') || name;
    const kind = request.headers.get('X-Artifact-Kind') || 'graph.output';
    const contentType = request.headers.get('Content-Type') || 'application/octet-stream';
    const artifact: GraphRunArtifact = { name, kind, path, content_type: contentType, size_bytes: size, sha256 };
    if (!validArtifactMetadata(artifact)) {
      return Response.json({ error: 'Invalid graph artifact metadata' }, { status: 400 });
    }
    const quota = await enforceGraphArtifactQuota(ctx, job, sha256, size);
    if (quota) return quota;
    const partIndexHeader = request.headers.get('X-Artifact-Part-Index');
    const partCountHeader = request.headers.get('X-Artifact-Part-Count');
    if (partIndexHeader !== null || partCountHeader !== null) {
      const partIndex = Number(partIndexHeader);
      const partCount = Number(partCountHeader);
      const partSize = Number(request.headers.get('X-Artifact-Part-Size'));
      const partSha256 = request.headers.get('X-Artifact-Part-Sha256') || '';
      if (!Number.isSafeInteger(partIndex) || !Number.isSafeInteger(partCount)
          || partIndex < 0 || partCount < 1 || partIndex >= partCount || partCount > MAX_ARTIFACT_PARTS
          || !Number.isSafeInteger(partSize) || partSize < 1 || partSize > MAX_ARTIFACT_PART_BYTES
          || !DIGEST_PATTERN.test(partSha256)) {
        return Response.json({ error: 'Invalid graph artifact part metadata' }, { status: 400 });
      }
      const bytes = await request.arrayBuffer();
      if (bytes.byteLength !== partSize || await sha256Hex(bytes) !== partSha256) {
        return Response.json({ error: 'Graph artifact part verification failed' }, { status: 400 });
      }
      job.artifact_uploads ??= {};
      const existing = job.artifact_uploads[sha256];
      if (existing && (existing.size_bytes !== size || existing.part_count !== partCount || existing.object_name)) {
        return Response.json({ error: 'Graph artifact part contract changed during upload' }, { status: 409 });
      }
      const parts = [...(existing?.parts ?? [])];
      const previous = parts.find((part) => part.index === partIndex);
      if (previous && (previous.size_bytes !== partSize || previous.sha256 !== partSha256)) {
        return Response.json({ error: 'Graph artifact part changed during upload' }, { status: 409 });
      }
      const nextParts = previous
        ? parts
        : [...parts, { index: partIndex, size_bytes: partSize, sha256: partSha256 }];
      if (nextParts.reduce((total, part) => total + part.size_bytes, 0) > size) {
        return Response.json({ error: 'Graph artifact parts exceed declared size' }, { status: 400 });
      }
      await storeGraphArtifactPart(ctx, job, sha256, partIndex, partSha256, bytes);
      const upload = { sha256, size_bytes: size, part_count: partCount,
        parts: nextParts.sort((left, right) => left.index - right.index) };
      if (!await saveGraphArtifactUpload(ctx, jobId, token, artifact, upload)) {
        return Response.json({ error: 'Graph assignment changed' }, { status: 409 });
      }
      await recordGraphTelemetry(ctx, {
        artifact_bytes_received: bytes.byteLength,
        artifact_parts_received: 1,
      });
      const complete = nextParts.length === partCount
        && nextParts.reduce((total, part) => total + part.size_bytes, 0) === size;
      return Response.json({ stored: true, name, part_index: partIndex, complete });
    }

    const bytes = await request.arrayBuffer();
    if (bytes.byteLength !== size || await sha256Hex(bytes) !== sha256) return Response.json({ error: 'Graph artifact verification failed' }, { status: 400 });
    await storeGraphArtifact(ctx, job, artifact, bytes);
    const upload = { sha256, size_bytes: size, object_name: graphArtifactObjectName(job, artifact), part_count: 0, parts: [] };
    if (!await saveGraphArtifactUpload(ctx, jobId, token, artifact, upload)) {
      return Response.json({ error: 'Graph assignment changed' }, { status: 409 });
    }
    await recordGraphTelemetry(ctx, { artifact_bytes_received: bytes.byteLength });
    return Response.json({ stored: true, name });
  }
  return new Response('Not Found', { status: 404 });
}

export async function handleGraphTelemetry(ctx: RelayContext): Promise<Response> {
  return Response.json(await graphRelayTelemetry(ctx), {
    headers: { 'Cache-Control': 'no-store' },
  });
}

export async function handleGetGraphRunManifest(ctx: RelayContext, jobId: string): Promise<Response> {
  const job = await ctx.getGraphJob(jobId);
  if (!job) return Response.json({ error: 'Graph job not found' }, { status: 404 });
  if (hasLocalCustody(job)) return job.run_manifest
    ? Response.json(job.run_manifest, { headers: { 'Cache-Control': 'no-store' } })
    : Response.json({ error: 'Run manifest not found' }, { status: 404 });
  if (job.run_manifest) return Response.json(job.run_manifest, { headers: { 'Cache-Control': 'no-store' } });
  if (job.attempt > 1) return Response.json({ error: 'Run manifest not found' }, { status: 404 });
  const object = await ctx.env.IMAGES.get(graphRunManifestKey(job.user_id, job.job_id));
  return object ? new Response(object.body, { headers: { 'Content-Type': 'application/json' } }) : Response.json({ error: 'Run manifest not found' }, { status: 404 });
}

export async function handleGetGraphArtifact(ctx: RelayContext, jobId: string, name: string): Promise<Response> {
  const job = await ctx.getGraphJob(jobId);
  if (!job) return Response.json({ error: 'Graph job not found' }, { status: 404 });
  const artifact = job.artifacts.find((candidate) => candidate.name === name);
  if (!artifact) return Response.json({ error: 'Graph artifact not found' }, { status: 404 });
  return await graphArtifactResponse(ctx, job, artifact)
    ?? Response.json({ error: 'Graph artifact not found' }, { status: 404 });
}

export async function graphFleetCapabilities(ctx: RelayContext): Promise<GraphWorkerCapabilities> {
  const workers = (await listFleetNodes(ctx))
    .filter((node) => node.status === 'online' || node.status === 'busy')
    .map((node) => node.capabilities.graph_worker)
    .filter((worker): worker is GraphWorkerCapabilities => worker !== undefined);
  const union = (select: (worker: GraphWorkerCapabilities) => string[]): string[] => [...new Set(workers.flatMap(select))].sort();
  const catalogNodes: Record<string, unknown>[] = workers.flatMap((worker) => {
    const document = worker.catalog;
    if (Array.isArray(document?.nodes)) {
      return document.nodes.filter(
        (entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null && !Array.isArray(entry)
      );
    }
    const result = document && typeof document.result === 'object' && document.result !== null
      ? document.result as Record<string, unknown>
      : null;
    return Array.isArray(result?.nodes)
      ? result.nodes.filter(
        (entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null && !Array.isArray(entry)
      )
      : [];
  });
  const catalog = catalogNodes.length > 0 ? {
    graph_kind: 'mere.run/workflow-graph',
    graph_schema_version: 1,
    job_contract_version: 'mere.run/job-bundle.v1',
    nodes: [...new Map(catalogNodes.map((entry) => {
      const provider = typeof entry.provider === 'object' && entry.provider !== null
        ? entry.provider as Record<string, unknown>
        : {};
      const providerId = typeof provider.id === 'string' ? provider.id : 'mere.run';
      const kind = typeof entry.kind === 'string' ? entry.kind : '';
      return [`${providerId}\u0000${kind}`, entry];
    })).values()].sort((left, right) => {
      const leftKind = typeof left.kind === 'string' ? left.kind : '';
      const rightKind = typeof right.kind === 'string' ? right.kind : '';
      return leftKind.localeCompare(rightKind);
    }),
    providers: [...new Map(workers.flatMap((worker) => worker.providers ?? []).map((provider) => [
      `${provider.id}\u0000${provider.version}\u0000${provider.catalog_sha256}`,
      provider,
    ])).values()],
  } : undefined;
  return {
    schema_version: 1,
    worker_version: workers.map((worker) => worker.worker_version).sort().at(-1) || 'unavailable',
    contract_versions: union((worker) => worker.contract_versions),
    data_policies: union((worker) => worker.data_policies ?? []),
    platform: workers.length === 1 ? workers[0].platform : 'fleet',
    architecture: workers.length === 1 ? workers[0].architecture : 'mixed',
    accelerator_backend: workers.length === 1 ? workers[0].accelerator_backend : 'mixed',
    memory_bytes: Math.max(0, ...workers.map((worker) => worker.memory_bytes)),
    system_memory_bytes: Math.max(0, ...workers.map((worker) => worker.system_memory_bytes || 0)),
    logical_cpu_cores: Math.max(0, ...workers.map((worker) => worker.logical_cpu_cores || 0)),
    available_disk_bytes: Math.max(0, ...workers.map((worker) => worker.available_disk_bytes || 0)),
    network_access: workers.some((worker) => worker.network_access === true),
    node_kinds: union((worker) => worker.node_kinds),
    installed_model_ids: union((worker) => worker.installed_model_ids),
    available_secret_names: union((worker) => worker.available_secret_names ?? []),
    cached_asset_digests: union((worker) => worker.cached_asset_digests ?? []),
    providers: [...new Map(
      workers.flatMap((worker) => worker.providers ?? []).map((provider) => [
        `${provider.id}\u0000${provider.version}\u0000${provider.catalog_sha256}`,
        provider,
      ])
    ).values()].sort((left, right) => left.id.localeCompare(right.id)),
    catalog,
  };
}

export function hasEligibleGraphWorker(ctx: RelayContext, job: GraphJob): boolean {
  return [...ctx.getConnectedAgents().values()].some((agent) => supportsGraph(agent.info, job));
}
