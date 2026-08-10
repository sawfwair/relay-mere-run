import type { AgentInfo } from './types';
import type { RelayContext, WebSocketAttachment } from './relay-context';
import { buildChatReceiptBase, buildGraphReceipt } from './relay-receipts';

export function getWebSocketAttachment(ws: WebSocket): WebSocketAttachment | null {
  return ws.deserializeAttachment() as WebSocketAttachment | null;
}

export function releaseAgent(ctx: RelayContext, agentId: string | null): void {
  if (!agentId) return;
  const agent = ctx.getConnectedAgents().get(agentId);
  if (agent) {
    ctx.updateAgentInfo(agent.ws, { status: 'online', current_job_id: null });
  }
}

export async function forwardMessageToOwnerIfNeeded(
  ctx: RelayContext,
  ownerUserId: string | undefined,
  path: string,
  payload: unknown,
  missingLog: string
): Promise<boolean> {
  if (ownerUserId && ownerUserId !== ctx.userId) {
    console.log(`Forwarding ${path.slice('/internal/'.length)} to owner DO ${ownerUserId}`);
    const ownerId = ctx.env.MERE_RUN_RELAY.idFromName(ownerUserId);
    const ownerDO = ctx.env.MERE_RUN_RELAY.get(ownerId);
    await ownerDO.fetch(
      new Request(`https://internal${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
    );
    return true;
  }

  console.log(missingLog);
  return false;
}

export function scheduleMemoryEviction<T>(
  map: Map<string, T>,
  workId: string,
  delayMs: number
): void {
  setTimeout(() => {
    map.delete(workId);
  }, delayMs);
}

interface FinishWorkOptions<T> {
  ctx: RelayContext;
  work: T;
  workId: string;
  agentId: string | null;
  map: Map<string, T>;
  persist: (work: T) => Promise<void>;
  retainInMemoryMs?: number;
  logMessage?: string;
  afterPersist?: () => Promise<void>;
}

export async function finishTerminalWork<T>(options: FinishWorkOptions<T>): Promise<void> {
  releaseAgent(options.ctx, options.agentId);
  await options.persist(options.work);
  if (options.afterPersist) {
    await options.afterPersist();
  }

  if (options.retainInMemoryMs && options.retainInMemoryMs > 0) {
    scheduleMemoryEviction(options.map, options.workId, options.retainInMemoryMs);
  } else {
    options.map.delete(options.workId);
  }

  if (options.logMessage) {
    console.log(options.logMessage);
  }
  await options.ctx.assignQueuedWork();
}

interface CancelableWork {
  agent_id: string | null;
  status: string;
  completed_at: string | null;
  error: string | null;
}

interface CancelWorkOptions<T extends CancelableWork> {
  ctx: RelayContext;
  work: T;
  workId: string;
  map: Map<string, T>;
  persist: (work: T) => Promise<void>;
  cancelMessage: unknown;
  cancelLogLabel: string;
  afterPersist?: () => Promise<void>;
  logMessage?: string;
}

export async function cancelWork<T extends CancelableWork>(
  options: CancelWorkOptions<T>
): Promise<'already_cancelled' | 'already_completed' | 'cancelled'> {
  if (options.work.status === 'cancelled') {
    return 'already_cancelled';
  }

  if (options.work.status === 'complete' || options.work.status === 'failed') {
    return 'already_completed';
  }

  sendCancelToAgent(
    options.ctx,
    options.work.agent_id,
    options.cancelMessage,
    options.cancelLogLabel
  );

  options.work.status = 'cancelled';
  options.work.error = 'Cancelled by client';
  options.work.completed_at = new Date().toISOString();

  await finishTerminalWork({
    ctx: options.ctx,
    work: options.work,
    workId: options.workId,
    agentId: options.work.agent_id,
    map: options.map,
    persist: options.persist,
    afterPersist: options.afterPersist,
    logMessage: options.logMessage,
  });

  return 'cancelled';
}

export function sendCancelToAgent(
  ctx: RelayContext,
  agentId: string | null,
  payload: unknown,
  errorLabel: string
): void {
  if (!agentId) return;
  const agent = ctx.getConnectedAgents().get(agentId);
  if (!agent) return;

  try {
    agent.ws.send(JSON.stringify(payload));
  } catch (error) {
    console.error(errorLabel, error);
  }
  ctx.updateAgentInfo(agent.ws, { status: 'online', current_job_id: null });
}

export async function failStaleAgentWork(
  ctx: RelayContext,
  agents: Map<string, { ws: WebSocket; info: AgentInfo }>,
  staleAfterMs: number
): Promise<void> {
  const now = Date.now();

  for (const [agentId, agent] of agents) {
    const lastPingTime = new Date(agent.info.last_ping).getTime();
    const timeSinceLastPing = now - lastPingTime;

    if (agent.info.status === 'busy' && timeSinceLastPing > staleAfterMs) {
      console.log(
        `Agent ${agentId} is stale (${Math.round(timeSinceLastPing / 1000)}s since last ping), resetting`
      );
      await ctx.failInProgressWorkForAgent(agent.info, 'Agent became unresponsive');
      ctx.updateAgentInfo(agent.ws, { status: 'online', current_job_id: null });
    }
  }
}

export async function failInProgressWorkForAgent(
  ctx: RelayContext,
  info: AgentInfo,
  reason: string
): Promise<void> {
  if (!info.current_job_id) return;
  await failInProgressWork(ctx, info.current_job_id, reason, info.agent_id);
}

export async function failInProgressWork(
  ctx: RelayContext,
  workId: string,
  reason: string,
  expectedAgentId?: string
): Promise<void> {
  const completedAt = new Date().toISOString();

  const job = ctx.jobs.get(workId);
  if (
    job
    && (!expectedAgentId || job.agent_id === expectedAgentId)
    && (job.status === 'assigned' || job.status === 'generating')
  ) {
    if (job.lease_aware && (job.attempts ?? 1) < (job.max_attempts ?? 1)) {
      job.status = 'queued';
      job.agent_id = null;
      job.progress = null;
      job.error = null;
      job.assigned_at = null;
      job.started_at = null;
      job.lease_id = null;
      await ctx.saveJob(job);
      console.log(`Job ${job.job_id} requeued after ${reason.toLowerCase()}`);
      return;
    }
    job.status = 'failed';
    job.error = reason;
    job.completed_at = completedAt;
    await ctx.storage.put(`job:${job.job_id}`, ctx.prepareJobForStorage(job));
    ctx.jobs.delete(job.job_id);
    return;
  }

  const chat = ctx.chats.get(workId);
  if (chat && (!expectedAgentId || chat.agent_id === expectedAgentId) && chat.status === 'processing') {
    chat.status = 'failed';
    chat.error = reason;
    chat.completed_at = completedAt;
    chat.execution_receipt = {
      ...buildChatReceiptBase(ctx, chat, completedAt),
      state: 'failed',
      error_code: 'EXECUTION_FAILED',
    };
    await ctx.saveChat(chat);
    ctx.chats.delete(chat.chat_id);
    return;
  }

  const talk = ctx.talks.get(workId);
  if (talk && (!expectedAgentId || talk.agent_id === expectedAgentId) && talk.status === 'processing') {
    talk.status = 'failed';
    talk.error = reason;
    talk.completed_at = completedAt;
    await ctx.storage.put(`talk:${talk.talk_id}`, ctx.prepareTalkForStorage(talk));
    ctx.talks.delete(talk.talk_id);
    return;
  }

  const asr = ctx.asrs.get(workId);
  if (asr && (!expectedAgentId || asr.agent_id === expectedAgentId) && asr.status === 'processing') {
    asr.status = 'failed';
    asr.error = reason;
    asr.completed_at = completedAt;
    await ctx.storage.put(`asr:${asr.asr_id}`, asr);
    ctx.asrs.delete(asr.asr_id);
    return;
  }

  const embed = ctx.embeds.get(workId);
  if (embed && (!expectedAgentId || embed.agent_id === expectedAgentId) && embed.status === 'processing') {
    embed.status = 'failed';
    embed.error = reason;
    embed.completed_at = completedAt;
    await ctx.storage.put(`embed:${embed.embed_id}`, embed);
    ctx.embeds.delete(embed.embed_id);
    return;
  }

  const ocr = ctx.ocrs.get(workId);
  if (ocr && (!expectedAgentId || ocr.agent_id === expectedAgentId) && ocr.status === 'processing') {
    ocr.status = 'failed';
    ocr.error = reason;
    ocr.completed_at = completedAt;
    await ctx.storage.put(`ocr:${ocr.ocr_id}`, ocr);
    ctx.ocrs.delete(ocr.ocr_id);
    return;
  }

  const tool = ctx.tools.get(workId);
  if (tool && (!expectedAgentId || tool.agent_id === expectedAgentId) && tool.status === 'processing') {
    tool.status = 'failed';
    tool.error = reason;
    tool.completed_at = completedAt;
    await ctx.storage.put(`tool:${tool.tool_id}`, tool);
    ctx.tools.delete(tool.tool_id);
    return;
  }

  const graph = ctx.graphJobs.get(workId);
  if (
    graph
    && (!expectedAgentId || graph.agent_id === expectedAgentId)
    && (graph.state === 'assigned' || graph.state === 'running' || graph.state === 'preflighting')
  ) {
    if (graph.attempt < graph.max_attempts) {
      graph.state = 'queued';
      graph.agent_id = null;
      graph.assigned_device_id = undefined;
      graph.error = null;
      graph.assigned_at = null;
      graph.started_at = null;
      graph.updated_at = completedAt;
      await ctx.saveGraphJob(graph);
      return;
    }
    graph.state = 'failed';
    graph.error = reason;
    graph.completed_at = completedAt;
    graph.updated_at = completedAt;
    graph.execution_receipt = await buildGraphReceipt(graph, 'failed', completedAt, { error: reason });
    await ctx.saveGraphJob(graph);
    ctx.graphJobs.delete(graph.job_id);
    await ctx.scheduleGraphWebhookIfNeeded(graph);
  }
}
