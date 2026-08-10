import { SELF, env, fetchMock } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

function setCookies(response: Response): string[] {
  return response.headers.getSetCookie();
}

function cookieHeader(cookies: string[]): string {
  return cookies.map((value) => value.split(';', 1)[0]).join('; ');
}

describe('relay browser auth', () => {
  beforeAll(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });

  afterAll(() => {
    fetchMock.assertNoPendingInterceptors();
  });

  it('starts a PKCE authorization flow with scoped, HttpOnly state cookies', async () => {
    const response = await SELF.fetch(new Request(
      'https://relay.example/auth/start?return_to=%2Ffleet',
      { redirect: 'manual' }
    ));

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get('Location') ?? '');
    expect(location.origin + location.pathname).toBe(`${env.BROKER_ORIGIN}/oauth/authorize`);
    expect(location.searchParams.get('client_id')).toBe('mererun-relay');
    expect(location.searchParams.get('redirect_uri')).toBe('https://relay.example/auth/callback');
    expect(location.searchParams.get('code_challenge_method')).toBe('S256');
    expect(location.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const cookies = setCookies(response);
    expect(cookies).toHaveLength(3);
    expect(cookies.every((value) => value.includes('HttpOnly') && value.includes('SameSite=Lax'))).toBe(true);
    expect(cookies.every((value) => value.includes('Path=/auth'))).toBe(true);
  });

  it('rejects callback state that does not match the signed-in browser', async () => {
    const response = await SELF.fetch(new Request(
      'https://relay.example/auth/callback?code=grant&state=attacker',
      {
        headers: { Cookie: 'mere_relay_oauth_state=expected' },
        redirect: 'manual',
      }
    ));
    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toContain('auth_error=');
  });

  it('exchanges a valid authorization code into an account-scoped relay session', async () => {
    const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
    const kid = 'relay-auth-test';
    const publicJwk = await exportJWK(publicKey);
    publicJwk.kid = kid;
    publicJwk.alg = 'RS256';
    publicJwk.use = 'sig';
    const token = await new SignJWT({ email: 'operator@example.com', name: 'Relay Operator' })
      .setProtectedHeader({ alg: 'RS256', kid })
      .setIssuer(env.BROKER_ORIGIN)
      .setAudience('mere-run-relay')
      .setSubject('user-relay-123')
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(privateKey);

    fetchMock.get(env.BROKER_ORIGIN)
      .intercept({
        path: '/oauth/token',
        method: 'POST',
        headers: {
          accept: 'application/json',
          origin: env.BROKER_ORIGIN,
        },
      })
      .reply(200, {
        access_token: token,
        refresh_token: 'refresh-test-token',
        token_type: 'Bearer',
        expires_in: 900,
      });
    fetchMock.get(env.BROKER_ORIGIN)
      .intercept({ path: '/.well-known/jwks.json', method: 'GET' })
      .reply(200, { keys: [publicJwk] });

    const start = await SELF.fetch(new Request(
      'https://relay.example/auth/start?return_to=%2F',
      { redirect: 'manual' }
    ));
    const location = new URL(start.headers.get('Location') ?? '');
    const callback = await SELF.fetch(new Request(
      `https://relay.example/auth/callback?code=valid-grant&state=${encodeURIComponent(location.searchParams.get('state') ?? '')}`,
      {
        headers: { Cookie: cookieHeader(setCookies(start)) },
        redirect: 'manual',
      }
    ));

    expect(callback.status).toBe(302);
    expect(callback.headers.get('Location')).toBe('https://relay.example/');
    const callbackCookies = setCookies(callback);
    expect(callbackCookies.some((value) => value.startsWith('mere_relay_access=') && value.includes('Secure'))).toBe(true);
    expect(callbackCookies.some((value) => value.startsWith('mere_relay_refresh=') && value.includes('HttpOnly'))).toBe(true);

    const session = await SELF.fetch(new Request('https://relay.example/auth/session', {
      headers: { Cookie: cookieHeader(callbackCookies) },
    }));
    expect(session.status).toBe(200);
    await expect(session.json()).resolves.toMatchObject({
      authenticated: true,
      user: {
        user_id: 'user-relay-123',
        email: 'operator@example.com',
        name: 'Relay Operator',
      },
    });

    const fleet = await SELF.fetch(new Request('https://relay.example/api/fleet', {
      headers: { Cookie: cookieHeader(callbackCookies) },
    }));
    expect(fleet.status).toBe(200);
    await expect(fleet.json()).resolves.toMatchObject({
      summary: { total_nodes: 0, online_nodes: 0, queue_depth: 0 },
      nodes: [],
    });
  });

  it('requires a refresh token and clears both session cookies on logout', async () => {
    const refresh = await SELF.fetch(new Request('https://relay.example/auth/refresh', { method: 'POST' }));
    expect(refresh.status).toBe(401);

    const logout = await SELF.fetch(new Request('https://relay.example/auth/logout', { redirect: 'manual' }));
    expect(logout.status).toBe(302);
    const cookies = setCookies(logout);
    expect(cookies).toHaveLength(2);
    expect(cookies.every((value) => value.includes('Max-Age=0'))).toBe(true);
  });
});
