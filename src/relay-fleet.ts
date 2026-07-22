import type { RelayContext } from './relay-context';
import type {
  AgentInfo,
  AgentTelemetry,
  FleetActivity,
  FleetModelCoverage,
  FleetNodePerformance,
  FleetNodePolicy,
  FleetNodeRecord,
  FleetSettings,
  GraphJob,
  FleetSnapshot,
  SchedulerMode,
} from './types';

const FLEET_NODE_PREFIX = 'fleet:node:';
const FLEET_SETTINGS_KEY = 'fleet:settings';
const ACTIVITY_PREFIXES = ['job:', 'chat:', 'talk:', 'asr:', 'embed:', 'ocr:', 'tool:', 'graph:'] as const;

export const DEFAULT_FLEET_NODE_POLICY: FleetNodePolicy = {
  enabled: true,
  draining: false,
  revoked: false,
  priority: 50,
  preferred_models: [],
  display_name: null,
};

export function defaultFleetSettings(): FleetSettings {
  return {
    scheduler_mode: 'balanced',
    retry_limit: 1,
    updated_at: new Date(0).toISOString(),
  };
}

function defaultPerformance(): FleetNodePerformance {
  return { models: {} };
}

function normalizePolicy(policy: Partial<FleetNodePolicy> | undefined): FleetNodePolicy {
  const priority = typeof policy?.priority === 'number' && Number.isFinite(policy.priority)
    ? policy.priority
    : DEFAULT_FLEET_NODE_POLICY.priority;
  const preferredModels = Array.isArray(policy?.preferred_models)
    ? policy.preferred_models.filter((model): model is string => typeof model === 'string')
    : [];
  const displayName = typeof policy?.display_name === 'string' ? policy.display_name.trim() : '';
  return {
    ...DEFAULT_FLEET_NODE_POLICY,
    ...policy,
    enabled: typeof policy?.enabled === 'boolean' ? policy.enabled : true,
    draining: typeof policy?.draining === 'boolean' ? policy.draining : false,
    revoked: typeof policy?.revoked === 'boolean' ? policy.revoked : false,
    priority: Math.max(0, Math.min(100, Math.round(priority))),
    preferred_models: Array.from(
      new Set(preferredModels.map((model) => model.trim()).filter(Boolean))
    ),
    display_name: displayName || null,
  };
}

function nodeStatus(info: AgentInfo, connected: boolean): FleetNodeRecord['status'] {
  const policy = normalizePolicy(info.policy);
  if (policy.revoked) return 'revoked';
  if (!policy.enabled) return 'disabled';
  if (policy.draining) return 'draining';
  if (!connected) return 'offline';
  return info.status;
}

function nodeKey(deviceId: string): string {
  return `${FLEET_NODE_PREFIX}${deviceId}`;
}

function recordFromInfo(
  info: AgentInfo,
  existing: FleetNodeRecord | undefined,
  connected: boolean,
  reportedName?: string
): FleetNodeRecord {
  const policy = normalizePolicy(info.policy ?? existing?.policy);
  const reported = reportedName?.trim() || existing?.reported_name || info.device_name;
  const now = new Date().toISOString();
  return {
    agent_id: info.agent_id,
    device_id: info.device_id,
    device_name: policy.display_name || reported,
    reported_name: reported,
    version: info.version,
    status: nodeStatus({ ...info, policy }, connected),
    current_job_id: connected ? info.current_job_id : null,
    first_seen: existing?.first_seen ?? info.connected_at ?? now,
    last_seen: info.last_ping || now,
    connected_at: connected ? info.connected_at : existing?.connected_at ?? null,
    capabilities: info.capabilities,
    system: info.system ?? existing?.system,
    runtime: info.runtime ?? existing?.runtime,
    capacity: info.capacity ?? existing?.capacity,
    telemetry: info.telemetry ?? existing?.telemetry,
    policy,
    performance: info.performance ?? existing?.performance ?? defaultPerformance(),
  };
}

export async function hydrateAgentFleetState(
  ctx: RelayContext,
  info: AgentInfo,
  reportedName: string
): Promise<FleetNodeRecord> {
  const existing = await ctx.storage.get<FleetNodeRecord>(nodeKey(info.device_id));
  info.policy = normalizePolicy(existing?.policy);
  info.performance = existing?.performance ?? defaultPerformance();
  info.system = info.system ?? existing?.system;
  info.runtime = info.runtime ?? existing?.runtime;
  info.capacity = info.capacity ?? existing?.capacity;
  info.telemetry = info.telemetry ?? existing?.telemetry;
  info.device_name = info.policy.display_name || reportedName;

  const record = recordFromInfo(info, existing, true, reportedName);
  await ctx.storage.put(nodeKey(info.device_id), record);
  return record;
}

export async function persistConnectedAgent(ctx: RelayContext, info: AgentInfo): Promise<void> {
  const existing = await ctx.storage.get<FleetNodeRecord>(nodeKey(info.device_id));
  const stateInfo = existing ? { ...info, capabilities: existing.capabilities } : info;
  await ctx.storage.put(nodeKey(info.device_id), recordFromInfo(stateInfo, existing, true));
}

export async function persistAgentInventory(ctx: RelayContext, info: AgentInfo): Promise<void> {
  const existing = await ctx.storage.get<FleetNodeRecord>(nodeKey(info.device_id));
  await ctx.storage.put(nodeKey(info.device_id), recordFromInfo(info, existing, true));
}

export async function updateAgentTelemetry(
  ctx: RelayContext,
  ws: WebSocket,
  info: AgentInfo,
  telemetry: AgentTelemetry | undefined
): Promise<void> {
  const lastPing = new Date().toISOString();
  const updates: Partial<AgentInfo> = { last_ping: lastPing };
  if (telemetry) updates.telemetry = telemetry;
  ctx.updateAgentInfo(ws, updates);
  await persistConnectedAgent(ctx, { ...info, ...updates });
}

export async function markAgentOffline(ctx: RelayContext, info: AgentInfo): Promise<void> {
  const existing = await ctx.storage.get<FleetNodeRecord>(nodeKey(info.device_id));
  const offlineInfo = {
    ...info,
    capabilities: existing?.capabilities ?? info.capabilities,
    current_job_id: null,
    last_ping: new Date().toISOString(),
  };
  await ctx.storage.put(nodeKey(info.device_id), recordFromInfo(offlineInfo, existing, false));
}

export async function listFleetNodes(ctx: RelayContext): Promise<FleetNodeRecord[]> {
  const stored = await ctx.storage.list<FleetNodeRecord>({ prefix: FLEET_NODE_PREFIX });
  const nodes = new Map<string, FleetNodeRecord>();
  for (const record of stored.values()) {
    nodes.set(record.device_id, {
      ...record,
      policy: normalizePolicy(record.policy),
      performance: record.performance ?? defaultPerformance(),
      status: record.policy?.revoked
        ? 'revoked'
        : record.policy?.enabled === false
          ? 'disabled'
          : record.policy?.draining
            ? 'draining'
            : 'offline',
      current_job_id: null,
    });
  }

  for (const agent of ctx.getConnectedAgents().values()) {
    const existing = nodes.get(agent.info.device_id);
    const connectedInfo = existing
      ? { ...agent.info, capabilities: existing.capabilities }
      : agent.info;
    nodes.set(agent.info.device_id, recordFromInfo(connectedInfo, existing, true));
  }

  return Array.from(nodes.values()).sort((left, right) => {
    const statusRank = (status: FleetNodeRecord['status']): number => {
      if (status === 'busy') return 0;
      if (status === 'online') return 1;
      if (status === 'draining') return 2;
      if (status === 'disabled') return 3;
      if (status === 'offline') return 4;
      return 5;
    };
    return statusRank(left.status) - statusRank(right.status)
      || left.device_name.localeCompare(right.device_name);
  });
}

export async function getFleetSettings(ctx: RelayContext): Promise<FleetSettings> {
  const stored = await ctx.storage.get<FleetSettings>(FLEET_SETTINGS_KEY);
  if (!stored) return defaultFleetSettings();
  const mode: SchedulerMode = ['balanced', 'fastest', 'efficient'].includes(stored.scheduler_mode)
    ? stored.scheduler_mode
    : 'balanced';
  return {
    scheduler_mode: mode,
    retry_limit: Math.max(0, Math.min(3, Math.round(stored.retry_limit ?? 1))),
    updated_at: stored.updated_at || new Date(0).toISOString(),
  };
}

export async function updateFleetSettings(
  ctx: RelayContext,
  patch: Partial<Pick<FleetSettings, 'scheduler_mode' | 'retry_limit'>>
): Promise<FleetSettings> {
  const current = await getFleetSettings(ctx);
  if (patch.scheduler_mode && !['balanced', 'fastest', 'efficient'].includes(patch.scheduler_mode)) {
    throw new Error('Invalid scheduler mode');
  }
  if (
    patch.retry_limit !== undefined
    && (typeof patch.retry_limit !== 'number' || !Number.isFinite(patch.retry_limit))
  ) {
    throw new Error('Retry limit must be a finite number');
  }
  const settings: FleetSettings = {
    scheduler_mode: patch.scheduler_mode ?? current.scheduler_mode,
    retry_limit: patch.retry_limit === undefined
      ? current.retry_limit
      : Math.max(0, Math.min(3, Math.round(patch.retry_limit))),
    updated_at: new Date().toISOString(),
  };
  await ctx.storage.put(FLEET_SETTINGS_KEY, settings);
  return settings;
}

export interface FleetNodePolicyPatch {
  enabled?: boolean;
  draining?: boolean;
  revoked?: boolean;
  priority?: number;
  preferred_models?: string[];
  display_name?: string | null;
}

export async function updateFleetNodePolicy(
  ctx: RelayContext,
  deviceId: string,
  patch: FleetNodePolicyPatch
): Promise<FleetNodeRecord | null> {
  for (const field of ['enabled', 'draining', 'revoked'] as const) {
    if (patch[field] !== undefined && typeof patch[field] !== 'boolean') {
      throw new Error(`${field} must be a boolean`);
    }
  }
  if (patch.priority !== undefined && (typeof patch.priority !== 'number' || !Number.isFinite(patch.priority))) {
    throw new Error('priority must be a finite number');
  }
  if (
    patch.preferred_models !== undefined
    && (!Array.isArray(patch.preferred_models)
      || patch.preferred_models.some((model) => typeof model !== 'string'))
  ) {
    throw new Error('preferred_models must be an array of strings');
  }
  if (
    patch.display_name !== undefined
    && patch.display_name !== null
    && typeof patch.display_name !== 'string'
  ) {
    throw new Error('display_name must be a string or null');
  }

  const key = nodeKey(deviceId);
  const existing = await ctx.storage.get<FleetNodeRecord>(key);
  if (!existing) return null;

  const policy = normalizePolicy({ ...existing.policy, ...patch });
  const updated: FleetNodeRecord = {
    ...existing,
    device_name: policy.display_name || existing.reported_name,
    policy,
    status: policy.revoked
      ? 'revoked'
      : !policy.enabled
        ? 'disabled'
        : policy.draining
          ? 'draining'
          : existing.status,
  };
  await ctx.storage.put(key, updated);

  for (const agent of ctx.getConnectedAgents().values()) {
    if (agent.info.device_id !== deviceId) continue;
    ctx.updateAgentInfo(agent.ws, {
      device_name: updated.device_name,
      policy,
    });
    if (policy.revoked) {
      await ctx.failInProgressWorkForAgent(agent.info, 'Node access revoked');
      agent.ws.close(4003, 'Node access revoked');
    }
    break;
  }

  await ctx.assignQueuedWork();
  return updated;
}

export async function recordNodePerformance(
  ctx: RelayContext,
  agentId: string | null,
  model: string,
  success: boolean,
  generationTimeMs?: number
): Promise<void> {
  if (!agentId) return;
  const agent = ctx.getConnectedAgents().get(agentId);
  if (!agent) return;

  const key = nodeKey(agent.info.device_id);
  const existing = await ctx.storage.get<FleetNodeRecord>(key);
  if (!existing) return;

  const performance = existing.performance ?? defaultPerformance();
  const current = performance.models[model] ?? {
    successes: 0,
    failures: 0,
    average_generation_time_ms: null,
    last_generation_time_ms: null,
    updated_at: new Date(0).toISOString(),
  };
  const duration = generationTimeMs && generationTimeMs > 0 ? generationTimeMs : null;
  const nextSuccesses = current.successes + (success ? 1 : 0);
  const nextAverage = success && duration !== null
    ? current.average_generation_time_ms === null || current.successes === 0
      ? duration
      : Math.round(
          ((current.average_generation_time_ms * current.successes) + duration) / nextSuccesses
        )
    : current.average_generation_time_ms;
  const metric = {
    successes: nextSuccesses,
    failures: current.failures + (success ? 0 : 1),
    average_generation_time_ms: nextAverage,
    last_generation_time_ms: duration ?? current.last_generation_time_ms,
    updated_at: new Date().toISOString(),
  };
  const nextPerformance: FleetNodePerformance = {
    models: { ...performance.models, [model]: metric },
  };
  existing.performance = nextPerformance;
  await ctx.storage.put(key, existing);
  ctx.updateAgentInfo(agent.ws, { performance: nextPerformance });
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function timestampValue(value: unknown): string | null {
  return typeof value === 'string' && !Number.isNaN(new Date(value).getTime()) ? value : null;
}

export function durationMs(startedAt: string | null, completedAt: string | null): number | null {
  if (!startedAt || !completedAt) return null;
  const duration = new Date(completedAt).getTime() - new Date(startedAt).getTime();
  return Number.isFinite(duration) && duration >= 0 ? duration : null;
}

function activityFromStored(prefix: string, value: Record<string, unknown>): FleetActivity | null {
  const request = value.request && typeof value.request === 'object'
    ? value.request as Record<string, unknown>
    : {};
  const createdAt = timestampValue(value.created_at);
  if (!createdAt) return null;
  const startedAt = timestampValue(value.started_at);
  const completedAt = timestampValue(value.completed_at);
  const agentId = stringValue(value.agent_id);
  const error = stringValue(value.error);
  const status = stringValue(value.status) ?? stringValue(value.state) ?? 'unknown';

  if (prefix === 'graph:') {
    const graph = value.graph && typeof value.graph === 'object'
      ? value.graph as Record<string, unknown>
      : {};
    const job = value.job && typeof value.job === 'object'
      ? value.job as Record<string, unknown>
      : {};
    const requirements = job.requirements && typeof job.requirements === 'object'
      ? job.requirements as Record<string, unknown>
      : {};
    const modelIds = Array.isArray(requirements.model_ids)
      ? requirements.model_ids.filter((model): model is string => typeof model === 'string')
      : [];
    return {
      id: stringValue(value.job_id) ?? 'unknown',
      kind: 'graph',
      status,
      agent_id: agentId,
      model: modelIds.join(', ') || undefined,
      label: stringValue(graph.name) ?? 'Workflow graph',
      created_at: createdAt,
      started_at: startedAt,
      completed_at: completedAt,
      duration_ms: durationMs(startedAt, completedAt),
      error,
    };
  }

  if (prefix === 'job:') {
    const requestedKind = stringValue(request.kind);
    const kind = requestedKind === 'music' || requestedKind === 'video' ? requestedKind : 'image';
    return {
      id: stringValue(value.job_id) ?? 'unknown',
      kind,
      status,
      agent_id: agentId,
      model: stringValue(request.model) ?? undefined,
      label: stringValue(request.prompt) ?? `${kind} generation`,
      created_at: createdAt,
      started_at: startedAt,
      completed_at: completedAt,
      duration_ms: durationMs(startedAt, completedAt),
      error,
    };
  }

  if (prefix === 'chat:') {
    const messages: unknown[] = Array.isArray(value.messages) ? value.messages as unknown[] : [];
    const last = messages.at(-1);
    const label = last && typeof last === 'object'
      ? stringValue((last as Record<string, unknown>).content)
      : null;
    return {
      id: stringValue(value.chat_id) ?? 'unknown',
      kind: 'chat',
      status,
      agent_id: agentId,
      model: stringValue(value.model) ?? undefined,
      label: label ?? 'Text chat',
      created_at: createdAt,
      started_at: startedAt,
      completed_at: completedAt,
      duration_ms: durationMs(startedAt, completedAt),
      error,
    };
  }

  const definitions: Record<string, { id: string; kind: FleetActivity['kind']; label: string }> = {
    'talk:': { id: 'talk_id', kind: 'talk', label: stringValue(request.text) ?? 'Speech generation' },
    'asr:': { id: 'asr_id', kind: 'asr', label: 'Speech transcription' },
    'embed:': { id: 'embed_id', kind: 'embed', label: 'Text embedding' },
    'ocr:': { id: 'ocr_id', kind: 'ocr', label: 'Image OCR' },
    'tool:': {
      id: 'tool_id',
      kind: 'tool',
      label: [stringValue(request.plugin), stringValue(request.command)].filter(Boolean).join(' ') || 'Plugin tool',
    },
  };
  const definition = definitions[prefix];
  if (!definition) return null;
  return {
    id: stringValue(value[definition.id]) ?? 'unknown',
    kind: definition.kind,
    status,
    agent_id: agentId,
    label: definition.label,
    created_at: createdAt,
    started_at: startedAt,
    completed_at: completedAt,
    duration_ms: durationMs(startedAt, completedAt),
    error,
  };
}

export async function listFleetActivity(ctx: RelayContext, limit = 60): Promise<FleetActivity[]> {
  const collections = await Promise.all(
    ACTIVITY_PREFIXES.map(async (prefix) => ({
      prefix,
      values: await ctx.storage.list<Record<string, unknown>>({ prefix, limit: 100 }),
    }))
  );
  const activity: FleetActivity[] = [];
  for (const collection of collections) {
    for (const value of collection.values.values()) {
      const item = activityFromStored(collection.prefix, value);
      if (item) activity.push(item);
    }
  }
  return activity
    .sort((left, right) => new Date(right.created_at).getTime() - new Date(left.created_at).getTime())
    .slice(0, limit);
}

function fleetModelCoverage(nodes: FleetNodeRecord[]): FleetModelCoverage[] {
  const coverage = new Map<string, FleetModelCoverage>();
  for (const node of nodes) {
    for (const model of node.capabilities.models) {
      const current = coverage.get(model) ?? {
        model,
        capable_nodes: 0,
        available_nodes: 0,
        fastest_average_ms: null,
      };
      current.capable_nodes += 1;
      if (node.status === 'online') current.available_nodes += 1;
      const average = node.performance.models[model]?.average_generation_time_ms;
      if (average !== null && average !== undefined) {
        current.fastest_average_ms = current.fastest_average_ms === null
          ? average
          : Math.min(current.fastest_average_ms, average);
      }
      coverage.set(model, current);
    }
  }
  return Array.from(coverage.values()).sort((left, right) =>
    right.available_nodes - left.available_nodes
    || right.capable_nodes - left.capable_nodes
    || left.model.localeCompare(right.model)
  );
}

export async function buildFleetSnapshot(
  ctx: RelayContext,
  queueDepth: number
): Promise<FleetSnapshot> {
  const [nodes, settings, activity] = await Promise.all([
    listFleetNodes(ctx),
    getFleetSettings(ctx),
    listFleetActivity(ctx),
  ]);
  const models = fleetModelCoverage(nodes);
  const installedModels = new Set(nodes.flatMap((node) => node.runtime?.installed_models ?? []));
  return {
    generated_at: new Date().toISOString(),
    settings,
    summary: {
      total_nodes: nodes.length,
      online_nodes: nodes.filter((node) => node.status === 'online' || node.status === 'busy').length,
      busy_nodes: nodes.filter((node) => node.status === 'busy' || node.current_job_id).length,
      available_nodes: nodes.filter((node) => node.status === 'online').length,
      queue_depth: queueDepth,
      installed_models: installedModels.size,
      routable_models: models.length,
    },
    nodes,
    models,
    activity,
  };
}

export function agentCanAcceptWork(info: AgentInfo): boolean {
  const policy = normalizePolicy(info.policy);
  return policy.enabled && !policy.draining && !policy.revoked;
}

export function scoreAgentForWork(info: AgentInfo, model: string, mode: SchedulerMode): number {
  const policy = normalizePolicy(info.policy);
  let score = policy.priority;
  if (policy.preferred_models.includes(model)) score += 30;

  const metric = info.performance?.models[model];
  if (mode === 'fastest' && metric?.average_generation_time_ms) {
    score += Math.max(0, 100_000 / metric.average_generation_time_ms);
  }
  if (mode === 'efficient') {
    if (info.telemetry?.power_source === 'ac' || info.telemetry?.power_source === 'external') score += 20;
    if (info.telemetry?.power_source === 'battery') score -= 30;
    if (info.telemetry?.low_power_mode) score -= 20;
    if (info.telemetry?.thermal_state === 'serious') score -= 25;
    if (info.telemetry?.thermal_state === 'critical') score -= 100;
  }
  if (info.telemetry?.memory_available_bytes) {
    score += Math.min(20, info.telemetry.memory_available_bytes / (1024 ** 3 * 4));
  }
  return score;
}

export function graphCachedInputBytes(info: AgentInfo, graph: GraphJob): number {
  const cached = new Set(info.capabilities.graph_worker?.cached_asset_digests ?? []);
  const assets = new Map<string, number>();
  for (const entry of graph.assets.groups.flatMap((group) => group.entries)) {
    assets.set(entry.digest, entry.size_bytes);
  }
  return [...assets.entries()].reduce(
    (total, [digest, sizeBytes]) => total + (cached.has(digest) ? sizeBytes : 0),
    0
  );
}

export function scoreAgentForGraph(
  info: AgentInfo,
  graph: GraphJob,
  mode: SchedulerMode
): number {
  let score = scoreAgentForWork(info, 'graph', mode);
  const models = graph.job.requirements.model_ids;
  score += Math.min(30, models.filter((model) => info.policy?.preferred_models.includes(model)).length * 10);

  const durations = models
    .map((model) => info.performance?.models[model]?.average_generation_time_ms)
    .filter((duration): duration is number => typeof duration === 'number' && duration > 0);
  if (mode === 'fastest' && durations.length > 0) {
    const average = durations.reduce((total, duration) => total + duration, 0) / durations.length;
    score += Math.max(0, 100_000 / average);
  }

  const totalInputBytes = graph.assets.groups
    .flatMap((group) => group.entries)
    .reduce((total, entry) => total + entry.size_bytes, 0);
  if (totalInputBytes > 0) {
    const cachedBytes = graphCachedInputBytes(info, graph);
    score += (cachedBytes / totalInputBytes) * 40;
    score += Math.min(20, cachedBytes / (1024 ** 3));
  }
  return score;
}
