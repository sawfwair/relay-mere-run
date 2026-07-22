import type { RelayContext } from './relay-context';
import type {
  Embed,
  EmbedRequest,
  SubmitEmbedRequest,
  SubmitEmbedResponse,
  EmbedStatusResponse,
  CancelEmbedResponse,
  Ocr,
  OcrRequest,
  SubmitOcrRequest,
  SubmitOcrResponse,
  OcrStatusResponse,
  CancelOcrResponse,
} from './types';
import { cancelWork } from './relay-lifecycle';
import {
  assignEmbedToAgent,
  hasCapableAgentForEmbed,
  getEmbedQueuePosition,
  assignOcrToAgent,
  hasCapableAgentForOcr,
  getOcrQueuePosition,
} from './relay-queue';
import { buildCancelResponse, finishSubmission } from './relay-api-common';

export async function handleSubmitEmbed(
  ctx: RelayContext,
  request: SubmitEmbedRequest & { client_id: string },
  userId: string
): Promise<Response> {
  const embedId = `embed_${crypto.randomUUID().slice(0, 12)}`;
  const embedRequest: EmbedRequest = {
    texts: request.texts,
    model: request.model?.trim() || 'text-embed-qwen3-0.6b',
    max_tokens: request.max_tokens ?? 512,
  };

  const embed: Embed = {
    embed_id: embedId,
    user_id: userId,
    client_id: request.client_id,
    agent_id: null,
    status: 'queued',
    request: embedRequest,
    result: null,
    error: null,
    created_at: new Date().toISOString(),
    started_at: null,
    completed_at: null,
    webhook_url: request.webhook_url ?? null,
    webhook_sent: false,
  };

  await ctx.saveEmbed(embed);

  return finishSubmission<SubmitEmbedResponse>({
    ctx,
    storageKey: `embed:${embedId}`,
    removeFromMemory: () => {
      ctx.embeds.delete(embedId);
    },
    assign: () => assignEmbedToAgent(ctx, embed),
    hasCapableAgent: () => hasCapableAgentForEmbed(ctx),
    getQueuePosition: () => getEmbedQueuePosition(ctx, embedId),
    buildAssignedResponse: () => ({
      embed_id: embedId,
      status: 'assigned',
      agent_id: embed.agent_id!,
    }),
    buildQueuedResponse: (position) => ({
      embed_id: embedId,
      status: 'queued',
      position,
    }),
  });
}

export async function handleGetEmbed(ctx: RelayContext, embedId: string): Promise<Response> {
  const embed = await ctx.getEmbed(embedId);
  if (!embed) {
    return Response.json({ error: 'Embed request not found' }, { status: 404 });
  }

  const response: EmbedStatusResponse = {
    embed_id: embed.embed_id,
    user_id: embed.user_id,
    client_id: embed.client_id,
    agent_id: embed.agent_id,
    status: embed.status,
    request: embed.request,
    result: embed.result,
    error: embed.error,
    created_at: embed.created_at,
    started_at: embed.started_at,
    completed_at: embed.completed_at,
  };
  return Response.json(response);
}

export async function handleCancelEmbed(ctx: RelayContext, embedId: string): Promise<Response> {
  const embed = await ctx.getEmbed(embedId);
  if (!embed) {
    return Response.json({ error: 'Embed request not found' }, { status: 404 });
  }

  const outcome = await cancelWork({
    ctx,
    work: embed,
    workId: embed.embed_id,
    map: ctx.embeds,
    persist: async (currentEmbed) => {
      await ctx.storage.put(`embed:${currentEmbed.embed_id}`, currentEmbed);
    },
    afterPersist: async () => {
      await ctx.scheduleEmbedWebhookIfNeeded(embed);
    },
    cancelMessage: { type: 'embed_cancel', embed_id: embedId },
    cancelLogLabel: `Failed to send embed cancel for ${embedId}:`,
    logMessage: `Embed ${embed.embed_id} cancelled`,
  });

  return buildCancelResponse<CancelEmbedResponse>(outcome, 'Embed request already completed');
}

export async function handleSubmitOcr(
  ctx: RelayContext,
  request: SubmitOcrRequest & { client_id: string },
  userId: string
): Promise<Response> {
  const ocrId = `ocr_${crypto.randomUUID().slice(0, 12)}`;
  const ocrRequest: OcrRequest = {
    image_url: request.image_url,
    max_tokens: request.max_tokens ?? 4096,
    temperature: request.temperature ?? 0.2,
  };

  const ocr: Ocr = {
    ocr_id: ocrId,
    user_id: userId,
    client_id: request.client_id,
    agent_id: null,
    status: 'queued',
    request: ocrRequest,
    result: null,
    error: null,
    created_at: new Date().toISOString(),
    started_at: null,
    completed_at: null,
  };

  await ctx.saveOcr(ocr);

  return finishSubmission<SubmitOcrResponse>({
    ctx,
    storageKey: `ocr:${ocrId}`,
    removeFromMemory: () => {
      ctx.ocrs.delete(ocrId);
    },
    assign: () => assignOcrToAgent(ctx, ocr),
    hasCapableAgent: () => hasCapableAgentForOcr(ctx),
    getQueuePosition: () => getOcrQueuePosition(ctx, ocrId),
    buildAssignedResponse: () => ({
      ocr_id: ocrId,
      status: 'assigned',
      agent_id: ocr.agent_id!,
    }),
    buildQueuedResponse: (position) => ({
      ocr_id: ocrId,
      status: 'queued',
      position,
    }),
  });
}

export async function handleGetOcr(ctx: RelayContext, ocrId: string): Promise<Response> {
  const ocr = await ctx.getOcr(ocrId);
  if (!ocr) {
    return Response.json({ error: 'OCR request not found' }, { status: 404 });
  }

  const response: OcrStatusResponse = {
    ocr_id: ocr.ocr_id,
    user_id: ocr.user_id,
    client_id: ocr.client_id,
    agent_id: ocr.agent_id,
    status: ocr.status,
    request: ocr.request,
    result: ocr.result,
    error: ocr.error,
    created_at: ocr.created_at,
    started_at: ocr.started_at,
    completed_at: ocr.completed_at,
  };

  return Response.json(response);
}

export async function handleCancelOcr(ctx: RelayContext, ocrId: string): Promise<Response> {
  const ocr = await ctx.getOcr(ocrId);
  if (!ocr) {
    return Response.json({ error: 'OCR request not found' }, { status: 404 });
  }

  const outcome = await cancelWork({
    ctx,
    work: ocr,
    workId: ocr.ocr_id,
    map: ctx.ocrs,
    persist: async (currentOcr) => {
      await ctx.storage.put(`ocr:${currentOcr.ocr_id}`, currentOcr);
    },
    cancelMessage: { type: 'ocr_cancel', ocr_id: ocrId },
    cancelLogLabel: `Failed to send OCR cancel for ${ocrId}:`,
    logMessage: `OCR ${ocr.ocr_id} cancelled`,
  });

  return buildCancelResponse<CancelOcrResponse>(outcome, 'OCR request already completed');
}
