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

export function terminalErrorCode(error: string | null): string | null {
  if (!error) return null;
  const candidate = error.match(/\b[A-Z][A-Z0-9_]{2,63}\b/u)?.[0];
  return candidate ?? 'EXECUTION_FAILED';
}

export function sanitizedTerminalError(error: string | null): string {
  return terminalErrorCode(error) ?? 'EXECUTION_FAILED';
}
