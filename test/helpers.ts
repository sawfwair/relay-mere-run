import { env } from 'cloudflare:test';
import type {
  AgentCapabilities,
  AgentCapacity,
  AgentRuntimeInfo,
  AgentSystemInfo,
  SubmitAsrRequest,
  SubmitChatRequest,
  SubmitEmbedRequest,
  SubmitJobRequest,
  SubmitOcrRequest,
  SubmitTalkRequest,
  SubmitToolRequest,
} from '../src/types';

interface AgentConnectOptions {
  deviceId?: string;
  deviceName?: string;
  system?: AgentSystemInfo;
  runtime?: AgentRuntimeInfo;
  capacity?: AgentCapacity;
  availability?: {
    status: 'online' | 'busy';
    current_job_id?: string;
    source: string;
  };
}

interface AuthResultPayload {
  type: 'auth_result';
  success: boolean;
  agent_id: string;
  user_id: string;
}

interface PendingMessageWaiter {
  resolve: (value: string) => void;
  reject: (reason?: unknown) => void;
  timeout: ReturnType<typeof setTimeout>;
}

const DEFAULT_CAPABILITIES: AgentCapabilities = {
  models: ['mere-nano', 'talk-nano', 'asr', 'ocr'],
  max_resolution: 2048,
  controlnet: false,
  lora: true,
  img2img: true,
};

const wsMessageQueues = new WeakMap<WebSocket, string[]>();
const wsWaiters = new WeakMap<WebSocket, PendingMessageWaiter[]>();
const wsAttached = new WeakSet<WebSocket>();

function normalizeWebSocketData(data: unknown): string {
  if (typeof data === 'string') {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return new TextDecoder().decode(data);
  }
  return String(data);
}

function ensureWebSocketBuffer(ws: WebSocket): void {
  if (wsAttached.has(ws)) {
    return;
  }
  wsAttached.add(ws);
  wsMessageQueues.set(ws, []);
  wsWaiters.set(ws, []);

  ws.addEventListener('message', (event: MessageEvent) => {
    const payload = normalizeWebSocketData(event.data);
    const waiters = wsWaiters.get(ws);
    if (waiters && waiters.length > 0) {
      const waiter = waiters.shift();
      if (waiter) {
        clearTimeout(waiter.timeout);
        waiter.resolve(payload);
        return;
      }
    }
    const queue = wsMessageQueues.get(ws);
    if (queue) {
      queue.push(payload);
    }
  });

  ws.addEventListener('close', () => {
    const waiters = wsWaiters.get(ws);
    if (waiters) {
      for (const waiter of waiters) {
        clearTimeout(waiter.timeout);
        waiter.reject(new Error('WebSocket closed before message was received'));
      }
      waiters.length = 0;
    }
  });
}

export function getRelay(userId: string): DurableObjectStub {
  const id = env.MERE_RUN_RELAY.idFromName(userId);
  return env.MERE_RUN_RELAY.get(id);
}

export function capabilitiesWithModels(models: string[]): AgentCapabilities {
  return {
    ...DEFAULT_CAPABILITIES,
    models,
  };
}

export function capabilitiesWithPlugin(plugin: {
  name: string;
  commands: string[];
  capabilities?: string[];
}): AgentCapabilities {
  return {
    ...DEFAULT_CAPABILITIES,
    plugins: [
      {
        name: plugin.name,
        commands: plugin.commands,
        capabilities: plugin.capabilities ?? plugin.commands,
      },
    ],
  };
}

export async function connectAgent(
  userId: string,
  capabilities: AgentCapabilities = DEFAULT_CAPABILITIES,
  options: AgentConnectOptions = {}
): Promise<{ relay: DurableObjectStub; ws: WebSocket; agentId: string }> {
  const relay = getRelay(userId);
  const response = await relay.fetch(
    new Request('https://relay/agent', {
      headers: {
        Upgrade: 'websocket',
        'X-User-Id': userId,
      },
    })
  );
  if (response.status !== 101 || !response.webSocket) {
    throw new Error(`Expected 101 websocket upgrade, got ${response.status}`);
  }

  const ws = response.webSocket;
  ws.accept();
  ensureWebSocketBuffer(ws);

  ws.send(
    JSON.stringify({
      type: 'auth',
      device_id: options.deviceId ?? `test-device-${crypto.randomUUID()}`,
      device_name: options.deviceName ?? 'Test Agent',
      version: '1.0.0',
      capabilities,
      system: options.system,
      runtime: options.runtime,
      capacity: options.capacity,
      availability: options.availability,
    })
  );

  const auth = await waitForWebSocketJson<AuthResultPayload>(ws);
  if (auth.type !== 'auth_result' || !auth.success) {
    throw new Error('Agent authentication failed in test helper');
  }

  return { relay, ws, agentId: auth.agent_id };
}

export async function submitJob(
  relay: DurableObjectStub,
  userId: string,
  request: SubmitJobRequest
): Promise<Response> {
  return relay.fetch(
    new Request('https://relay/internal/submit', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-User-Id': userId,
      },
      body: JSON.stringify({
        ...request,
        client_id: `client_${userId.slice(-8)}`,
        relay_origin: 'https://relay',
      }),
    })
  );
}

export async function submitChat(
  relay: DurableObjectStub,
  userId: string,
  request: SubmitChatRequest
): Promise<Response> {
  return relay.fetch(
    new Request('https://relay/internal/chat/submit', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-User-Id': userId,
      },
      body: JSON.stringify({
        ...request,
        client_id: `client_${userId.slice(-8)}`,
      }),
    })
  );
}

export async function submitTalk(
  relay: DurableObjectStub,
  userId: string,
  request: SubmitTalkRequest
): Promise<Response> {
  return relay.fetch(
    new Request('https://relay/internal/talk/submit', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-User-Id': userId,
      },
      body: JSON.stringify({
        ...request,
        client_id: `client_${userId.slice(-8)}`,
        relay_origin: 'https://relay',
      }),
    })
  );
}

export async function submitAsr(
  relay: DurableObjectStub,
  userId: string,
  request: SubmitAsrRequest
): Promise<Response> {
  return relay.fetch(
    new Request('https://relay/internal/asr/submit', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-User-Id': userId,
      },
      body: JSON.stringify({
        ...request,
        client_id: `client_${userId.slice(-8)}`,
      }),
    })
  );
}

export async function submitEmbed(
  relay: DurableObjectStub,
  userId: string,
  request: SubmitEmbedRequest
): Promise<Response> {
  return relay.fetch(
    new Request('https://relay/internal/embed/submit', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-User-Id': userId,
      },
      body: JSON.stringify({
        ...request,
        client_id: `client_${userId.slice(-8)}`,
      }),
    })
  );
}

export async function submitOcr(
  relay: DurableObjectStub,
  userId: string,
  request: SubmitOcrRequest
): Promise<Response> {
  return relay.fetch(
    new Request('https://relay/internal/ocr/submit', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-User-Id': userId,
      },
      body: JSON.stringify({
        ...request,
        client_id: `client_${userId.slice(-8)}`,
      }),
    })
  );
}

export async function submitTool(
  relay: DurableObjectStub,
  userId: string,
  request: SubmitToolRequest
): Promise<Response> {
  return relay.fetch(
    new Request('https://relay/internal/tool/submit', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-User-Id': userId,
      },
      body: JSON.stringify({
        ...request,
        client_id: `client_${userId.slice(-8)}`,
        relay_origin: 'https://relay',
      }),
    })
  );
}

export async function readJson<T>(response: Response): Promise<T> {
  const value: unknown = await response.json();
  return value as T;
}

export async function waitForWebSocketMessage(ws: WebSocket, timeoutMs = 2_000): Promise<string> {
  ensureWebSocketBuffer(ws);
  const queue = wsMessageQueues.get(ws);
  if (queue && queue.length > 0) {
    return queue.shift() as string;
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      const waiters = wsWaiters.get(ws);
      if (waiters) {
        const index = waiters.findIndex((waiter) => waiter.resolve === resolve);
        if (index >= 0) {
          waiters.splice(index, 1);
        }
      }
      reject(new Error(`Timed out waiting for websocket message after ${timeoutMs}ms`));
    }, timeoutMs);

    const waiters = wsWaiters.get(ws);
    if (!waiters) {
      clearTimeout(timeout);
      reject(new Error('WebSocket waiter state was not initialized'));
      return;
    }
    waiters.push({ resolve, reject, timeout });
  });
}

export async function waitForWebSocketJson<T = Record<string, unknown>>(
  ws: WebSocket,
  timeoutMs = 2_000
): Promise<T> {
  const raw = await waitForWebSocketMessage(ws, timeoutMs);
  return JSON.parse(raw) as T;
}

export function closeWebSocket(ws: WebSocket): void {
  try {
    ws.close(1000, 'test complete');
  } catch {
    // ignore
  }
}
