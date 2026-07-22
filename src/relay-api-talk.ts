import {
  generateAudioUploadUrl,
  storeAudio,
  deleteAudio,
} from './r2';
import type { RelayContext } from './relay-context';
import type {
  Talk,
  TalkRequest,
  SubmitTalkRequest,
  SubmitTalkResponse,
  TalkStatusResponse,
  CancelTalkResponse,
} from './types';
import { cancelWork } from './relay-lifecycle';
import {
  assignTalkToAgent,
  hasCapableAgentForTalk,
  getTalkQueuePosition,
} from './relay-queue';
import { buildCancelResponse, finishSubmission } from './relay-api-common';

export async function handleSubmitTalk(
  ctx: RelayContext,
  request: SubmitTalkRequest & { client_id: string; relay_origin?: string },
  userId: string
): Promise<Response> {
  const talkId = `talk_${crypto.randomUUID().slice(0, 12)}`;
  const origin = request.relay_origin || 'https://relay.mere.run';
  const outputFormat = request.output_format ?? 'wav';
  if (outputFormat !== 'wav') {
    return Response.json({ error: 'Only wav output_format is currently supported' }, { status: 400 });
  }

  const talkRequest: TalkRequest = {
    text: request.text,
    voice_description: request.voice_description ?? 'A calm female voice with clear pronunciation',
    speed: request.speed ?? 1.0,
    temperature: request.temperature ?? 0.6,
    output_format: outputFormat,
  };

  const talk: Talk = {
    talk_id: talkId,
    user_id: userId,
    client_id: request.client_id,
    agent_id: null,
    status: 'queued',
    request: talkRequest,
    result: null,
    error: null,
    created_at: new Date().toISOString(),
    started_at: null,
    completed_at: null,
    upload_url: generateAudioUploadUrl(origin, userId, talkId),
    direct_audio: request.direct_audio ?? false,
  };

  await ctx.saveTalk(talk);

  return finishSubmission<SubmitTalkResponse>({
    ctx,
    storageKey: `talk:${talkId}`,
    removeFromMemory: () => {
      ctx.talks.delete(talkId);
    },
    assign: () => assignTalkToAgent(ctx, talk),
    hasCapableAgent: () => hasCapableAgentForTalk(ctx),
    getQueuePosition: () => getTalkQueuePosition(ctx, talkId),
    buildAssignedResponse: () => ({
      talk_id: talkId,
      status: 'assigned',
      agent_id: talk.agent_id!,
    }),
    buildQueuedResponse: (position) => ({
      talk_id: talkId,
      status: 'queued',
      position,
    }),
  });
}

export async function handleGetTalk(ctx: RelayContext, talkId: string): Promise<Response> {
  const talk = await ctx.getTalk(talkId);
  if (!talk) {
    return Response.json({ error: 'Talk request not found' }, { status: 404 });
  }

  const response: TalkStatusResponse = {
    talk_id: talk.talk_id,
    user_id: talk.user_id,
    client_id: talk.client_id,
    agent_id: talk.agent_id,
    status: talk.status,
    request: talk.request,
    result: talk.result,
    error: talk.error,
    created_at: talk.created_at,
    started_at: talk.started_at,
    completed_at: talk.completed_at,
    direct_audio: talk.direct_audio,
  };

  return Response.json(response);
}

export async function handleCancelTalk(ctx: RelayContext, talkId: string): Promise<Response> {
  const talk = await ctx.getTalk(talkId);
  if (!talk) {
    return Response.json({ error: 'Talk request not found' }, { status: 404 });
  }

  const outcome = await cancelWork({
    ctx,
    work: talk,
    workId: talk.talk_id,
    map: ctx.talks,
    persist: async (currentTalk) => {
      await ctx.storage.put(`talk:${currentTalk.talk_id}`, ctx.prepareTalkForStorage(currentTalk));
    },
    cancelMessage: { type: 'talk_cancel', talk_id: talkId },
    cancelLogLabel: `Failed to send talk cancel for ${talkId}:`,
    logMessage: `Talk ${talk.talk_id} cancelled`,
  });

  return buildCancelResponse<CancelTalkResponse>(outcome, 'Talk request already completed');
}

export async function handleDeleteTalkAudio(ctx: RelayContext, talkId: string): Promise<Response> {
  const talk = await ctx.getTalk(talkId);
  if (!talk) {
    return Response.json({ error: 'Talk request not found' }, { status: 404 });
  }

  await deleteAudio(ctx.env, talk.user_id, talkId);
  return Response.json({ deleted: true });
}

export async function handleAudioUpload(
  ctx: RelayContext,
  talkId: string,
  request: Request
): Promise<Response> {
  const talk = await ctx.getTalk(talkId);
  if (!talk) {
    return Response.json({ error: 'Talk request not found or already completed' }, { status: 404 });
  }

  if (!talk.user_id) {
    return Response.json({ error: 'Missing user ID in talk request' }, { status: 400 });
  }

  const audioData = await request.arrayBuffer();
  if (audioData.byteLength === 0) {
    return Response.json({ error: 'Empty audio data' }, { status: 400 });
  }

  const audioUrl = await storeAudio(ctx.env, talk.user_id, talkId, audioData);
  return Response.json({ audio_url: audioUrl });
}
