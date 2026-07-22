import type { RelayContext } from './relay-context';
import type {
  ProgressMessage,
  ResultMessage,
} from './types';
import {
  finishTerminalWork,
  forwardMessageToOwnerIfNeeded,
} from './relay-lifecycle';
import { TERMINAL_RETAIN_MS } from './relay-agent-common';
import { recordNodePerformance } from './relay-fleet';

function hasCurrentLease(
  job: { lease_id?: string | null; lease_aware?: boolean },
  leaseId: string | undefined
): boolean {
  if (leaseId && leaseId !== job.lease_id) return false;
  if (job.lease_aware && !leaseId) return false;
  return true;
}

export async function handleProgress(
  ctx: RelayContext,
  msg: ProgressMessage
): Promise<void> {
  const job = await ctx.getJob(msg.job_id);
  if (!job) return;
  if (!hasCurrentLease(job, msg.lease_id)) {
    console.log(`Ignoring progress from stale lease for job ${msg.job_id}`);
    return;
  }
  if (job.status === 'cancelled') {
    console.log(`Ignoring progress for cancelled job ${msg.job_id}`);
    return;
  }

  job.status = 'generating';
  job.started_at = job.started_at ?? new Date().toISOString();
  job.progress = {
    step: msg.step,
    total_steps: msg.total_steps,
  };
  await ctx.saveJob(job);
}

export async function handleResult(
  ctx: RelayContext,
  msg: ResultMessage
): Promise<void> {
  const job = await ctx.getJob(msg.job_id);
  if (!job) {
    await forwardMessageToOwnerIfNeeded(
      ctx,
      msg.owner_user_id,
      '/result',
      msg,
      `Result for unknown job ${msg.job_id} - job not in memory (may be different DO or already completed)`
    );
    return;
  }
  if (!hasCurrentLease(job, msg.lease_id)) {
    console.log(`Ignoring result from stale lease for job ${msg.job_id}`);
    return;
  }
  if (job.status === 'cancelled') {
    console.log(`Ignoring late result for cancelled job ${msg.job_id}`);
    return;
  }

  job.status = msg.success ? 'complete' : 'failed';
  job.completed_at = new Date().toISOString();

  if (msg.success && (msg.image_url || msg.image_data || msg.media_url || msg.media_data)) {
    job.result = {
      image_url: msg.image_url ?? msg.media_url,
      image_data: msg.image_data ?? msg.media_data,
      media_url: msg.media_url ?? msg.image_url,
      media_data: msg.media_data ?? msg.image_data,
      content_type: msg.content_type,
      output_kind: msg.output_kind,
      seed: msg.seed ?? 0,
      generation_time_ms: msg.generation_time_ms ?? 0,
    };
  } else if (!msg.success) {
    job.error = msg.error ?? 'Unknown error';
  }

  await recordNodePerformance(
    ctx,
    job.agent_id,
    job.request.model?.trim() || job.request.kind || 'image',
    msg.success,
    msg.generation_time_ms
  );

  await finishTerminalWork({
    ctx,
    work: job,
    workId: job.job_id,
    agentId: job.agent_id,
    map: ctx.jobs,
    persist: async (currentJob) => {
      await ctx.storage.put(`job:${currentJob.job_id}`, ctx.prepareJobForStorage(currentJob));
    },
    retainInMemoryMs: TERMINAL_RETAIN_MS,
    afterPersist: async () => {
      await ctx.scheduleJobWebhookIfNeeded(job);
    },
    logMessage: `Job ${job.job_id} ${job.status}`,
  });
}
