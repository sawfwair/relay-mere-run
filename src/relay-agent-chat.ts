import type { RelayContext } from './relay-context';
import type {
  ChatResponseMessage,
  ChatErrorMessage,
} from './types';
import { finishTerminalWork } from './relay-lifecycle';
import { durationMs, recordNodePerformance } from './relay-fleet';

export async function handleChatResponse(
  ctx: RelayContext,
  msg: ChatResponseMessage
): Promise<void> {
  const chat = await ctx.getChat(msg.chat_id);
  if (!chat) return;

  chat.status = 'complete';
  chat.response = msg.response;
	chat.tokens_generated = msg.tokens_generated ?? null;
	chat.completed_at = new Date().toISOString();
	await recordNodePerformance(
		ctx,
		chat.agent_id,
		chat.model?.trim() || 'text',
		true,
		durationMs(chat.started_at, chat.completed_at) ?? undefined
	);

  await finishTerminalWork({
    ctx,
    work: chat,
    workId: chat.chat_id,
    agentId: chat.agent_id,
    map: ctx.chats,
    persist: async (currentChat) => {
      await ctx.storage.put(`chat:${currentChat.chat_id}`, currentChat);
    },
    logMessage: `Chat ${chat.chat_id} completed`,
  });
}

export async function handleChatError(
  ctx: RelayContext,
  msg: ChatErrorMessage
): Promise<void> {
  const chat = await ctx.getChat(msg.chat_id);
  if (!chat) return;

  chat.status = 'failed';
	chat.error = msg.error;
	chat.completed_at = new Date().toISOString();
	await recordNodePerformance(ctx, chat.agent_id, chat.model?.trim() || 'text', false);

  await finishTerminalWork({
    ctx,
    work: chat,
    workId: chat.chat_id,
    agentId: chat.agent_id,
    map: ctx.chats,
    persist: async (currentChat) => {
      await ctx.storage.put(`chat:${currentChat.chat_id}`, currentChat);
    },
    logMessage: `Chat ${chat.chat_id} failed: ${msg.error}`,
  });
}
