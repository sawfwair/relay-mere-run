import type { SubmitChatRequest } from './types';

const encoder = new TextEncoder();

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, entry]) => [key, canonicalize(entry)])
    );
  }
  return value;
}

export async function sha256Text(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export async function sha256Json(value: unknown): Promise<string> {
  return sha256Text(canonicalJson(value));
}

/** The same runtime projection authorizes a grant and addresses its receipt.
 * Transport IDs and wire-compatibility flags do not change model execution. */
export function chatRequestContent(request: SubmitChatRequest): unknown {
  return {
    messages: request.messages, max_tokens: request.max_tokens,
    temperature: request.temperature, requires_json: request.requires_json,
    adapter: request.adapter, required_device_id: request.required_device_id,
    execution_spec_sha256: request.execution_spec_sha256, identity: request.identity,
    model: request.model,
  };
}

export function graphRequestContent(body: {
  job: object; graph: unknown; inputs: unknown; assets: unknown; bundle_documents?: unknown;
}): unknown {
  const job = Object.fromEntries(Object.entries(body.job).filter(
    ([key]) => !['job_id', 'created_at', 'idempotency_key'].includes(key),
  ));
  return { job, graph: body.graph, inputs: body.inputs, assets: body.assets, bundle_documents: body.bundle_documents };
}

export function terminalErrorCode(error: string | null): string | null {
  if (!error) return null;
  const candidate = error.match(/\b[A-Z][A-Z0-9_]{2,63}\b/u)?.[0];
  return candidate ?? 'EXECUTION_FAILED';
}

export function sanitizedTerminalError(error: string | null): string {
  return terminalErrorCode(error) ?? 'EXECUTION_FAILED';
}
