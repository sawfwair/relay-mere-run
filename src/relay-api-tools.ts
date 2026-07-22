import {
  generateToolUploadUrlBase,
  storeToolArtifact,
} from './r2';
import type { RelayContext } from './relay-context';
import type {
  SubmitToolRequest,
  SubmitToolResponse,
  Tool,
  ToolRequest,
  ToolStatusResponse,
} from './types';
import { cancelWork } from './relay-lifecycle';
import {
  assignToolToAgent,
  getToolQueuePosition,
  hasCapableAgentForTool,
} from './relay-queue';
import { buildCancelResponse, finishSubmission } from './relay-api-common';

const DEFAULT_TOOL_PLUGIN = 'mere-animatic-tools';

function normalizeRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function normalizeToolRequest(request: SubmitToolRequest): ToolRequest {
  const command = request.command?.trim();
  if (!command) {
    throw new Error('command is required');
  }
  return {
    plugin: request.plugin?.trim() || DEFAULT_TOOL_PLUGIN,
    command,
    inputs: normalizeRecord(request.inputs),
    options: normalizeRecord(request.options),
    assets: Array.isArray(request.assets) ? request.assets : [],
  };
}

export async function handleSubmitTool(
  ctx: RelayContext,
  request: SubmitToolRequest & { client_id: string; relay_origin?: string },
  userId: string
): Promise<Response> {
  let toolRequest: ToolRequest;
  try {
    toolRequest = normalizeToolRequest(request);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid tool request';
    return Response.json({ error: message }, { status: 400 });
  }

  const toolId = `tool_${crypto.randomUUID().slice(0, 12)}`;
  const origin = request.relay_origin || 'https://relay.mere.run';
  const uploadUrlBase = generateToolUploadUrlBase(origin, userId, toolId);

  const tool: Tool = {
    tool_id: toolId,
    user_id: userId,
    client_id: request.client_id,
    agent_id: null,
    status: 'queued',
    request: toolRequest,
    progress: null,
    result: null,
    error: null,
    created_at: new Date().toISOString(),
    started_at: null,
    completed_at: null,
    upload_url_base: uploadUrlBase,
    webhook_url: request.webhook_url ?? null,
    webhook_sent: false,
  };

  await ctx.saveTool(tool);

  return finishSubmission<SubmitToolResponse>({
    ctx,
    storageKey: `tool:${toolId}`,
    removeFromMemory: () => {
      ctx.tools.delete(toolId);
    },
    assign: () => assignToolToAgent(ctx, tool, request.agent_id),
    hasCapableAgent: () => hasCapableAgentForTool(ctx, tool),
    getQueuePosition: () => getToolQueuePosition(ctx, toolId),
    buildAssignedResponse: () => ({
      tool_id: toolId,
      status: 'assigned',
      agent_id: tool.agent_id!,
      estimated_time_ms: 15000,
    }),
    buildQueuedResponse: (position) => ({
      tool_id: toolId,
      status: 'queued',
      position,
      estimated_time_ms: 15000 * (position + 1),
    }),
  });
}

export async function handleGetTool(ctx: RelayContext, toolId: string): Promise<Response> {
  const tool = await ctx.getTool(toolId);
  if (!tool) {
    return Response.json({ error: 'Tool job not found' }, { status: 404 });
  }

  const response: ToolStatusResponse = {
    tool_id: tool.tool_id,
    user_id: tool.user_id,
    client_id: tool.client_id,
    agent_id: tool.agent_id,
    status: tool.status,
    request: tool.request,
    progress: tool.progress,
    result: tool.result,
    error: tool.error,
    created_at: tool.created_at,
    started_at: tool.started_at,
    completed_at: tool.completed_at,
  };

  return Response.json(response);
}

export async function handleCancelTool(ctx: RelayContext, toolId: string): Promise<Response> {
  const tool = await ctx.getTool(toolId);
  if (!tool) {
    return Response.json({ error: 'Tool job not found' }, { status: 404 });
  }

  const outcome = await cancelWork({
    ctx,
    work: tool,
    workId: tool.tool_id,
    map: ctx.tools,
    persist: async (currentTool) => {
      await ctx.storage.put(`tool:${currentTool.tool_id}`, currentTool);
    },
    cancelMessage: { type: 'tool_cancel', tool_id: toolId },
    cancelLogLabel: `Failed to send tool cancel for ${toolId}:`,
    afterPersist: async () => {
      await ctx.scheduleToolWebhookIfNeeded(tool);
    },
    logMessage: `Tool ${tool.tool_id} cancelled`,
  });

  return buildCancelResponse<{ cancelled: boolean }>(outcome, 'Tool job already completed');
}

export async function handleToolUpload(
  ctx: RelayContext,
  toolId: string,
  artifactName: string,
  request: Request
): Promise<Response> {
  const tool = await ctx.getTool(toolId);
  if (!tool) {
    return Response.json({ error: 'Tool job not found or already completed' }, { status: 404 });
  }

  if (!tool.user_id) {
    return Response.json({ error: 'Missing user ID in tool job' }, { status: 400 });
  }

  const outputData = await request.arrayBuffer();
  if (outputData.byteLength === 0) {
    return Response.json({ error: 'Empty artifact data' }, { status: 400 });
  }

  const contentType = request.headers.get('Content-Type') || 'application/octet-stream';
  const mediaUrl = await storeToolArtifact(ctx.env, tool.user_id, toolId, artifactName, outputData, contentType);
  return Response.json({
    url: mediaUrl,
    media_url: mediaUrl,
    content_type: contentType,
    name: artifactName,
  });
}
