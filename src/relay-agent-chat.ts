import type { RelayContext } from './relay-context';
import type {
  ChatResponseMessage,
  ChatErrorMessage,
} from './types';
import { finishTerminalWork } from './relay-lifecycle';
import { durationMs, recordNodePerformance } from './relay-fleet';
import { sanitizedTerminalError, sha256Text } from './execution';
import { buildChatReceiptBase } from './relay-receipts';

export async function handleChatResponse(
  ctx: RelayContext,
  msg: ChatResponseMessage
): Promise<void> {
  const chat = await ctx.getChat(msg.chat_id);
  if (!chat) return;
  if (chat.status === 'cancelled') {
    console.log(`Ignoring late chat response for cancelled request ${msg.chat_id}`);
    return;
  }

  chat.status = 'complete';
  chat.response = msg.response;
  chat.tokens_generated = msg.tokens_generated ?? null;
  chat.completed_at = new Date().toISOString();
  chat.execution_receipt = {
    ...buildChatReceiptBase(ctx, chat, chat.completed_at),
    state: 'complete',
    output_sha256: await sha256Text(msg.response),
  };
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
      await ctx.saveChat(currentChat);
    },
    retainInMemoryMs: 5 * 60_000,
    logMessage: `Chat ${chat.chat_id} completed`,
  });
}

export async function handleChatError(
  ctx: RelayContext,
  msg: ChatErrorMessage
): Promise<void> {
  const chat = await ctx.getChat(msg.chat_id);
  if (!chat) return;
  if (chat.status === 'cancelled') {
    console.log(`Ignoring late chat error for cancelled request ${msg.chat_id}`);
    return;
  }

  chat.status = 'failed';
  const errorCode = sanitizedTerminalError(msg.error);
  chat.error = errorCode;
  chat.completed_at = new Date().toISOString();
  chat.execution_receipt = {
    ...buildChatReceiptBase(ctx, chat, chat.completed_at),
    state: 'failed',
    error_code: errorCode,
  };
  await recordNodePerformance(ctx, chat.agent_id, chat.model?.trim() || 'text', false);

  await finishTerminalWork({
    ctx,
    work: chat,
    workId: chat.chat_id,
    agentId: chat.agent_id,
    map: ctx.chats,
    persist: async (currentChat) => {
      await ctx.saveChat(currentChat);
    },
    retainInMemoryMs: 5 * 60_000,
    logMessage: `Chat ${chat.chat_id} failed: ${errorCode}`,
  });
}
