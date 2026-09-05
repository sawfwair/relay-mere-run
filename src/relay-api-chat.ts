import type { RelayContext } from './relay-context';
import type {
  Chat,
  SubmitChatRequest,
  ChatStatusResponse,
} from './types';
import {
  assignChatToAgent,
  getChatQueuePosition,
} from './relay-queue';
import { buildCancelResponse } from './relay-api-common';
import { chatRequestContent, sha256Json } from './execution';
import { cancelWork } from './relay-lifecycle';
import { buildChatReceiptBase } from './relay-receipts';
import { reserveChat } from './relay-chat-admission';

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
  const requestSha256 = await sha256Json(chatRequestContent(request));
  const idempotencyKey = request.idempotency_key?.trim();
  const chatId = request.chat_id ?? `chat_${crypto.randomUUID().slice(0, 12)}`;
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

  const reservation = await reserveChat(ctx, chat);
  if (reservation.kind === 'denied') {
    return Response.json({ error: reservation.code, code: reservation.code }, { status: reservation.status });
  }
  if (reservation.kind === 'replay') return repeatedSubmission(reservation.chat);
  ctx.chats.set(chatId, chat);
  if (await assignChatToAgent(ctx, chat)) return repeatedSubmission(chat);
  // Once admitted, a disconnect must not erase an execution another caller
  // has already received. Reconnect/queue recovery retains the reserved ID.
  return Response.json({ chat_id: chatId, status: 'queued', position: getChatQueuePosition(ctx, chatId) });
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
