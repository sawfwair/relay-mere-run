import { env, runInDurableObject } from 'cloudflare:test';
import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { clearJwksCache, authenticateAgent } from '../src/auth';
import { authorizeExecutionRequest, executionGrantFromClaims, restrictExecutionResponse } from '../src/execution-grant';
import { chatRequestContent, sha256Json, sha256Text } from '../src/execution';
import type { Env, SubmitChatRequest } from '../src/types';
import { capabilitiesWithModels, closeWebSocket, connectAgent, readJson, submitChat, waitForWebSocketJson } from './helpers';

const model = 'example-text-model';
const spec = 'a'.repeat(64);
const now = () => Math.floor(Date.now() / 1000);
const req = (path: string, method = 'GET', body?: unknown) => new Request(`https://relay.example/api${path}`, {
  method, headers: { Authorization: 'Bearer fixture', 'Content-Type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

async function fixture() {
  const key = `example-workflow:${'1'.repeat(64)}`;
  const body: SubmitChatRequest = { chat_id: `chat_${(await sha256Text(key)).slice(0, 32)}`,
    idempotency_key: key, execution_spec_sha256: spec, model, max_tokens: 512,
    messages: [{ role: 'user', content: 'private bounded request' }] };
  const execution = { chat_id: body.chat_id!, idempotency_key: key,
    request_sha256: await sha256Json(chatRequestContent(body)), execution_spec_sha256: spec,
    model_id: model, adapter_manifest_sha256: null, max_tokens: 1024 };
  const grant = { version: 2 as const, kind: 'chat' as const,
    id: 'e50aa638-f0dc-4eed-8e82-408c8c7fcb85', executions: [execution] as [typeof execution] };
  const claims: JWTPayload = { sub: 'owner', iat: now(), exp: now() + 300,
    client_id: 'example-app', azp: 'example-app', scope: 'relay:chat-execution',
    token_use: 'relay_execution', relay_execution_grant: grant };
  return { body, execution, grant, claims };
}

afterEach(() => { clearJwksCache(); vi.unstubAllGlobals(); });

describe('single-execution background chat authorization', () => {
  it('requires a complete versioned scope and never downgrades malformed chat claims', async () => {
    const { grant, claims, execution } = await fixture();
    expect(executionGrantFromClaims(claims)).toEqual(grant);
    expect(() => executionGrantFromClaims({ sub: 'owner', scope: 'relay:chat-execution' })).toThrow();
    for (const changes of [
      { scope: 'relay:graph-execution' }, { scope: 'openid relay:chat-execution' }, { token_use: 'oauth_access' },
      { relay_execution_grant: { ...grant, executions: [] } },
      { relay_execution_grant: { ...grant, executions: [execution, execution] } },
      { relay_execution_grant: { ...grant, executions: [{ ...execution, max_tokens: 0 }] } },
      { relay_execution_grant: { ...grant, executions: [{ ...execution, request_sha256: undefined }] } },
      { relay_execution_grant: { ...grant, executions: [{ ...execution, model_id: '' }] } },
    ]) expect(() => executionGrantFromClaims({ ...claims, ...changes })).toThrow();
  });

  it('allows only the reserved chat and exact content, not fleet, graph, uploads or other chat reads', async () => {
    const { grant, body, execution } = await fixture();
    expect(await authorizeExecutionRequest(req('/chat', 'POST', body), '/chat', grant)).toBeNull();
    for (const [method, path] of [
      ['GET', `/chat/${execution.chat_id}`], ['POST', `/chat/${execution.chat_id}/cancel`],
    ]) {
      expect(await authorizeExecutionRequest(req(path, method), path, grant)).toBeNull();
    }
    for (const path of ['/fleet', '/status', '/chat', '/chat/other', '/graph-jobs/capabilities',
      '/graph-jobs', '/uploads', '/agent', '/zero-agent/fleet', `/chat/${execution.chat_id}/events`]) {
      expect((await authorizeExecutionRequest(req(path), path, grant))?.status).toBe(403);
    }
    expect((await authorizeExecutionRequest(new Request('https://relay.example/api/chat'), '/chat', grant))?.status).toBe(403);
    expect((await authorizeExecutionRequest(req('/chat', 'POST', { ...body, temperature: 1 }), '/chat', grant))?.status).toBe(403);
    expect((await restrictExecutionResponse(Response.json({ chat_id: 'other', response: 'unrelated' }), grant)).status).toBe(403);
    expect((await restrictExecutionResponse(Response.json({ chat_id: execution.chat_id }), grant)).status).toBe(200);
  });

  it('enforces model, adapter and token ceilings even when the supplied digest matches modified content', async () => {
    const { grant, body, execution } = await fixture();
    for (const altered of [
      { ...body, chat_id: `chat_${'2'.repeat(32)}` }, { ...body, idempotency_key: 'different' },
      { ...body, model: 'different' }, { ...body, execution_spec_sha256: 'b'.repeat(64) },
      { ...body, max_tokens: 1025 }, { ...body, max_tokens: -1 }, { ...body, max_tokens: 1.5 },
      { ...body, max_tokens: undefined },
      { ...body, adapter: { manifest_sha256: 'c'.repeat(64), base_model_id: model } },
    ]) {
      const modifiedGrant = { ...grant, executions: [{ ...execution,
        request_sha256: await sha256Json(chatRequestContent(altered)) }] as [typeof execution] };
      expect((await authorizeExecutionRequest(req('/chat', 'POST', altered), '/chat', modifiedGrant))?.status).toBe(403);
    }
    const adapterBody = { ...body, adapter: { manifest_sha256: 'c'.repeat(64), base_model_id: model, scale: 0.75 } };
    const adapterGrant = { ...grant, executions: [{ ...execution, adapter_manifest_sha256: 'c'.repeat(64),
      request_sha256: await sha256Json(chatRequestContent(adapterBody)) }] };
    const parsed = executionGrantFromClaims({ ...(await fixture()).claims, relay_execution_grant: adapterGrant })!;
    expect(await authorizeExecutionRequest(req('/chat', 'POST', adapterBody), '/chat', parsed)).toBeNull();
    expect((await authorizeExecutionRequest(req('/chat', 'POST', body), '/chat', parsed))?.status).toBe(403);
  });

  it('enforces signed chat grants through the real Worker and account Durable Object to a node', async () => {
    const { body, grant, claims } = await fixture();
    const userId = `bounded-chat-${crypto.randomUUID()}`;
    const node = await connectAgent(userId, capabilitiesWithModels([model]), { deviceId: 'bounded-node' });
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const issuer = `https://broker-${crypto.randomUUID()}.example`;
    const jwk = await exportJWK(publicKey);
    vi.stubGlobal('fetch', vi.fn(() => Response.json({ keys: [{ ...jwk, kid: 'chat-grant', alg: 'RS256', use: 'sig' }] })));
    const token = await new SignJWT({ ...claims, sub: userId }).setIssuer(issuer).setAudience('mere-run-relay')
      .setProtectedHeader({ alg: 'RS256', kid: 'chat-grant' }).sign(privateKey);
    const workerEnv = { ...env, BROKER_ORIGIN: issuer } as Env;
    const call = (path: string, method = 'GET', input?: unknown) => worker.fetch(new Request(req(path, method, input), {
      headers: { Authorization: `Bearer ${token}`, 'X-User-Id': 'different-account', 'Content-Type': 'application/json' },
    }), workerEnv);
    try {
      expect(await authenticateAgent(new Request(req('/agent'), { headers: { Authorization: `Bearer ${token}` } }), workerEnv)).toBeNull();
      expect((await call('/fleet')).status).toBe(403);
      expect((await call('/chat', 'POST', body)).status).toBe(200);
      expect(await waitForWebSocketJson(node.ws)).toMatchObject({ type: 'chat_request', chat_id: body.chat_id });
      expect((await call('/chat', 'POST', body)).status).toBe(200);
      expect(await (await call(`/chat/${body.chat_id}`)).json()).toMatchObject({ user_id: userId, status: 'processing' });
      expect((await call('/chat/another')).status).toBe(403);
      expect((await call(`/chat/${body.chat_id}/cancel`, 'POST')).status).toBe(200);
      const terminal = await (await call(`/chat/${body.chat_id}`)).json();
      expect(terminal).toMatchObject({ execution_receipt: { execution_id: body.chat_id, state: 'cancelled',
        execution_spec_sha256: spec, request_sha256: grant.executions[0].request_sha256, device_id: 'bounded-node' } });
      const stored = await runInDurableObject(node.relay, async (_instance, state) => state.storage.get(`chat:${body.chat_id}`));
      expect(JSON.stringify(stored)).not.toContain('private bounded request');
      expect(JSON.stringify(stored)).not.toContain(token);
    } finally { closeWebSocket(node.ws); }
  });
});

describe('atomic account-scoped chat reservation', () => {
  it('shares one execution across concurrent repeats and rejects ID or content conflicts', async () => {
    const { body } = await fixture();
    const userId = `atomic-chat-${crypto.randomUUID()}`;
    const node = await connectAgent(userId, capabilitiesWithModels([model]), { deviceId: 'atomic-node' });
    try {
      const responses = await Promise.all(Array.from({ length: 5 }, () => submitChat(node.relay, userId, body)));
      for (const response of responses) {
        expect(response.status).toBe(200);
        expect(await readJson(response)).toMatchObject({ chat_id: body.chat_id });
      }
      expect(await waitForWebSocketJson(node.ws)).toMatchObject({ type: 'chat_request', chat_id: body.chat_id });
      const before = await runInDurableObject(node.relay, async (_instance, state) => state.storage.get(`chat:${body.chat_id}`));
      const conflict = await submitChat(node.relay, userId, { ...body, messages: [{ role: 'user', content: 'altered' }] });
      expect(conflict.status).toBe(409);
      expect(await conflict.json()).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
      const collision = await submitChat(node.relay, userId, { ...body, idempotency_key: 'other-key' });
      expect(collision.status).toBe(409);
      expect(await collision.json()).toMatchObject({ code: 'CHAT_ID_CONFLICT' });
      const after = await runInDurableObject(node.relay, async (_instance, state) => state.storage.get(`chat:${body.chat_id}`));
      expect(after).toEqual(before);
      const count = await runInDurableObject(node.relay, async (_instance, state) => (await state.storage.list({ prefix: 'chat:' })).size);
      expect(count).toBe(1);
    } finally { closeWebSocket(node.ws); }
  });
});
