import { SELF, env } from 'cloudflare:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearJwksCache, isTransientJwksError, verifyBrokerToken } from '../src/auth';

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
    vi.stubGlobal('fetch', vi.fn(() => Response.json({
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
});
