import type { AuthResult, Env } from './types';
import { authenticateClient, verifyBrokerToken } from './auth';
import { readResponseJson } from './json';
import { tokenResponseSchema } from './contracts/responses';

const CLIENT_ID = 'mererun-relay';
const ACCESS_COOKIE = 'mere_relay_access';
const REFRESH_COOKIE = 'mere_relay_refresh';
const STATE_COOKIE = 'mere_relay_oauth_state';
const VERIFIER_COOKIE = 'mere_relay_oauth_verifier';
const RETURN_COOKIE = 'mere_relay_return_to';

interface TokenResponse {
  access_token?: string;
  id_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function randomValue(bytes = 32): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

async function codeChallenge(verifier: string): Promise<string> {
  return base64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
}

function cookieMap(request: Request): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const cookie of (request.headers.get('Cookie') ?? '').split(';')) {
    const [name, ...value] = cookie.trim().split('=');
    if (name) cookies.set(name, decodeURIComponent(value.join('=')));
  }
  return cookies;
}

function cookie(
  name: string,
  value: string,
  requestUrl: URL,
  options: { maxAge: number; path?: string }
): string {
  return [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${options.path ?? '/'}`,
    `Max-Age=${options.maxAge}`,
    'HttpOnly',
    'SameSite=Lax',
    requestUrl.protocol === 'https:' ? 'Secure' : '',
  ].filter(Boolean).join('; ');
}

function safeReturnPath(value: string | null | undefined): string {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return '/';
  return value;
}

function callbackUrl(url: URL): string {
  return `${url.origin}/auth/callback`;
}

function authErrorRedirect(url: URL, message: string): Response {
  const redirect = new URL('/', url.origin);
  redirect.searchParams.set('auth_error', message);
  return Response.redirect(redirect.toString(), 302);
}

async function exchangeToken(env: Env, body: URLSearchParams): Promise<TokenResponse> {
  const response = await fetch(`${env.BROKER_ORIGIN}/oauth/token`, {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      // mere.world rejects form-encoded cross-site POSTs. This is a trusted
      // server-to-server OAuth exchange, so identify it as broker-originated.
      'Origin': env.BROKER_ORIGIN,
    },
    body,
  });
  let payload: TokenResponse;
  try {
    payload = await readResponseJson(response, tokenResponseSchema);
  } catch {
    payload = { error: 'invalid_response', error_description: 'mere.world returned an invalid token response.' };
  }
  if (!response.ok && !payload.error) payload.error = 'token_exchange_failed';
  return payload;
}

function appendSessionCookies(
  headers: Headers,
  requestUrl: URL,
  tokens: TokenResponse,
  previousRefreshToken?: string
): void {
  const accessToken = tokens.access_token || tokens.id_token;
  if (!accessToken) return;
  const maxAge = Math.max(60, Math.min(86_400, Math.round(tokens.expires_in ?? 900)));
  headers.append('Set-Cookie', cookie(ACCESS_COOKIE, accessToken, requestUrl, { maxAge }));
  const refreshToken = tokens.refresh_token || previousRefreshToken;
  if (refreshToken) {
    headers.append('Set-Cookie', cookie(REFRESH_COOKIE, refreshToken, requestUrl, { maxAge: 30 * 24 * 60 * 60 }));
  }
}

export async function handleWebAuthStart(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const state = randomValue();
  const verifier = randomValue(48);
  const authorize = new URL('/oauth/authorize', env.BROKER_ORIGIN);
  authorize.searchParams.set('response_type', 'code');
  authorize.searchParams.set('client_id', CLIENT_ID);
  authorize.searchParams.set('redirect_uri', callbackUrl(url));
  authorize.searchParams.set('scope', 'openid profile email offline_access');
  authorize.searchParams.set('state', state);
  authorize.searchParams.set('code_challenge', await codeChallenge(verifier));
  authorize.searchParams.set('code_challenge_method', 'S256');

  const headers = new Headers({ Location: authorize.toString(), 'Cache-Control': 'no-store' });
  headers.append('Set-Cookie', cookie(STATE_COOKIE, state, url, { maxAge: 600, path: '/auth' }));
  headers.append('Set-Cookie', cookie(VERIFIER_COOKIE, verifier, url, { maxAge: 600, path: '/auth' }));
  headers.append('Set-Cookie', cookie(
    RETURN_COOKIE,
    safeReturnPath(url.searchParams.get('return_to')),
    url,
    { maxAge: 600, path: '/auth' }
  ));
  return new Response(null, { status: 302, headers });
}

export async function handleWebAuthCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const cookies = cookieMap(request);
  const state = url.searchParams.get('state');
  const code = url.searchParams.get('code');
  if (!state || state !== cookies.get(STATE_COOKIE) || !code) {
    return authErrorRedirect(url, 'The sign-in response could not be verified. Please try again.');
  }
  const verifier = cookies.get(VERIFIER_COOKIE);
  if (!verifier) {
    return authErrorRedirect(url, 'The sign-in attempt expired. Please try again.');
  }

  const tokens = await exchangeToken(env, new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: CLIENT_ID,
    code,
    redirect_uri: callbackUrl(url),
    code_verifier: verifier,
  }));
  const accessToken = tokens.access_token || tokens.id_token;
  if (!accessToken || !(await verifyBrokerToken(accessToken, env))) {
    return authErrorRedirect(
      url,
      tokens.error_description || tokens.error || 'mere.world did not return a valid relay session.'
    );
  }

  const headers = new Headers({
    Location: new URL(safeReturnPath(cookies.get(RETURN_COOKIE)), url.origin).toString(),
    'Cache-Control': 'no-store',
  });
  appendSessionCookies(headers, url, tokens);
  for (const name of [STATE_COOKIE, VERIFIER_COOKIE, RETURN_COOKIE]) {
    headers.append('Set-Cookie', cookie(name, '', url, { maxAge: 0, path: '/auth' }));
  }
  return new Response(null, { status: 302, headers });
}

export async function handleWebAuthRefresh(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const refreshToken = cookieMap(request).get(REFRESH_COOKIE);
  if (!refreshToken) {
    return Response.json({ authenticated: false }, { status: 401 });
  }
  const tokens = await exchangeToken(env, new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: CLIENT_ID,
    refresh_token: refreshToken,
  }));
  const accessToken = tokens.access_token || tokens.id_token;
  const identity = accessToken ? await verifyBrokerToken(accessToken, env) : null;
  if (!accessToken || !identity) {
    return Response.json(
      { authenticated: false, error: tokens.error_description || tokens.error || 'Session refresh failed' },
      { status: 401 }
    );
  }
  const headers = new Headers({ 'Cache-Control': 'no-store' });
  appendSessionCookies(headers, url, tokens, refreshToken);
  return Response.json({ authenticated: true, user: identity }, { headers });
}

export async function handleWebAuthSession(request: Request, env: Env): Promise<Response> {
  const identity = await authenticateClient(request, env);
  if (!identity) {
    return Response.json({ authenticated: false }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
  }
  return Response.json(
    { authenticated: true, user: identity },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}

export function handleWebAuthLogout(request: Request): Response {
  const url = new URL(request.url);
  const headers = new Headers({ Location: new URL('/', url.origin).toString(), 'Cache-Control': 'no-store' });
  headers.append('Set-Cookie', cookie(ACCESS_COOKIE, '', url, { maxAge: 0 }));
  headers.append('Set-Cookie', cookie(REFRESH_COOKIE, '', url, { maxAge: 0 }));
  return new Response(null, { status: 302, headers });
}

export function webAuthClientId(): string {
  return CLIENT_ID;
}

export type WebAuthIdentity = AuthResult;
