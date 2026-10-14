import type { Env } from './types';

export function isBatchPath(path: string, prefix = ''): boolean {
  return path === `${prefix}/graph-batches` || path.startsWith(`${prefix}/graph-batches/`);
}

export function forwardClientBatch(request: Request, env: Env, userId: string): Promise<Response> | null {
  const url = new URL(request.url);
  // The legacy client prefix is handled by the existing route adapter.
  if (!isBatchPath(url.pathname, '/api')) return null;
  const relay = env.MERE_RUN_RELAY.get(env.MERE_RUN_RELAY.idFromName(userId));
  return relay.fetch(new Request(`${url.origin}/internal${url.pathname.slice('/api'.length)}${url.search}`, {
    method: request.method, body: request.body,
    headers: { 'Content-Type': request.headers.get('Content-Type') ?? 'application/json', 'X-User-Id': userId },
  }));
}
