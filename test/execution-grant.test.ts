import { env } from 'cloudflare:test';
import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { authenticateAgent, clearJwksCache, verifyBrokerToken } from '../src/auth';
import { authorizeExecutionRequest, executionGrantFromClaims, restrictExecutionResponse, type RelayExecutionGrant } from '../src/execution-grant';
import { graphRequestContent, sha256Json } from '../src/execution';
import type { Env } from '../src/types';

const grant: RelayExecutionGrant = {
  version: 1, id: 'e50aa638-f0dc-4eed-8e82-408c8c7fcb85',
  executions: [{ job_id: 'c833b5a0-28af-4d1d-98ee-52350b68f176', idempotency_key: 'test:workflow:1',
    provider_id: 'mere-example-provider', node_kind: 'example.generate' }],
};
const execution = grant.executions[0];
const now = () => Math.floor(Date.now() / 1000);
const claims = (): JWTPayload => ({ sub: 'owner', iat: now(), exp: now() + 300,
  client_id: 'example-app', azp: 'example-app', scope: 'relay:graph-execution', token_use: 'relay_execution',
  relay_execution_grant: grant });
const body = () => ({ job: { job_id: execution.job_id, idempotency_key: execution.idempotency_key, created_at: '2026-08-27T00:00:00Z' },
  graph: { nodes: [{ id: 'execute', provider: execution.provider_id, kind: execution.node_kind }] }, inputs: { payload: {} }, assets: {} });
const request = (path: string, method = 'GET', input?: unknown) => new Request(`https://relay.example/api${path}`, {
  method, headers: { Authorization: 'Bearer test', 'Content-Type': 'application/json' },
  ...(input === undefined ? {} : { body: JSON.stringify(input) }),
});

afterEach(() => { clearJwksCache(); vi.unstubAllGlobals(); });

describe('background execution scope', () => {
  it('accepts only complete five-minute scoped claims and does not downgrade malformed tokens', () => {
    expect(executionGrantFromClaims(claims())).toEqual(grant);
    expect(executionGrantFromClaims({ sub: 'owner', scope: 'openid profile' })).toBeUndefined();
    const invalid = [
      { relay_execution_grant: undefined }, { relay_execution_grant: null }, { token_use: 'oauth_access' },
      { scope: 'openid relay:graph-execution' }, { azp: 'other-app' }, { iat: undefined },
      { exp: undefined }, { exp: now() + 301 }, { iat: now() + 60 },
      { relay_execution_grant: { ...grant, executions: [execution, execution] } },
    ];
    for (const change of invalid) expect(() => executionGrantFromClaims({ ...claims(), ...change })).toThrow();
  });

  it('allows only the reserved graph operations with bearer authentication', async () => {
    for (const [method, path] of [
      ['GET', '/graph-jobs/capabilities'], ['GET', `/graph-jobs/${execution.job_id}`],
      ['DELETE', `/graph-jobs/${execution.job_id}`], ['POST', `/graph-jobs/${execution.job_id}/commit`],
      ['GET', `/graph-jobs/${execution.job_id}/artifacts/receipt`],
    ]) expect(await authorizeExecutionRequest(request(path, method), path, grant)).toBeNull();
    expect(await authorizeExecutionRequest(request('/graph-jobs', 'POST', body()), '/graph-jobs', grant)).toBeNull();
    for (const [method, path] of [
      ['GET', '/graph-jobs'], ['GET', '/graph-jobs/another-job'], ['DELETE', '/graph-jobs/another-job'],
      ['GET', '/fleet'], ['PATCH', '/fleet/settings'], ['GET', '/status'], ['POST', '/chat'],
      ['GET', '/graph-jobs/telemetry'], ['POST', '/graph-jobs/preflight'],
      ['POST', `/graph-jobs/${execution.job_id}/retry`], ['GET', `/graph-jobs/${execution.job_id}/events`],
      ['GET', `/graph-jobs/${execution.job_id}/artifacts/private-output`],
      ['PUT', `/graph-jobs/${execution.job_id}/assets/${'a'.repeat(64)}`],
      ['GET', `/graph-jobs/${execution.job_id}%2fartifacts%2freceipt`],
    ]) expect((await authorizeExecutionRequest(request(path, method), path, grant))?.status).toBe(403);
    expect((await authorizeExecutionRequest(new Request('https://relay.example/api/graph-jobs/capabilities'),
      '/graph-jobs/capabilities', grant))?.status).toBe(403);
  });

  it('binds submissions to job ID, idempotency key, provider, node kind, and optional immutable digest', async () => {
    for (const altered of [
      { ...body(), job: { ...body().job, job_id: 'another-job' } },
      { ...body(), job: { ...body().job, idempotency_key: 'other-key' } },
      { ...body(), graph: { nodes: [{ provider: 'other-provider', kind: execution.node_kind }] } },
      { ...body(), graph: { nodes: [{ provider: execution.provider_id, kind: 'other.kind' }] } },
      { ...body(), graph: { nodes: [] } }, {},
    ]) expect((await authorizeExecutionRequest(request('/graph-jobs', 'POST', altered), '/graph-jobs', grant))?.status).toBe(403);
    const pinned = { ...grant, executions: [{ ...execution, request_sha256: await sha256Json(graphRequestContent(body())) }] };
    expect(await authorizeExecutionRequest(request('/graph-jobs', 'POST', body()), '/graph-jobs', pinned)).toBeNull();
    expect((await authorizeExecutionRequest(request('/graph-jobs', 'POST', { ...body(), inputs: { altered: true } }), '/graph-jobs', pinned))?.status).toBe(403);
    expect((await restrictExecutionResponse(Response.json({ job_id: 'other-job', private: 'unrelated-result' }), grant)).status).toBe(403);
    expect((await restrictExecutionResponse(Response.json({ job_id: execution.job_id }), grant)).status).toBe(200);
  });

  it('enforces scope on the actual Worker route and cannot authenticate a node or cross accounts', async () => {
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const issuer = `https://broker-${crypto.randomUUID()}.example`;
    const publicJwk = await exportJWK(publicKey);
    vi.stubGlobal('fetch', vi.fn(() => Response.json({ keys: [{ ...publicJwk, kid: 'grant-test', alg: 'RS256', use: 'sig' }] })));
    const token = await new SignJWT(claims()).setIssuer(issuer).setAudience('mere-run-relay')
      .setProtectedHeader({ alg: 'RS256', kid: 'grant-test' }).sign(privateKey);
    const accounts: string[] = [];
    const calls: Request[] = [];
    const testEnv = { ...env, BROKER_ORIGIN: issuer, MERE_RUN_RELAY: {
      idFromName(name: string) { accounts.push(name); return name; },
      get() { return { fetch(input: Request) { calls.push(input); return Promise.resolve(Response.json({ job_id: execution.job_id })); } }; },
    } } as unknown as Env;
    const authRequest = (path: string, method = 'GET', input?: unknown) => new Request(request(path, method, input), {
      headers: { Authorization: `Bearer ${token}`, 'X-User-Id': 'attacker', 'Content-Type': 'application/json' },
    });
    expect(await verifyBrokerToken(token, testEnv)).toMatchObject({ user_id: 'owner', execution_grant: grant });
    expect(await authenticateAgent(authRequest('/agent'), testEnv)).toBeNull();
    expect((await worker.fetch(authRequest('/fleet'), testEnv)).status).toBe(403);
    expect((await worker.fetch(authRequest('/chat', 'POST', {}), testEnv)).status).toBe(403);
    expect(calls).toHaveLength(0);
    expect((await worker.fetch(authRequest(`/graph-jobs/${execution.job_id}`), testEnv)).status).toBe(200);
    expect((await worker.fetch(authRequest('/graph-jobs', 'POST', body()), testEnv)).status).toBe(200);
    expect(accounts).toEqual(['owner', 'owner']);
    expect(calls[1].headers.get('X-User-Id')).toBe('owner');
    expect((await worker.fetch(authRequest('/zero-agent/fleet'), testEnv)).status).toBe(403);
  });
});
