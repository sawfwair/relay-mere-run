import { z } from 'zod';
import type {
  RelayContext,
  AsrBrowserWebSocketAttachment,
  AnyWebSocketAttachment,
  ConnectedAgentRecord,
} from './relay-context';
import { isAsrBrowserWebSocketAttachment } from './relay-context';
import { ASR_STREAM_ALARM_KEY, scheduleNextRelayAlarm } from './relay-alarm';
import { parseJson, readRequestJson } from './json';
import { asrStreamTicketRequestSchema } from './contracts/requests';
import { unknownRecordSchema } from './contracts/primitives';

const PROTOCOL = 1;
const INPUT_FORMAT = 'pcm-s16le/16000/mono';
const TICKET_TTL_MS = 30_000;
const START_TIMEOUT_MS = 5_000;
const IDLE_TIMEOUT_MS = 30_000;
const MAX_DURATION_MS = 4 * 60 * 60 * 1_000;
const MAX_FRAME_BYTES = 6_400;
const MAX_RELAY_AUDIO_BUFFER_BYTES = 160 * 1024;
const SESSION_JOB_PREFIX = 'asr-stream:';

interface StoredAsrTicket {
  userId: string;
  clientId: string;
  agentId: string;
  protocol: number;
  expiresAtMs: number;
}

interface SealedTicketPayload {
  u: string;
  t: string;
  e: number;
}

const sealedTicketPayloadSchema = z.object({
  u: z.string(),
  t: z.string(),
  e: z.number(),
}).passthrough() satisfies z.ZodType<SealedTicketPayload>;

export interface AsrStreamEventMessage {
  session_id: string;
  event: Record<string, unknown>;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '');
}

function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function ticketSecret(env: RelayContext['env']): Promise<string> {
  const binding = env.ASR_STREAM_TICKET_SECRET;
  const value = typeof binding === 'string' ? binding : await binding?.get();
  if (!value || value.length < 32) throw new Error('ASR stream ticket secret is not configured');
  return value;
}

async function ticketKey(env: RelayContext['env']): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(await ticketSecret(env)));
  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function sealAsrTicket(
  env: RelayContext['env'],
  payload: SealedTicketPayload
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const clear = new TextEncoder().encode(JSON.stringify(payload));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    await ticketKey(env),
    clear
  ));
  const output = new Uint8Array(iv.length + encrypted.length);
  output.set(iv, 0);
  output.set(encrypted, iv.length);
  return base64UrlEncode(output);
}

export async function openAsrTicket(
  env: RelayContext['env'],
  token: string
): Promise<SealedTicketPayload | null> {
  try {
    const bytes = base64UrlDecode(token);
    if (bytes.length <= 28) return null;
    const clear = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytes.slice(0, 12) },
      await ticketKey(env),
      bytes.slice(12)
    );
    const value = parseJson(new TextDecoder().decode(clear), sealedTicketPayloadSchema);
    if (!value.u || !value.t || !Number.isFinite(value.e) || value.e < Date.now()) return null;
    return value;
  } catch {
    return null;
  }
}

function compatibleAgent(ctx: RelayContext, agentId?: string): ConnectedAgentRecord | undefined {
  return Array.from(ctx.getConnectedAgents().values()).find(({ info }) => {
    const capability = info.capabilities.asr_streaming;
    return (!agentId || info.agent_id === agentId)
      && info.status === 'online'
      && info.current_job_id === null
      && capability?.protocols.includes(PROTOCOL)
      && capability.input_formats.includes(INPUT_FORMAT)
      && capability.max_sessions >= 1;
  });
}

export async function createAsrStreamTicket(ctx: RelayContext, request: Request): Promise<Response> {
  if (ctx.env.ASR_STREAMING_ENABLED !== 'true') {
    return Response.json({ error: 'ASR streaming is disabled' }, { status: 503 });
  }
  let clientId = 'browser';
  try {
    const body = await readRequestJson(request, asrStreamTicketRequestSchema);
    if (typeof body.client_id === 'string' && body.client_id.trim()) clientId = body.client_id.trim();
  } catch {
    // An empty JSON body is valid; client identity remains the authenticated browser default.
  }
  const agent = compatibleAgent(ctx);
  if (!agent) return Response.json({ error: 'No compatible idle ASR node' }, { status: 409 });

  const ticketId = crypto.randomUUID();
  const expiresAtMs = Date.now() + TICKET_TTL_MS;
  const ticket: StoredAsrTicket = {
    userId: ctx.getRequestUserId(request),
    clientId,
    agentId: agent.info.agent_id,
    protocol: PROTOCOL,
    expiresAtMs,
  };
  await ctx.storage.put(`asr-ticket:${ticketId}`, ticket);
  await scheduleAsrStreamAlarm(ctx);
  return Response.json({
    ticket_id: ticketId,
    protocol: PROTOCOL,
    device_label: agent.info.device_name,
    expires_at_ms: expiresAtMs,
  });
}

export async function acceptAsrBrowserWebSocket(ctx: RelayContext, request: Request): Promise<Response> {
  if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
    return new Response('Expected WebSocket', { status: 426 });
  }
  const ticketId = new URL(request.url).searchParams.get('ticket') ?? '';
  const key = `asr-ticket:${ticketId}`;
  const ticket = await ctx.storage.get<StoredAsrTicket>(key);
  if (ticket) {
    await ctx.storage.delete(key);
    await scheduleAsrStreamAlarm(ctx);
  }
  if (!ticket || ticket.expiresAtMs < Date.now() || ticket.protocol !== PROTOCOL) {
    return new Response('Invalid or expired stream ticket', { status: 401 });
  }
  if (ticket.userId !== ctx.getRequestUserId(request)) {
    return new Response('Stream ticket owner mismatch', { status: 403 });
  }
  if (!compatibleAgent(ctx, ticket.agentId)) {
    return new Response('Selected ASR node is no longer idle', { status: 409 });
  }

  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);
  const now = Date.now();
  const attachment: AsrBrowserWebSocketAttachment = {
    kind: 'asr_browser',
    sessionId: crypto.randomUUID(),
    agentId: ticket.agentId,
    clientId: ticket.clientId,
    connectedAtMs: now,
    lastAudioAtMs: now,
    forwardedAudioBytes: 0,
    started: false,
    terminal: false,
    nextFrameSequence: 0,
    nextEventSequence: 0,
  };
  server.serializeAttachment(attachment);
  ctx.acceptWebSocket(server);
  await scheduleAsrStreamAlarm(ctx);
  return new Response(null, { status: 101, webSocket: client });
}

function browserAttachment(ws: WebSocket): AsrBrowserWebSocketAttachment | null {
  const attachment = ws.deserializeAttachment() as AnyWebSocketAttachment | null;
  return isAsrBrowserWebSocketAttachment(attachment) ? attachment : null;
}

function selectedAgentSocket(ctx: RelayContext, agentId: string): WebSocket | null {
  return ctx.getConnectedAgents().get(agentId)?.ws ?? null;
}

function failBrowser(ctx: RelayContext, ws: WebSocket, attachment: AsrBrowserWebSocketAttachment, code: string, message: string): void {
  if (!attachment.terminal) {
    attachment.nextEventSequence += 1;
    ws.send(JSON.stringify({
      protocol: PROTOCOL,
      type: 'error',
      sessionId: attachment.sessionId,
      sequence: attachment.nextEventSequence,
      code,
      message,
    }));
  }
  attachment.terminal = true;
  ws.serializeAttachment(attachment);
  releaseAgent(ctx, attachment);
  ws.close(1008, code);
}

function releaseAgent(ctx: RelayContext, attachment: AsrBrowserWebSocketAttachment): void {
  const record = ctx.getConnectedAgents().get(attachment.agentId);
  if (record?.info.current_job_id === `${SESSION_JOB_PREFIX}${attachment.sessionId}`) {
    ctx.updateAgentInfo(record.ws, { status: 'online', current_job_id: null });
  }
}

function sendControl(ctx: RelayContext, attachment: AsrBrowserWebSocketAttachment, type: string): boolean {
  const agent = selectedAgentSocket(ctx, attachment.agentId);
  if (!agent) return false;
  agent.send(JSON.stringify({ type, session_id: attachment.sessionId }));
  return true;
}

export function encodeAsrAudioFrame(sessionId: string, sequence: number, payload: ArrayBuffer): ArrayBuffer {
  const output = new Uint8Array(44 + payload.byteLength);
  output.set(new TextEncoder().encode('ASR1'), 0);
  output.set(new TextEncoder().encode(sessionId), 4);
  new DataView(output.buffer).setUint32(40, sequence, false);
  output.set(new Uint8Array(payload), 44);
  return output.buffer;
}

export async function handleAsrBrowserMessage(
  ctx: RelayContext,
  ws: WebSocket,
  message: string | ArrayBuffer
): Promise<void> {
  const attachment = browserAttachment(ws);
  if (!attachment || attachment.terminal) return;
  const now = Date.now();
  if (!attachment.started && now - attachment.connectedAtMs > START_TIMEOUT_MS) {
    failBrowser(ctx, ws, attachment, 'start_timeout', 'start was not received within five seconds');
    return;
  }
  if (now - attachment.connectedAtMs > MAX_DURATION_MS) {
    if (!sendControl(ctx, attachment, 'asr_stream_stop')) {
      failBrowser(ctx, ws, attachment, 'node_disconnected', 'selected node disconnected');
      return;
    }
    attachment.stopRequestedAtMs = now;
    ws.serializeAttachment(attachment);
    await scheduleAsrStreamAlarm(ctx);
    return;
  }

  if (typeof message === 'string') {
    let control: Record<string, unknown>;
    try {
      control = parseJson(message, unknownRecordSchema);
    } catch {
      failBrowser(ctx, ws, attachment, 'invalid_control', 'control messages must be valid JSON');
      return;
    }
    if (control.type === 'start' && !attachment.started) {
      if (control.protocol !== PROTOCOL || control.sampleRate !== 16_000 || control.inputFormat !== 'pcm-s16le') {
        failBrowser(ctx, ws, attachment, 'unsupported_stream', 'protocol v1 requires pcm-s16le at 16000 Hz');
        return;
      }
      const agent = ctx.getConnectedAgents().get(attachment.agentId);
      if (!agent || agent.info.status !== 'online' || agent.info.current_job_id !== null) {
        failBrowser(ctx, ws, attachment, 'node_busy', 'selected node is no longer idle');
        return;
      }
      attachment.started = true;
      attachment.startedAtMs = now;
      attachment.lastAudioAtMs = now;
      ws.serializeAttachment(attachment);
      ctx.updateAgentInfo(agent.ws, {
        status: 'busy',
        current_job_id: `${SESSION_JOB_PREFIX}${attachment.sessionId}`,
      });
      ws.send(JSON.stringify({
        protocol: PROTOCOL,
        type: 'accepted',
        sessionId: attachment.sessionId,
        sequence: 0,
      }));
      agent.ws.send(JSON.stringify({
        type: 'asr_stream_start',
        session_id: attachment.sessionId,
        protocol: PROTOCOL,
        sample_rate: 16_000,
        input_format: 'pcm-s16le',
        language: typeof control.language === 'string' ? control.language : undefined,
      }));
      await scheduleAsrStreamAlarm(ctx);
      return;
    }
    if (!attachment.started) {
      failBrowser(ctx, ws, attachment, 'start_required', 'start must be the first message');
      return;
    }
    if (control.type === 'stop') {
      if (!sendControl(ctx, attachment, 'asr_stream_stop')) {
        failBrowser(ctx, ws, attachment, 'node_disconnected', 'selected node disconnected');
      } else {
        attachment.stopRequestedAtMs = now;
        ws.serializeAttachment(attachment);
        await scheduleAsrStreamAlarm(ctx);
      }
      return;
    }
    if (control.type === 'cancel') {
      if (!sendControl(ctx, attachment, 'asr_stream_cancel')) {
        failBrowser(ctx, ws, attachment, 'node_disconnected', 'selected node disconnected');
      }
      return;
    }
    failBrowser(ctx, ws, attachment, 'invalid_control', 'unknown or repeated control message');
    return;
  }

  if (!attachment.started) {
    failBrowser(ctx, ws, attachment, 'start_required', 'start must precede audio');
    return;
  }
  if (attachment.readyAtMs === undefined) {
    failBrowser(ctx, ws, attachment, 'model_not_ready', 'audio cannot be sent before the node emits ready');
    return;
  }
  if (message.byteLength === 0 || message.byteLength > MAX_FRAME_BYTES || !Number.isSafeInteger(message.byteLength / 2)) {
    failBrowser(ctx, ws, attachment, 'invalid_audio_frame', 'audio frames must be non-empty even-sized PCM16 and no larger than 6400 bytes');
    return;
  }
  if (now - attachment.lastAudioAtMs > IDLE_TIMEOUT_MS) {
    sendControl(ctx, attachment, 'asr_stream_cancel');
    failBrowser(ctx, ws, attachment, 'idle_timeout', 'no audio received for 30 seconds');
    return;
  }
  const agent = selectedAgentSocket(ctx, attachment.agentId);
  if (!agent) {
    failBrowser(ctx, ws, attachment, 'node_disconnected', 'selected node disconnected');
    return;
  }
  const elapsedMs = Math.max(0, now - (attachment.startedAtMs ?? now));
  const maximumForwardedBytes = Math.floor(elapsedMs * 32) + MAX_RELAY_AUDIO_BUFFER_BYTES;
  if (attachment.forwardedAudioBytes + message.byteLength > maximumForwardedBytes) {
    sendControl(ctx, attachment, 'asr_stream_cancel');
    failBrowser(ctx, ws, attachment, 'backpressure_exceeded', 'relay audio queue exceeded five seconds');
    return;
  }
  attachment.nextFrameSequence += 1;
  attachment.lastAudioAtMs = now;
  attachment.forwardedAudioBytes += message.byteLength;
  ws.serializeAttachment(attachment);
  agent.send(encodeAsrAudioFrame(attachment.sessionId, attachment.nextFrameSequence, message));
}

export function validateCliAsrEvent(event: Record<string, unknown>): boolean {
  if (event.protocol !== PROTOCOL || typeof event.type !== 'string') return false;
  switch (event.type) {
    case 'ready':
      return event.sampleRate === 16_000 && event.inputFormat === 'pcm-s16le';
    case 'partial':
    case 'commit':
      return typeof event.utteranceId === 'string'
        && Number.isSafeInteger(event.revision)
        && typeof event.text === 'string'
        && Number.isSafeInteger(event.startMs)
        && Number.isSafeInteger(event.endMs);
    case 'stats':
      return typeof event.decodeLatencyMs === 'number'
        && Number.isSafeInteger(event.audioMs)
        && Number.isSafeInteger(event.queuedAudioMs);
    case 'final':
      return typeof event.reason === 'string';
    case 'error':
      return typeof event.code === 'string' && typeof event.message === 'string';
    default:
      return false;
  }
}

function cliAsrEventFields(event: Record<string, unknown>): Record<string, unknown> {
  switch (event.type) {
    case 'ready':
      return { sampleRate: event.sampleRate, inputFormat: event.inputFormat };
    case 'partial':
    case 'commit':
      return {
        utteranceId: event.utteranceId,
        revision: event.revision,
        text: event.text,
        startMs: event.startMs,
        endMs: event.endMs,
      };
    case 'stats':
      return {
        decodeLatencyMs: event.decodeLatencyMs,
        audioMs: event.audioMs,
        queuedAudioMs: event.queuedAudioMs,
      };
    case 'final':
      return { reason: event.reason };
    case 'error':
      return { code: event.code, message: event.message };
    default:
      return {};
  }
}

export async function handleNodeAsrStreamEvent(ctx: RelayContext, message: AsrStreamEventMessage): Promise<void> {
  if (!validateCliAsrEvent(message.event)) return;
  for (const ws of ctx.getWebSockets()) {
    const attachment = ws.deserializeAttachment() as AnyWebSocketAttachment | null;
    if (!isAsrBrowserWebSocketAttachment(attachment) || attachment.sessionId !== message.session_id) continue;
    if (attachment.terminal) return;
    attachment.nextEventSequence += 1;
    const type = message.event.type;
    const eventFields = cliAsrEventFields(message.event);
    if (type === 'ready') {
      attachment.readyAtMs = Date.now();
      attachment.lastAudioAtMs = attachment.readyAtMs;
    }
    ws.send(JSON.stringify({
      protocol: PROTOCOL,
      type,
      sessionId: attachment.sessionId,
      sequence: attachment.nextEventSequence,
      ...eventFields,
    }));
    if (type === 'final' || type === 'error') {
      attachment.terminal = true;
      releaseAgent(ctx, attachment);
      ws.serializeAttachment(attachment);
      ws.close(1000, String(type));
      await scheduleAsrStreamAlarm(ctx);
    } else {
      ws.serializeAttachment(attachment);
      if (type === 'ready') await scheduleAsrStreamAlarm(ctx);
    }
    return;
  }
}

export async function handleAsrBrowserClose(ctx: RelayContext, ws: WebSocket): Promise<void> {
  const attachment = browserAttachment(ws);
  if (!attachment || attachment.terminal) return;
  sendControl(ctx, attachment, 'asr_stream_cancel');
  attachment.terminal = true;
  releaseAgent(ctx, attachment);
  ws.serializeAttachment(attachment);
  await scheduleAsrStreamAlarm(ctx);
}

function sessionDeadline(attachment: AsrBrowserWebSocketAttachment): number {
  if (!attachment.started) return attachment.connectedAtMs + START_TIMEOUT_MS;
  if (attachment.stopRequestedAtMs !== undefined) return attachment.stopRequestedAtMs + 15_000;
  if (attachment.readyAtMs === undefined) return attachment.connectedAtMs + MAX_DURATION_MS;
  return Math.min(
    attachment.lastAudioAtMs + IDLE_TIMEOUT_MS,
    attachment.connectedAtMs + MAX_DURATION_MS,
  );
}

export async function scheduleAsrStreamAlarm(ctx: RelayContext): Promise<void> {
  let next: number | null = null;
  const now = Date.now();
  const tickets = await ctx.storage.list<StoredAsrTicket>({ prefix: 'asr-ticket:' });
  for (const [key, ticket] of tickets) {
    if (ticket.expiresAtMs <= now) {
      await ctx.storage.delete(key);
      continue;
    }
    if (next === null || ticket.expiresAtMs < next) next = ticket.expiresAtMs;
  }
  for (const ws of ctx.getWebSockets()) {
    const attachment = browserAttachment(ws);
    if (!attachment || attachment.terminal) continue;
    const deadline = sessionDeadline(attachment);
    if (next === null || deadline < next) next = deadline;
  }
  if (next === null) await ctx.storage.delete(ASR_STREAM_ALARM_KEY);
  else await ctx.storage.put(ASR_STREAM_ALARM_KEY, next);
  await scheduleNextRelayAlarm(ctx);
}

export async function expireAsrStreamSessions(ctx: RelayContext, now = Date.now()): Promise<void> {
  for (const ws of ctx.getWebSockets()) {
    const attachment = browserAttachment(ws);
    if (!attachment || attachment.terminal || sessionDeadline(attachment) > now) continue;
    if (!attachment.started) {
      failBrowser(ctx, ws, attachment, 'start_timeout', 'start was not received within five seconds');
      continue;
    }
    if (attachment.stopRequestedAtMs !== undefined) {
      sendControl(ctx, attachment, 'asr_stream_cancel');
      failBrowser(ctx, ws, attachment, 'stop_timeout', 'the node did not finish transcription within 15 seconds');
      continue;
    }
    if (now - attachment.connectedAtMs >= MAX_DURATION_MS) {
      if (!sendControl(ctx, attachment, 'asr_stream_stop')) {
        failBrowser(ctx, ws, attachment, 'node_disconnected', 'selected node disconnected');
        continue;
      }
      attachment.stopRequestedAtMs = now;
      ws.serializeAttachment(attachment);
      continue;
    }
    sendControl(ctx, attachment, 'asr_stream_cancel');
    failBrowser(ctx, ws, attachment, 'idle_timeout', 'no audio received for 30 seconds');
  }
  await scheduleAsrStreamAlarm(ctx);
}

export function closeAsrSessionsForAgent(ctx: RelayContext, agentId: string): void {
  for (const ws of ctx.getWebSockets()) {
    const attachment = ws.deserializeAttachment() as AnyWebSocketAttachment | null;
    if (!isAsrBrowserWebSocketAttachment(attachment) || attachment.agentId !== agentId || attachment.terminal) continue;
    failBrowser(ctx, ws, attachment, 'node_disconnected', 'selected node disconnected');
  }
}

export function hasAsrSessionForAgent(ctx: RelayContext, agentId: string): boolean {
  return ctx.getWebSockets().some((ws) => {
    const attachment = ws.deserializeAttachment() as AnyWebSocketAttachment | null;
    return isAsrBrowserWebSocketAttachment(attachment) && attachment.agentId === agentId && !attachment.terminal;
  });
}
