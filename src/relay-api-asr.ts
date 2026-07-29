import type { RelayContext } from './relay-context';
import type {
  Asr,
  AsrRequest,
  SubmitAsrRequest,
  SubmitAsrResponse,
  AsrStatusResponse,
  CancelAsrResponse,
} from './types';
import { cancelWork } from './relay-lifecycle';
import {
  assignAsrToAgent,
  hasCapableAgentForAsr,
  getAsrQueuePosition,
} from './relay-queue';
import { buildCancelResponse, finishSubmission } from './relay-api-common';

export async function handleSubmitAsr(
  ctx: RelayContext,
  request: SubmitAsrRequest & { client_id: string },
  userId: string
): Promise<Response> {
  const asrId = `asr_${crypto.randomUUID().slice(0, 12)}`;
  const asrRequest: AsrRequest = {
    audio_url: request.audio_url,
    language: request.language ?? null,
    task: request.task ?? 'transcribe',
    backend: request.backend ?? 'auto',
    diarize: request.diarize ?? false,
    max_tokens: request.max_tokens ?? 448,
  };

  const asr: Asr = {
    asr_id: asrId,
    user_id: userId,
    client_id: request.client_id,
    agent_id: null,
    status: 'queued',
    request: asrRequest,
    result: null,
    error: null,
    created_at: new Date().toISOString(),
    started_at: null,
    completed_at: null,
    webhook_url: request.webhook_url ?? null,
    webhook_sent: false,
  };

  await ctx.saveAsr(asr);

  return finishSubmission<SubmitAsrResponse>({
    ctx,
    storageKey: `asr:${asrId}`,
    removeFromMemory: () => {
      ctx.asrs.delete(asrId);
    },
    assign: () => assignAsrToAgent(ctx, asr),
    hasCapableAgent: () => hasCapableAgentForAsr(ctx, asr),
    getQueuePosition: () => getAsrQueuePosition(ctx, asrId),
    buildAssignedResponse: () => ({
      asr_id: asrId,
      status: 'assigned',
      agent_id: asr.agent_id!,
    }),
    buildQueuedResponse: (position) => ({
      asr_id: asrId,
      status: 'queued',
      position,
    }),
  });
}

export async function handleGetAsr(ctx: RelayContext, asrId: string): Promise<Response> {
  const asr = await ctx.getAsr(asrId);
  if (!asr) {
    return Response.json({ error: 'ASR request not found' }, { status: 404 });
  }

  const response: AsrStatusResponse = {
    asr_id: asr.asr_id,
    user_id: asr.user_id,
    client_id: asr.client_id,
    agent_id: asr.agent_id,
    status: asr.status,
    request: asr.request,
    result: asr.result,
    error: asr.error,
    created_at: asr.created_at,
    started_at: asr.started_at,
    completed_at: asr.completed_at,
  };

  return Response.json(response);
}

export async function handleCancelAsr(ctx: RelayContext, asrId: string): Promise<Response> {
  const asr = await ctx.getAsr(asrId);
  if (!asr) {
    return Response.json({ error: 'ASR request not found' }, { status: 404 });
  }

  const outcome = await cancelWork({
    ctx,
    work: asr,
    workId: asr.asr_id,
    map: ctx.asrs,
    persist: async (currentAsr) => {
      await ctx.storage.put(`asr:${currentAsr.asr_id}`, currentAsr);
    },
    afterPersist: async () => {
      await ctx.scheduleAsrWebhookIfNeeded(asr);
    },
    cancelMessage: { type: 'asr_cancel', asr_id: asrId },
    cancelLogLabel: `Failed to send ASR cancel for ${asrId}:`,
    logMessage: `ASR ${asr.asr_id} cancelled`,
  });

  return buildCancelResponse<CancelAsrResponse>(outcome, 'ASR request already completed');
}
