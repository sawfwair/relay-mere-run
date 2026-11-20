import type { RelayContext } from './relay-context';
import type { Chat } from './types';
import { hasCapableAgentForChat } from './relay-queue';

type Reservation =
  | { kind: 'created' }
  | { kind: 'replay'; chat: Chat }
  | { kind: 'denied'; code: string; status: number };
type IdempotencyRecord = { chat_id: string; request_sha256: string };

/** Reserve both keys in one transaction, before exposing an execution.
 * Concurrent requests cannot overwrite an ID or run the same logical chat twice. */
export async function reserveChat(ctx: RelayContext, chat: Chat): Promise<Reservation> {
  return ctx.storage.transaction(async (storage) => {
    const key = chat.idempotency_key ? `chat-idempotency:${chat.idempotency_key}` : null;
    const previous = key ? await storage.get<IdempotencyRecord>(key) : undefined;
    if (previous) {
      if (previous.request_sha256 !== chat.request_sha256) {
        return { kind: 'denied', code: 'IDEMPOTENCY_CONFLICT', status: 409 };
      }
      const existing = await storage.get<Chat>(`chat:${previous.chat_id}`);
      if (existing) return { kind: 'replay', chat: existing };
      return { kind: 'denied', code: 'IDEMPOTENCY_EXECUTION_UNAVAILABLE', status: 410 };
    }
    if (await storage.get(`chat:${chat.chat_id}`)) {
      return { kind: 'denied', code: 'CHAT_ID_CONFLICT', status: 409 };
    }
    if (ctx.getConnectedAgents().size === 0) {
      return { kind: 'denied', code: 'NO_AGENTS', status: 503 };
    }
    if (!hasCapableAgentForChat(ctx, chat)) {
      return { kind: 'denied', code: 'NO_COMPATIBLE_AGENTS', status: 503 };
    }
    // Only queued prompts are durable, pending delivery. Assignment removes
    // the payload through the existing saveChat redaction boundary.
    await storage.put(`chat:${chat.chat_id}`, chat);
    if (key) await storage.put(key, { chat_id: chat.chat_id, request_sha256: chat.request_sha256 });
    return { kind: 'created' };
  });
}
