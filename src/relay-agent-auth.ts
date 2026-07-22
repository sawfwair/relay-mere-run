import type { RelayContext, WebSocketAttachment, AnyWebSocketAttachment } from './relay-context';
import { isAgentWebSocketAttachment } from './relay-context';
import type {
  AgentInfo,
  AvailabilityUpdateMessage,
  AuthMessage,
  InventoryUpdateMessage,
  PingMessage,
} from './types';
import {
  hydrateAgentFleetState,
  persistAgentInventory,
  persistConnectedAgent,
  updateAgentTelemetry,
} from './relay-fleet';
import { compactAgentInfoForAttachment } from './relay-agent-attachment';

async function agentIdForDevice(deviceId: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(deviceId));
  const suffix = Array.from(new Uint8Array(digest).slice(0, 8), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('');
  return `agent_${suffix}`;
}

export async function handleAvailabilityUpdate(
  ctx: RelayContext,
  ws: WebSocket,
  msg: AvailabilityUpdateMessage
): Promise<void> {
  const attachment = ws.deserializeAttachment() as WebSocketAttachment | null;
  if (!attachment) return;
  const localPrefix = `local:${msg.source}:`;
  const currentJobId = attachment.info.current_job_id;

  // A local owner may only clear or replace its own reservation. This closes
  // the narrow race where Relay assigns a job while Animatic is publishing a
  // busy transition from the native device gate.
  if (
    msg.source !== 'relay'
    && currentJobId
    && !currentJobId.startsWith(localPrefix)
  ) {
    return;
  }
  // Result handling may synchronously place the next queued job before the
  // Node's gate-release frame arrives. A release can clear only the exact work
  // id it names, never a newer assignment.
  if (
    msg.status === 'online'
    && currentJobId
    && currentJobId !== msg.current_job_id
  ) {
    return;
  }
  if (
    msg.status === 'busy'
    && msg.source === 'relay'
    && currentJobId
    && msg.current_job_id
    && currentJobId !== msg.current_job_id
  ) {
    return;
  }
  const updates: Partial<AgentInfo> = {
    status: msg.status,
    current_job_id: msg.status === 'busy'
      ? msg.current_job_id || `${localPrefix}unspecified`
      : null,
    last_ping: new Date().toISOString(),
  };
  ctx.updateAgentInfo(ws, updates);
  await persistConnectedAgent(ctx, { ...attachment.info, ...updates });
  if (msg.status === 'online') await ctx.assignQueuedWork();
}

export async function handleAuth(
  ctx: RelayContext,
  ws: WebSocket,
  msg: AuthMessage
): Promise<void> {
  for (const existingWs of ctx.getWebSockets()) {
    if (existingWs === ws) continue;
    const attachment = existingWs.deserializeAttachment() as AnyWebSocketAttachment | null;
    if (isAgentWebSocketAttachment(attachment) && attachment.info.device_id === msg.device_id) {
      console.log(`Closing old connection for device ${msg.device_id} (agent ${attachment.agentId})`);
      existingWs.serializeAttachment({ ...attachment, superseded: true });
      await ctx.failInProgressWorkForAgent(attachment.info, 'Agent reconnected');
      existingWs.close(1000, 'Replaced by new connection');
    }
  }

  const agentId = await agentIdForDevice(msg.device_id);
  const initialAvailability = msg.availability?.status === 'busy' ? msg.availability : null;
  const info: AgentInfo = {
    agent_id: agentId,
    device_id: msg.device_id,
    device_name: msg.device_name,
    version: msg.version,
    capabilities: msg.capabilities,
    status: initialAvailability ? 'busy' : 'online',
    current_job_id: initialAvailability?.current_job_id || (
      initialAvailability ? `local:${initialAvailability.source}:unspecified` : null
    ),
    connected_at: new Date().toISOString(),
    last_ping: new Date().toISOString(),
    system: msg.system,
    runtime: msg.runtime,
    capacity: msg.capacity,
  };

  const fleetNode = await hydrateAgentFleetState(ctx, info, msg.device_name);
  if (fleetNode.policy.revoked) {
    ws.send(JSON.stringify({
      type: 'auth_result',
      success: false,
      agent_id: agentId,
      user_id: ctx.userId,
      error: 'Node access has been revoked',
    }));
    ws.close(4003, 'Node access has been revoked');
    return;
  }

  const attachment: WebSocketAttachment = {
    agentId,
    info: compactAgentInfoForAttachment(info),
  };
  ws.serializeAttachment(attachment);

  ws.send(
    JSON.stringify({
      type: 'auth_result',
      success: true,
      agent_id: agentId,
      user_id: ctx.userId,
    })
  );

  console.log(`Agent ${agentId} (${msg.device_name}) authenticated`);
  if (info.status === 'online') await ctx.assignQueuedWork();
}

export async function handlePing(
  ctx: RelayContext,
  ws: WebSocket,
  msg: PingMessage
): Promise<void> {
  const attachment = ws.deserializeAttachment() as WebSocketAttachment | null;
  if (!attachment) return;
  await updateAgentTelemetry(ctx, ws, attachment.info, msg.telemetry);
  ws.send(JSON.stringify({ type: 'pong', timestamp_ms: msg.timestamp_ms }));
}

export async function handleInventoryUpdate(
  ctx: RelayContext,
  ws: WebSocket,
  msg: InventoryUpdateMessage
): Promise<void> {
  const attachment = ws.deserializeAttachment() as WebSocketAttachment | null;
  if (!attachment) return;
  const updates: Partial<AgentInfo> = {
    capabilities: msg.capabilities,
    system: msg.system,
    runtime: msg.runtime,
    capacity: msg.capacity,
    last_ping: new Date().toISOString(),
  };
  await persistAgentInventory(ctx, { ...attachment.info, ...updates });
  ctx.updateAgentInfo(ws, updates);
  await ctx.assignQueuedWork();
}
