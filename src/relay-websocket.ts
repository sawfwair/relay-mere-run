import type {
  AgentInfo,
  AuthMessage,
  ProgressMessage,
  ResultMessage,
  ChatResponseMessage,
  ChatErrorMessage,
  TalkResponseMessage,
  TalkErrorMessage,
  AsrResponseMessage,
  AsrErrorMessage,
  EmbedResponseMessage,
  EmbedErrorMessage,
  OcrResponseMessage,
  OcrErrorMessage,
  ToolProgressMessage,
  ToolResultMessage,
  ToolErrorMessage,
  PingMessage,
  GraphEventMessage,
  GraphResultMessage,
  GraphErrorMessage,
  InventoryUpdateMessage,
  AvailabilityUpdateMessage,
  ModelPlanEventMessage,
  ModelPlanResultMessage,
  AsrStreamEventMessage,
} from './types';
import type { WebSocketAttachment } from './relay-context';
import { agentMessageSchema } from './contracts/agent';
import { parseJson } from './json';

export interface RelayWebSocketHandlers {
  handleAuth(ws: WebSocket, msg: AuthMessage): Promise<void>;
  handleProgress(msg: ProgressMessage): Promise<void>;
  handleResult(msg: ResultMessage): Promise<void>;
  handlePing(ws: WebSocket, msg: PingMessage): Promise<void>;
  handleInventoryUpdate(ws: WebSocket, msg: InventoryUpdateMessage): Promise<void>;
  handleAvailabilityUpdate(ws: WebSocket, msg: AvailabilityUpdateMessage): Promise<void>;
  handleChatResponse(msg: ChatResponseMessage): Promise<void>;
  handleChatError(msg: ChatErrorMessage): Promise<void>;
  handleTalkResponse(msg: TalkResponseMessage): Promise<void>;
  handleTalkError(msg: TalkErrorMessage): Promise<void>;
  handleAsrResponse(msg: AsrResponseMessage): Promise<void>;
  handleAsrError(msg: AsrErrorMessage): Promise<void>;
  handleEmbedResponse(msg: EmbedResponseMessage): Promise<void>;
  handleEmbedError(msg: EmbedErrorMessage): Promise<void>;
  handleOcrResponse(msg: OcrResponseMessage): Promise<void>;
  handleOcrError(msg: OcrErrorMessage): Promise<void>;
  handleToolProgress(msg: ToolProgressMessage): Promise<void>;
  handleToolResult(msg: ToolResultMessage): Promise<void>;
  handleToolError(msg: ToolErrorMessage): Promise<void>;
  handleGraphEvent(msg: GraphEventMessage, agentId: string | null): Promise<void>;
  handleGraphResult(msg: GraphResultMessage, agentId: string | null): Promise<void>;
  handleGraphError(msg: GraphErrorMessage, agentId: string | null): Promise<void>;
  handleModelPlanEvent(msg: ModelPlanEventMessage, agentId: string | null): Promise<void>;
  handleModelPlanResult(msg: ModelPlanResultMessage, agentId: string | null): Promise<void>;
  handleAsrStreamEvent(msg: AsrStreamEventMessage): Promise<void>;
  getAttachment(ws: WebSocket): WebSocketAttachment | null;
  failInProgressWorkForAgent(info: AgentInfo, reason: string): Promise<void>;
  markAgentOffline(info: AgentInfo): Promise<void>;
  assignQueuedWork(): Promise<void>;
  closeAsrSessionsForAgent(agentId: string): void;
}

export async function handleRelayWebSocketMessage(
  handlers: RelayWebSocketHandlers,
  ws: WebSocket,
  message: string | ArrayBuffer
): Promise<void> {
  if (typeof message !== 'string') return;
  if (handlers.getAttachment(ws)?.superseded) return;

  try {
    const msg = parseJson(message, agentMessageSchema);

    switch (msg.type) {
      case 'auth':
        await handlers.handleAuth(ws, msg);
        break;
      case 'progress':
        await handlers.handleProgress(msg);
        break;
      case 'result':
        await handlers.handleResult(msg);
        break;
      case 'ping':
        await handlers.handlePing(ws, msg);
        break;
      case 'inventory_update':
        await handlers.handleInventoryUpdate(ws, msg);
        break;
      case 'availability_update':
        await handlers.handleAvailabilityUpdate(ws, msg);
        break;
      case 'chat_response':
        await handlers.handleChatResponse(msg);
        break;
      case 'chat_error':
        await handlers.handleChatError(msg);
        break;
      case 'talk_response':
        await handlers.handleTalkResponse(msg);
        break;
      case 'talk_error':
        await handlers.handleTalkError(msg);
        break;
      case 'asr_response':
        await handlers.handleAsrResponse(msg);
        break;
      case 'asr_error':
        await handlers.handleAsrError(msg);
        break;
      case 'embed_response':
        await handlers.handleEmbedResponse(msg);
        break;
      case 'embed_error':
        await handlers.handleEmbedError(msg);
        break;
      case 'ocr_response':
        await handlers.handleOcrResponse(msg);
        break;
      case 'ocr_error':
        await handlers.handleOcrError(msg);
        break;
      case 'tool_progress':
        await handlers.handleToolProgress(msg);
        break;
      case 'tool_result':
        await handlers.handleToolResult(msg);
        break;
      case 'tool_error':
        await handlers.handleToolError(msg);
        break;
      case 'graph_event':
        await handlers.handleGraphEvent(msg, handlers.getAttachment(ws)?.agentId ?? null);
        break;
      case 'graph_result':
        await handlers.handleGraphResult(msg, handlers.getAttachment(ws)?.agentId ?? null);
        break;
      case 'graph_error':
        await handlers.handleGraphError(msg, handlers.getAttachment(ws)?.agentId ?? null);
        break;
      case 'model_plan_event':
        await handlers.handleModelPlanEvent(msg, handlers.getAttachment(ws)?.agentId ?? null);
        break;
      case 'model_plan_result':
        await handlers.handleModelPlanResult(msg, handlers.getAttachment(ws)?.agentId ?? null);
        break;
      case 'asr_stream_event':
        await handlers.handleAsrStreamEvent(msg);
        break;
    }
  } catch (error) {
    console.error('WebSocket message error:', error);
  }
}

export async function handleRelayWebSocketClose(
  handlers: RelayWebSocketHandlers,
  ws: WebSocket
): Promise<void> {
  const attachment = handlers.getAttachment(ws);
  if (!attachment) return;

  if (attachment.superseded) {
    console.log(`Superseded agent ${attachment.agentId} connection closed`);
    return;
  }

  const { agentId, info } = attachment;

  handlers.closeAsrSessionsForAgent(agentId);
  await handlers.failInProgressWorkForAgent(info, 'Agent disconnected');
  await handlers.markAgentOffline(info);
  console.log(`Agent ${agentId} disconnected`);
  await handlers.assignQueuedWork();
}
