import type { RelayContext } from './relay-context';
import type { StatusResponse } from './types';
import { failStaleAgentWork } from './relay-lifecycle';
import { countQueuedWork } from './relay-queue';

const STALE_AGENT_TIMEOUT_MS = 2 * 60 * 1000;

async function cleanupStaleAgents(ctx: RelayContext): Promise<void> {
  await failStaleAgentWork(ctx, ctx.getConnectedAgents(), STALE_AGENT_TIMEOUT_MS);
  await ctx.assignQueuedWork();
}

export function acceptAgentWebSocket(ctx: RelayContext, request: Request): Response {
  ctx.setUserId(request.headers.get('X-User-Id') || '');

  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);
  ctx.acceptWebSocket(server);
  return new Response(null, { status: 101, webSocket: client });
}

export async function handleStatus(ctx: RelayContext): Promise<Response> {
  await cleanupStaleAgents(ctx);

  const agents = Array.from(ctx.getConnectedAgents().values()).map((agent) => ({
    agent_id: agent.info.agent_id,
    device_name: agent.info.device_name,
    status: agent.info.status,
    last_seen: agent.info.last_ping,
    current_job_id: agent.info.current_job_id,
    capabilities: agent.info.capabilities,
  }));

  const response: StatusResponse = {
    agents,
    queue_depth: countQueuedWork(ctx),
  };
  return Response.json(response);
}
