import { z } from 'zod';
import { submitChatRequestSchema } from './contracts/requests';
import { chatRequestContent, sha256Json } from './execution';

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
export const chatExecutionGrantSchema = z.object({
  version: z.literal(2),
  kind: z.literal('chat'),
  id: z.uuid(),
  executions: z.tuple([z.object({
    chat_id: z.string().regex(/^chat_[a-f0-9]{32}$/u),
    idempotency_key: z.string().min(1).max(160).regex(/^[A-Za-z0-9_.:-]+$/u),
    request_sha256: digest,
    execution_spec_sha256: digest,
    model_id: z.string().min(1).max(200),
    adapter_manifest_sha256: digest.nullable(),
    max_tokens: z.number().int().min(1).max(32768),
  }).strict()]),
}).strict();

type ChatExecutionGrant = z.infer<typeof chatExecutionGrantSchema>;

/** A chat grant is deliberately not a fleet/read-all or graph capability. */
export async function chatExecutionAllowed(
  request: Request, path: string, grant: ChatExecutionGrant,
): Promise<boolean> {
  const execution = grant.executions[0];
  if (path === `/chat/${execution.chat_id}`) return request.method === 'GET';
  if (path === `/chat/${execution.chat_id}/cancel`) return request.method === 'POST';
  if (path !== '/chat' || request.method !== 'POST') return false;
  const text = await request.clone().text();
  if (text.length > 2_000_000) return false;
  let json: unknown;
  try { json = JSON.parse(text); } catch { return false; }
  const parsed = submitChatRequestSchema.safeParse(json);
  if (!parsed.success) return false;
  const body = parsed.data;
  if (body.chat_id !== execution.chat_id || body.idempotency_key !== execution.idempotency_key
    || body.execution_spec_sha256 !== execution.execution_spec_sha256
    || body.model !== execution.model_id
    || (body.adapter?.manifest_sha256 ?? null) !== execution.adapter_manifest_sha256
    || !Number.isSafeInteger(body.max_tokens) || Number(body.max_tokens) < 1
    || Number(body.max_tokens) > execution.max_tokens) return false;
  return await sha256Json(chatRequestContent(body)) === execution.request_sha256;
}
