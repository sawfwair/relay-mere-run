import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import type { Chat, ChatStatusResponse } from '../src/types';
import {
  capabilitiesWithModels, closeWebSocket, connectAgent, readJson, submitChat,
  waitForWebSocketJson,
} from './helpers';

const modelId = 'text-chat-fixture';
const manifestSha256 = 'a'.repeat(64);
const pinnedCapabilities = {
  ...capabilitiesWithModels([modelId]),
  text_adapters: [{ manifest_sha256: manifestSha256, base_model_id: modelId }],
};

function terminalMessage(type: 'chat_response' | 'chat_error', chatId: string, marker: string) {
  return type === 'chat_response'
    ? { type, chat_id: chatId, response: marker, tokens_generated: 7 }
    : { type, chat_id: chatId, error: marker };
}

async function messageBarrier(ws: WebSocket): Promise<void> {
  const timestamp = Date.now();
  ws.send(JSON.stringify({ type: 'ping', timestamp_ms: timestamp }));
  expect(await waitForWebSocketJson(ws)).toMatchObject({ type: 'pong', timestamp_ms: timestamp });
}

async function statusFor(relay: DurableObjectStub, chatId: string): Promise<ChatStatusResponse> {
  return readJson<ChatStatusResponse>(await relay.fetch(new Request(
    `https://relay/internal/chat/${chatId}`
  )));
}

async function storedChat(relay: DurableObjectStub, chatId: string): Promise<Chat | undefined> {
  return runInDurableObject(relay, async (_instance, state) => state.storage.get<Chat>(`chat:${chatId}`));
}

async function pinnedChat(relay: DurableObjectStub, userId: string, deviceId: string): Promise<string> {
  const response = await submitChat(relay, userId, {
    messages: [{ role: 'user', content: 'private assignment-bound prompt' }],
    model: modelId,
    adapter: { manifest_sha256: manifestSha256, base_model_id: modelId, scale: 0.75 },
    execution_spec_sha256: 'b'.repeat(64),
    required_device_id: deviceId,
  });
  expect(response.status).toBe(200);
  return (await readJson<{ chat_id: string }>(response)).chat_id;
}

describe('assignment-bound immutable chat receipts', () => {
  it.each(['chat_response', 'chat_error'] as const)('rejects %s from another node in the same account', async (type) => {
    const userId = `chat-wrong-node-${crypto.randomUUID()}`;
    const owner = await connectAgent(userId, pinnedCapabilities, { deviceId: 'pinned-adapter-owner' });
    const other = await connectAgent(userId, capabilitiesWithModels([modelId]), { deviceId: 'unassigned-node' });
    try {
      const chatId = await pinnedChat(owner.relay, userId, 'pinned-adapter-owner');
      expect(await waitForWebSocketJson(owner.ws)).toMatchObject({ type: 'chat_request', chat_id: chatId });
      other.ws.send(JSON.stringify({
        ...terminalMessage(type, chatId, 'not from the assigned adapter node'), agent_id: owner.agentId,
      }));
      await messageBarrier(other.ws);

      expect(await statusFor(owner.relay, chatId)).toMatchObject({
        status: 'processing', response: null, error: null, execution_receipt: null,
        agent_id: owner.agentId,
      });
      expect(await storedChat(owner.relay, chatId)).toMatchObject({ status: 'processing', messages: [], response: null });

      owner.ws.send(JSON.stringify(terminalMessage('chat_response', chatId, 'verified assigned response')));
      await vi.waitFor(async () => {
        expect(await statusFor(owner.relay, chatId)).toMatchObject({
          status: 'complete', response: 'verified assigned response',
          execution_receipt: {
            state: 'complete', device_id: 'pinned-adapter-owner',
            adapter_manifest_sha256: manifestSha256,
          },
        });
      });
      const persisted = await storedChat(owner.relay, chatId);
      expect(persisted?.messages).toEqual([]);
      expect(persisted?.response).toBeNull();
      expect(JSON.stringify(persisted)).not.toContain('private assignment-bound prompt');
      expect(JSON.stringify(persisted)).not.toContain('not from the assigned adapter node');
    } finally {
      closeWebSocket(other.ws);
      closeWebSocket(owner.ws);
    }
  });

  it.each(['chat_response', 'chat_error'] as const)('does not let a node complete queued, unassigned work with %s', async (type) => {
    const userId = `chat-queued-result-${crypto.randomUUID()}`;
    const owner = await connectAgent(userId, pinnedCapabilities, { deviceId: 'busy-adapter-owner' });
    try {
      await pinnedChat(owner.relay, userId, 'busy-adapter-owner');
      await waitForWebSocketJson(owner.ws);
      const queuedId = await pinnedChat(owner.relay, userId, 'busy-adapter-owner');
      expect((await statusFor(owner.relay, queuedId)).status).toBe('queued');
      owner.ws.send(JSON.stringify(terminalMessage(type, queuedId, 'not assigned yet')));
      await messageBarrier(owner.ws);
      expect(await statusFor(owner.relay, queuedId)).toMatchObject({
        status: 'queued', agent_id: null, response: null, error: null, execution_receipt: null,
      });
      expect((await storedChat(owner.relay, queuedId))?.status).toBe('queued');
    } finally {
      closeWebSocket(owner.ws);
    }
  });

  it.each(['complete', 'failed', 'cancelled'] as const)('preserves a %s receipt against duplicate and contradictory terminal messages', async (state) => {
    const userId = `chat-terminal-immutable-${crypto.randomUUID()}`;
    const owner = await connectAgent(userId, pinnedCapabilities, { deviceId: 'terminal-owner' });
    try {
      const chatId = await pinnedChat(owner.relay, userId, 'terminal-owner');
      await waitForWebSocketJson(owner.ws);
      if (state === 'cancelled') {
        await owner.relay.fetch(new Request(`https://relay/internal/chat/${chatId}`, { method: 'POST' }));
        expect(await waitForWebSocketJson(owner.ws)).toMatchObject({ type: 'chat_cancel', chat_id: chatId });
      } else {
        owner.ws.send(JSON.stringify(terminalMessage(state === 'complete' ? 'chat_response' : 'chat_error', chatId, 'original terminal result')));
      }
      await vi.waitFor(async () => expect((await statusFor(owner.relay, chatId)).execution_receipt?.state).toBe(state));
      await vi.waitFor(async () => expect((await storedChat(owner.relay, chatId))?.status).toBe(state));
      const original = await statusFor(owner.relay, chatId);
      const originalStored = await storedChat(owner.relay, chatId);
      owner.ws.send(JSON.stringify(terminalMessage('chat_response', chatId, 'late replacement output')));
      owner.ws.send(JSON.stringify(terminalMessage('chat_error', chatId, 'late contradictory error')));
      await messageBarrier(owner.ws);
      expect(await statusFor(owner.relay, chatId)).toEqual(original);
      expect(await storedChat(owner.relay, chatId)).toEqual(originalStored);
    } finally {
      closeWebSocket(owner.ws);
    }
  });

  it.each(['complete', 'failed'] as const)('does not resurrect a durable %s chat after its memory copy is gone', async (state) => {
    const userId = `chat-durable-terminal-${crypto.randomUUID()}`;
    const owner = await connectAgent(userId, pinnedCapabilities, { deviceId: 'durable-owner' });
    try {
      const chatId = await pinnedChat(owner.relay, userId, 'durable-owner');
      await waitForWebSocketJson(owner.ws);
      owner.ws.send(JSON.stringify(terminalMessage(state === 'complete' ? 'chat_response' : 'chat_error', chatId, 'original private output')));
      await vi.waitFor(async () => expect((await statusFor(owner.relay, chatId)).execution_receipt?.state).toBe(state));
      await vi.waitFor(async () => expect((await storedChat(owner.relay, chatId))?.status).toBe(state));
      const original = await storedChat(owner.relay, chatId);
      await runInDurableObject(owner.relay, (instance) => {
        (instance as unknown as { chats: Map<string, Chat> }).chats.delete(chatId);
      });
      owner.ws.send(JSON.stringify(terminalMessage('chat_response', chatId, 'resurrected output')));
      await messageBarrier(owner.ws);
      expect(await storedChat(owner.relay, chatId)).toEqual(original);
      expect(await statusFor(owner.relay, chatId)).toMatchObject({ status: state, response: null });
    } finally {
      closeWebSocket(owner.ws);
    }
  });

  it.each(['chat_response', 'chat_error'] as const)('keeps the first terminal transition when %s races a contradictory message', async (first) => {
    const userId = `chat-terminal-race-${crypto.randomUUID()}`;
    const owner = await connectAgent(userId, pinnedCapabilities, { deviceId: 'racing-owner' });
    try {
      const chatId = await pinnedChat(owner.relay, userId, 'racing-owner');
      await waitForWebSocketJson(owner.ws);
      owner.ws.send(JSON.stringify(terminalMessage(first, chatId, 'first terminal result')));
      owner.ws.send(JSON.stringify(terminalMessage(first === 'chat_response' ? 'chat_error' : 'chat_response', chatId, 'contradictory result')));
      await messageBarrier(owner.ws);
      const state = first === 'chat_response' ? 'complete' : 'failed';
      await vi.waitFor(async () => expect((await storedChat(owner.relay, chatId))?.execution_receipt?.state).toBe(state));
      expect(await statusFor(owner.relay, chatId)).toMatchObject({
        status: state, response: first === 'chat_response' ? 'first terminal result' : null,
      });
    } finally {
      closeWebSocket(owner.ws);
    }
  });

  it('keeps chat replies confined to the authenticated account', async () => {
    const userId = `chat-owner-account-${crypto.randomUUID()}`;
    const owner = await connectAgent(userId, pinnedCapabilities, { deviceId: 'account-owner' });
    const outsider = await connectAgent(`chat-other-account-${crypto.randomUUID()}`, pinnedCapabilities, { deviceId: 'account-owner' });
    try {
      const chatId = await pinnedChat(owner.relay, userId, 'account-owner');
      await waitForWebSocketJson(owner.ws);
      outsider.ws.send(JSON.stringify(terminalMessage('chat_response', chatId, 'cross-account output')));
      await messageBarrier(outsider.ws);
      expect(await statusFor(owner.relay, chatId)).toMatchObject({ status: 'processing', execution_receipt: null });
      expect((await storedChat(outsider.relay, chatId))).toBeUndefined();
    } finally {
      closeWebSocket(outsider.ws);
      closeWebSocket(owner.ws);
    }
  });
});
