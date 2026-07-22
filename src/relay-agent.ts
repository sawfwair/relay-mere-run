import type { RelayContext } from './relay-context';
import type { RelayWebSocketHandlers } from './relay-websocket';
import type {
  AgentInfo,
  AvailabilityUpdateMessage,
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
  ModelPlanEventMessage,
  ModelPlanResultMessage,
  AsrStreamEventMessage,
} from './types';
import { getWebSocketAttachment } from './relay-lifecycle';
export { handleAuth, handleAvailabilityUpdate, handleInventoryUpdate, handlePing } from './relay-agent-auth';
export { handleProgress, handleResult } from './relay-agent-job';
export { handleChatResponse, handleChatError } from './relay-agent-chat';
export {
  handleTalkResponse,
  handleTalkError,
  handleAsrResponse,
  handleAsrError,
} from './relay-agent-speech';
export {
  handleEmbedResponse,
  handleEmbedError,
  handleOcrResponse,
  handleOcrError,
} from './relay-agent-analysis';
export { handleToolProgress, handleToolResult, handleToolError } from './relay-agent-tool';
import { handleAuth, handleAvailabilityUpdate, handleInventoryUpdate, handlePing } from './relay-agent-auth';
import { handleProgress, handleResult } from './relay-agent-job';
import { handleChatResponse, handleChatError } from './relay-agent-chat';
import {
  handleTalkResponse,
  handleTalkError,
  handleAsrResponse,
  handleAsrError,
} from './relay-agent-speech';
import {
  handleEmbedResponse,
  handleEmbedError,
  handleOcrResponse,
  handleOcrError,
} from './relay-agent-analysis';
import {
  handleToolProgress,
  handleToolResult,
  handleToolError,
} from './relay-agent-tool';
import { markAgentOffline } from './relay-fleet';
import { handleGraphError, handleGraphEvent, handleGraphResult } from './relay-api-graph';
import { handleFleetModelPlanEvent, handleFleetModelPlanResult } from './relay-model-plans';
import { closeAsrSessionsForAgent, handleNodeAsrStreamEvent } from './relay-asr-stream';

export function createRelayWebSocketHandlers(ctx: RelayContext): RelayWebSocketHandlers {
  return {
    handleAuth: (ws: WebSocket, msg: AuthMessage) => handleAuth(ctx, ws, msg),
    handleProgress: (msg: ProgressMessage) => handleProgress(ctx, msg),
    handleResult: (msg: ResultMessage) => handleResult(ctx, msg),
    handlePing: (ws: WebSocket, msg: PingMessage) =>
      handlePing(ctx, ws, msg),
    handleInventoryUpdate: (ws: WebSocket, msg: InventoryUpdateMessage) =>
      handleInventoryUpdate(ctx, ws, msg),
    handleAvailabilityUpdate: (ws: WebSocket, msg: AvailabilityUpdateMessage) =>
      handleAvailabilityUpdate(ctx, ws, msg),
    handleChatResponse: (msg: ChatResponseMessage) => handleChatResponse(ctx, msg),
    handleChatError: (msg: ChatErrorMessage) => handleChatError(ctx, msg),
    handleTalkResponse: (msg: TalkResponseMessage) => handleTalkResponse(ctx, msg),
    handleTalkError: (msg: TalkErrorMessage) => handleTalkError(ctx, msg),
    handleAsrResponse: (msg: AsrResponseMessage) => handleAsrResponse(ctx, msg),
    handleAsrError: (msg: AsrErrorMessage) => handleAsrError(ctx, msg),
    handleEmbedResponse: (msg: EmbedResponseMessage) => handleEmbedResponse(ctx, msg),
    handleEmbedError: (msg: EmbedErrorMessage) => handleEmbedError(ctx, msg),
    handleOcrResponse: (msg: OcrResponseMessage) => handleOcrResponse(ctx, msg),
    handleOcrError: (msg: OcrErrorMessage) => handleOcrError(ctx, msg),
    handleToolProgress: (msg: ToolProgressMessage) => handleToolProgress(ctx, msg),
    handleToolResult: (msg: ToolResultMessage) => handleToolResult(ctx, msg),
    handleToolError: (msg: ToolErrorMessage) => handleToolError(ctx, msg),
    handleGraphEvent: (msg: GraphEventMessage, agentId: string | null) => handleGraphEvent(ctx, msg, agentId),
    handleGraphResult: (msg: GraphResultMessage, agentId: string | null) => handleGraphResult(ctx, msg, agentId),
    handleGraphError: (msg: GraphErrorMessage, agentId: string | null) => handleGraphError(ctx, msg, agentId),
    handleModelPlanEvent: (msg: ModelPlanEventMessage, agentId: string | null) =>
      handleFleetModelPlanEvent(ctx, msg, agentId),
    handleModelPlanResult: (msg: ModelPlanResultMessage, agentId: string | null) =>
      handleFleetModelPlanResult(ctx, msg, agentId),
    handleAsrStreamEvent: (msg: AsrStreamEventMessage) => handleNodeAsrStreamEvent(ctx, msg),
    getAttachment: (ws: WebSocket) => getWebSocketAttachment(ws),
    failInProgressWorkForAgent: (info: AgentInfo, reason: string) =>
      ctx.failInProgressWorkForAgent(info, reason),
    markAgentOffline: (info: AgentInfo) => markAgentOffline(ctx, info),
    assignQueuedWork: () => ctx.assignQueuedWork(),
    closeAsrSessionsForAgent: (agentId: string) => closeAsrSessionsForAgent(ctx, agentId),
  };
}
