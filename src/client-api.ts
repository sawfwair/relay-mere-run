import type {
  Env,
  JobStatusResponse,
} from './types';
import { parseJson, readRequestJson, readResponseJson } from './json';
import { invalidJsonResponse } from './json';
import {
  graphClientEnvelopeSchema,
  submitAsrRequestSchema,
  submitChatRequestSchema,
  submitEmbedRequestSchema,
  submitJobRequestSchema,
  submitOcrRequestSchema,
  submitTalkRequestSchema,
  submitToolRequestSchema,
} from './contracts/requests';
import {
  asrStatusResponseSchema,
  asrStreamTicketResponseSchema,
  embedStatusResponseSchema,
  graphStateResponseSchema,
  jobStatusResponseSchema,
  ocrStatusResponseSchema,
  talkStatusResponseSchema,
  toolStatusResponseSchema,
  unknownJsonSchema,
} from './contracts/responses';
import { graphRunEventSchema } from './contracts/graph';
import { buildAssetUrl, getAndDeleteAudio, getAndDeleteImage } from './r2';
import { sealAsrTicket } from './relay-asr-stream';

const SSE_POLL_INTERVAL_MS = 1000;
const SSE_KEEPALIVE_MS = 15000;
const EMBED_MAX_TEXTS = 2_000;
const EMBED_MAX_TOTAL_BYTES = 1_000_000;
const CLIENT_API_PREFIX = '/api';
const LEGACY_CLIENT_API_PREFIX = '/api/zero-agent';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function graphEventStream(relay: DurableObjectStub, origin: string, jobId: string): Response {
  const encoder = new TextEncoder();
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller): Promise<void> {
      const send = (event: string, data: unknown): boolean => {
        if (closed) return false;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
          return true;
        } catch {
          closed = true;
          return false;
        }
      };
      let lastSequence = -1;
      let lastKeepalive = Date.now();
      try {
        if (!send('connected', { job_id: jobId })) return;
        while (!closed) {
          const eventsResponse = await relay.fetch(new Request(`${origin}/internal/graph-jobs/${jobId}/events`));
          const statusResponse = await relay.fetch(new Request(`${origin}/internal/graph-jobs/${jobId}`));
          if (!eventsResponse.ok || !statusResponse.ok) {
            send('error', { error: 'Graph job was not found' });
            break;
          }
          const eventText = new TextDecoder().decode(await eventsResponse.arrayBuffer());
          const events = eventText
            .split('\n')
            .filter(Boolean)
            .map((line) => parseJson(line, graphRunEventSchema));
          for (const event of events) {
            const sequence = event.sequence;
            if (!Number.isSafeInteger(sequence) || sequence <= lastSequence) continue;
            if (!send('graph_event', event)) return;
            lastSequence = sequence;
          }
          const status = await readResponseJson(statusResponse, graphStateResponseSchema);
          if (['finished', 'failed', 'cancelled'].includes(status.state)) {
            send('done', { job_id: jobId, state: status.state });
            break;
          }
          if (Date.now() - lastKeepalive >= SSE_KEEPALIVE_MS) {
            controller.enqueue(encoder.encode(': keepalive\n\n'));
            lastKeepalive = Date.now();
          }
          await sleep(SSE_POLL_INTERVAL_MS);
        }
      } catch (error) {
        send('error', { error: error instanceof Error ? error.message : 'Unknown graph stream error' });
      } finally {
        closed = true;
        try { controller.close(); } catch { /* stream already closed */ }
      }
    },
    cancel(): void {
      closed = true;
    },
  });
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}

export function getClientApiPath(pathname: string): string | null {
  if (pathname === LEGACY_CLIENT_API_PREFIX) {
    return '/';
  }
  if (pathname.startsWith(`${LEGACY_CLIENT_API_PREFIX}/`)) {
    return pathname.slice(LEGACY_CLIENT_API_PREFIX.length) || '/';
  }
  if (pathname === CLIENT_API_PREFIX) {
    return '/';
  }
  if (pathname.startsWith(`${CLIENT_API_PREFIX}/`)) {
    return pathname.slice(CLIENT_API_PREFIX.length) || '/';
  }
  return null;
}

async function hydrateDirectImage(
  env: Env,
  userId: string,
  jobId: string,
  job: JobStatusResponse
): Promise<JobStatusResponse> {
  if (job.status === 'complete' && job.direct_image && job.result?.image_url && !job.result?.image_data) {
    const imageData = await getAndDeleteImage(env, userId, jobId);
    if (imageData) {
      job.result.image_data = imageData;
    }
  }
  return job;
}

/**
 * Handle client HTTP API requests
 * All requests are already authenticated (user_id verified)
 */
export async function handleClientApi(
  request: Request,
  env: Env,
  userId: string
): Promise<Response> {
  try {
    return await handleClientApiUnchecked(request, env, userId);
  } catch (error) {
    const response = invalidJsonResponse(error);
    if (response) return response;
    throw error;
  }
}

async function handleClientApiUnchecked(
  request: Request,
  env: Env,
  userId: string
): Promise<Response> {
  const url = new URL(request.url);
  const path = getClientApiPath(url.pathname);
  if (path === null) {
    return new Response('Not Found', { status: 404 });
  }

  // Get user's Durable Object
  const id = env.MERE_RUN_RELAY.idFromName(userId);
  const relay = env.MERE_RUN_RELAY.get(id);

  if (path === '/asr/stream-ticket' && request.method === 'POST') {
    const rawResponse = await relay.fetch(new Request(`${url.origin}/internal/asr/stream-ticket`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-User-Id': userId },
      body: request.body,
    }));
    if (!rawResponse.ok) return rawResponse;
    const raw = await readResponseJson(rawResponse, asrStreamTicketResponseSchema);
    try {
      const ticket = await sealAsrTicket(env, { u: userId, t: raw.ticket_id, e: raw.expires_at_ms });
      const webSocketURL = new URL('/api/asr/stream', url.origin);
      webSocketURL.protocol = webSocketURL.protocol === 'https:' ? 'wss:' : 'ws:';
      webSocketURL.searchParams.set('ticket', ticket);
      return Response.json({
        websocket_url: webSocketURL.toString(),
        protocol: raw.protocol,
        device_label: raw.device_label,
        expires_at: new Date(raw.expires_at_ms).toISOString(),
      });
    } catch {
      return Response.json({ error: 'ASR stream ticket signing is unavailable' }, { status: 503 });
    }
  }

  if (path === '/graph-jobs/capabilities' && request.method === 'GET') {
    return relay.fetch(new Request(`${url.origin}/internal/graph-jobs/capabilities`));
  }
  if (path === '/graph-jobs/telemetry' && request.method === 'GET') {
    return relay.fetch(new Request(`${url.origin}/internal/graph-jobs/telemetry`));
  }
  if (path === '/graph-jobs/preflight' && request.method === 'POST') {
    return relay.fetch(new Request(`${url.origin}/internal/graph-jobs/preflight`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-User-Id': userId },
      body: request.body,
    }));
  }

  if (path === '/graph-jobs' && request.method === 'POST') {
    const body = await readRequestJson(request, graphClientEnvelopeSchema);
    return relay.fetch(new Request(`${url.origin}/internal/graph-jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-User-Id': userId },
      body: JSON.stringify({
        ...body,
        client_id: `client_${userId.slice(-8)}`,
        relay_origin: url.origin,
      }),
    }));
  }

  if (path === '/graph-jobs' && request.method === 'GET') {
    return relay.fetch(new Request(`${url.origin}/internal/graph-jobs${url.search}`));
  }

  const graphAssetMatch = path.match(/^\/graph-jobs\/([^/]+)\/assets\/([a-f0-9]{64})$/);
  if (graphAssetMatch && request.method === 'PUT') {
    return relay.fetch(new Request(
      `${url.origin}/internal/graph-jobs/${graphAssetMatch[1]}/assets/${graphAssetMatch[2]}`,
      { method: 'PUT', headers: { 'Content-Type': request.headers.get('Content-Type') || 'application/octet-stream' }, body: request.body }
    ));
  }

  const graphCommitMatch = path.match(/^\/graph-jobs\/([^/]+)\/commit$/);
  if (graphCommitMatch && request.method === 'POST') {
    return relay.fetch(new Request(`${url.origin}/internal/graph-jobs/${graphCommitMatch[1]}/commit`, { method: 'POST' }));
  }

  const graphEventsMatch = path.match(/^\/graph-jobs\/([^/]+)\/events$/);
  if (graphEventsMatch && request.method === 'GET') {
    if (request.headers.get('Accept')?.includes('text/event-stream')) {
      return graphEventStream(relay, url.origin, graphEventsMatch[1]);
    }
    return relay.fetch(new Request(`${url.origin}/internal/graph-jobs/${graphEventsMatch[1]}/events`));
  }

  const graphRetryMatch = path.match(/^\/graph-jobs\/([^/]+)\/retry$/);
  if (graphRetryMatch && request.method === 'POST') {
    return relay.fetch(new Request(`${url.origin}/internal/graph-jobs/${graphRetryMatch[1]}/retry`, { method: 'POST' }));
  }

  const graphManifestMatch = path.match(/^\/graph-jobs\/([^/]+)\/run-manifest$/);
  if (graphManifestMatch && request.method === 'GET') {
    return relay.fetch(new Request(`${url.origin}/internal/graph-jobs/${graphManifestMatch[1]}/run-manifest`));
  }

  const graphArtifactMatch = path.match(/^\/graph-jobs\/([^/]+)\/artifacts\/([^/]+)$/);
  if (graphArtifactMatch && request.method === 'GET') {
    return relay.fetch(new Request(`${url.origin}/internal/graph-jobs/${graphArtifactMatch[1]}/artifacts/${graphArtifactMatch[2]}`));
  }

  const graphMatch = path.match(/^\/graph-jobs\/([^/]+)$/);
  if (graphMatch && request.method === 'GET') {
    return relay.fetch(new Request(`${url.origin}/internal/graph-jobs/${graphMatch[1]}`));
  }
  if (graphMatch && request.method === 'DELETE') {
    return relay.fetch(new Request(`${url.origin}/internal/graph-jobs/${graphMatch[1]}`, { method: 'DELETE' }));
  }

  // GET /api/status
  if (path === '/status' && request.method === 'GET') {
    const doRequest = new Request(`${url.origin}/internal/status`);
    return relay.fetch(doRequest);
  }

  if (path === '/fleet' && request.method === 'GET') {
    return relay.fetch(new Request(`${url.origin}/internal/fleet`));
  }

  if (path === '/fleet/settings' && request.method === 'PATCH') {
    return relay.fetch(new Request(`${url.origin}/internal/fleet/settings`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: request.body,
    }));
  }

  const fleetNodeMatch = path.match(/^\/fleet\/nodes\/([^/]+)$/);
  if (fleetNodeMatch && request.method === 'PATCH') {
    return relay.fetch(new Request(
      `${url.origin}/internal/fleet/nodes/${encodeURIComponent(decodeURIComponent(fleetNodeMatch[1]))}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: request.body,
      }
    ));
  }

  const fleetNodeRefreshMatch = path.match(/^\/fleet\/nodes\/([^/]+)\/refresh$/);
  if (fleetNodeRefreshMatch && request.method === 'POST') {
    return relay.fetch(new Request(
      `${url.origin}/internal/fleet/nodes/${encodeURIComponent(decodeURIComponent(fleetNodeRefreshMatch[1]))}/refresh`,
      { method: 'POST' }
    ));
  }

  if (path === '/fleet/model-plans' && request.method === 'POST') {
    return relay.fetch(new Request(`${url.origin}/internal/fleet/model-plans`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: request.body,
    }));
  }
  if (path === '/fleet/model-plans' && request.method === 'GET') {
    const limit = url.searchParams.get('limit');
    const query = limit ? `?limit=${encodeURIComponent(limit)}` : '';
    return relay.fetch(new Request(`${url.origin}/internal/fleet/model-plans${query}`));
  }
  const fleetModelPlanApplyMatch = path.match(/^\/fleet\/model-plans\/([^/]+)\/apply$/);
  if (fleetModelPlanApplyMatch && request.method === 'POST') {
    return relay.fetch(new Request(
      `${url.origin}/internal/fleet/model-plans/${encodeURIComponent(decodeURIComponent(fleetModelPlanApplyMatch[1]))}/apply`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: request.body,
      }
    ));
  }
  const fleetModelPlanMatch = path.match(/^\/fleet\/model-plans\/([^/]+)$/);
  if (fleetModelPlanMatch && request.method === 'GET') {
    return relay.fetch(new Request(
      `${url.origin}/internal/fleet/model-plans/${encodeURIComponent(decodeURIComponent(fleetModelPlanMatch[1]))}`
    ));
  }
  if (fleetModelPlanMatch && request.method === 'DELETE') {
    return relay.fetch(new Request(
      `${url.origin}/internal/fleet/model-plans/${encodeURIComponent(decodeURIComponent(fleetModelPlanMatch[1]))}`,
      { method: 'DELETE' }
    ));
  }

  // POST /api/generate
  if (path === '/generate' && request.method === 'POST') {
    const body = await readRequestJson(request, submitJobRequestSchema);

    // Add client_id and relay_origin for upload URL generation
    const submitBody = {
      ...body,
      client_id: `client_${userId.slice(-8)}`,
      relay_origin: url.origin,
    };

    const doRequest = new Request(`${url.origin}/internal/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-User-Id': userId },
      body: JSON.stringify(submitBody),
    });

    return relay.fetch(doRequest);
  }

  // POST /api/video
  if (path === '/video' && request.method === 'POST') {
    const body = await readRequestJson(request, submitJobRequestSchema);

    const submitBody = {
      ...body,
      kind: 'video',
      model: body.model?.trim() || 'video-ltx23-av-mlx',
      client_id: `client_${userId.slice(-8)}`,
      relay_origin: url.origin,
    };

    const doRequest = new Request(`${url.origin}/internal/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-User-Id': userId },
      body: JSON.stringify(submitBody),
    });

    return relay.fetch(doRequest);
  }

  // POST /api/music
  if (path === '/music' && request.method === 'POST') {
    const body = await readRequestJson(request, submitJobRequestSchema);

    const submitBody = {
      ...body,
      kind: 'music',
      model: body.model?.trim() || 'music-acestep',
      client_id: `client_${userId.slice(-8)}`,
      relay_origin: url.origin,
    };

    const doRequest = new Request(`${url.origin}/internal/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-User-Id': userId },
      body: JSON.stringify(submitBody),
    });

    return relay.fetch(doRequest);
  }

  // GET /api/job/:job_id
  const jobMatch = path.match(/^\/job\/([^/]+)$/);
  if (jobMatch && request.method === 'GET') {
    const jobId = jobMatch[1];
    const doRequest = new Request(`${url.origin}/internal/job/${jobId}`);
    const response = await relay.fetch(doRequest);

    // For direct_image jobs that are complete, fetch from R2 and return base64
    if (response.ok) {
      const job = await hydrateDirectImage(
        env,
        userId,
        jobId,
        await readResponseJson(response, jobStatusResponseSchema)
      );
      return Response.json(job);
    }
    return response;
  }

  // DELETE /api/job/:job_id
  if (jobMatch && request.method === 'DELETE') {
    const jobId = jobMatch[1];
    const doRequest = new Request(`${url.origin}/internal/job/${jobId}`, {
      method: 'DELETE',
    });
    return relay.fetch(doRequest);
  }

  // DELETE /api/job/:job_id/image
  const jobImageMatch = path.match(/^\/job\/([^/]+)\/image$/);
  if (jobImageMatch && request.method === 'DELETE') {
    const jobId = jobImageMatch[1];
    const doRequest = new Request(`${url.origin}/internal/job/${jobId}/image`, {
      method: 'DELETE',
    });
    return relay.fetch(doRequest);
  }

  // GET /api/job/:job_id/stream (SSE)
  const streamMatch = path.match(/^\/job\/([^/]+)\/stream$/);
  if (streamMatch && request.method === 'GET') {
    const jobId = streamMatch[1];

    const initialRequest = new Request(`${url.origin}/internal/job/${jobId}`);
    const initialResponse = await relay.fetch(initialRequest);
    if (!initialResponse.ok) {
      return initialResponse;
    }

    const initialJob = await hydrateDirectImage(
      env,
      userId,
      jobId,
      await readResponseJson(initialResponse, jobStatusResponseSchema)
    );

    const encoder = new TextEncoder();
    let closed = false;

    const stream = new ReadableStream<Uint8Array>({
      async start(controller): Promise<void> {
        const sendEvent = (event: string, data: unknown): boolean => {
          if (closed) return false;
          try {
            controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
            return true;
          } catch {
            closed = true;
            return false;
          }
        };

        const sendComment = (comment: string): boolean => {
          if (closed) return false;
          try {
            controller.enqueue(encoder.encode(`: ${comment}\n\n`));
            return true;
          } catch {
            closed = true;
            return false;
          }
        };

        const isTerminal = (status: JobStatusResponse['status']): boolean =>
          status === 'complete' || status === 'failed' || status === 'cancelled';

        let lastKeepaliveAt = Date.now();
        let lastEventKey = '';

        const emitJobIfChanged = (job: JobStatusResponse): boolean => {
          const progressStep = job.progress?.step ?? -1;
          const progressTotal = job.progress?.total_steps ?? -1;
          const eventKey = `${job.status}|${progressStep}|${progressTotal}|${job.error ?? ''}|${job.completed_at ?? ''}`;
          if (eventKey === lastEventKey) {
            return true;
          }
          lastEventKey = eventKey;
          return sendEvent('job', job);
        };

        try {
          if (!sendEvent('connected', { job_id: jobId })) {
            return;
          }

          if (!emitJobIfChanged(initialJob)) {
            return;
          }

          if (isTerminal(initialJob.status)) {
            sendEvent('done', { job_id: jobId, status: initialJob.status });
            return;
          }

          while (!closed) {
            await sleep(SSE_POLL_INTERVAL_MS);
            if (closed) break;

            const doRequest = new Request(`${url.origin}/internal/job/${jobId}`);
            const doResponse = await relay.fetch(doRequest);

            if (!doResponse.ok) {
              let errorPayload: unknown = { error: 'Failed to fetch job status during stream' };
              try {
                errorPayload = await readResponseJson(doResponse, unknownJsonSchema);
              } catch {
                // keep default payload
              }
              sendEvent('error', errorPayload);
              break;
            }

            const job = await hydrateDirectImage(
              env,
              userId,
              jobId,
              await readResponseJson(doResponse, jobStatusResponseSchema)
            );

            if (!emitJobIfChanged(job)) {
              break;
            }

            if (isTerminal(job.status)) {
              sendEvent('done', { job_id: jobId, status: job.status });
              break;
            }

            const now = Date.now();
            if (now - lastKeepaliveAt >= SSE_KEEPALIVE_MS) {
              if (!sendComment('keepalive')) {
                break;
              }
              lastKeepaliveAt = now;
            }
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown SSE stream error';
          sendEvent('error', { error: message });
        } finally {
          closed = true;
          try {
            controller.close();
          } catch {
            // stream already closed
          }
        }
      },
      cancel(): void {
        closed = true;
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    });
  }

  // POST /api/upload/:user_id/:job_id (agent image upload)
  // URL includes owner userId to route to correct DO regardless of agent's auth
  const uploadMatch = path.match(/^\/upload\/([^/]+)\/([^/]+)$/);
  if (uploadMatch && request.method === 'POST') {
    const ownerUserId = decodeURIComponent(uploadMatch[1]);
    const jobId = uploadMatch[2];

    // Route to the job owner's DO, not the uploader's
    const ownerId = env.MERE_RUN_RELAY.idFromName(ownerUserId);
    const ownerRelay = env.MERE_RUN_RELAY.get(ownerId);

    const doRequest = new Request(`${url.origin}/internal/upload/${jobId}`, {
      method: 'POST',
      body: request.body,
      headers: {
        'Content-Type': request.headers.get('Content-Type') || 'image/png',
        'X-User-Id': ownerUserId,
      },
    });
    return ownerRelay.fetch(doRequest);
  }

  // POST /api/tool-upload/:user_id/:tool_id/:artifact_name (agent tool artifact upload)
  const toolUploadMatch = path.match(/^\/tool-upload\/([^/]+)\/([^/]+)\/([^/]+)$/);
  if (toolUploadMatch && request.method === 'POST') {
    const ownerUserId = decodeURIComponent(toolUploadMatch[1]);
    const toolId = toolUploadMatch[2];
    const artifactName = toolUploadMatch[3];

    const ownerId = env.MERE_RUN_RELAY.idFromName(ownerUserId);
    const ownerRelay = env.MERE_RUN_RELAY.get(ownerId);

    const doRequest = new Request(`${url.origin}/internal/tool-upload/${toolId}/${artifactName}`, {
      method: 'POST',
      body: request.body,
      headers: {
        'Content-Type': request.headers.get('Content-Type') || 'application/octet-stream',
        'X-User-Id': ownerUserId,
      },
    });
    return ownerRelay.fetch(doRequest);
  }

  // POST /api/audio-upload/:user_id/:talk_id (agent audio upload)
  // URL includes owner userId to route to correct DO regardless of agent's auth
  const audioUploadMatch = path.match(/^\/audio-upload\/([^/]+)\/([^/]+)$/);
  if (audioUploadMatch && request.method === 'POST') {
    const ownerUserId = decodeURIComponent(audioUploadMatch[1]);
    const talkId = audioUploadMatch[2];

    const ownerId = env.MERE_RUN_RELAY.idFromName(ownerUserId);
    const ownerRelay = env.MERE_RUN_RELAY.get(ownerId);

    const doRequest = new Request(`${url.origin}/internal/audio-upload/${talkId}`, {
      method: 'POST',
      body: request.body,
      headers: {
        'Content-Type': request.headers.get('Content-Type') || 'audio/wav',
        'X-User-Id': ownerUserId,
      },
    });
    return ownerRelay.fetch(doRequest);
  }

  // POST /api/input-upload (client input image for img2img)
  if (path === '/input-upload' && request.method === 'POST') {
    const imageData = await request.arrayBuffer();
    if (imageData.byteLength === 0) {
      return Response.json({ error: 'Empty image data' }, { status: 400 });
    }
    if (imageData.byteLength > 5 * 1024 * 1024) {
      return Response.json({ error: 'Image too large (max 5MB)' }, { status: 400 });
    }
    const key = `inputs/${userId}/${crypto.randomUUID()}.jpg`;
    await env.IMAGES.put(key, imageData, { httpMetadata: { contentType: 'image/jpeg' } });
    const imageUrl = buildAssetUrl(env, key);
    return Response.json({ url: imageUrl });
  }

  // POST /api/asr/input-upload (client audio upload for ASR)
  if (path === '/asr/input-upload' && request.method === 'POST') {
    const audioData = await request.arrayBuffer();
    if (audioData.byteLength === 0) {
      return Response.json({ error: 'Empty audio data' }, { status: 400 });
    }
    if (audioData.byteLength > 25 * 1024 * 1024) {
      return Response.json({ error: 'Audio too large (max 25MB)' }, { status: 400 });
    }
    const ext = (request.headers.get('Content-Type') || 'audio/wav').includes('mpeg') ? 'mp3' : 'wav';
    const key = `inputs/${userId}/${crypto.randomUUID()}.${ext}`;
    await env.IMAGES.put(key, audioData, {
      httpMetadata: { contentType: request.headers.get('Content-Type') || 'audio/wav' },
    });
    const audioUrl = buildAssetUrl(env, key);
    return Response.json({ url: audioUrl });
  }

  // POST /api/ocr/input-upload (client image upload for OCR)
  if (path === '/ocr/input-upload' && request.method === 'POST') {
    const imageData = await request.arrayBuffer();
    if (imageData.byteLength === 0) {
      return Response.json({ error: 'Empty image data' }, { status: 400 });
    }
    if (imageData.byteLength > 10 * 1024 * 1024) {
      return Response.json({ error: 'Image too large (max 10MB)' }, { status: 400 });
    }
    const contentType = request.headers.get('Content-Type') || 'image/jpeg';
    const ext = contentType.includes('png') ? 'png' : 'jpg';
    const key = `inputs/${userId}/${crypto.randomUUID()}.${ext}`;
    await env.IMAGES.put(key, imageData, {
      httpMetadata: { contentType },
    });
    const imageUrl = buildAssetUrl(env, key);
    return Response.json({ url: imageUrl });
  }

  // POST /api/chat
  if (path === '/chat' && request.method === 'POST') {
    const body = await readRequestJson(request, submitChatRequestSchema);

    // Validate messages
    if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
      return new Response(JSON.stringify({ error: 'messages array required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    for (const msg of body.messages) {
      if (!msg.role || !msg.content) {
        return new Response(
          JSON.stringify({ error: 'Each message must have role and content' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
      }
    }

    const submitBody = {
      ...body,
      client_id: `client_${userId.slice(-8)}`,
    };

    const doRequest = new Request(`${url.origin}/internal/chat/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-User-Id': userId },
      body: JSON.stringify(submitBody),
    });

    return relay.fetch(doRequest);
  }

  // POST /api/tools/run
  if (path === '/tools/run' && request.method === 'POST') {
    const body = await readRequestJson(request, submitToolRequestSchema);

    const submitBody = {
      ...body,
      client_id: `client_${userId.slice(-8)}`,
      relay_origin: url.origin,
    };

    const doRequest = new Request(`${url.origin}/internal/tool/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-User-Id': userId },
      body: JSON.stringify(submitBody),
    });

    return relay.fetch(doRequest);
  }

  // GET/DELETE /api/tools/jobs/:tool_id
  const toolMatch = path.match(/^\/tools\/jobs\/([^/]+)$/);
  if (toolMatch && request.method === 'GET') {
    const toolId = toolMatch[1];
    const doRequest = new Request(`${url.origin}/internal/tool/${toolId}`);
    const response = await relay.fetch(doRequest);
    if (response.ok) {
      return Response.json(await readResponseJson(response, toolStatusResponseSchema));
    }
    return response;
  }
  if (toolMatch && request.method === 'DELETE') {
    const toolId = toolMatch[1];
    const doRequest = new Request(`${url.origin}/internal/tool/${toolId}`, {
      method: 'DELETE',
    });
    return relay.fetch(doRequest);
  }

  // GET /api/chat/:chat_id
  const chatMatch = path.match(/^\/chat\/([^/]+)$/);
  if (chatMatch && request.method === 'GET') {
    const chatId = chatMatch[1];
    const doRequest = new Request(`${url.origin}/internal/chat/${chatId}`);
    return relay.fetch(doRequest);
  }

  // POST /api/talk
  if (path === '/talk' && request.method === 'POST') {
    const body = await readRequestJson(request, submitTalkRequestSchema);

    if (!body.text || typeof body.text !== 'string' || body.text.trim().length === 0) {
      return new Response(JSON.stringify({ error: 'text is required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const submitBody = {
      ...body,
      client_id: `client_${userId.slice(-8)}`,
      relay_origin: url.origin,
    };

    const doRequest = new Request(`${url.origin}/internal/talk/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-User-Id': userId },
      body: JSON.stringify(submitBody),
    });

    return relay.fetch(doRequest);
  }

  // GET /api/talk/:talk_id
  const talkMatch = path.match(/^\/talk\/([^/]+)$/);
  if (talkMatch && request.method === 'GET') {
    const talkId = talkMatch[1];
    const doRequest = new Request(`${url.origin}/internal/talk/${talkId}`);
    const response = await relay.fetch(doRequest);

    // For direct_audio talks that are complete, fetch from R2 and return base64
    if (response.ok) {
      const talk = await readResponseJson(response, talkStatusResponseSchema);
      if (talk.status === 'complete' && talk.direct_audio && talk.result?.audio_url && !talk.result?.audio_data) {
        const audioData = await getAndDeleteAudio(env, userId, talkId);
        if (audioData) {
          talk.result.audio_data = audioData;
        }
      }
      return Response.json(talk);
    }
    return response;
  }
  if (talkMatch && request.method === 'DELETE') {
    const talkId = talkMatch[1];
    const doRequest = new Request(`${url.origin}/internal/talk/${talkId}`, {
      method: 'DELETE',
    });
    return relay.fetch(doRequest);
  }

  // DELETE /api/talk/:talk_id/audio
  const talkAudioMatch = path.match(/^\/talk\/([^/]+)\/audio$/);
  if (talkAudioMatch && request.method === 'DELETE') {
    const talkId = talkAudioMatch[1];
    const doRequest = new Request(`${url.origin}/internal/talk/${talkId}/audio`, {
      method: 'DELETE',
    });
    return relay.fetch(doRequest);
  }

  // POST /api/asr
  if (path === '/asr' && request.method === 'POST') {
    const body = await readRequestJson(request, submitAsrRequestSchema);

    if (!body.audio_url || typeof body.audio_url !== 'string' || body.audio_url.trim().length === 0) {
      return new Response(JSON.stringify({ error: 'audio_url is required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const submitBody = {
      ...body,
      client_id: `client_${userId.slice(-8)}`,
    };

    const doRequest = new Request(`${url.origin}/internal/asr/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-User-Id': userId },
      body: JSON.stringify(submitBody),
    });

    return relay.fetch(doRequest);
  }

  // GET /api/asr/:asr_id
  const asrMatch = path.match(/^\/asr\/([^/]+)$/);
  if (asrMatch && request.method === 'GET') {
    const asrId = asrMatch[1];
    const doRequest = new Request(`${url.origin}/internal/asr/${asrId}`);
    const response = await relay.fetch(doRequest);

    if (response.ok) {
      const asr = await readResponseJson(response, asrStatusResponseSchema);
      return Response.json(asr);
    }
    return response;
  }
  if (asrMatch && request.method === 'DELETE') {
    const asrId = asrMatch[1];
    const doRequest = new Request(`${url.origin}/internal/asr/${asrId}`, {
      method: 'DELETE',
    });
    return relay.fetch(doRequest);
  }

  // POST /api/embed
  if (path === '/embed' && request.method === 'POST') {
    const body = await readRequestJson(request, submitEmbedRequestSchema);
    if (!Array.isArray(body.texts) || body.texts.length === 0) {
      return new Response(JSON.stringify({ error: 'texts[] is required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (body.texts.length > EMBED_MAX_TEXTS) {
      return new Response(
        JSON.stringify({ error: `Too many texts (max ${EMBED_MAX_TEXTS})` }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }
    let totalBytes = 0;
    for (const text of body.texts) {
      if (typeof text !== 'string') {
        return new Response(JSON.stringify({ error: 'texts[] must contain strings' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      totalBytes += new TextEncoder().encode(text).byteLength;
    }
    if (totalBytes > EMBED_MAX_TOTAL_BYTES) {
      return new Response(
        JSON.stringify({ error: `Payload too large (max ${EMBED_MAX_TOTAL_BYTES} bytes)` }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const submitBody = {
      ...body,
      client_id: `client_${userId.slice(-8)}`,
    };

    const doRequest = new Request(`${url.origin}/internal/embed/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-User-Id': userId },
      body: JSON.stringify(submitBody),
    });

    return relay.fetch(doRequest);
  }

  // GET /api/embed/:embed_id
  const embedMatch = path.match(/^\/embed\/([^/]+)$/);
  if (embedMatch && request.method === 'GET') {
    const embedId = embedMatch[1];
    const doRequest = new Request(`${url.origin}/internal/embed/${embedId}`);
    const response = await relay.fetch(doRequest);

    if (response.ok) {
      const embed = await readResponseJson(response, embedStatusResponseSchema);
      return Response.json(embed);
    }
    return response;
  }
  if (embedMatch && request.method === 'DELETE') {
    const embedId = embedMatch[1];
    const doRequest = new Request(`${url.origin}/internal/embed/${embedId}`, {
      method: 'DELETE',
    });
    return relay.fetch(doRequest);
  }

  // POST /api/ocr
  if (path === '/ocr' && request.method === 'POST') {
    const body = await readRequestJson(request, submitOcrRequestSchema);

    if (!body.image_url || typeof body.image_url !== 'string' || body.image_url.trim().length === 0) {
      return new Response(JSON.stringify({ error: 'image_url is required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const submitBody = {
      ...body,
      client_id: `client_${userId.slice(-8)}`,
    };

    const doRequest = new Request(`${url.origin}/internal/ocr/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-User-Id': userId },
      body: JSON.stringify(submitBody),
    });

    return relay.fetch(doRequest);
  }

  // GET /api/ocr/:ocr_id
  const ocrMatch = path.match(/^\/ocr\/([^/]+)$/);
  if (ocrMatch && request.method === 'GET') {
    const ocrId = ocrMatch[1];
    const doRequest = new Request(`${url.origin}/internal/ocr/${ocrId}`);
    const response = await relay.fetch(doRequest);

    if (response.ok) {
      const ocr = await readResponseJson(response, ocrStatusResponseSchema);
      return Response.json(ocr);
    }
    return response;
  }
  if (ocrMatch && request.method === 'DELETE') {
    const ocrId = ocrMatch[1];
    const doRequest = new Request(`${url.origin}/internal/ocr/${ocrId}`, {
      method: 'DELETE',
    });
    return relay.fetch(doRequest);
  }

  return new Response('Not Found', { status: 404 });
}
