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

export async function handleSubmitChat(
  ctx: RelayContext,
  request: SubmitChatRequest & { client_id: string },
  userId: string
): Promise<Response> {
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
    model: request.model,
    response: null,
    tokens_generated: null,
    error: null,
    created_at: new Date().toISOString(),
    started_at: null,
    completed_at: null,
  };

  await ctx.saveChat(chat);

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
  };

  return Response.json(response);
}
