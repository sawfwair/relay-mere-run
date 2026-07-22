import type {
  ResultMessage,
  SubmitJobRequest,
  SubmitChatRequest,
  SubmitTalkRequest,
  SubmitAsrRequest,
  SubmitEmbedRequest,
  SubmitOcrRequest,
  SubmitToolRequest,
  TalkResponseMessage,
  TalkErrorMessage,
  AsrResponseMessage,
  AsrErrorMessage,
  EmbedResponseMessage,
  EmbedErrorMessage,
  OcrResponseMessage,
  OcrErrorMessage,
  ToolResultMessage,
  ToolErrorMessage,
  SubmitGraphJobRequest,
  GraphEventMessage,
  GraphResultMessage,
  GraphErrorMessage,
} from './types';
import { invalidJsonResponse, readRequestJson } from './json';
import {
  graphErrorMessageSchema,
  graphEventMessageSchema,
  graphResultMessageSchema,
  submitGraphJobRequestSchema,
} from './contracts/graph';
import {
  asrErrorMessageSchema,
  asrResponseMessageSchema,
  embedErrorMessageSchema,
  embedResponseMessageSchema,
  ocrErrorMessageSchema,
  ocrResponseMessageSchema,
  resultMessageSchema,
  talkErrorMessageSchema,
  talkResponseMessageSchema,
  toolErrorMessageSchema,
  toolResultMessageSchema,
} from './contracts/messages';
import {
  submitAsrInternalSchema,
  submitChatInternalSchema,
  submitEmbedInternalSchema,
  submitJobInternalSchema,
  submitOcrInternalSchema,
  submitTalkInternalSchema,
  submitToolInternalSchema,
} from './contracts/requests';

export interface RelayRouteHandlers {
  acceptAgentWebSocket(request: Request): Response;
  getRequestUserId(request: Request): string;
  handleStatus(): Promise<Response>;
  handleFleetSnapshot(): Promise<Response>;
  handleUpdateFleetSettings(request: Request): Promise<Response>;
  handleUpdateFleetNode(deviceId: string, request: Request): Promise<Response>;
  handleRefreshFleetNode(deviceId: string): Promise<Response>;
  handleCreateFleetModelPlan(request: Request): Promise<Response>;
  handleListFleetModelPlans(limit: number): Promise<Response>;
  handleGetFleetModelPlan(planId: string): Promise<Response>;
  handleApplyFleetModelPlan(planId: string, request: Request): Promise<Response>;
  handleCancelFleetModelPlan(planId: string): Promise<Response>;
  handleResult(msg: ResultMessage): Promise<void>;
  handleTalkResponse(msg: TalkResponseMessage): Promise<void>;
  handleTalkError(msg: TalkErrorMessage): Promise<void>;
  handleAsrResponse(msg: AsrResponseMessage): Promise<void>;
  handleAsrError(msg: AsrErrorMessage): Promise<void>;
  handleEmbedResponse(msg: EmbedResponseMessage): Promise<void>;
  handleEmbedError(msg: EmbedErrorMessage): Promise<void>;
  handleOcrResponse(msg: OcrResponseMessage): Promise<void>;
  handleOcrError(msg: OcrErrorMessage): Promise<void>;
  handleToolResult(msg: ToolResultMessage): Promise<void>;
  handleToolError(msg: ToolErrorMessage): Promise<void>;
  handleSubmitJob(
    request: SubmitJobRequest & { client_id: string; relay_origin?: string },
    userId: string
  ): Promise<Response>;
  handleDeleteJobImage(jobId: string): Promise<Response>;
  handleGetJob(jobId: string): Promise<Response>;
  handleCancelJob(jobId: string): Promise<Response>;
  handleImageUpload(jobId: string, request: Request): Promise<Response>;
  handleSubmitChat(
    request: SubmitChatRequest & { client_id: string },
    userId: string
  ): Promise<Response>;
  handleGetChat(chatId: string): Promise<Response>;
  handleSubmitTalk(
    request: SubmitTalkRequest & { client_id: string; relay_origin?: string },
    userId: string
  ): Promise<Response>;
  handleGetTalk(talkId: string): Promise<Response>;
  handleCancelTalk(talkId: string): Promise<Response>;
  handleDeleteTalkAudio(talkId: string): Promise<Response>;
  handleAudioUpload(talkId: string, request: Request): Promise<Response>;
  handleSubmitAsr(
    request: SubmitAsrRequest & { client_id: string },
    userId: string
  ): Promise<Response>;
  handleGetAsr(asrId: string): Promise<Response>;
  handleCancelAsr(asrId: string): Promise<Response>;
  handleSubmitEmbed(
    request: SubmitEmbedRequest & { client_id: string },
    userId: string
  ): Promise<Response>;
  handleGetEmbed(embedId: string): Promise<Response>;
  handleCancelEmbed(embedId: string): Promise<Response>;
  handleSubmitOcr(
    request: SubmitOcrRequest & { client_id: string },
    userId: string
  ): Promise<Response>;
  handleGetOcr(ocrId: string): Promise<Response>;
  handleCancelOcr(ocrId: string): Promise<Response>;
  handleSubmitTool(
    request: SubmitToolRequest & { client_id: string; relay_origin?: string },
    userId: string
  ): Promise<Response>;
  handleGetTool(toolId: string): Promise<Response>;
  handleCancelTool(toolId: string): Promise<Response>;
  handleToolUpload(toolId: string, artifactName: string, request: Request): Promise<Response>;
  handleCreateGraphJob(request: SubmitGraphJobRequest, userId: string, origin: string): Promise<Response>;
  handleUploadGraphAsset(jobId: string, digest: string, request: Request): Promise<Response>;
  handleCommitGraphJob(jobId: string): Promise<Response>;
  handleGetGraphJob(jobId: string): Promise<Response>;
  handleListGraphJobs(limit: number): Promise<Response>;
  handlePreflightGraphJob(request: SubmitGraphJobRequest): Response;
  handleGraphEvents(jobId: string): Promise<Response>;
  handleCancelGraphJob(jobId: string): Promise<Response>;
  handleRetryGraphJob(jobId: string): Promise<Response>;
  handleGraphEvent(message: GraphEventMessage): Promise<void>;
  handleGraphResult(message: GraphResultMessage): Promise<void>;
  handleGraphError(message: GraphErrorMessage): Promise<void>;
  handleGraphNodeRequest(jobId: string, token: string, action: string, request: Request): Promise<Response>;
  handleGetGraphRunManifest(jobId: string): Promise<Response>;
  handleGetGraphArtifact(jobId: string, name: string): Promise<Response>;
  handleGraphCapabilities(): Promise<Response>;
  handleGraphTelemetry(): Promise<Response>;
}

export async function handleRelayFetch(
  handlers: RelayRouteHandlers,
  request: Request
): Promise<Response> {
  try {
    return await handleRelayFetchUnchecked(handlers, request);
  } catch (error) {
    const response = invalidJsonResponse(error);
    if (response) return response;
    throw error;
  }
}

async function handleRelayFetchUnchecked(
  handlers: RelayRouteHandlers,
  request: Request
): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === '/agent' || url.pathname === '/zero-agent') {
    return handlers.acceptAgentWebSocket(request);
  }

  if (url.pathname === '/internal/status') {
    return handlers.handleStatus();
  }

  if (url.pathname === '/internal/fleet' && request.method === 'GET') {
    return handlers.handleFleetSnapshot();
  }

  if (url.pathname === '/internal/fleet/settings' && request.method === 'PATCH') {
    return handlers.handleUpdateFleetSettings(request);
  }

  const fleetNodeMatch = url.pathname.match(/^\/internal\/fleet\/nodes\/([^/]+)$/);
  if (fleetNodeMatch && request.method === 'PATCH') {
    return handlers.handleUpdateFleetNode(decodeURIComponent(fleetNodeMatch[1]), request);
  }

  const fleetNodeRefreshMatch = url.pathname.match(/^\/internal\/fleet\/nodes\/([^/]+)\/refresh$/);
  if (fleetNodeRefreshMatch && request.method === 'POST') {
    return handlers.handleRefreshFleetNode(decodeURIComponent(fleetNodeRefreshMatch[1]));
  }

  if (url.pathname === '/internal/fleet/model-plans' && request.method === 'POST') {
    return handlers.handleCreateFleetModelPlan(request);
  }
  if (url.pathname === '/internal/fleet/model-plans' && request.method === 'GET') {
    const limit = Number.parseInt(url.searchParams.get('limit') ?? '50', 10);
    return handlers.handleListFleetModelPlans(Number.isFinite(limit) ? limit : 50);
  }
  const fleetModelPlanApplyMatch = url.pathname.match(/^\/internal\/fleet\/model-plans\/([^/]+)\/apply$/);
  if (fleetModelPlanApplyMatch && request.method === 'POST') {
    return handlers.handleApplyFleetModelPlan(
      decodeURIComponent(fleetModelPlanApplyMatch[1]),
      request
    );
  }
  const fleetModelPlanMatch = url.pathname.match(/^\/internal\/fleet\/model-plans\/([^/]+)$/);
  if (fleetModelPlanMatch && request.method === 'GET') {
    return handlers.handleGetFleetModelPlan(decodeURIComponent(fleetModelPlanMatch[1]));
  }
  if (fleetModelPlanMatch && request.method === 'DELETE') {
    return handlers.handleCancelFleetModelPlan(decodeURIComponent(fleetModelPlanMatch[1]));
  }

  if (url.pathname === '/internal/result' && request.method === 'POST') {
    const msg = await readRequestJson(request, resultMessageSchema);
    await handlers.handleResult(msg);
    return new Response('OK');
  }

  if (url.pathname === '/internal/talk-response' && request.method === 'POST') {
    const msg = await readRequestJson(request, talkResponseMessageSchema);
    await handlers.handleTalkResponse(msg);
    return new Response('OK');
  }

  if (url.pathname === '/internal/talk-error' && request.method === 'POST') {
    const msg = await readRequestJson(request, talkErrorMessageSchema);
    await handlers.handleTalkError(msg);
    return new Response('OK');
  }

  if (url.pathname === '/internal/asr-response' && request.method === 'POST') {
    const msg = await readRequestJson(request, asrResponseMessageSchema);
    await handlers.handleAsrResponse(msg);
    return new Response('OK');
  }

  if (url.pathname === '/internal/asr-error' && request.method === 'POST') {
    const msg = await readRequestJson(request, asrErrorMessageSchema);
    await handlers.handleAsrError(msg);
    return new Response('OK');
  }

  if (url.pathname === '/internal/embed-response' && request.method === 'POST') {
    const msg = await readRequestJson(request, embedResponseMessageSchema);
    await handlers.handleEmbedResponse(msg);
    return new Response('OK');
  }

  if (url.pathname === '/internal/embed-error' && request.method === 'POST') {
    const msg = await readRequestJson(request, embedErrorMessageSchema);
    await handlers.handleEmbedError(msg);
    return new Response('OK');
  }

  if (url.pathname === '/internal/ocr-response' && request.method === 'POST') {
    const msg = await readRequestJson(request, ocrResponseMessageSchema);
    await handlers.handleOcrResponse(msg);
    return new Response('OK');
  }

  if (url.pathname === '/internal/ocr-error' && request.method === 'POST') {
    const msg = await readRequestJson(request, ocrErrorMessageSchema);
    await handlers.handleOcrError(msg);
    return new Response('OK');
  }

  if (url.pathname === '/internal/tool-result' && request.method === 'POST') {
    const msg = await readRequestJson(request, toolResultMessageSchema);
    await handlers.handleToolResult(msg);
    return new Response('OK');
  }

  if (url.pathname === '/internal/tool-error' && request.method === 'POST') {
    const msg = await readRequestJson(request, toolErrorMessageSchema);
    await handlers.handleToolError(msg);
    return new Response('OK');
  }

  if (url.pathname === '/internal/graph-event' && request.method === 'POST') {
    const message = await readRequestJson(request, graphEventMessageSchema);
    await handlers.handleGraphEvent(message);
    return new Response('OK');
  }

  if (url.pathname === '/internal/graph-result' && request.method === 'POST') {
    const message = await readRequestJson(request, graphResultMessageSchema);
    await handlers.handleGraphResult(message);
    return new Response('OK');
  }

  if (url.pathname === '/internal/graph-error' && request.method === 'POST') {
    const message = await readRequestJson(request, graphErrorMessageSchema);
    await handlers.handleGraphError(message);
    return new Response('OK');
  }

  if (url.pathname === '/internal/graph-jobs/capabilities' && request.method === 'GET') {
    return handlers.handleGraphCapabilities();
  }
  if (url.pathname === '/internal/graph-jobs/telemetry' && request.method === 'GET') {
    return handlers.handleGraphTelemetry();
  }

  if (url.pathname === '/internal/graph-jobs/preflight' && request.method === 'POST') {
    const body = await readRequestJson(request, submitGraphJobRequestSchema);
    return handlers.handlePreflightGraphJob(body);
  }

  if (url.pathname === '/internal/graph-jobs' && request.method === 'POST') {
    const body = await readRequestJson(request, submitGraphJobRequestSchema);
    return handlers.handleCreateGraphJob(body, handlers.getRequestUserId(request), url.origin);
  }

  if (url.pathname === '/internal/graph-jobs' && request.method === 'GET') {
    return handlers.handleListGraphJobs(Number(url.searchParams.get('limit') || 50));
  }

  const graphAssetMatch = url.pathname.match(/^\/internal\/graph-jobs\/([^/]+)\/assets\/([a-f0-9]{64})$/);
  if (graphAssetMatch && request.method === 'PUT') {
    return handlers.handleUploadGraphAsset(graphAssetMatch[1], graphAssetMatch[2], request);
  }

  const graphCommitMatch = url.pathname.match(/^\/internal\/graph-jobs\/([^/]+)\/commit$/);
  if (graphCommitMatch && request.method === 'POST') return handlers.handleCommitGraphJob(graphCommitMatch[1]);

  const graphEventsMatch = url.pathname.match(/^\/internal\/graph-jobs\/([^/]+)\/events$/);
  if (graphEventsMatch && request.method === 'GET') return handlers.handleGraphEvents(graphEventsMatch[1]);

  const graphRetryMatch = url.pathname.match(/^\/internal\/graph-jobs\/([^/]+)\/retry$/);
  if (graphRetryMatch && request.method === 'POST') return handlers.handleRetryGraphJob(graphRetryMatch[1]);

  const graphManifestMatch = url.pathname.match(/^\/internal\/graph-jobs\/([^/]+)\/run-manifest$/);
  if (graphManifestMatch && request.method === 'GET') return handlers.handleGetGraphRunManifest(graphManifestMatch[1]);

  const graphArtifactMatch = url.pathname.match(/^\/internal\/graph-jobs\/([^/]+)\/artifacts\/([^/]+)$/);
  if (graphArtifactMatch && request.method === 'GET') {
    return handlers.handleGetGraphArtifact(graphArtifactMatch[1], decodeURIComponent(graphArtifactMatch[2]));
  }

  const graphMatch = url.pathname.match(/^\/internal\/graph-jobs\/([^/]+)$/);
  if (graphMatch && request.method === 'GET') return handlers.handleGetGraphJob(graphMatch[1]);
  if (graphMatch && request.method === 'DELETE') return handlers.handleCancelGraphJob(graphMatch[1]);

  const graphNodeMatch = url.pathname.match(/^\/internal\/graph-node\/([^/]+)\/([^/]+)\/(.+)$/);
  if (graphNodeMatch) {
    return handlers.handleGraphNodeRequest(graphNodeMatch[1], graphNodeMatch[2], graphNodeMatch[3], request);
  }

  if (url.pathname === '/internal/submit' && request.method === 'POST') {
    const body = await readRequestJson(request, submitJobInternalSchema);
    return handlers.handleSubmitJob(body, handlers.getRequestUserId(request));
  }

  const deleteImageMatch = url.pathname.match(/^\/internal\/job\/([^/]+)\/image$/);
  if (deleteImageMatch && request.method === 'DELETE') {
    return handlers.handleDeleteJobImage(deleteImageMatch[1]);
  }

  const jobMatch = url.pathname.match(/^\/internal\/job\/([^/]+)$/);
  if (jobMatch && request.method === 'GET') {
    return handlers.handleGetJob(jobMatch[1]);
  }
  if (jobMatch && request.method === 'DELETE') {
    return handlers.handleCancelJob(jobMatch[1]);
  }

  const uploadMatch = url.pathname.match(/^\/internal\/upload\/([^/]+)$/);
  if (uploadMatch && request.method === 'POST') {
    return handlers.handleImageUpload(uploadMatch[1], request);
  }

  const toolUploadMatch = url.pathname.match(/^\/internal\/tool-upload\/([^/]+)\/([^/]+)$/);
  if (toolUploadMatch && request.method === 'POST') {
    return handlers.handleToolUpload(toolUploadMatch[1], decodeURIComponent(toolUploadMatch[2]), request);
  }

  if (url.pathname === '/internal/chat/submit' && request.method === 'POST') {
    const body = await readRequestJson(request, submitChatInternalSchema);
    return handlers.handleSubmitChat(body, handlers.getRequestUserId(request));
  }

  const chatMatch = url.pathname.match(/^\/internal\/chat\/([^/]+)$/);
  if (chatMatch && request.method === 'GET') {
    return handlers.handleGetChat(chatMatch[1]);
  }

  if (url.pathname === '/internal/talk/submit' && request.method === 'POST') {
    const body = await readRequestJson(request, submitTalkInternalSchema);
    return handlers.handleSubmitTalk(body, handlers.getRequestUserId(request));
  }

  const talkMatch = url.pathname.match(/^\/internal\/talk\/([^/]+)$/);
  if (talkMatch && request.method === 'GET') {
    return handlers.handleGetTalk(talkMatch[1]);
  }
  if (talkMatch && request.method === 'DELETE') {
    return handlers.handleCancelTalk(talkMatch[1]);
  }

  const deleteTalkAudioMatch = url.pathname.match(/^\/internal\/talk\/([^/]+)\/audio$/);
  if (deleteTalkAudioMatch && request.method === 'DELETE') {
    return handlers.handleDeleteTalkAudio(deleteTalkAudioMatch[1]);
  }

  const audioUploadMatch = url.pathname.match(/^\/internal\/audio-upload\/([^/]+)$/);
  if (audioUploadMatch && request.method === 'POST') {
    return handlers.handleAudioUpload(audioUploadMatch[1], request);
  }

  if (url.pathname === '/internal/asr/submit' && request.method === 'POST') {
    const body = await readRequestJson(request, submitAsrInternalSchema);
    return handlers.handleSubmitAsr(body, handlers.getRequestUserId(request));
  }

  const asrMatch = url.pathname.match(/^\/internal\/asr\/([^/]+)$/);
  if (asrMatch && request.method === 'GET') {
    return handlers.handleGetAsr(asrMatch[1]);
  }
  if (asrMatch && request.method === 'DELETE') {
    return handlers.handleCancelAsr(asrMatch[1]);
  }

  if (url.pathname === '/internal/embed/submit' && request.method === 'POST') {
    const body = await readRequestJson(request, submitEmbedInternalSchema);
    return handlers.handleSubmitEmbed(body, handlers.getRequestUserId(request));
  }

  const embedMatch = url.pathname.match(/^\/internal\/embed\/([^/]+)$/);
  if (embedMatch && request.method === 'GET') {
    return handlers.handleGetEmbed(embedMatch[1]);
  }
  if (embedMatch && request.method === 'DELETE') {
    return handlers.handleCancelEmbed(embedMatch[1]);
  }

  if (url.pathname === '/internal/ocr/submit' && request.method === 'POST') {
    const body = await readRequestJson(request, submitOcrInternalSchema);
    return handlers.handleSubmitOcr(body, handlers.getRequestUserId(request));
  }

  const ocrMatch = url.pathname.match(/^\/internal\/ocr\/([^/]+)$/);
  if (ocrMatch && request.method === 'GET') {
    return handlers.handleGetOcr(ocrMatch[1]);
  }
  if (ocrMatch && request.method === 'DELETE') {
    return handlers.handleCancelOcr(ocrMatch[1]);
  }

  if (url.pathname === '/internal/tool/submit' && request.method === 'POST') {
    const body = await readRequestJson(request, submitToolInternalSchema);
    return handlers.handleSubmitTool(body, handlers.getRequestUserId(request));
  }

  const toolMatch = url.pathname.match(/^\/internal\/tool\/([^/]+)$/);
  if (toolMatch && request.method === 'GET') {
    return handlers.handleGetTool(toolMatch[1]);
  }
  if (toolMatch && request.method === 'DELETE') {
    return handlers.handleCancelTool(toolMatch[1]);
  }

  return new Response('Not Found', { status: 404 });
}
