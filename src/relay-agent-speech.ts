import type { RelayContext } from './relay-context';
import type {
  TalkResponseMessage,
  TalkErrorMessage,
  AsrResponseMessage,
  AsrErrorMessage,
} from './types';
import {
  finishTerminalWork,
  forwardMessageToOwnerIfNeeded,
} from './relay-lifecycle';
import { TERMINAL_RETAIN_MS } from './relay-agent-common';
import { durationMs, recordNodePerformance } from './relay-fleet';

export async function handleTalkResponse(
  ctx: RelayContext,
  msg: TalkResponseMessage
): Promise<void> {
  const talk = await ctx.getTalk(msg.talk_id);
  if (!talk) {
    await forwardMessageToOwnerIfNeeded(
      ctx,
      msg.owner_user_id,
      '/talk-response',
      msg,
      `Talk response for unknown talk ${msg.talk_id}`
    );
    return;
  }
  if (talk.status === 'cancelled') {
    console.log(`Ignoring late talk response for cancelled talk ${msg.talk_id}`);
    return;
  }

  talk.status = 'complete';
  talk.completed_at = new Date().toISOString();
  talk.result = {
    audio_url: msg.audio_url,
    audio_data: msg.audio_data,
    duration_seconds: msg.duration_seconds ?? 0,
    sample_rate: msg.sample_rate ?? 24000,
    output_format: msg.output_format ?? 'wav',
  };
	talk.error = null;
	await recordNodePerformance(
		ctx,
		talk.agent_id,
		'talk',
		true,
		durationMs(talk.started_at, talk.completed_at) ?? undefined
	);

  await finishTerminalWork({
    ctx,
    work: talk,
    workId: talk.talk_id,
    agentId: talk.agent_id,
    map: ctx.talks,
    persist: async (currentTalk) => {
      await ctx.storage.put(`talk:${currentTalk.talk_id}`, ctx.prepareTalkForStorage(currentTalk));
    },
    retainInMemoryMs: TERMINAL_RETAIN_MS,
    logMessage: `Talk ${talk.talk_id} completed`,
  });
}

export async function handleTalkError(
  ctx: RelayContext,
  msg: TalkErrorMessage
): Promise<void> {
  const talk = await ctx.getTalk(msg.talk_id);
  if (!talk) {
    await forwardMessageToOwnerIfNeeded(
      ctx,
      msg.owner_user_id,
      '/talk-error',
      msg,
      `Talk error for unknown talk ${msg.talk_id}`
    );
    return;
  }
  if (talk.status === 'cancelled') {
    console.log(`Ignoring late talk error for cancelled talk ${msg.talk_id}`);
    return;
  }

  talk.status = 'failed';
	talk.error = msg.error;
	talk.completed_at = new Date().toISOString();
	await recordNodePerformance(ctx, talk.agent_id, 'talk', false);

  await finishTerminalWork({
    ctx,
    work: talk,
    workId: talk.talk_id,
    agentId: talk.agent_id,
    map: ctx.talks,
    persist: async (currentTalk) => {
      await ctx.storage.put(`talk:${currentTalk.talk_id}`, ctx.prepareTalkForStorage(currentTalk));
    },
    logMessage: `Talk ${talk.talk_id} failed: ${msg.error}`,
  });
}

export async function handleAsrResponse(
  ctx: RelayContext,
  msg: AsrResponseMessage
): Promise<void> {
  const asr = await ctx.getAsr(msg.asr_id);
  if (!asr) {
    await forwardMessageToOwnerIfNeeded(
      ctx,
      msg.owner_user_id,
      '/asr-response',
      msg,
      `ASR response for unknown request ${msg.asr_id}`
    );
    return;
  }
  if (asr.status === 'cancelled') {
    console.log(`Ignoring late ASR response for cancelled request ${msg.asr_id}`);
    return;
  }

  asr.status = 'complete';
  asr.completed_at = new Date().toISOString();
  asr.result = {
    text: msg.text,
    language: msg.language ?? null,
    duration_seconds: msg.duration_seconds ?? 0,
    token_alignments: msg.token_alignments,
    sentence_alignments: msg.sentence_alignments,
    speaker_segments: msg.speaker_segments,
  };
	asr.error = null;
	await recordNodePerformance(
		ctx,
		asr.agent_id,
		'asr',
		true,
		durationMs(asr.started_at, asr.completed_at) ?? undefined
	);

  await finishTerminalWork({
    ctx,
    work: asr,
    workId: asr.asr_id,
    agentId: asr.agent_id,
    map: ctx.asrs,
    persist: async (currentAsr) => {
      await ctx.storage.put(`asr:${currentAsr.asr_id}`, currentAsr);
    },
    afterPersist: async () => {
      await ctx.scheduleAsrWebhookIfNeeded(asr);
    },
    retainInMemoryMs: TERMINAL_RETAIN_MS,
    logMessage: `ASR ${asr.asr_id} completed`,
  });
}

export async function handleAsrError(
  ctx: RelayContext,
  msg: AsrErrorMessage
): Promise<void> {
  const asr = await ctx.getAsr(msg.asr_id);
  if (!asr) {
    await forwardMessageToOwnerIfNeeded(
      ctx,
      msg.owner_user_id,
      '/asr-error',
      msg,
      `ASR error for unknown request ${msg.asr_id}`
    );
    return;
  }
  if (asr.status === 'cancelled') {
    console.log(`Ignoring late ASR error for cancelled request ${msg.asr_id}`);
    return;
  }

  asr.status = 'failed';
	asr.error = msg.error;
	asr.completed_at = new Date().toISOString();
	await recordNodePerformance(ctx, asr.agent_id, 'asr', false);

  await finishTerminalWork({
    ctx,
    work: asr,
    workId: asr.asr_id,
    agentId: asr.agent_id,
    map: ctx.asrs,
    persist: async (currentAsr) => {
      await ctx.storage.put(`asr:${currentAsr.asr_id}`, currentAsr);
    },
    afterPersist: async () => {
      await ctx.scheduleAsrWebhookIfNeeded(asr);
    },
    logMessage: `ASR ${asr.asr_id} failed: ${msg.error}`,
  });
}
