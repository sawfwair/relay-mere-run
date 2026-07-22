import type {
  Asr,
  AsrStatusResponse,
  Embed,
  EmbedStatusResponse,
  Job,
  JobStatusResponse,
  Tool,
  ToolStatusResponse,
} from './types';
import type { RelayContext } from './relay-context';
import { scheduleNextRelayAlarm } from './relay-alarm';

const WEBHOOK_BACKOFF_MS = [1000, 2000, 4000, 8000];

type WebhookKind = 'job' | 'asr' | 'embed' | 'tool';
type WebhookEvent =
  | 'job.completed'
  | 'job.failed'
  | 'job.cancelled'
  | 'asr.completed'
  | 'asr.failed'
  | 'asr.cancelled'
  | 'embed.completed'
  | 'embed.failed'
  | 'embed.cancelled'
  | 'tool.completed'
  | 'tool.failed'
  | 'tool.cancelled';

export interface WebhookDeliveryState {
  kind?: WebhookKind;
  work_id?: string;
  job_id?: string;
  webhook_url: string;
  event: WebhookEvent;
  attempts: number;
  next_attempt_at: number | null;
  last_error: string | null;
}

interface WebhookDescriptor<T> {
  kind: WebhookKind;
  id: string;
  work: T;
  webhookUrl: string | null;
  webhookSent: boolean;
  event: WebhookEvent | null;
  payload: JobStatusResponse | AsrStatusResponse | EmbedStatusResponse | ToolStatusResponse;
  storageKey: string;
  markSent(work: T): T;
}

function getWebhookTimeoutMs(ctx: RelayContext): number {
  const parsed = Number.parseInt(ctx.env.WEBHOOK_TIMEOUT_MS || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30000;
}

function getWebhookMaxAttempts(ctx: RelayContext): number {
  const parsed = Number.parseInt(ctx.env.WEBHOOK_MAX_ATTEMPTS || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5;
}

function getWebhookStateKey(kind: WebhookKind, id: string): string {
  return kind === 'job' ? `webhook:${id}` : `webhook:${kind}:${id}`;
}

function getStateKind(state: WebhookDeliveryState): WebhookKind {
  return state.kind ?? 'job';
}

function getStateWorkId(state: WebhookDeliveryState): string {
  return state.work_id ?? state.job_id ?? '';
}

function getWebhookEventForJobStatus(status: Job['status']): WebhookEvent | null {
  if (status === 'complete') return 'job.completed';
  if (status === 'failed') return 'job.failed';
  if (status === 'cancelled') return 'job.cancelled';
  return null;
}

function getWebhookEventForAsrStatus(status: Asr['status']): WebhookEvent | null {
  if (status === 'complete') return 'asr.completed';
  if (status === 'failed') return 'asr.failed';
  if (status === 'cancelled') return 'asr.cancelled';
  return null;
}

function getWebhookEventForEmbedStatus(status: Embed['status']): WebhookEvent | null {
  if (status === 'complete') return 'embed.completed';
  if (status === 'failed') return 'embed.failed';
  if (status === 'cancelled') return 'embed.cancelled';
  return null;
}

function getWebhookEventForToolStatus(status: Tool['status']): WebhookEvent | null {
  if (status === 'complete') return 'tool.completed';
  if (status === 'failed') return 'tool.failed';
  if (status === 'cancelled') return 'tool.cancelled';
  return null;
}

function getWebhookPayload(job: Job): JobStatusResponse {
  return {
    job_id: job.job_id,
    user_id: job.user_id,
    client_id: job.client_id,
    agent_id: job.agent_id,
    status: job.status,
    request: job.request,
    progress: job.progress,
    result: job.result,
    error: job.error,
    created_at: job.created_at,
    assigned_at: job.assigned_at,
    started_at: job.started_at,
    completed_at: job.completed_at,
    direct_image: job.direct_image,
  };
}

function getAsrWebhookPayload(asr: Asr): AsrStatusResponse {
  return {
    asr_id: asr.asr_id,
    user_id: asr.user_id,
    client_id: asr.client_id,
    agent_id: asr.agent_id,
    status: asr.status,
    request: asr.request,
    result: asr.result,
    error: asr.error,
    created_at: asr.created_at,
    started_at: asr.started_at,
    completed_at: asr.completed_at,
  };
}

function getEmbedWebhookPayload(embed: Embed): EmbedStatusResponse {
  return {
    embed_id: embed.embed_id,
    user_id: embed.user_id,
    client_id: embed.client_id,
    agent_id: embed.agent_id,
    status: embed.status,
    request: embed.request,
    result: embed.result,
    error: embed.error,
    created_at: embed.created_at,
    started_at: embed.started_at,
    completed_at: embed.completed_at,
  };
}

function getToolWebhookPayload(tool: Tool): ToolStatusResponse {
  return {
    tool_id: tool.tool_id,
    user_id: tool.user_id,
    client_id: tool.client_id,
    agent_id: tool.agent_id,
    status: tool.status,
    request: tool.request,
    progress: tool.progress,
    result: tool.result,
    error: tool.error,
    created_at: tool.created_at,
    started_at: tool.started_at,
    completed_at: tool.completed_at,
  };
}

function getJobDescriptor(job: Job): WebhookDescriptor<Job> {
  return {
    kind: 'job',
    id: job.job_id,
    work: job,
    webhookUrl: job.webhook_url,
    webhookSent: job.webhook_sent,
    event: getWebhookEventForJobStatus(job.status),
    payload: getWebhookPayload(job),
    storageKey: `job:${job.job_id}`,
    markSent: (currentJob) => ({ ...currentJob, webhook_sent: true }),
  };
}

function getAsrDescriptor(asr: Asr): WebhookDescriptor<Asr> {
  return {
    kind: 'asr',
    id: asr.asr_id,
    work: asr,
    webhookUrl: asr.webhook_url,
    webhookSent: asr.webhook_sent,
    event: getWebhookEventForAsrStatus(asr.status),
    payload: getAsrWebhookPayload(asr),
    storageKey: `asr:${asr.asr_id}`,
    markSent: (currentAsr) => ({ ...currentAsr, webhook_sent: true }),
  };
}

function getEmbedDescriptor(embed: Embed): WebhookDescriptor<Embed> {
  return {
    kind: 'embed',
    id: embed.embed_id,
    work: embed,
    webhookUrl: embed.webhook_url,
    webhookSent: embed.webhook_sent,
    event: getWebhookEventForEmbedStatus(embed.status),
    payload: getEmbedWebhookPayload(embed),
    storageKey: `embed:${embed.embed_id}`,
    markSent: (currentEmbed) => ({ ...currentEmbed, webhook_sent: true }),
  };
}

function getToolDescriptor(tool: Tool): WebhookDescriptor<Tool> {
  return {
    kind: 'tool',
    id: tool.tool_id,
    work: tool,
    webhookUrl: tool.webhook_url,
    webhookSent: tool.webhook_sent,
    event: getWebhookEventForToolStatus(tool.status),
    payload: getToolWebhookPayload(tool),
    storageKey: `tool:${tool.tool_id}`,
    markSent: (currentTool) => ({ ...currentTool, webhook_sent: true }),
  };
}

async function signWebhookPayload(
  ctx: RelayContext,
  timestamp: string,
  rawBody: string
): Promise<string> {
  const rawSecret = ctx.env.WEBHOOK_SIGNING_SECRET;
  const secret =
    typeof rawSecret === 'string' ? rawSecret : rawSecret ? await rawSecret.get() : '';
  const encoder = new TextEncoder();
  const keyData = encoder.encode(secret);
  const data = encoder.encode(`${timestamp}.${rawBody}`);
  const key = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, data);
  const bytes = new Uint8Array(signature);
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `v1=${hex}`;
}

async function attemptWebhookDelivery<T>(
  ctx: RelayContext,
  descriptor: WebhookDescriptor<T>,
  event: WebhookEvent,
  attemptsSoFar: number
): Promise<void> {
  const stateKey = getWebhookStateKey(descriptor.kind, descriptor.id);
  if (!descriptor.webhookUrl || descriptor.webhookSent) {
    await ctx.storage.delete(stateKey);
    await scheduleNextRelayAlarm(ctx);
    return;
  }

  const rawBody = JSON.stringify(descriptor.payload);
  const timestamp = `${Math.floor(Date.now() / 1000)}`;
  const signature = await signWebhookPayload(ctx, timestamp, rawBody);

  let ok = false;
  let lastError: string | null = null;

  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), getWebhookTimeoutMs(ctx));
  try {
    const response = await fetch(descriptor.webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-MereRunRelay-Timestamp': timestamp,
        'X-MereRunRelay-Signature': signature,
        'X-MereRunRelay-Event': event,
      },
      body: rawBody,
      signal: abortController.signal,
    });
    if (response.ok) {
      ok = true;
    } else {
      lastError = `HTTP ${response.status}`;
    }
  } catch (error) {
    if (error instanceof Error) {
      lastError = error.message;
    } else {
      lastError = 'Webhook request failed';
    }
  } finally {
    clearTimeout(timeoutId);
  }

  if (ok) {
    const marked = descriptor.markSent(descriptor.work);
    await ctx.storage.put(descriptor.storageKey, marked);
    if (descriptor.kind === 'job') {
      ctx.jobs.set(descriptor.id, marked as Job);
    } else if (descriptor.kind === 'asr') {
      ctx.asrs.set(descriptor.id, marked as Asr);
    } else if (descriptor.kind === 'embed') {
      ctx.embeds.set(descriptor.id, marked as Embed);
    } else {
      ctx.tools.set(descriptor.id, marked as Tool);
    }
    await ctx.storage.delete(stateKey);
    await scheduleNextRelayAlarm(ctx);
    return;
  }

  const attempts = attemptsSoFar + 1;
  if (attempts >= getWebhookMaxAttempts(ctx)) {
    console.error(
      `Webhook delivery exhausted retries for ${descriptor.kind} ${descriptor.id}: ${lastError ?? 'unknown error'}`
    );
    await ctx.storage.delete(stateKey);
    await scheduleNextRelayAlarm(ctx);
    return;
  }

  const backoffIndex = Math.min(attempts - 1, WEBHOOK_BACKOFF_MS.length - 1);
  const state: WebhookDeliveryState = {
    kind: descriptor.kind,
    work_id: descriptor.id,
    job_id: descriptor.kind === 'job' ? descriptor.id : undefined,
    webhook_url: descriptor.webhookUrl,
    event,
    attempts,
    next_attempt_at: Date.now() + WEBHOOK_BACKOFF_MS[backoffIndex],
    last_error: lastError,
  };
  await ctx.storage.put(stateKey, state);
  await scheduleNextRelayAlarm(ctx);
}

async function scheduleWebhookIfNeeded<T>(
  ctx: RelayContext,
  descriptor: WebhookDescriptor<T>
): Promise<void> {
  if (!descriptor.webhookUrl || descriptor.webhookSent || !descriptor.event) {
    return;
  }

  const existingState = await ctx.storage.get<WebhookDeliveryState>(
    getWebhookStateKey(descriptor.kind, descriptor.id)
  );
  if (existingState && existingState.attempts >= getWebhookMaxAttempts(ctx)) {
    return;
  }

  await attemptWebhookDelivery(ctx, descriptor, descriptor.event, existingState?.attempts ?? 0);
}

export async function scheduleJobWebhookIfNeeded(
  ctx: RelayContext,
  job: Job
): Promise<void> {
  await scheduleWebhookIfNeeded(ctx, getJobDescriptor(job));
}

export async function scheduleAsrWebhookIfNeeded(
  ctx: RelayContext,
  asr: Asr
): Promise<void> {
  await scheduleWebhookIfNeeded(ctx, getAsrDescriptor(asr));
}

export async function scheduleEmbedWebhookIfNeeded(
  ctx: RelayContext,
  embed: Embed
): Promise<void> {
  await scheduleWebhookIfNeeded(ctx, getEmbedDescriptor(embed));
}

export async function scheduleToolWebhookIfNeeded(
  ctx: RelayContext,
  tool: Tool
): Promise<void> {
  await scheduleWebhookIfNeeded(ctx, getToolDescriptor(tool));
}

async function loadDescriptorForState(
  ctx: RelayContext,
  state: WebhookDeliveryState
): Promise<WebhookDescriptor<Job | Asr | Embed | Tool> | null> {
  const kind = getStateKind(state);
  const id = getStateWorkId(state);
  if (!id) {
    return null;
  }

  if (kind === 'job') {
    const job = await ctx.storage.get<Job>(`job:${id}`);
    return job && job.webhook_url && !job.webhook_sent ? getJobDescriptor(job) : null;
  }
  if (kind === 'asr') {
    const asr = await ctx.storage.get<Asr>(`asr:${id}`);
    return asr && asr.webhook_url && !asr.webhook_sent ? getAsrDescriptor(asr) : null;
  }
  if (kind === 'embed') {
    const embed = await ctx.storage.get<Embed>(`embed:${id}`);
    return embed && embed.webhook_url && !embed.webhook_sent ? getEmbedDescriptor(embed) : null;
  }

  const tool = await ctx.storage.get<Tool>(`tool:${id}`);
  return tool && tool.webhook_url && !tool.webhook_sent ? getToolDescriptor(tool) : null;
}

export async function handleWebhookAlarm(ctx: RelayContext): Promise<void> {
  const pending = await ctx.storage.list<WebhookDeliveryState>({ prefix: 'webhook:' });
  if (pending.size === 0) {
    await scheduleNextRelayAlarm(ctx);
    return;
  }

  for (const [key, state] of pending) {
    const descriptor = await loadDescriptorForState(ctx, state);
    if (!descriptor) {
      await ctx.storage.delete(key);
      continue;
    }

    await attemptWebhookDelivery(ctx, descriptor, state.event, state.attempts);
  }

  await scheduleNextRelayAlarm(ctx);
}
