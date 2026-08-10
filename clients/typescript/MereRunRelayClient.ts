import {
  type JsonGuard,
  isAbortError,
  isAsrStatusResponse,
  isCancelResponse,
  isChatStatusResponse,
  isDeleteResponse,
  isEmbedStatusResponse,
  isErrorResponse,
  isJobStatusResponse,
  isJobStreamConnectedEvent,
  isJobStreamDoneEvent,
  isOcrStatusResponse,
  isStatusResponse,
  isSubmitAsrResponse,
  isSubmitChatResponse,
  isSubmitEmbedResponse,
  isSubmitJobResponse,
  isSubmitOcrResponse,
  isSubmitTalkResponse,
  isTalkStatusResponse,
  isUploadResponse,
} from './runtime-contracts';

export const DEFAULT_MERE_RUN_RELAY_BASE_URL = 'https://relay.mere.run';
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;

export type MereRunRelayAuthorization =
  | { scheme: 'bearer'; token: string }
  | { scheme: 'header'; value: string };

export interface MereRunRelayClientOptions {
  authorization: MereRunRelayAuthorization | string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface PollOptions<T> {
  intervalMs?: number;
  timeoutMs?: number;
  onUpdate?: (status: T) => void;
}

export interface JobStreamConnectedEvent {
  job_id: string;
}

export interface JobStreamDoneEvent {
  job_id: string;
  status: JobStatus;
}

export interface JobStreamEvent {
  type: string;
  data: unknown;
}

export interface JobStreamOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  onConnected?: (event: JobStreamConnectedEvent) => void;
  onUpdate?: (status: JobStatusResponse) => void;
  onDone?: (event: JobStreamDoneEvent) => void;
  onError?: (payload: unknown) => void;
  onEvent?: (event: JobStreamEvent) => void;
}

export interface AgentCapabilities {
  models: string[];
  max_resolution: number;
  controlnet: boolean;
  lora: boolean;
  img2img: boolean;
}

export interface AgentStatus {
  agent_id: string;
  device_name: string;
  status: 'online' | 'busy' | 'offline';
  last_seen: string;
  current_job_id: string | null;
  capabilities: AgentCapabilities;
}

export interface StatusResponse {
  agents: AgentStatus[];
  queue_depth: number;
}

export interface JobRequest {
  kind?: 'image' | 'music' | 'video';
  prompt: string;
  negative_prompt: string | null;
  width: number;
  height: number;
  steps: number;
  seed: number | null;
  input_image_url: string | null;
  input_image_data: string | null;
  input_strength: number | null;
  model?: string;
  duration_seconds?: number;
  fps?: number;
  num_frames?: number;
  lyrics?: string;
}

export interface JobResult {
  image_url?: string;
  image_data?: string;
  media_url?: string;
  media_data?: string;
  content_type?: string;
  output_kind?: 'image' | 'music' | 'video';
  seed: number;
  generation_time_ms: number;
}

export type JobStatus =
  | 'queued'
  | 'assigned'
  | 'generating'
  | 'complete'
  | 'failed'
  | 'cancelled';

export interface SubmitJobRequest {
  kind?: 'image' | 'music' | 'video';
  prompt: string;
  negative_prompt?: string;
  width?: number;
  height?: number;
  steps?: number;
  seed?: number;
  input_image_url?: string;
  input_image_data?: string;
  input_strength?: number;
  model?: string;
  agent_id?: string;
  webhook_url?: string;
  direct_image?: boolean;
  duration_seconds?: number;
  fps?: number;
  num_frames?: number;
  lyrics?: string;
}

export type SubmitVideoRequest = SubmitJobRequest;
export type SubmitMusicRequest = SubmitJobRequest;

export interface SubmitJobResponse {
  job_id: string;
  status: 'assigned' | 'queued';
  agent_id?: string;
  position?: number;
  estimated_time_ms: number;
}

export interface JobStatusResponse {
  job_id: string;
  user_id: string;
  client_id: string;
  agent_id: string | null;
  status: JobStatus;
  request: JobRequest;
  progress: { step: number; total_steps: number } | null;
  result: JobResult | null;
  error: string | null;
  created_at: string;
  assigned_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  direct_image: boolean;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  image_url?: string;
}

export interface TextAdapterReference {
  manifest_sha256: string;
  base_model_id: string;
  scale?: number;
}

export interface IdentityExecutionReference {
  persona_id: string;
  version_id: string;
  deployment_id: string;
}

export interface RelayExecutionReceipt {
  schema: 'relay.execution-receipt.v1';
  execution_id: string;
  request_sha256: string;
  execution_spec_sha256?: string;
  model_id: string;
  adapter_manifest_sha256?: string;
  provider_id: string;
  provider_version?: string;
  provider_catalog_sha256?: string;
  device_id?: string;
  started_at: string | null;
  completed_at: string;
  duration_ms?: number;
  state: 'complete' | 'failed' | 'cancelled';
  output_sha256?: string;
  error_code?: string;
}

export interface SubmitChatRequest {
  messages: ChatMessage[];
  max_tokens?: number;
  temperature?: number;
  requires_json?: boolean;
  use_lora?: boolean;
  adapter?: TextAdapterReference;
  required_device_id?: string;
  execution_spec_sha256?: string;
  identity?: IdentityExecutionReference;
  idempotency_key?: string;
  model?: string;
}

export interface SubmitChatResponse {
  chat_id: string;
  status: 'assigned' | 'queued' | 'complete' | 'failed' | 'cancelled';
  agent_id?: string;
  position?: number;
}

export type ChatStatus = 'queued' | 'processing' | 'complete' | 'failed' | 'cancelled';

export interface ChatStatusResponse {
  chat_id: string;
  user_id: string;
  client_id: string;
  agent_id: string | null;
  status: ChatStatus;
  messages: ChatMessage[];
  response: string | null;
  tokens_generated: number | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  execution_receipt?: RelayExecutionReceipt | null;
}

export interface TalkRequest {
  text: string;
  voice_description: string | null;
  speed: number;
  temperature: number;
  output_format: 'wav';
}

export interface TalkResult {
  audio_url?: string;
  audio_data?: string;
  duration_seconds: number;
  sample_rate: number;
  output_format: 'wav';
}

export interface SubmitTalkRequest {
  text: string;
  voice_description?: string;
  speed?: number;
  temperature?: number;
  output_format?: 'wav';
  direct_audio?: boolean;
}

export interface SubmitTalkResponse {
  talk_id: string;
  status: 'assigned' | 'queued';
  agent_id?: string;
  position?: number;
}

export type TalkStatus = 'queued' | 'processing' | 'complete' | 'failed' | 'cancelled';

export interface TalkStatusResponse {
  talk_id: string;
  user_id: string;
  client_id: string;
  agent_id: string | null;
  status: TalkStatus;
  request: TalkRequest;
  result: TalkResult | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  direct_audio: boolean;
}

export type AsrTask = 'transcribe' | 'translate';
export type AsrBackend = 'auto' | 'parakeet' | 'qwen';
export type AsrStatus = 'queued' | 'processing' | 'complete' | 'failed' | 'cancelled';
export type EmbedStatus = 'queued' | 'processing' | 'complete' | 'failed' | 'cancelled';

export interface AsrRequest {
  audio_url: string;
  language: string | null;
  task: AsrTask;
  backend?: AsrBackend;
  diarize: boolean;
  max_tokens: number;
}

export interface AsrTokenAlignment {
  id?: number;
  text: string;
  start_seconds: number;
  duration_seconds: number;
  end_seconds: number;
}

export interface AsrSentenceAlignment {
  text: string;
  start_seconds: number;
  duration_seconds: number;
  end_seconds: number;
  tokens: AsrTokenAlignment[];
}

export interface AsrSpeakerSegment {
  speaker: string;
  speaker_index: number;
  start_seconds: number;
  end_seconds: number;
  duration_seconds: number;
}

export interface AsrResult {
  text: string;
  language: string | null;
  duration_seconds: number;
  token_alignments?: AsrTokenAlignment[];
  sentence_alignments?: AsrSentenceAlignment[];
  speaker_segments?: AsrSpeakerSegment[];
}

export interface SubmitAsrRequest {
  audio_url: string;
  language?: string;
  task?: AsrTask;
  backend?: AsrBackend;
  diarize?: boolean;
  max_tokens?: number;
}

export interface SubmitAsrResponse {
  asr_id: string;
  status: 'assigned' | 'queued';
  agent_id?: string;
  position?: number;
}

export interface AsrStatusResponse {
  asr_id: string;
  user_id: string;
  client_id: string;
  agent_id: string | null;
  status: AsrStatus;
  request: AsrRequest;
  result: AsrResult | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

export interface EmbedRequest {
  texts: string[];
  model: string;
  max_tokens: number;
}

export interface EmbedDataRow {
  index: number;
  embedding: number[];
}

export interface EmbedResult {
  model: string;
  dimensions: number;
  data: EmbedDataRow[];
}

export interface SubmitEmbedRequest {
  texts: string[];
  model?: string;
  max_tokens?: number;
}

export interface SubmitEmbedResponse {
  embed_id: string;
  status: 'assigned' | 'queued';
  agent_id?: string;
  position?: number;
}

export interface EmbedStatusResponse {
  embed_id: string;
  user_id: string;
  client_id: string;
  agent_id: string | null;
  status: EmbedStatus;
  request: EmbedRequest;
  result: EmbedResult | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

export type OcrStatus = 'queued' | 'processing' | 'complete' | 'failed' | 'cancelled';

export interface OcrRequest {
  image_url: string;
  max_tokens: number;
  temperature: number;
}

export interface OcrResult {
  text: string;
  tokens_generated: number;
}

export interface SubmitOcrRequest {
  image_url: string;
  max_tokens?: number;
  temperature?: number;
}

export interface SubmitOcrResponse {
  ocr_id: string;
  status: 'assigned' | 'queued';
  agent_id?: string;
  position?: number;
}

export interface OcrStatusResponse {
  ocr_id: string;
  user_id: string;
  client_id: string;
  agent_id: string | null;
  status: OcrStatus;
  request: OcrRequest;
  result: OcrResult | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

export interface CancelJobResponse {
  cancelled: boolean;
}

export interface CancelTalkResponse {
  cancelled: boolean;
}

export interface CancelAsrResponse {
  cancelled: boolean;
}

export interface CancelEmbedResponse {
  cancelled: boolean;
}

export interface CancelOcrResponse {
  cancelled: boolean;
}

export interface DeleteJobImageResponse {
  deleted: boolean;
}

export interface DeleteTalkAudioResponse {
  deleted: boolean;
}

export interface InputUploadResponse {
  url: string;
}

export interface AsrInputUploadResponse {
  url: string;
}

export interface OcrInputUploadResponse {
  url: string;
}

export interface ErrorResponse {
  error?: string;
  code?: string;
}

export class MereRunRelayHttpError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly payload: unknown;

  constructor(status: number, message: string, code?: string, payload?: unknown) {
    super(message);
    this.name = 'MereRunRelayHttpError';
    this.status = status;
    this.code = code;
    this.payload = payload;
  }
}

export class MereRunRelayClient {
  private readonly baseUrl: string;
  private readonly authorizationHeader: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: MereRunRelayClientOptions) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_MERE_RUN_RELAY_BASE_URL).replace(/\/+$/, '');
    this.authorizationHeader = buildAuthorizationHeader(options.authorization);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async getStatus(): Promise<StatusResponse> {
    return this.request('/status', isStatusResponse);
  }

  async submitJob(request: SubmitJobRequest): Promise<SubmitJobResponse> {
    return this.request('/generate', isSubmitJobResponse, {
      method: 'POST',
      body: JSON.stringify(request),
    });
  }

  async submitVideo(request: SubmitVideoRequest): Promise<SubmitJobResponse> {
    return this.request('/video', isSubmitJobResponse, {
      method: 'POST',
      body: JSON.stringify(request),
    });
  }

  async submitMusic(request: SubmitMusicRequest): Promise<SubmitJobResponse> {
    return this.request('/music', isSubmitJobResponse, {
      method: 'POST',
      body: JSON.stringify(request),
    });
  }

  async getJob(jobId: string): Promise<JobStatusResponse> {
    return this.request(`/job/${encodeURIComponent(jobId)}`, isJobStatusResponse);
  }

  async cancelJob(jobId: string): Promise<CancelJobResponse> {
    return this.request(`/job/${encodeURIComponent(jobId)}`, isCancelResponse, {
      method: 'DELETE',
    });
  }

  async deleteJobImage(jobId: string): Promise<DeleteJobImageResponse> {
    return this.request(`/job/${encodeURIComponent(jobId)}/image`, isDeleteResponse, {
      method: 'DELETE',
    });
  }

  async uploadInputImage(
    image: Uint8Array | ArrayBuffer,
    contentType = 'image/jpeg'
  ): Promise<InputUploadResponse> {
    const source = image instanceof Uint8Array ? image : new Uint8Array(image);
    const bytes = new Uint8Array(source.byteLength);
    bytes.set(source);
    const body = new Blob([bytes], { type: contentType });
    return this.request('/input-upload', isUploadResponse, {
      method: 'POST',
      body,
      headers: { 'Content-Type': contentType },
    });
  }

  async uploadAsrInputAudio(
    audio: Uint8Array | ArrayBuffer,
    contentType = 'audio/wav'
  ): Promise<AsrInputUploadResponse> {
    const source = audio instanceof Uint8Array ? audio : new Uint8Array(audio);
    const bytes = new Uint8Array(source.byteLength);
    bytes.set(source);
    const body = new Blob([bytes], { type: contentType });
    return this.request('/asr/input-upload', isUploadResponse, {
      method: 'POST',
      body,
      headers: { 'Content-Type': contentType },
    });
  }

  async uploadOcrInputImage(
    image: Uint8Array | ArrayBuffer,
    contentType = 'image/jpeg'
  ): Promise<OcrInputUploadResponse> {
    const source = image instanceof Uint8Array ? image : new Uint8Array(image);
    const bytes = new Uint8Array(source.byteLength);
    bytes.set(source);
    const body = new Blob([bytes], { type: contentType });
    return this.request('/ocr/input-upload', isUploadResponse, {
      method: 'POST',
      body,
      headers: { 'Content-Type': contentType },
    });
  }

  async pollJob(
    jobId: string,
    options?: PollOptions<JobStatusResponse>
  ): Promise<JobStatusResponse> {
    const intervalMs = options?.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const timeoutMs = options?.timeoutMs ?? this.timeoutMs;
    const startedAt = Date.now();

    while (Date.now() - startedAt <= timeoutMs) {
      const status = await this.getJob(jobId);
      options?.onUpdate?.(status);

      if (
        status.status === 'complete' ||
        status.status === 'failed' ||
        status.status === 'cancelled'
      ) {
        return status;
      }

      await sleep(intervalMs);
    }

    throw new Error(`Polling timed out for job ${jobId} after ${timeoutMs}ms`);
  }

  async subscribeJobStream(
    jobId: string,
    options?: JobStreamOptions
  ): Promise<JobStatusResponse> {
    const timeoutMs = options?.timeoutMs ?? this.timeoutMs;
    const headers = new Headers();
    headers.set('Authorization', this.authorizationHeader);
    headers.set('Accept', 'text/event-stream');

    const controller = new AbortController();
    const abortSignal = controller.signal;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let externalAbortListener: (() => void) | undefined;

    if (timeoutMs > 0) {
      timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    }

    if (options?.signal) {
      if (options.signal.aborted) {
        controller.abort();
      } else {
        externalAbortListener = (): void => controller.abort();
        options.signal.addEventListener('abort', externalAbortListener, { once: true });
      }
    }

    try {
      let response: Response;
      try {
        response = await this.fetchImpl(
          `${this.baseUrl}/api/job/${encodeURIComponent(jobId)}/stream`,
          {
            method: 'GET',
            headers,
            signal: abortSignal,
          }
        );
      } catch (error) {
        if (isAbortError(error) && !options?.signal?.aborted) {
          throw new Error(`Stream timed out for job ${jobId} after ${timeoutMs}ms`);
        }
        throw error;
      }

      if (!response.ok) {
        const responseText = await response.text();
        const responsePayload = responseText ? safeParseJson(responseText) : undefined;
        const errorPayload = isErrorResponse(responsePayload) ? responsePayload : undefined;
        throw new MereRunRelayHttpError(
          response.status,
          errorPayload?.error ?? `HTTP ${response.status}`,
          errorPayload?.code,
          responsePayload
        );
      }

      if (!response.body) {
        throw new Error('SSE response body is missing');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let lastStatus: JobStatusResponse | null = null;
      let doneEvent: JobStreamDoneEvent | null = null;

      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');

        let boundary = buffer.indexOf('\n\n');
        while (boundary !== -1) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const parsed = parseSseEventBlock(block);
          if (!parsed) {
            boundary = buffer.indexOf('\n\n');
            continue;
          }

          options?.onEvent?.({ type: parsed.event, data: parsed.data });

          if (parsed.event === 'connected') {
            if (!isJobStreamConnectedEvent(parsed.data)) {
              throw new TypeError('SSE connected event does not match its JSON contract');
            }
            options?.onConnected?.(parsed.data);
          } else if (parsed.event === 'job') {
            if (!isJobStatusResponse(parsed.data)) {
              throw new TypeError('SSE job event does not match its JSON contract');
            }
            lastStatus = parsed.data;
            options?.onUpdate?.(lastStatus);
          } else if (parsed.event === 'done') {
            if (!isJobStreamDoneEvent(parsed.data)) {
              throw new TypeError('SSE done event does not match its JSON contract');
            }
            doneEvent = parsed.data;
            options?.onDone?.(doneEvent);
          } else if (parsed.event === 'error') {
            options?.onError?.(parsed.data);
            const message = isErrorResponse(parsed.data) && parsed.data.error
              ? parsed.data.error
              : `SSE stream error for job ${jobId}`;
            throw new Error(message);
          }

          boundary = buffer.indexOf('\n\n');
        }
      }

      buffer += decoder.decode().replace(/\r\n/g, '\n');
      if (buffer.trim().length > 0) {
        const parsed = parseSseEventBlock(buffer);
        if (parsed) {
          options?.onEvent?.({ type: parsed.event, data: parsed.data });
          if (parsed.event === 'job') {
            if (!isJobStatusResponse(parsed.data)) {
              throw new TypeError('SSE job event does not match its JSON contract');
            }
            lastStatus = parsed.data;
            options?.onUpdate?.(lastStatus);
          } else if (parsed.event === 'done') {
            if (!isJobStreamDoneEvent(parsed.data)) {
              throw new TypeError('SSE done event does not match its JSON contract');
            }
            doneEvent = parsed.data;
            options?.onDone?.(doneEvent);
          } else if (parsed.event === 'error') {
            options?.onError?.(parsed.data);
            const message = isErrorResponse(parsed.data) && parsed.data.error
              ? parsed.data.error
              : `SSE stream error for job ${jobId}`;
            throw new Error(message);
          }
        }
      }

      if (doneEvent && lastStatus && lastStatus.status === doneEvent.status) {
        return lastStatus;
      }

      if (
        lastStatus &&
        (lastStatus.status === 'complete' || lastStatus.status === 'failed' || lastStatus.status === 'cancelled')
      ) {
        return lastStatus;
      }

      return this.getJob(jobId);
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      if (options?.signal && externalAbortListener) {
        options.signal.removeEventListener('abort', externalAbortListener);
      }
    }
  }

  async generate(
    request: SubmitJobRequest,
    options?: PollOptions<JobStatusResponse>
  ): Promise<JobStatusResponse> {
    const submission = await this.submitJob(request);
    return this.pollJob(submission.job_id, options);
  }

  async video(
    request: SubmitVideoRequest,
    options?: PollOptions<JobStatusResponse>
  ): Promise<JobStatusResponse> {
    const submission = await this.submitVideo(request);
    return this.pollJob(submission.job_id, options);
  }

  async music(
    request: SubmitMusicRequest,
    options?: PollOptions<JobStatusResponse>
  ): Promise<JobStatusResponse> {
    const submission = await this.submitMusic(request);
    return this.pollJob(submission.job_id, options);
  }

  async submitChat(request: SubmitChatRequest): Promise<SubmitChatResponse> {
    return this.request('/chat', isSubmitChatResponse, {
      method: 'POST',
      body: JSON.stringify(request),
    });
  }

  async getChat(chatId: string): Promise<ChatStatusResponse> {
    return this.request(`/chat/${encodeURIComponent(chatId)}`, isChatStatusResponse);
  }

  async cancelChat(chatId: string): Promise<CancelJobResponse> {
    return this.request(`/chat/${encodeURIComponent(chatId)}/cancel`, isCancelResponse, {
      method: 'POST',
    });
  }

  async pollChat(
    chatId: string,
    options?: PollOptions<ChatStatusResponse>
  ): Promise<ChatStatusResponse> {
    const intervalMs = options?.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const timeoutMs = options?.timeoutMs ?? this.timeoutMs;
    const startedAt = Date.now();

    while (Date.now() - startedAt <= timeoutMs) {
      const status = await this.getChat(chatId);
      options?.onUpdate?.(status);

      if (status.status === 'complete' || status.status === 'failed' || status.status === 'cancelled') {
        return status;
      }

      await sleep(intervalMs);
    }

    throw new Error(`Polling timed out for chat ${chatId} after ${timeoutMs}ms`);
  }

  async chat(
    request: SubmitChatRequest,
    options?: PollOptions<ChatStatusResponse>
  ): Promise<ChatStatusResponse> {
    const submission = await this.submitChat(request);
    return this.pollChat(submission.chat_id, options);
  }

  async submitTalk(request: SubmitTalkRequest): Promise<SubmitTalkResponse> {
    return this.request('/talk', isSubmitTalkResponse, {
      method: 'POST',
      body: JSON.stringify(request),
    });
  }

  async getTalk(talkId: string): Promise<TalkStatusResponse> {
    return this.request(`/talk/${encodeURIComponent(talkId)}`, isTalkStatusResponse);
  }

  async deleteTalkAudio(talkId: string): Promise<DeleteTalkAudioResponse> {
    return this.request(`/talk/${encodeURIComponent(talkId)}/audio`, isDeleteResponse, {
      method: 'DELETE',
    });
  }

  async cancelTalk(talkId: string): Promise<CancelTalkResponse> {
    return this.request(`/talk/${encodeURIComponent(talkId)}`, isCancelResponse, {
      method: 'DELETE',
    });
  }

  async pollTalk(
    talkId: string,
    options?: PollOptions<TalkStatusResponse>
  ): Promise<TalkStatusResponse> {
    const intervalMs = options?.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const timeoutMs = options?.timeoutMs ?? this.timeoutMs;
    const startedAt = Date.now();

    while (Date.now() - startedAt <= timeoutMs) {
      const status = await this.getTalk(talkId);
      options?.onUpdate?.(status);

      if (status.status === 'complete' || status.status === 'failed' || status.status === 'cancelled') {
        return status;
      }

      await sleep(intervalMs);
    }

    throw new Error(`Polling timed out for talk ${talkId} after ${timeoutMs}ms`);
  }

  async talk(
    request: SubmitTalkRequest,
    options?: PollOptions<TalkStatusResponse>
  ): Promise<TalkStatusResponse> {
    const submission = await this.submitTalk(request);
    return this.pollTalk(submission.talk_id, options);
  }

  async submitAsr(request: SubmitAsrRequest): Promise<SubmitAsrResponse> {
    return this.request('/asr', isSubmitAsrResponse, {
      method: 'POST',
      body: JSON.stringify(request),
    });
  }

  async getAsr(asrId: string): Promise<AsrStatusResponse> {
    return this.request(`/asr/${encodeURIComponent(asrId)}`, isAsrStatusResponse);
  }

  async cancelAsr(asrId: string): Promise<CancelAsrResponse> {
    return this.request(`/asr/${encodeURIComponent(asrId)}`, isCancelResponse, {
      method: 'DELETE',
    });
  }

  async pollAsr(
    asrId: string,
    options?: PollOptions<AsrStatusResponse>
  ): Promise<AsrStatusResponse> {
    const intervalMs = options?.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const timeoutMs = options?.timeoutMs ?? this.timeoutMs;
    const startedAt = Date.now();

    while (Date.now() - startedAt <= timeoutMs) {
      const status = await this.getAsr(asrId);
      options?.onUpdate?.(status);

      if (status.status === 'complete' || status.status === 'failed' || status.status === 'cancelled') {
        return status;
      }

      await sleep(intervalMs);
    }

    throw new Error(`Polling timed out for ASR ${asrId} after ${timeoutMs}ms`);
  }

  async asr(
    request: SubmitAsrRequest,
    options?: PollOptions<AsrStatusResponse>
  ): Promise<AsrStatusResponse> {
    const submission = await this.submitAsr(request);
    return this.pollAsr(submission.asr_id, options);
  }

  async submitEmbed(request: SubmitEmbedRequest): Promise<SubmitEmbedResponse> {
    return this.request('/embed', isSubmitEmbedResponse, {
      method: 'POST',
      body: JSON.stringify(request),
    });
  }

  async getEmbed(embedId: string): Promise<EmbedStatusResponse> {
    return this.request(`/embed/${encodeURIComponent(embedId)}`, isEmbedStatusResponse);
  }

  async cancelEmbed(embedId: string): Promise<CancelEmbedResponse> {
    return this.request(`/embed/${encodeURIComponent(embedId)}`, isCancelResponse, {
      method: 'DELETE',
    });
  }

  async pollEmbed(
    embedId: string,
    options?: PollOptions<EmbedStatusResponse>
  ): Promise<EmbedStatusResponse> {
    const intervalMs = options?.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const timeoutMs = options?.timeoutMs ?? this.timeoutMs;
    const startedAt = Date.now();

    while (Date.now() - startedAt <= timeoutMs) {
      const status = await this.getEmbed(embedId);
      options?.onUpdate?.(status);

      if (status.status === 'complete' || status.status === 'failed' || status.status === 'cancelled') {
        return status;
      }

      await sleep(intervalMs);
    }

    throw new Error(`Polling timed out for embed ${embedId} after ${timeoutMs}ms`);
  }

  async embed(
    request: SubmitEmbedRequest,
    options?: PollOptions<EmbedStatusResponse>
  ): Promise<EmbedStatusResponse> {
    const submission = await this.submitEmbed(request);
    return this.pollEmbed(submission.embed_id, options);
  }

  async submitOcr(request: SubmitOcrRequest): Promise<SubmitOcrResponse> {
    return this.request('/ocr', isSubmitOcrResponse, {
      method: 'POST',
      body: JSON.stringify(request),
    });
  }

  async getOcr(ocrId: string): Promise<OcrStatusResponse> {
    return this.request(`/ocr/${encodeURIComponent(ocrId)}`, isOcrStatusResponse);
  }

  async cancelOcr(ocrId: string): Promise<CancelOcrResponse> {
    return this.request(`/ocr/${encodeURIComponent(ocrId)}`, isCancelResponse, {
      method: 'DELETE',
    });
  }

  async pollOcr(
    ocrId: string,
    options?: PollOptions<OcrStatusResponse>
  ): Promise<OcrStatusResponse> {
    const intervalMs = options?.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const timeoutMs = options?.timeoutMs ?? this.timeoutMs;
    const startedAt = Date.now();

    while (Date.now() - startedAt <= timeoutMs) {
      const status = await this.getOcr(ocrId);
      options?.onUpdate?.(status);

      if (status.status === 'complete' || status.status === 'failed' || status.status === 'cancelled') {
        return status;
      }

      await sleep(intervalMs);
    }

    throw new Error(`Polling timed out for OCR ${ocrId} after ${timeoutMs}ms`);
  }

  async ocr(
    request: SubmitOcrRequest,
    options?: PollOptions<OcrStatusResponse>
  ): Promise<OcrStatusResponse> {
    const submission = await this.submitOcr(request);
    return this.pollOcr(submission.ocr_id, options);
  }

  private async request<T>(
    path: string,
    parser: JsonGuard<T>,
    init: RequestInit = {}
  ): Promise<T> {
    const url = `${this.baseUrl}/api${path}`;
    const headers = new Headers(init.headers);
    headers.set('Authorization', this.authorizationHeader);
    headers.set('Accept', 'application/json');

    if (typeof init.body === 'string' && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        ...init,
        headers,
        signal: controller.signal,
      });
    } catch (error) {
      if (isAbortError(error)) {
        throw new Error(`Request timed out after ${this.timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }

    const responseText = await response.text();
    const responsePayload = responseText ? safeParseJson(responseText) : undefined;

    if (!response.ok) {
      const errorPayload = isErrorResponse(responsePayload) ? responsePayload : undefined;
      throw new MereRunRelayHttpError(
        response.status,
        errorPayload?.error ?? `HTTP ${response.status}`,
        errorPayload?.code,
        responsePayload
      );
    }

    if (!parser(responsePayload)) {
      throw new TypeError(`Relay response for ${path} does not match its JSON contract`);
    }
    return responsePayload;
  }
}

function buildAuthorizationHeader(authorization: MereRunRelayAuthorization | string): string {
  if (typeof authorization === 'string') {
    const trimmed = authorization.trim();
    if (/^Bearer\s+/i.test(trimmed)) {
      return trimmed;
    }

    return `Bearer ${trimmed}`;
  }

  switch (authorization.scheme) {
    case 'bearer':
      return `Bearer ${authorization.token.trim()}`;
    case 'header':
      return authorization.value.trim();
  }
}

function safeParseJson(value: string): unknown {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed;
  } catch {
    return value;
  }
}

function parseSseEventBlock(block: string): { event: string; data: unknown } | null {
  const trimmed = block.trim();
  if (!trimmed) {
    return null;
  }

  let event = 'message';
  const dataLines: string[] = [];

  for (const rawLine of trimmed.split('\n')) {
    const line = rawLine.trimEnd();
    if (!line || line.startsWith(':')) {
      continue;
    }
    if (line.startsWith('event:')) {
      event = line.slice('event:'.length).trim();
      continue;
    }
    if (line.startsWith('data:')) {
      dataLines.push(line.slice('data:'.length).trimStart());
    }
  }

  if (dataLines.length === 0) {
    return null;
  }

  return {
    event,
    data: safeParseJson(dataLines.join('\n')),
  };
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
