import {
  generateUploadUrl,
  storeJobOutput,
  deleteImage,
} from './r2';
import type { RelayContext } from './relay-context';
import type {
  Job,
  JobRequest,
  SubmitJobRequest,
  SubmitJobResponse,
  JobStatusResponse,
} from './types';
import { cancelWork } from './relay-lifecycle';
import {
  assignJobToAgent,
  hasCapableAgentForJob,
  getQueuePosition,
} from './relay-queue';
import { buildCancelResponse, finishSubmission } from './relay-api-common';
import { getFleetSettings } from './relay-fleet';

function inferJobKind(request: SubmitJobRequest): 'image' | 'music' | 'video' {
  if (request.kind) return request.kind;
  const model = request.model?.trim().toLowerCase() ?? '';
  if (model === 'ltxvideo' || model.startsWith('video-')) return 'video';
  if (model.startsWith('music-')) return 'music';
  return 'image';
}

export async function handleSubmitJob(
  ctx: RelayContext,
  request: SubmitJobRequest & { client_id: string; relay_origin?: string },
  userId: string
): Promise<Response> {
  const jobId = `job_${crypto.randomUUID().slice(0, 12)}`;
  const origin = request.relay_origin || 'https://relay.mere.run';
  const uploadUrl = generateUploadUrl(origin, userId, jobId);
  const kind = inferJobKind(request);
  const fleetSettings = await getFleetSettings(ctx);

  const jobRequest: JobRequest = {
    kind,
    prompt: request.prompt,
    negative_prompt: request.negative_prompt ?? null,
    width: request.width ?? (kind === 'video' ? 768 : 1024),
    height: request.height ?? (kind === 'video' ? 512 : 1024),
    steps: request.steps ?? 4,
    seed: request.seed ?? null,
    input_image_url: request.input_image_url ?? null,
    input_image_data: request.input_image_data ?? null,
    input_strength: request.input_strength ?? null,
    reference_image_urls: request.reference_image_urls ?? null,
    model: request.model?.trim(),
    duration_seconds: request.duration_seconds,
    fps: request.fps,
    num_frames: request.num_frames,
    lyrics: request.lyrics,
  };

  const job: Job = {
    job_id: jobId,
    user_id: userId,
    client_id: request.client_id,
    agent_id: null,
    status: 'queued',
    request: jobRequest,
    progress: null,
    result: null,
    error: null,
    created_at: new Date().toISOString(),
    assigned_at: null,
    started_at: null,
    completed_at: null,
    upload_url: uploadUrl,
    direct_image: request.direct_image ?? false,
    webhook_url: request.webhook_url ?? null,
    webhook_sent: false,
    attempts: 0,
    max_attempts: fleetSettings.retry_limit + 1,
    lease_id: null,
    lease_aware: false,
  };

  await ctx.saveJob(job);

  return finishSubmission<SubmitJobResponse>({
    ctx,
    storageKey: `job:${jobId}`,
    removeFromMemory: () => {
      ctx.jobs.delete(jobId);
    },
    assign: () => assignJobToAgent(ctx, job, request.agent_id),
    hasCapableAgent: () => hasCapableAgentForJob(ctx, job),
    getQueuePosition: () => getQueuePosition(ctx, jobId),
    buildAssignedResponse: () => ({
      job_id: jobId,
      status: 'assigned',
      agent_id: job.agent_id!,
      estimated_time_ms: 25000,
    }),
    buildQueuedResponse: (position) => ({
      job_id: jobId,
      status: 'queued',
      position,
      estimated_time_ms: 25000 * (position + 1),
    }),
  });
}

export async function handleGetJob(ctx: RelayContext, jobId: string): Promise<Response> {
  const job = await ctx.getJob(jobId);
  if (!job) {
    return Response.json({ error: 'Job not found' }, { status: 404 });
  }

  const response: JobStatusResponse = {
    job_id: job.job_id,
    user_id: job.user_id,
    client_id: job.client_id,
    agent_id: job.agent_id,
    status: job.status,
    request: job.request,
    progress: job.progress,
    result: job.result,
    error: job.error,
    created_at: job.created_at,
    assigned_at: job.assigned_at,
    started_at: job.started_at,
    completed_at: job.completed_at,
    direct_image: job.direct_image,
  };

  return Response.json(response);
}

export async function handleCancelJob(ctx: RelayContext, jobId: string): Promise<Response> {
  const job = await ctx.getJob(jobId);
  if (!job) {
    return Response.json({ error: 'Job not found' }, { status: 404 });
  }

  const outcome = await cancelWork({
    ctx,
    work: job,
    workId: job.job_id,
    map: ctx.jobs,
    persist: async (currentJob) => {
      await ctx.storage.put(`job:${currentJob.job_id}`, ctx.prepareJobForStorage(currentJob));
    },
    cancelMessage: { type: 'cancel', job_id: jobId },
    cancelLogLabel: `Failed to send job cancel for ${jobId}:`,
    afterPersist: async () => {
      await ctx.scheduleJobWebhookIfNeeded(job);
    },
    logMessage: `Job ${job.job_id} cancelled`,
  });

  return buildCancelResponse<{ cancelled: boolean }>(outcome, 'Job already completed');
}

export async function handleImageUpload(
  ctx: RelayContext,
  jobId: string,
  request: Request
): Promise<Response> {
  const job = await ctx.getJob(jobId);
  if (!job) {
    return Response.json({ error: 'Job not found or already completed' }, { status: 404 });
  }

  if (!job.user_id) {
    return Response.json({ error: 'Missing user ID in job' }, { status: 400 });
  }

  const outputData = await request.arrayBuffer();
  if (outputData.byteLength === 0) {
    return Response.json({ error: 'Empty output data' }, { status: 400 });
  }

  const contentType = request.headers.get('Content-Type') || 'image/png';
  const mediaUrl = await storeJobOutput(ctx.env, job.user_id, jobId, outputData, contentType);
  return Response.json({
    image_url: mediaUrl,
    media_url: mediaUrl,
    content_type: contentType,
  });
}

export async function handleDeleteJobImage(ctx: RelayContext, jobId: string): Promise<Response> {
  const job = await ctx.getJob(jobId);
  if (!job) {
    return Response.json({ error: 'Job not found' }, { status: 404 });
  }

  await deleteImage(ctx.env, job.user_id, jobId);
  return Response.json({ deleted: true });
}
