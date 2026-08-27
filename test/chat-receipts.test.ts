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
  it('retains assigned device and runtime provenance after the node disconnects', async () => {
    const userId = `chat-disconnected-provenance-${crypto.randomUUID()}`;
    const owner = await connectAgent(userId, pinnedCapabilities, {
      deviceId: 'disconnected-owner',
      runtime: { mere_run_version: '0.45.0', installed_models: [modelId] },
    });
    try {
      const chatId = await pinnedChat(owner.relay, userId, 'disconnected-owner');
      await waitForWebSocketJson(owner.ws);
      closeWebSocket(owner.ws);
      await vi.waitFor(async () => expect((await storedChat(owner.relay, chatId))?.status).toBe('failed'));
      const persisted = await storedChat(owner.relay, chatId);
      expect(persisted?.execution_receipt).toMatchObject({
        state: 'failed', device_id: 'disconnected-owner', provider_version: '0.45.0',
        model_id: modelId, adapter_manifest_sha256: manifestSha256,
        execution_spec_sha256: 'b'.repeat(64),
      });
      expect(persisted?.execution_receipt?.started_at).not.toBeNull();
      expect(persisted?.messages).toEqual([]);
      expect(persisted?.response).toBeNull();
      expect(JSON.stringify(persisted)).not.toContain('private assignment-bound prompt');
    } finally {
      closeWebSocket(owner.ws);
    }
  });

  it('uses the runtime selected at assignment instead of a later inventory update', async () => {
    const userId = `chat-updated-runtime-${crypto.randomUUID()}`;
    const owner = await connectAgent(userId, pinnedCapabilities, {
      deviceId: 'updated-runtime-owner',
      runtime: { mere_run_version: '0.45.0', installed_models: [modelId] },
    });
    try {
      const chatId = await pinnedChat(owner.relay, userId, 'updated-runtime-owner');
      await waitForWebSocketJson(owner.ws);
      owner.ws.send(JSON.stringify({
        type: 'inventory_update', capabilities: pinnedCapabilities,
        system: { platform: 'macos', architecture: 'aarch64', accelerators: [] },
        runtime: { mere_run_version: '0.46.0', installed_models: [modelId] },
        capacity: { max_concurrent_jobs: 1 },
      }));
      await messageBarrier(owner.ws);
      owner.ws.send(JSON.stringify(terminalMessage('chat_response', chatId, 'assigned runtime output')));
      await vi.waitFor(async () => expect((await storedChat(owner.relay, chatId))?.status).toBe('complete'));
      expect((await storedChat(owner.relay, chatId))?.execution_receipt).toMatchObject({
        state: 'complete', device_id: 'updated-runtime-owner', provider_version: '0.45.0',
      });
    } finally {
      closeWebSocket(owner.ws);
    }
  });

  it('keeps pre-upgrade durable assignments readable using available live provenance', async () => {
    const userId = `chat-legacy-assignment-${crypto.randomUUID()}`;
    const owner = await connectAgent(userId, pinnedCapabilities, { deviceId: 'legacy-owner' });
    try {
      const chatId = await pinnedChat(owner.relay, userId, 'legacy-owner');
      await waitForWebSocketJson(owner.ws);
      await runInDurableObject(owner.relay, async (instance, state) => {
        const legacy = await state.storage.get<Chat>(`chat:${chatId}`);
        if (!legacy) throw new Error('Expected persisted assignment');
        delete legacy.assigned_node;
        await state.storage.put(`chat:${chatId}`, legacy);
        (instance as unknown as { chats: Map<string, Chat> }).chats.delete(chatId);
      });
      owner.ws.send(JSON.stringify(terminalMessage('chat_response', chatId, 'legacy assigned response')));
      await vi.waitFor(async () => expect((await storedChat(owner.relay, chatId))?.status).toBe('complete'));
      expect((await storedChat(owner.relay, chatId))?.execution_receipt).toMatchObject({
        state: 'complete', device_id: 'legacy-owner', provider_version: '1.0.0',
      });
    } finally {
      closeWebSocket(owner.ws);
    }
  });

  it('does not invent an executing node for work cancelled before assignment', async () => {
    const userId = `chat-unassigned-cancel-${crypto.randomUUID()}`;
    const owner = await connectAgent(userId, pinnedCapabilities, { deviceId: 'busy-cancel-owner' });
    try {
      await pinnedChat(owner.relay, userId, 'busy-cancel-owner');
      await waitForWebSocketJson(owner.ws);
      const queuedId = await pinnedChat(owner.relay, userId, 'busy-cancel-owner');
      expect((await statusFor(owner.relay, queuedId)).status).toBe('queued');
      await owner.relay.fetch(new Request(`https://relay/internal/chat/${queuedId}`, { method: 'POST' }));
      const receipt = (await storedChat(owner.relay, queuedId))?.execution_receipt;
      expect(receipt).toMatchObject({ state: 'cancelled', started_at: null, error_code: 'EXECUTION_CANCELLED' });
      expect(receipt).not.toHaveProperty('device_id');
      expect(receipt).not.toHaveProperty('provider_version');
    } finally {
      closeWebSocket(owner.ws);
    }
  });

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
