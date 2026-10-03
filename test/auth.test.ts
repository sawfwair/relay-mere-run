import { SELF, env } from 'cloudflare:test';
import { z } from 'zod';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { authenticateAgent, clearJwksCache, isTransientJwksError, verifyBrokerToken } from '../src/auth';

afterEach(() => {
  clearJwksCache();
  vi.unstubAllGlobals();
});

describe('relay broker authentication', () => {
  it('publishes the headless relay device-auth contract without authentication', async () => {
    const response = await SELF.fetch(new Request('https://relay.example/.well-known/mere-run-relay'));

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    await expect(response.json()).resolves.toEqual({
      schema_version: 1,
      kind: 'mere.run/relay',
      graph_contract_versions: ['mere.run/job-bundle.v1'],
      auth: {
        issuer: env.BROKER_ORIGIN,
        authorization_endpoint: `${env.BROKER_ORIGIN}/oauth/authorize`,
        device_authorization_endpoint: `${env.BROKER_ORIGIN}/oauth/device_authorization`,
        token_endpoint: `${env.BROKER_ORIGIN}/oauth/token`,
        client_id: 'mererun-node',
        scope: 'openid profile email offline_access',
      },
    });
  });

  it('retries only transient JWKS transport failures', () => {
    expect(isTransientJwksError({ code: 'ERR_JWKS_TIMEOUT' })).toBe(true);
    expect(isTransientJwksError({ code: 'ERR_JWKS_FETCH_FAILED' })).toBe(true);
    expect(isTransientJwksError({ code: 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED' })).toBe(false);
    expect(isTransientJwksError(new Error('network'))).toBe(false);
  });

  it('accepts only signed, live mere.world tokens for the Relay audience with a stable subject', async () => {
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const publicJwk = await exportJWK(publicKey);
    const issuer = `https://broker-${crypto.randomUUID()}.example`;
    vi.stubGlobal('fetch', vi.fn((url) => String(url).includes('/app/admission') ? Response.json({ allowed: true }) : Response.json({
      keys: [{ ...publicJwk, kid: 'relay-test', alg: 'RS256', use: 'sig' }],
    })));
    const sign = (claims: { aud: string; iss?: string; sub?: string; expiresIn?: string }) =>
      new SignJWT({ email: 'owner@example.com' })
        .setProtectedHeader({ alg: 'RS256', kid: 'relay-test' })
        .setIssuer(claims.iss ?? issuer)
        .setAudience(claims.aud)
        .setSubject(claims.sub ?? 'mere-user-1')
        .setIssuedAt()
        .setExpirationTime(claims.expiresIn ?? '5m')
        .sign(privateKey);
    const authEnv = { ...env, BROKER_ORIGIN: issuer };

    await expect(verifyBrokerToken(
      await sign({ aud: 'mere-run-relay' }),
      authEnv
    )).resolves.toMatchObject({ user_id: 'mere-user-1' });
    await expect(verifyBrokerToken(
      await sign({ aud: 'unrelated-service' }),
      authEnv
    )).resolves.toBeNull();
    await expect(verifyBrokerToken(
      await sign({ aud: 'mere-run-relay', iss: 'https://attacker.example' }),
      authEnv
    )).resolves.toBeNull();
    await expect(verifyBrokerToken(
      await sign({ aud: 'mere-run-relay', expiresIn: '-1s' }),
      authEnv
    )).resolves.toBeNull();
  });
  it('rechecks World admission for the same live token and fails closed on outages', async () => {
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const publicJwk = await exportJWK(publicKey);
    const issuer = `https://broker-${crypto.randomUUID()}.example`;
    let allowed: unknown = true;
    let unavailable = false;
    const fetcher = vi.fn((url, init?: RequestInit) => {
      if (String(url).includes('/app/admission')) {
        if (unavailable) return Promise.reject(new Error('offline'));
        expect(JSON.parse(typeof init?.body === 'string' ? init.body : 'null')).toEqual({ userId: 'mere-user-1', clientId: 'mererun-relay', audienceOrigin: 'https://relay.mere.run' });
        return Promise.resolve(Response.json({ allowed }));
      }
      return Promise.resolve(Response.json({ keys: [{ ...publicJwk, kid: 'revocation-test', alg: 'RS256', use: 'sig' }] }));
    });
    vi.stubGlobal('fetch', fetcher);
    const token = await new SignJWT({ email: 'owner@example.com' }).setProtectedHeader({ alg: 'RS256', kid: 'revocation-test' })
      .setIssuer(issuer).setAudience('mere-run-relay').setSubject('mere-user-1').setIssuedAt().setExpirationTime('5m').sign(privateKey);
    const authEnv = { ...env, BROKER_ORIGIN: issuer };
    expect(await verifyBrokerToken(token, authEnv)).toMatchObject({ user_id: 'mere-user-1' });
    allowed = false;
    expect(await verifyBrokerToken(token, authEnv)).toBeNull();
    allowed = 'true';
    expect(await verifyBrokerToken(token, authEnv)).toBeNull();
    allowed = true;
    unavailable = true;
    expect(await verifyBrokerToken(token, authEnv)).toBeNull();
    unavailable = false;
    expect(await verifyBrokerToken(token, { ...authEnv, AUTH_INTERNAL_TOKEN: undefined })).toBeNull();
    expect(await verifyBrokerToken(token, authEnv)).toMatchObject({ user_id: 'mere-user-1' });
  });

  it('requires both Relay and source-app access for Studio, iOS, and Node tokens', async () => {
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const publicJwk = await exportJWK(publicKey);
    const issuer = `https://broker-${crypto.randomUUID()}.example`;
    const allowed = new Set(['mererun-relay', 'mererun-studio', 'mererun-ios']);
    vi.stubGlobal('fetch', vi.fn((url, init?: RequestInit) => {
      if (String(url).includes('/app/admission')) {
        const body = z.object({ clientId: z.string(), audienceOrigin: z.string() }).parse(JSON.parse(typeof init?.body === 'string' ? init.body : 'null') as unknown);
        expect(body.audienceOrigin).toBe(body.clientId === 'mererun-relay' ? 'https://relay.mere.run'
          : body.clientId === 'mererun-studio' ? 'https://studio.mere.run' : issuer);
        return Promise.resolve(Response.json({ allowed: allowed.has(body.clientId) }));
      }
      return Promise.resolve(Response.json({ keys: [{ ...publicJwk, kid: 'source-test', alg: 'RS256', use: 'sig' }] }));
    }));
    const authEnv = { ...env, BROKER_ORIGIN: issuer };
    for (const source of ['mererun-studio', 'mererun-ios', 'mererun-node']) {
      allowed.add(source);
      const token = await new SignJWT({ client_id: source }).setProtectedHeader({ alg: 'RS256', kid: 'source-test' })
        .setIssuer(issuer).setAudience(source === 'mererun-node' ? 'mere-run-relay' : source)
        .setSubject('mere-user-1').setIssuedAt().setExpirationTime('5m').sign(privateKey);
      expect(await verifyBrokerToken(token, authEnv)).toMatchObject({ user_id: 'mere-user-1' });
      allowed.delete(source);
      expect(await verifyBrokerToken(token, authEnv)).toBeNull();
      allowed.add(source); allowed.delete('mererun-relay');
      expect(await verifyBrokerToken(token, authEnv)).toBeNull();
      allowed.add('mererun-relay');
      allowed.delete('mererun-node');
      const request = new Request('https://relay.mere.run/agent', { headers: { Authorization: `Bearer ${token}` } });
      expect(await authenticateAgent(request, authEnv)).toBeNull();
      allowed.add('mererun-node');
      expect(await authenticateAgent(request, authEnv)).toMatchObject({ user_id: 'mere-user-1' });
    }
  });

});
