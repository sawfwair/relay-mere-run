import type { RelayContext, ConnectedAgentRecord } from './relay-context';
import { persistConnectedAgent, listFleetNodes } from './relay-fleet';
import type {
  ApplyFleetModelPlanRequest,
  FleetModelApplyResult,
  FleetModelPlan,
  FleetModelPlanEvent,
  FleetModelPlanTarget,
  ModelPlanEventMessage,
  ModelPlanResultMessage,
  SubmitFleetModelPlanRequest,
} from './types';

const MODEL_PLAN_PREFIX = 'fleet:model-plan:';
const MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const MAX_MODELS_PER_PLAN = 128;
const MAX_TARGETS_PER_PLAN = 32;
const MAX_EVENTS_PER_PLAN = 2_000;

function planKey(planId: string): string {
  return `${MODEL_PLAN_PREFIX}${planId}`;
}

function uniqueStrings(values: string[], label: string, maximum: number): string[] {
  if (!Array.isArray(values) || values.some((value) => typeof value !== 'string')) {
    throw new Error(`${label} must be an array of strings`);
  }
  const normalized = [...new Set(values.map((value) => value.trim()).filter(Boolean))];
  if (normalized.length === 0) throw new Error(`${label} must not be empty`);
  if (normalized.length > maximum) throw new Error(`${label} exceeds the limit of ${maximum}`);
  return normalized;
}

function validateModelIds(values: string[], allowEmpty = false): string[] {
  if (allowEmpty && values.length === 0) return [];
  const modelIds = uniqueStrings(values, 'model_ids', MAX_MODELS_PER_PLAN);
  const invalid = modelIds.find((modelId) => !MODEL_ID_PATTERN.test(modelId));
  if (invalid) throw new Error(`Invalid model id: ${invalid}`);
  return modelIds.sort();
}

function connectedNode(ctx: RelayContext, deviceId: string): ConnectedAgentRecord | undefined {
  return [...ctx.getConnectedAgents().values()].find((agent) => agent.info.device_id === deviceId);
}

function appendEvent(
  plan: FleetModelPlan,
  deviceId: string,
  phase: string,
  modelId?: string,
  message?: string
): void {
  const event: FleetModelPlanEvent = {
    sequence: (plan.events.at(-1)?.sequence ?? 0) + 1,
    created_at: new Date().toISOString(),
    device_id: deviceId,
    phase: phase.slice(0, 64),
    ...(modelId ? { model_id: modelId } : {}),
    ...(message?.trim() ? { message: message.trim().slice(0, 1_000) } : {}),
  };
  plan.events = [...plan.events, event].slice(-MAX_EVENTS_PER_PLAN);
}

function updatePlanState(plan: FleetModelPlan): void {
  if (plan.state === 'cancelled') return;
  if (plan.targets.some((target) => target.state === 'applying')) {
    plan.state = 'applying';
    plan.completed_at = null;
    return;
  }
  const terminal = plan.targets.every((target) =>
    ['noop', 'finished', 'failed', 'offline', 'cancelled'].includes(target.state)
  );
  if (!terminal) {
    plan.state = 'planned';
    plan.completed_at = null;
    return;
  }
  const failed = plan.targets.some((target) =>
    ['failed', 'offline', 'cancelled'].includes(target.state)
  );
  plan.state = failed ? 'failed' : 'finished';
  plan.completed_at = new Date().toISOString();
}

async function savePlan(ctx: RelayContext, plan: FleetModelPlan): Promise<void> {
  plan.updated_at = new Date().toISOString();
  await ctx.storage.put(planKey(plan.plan_id), plan);
}

export async function getFleetModelPlan(
  ctx: RelayContext,
  planId: string
): Promise<FleetModelPlan | null> {
  return (await ctx.storage.get<FleetModelPlan>(planKey(planId))) ?? null;
}

export async function listFleetModelPlans(
  ctx: RelayContext,
  limit: number
): Promise<FleetModelPlan[]> {
  const stored = await ctx.storage.list<FleetModelPlan>({ prefix: MODEL_PLAN_PREFIX });
  return [...stored.values()]
    .sort((left, right) => right.created_at.localeCompare(left.created_at))
    .slice(0, Math.max(1, Math.min(100, Math.round(limit))));
}

export async function createFleetModelPlan(
  ctx: RelayContext,
  request: SubmitFleetModelPlanRequest
): Promise<FleetModelPlan> {
  const targetDeviceIds = uniqueStrings(
    request.target_device_ids,
    'target_device_ids',
    MAX_TARGETS_PER_PLAN
  );
  const sourceDeviceId = request.source_device_id?.trim() || null;
  const nodes = await listFleetNodes(ctx);
  const nodesById = new Map(nodes.map((node) => [node.device_id, node]));
  const missingTarget = targetDeviceIds.find((deviceId) => !nodesById.has(deviceId));
  if (missingTarget) throw new Error(`Target node not found: ${missingTarget}`);

  let modelIds: string[];
  if (request.model_ids !== undefined) {
    modelIds = validateModelIds(request.model_ids);
  } else {
    if (!sourceDeviceId) throw new Error('source_device_id is required when model_ids is omitted');
    const source = nodesById.get(sourceDeviceId);
    if (!source) throw new Error(`Source node not found: ${sourceDeviceId}`);
    if (source.runtime?.inventory_status !== 'reported' && source.runtime?.inventory_status !== 'empty') {
      throw new Error(`Source node ${sourceDeviceId} has not reported a reliable model inventory`);
    }
    modelIds = validateModelIds(source.runtime.installed_models);
  }

  const now = new Date().toISOString();
  const targets: FleetModelPlanTarget[] = targetDeviceIds.map((deviceId) => {
    const node = nodesById.get(deviceId)!;
    const installed = [...new Set(node.runtime?.installed_models ?? [])].sort();
    const installedSet = new Set(installed);
    const missing = modelIds.filter((modelId) => !installedSet.has(modelId));
    return {
      device_id: deviceId,
      device_name: node.device_name,
      installed_model_ids: installed,
      missing_model_ids: missing,
      state: missing.length === 0 ? 'noop' : node.status === 'offline' ? 'offline' : 'ready',
      results: [],
      error: node.status === 'offline' && missing.length > 0 ? 'Node is offline' : null,
      started_at: null,
      completed_at: missing.length === 0 ? now : null,
    };
  });
  const plan: FleetModelPlan = {
    schema_version: 1,
    kind: 'mere.run/fleet-model-plan',
    plan_id: crypto.randomUUID(),
    source_device_id: sourceDeviceId,
    model_ids: modelIds,
    targets,
    events: [],
    attempt: 0,
    state: 'planned',
    created_at: now,
    updated_at: now,
    applied_at: null,
    completed_at: null,
  };
  updatePlanState(plan);
  await savePlan(ctx, plan);
  return plan;
}

function currentMissingModels(
  plan: FleetModelPlan,
  target: FleetModelPlanTarget,
  connected: ConnectedAgentRecord
): string[] {
  const installed = new Set(connected.info.runtime?.installed_models ?? target.installed_model_ids);
  target.installed_model_ids = [...installed].sort();
  target.missing_model_ids = plan.model_ids.filter((modelId) => !installed.has(modelId));
  return target.missing_model_ids;
}

export async function applyFleetModelPlan(
  ctx: RelayContext,
  planId: string,
  request: ApplyFleetModelPlanRequest
): Promise<FleetModelPlan | null> {
  const plan = await getFleetModelPlan(ctx, planId);
  if (!plan) return null;
  if (plan.state === 'applying') throw new Error('Model plan is already applying');
  if (plan.state === 'cancelled') throw new Error('Cancelled model plans cannot be applied');
  if (request.accept_model_licenses !== undefined && typeof request.accept_model_licenses !== 'boolean') {
    throw new Error('accept_model_licenses must be a boolean');
  }

  const now = new Date().toISOString();
  plan.attempt += 1;
  plan.applied_at = now;
  plan.completed_at = null;
  for (const target of plan.targets) {
    const connected = connectedNode(ctx, target.device_id);
    if (!connected) {
      target.state = 'offline';
      target.error = 'Node is offline';
      target.completed_at = now;
      appendEvent(plan, target.device_id, 'not_dispatched', undefined, target.error);
      continue;
    }
    if (connected.info.status !== 'online') {
      target.state = 'failed';
      target.error = `Node is busy with ${connected.info.current_job_id ?? 'another operation'}`;
      target.completed_at = now;
      appendEvent(plan, target.device_id, 'not_dispatched', undefined, target.error);
      continue;
    }
    if (connected.info.policy?.revoked || connected.info.policy?.enabled === false) {
      target.state = 'failed';
      target.error = 'Node is disabled or revoked by fleet policy';
      target.completed_at = now;
      appendEvent(plan, target.device_id, 'not_dispatched', undefined, target.error);
      continue;
    }

    const missing = currentMissingModels(plan, target, connected);
    if (missing.length === 0) {
      target.state = 'noop';
      target.error = null;
      target.completed_at = now;
      appendEvent(plan, target.device_id, 'already_satisfied');
      continue;
    }

    try {
      connected.ws.send(JSON.stringify({
        type: 'model_plan_request',
        plan_id: plan.plan_id,
        attempt: plan.attempt,
        model_ids: missing,
        accept_model_licenses: request.accept_model_licenses ?? false,
      }));
      target.state = 'applying';
      target.results = [];
      target.error = null;
      target.started_at = now;
      target.completed_at = null;
      appendEvent(plan, target.device_id, 'dispatched');
      const busyInfo = {
        ...connected.info,
        status: 'busy' as const,
        current_job_id: `model-plan:${plan.plan_id}`,
      };
      ctx.updateAgentInfo(connected.ws, busyInfo);
      await persistConnectedAgent(ctx, busyInfo);
    } catch (error) {
      target.state = 'failed';
      target.error = error instanceof Error ? error.message : 'Failed to dispatch model plan';
      target.completed_at = now;
      appendEvent(plan, target.device_id, 'dispatch_failed', undefined, target.error);
    }
  }
  updatePlanState(plan);
  await savePlan(ctx, plan);
  return plan;
}

export async function cancelFleetModelPlan(
  ctx: RelayContext,
  planId: string
): Promise<FleetModelPlan | null> {
  const plan = await getFleetModelPlan(ctx, planId);
  if (!plan) return null;
  if (['finished', 'failed', 'cancelled'].includes(plan.state)) return plan;
  for (const target of plan.targets.filter((candidate) => candidate.state === 'applying')) {
    const connected = connectedNode(ctx, target.device_id);
    if (connected) {
      connected.ws.send(JSON.stringify({ type: 'model_plan_cancel', plan_id: plan.plan_id }));
      appendEvent(plan, target.device_id, 'cancel_requested');
    }
  }
  plan.state = 'cancelled';
  plan.completed_at = new Date().toISOString();
  await savePlan(ctx, plan);
  return plan;
}

export async function handleFleetModelPlanEvent(
  ctx: RelayContext,
  message: ModelPlanEventMessage,
  agentId: string | null
): Promise<void> {
  if (!agentId) return;
  const connected = ctx.getConnectedAgents().get(agentId);
  if (!connected) return;
  const plan = await getFleetModelPlan(ctx, message.plan_id);
  if (!plan) return;
  if (message.attempt !== plan.attempt) return;
  const target = plan.targets.find((candidate) => candidate.device_id === connected.info.device_id);
  if (!target || target.state !== 'applying') return;
  if (message.model_id && !target.missing_model_ids.includes(message.model_id)) return;
  appendEvent(plan, target.device_id, message.phase, message.model_id, message.message);
  await savePlan(ctx, plan);
}

function normalizeResults(
  target: FleetModelPlanTarget,
  results: FleetModelApplyResult[]
): FleetModelApplyResult[] {
  const expected = new Set(target.missing_model_ids);
  const seen = new Set<string>();
  return results.filter((result) => {
    const valid = expected.has(result.model_id)
      && !seen.has(result.model_id)
      && ['installed', 'already_installed', 'failed', 'cancelled'].includes(result.state);
    if (valid) seen.add(result.model_id);
    return valid;
  }).map((result) => ({
    model_id: result.model_id,
    state: result.state,
    ...(result.error?.trim() ? { error: result.error.trim().slice(0, 2_000) } : {}),
  }));
}

export async function handleFleetModelPlanResult(
  ctx: RelayContext,
  message: ModelPlanResultMessage,
  agentId: string | null
): Promise<void> {
  if (!agentId) return;
  const connected = ctx.getConnectedAgents().get(agentId);
  if (!connected) return;
  const plan = await getFleetModelPlan(ctx, message.plan_id);
  if (!plan) return;
  if (message.attempt !== plan.attempt) return;
  const target = plan.targets.find((candidate) => candidate.device_id === connected.info.device_id);
  if (!target || target.state !== 'applying') return;

  target.results = normalizeResults(target, message.results);
  const returned = new Set(target.results.map((result) => result.model_id));
  for (const modelId of target.missing_model_ids.filter((modelId) => !returned.has(modelId))) {
    target.results.push({ model_id: modelId, state: 'failed', error: 'Node did not report a result' });
  }
  target.installed_model_ids = validateModelIds(message.installed_model_ids, true);
  target.missing_model_ids = plan.model_ids.filter(
    (modelId) => !target.installed_model_ids.includes(modelId)
  );
  const failed = target.results.find((result) => result.state === 'failed');
  const cancelled = target.results.some((result) => result.state === 'cancelled');
  target.state = cancelled ? 'cancelled' : failed || target.missing_model_ids.length > 0 ? 'failed' : 'finished';
  target.error = failed?.error ?? (target.missing_model_ids.length > 0
    ? `Models still missing: ${target.missing_model_ids.join(', ')}`
    : null);
  target.completed_at = new Date().toISOString();
  appendEvent(plan, target.device_id, target.state, undefined, target.error ?? undefined);

  const runtime = {
    ...(connected.info.runtime ?? { installed_models: [] }),
    installed_models: target.installed_model_ids,
    inventory_status: target.installed_model_ids.length > 0 ? 'reported' as const : 'empty' as const,
  };
  const availableInfo = { ...connected.info, status: 'online' as const, current_job_id: null, runtime };
  ctx.updateAgentInfo(connected.ws, availableInfo);
  await persistConnectedAgent(ctx, availableInfo);
  connected.ws.send(JSON.stringify({ type: 'inventory_request' }));

  updatePlanState(plan);
  await savePlan(ctx, plan);
  await ctx.assignQueuedWork();
}
