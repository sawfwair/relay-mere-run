import type { JWTPayload } from 'jose';
import { z } from 'zod';
import { graphRequestContent, sha256Json } from './execution';
import { readResponseJson } from './json';
import { chatExecutionAllowed, chatExecutionGrantSchema } from './chat-execution-grant';

const identifier = z.string().min(1).max(160).regex(/^[A-Za-z0-9_.:-]+$/u);
const graphGrantSchema = z.object({
  version: z.literal(1),
  id: z.uuid(),
  executions: z.array(z.object({
    job_id: identifier,
    idempotency_key: identifier,
    provider_id: identifier,
    node_kind: identifier,
    request_sha256: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  }).strict()).min(1).max(8),
}).strict();

const grantSchema = z.discriminatedUnion('version', [graphGrantSchema, chatExecutionGrantSchema]);
export type RelayExecutionGrant = z.infer<typeof grantSchema>;

/** A malformed restricted token must never fall back to account-wide access. */
export function executionGrantFromClaims(payload: JWTPayload): RelayExecutionGrant | undefined {
  const scope = typeof payload.scope === 'string' ? payload.scope.split(/\s+/u) : [];
  const restricted = payload.token_use === 'relay_execution'
    || payload.relay_execution_grant !== undefined
    || scope.some((value) => ['relay:graph-execution', 'relay:chat-execution'].includes(value));
  if (!restricted) return undefined;
  if (payload.token_use !== 'relay_execution'
    || typeof payload.client_id !== 'string' || !identifier.safeParse(payload.client_id).success
    || payload.azp !== payload.client_id
    || !Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp)
    || Number(payload.exp) - Number(payload.iat) > 300
    || Number(payload.exp) <= Number(payload.iat)
    || Number(payload.iat) > Math.floor(Date.now() / 1000) + 30) {
    throw new Error('Invalid execution grant claims');
  }
  const grant = grantSchema.parse(payload.relay_execution_grant);
  if (payload.scope !== (grant.version === 1 ? 'relay:graph-execution' : 'relay:chat-execution')) {
    throw new Error('Execution grant scope does not match its kind');
  }
  if (grant.version === 1 && (new Set(grant.executions.map((entry) => entry.job_id)).size !== grant.executions.length
    || new Set(grant.executions.map((entry) => entry.idempotency_key)).size !== grant.executions.length)) {
    throw new Error('Duplicate execution grant slots');
  }
  return grant;
}

function denied(): Response {
  return Response.json({ error: 'Execution grant does not authorize this operation', code: 'EXECUTION_SCOPE_DENIED' },
    { status: 403, headers: { 'Cache-Control': 'no-store' } });
}

const envelopeSchema = z.object({
  job: z.object({ job_id: z.string(), idempotency_key: z.string() }).passthrough(),
  graph: z.object({ nodes: z.array(z.object({ provider: z.string(), kind: z.string() }).passthrough()).min(1) }).passthrough(),
  inputs: z.unknown(), assets: z.unknown(), bundle_documents: z.unknown().optional(),
}).passthrough();

async function submissionAllowed(request: Request, grant: z.infer<typeof graphGrantSchema>): Promise<boolean> {
  const text = await request.clone().text();
  if (text.length > 2_000_000) return false;
  let json: unknown;
  try { json = JSON.parse(text); } catch { return false; }
  const parsed = envelopeSchema.safeParse(json);
  if (!parsed.success) return false;
  const body = parsed.data;
  const execution = grant.executions.find((entry) => entry.job_id === body.job.job_id);
  if (!execution || execution.idempotency_key !== body.job.idempotency_key
    || !body.graph.nodes.every((node) => node.provider === execution.provider_id && node.kind === execution.node_kind)) return false;
  return !execution.request_sha256
    || execution.request_sha256 === await sha256Json(graphRequestContent(body));
}

/** The allowlist deliberately excludes account lists, uploads, fleet changes,
 * other inference APIs, and node sockets. Each mutation names a reserved job. */
export async function authorizeExecutionRequest(
  request: Request, path: string, grant: RelayExecutionGrant,
): Promise<Response | null> {
  if (!request.headers.get('Authorization')?.startsWith('Bearer ')) return denied();
  if (grant.version === 2) return await chatExecutionAllowed(request, path, grant) ? null : denied();
  if (path === '/graph-jobs/capabilities' && request.method === 'GET') return null;
  if (path === '/graph-jobs' && request.method === 'POST') {
    return await submissionAllowed(request, grant) ? null : denied();
  }
  const match = path.match(/^\/graph-jobs\/([A-Za-z0-9_.:-]+)(?:\/(commit|artifacts\/receipt))?$/u);
  if (!match || !grant.executions.some((entry) => entry.job_id === match[1])) return denied();
  if (!match[2] && ['GET', 'DELETE'].includes(request.method)) return null;
  if (match[2] === 'commit' && request.method === 'POST') return null;
  if (match[2] === 'artifacts/receipt' && request.method === 'GET') return null;
  return denied();
}

// An account-wide idempotency record may point to a different execution. Do
// not disclose that execution through a restricted submission replay.
export async function restrictExecutionResponse(response: Response, grant: RelayExecutionGrant): Promise<Response> {
  if (!response.ok) return response;
  const body = await readResponseJson(response.clone(), z.object({
    job_id: z.string().optional(), chat_id: z.string().optional(),
  })).catch(() => null);
  const allowed = grant.version === 1
    ? grant.executions.some((entry) => entry.job_id === body?.job_id)
    : grant.executions[0].chat_id === body?.chat_id;
  if (!allowed) return denied();
  return response;
}
