import type { RelayContext } from './relay-context';
import type {
  Chat,
  SubmitChatRequest,
  SubmitChatResponse,
  ChatStatusResponse,
} from './types';
import {
  assignChatToAgent,
  hasCapableAgentForChat,
  getChatQueuePosition,
} from './relay-queue';
import { finishSubmission } from './relay-api-common';
import { buildCancelResponse } from './relay-api-common';
import { sha256Json } from './execution';
import { cancelWork } from './relay-lifecycle';
import { buildChatReceiptBase } from './relay-receipts';

interface ChatIdempotencyRecord {
  chat_id: string;
  request_sha256: string;
}

function repeatedSubmission(chat: Chat): Response {
  const status = chat.status === 'processing' ? 'assigned' : chat.status;
  return Response.json({
    chat_id: chat.chat_id,
    status,
    ...(chat.agent_id ? { agent_id: chat.agent_id } : {}),
  });
}

export async function handleSubmitChat(
  ctx: RelayContext,
  request: SubmitChatRequest & { client_id: string },
  userId: string
): Promise<Response> {
  if (request.use_lora === true && !request.adapter) {
    return Response.json({
      error: 'An exact adapter reference is required when use_lora is true.',
      code: 'ADAPTER_REFERENCE_REQUIRED',
    }, { status: 400 });
  }
  if (request.adapter && request.model?.trim() && request.model.trim() !== request.adapter.base_model_id) {
    return Response.json({
      error: 'The requested model does not match the exact adapter base model.',
      code: 'ADAPTER_BASE_MODEL_MISMATCH',
    }, { status: 400 });
  }
  const requestSha256 = await sha256Json({
    messages: request.messages,
    max_tokens: request.max_tokens,
    temperature: request.temperature,
    requires_json: request.requires_json,
    adapter: request.adapter,
    required_device_id: request.required_device_id,
    execution_spec_sha256: request.execution_spec_sha256,
    identity: request.identity,
    model: request.model,
  });
  const idempotencyKey = request.idempotency_key?.trim();
  if (idempotencyKey) {
    const existing = await ctx.storage.get<ChatIdempotencyRecord>(`chat-idempotency:${idempotencyKey}`);
    if (existing) {
      if (existing.request_sha256 !== requestSha256) {
        return Response.json({
          error: 'Idempotency key was already used for a different request.',
          code: 'IDEMPOTENCY_CONFLICT',
        }, { status: 409 });
      }
      const existingChat = await ctx.getChat(existing.chat_id);
      if (existingChat) return repeatedSubmission(existingChat);
    }
  }
  const chatId = `chat_${crypto.randomUUID().slice(0, 12)}`;
  const chat: Chat = {
    chat_id: chatId,
    user_id: userId,
    client_id: request.client_id,
    agent_id: null,
    status: 'queued',
    messages: request.messages,
    max_tokens: request.max_tokens,
    temperature: request.temperature,
    requires_json: request.requires_json,
    use_lora: request.use_lora,
    adapter: request.adapter,
    required_device_id: request.required_device_id,
    execution_spec_sha256: request.execution_spec_sha256,
    identity: request.identity,
    idempotency_key: idempotencyKey,
    request_sha256: requestSha256,
    model: request.model,
    response: null,
    tokens_generated: null,
    error: null,
    created_at: new Date().toISOString(),
    started_at: null,
    completed_at: null,
    execution_receipt: null,
  };

  await ctx.saveChat(chat);
  if (idempotencyKey) {
    await ctx.storage.put(`chat-idempotency:${idempotencyKey}`, {
      chat_id: chatId,
      request_sha256: requestSha256,
    } satisfies ChatIdempotencyRecord);
  }

  return finishSubmission<SubmitChatResponse>({
    ctx,
    storageKey: `chat:${chatId}`,
    removeFromMemory: () => {
      ctx.chats.delete(chatId);
    },
    assign: () => assignChatToAgent(ctx, chat),
    hasCapableAgent: () => hasCapableAgentForChat(ctx, chat),
    getQueuePosition: () => getChatQueuePosition(ctx, chatId),
    buildAssignedResponse: () => ({
      chat_id: chatId,
      status: 'assigned',
      agent_id: chat.agent_id!,
    }),
    buildQueuedResponse: (position) => ({
      chat_id: chatId,
      status: 'queued',
      position,
    }),
  });
}

export async function handleGetChat(ctx: RelayContext, chatId: string): Promise<Response> {
  const chat = await ctx.getChat(chatId);
  if (!chat) {
    return Response.json({ error: 'Chat not found' }, { status: 404 });
  }

  const response: ChatStatusResponse = {
    chat_id: chat.chat_id,
    user_id: chat.user_id,
    client_id: chat.client_id,
    agent_id: chat.agent_id,
    status: chat.status,
    messages: chat.messages,
    response: chat.response,
    tokens_generated: chat.tokens_generated,
    error: chat.error,
    created_at: chat.created_at,
    started_at: chat.started_at,
    completed_at: chat.completed_at,
    execution_receipt: chat.execution_receipt,
  };

  return Response.json(response);
}

export async function handleCancelChat(ctx: RelayContext, chatId: string): Promise<Response> {
  const chat = await ctx.getChat(chatId);
  if (!chat) return Response.json({ error: 'Chat not found' }, { status: 404 });

  const outcome = await cancelWork({
    ctx,
    work: chat,
    workId: chat.chat_id,
    map: ctx.chats,
    persist: async (currentChat) => {
      if (currentChat.completed_at) {
        currentChat.execution_receipt = {
          ...buildChatReceiptBase(ctx, currentChat, currentChat.completed_at),
          state: 'cancelled',
          error_code: 'EXECUTION_CANCELLED',
        };
      }
      await ctx.saveChat(currentChat);
    },
    cancelMessage: { type: 'chat_cancel', chat_id: chatId },
    cancelLogLabel: `Failed to send chat cancel for ${chatId}:`,
    logMessage: `Chat ${chat.chat_id} cancelled`,
  });

  return buildCancelResponse<{ cancelled: boolean }>(outcome, 'Chat already completed');
}
