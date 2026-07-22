import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { isTransientJwksError } from '../src/auth';

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
});
