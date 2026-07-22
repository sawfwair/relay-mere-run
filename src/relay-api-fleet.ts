import type { RelayContext } from './relay-context';
import { readRequestJson } from './json';
import {
  applyFleetModelPlanRequestSchema,
  fleetNodePolicyPatchSchema,
  fleetSettingsPatchSchema,
  submitFleetModelPlanRequestSchema,
} from './contracts/fleet';
import { countQueuedWork } from './relay-queue';
import {
  buildFleetSnapshot,
  listFleetNodes,
  updateFleetNodePolicy,
  updateFleetSettings,
} from './relay-fleet';
import {
  applyFleetModelPlan,
  cancelFleetModelPlan,
  createFleetModelPlan,
  getFleetModelPlan,
  listFleetModelPlans,
} from './relay-model-plans';

export async function handleCreateFleetModelPlan(
  ctx: RelayContext,
  request: Request
): Promise<Response> {
  try {
    const body = await readRequestJson(request, submitFleetModelPlanRequestSchema);
    return Response.json(await createFleetModelPlan(ctx, body), { status: 201 });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : 'Invalid model plan' },
      { status: 400 }
    );
  }
}

export async function handleListFleetModelPlans(
  ctx: RelayContext,
  limit: number
): Promise<Response> {
  return Response.json({ plans: await listFleetModelPlans(ctx, limit) });
}

export async function handleGetFleetModelPlan(
  ctx: RelayContext,
  planId: string
): Promise<Response> {
  const plan = await getFleetModelPlan(ctx, planId);
  return plan
    ? Response.json(plan)
    : Response.json({ error: 'Model plan not found' }, { status: 404 });
}

export async function handleApplyFleetModelPlan(
  ctx: RelayContext,
  planId: string,
  request: Request
): Promise<Response> {
  try {
    const body = await readRequestJson(request, applyFleetModelPlanRequestSchema);
    const plan = await applyFleetModelPlan(ctx, planId, body);
    return plan
      ? Response.json(plan, { status: plan.state === 'applying' ? 202 : 200 })
      : Response.json({ error: 'Model plan not found' }, { status: 404 });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : 'Invalid model plan apply request' },
      { status: 409 }
    );
  }
}

export async function handleCancelFleetModelPlan(
  ctx: RelayContext,
  planId: string
): Promise<Response> {
  const plan = await cancelFleetModelPlan(ctx, planId);
  return plan
    ? Response.json(plan, { status: 202 })
    : Response.json({ error: 'Model plan not found' }, { status: 404 });
}

export async function handleRefreshFleetNode(
  ctx: RelayContext,
  deviceId: string
): Promise<Response> {
  const connected = [...ctx.getConnectedAgents().values()].find(
    (agent) => agent.info.device_id === deviceId
  );
  if (connected) {
    connected.ws.send(JSON.stringify({ type: 'inventory_request' }));
    return Response.json({ device_id: deviceId, requested: true }, { status: 202 });
  }
  const known = (await listFleetNodes(ctx)).some((node) => node.device_id === deviceId);
  return known
    ? Response.json({ error: 'Node is offline' }, { status: 409 })
    : Response.json({ error: 'Node not found' }, { status: 404 });
}

export async function handleFleetSnapshot(ctx: RelayContext): Promise<Response> {
  return Response.json(await buildFleetSnapshot(ctx, countQueuedWork(ctx)));
}

export async function handleUpdateFleetSettings(
  ctx: RelayContext,
  request: Request
): Promise<Response> {
  try {
    const patch = await readRequestJson(request, fleetSettingsPatchSchema);
    return Response.json(await updateFleetSettings(ctx, patch));
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : 'Invalid fleet settings' },
      { status: 400 }
    );
  }
}

export async function handleUpdateFleetNode(
  ctx: RelayContext,
  deviceId: string,
  request: Request
): Promise<Response> {
  try {
    const patch = await readRequestJson(request, fleetNodePolicyPatchSchema);
    const updated = await updateFleetNodePolicy(ctx, deviceId, patch);
    if (!updated) {
      return Response.json({ error: 'Node not found' }, { status: 404 });
    }
    return Response.json(updated);
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : 'Invalid node policy' },
      { status: 400 }
    );
  }
}
