import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentCapabilities } from '../src/types';
import {
  encodeAsrAudioFrame,
  openAsrTicket,
  sealAsrTicket,
  validateCliAsrEvent,
} from '../src/relay-asr-stream';
import {
  capabilitiesWithModels,
  closeWebSocket,
  connectAgent,
  readJson,
  waitForWebSocketJson,
} from './helpers';

const openSockets: WebSocket[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const socket of openSockets.splice(0)) closeWebSocket(socket);
});

function streamingCapabilities(
  backends: Array<'auto' | 'parakeet' | 'qwen'> = ['parakeet', 'qwen']
): AgentCapabilities {
  return {
    ...capabilitiesWithModels(['asr']),
    asr_streaming: {
      protocols: [1],
      input_formats: ['pcm-s16le/16000/mono'],
      max_sessions: 1,
      backends,
    },
  };
}

async function mintTicket(
  relay: DurableObjectStub,
  userId: string,
  backend?: 'auto' | 'parakeet' | 'qwen'
): Promise<Response> {
  return relay.fetch(new Request('https://relay/internal/asr/stream-ticket', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-User-Id': userId },
    body: JSON.stringify({
      client_id: 'agentsmarkdown:test',
      ...(backend ? { backend } : {}),
    }),
  }));
}

async function openStream(
  relay: DurableObjectStub,
  userId: string,
  ticketId: string,
): Promise<{ response: Response; socket: WebSocket | null }> {
  const response = await relay.fetch(new Request(
    `https://relay/internal/asr/stream?ticket=${encodeURIComponent(ticketId)}`,
    { headers: { Upgrade: 'websocket', 'X-User-Id': userId } },
  ));
  const socket = response.webSocket ?? null;
  if (socket) {
    socket.accept();
    openSockets.push(socket);
  }
  return { response, socket };
}

describe('ASR stream protocol v1', () => {
  it('seals owner routing data in an opaque expiring ticket', async () => {
    const payload = { u: 'user-private', t: crypto.randomUUID(), e: Date.now() + 30_000 };
    const ticket = await sealAsrTicket(env, payload);
    expect(ticket).not.toContain(payload.u);
    expect(await openAsrTicket(env, ticket)).toEqual(payload);
    expect(await openAsrTicket(env, `${ticket}x`)).toBeNull();
  });

  it('encodes the fixed ASR1 binary header in network byte order', () => {
    const sessionId = '123e4567-e89b-12d3-a456-426614174000';
    const frame = new Uint8Array(encodeAsrAudioFrame(
      sessionId,
      0x01020304,
      new Uint8Array([0x34, 0x12]).buffer
    ));
    expect(new TextDecoder().decode(frame.slice(0, 4))).toBe('ASR1');
    expect(new TextDecoder().decode(frame.slice(4, 40))).toBe(sessionId);
    expect(Array.from(frame.slice(40, 44))).toEqual([1, 2, 3, 4]);
    expect(Array.from(frame.slice(44))).toEqual([0x34, 0x12]);
  });

  it('accepts only declared protocol-v1 CLI event shapes', () => {
    expect(validateCliAsrEvent({
      protocol: 1,
      type: 'partial',
      utteranceId: crypto.randomUUID(),
      revision: 2,
      text: 'hello',
      startMs: 0,
      endMs: 2_100,
    })).toBe(true);
    expect(validateCliAsrEvent({ protocol: 2, type: 'final', reason: 'eof' })).toBe(false);
    expect(validateCliAsrEvent({ protocol: 1, type: 'commit', text: 'missing fields' })).toBe(false);
    expect(validateCliAsrEvent({ protocol: 1, type: 'unknown' })).toBe(false);
  });

  it('rejects old nodes and consumes each ticket exactly once', async () => {
    const oldUser = `asr-old-${crypto.randomUUID()}`;
    const old = await connectAgent(oldUser, capabilitiesWithModels(['asr']));
    openSockets.push(old.ws);
    expect((await mintTicket(old.relay, oldUser)).status).toBe(409);

    const userId = `asr-ticket-${crypto.randomUUID()}`;
    const agent = await connectAgent(userId, streamingCapabilities());
    openSockets.push(agent.ws);
    const issued = await mintTicket(agent.relay, userId);
    expect(issued.status).toBe(200);
    const ticket = await readJson<{ ticket_id: string }>(issued);
    const opened = await openStream(agent.relay, userId, ticket.ticket_id);
    expect(opened.response.status).toBe(101);
    expect((await openStream(agent.relay, userId, ticket.ticket_id)).response.status).toBe(401);
  });

  it('rejects invalid backends and selects a node advertising the requested backend', async () => {
    const userId = `asr-backend-${crypto.randomUUID()}`;
    const qwen = await connectAgent(userId, streamingCapabilities(['qwen']), {
      deviceName: 'Qwen Node',
    });
    const parakeet = await connectAgent(userId, streamingCapabilities(['parakeet']), {
      deviceName: 'Parakeet Node',
    });
    openSockets.push(qwen.ws, parakeet.ws);

    const invalid = await parakeet.relay.fetch(new Request(
      'https://relay/internal/asr/stream-ticket',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-User-Id': userId },
        body: JSON.stringify({ backend: 'other' }),
      }
    ));
    expect(invalid.status).toBe(400);

    const issued = await mintTicket(parakeet.relay, userId, 'parakeet');
    expect(issued.status).toBe(200);
    expect(await readJson<{ device_label: string }>(issued)).toMatchObject({
      device_label: 'Parakeet Node',
    });
  });

  it('reports and routes legacy Parakeet nodes when auto selection is guaranteed', async () => {
    const userId = `asr-legacy-backend-${crypto.randomUUID()}`;
    const agent = await connectAgent(userId, streamingCapabilities([]), {
      deviceName: 'Legacy Parakeet Node',
      runtime: {
        mere_run_version: 'mere.run 0.26.0',
        installed_models: ['speech-asr-parakeet'],
        inventory_status: 'reported',
      },
    });
    openSockets.push(agent.ws);

    const statusResponse = await agent.relay.fetch(new Request('https://relay/internal/status'));
    const status = await readJson<{
      agents: Array<{
        capabilities: { asr_streaming?: { backends?: string[] } };
      }>;
    }>(statusResponse);
    expect(status.agents[0].capabilities.asr_streaming?.backends).toEqual(['parakeet']);
    expect((await mintTicket(agent.relay, userId, 'parakeet')).status).toBe(200);
  });

  it('expires unused tickets, rejects the wrong owner, and refuses a second live session', async () => {
    const userId = `asr-policy-${crypto.randomUUID()}`;
    const agent = await connectAgent(userId, streamingCapabilities());
    openSockets.push(agent.ws);

    const expiring = await readJson<{ ticket_id: string }>(await mintTicket(agent.relay, userId));
    await runInDurableObject(agent.relay, async (_instance, state) => {
      const key = `asr-ticket:${expiring.ticket_id}`;
      const ticket = await state.storage.get<Record<string, unknown>>(key);
      await state.storage.put(key, { ...ticket, expiresAtMs: Date.now() - 1 });
      await state.storage.put('asr-stream:next-alarm', Date.now() - 1);
    });
    await runDurableObjectAlarm(agent.relay);
    expect((await openStream(agent.relay, userId, expiring.ticket_id)).response.status).toBe(401);

    const wrongOwner = await readJson<{ ticket_id: string }>(await mintTicket(agent.relay, userId));
    expect((await openStream(agent.relay, `${userId}-other`, wrongOwner.ticket_id)).response.status).toBe(403);

    const activeTicket = await readJson<{ ticket_id: string }>(await mintTicket(agent.relay, userId));
    const active = await openStream(agent.relay, userId, activeTicket.ticket_id);
    expect(active.socket).not.toBeNull();
    active.socket!.send(JSON.stringify({
      type: 'start', protocol: 1, sampleRate: 16_000, inputFormat: 'pcm-s16le', language: 'en',
    }));
    await waitForWebSocketJson(active.socket!);
    await waitForWebSocketJson(agent.ws);
    expect((await mintTicket(agent.relay, userId)).status).toBe(409);
  });

  it('terminates odd or oversized browser PCM frames', async () => {
    const userId = `asr-frame-${crypto.randomUUID()}`;
    const agent = await connectAgent(userId, streamingCapabilities());
    openSockets.push(agent.ws);
    const ticket = await readJson<{ ticket_id: string }>(await mintTicket(agent.relay, userId));
    const opened = await openStream(agent.relay, userId, ticket.ticket_id);
    opened.socket!.send(JSON.stringify({
      type: 'start', protocol: 1, sampleRate: 16_000, inputFormat: 'pcm-s16le', language: 'en',
    }));
    await waitForWebSocketJson(opened.socket!);
    const start = await waitForWebSocketJson<{ session_id: string }>(agent.ws);
    agent.ws.send(JSON.stringify({
      type: 'asr_stream_event',
      session_id: start.session_id,
      event: { protocol: 1, type: 'ready', sampleRate: 16_000, inputFormat: 'pcm-s16le' },
    }));
    await waitForWebSocketJson(opened.socket!);
    const terminal = waitForWebSocketJson<Record<string, unknown>>(opened.socket!);
    opened.socket!.send(new Uint8Array(3).buffer);
    expect(await terminal).toMatchObject({ type: 'error', code: 'invalid_audio_frame' });
  });

  it('routes ready, PCM frames, commits, and final events through the selected node', async () => {
    const userId = `asr-route-${crypto.randomUUID()}`;
    const agent = await connectAgent(userId, streamingCapabilities());
    openSockets.push(agent.ws);
    const ticket = await readJson<{ ticket_id: string }>(
      await mintTicket(agent.relay, userId, 'parakeet')
    );
    const opened = await openStream(agent.relay, userId, ticket.ticket_id);
    const browser = opened.socket;
    expect(browser).not.toBeNull();
    if (!browser) return;

    browser.send(JSON.stringify({
      type: 'start', protocol: 1, sampleRate: 16_000, inputFormat: 'pcm-s16le', language: 'en',
    }));
    expect(await waitForWebSocketJson(browser)).toMatchObject({ type: 'accepted', sequence: 0 });
    const start = await waitForWebSocketJson<{
      type: string;
      session_id: string;
      backend: string;
    }>(agent.ws);
    expect(start.type).toBe('asr_stream_start');
    expect(start.backend).toBe('parakeet');

    agent.ws.send(JSON.stringify({
      type: 'asr_stream_event',
      session_id: start.session_id,
      event: { protocol: 1, type: 'ready', sampleRate: 16_000, inputFormat: 'pcm-s16le' },
    }));
    expect(await waitForWebSocketJson(browser)).toMatchObject({
      type: 'ready', sessionId: start.session_id, sequence: 1,
    });

    const audioPromise = new Promise<ArrayBuffer>((resolve) => {
      agent.ws.addEventListener('message', (event: MessageEvent) => {
        if (event.data instanceof ArrayBuffer) resolve(event.data);
      }, { once: true });
    });
    browser.send(new Uint8Array(3_200).buffer);
    const audio = new Uint8Array(await audioPromise);
    expect(new TextDecoder().decode(audio.slice(0, 4))).toBe('ASR1');
    expect(new TextDecoder().decode(audio.slice(4, 40))).toBe(start.session_id);
    expect(new DataView(audio.buffer).getUint32(40, false)).toBe(1);
    expect(audio.byteLength).toBe(3_244);

    const utteranceId = crypto.randomUUID();
    agent.ws.send(JSON.stringify({
      type: 'asr_stream_event', session_id: start.session_id,
      event: { protocol: 1, type: 'commit', utteranceId, revision: 2, text: 'hello', startMs: 0, endMs: 2_100 },
    }));
    expect(await waitForWebSocketJson(browser)).toMatchObject({
      type: 'commit', sequence: 2, utteranceId, text: 'hello',
    });
    agent.ws.send(JSON.stringify({
      type: 'asr_stream_event', session_id: start.session_id,
      event: { protocol: 1, type: 'final', reason: 'eof' },
    }));
    expect(await waitForWebSocketJson(browser)).toMatchObject({ type: 'final', sequence: 3, reason: 'eof' });
  });

  it('enforces start timeout from the Durable Object alarm without another browser message', async () => {
    const userId = `asr-timeout-${crypto.randomUUID()}`;
    const agent = await connectAgent(userId, streamingCapabilities());
    openSockets.push(agent.ws);
    const ticket = await readJson<{ ticket_id: string }>(await mintTicket(agent.relay, userId));
    const opened = await openStream(agent.relay, userId, ticket.ticket_id);
    expect(opened.socket).not.toBeNull();
    await runInDurableObject(agent.relay, async (_instance, state) => {
      const server = state.getWebSockets().find((socket) =>
        (socket.deserializeAttachment() as { kind?: string } | null)?.kind === 'asr_browser'
      );
      expect(server).toBeDefined();
      const attachment = server!.deserializeAttachment() as { connectedAtMs: number };
      server!.serializeAttachment({ ...attachment, connectedAtMs: Date.now() - 5_001 });
      await state.storage.put('asr-stream:next-alarm', Date.now() - 1);
    });
    const terminal = waitForWebSocketJson(opened.socket!);
    expect(await runDurableObjectAlarm(agent.relay)).toBe(true);
    expect(await terminal).toMatchObject({
      type: 'error', code: 'start_timeout', sequence: 1,
    });
  });

  it('starts the idle timeout only after the node reports ready', async () => {
    const userId = `asr-idle-${crypto.randomUUID()}`;
    const agent = await connectAgent(userId, streamingCapabilities());
    openSockets.push(agent.ws);
    const ticket = await readJson<{ ticket_id: string }>(await mintTicket(agent.relay, userId));
    const opened = await openStream(agent.relay, userId, ticket.ticket_id);
    opened.socket!.send(JSON.stringify({
      type: 'start', protocol: 1, sampleRate: 16_000, inputFormat: 'pcm-s16le', language: 'en',
    }));
    await waitForWebSocketJson(opened.socket!);
    const start = await waitForWebSocketJson<{ session_id: string }>(agent.ws);

    await runInDurableObject(agent.relay, async (_instance, state) => {
      const server = state.getWebSockets().find((socket) =>
        (socket.deserializeAttachment() as { kind?: string } | null)?.kind === 'asr_browser'
      );
      const attachment = server!.deserializeAttachment() as Record<string, unknown>;
      server!.serializeAttachment({
        ...attachment,
        connectedAtMs: Date.now() - 60_000,
        lastAudioAtMs: Date.now() - 60_000,
      });
      await state.storage.put('asr-stream:next-alarm', Date.now() - 1);
    });
    expect(await runDurableObjectAlarm(agent.relay)).toBe(true);
    await runInDurableObject(agent.relay, (_instance, state) => {
      const attachment = state.getWebSockets()
        .map((socket) => socket.deserializeAttachment() as { kind?: string; terminal?: boolean })
        .find((value) => value?.kind === 'asr_browser');
      expect(attachment?.terminal).toBe(false);
    });

    agent.ws.send(JSON.stringify({
      type: 'asr_stream_event',
      session_id: start.session_id,
      event: { protocol: 1, type: 'ready', sampleRate: 16_000, inputFormat: 'pcm-s16le' },
    }));
    await waitForWebSocketJson(opened.socket!);
    await runInDurableObject(agent.relay, async (_instance, state) => {
      const server = state.getWebSockets().find((socket) =>
        (socket.deserializeAttachment() as { kind?: string } | null)?.kind === 'asr_browser'
      );
      const attachment = server!.deserializeAttachment() as Record<string, unknown>;
      server!.serializeAttachment({ ...attachment, lastAudioAtMs: Date.now() - 30_001 });
      await state.storage.put('asr-stream:next-alarm', Date.now() - 1);
    });
    const terminal = waitForWebSocketJson(opened.socket!);
    expect(await runDurableObjectAlarm(agent.relay)).toBe(true);
    expect(await terminal).toMatchObject({ type: 'error', code: 'idle_timeout' });
  });

  it('requests a graceful stop at the four-hour absolute limit', async () => {
    const userId = `asr-maximum-${crypto.randomUUID()}`;
    const agent = await connectAgent(userId, streamingCapabilities());
    openSockets.push(agent.ws);
    const ticket = await readJson<{ ticket_id: string }>(await mintTicket(agent.relay, userId));
    const opened = await openStream(agent.relay, userId, ticket.ticket_id);
    opened.socket!.send(JSON.stringify({
      type: 'start', protocol: 1, sampleRate: 16_000, inputFormat: 'pcm-s16le', language: 'en',
    }));
    await waitForWebSocketJson(opened.socket!);
    await waitForWebSocketJson(agent.ws);
    await runInDurableObject(agent.relay, async (_instance, state) => {
      const server = state.getWebSockets().find((socket) =>
        (socket.deserializeAttachment() as { kind?: string } | null)?.kind === 'asr_browser'
      );
      const attachment = server!.deserializeAttachment() as Record<string, unknown>;
      server!.serializeAttachment({ ...attachment, connectedAtMs: Date.now() - (4 * 60 * 60 * 1_000) });
      await state.storage.put('asr-stream:next-alarm', Date.now() - 1);
    });
    const stop = waitForWebSocketJson<Record<string, unknown>>(agent.ws);
    expect(await runDurableObjectAlarm(agent.relay)).toBe(true);
    expect(await stop).toMatchObject({ type: 'asr_stream_stop' });
  });
});
