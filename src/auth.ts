import {
  createRemoteJWKSet,
  customFetch,
  jwtVerify,
  type FetchImplementation,
  type JWTVerifyGetKey,
} from 'jose';
import type { Env, AuthResult } from './types';

// mere.world issues brokered access tokens as RS256 JWTs (better-auth jwt
// plugin). We validate them statelessly against the broker's JWKS — no userinfo
// round-trip, no shared secret. `createRemoteJWKSet` fetches and caches the keys.
let jwks: JWTVerifyGetKey | null = null;
let jwksOrigin: string | null = null;

const cachedJwksFetch: FetchImplementation = async (url, options) => {
  const cacheKey = new Request(url, { method: 'GET' });
  try {
    const cached = await caches.default.match(cacheKey);
    if (cached) return cached;
  } catch {
    // Authentication can still proceed when the runtime cache is unavailable.
  }

  const response = await fetch(url, options);
  if (response.ok) {
    const headers = new Headers(response.headers);
    headers.set('Cache-Control', 'public, max-age=60');
    const cachedResponse = new Response(response.clone().body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
    // Cache population is opportunistic. Authentication must not wait for a
    // stalled Cache API write after the broker has already returned valid keys.
    void caches.default.put(cacheKey, cachedResponse).catch(() => undefined);
  }
  return response;
};

function getJwks(brokerOrigin: string): JWTVerifyGetKey {
  if (!jwks || jwksOrigin !== brokerOrigin) {
    jwks = createRemoteJWKSet(
      new URL(`${brokerOrigin}/.well-known/jwks.json`),
      {
        timeoutDuration: 15_000,
        [customFetch]: cachedJwksFetch,
      }
    );
    jwksOrigin = brokerOrigin;
  }
  return jwks;
}

export function isTransientJwksError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  return error.code === 'ERR_JWKS_TIMEOUT' || error.code === 'ERR_JWKS_FETCH_FAILED';
}

export function clearJwksCache(): void {
  jwks = null;
  jwksOrigin = null;
}

/**
 * Parse the Authorization header for a Bearer token (a mere.world brokered JWT
 * obtained via the OAuth 2.0 device-authorization grant).
 */
function parseBearerToken(request: Request): string | null {
  const auth = request.headers.get('Authorization');
  if (auth?.startsWith('Bearer ')) return auth.slice(7);
  const cookies = request.headers.get('Cookie') ?? '';
  for (const cookie of cookies.split(';')) {
    const [name, ...value] = cookie.trim().split('=');
    if (name === 'mere_relay_access') {
      return decodeURIComponent(value.join('='));
    }
  }
  return null;
}

/**
 * Verify a brokered JWT and resolve it to its owner. `jwtVerify` checks the
 * signature (via JWKS), expiry, issuer, and Relay audience; `sub` is the stable
 * user id we key the per-user Durable Object (and the agent pool) on.
 */
export async function verifyBrokerToken(token: string, env: Env): Promise<AuthResult | null> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const { payload } = await jwtVerify(token, getJwks(env.BROKER_ORIGIN), {
        issuer: env.BROKER_ORIGIN,
        audience: 'mere-run-relay',
      });
      if (typeof payload.sub === 'string' && payload.sub) {
        return {
          user_id: payload.sub,
          email: typeof payload.email === 'string' ? payload.email : undefined,
          name: typeof payload.name === 'string' ? payload.name : undefined,
        };
      }
      return null;
    } catch (error) {
      if (attempt === 0 && isTransientJwksError(error)) {
        clearJwksCache();
        continue;
      }
      if (isTransientJwksError(error)) {
        const code = typeof error === 'object' && error !== null && 'code' in error
          ? String(error.code)
          : 'ERR_JWKS_UNKNOWN';
        console.warn('Broker JWKS verification failed after retry', {
          code,
          message: error instanceof Error ? error.message : String(error),
        });
      }
      return null;
    }
  }
  return null;
}

async function authenticateBrokerToken(request: Request, env: Env): Promise<AuthResult | null> {
  const token = parseBearerToken(request);
  if (!token) return null;
  return verifyBrokerToken(token, env);
}

/**
 * Authenticate an agent WebSocket connection (a mere.run node) via its
 * mere.world brokered token.
 */
export async function authenticateAgent(request: Request, env: Env): Promise<AuthResult | null> {
  return authenticateBrokerToken(request, env);
}

/**
 * Authenticate a client HTTP request (an app submitting jobs) via its
 * mere.world brokered token.
 */
export async function authenticateClient(request: Request, env: Env): Promise<AuthResult | null> {
  return authenticateBrokerToken(request, env);
}
