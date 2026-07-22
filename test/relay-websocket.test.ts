import { describe, expect, it, vi } from 'vitest';
import {
  handleRelayWebSocketClose,
  type RelayWebSocketHandlers,
} from '../src/relay-websocket';
import type { WebSocketAttachment } from '../src/relay-context';
import type { AgentInfo } from '../src/types';

const agentInfo: AgentInfo = {
  agent_id: 'superseded-agent',
  device_id: 'superseded-device',
  device_name: 'Superseded Device',
  version: '0.2.10',
  status: 'online',
  current_job_id: null,
  connected_at: '2026-07-22T00:00:00.000Z',
  last_ping: '2026-07-22T00:00:00.000Z',
  capabilities: {
    models: [],
    max_resolution: 0,
    controlnet: false,
    lora: false,
    img2img: false,
  },
};

interface HandlerFixture {
  handlers: RelayWebSocketHandlers;
  failInProgressWorkForAgent: ReturnType<typeof vi.fn>;
  markAgentOffline: ReturnType<typeof vi.fn>;
  assignQueuedWork: ReturnType<typeof vi.fn>;
  closeAsrSessionsForAgent: ReturnType<typeof vi.fn>;
}

function handlersFor(attachment: WebSocketAttachment): HandlerFixture {
  const noop = async (): Promise<void> => {};
  const failInProgressWorkForAgent = vi.fn(noop);
  const markAgentOffline = vi.fn(noop);
  const assignQueuedWork = vi.fn(noop);
  const closeAsrSessionsForAgent = vi.fn();
  const handlers: RelayWebSocketHandlers = {
    handleAuth: noop,
    handleProgress: noop,
    handleResult: noop,
    handlePing: noop,
    handleInventoryUpdate: noop,
    handleAvailabilityUpdate: noop,
    handleChatResponse: noop,
    handleChatError: noop,
    handleTalkResponse: noop,
    handleTalkError: noop,
    handleAsrResponse: noop,
    handleAsrError: noop,
    handleEmbedResponse: noop,
    handleEmbedError: noop,
    handleOcrResponse: noop,
    handleOcrError: noop,
    handleToolProgress: noop,
    handleToolResult: noop,
    handleToolError: noop,
    handleGraphEvent: noop,
    handleGraphResult: noop,
    handleGraphError: noop,
    handleModelPlanEvent: noop,
    handleModelPlanResult: noop,
    handleAsrStreamEvent: noop,
    getAttachment: () => attachment,
    failInProgressWorkForAgent,
    markAgentOffline,
    assignQueuedWork,
    closeAsrSessionsForAgent,
  };
  return {
    handlers,
    failInProgressWorkForAgent,
    markAgentOffline,
    assignQueuedWork,
    closeAsrSessionsForAgent,
  };
}

describe('relay WebSocket close handling', () => {
  it('does not mutate fleet or work state when a superseded connection closes', async () => {
    const pair = new WebSocketPair();
    const fixture = handlersFor({ agentId: agentInfo.agent_id, info: agentInfo, superseded: true });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await handleRelayWebSocketClose(fixture.handlers, pair[0]);

    expect(log).toHaveBeenCalledWith('Superseded agent superseded-agent connection closed');
    expect(fixture.closeAsrSessionsForAgent).not.toHaveBeenCalled();
    expect(fixture.failInProgressWorkForAgent).not.toHaveBeenCalled();
    expect(fixture.markAgentOffline).not.toHaveBeenCalled();
    expect(fixture.assignQueuedWork).not.toHaveBeenCalled();
    log.mockRestore();
  });
});
