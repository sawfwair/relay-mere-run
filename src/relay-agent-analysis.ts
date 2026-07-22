import type { RelayContext } from './relay-context';
import type {
  EmbedResponseMessage,
  EmbedErrorMessage,
  OcrResponseMessage,
  OcrErrorMessage,
} from './types';
import {
  finishTerminalWork,
  forwardMessageToOwnerIfNeeded,
} from './relay-lifecycle';
import { TERMINAL_RETAIN_MS } from './relay-agent-common';
import { durationMs, recordNodePerformance } from './relay-fleet';

export async function handleEmbedResponse(
  ctx: RelayContext,
  msg: EmbedResponseMessage
): Promise<void> {
  const embed = await ctx.getEmbed(msg.embed_id);
  if (!embed) {
    await forwardMessageToOwnerIfNeeded(
      ctx,
      msg.owner_user_id,
      '/embed-response',
      msg,
      `Embed response for unknown request ${msg.embed_id}`
    );
    return;
  }
  if (embed.status === 'cancelled') {
    console.log(`Ignoring late embed response for cancelled request ${msg.embed_id}`);
    return;
  }

  embed.status = 'complete';
  embed.completed_at = new Date().toISOString();
  embed.result = {
    model: msg.model ?? embed.request.model,
    dimensions: msg.dimensions ?? (msg.data[0]?.embedding?.length ?? 0),
    data: msg.data ?? [],
  };
	embed.error = null;
	await recordNodePerformance(
		ctx,
		embed.agent_id,
		embed.request.model,
		true,
		durationMs(embed.started_at, embed.completed_at) ?? undefined
	);

	await finishTerminalWork({
    ctx,
    work: embed,
    workId: embed.embed_id,
    agentId: embed.agent_id,
    map: ctx.embeds,
    persist: async (currentEmbed) => {
      await ctx.storage.put(`embed:${currentEmbed.embed_id}`, currentEmbed);
    },
    afterPersist: async () => {
      await ctx.scheduleEmbedWebhookIfNeeded(embed);
    },
    retainInMemoryMs: TERMINAL_RETAIN_MS,
    logMessage: `Embed ${embed.embed_id} completed`,
  });
}

export async function handleEmbedError(
  ctx: RelayContext,
  msg: EmbedErrorMessage
): Promise<void> {
  const embed = await ctx.getEmbed(msg.embed_id);
  if (!embed) {
    await forwardMessageToOwnerIfNeeded(
      ctx,
      msg.owner_user_id,
      '/embed-error',
      msg,
      `Embed error for unknown request ${msg.embed_id}`
    );
    return;
  }
  if (embed.status === 'cancelled') {
    console.log(`Ignoring late embed error for cancelled request ${msg.embed_id}`);
    return;
  }

  embed.status = 'failed';
	embed.error = msg.error;
	embed.completed_at = new Date().toISOString();
	await recordNodePerformance(ctx, embed.agent_id, embed.request.model, false);

  await finishTerminalWork({
    ctx,
    work: embed,
    workId: embed.embed_id,
    agentId: embed.agent_id,
    map: ctx.embeds,
    persist: async (currentEmbed) => {
      await ctx.storage.put(`embed:${currentEmbed.embed_id}`, currentEmbed);
    },
    afterPersist: async () => {
      await ctx.scheduleEmbedWebhookIfNeeded(embed);
    },
    logMessage: `Embed ${embed.embed_id} failed: ${msg.error}`,
  });
}

export async function handleOcrResponse(
  ctx: RelayContext,
  msg: OcrResponseMessage
): Promise<void> {
  const ocr = await ctx.getOcr(msg.ocr_id);
  if (!ocr) {
    await forwardMessageToOwnerIfNeeded(
      ctx,
      msg.owner_user_id,
      '/ocr-response',
      msg,
      `OCR response for unknown request ${msg.ocr_id}`
    );
    return;
  }
  if (ocr.status === 'cancelled') {
    console.log(`Ignoring late OCR response for cancelled request ${msg.ocr_id}`);
    return;
  }

  ocr.status = 'complete';
  ocr.completed_at = new Date().toISOString();
  ocr.result = {
    text: msg.text,
    tokens_generated: msg.tokens_generated ?? 0,
  };
	ocr.error = null;
	await recordNodePerformance(
		ctx,
		ocr.agent_id,
		'ocr',
		true,
		durationMs(ocr.started_at, ocr.completed_at) ?? undefined
	);

  await finishTerminalWork({
    ctx,
    work: ocr,
    workId: ocr.ocr_id,
    agentId: ocr.agent_id,
    map: ctx.ocrs,
    persist: async (currentOcr) => {
      await ctx.storage.put(`ocr:${currentOcr.ocr_id}`, currentOcr);
    },
    retainInMemoryMs: TERMINAL_RETAIN_MS,
    logMessage: `OCR ${ocr.ocr_id} completed`,
  });
}

export async function handleOcrError(
  ctx: RelayContext,
  msg: OcrErrorMessage
): Promise<void> {
  const ocr = await ctx.getOcr(msg.ocr_id);
  if (!ocr) {
    await forwardMessageToOwnerIfNeeded(
      ctx,
      msg.owner_user_id,
      '/ocr-error',
      msg,
      `OCR error for unknown request ${msg.ocr_id}`
    );
    return;
  }
  if (ocr.status === 'cancelled') {
    console.log(`Ignoring late OCR error for cancelled request ${msg.ocr_id}`);
    return;
  }

  ocr.status = 'failed';
	ocr.error = msg.error;
	ocr.completed_at = new Date().toISOString();
	await recordNodePerformance(ctx, ocr.agent_id, 'ocr', false);

  await finishTerminalWork({
    ctx,
    work: ocr,
    workId: ocr.ocr_id,
    agentId: ocr.agent_id,
    map: ctx.ocrs,
    persist: async (currentOcr) => {
      await ctx.storage.put(`ocr:${currentOcr.ocr_id}`, currentOcr);
    },
    logMessage: `OCR ${ocr.ocr_id} failed: ${msg.error}`,
  });
}
