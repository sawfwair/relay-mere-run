import type {
  AsrStatusResponse,
  CancelJobResponse,
  ChatStatusResponse,
  DeleteJobImageResponse,
  EmbedStatusResponse,
  ErrorResponse,
  InputUploadResponse,
  JobStatusResponse,
  JobStreamConnectedEvent,
  JobStreamDoneEvent,
  OcrStatusResponse,
  StatusResponse,
  SubmitAsrResponse,
  SubmitChatResponse,
  SubmitEmbedResponse,
  SubmitJobResponse,
  SubmitOcrResponse,
  SubmitTalkResponse,
  TalkStatusResponse,
} from './MereRunRelayClient';

export type JsonGuard<T> = (value: unknown) => value is T;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

function isNullableString(value: unknown): value is string | null {
  return value === null || isString(value);
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || isString(value);
}

function isOptionalNumber(value: unknown): value is number | undefined {
  return value === undefined || isNumber(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString);
}

function isOneOf(value: unknown, options: readonly string[]): value is string {
  return isString(value) && options.includes(value);
}

function isSubmission(value: unknown, idField: string): boolean {
  if (!isRecord(value)) return false;
  return isString(value[idField])
    && isOneOf(value.status, ['assigned', 'queued'])
    && isOptionalString(value.agent_id)
    && isOptionalNumber(value.position);
}

function hasCommonStatus(
  value: Record<string, unknown>,
  idField: string,
  statuses: readonly string[]
): boolean {
  return isString(value[idField])
    && isString(value.user_id)
    && isString(value.client_id)
    && isNullableString(value.agent_id)
    && isOneOf(value.status, statuses)
    && isNullableString(value.error)
    && isString(value.created_at)
    && isNullableString(value.started_at)
    && isNullableString(value.completed_at);
}

function isChatMessage(value: unknown): boolean {
  return isRecord(value)
    && isOneOf(value.role, ['system', 'user', 'assistant'])
    && isString(value.content)
    && isOptionalString(value.image_url);
}

function isJobRequest(value: unknown): boolean {
  return isRecord(value)
    && (value.kind === undefined || isOneOf(value.kind, ['image', 'music', 'video']))
    && isString(value.prompt)
    && isNullableString(value.negative_prompt)
    && isNumber(value.width)
    && isNumber(value.height)
    && isNumber(value.steps)
    && (value.seed === null || isNumber(value.seed))
    && isNullableString(value.input_image_url)
    && isNullableString(value.input_image_data)
    && (value.input_strength === null || isNumber(value.input_strength))
    && isOptionalString(value.model)
    && isOptionalNumber(value.duration_seconds)
    && isOptionalNumber(value.fps)
    && isOptionalNumber(value.num_frames)
    && isOptionalString(value.lyrics);
}

function isJobResult(value: unknown): boolean {
  return isRecord(value)
    && isOptionalString(value.image_url)
    && isOptionalString(value.image_data)
    && isOptionalString(value.media_url)
    && isOptionalString(value.media_data)
    && isOptionalString(value.content_type)
    && (value.output_kind === undefined || isOneOf(value.output_kind, ['image', 'music', 'video']))
    && isNumber(value.seed)
    && isNumber(value.generation_time_ms);
}

function isProgress(value: unknown): boolean {
  return value === null || (isRecord(value) && isNumber(value.step) && isNumber(value.total_steps));
}

function isTalkRequest(value: unknown): boolean {
  return isRecord(value)
    && isString(value.text)
    && isNullableString(value.voice_description)
    && isNumber(value.speed)
    && isNumber(value.temperature)
    && value.output_format === 'wav';
}

function isTalkResult(value: unknown): boolean {
  return isRecord(value)
    && isOptionalString(value.audio_url)
    && isOptionalString(value.audio_data)
    && isNumber(value.duration_seconds)
    && isNumber(value.sample_rate)
    && value.output_format === 'wav';
}

function isAsrToken(value: unknown): boolean {
  return isRecord(value)
    && isOptionalNumber(value.id)
    && isString(value.text)
    && isNumber(value.start_seconds)
    && isNumber(value.duration_seconds)
    && isNumber(value.end_seconds);
}

function isAsrSentence(value: unknown): boolean {
  return isRecord(value)
    && isString(value.text)
    && isNumber(value.start_seconds)
    && isNumber(value.duration_seconds)
    && isNumber(value.end_seconds)
    && Array.isArray(value.tokens)
    && value.tokens.every(isAsrToken);
}

function isAsrSpeakerSegment(value: unknown): boolean {
  return isRecord(value)
    && isString(value.speaker)
    && isNumber(value.speaker_index)
    && isNumber(value.start_seconds)
    && isNumber(value.end_seconds)
    && isNumber(value.duration_seconds);
}

function isAsrRequest(value: unknown): boolean {
  return isRecord(value)
    && isString(value.audio_url)
    && isNullableString(value.language)
    && isOneOf(value.task, ['transcribe', 'translate'])
    && (value.backend === undefined || isOneOf(value.backend, ['auto', 'parakeet', 'qwen']))
    && typeof value.diarize === 'boolean'
    && isNumber(value.max_tokens);
}

function isAsrResult(value: unknown): boolean {
  return isRecord(value)
    && isString(value.text)
    && isNullableString(value.language)
    && isNumber(value.duration_seconds)
    && (value.token_alignments === undefined
      || (Array.isArray(value.token_alignments) && value.token_alignments.every(isAsrToken)))
    && (value.sentence_alignments === undefined
      || (Array.isArray(value.sentence_alignments) && value.sentence_alignments.every(isAsrSentence)))
    && (value.speaker_segments === undefined
      || (Array.isArray(value.speaker_segments) && value.speaker_segments.every(isAsrSpeakerSegment)));
}

function isEmbedRequest(value: unknown): boolean {
  return isRecord(value)
    && isStringArray(value.texts)
    && isString(value.model)
    && isNumber(value.max_tokens);
}

function isEmbedRow(value: unknown): boolean {
  return isRecord(value)
    && isNumber(value.index)
    && Array.isArray(value.embedding)
    && value.embedding.every(isNumber);
}

function isEmbedResult(value: unknown): boolean {
  return isRecord(value)
    && isString(value.model)
    && isNumber(value.dimensions)
    && Array.isArray(value.data)
    && value.data.every(isEmbedRow);
}

function isOcrRequest(value: unknown): boolean {
  return isRecord(value)
    && isString(value.image_url)
    && isNumber(value.max_tokens)
    && isNumber(value.temperature);
}

function isOcrResult(value: unknown): boolean {
  return isRecord(value) && isString(value.text) && isNumber(value.tokens_generated);
}

export const isErrorResponse: JsonGuard<ErrorResponse> = (value): value is ErrorResponse =>
  isRecord(value) && isOptionalString(value.error) && isOptionalString(value.code);

export const isStatusResponse: JsonGuard<StatusResponse> = (value): value is StatusResponse => {
  if (!isRecord(value) || !isNumber(value.queue_depth) || !Array.isArray(value.agents)) return false;
  return value.agents.every((agent: unknown) => isRecord(agent)
    && isString(agent.agent_id)
    && isString(agent.device_name)
    && isOneOf(agent.status, ['online', 'busy', 'offline'])
    && isString(agent.last_seen)
    && isNullableString(agent.current_job_id)
    && isRecord(agent.capabilities)
    && isStringArray(agent.capabilities.models)
    && isNumber(agent.capabilities.max_resolution)
    && isBoolean(agent.capabilities.controlnet)
    && isBoolean(agent.capabilities.lora)
    && isBoolean(agent.capabilities.img2img));
};

export const isSubmitJobResponse: JsonGuard<SubmitJobResponse> = (value): value is SubmitJobResponse =>
  isSubmission(value, 'job_id') && isRecord(value) && isNumber(value.estimated_time_ms);
export const isSubmitChatResponse: JsonGuard<SubmitChatResponse> = (value): value is SubmitChatResponse =>
  isRecord(value)
    && isString(value.chat_id)
    && isOneOf(value.status, ['assigned', 'queued', 'complete', 'failed', 'cancelled'])
    && isOptionalString(value.agent_id)
    && isOptionalNumber(value.position);
export const isSubmitTalkResponse: JsonGuard<SubmitTalkResponse> = (value): value is SubmitTalkResponse =>
  isSubmission(value, 'talk_id');
export const isSubmitAsrResponse: JsonGuard<SubmitAsrResponse> = (value): value is SubmitAsrResponse =>
  isSubmission(value, 'asr_id');
export const isSubmitEmbedResponse: JsonGuard<SubmitEmbedResponse> = (value): value is SubmitEmbedResponse =>
  isSubmission(value, 'embed_id');
export const isSubmitOcrResponse: JsonGuard<SubmitOcrResponse> = (value): value is SubmitOcrResponse =>
  isSubmission(value, 'ocr_id');

export const isJobStatusResponse: JsonGuard<JobStatusResponse> = (value): value is JobStatusResponse => {
  if (!isRecord(value) || !hasCommonStatus(
    value,
    'job_id',
    ['queued', 'assigned', 'generating', 'complete', 'failed', 'cancelled']
  )) return false;
  return isJobRequest(value.request)
    && isProgress(value.progress)
    && (value.result === null || isJobResult(value.result))
    && isNullableString(value.assigned_at)
    && isBoolean(value.direct_image);
};

export const isChatStatusResponse: JsonGuard<ChatStatusResponse> = (value): value is ChatStatusResponse => {
  if (!isRecord(value) || !hasCommonStatus(
    value,
    'chat_id',
    ['queued', 'processing', 'complete', 'failed', 'cancelled']
  )) return false;
  return Array.isArray(value.messages)
    && value.messages.every(isChatMessage)
    && isNullableString(value.response)
    && (value.tokens_generated === null || isNumber(value.tokens_generated))
    && (value.execution_receipt === undefined
      || value.execution_receipt === null
      || (isRecord(value.execution_receipt)
        && value.execution_receipt.schema === 'relay.execution-receipt.v1'
        && isString(value.execution_receipt.execution_id)
        && isString(value.execution_receipt.request_sha256)
        && isString(value.execution_receipt.model_id)
        && isString(value.execution_receipt.provider_id)
        && isOneOf(value.execution_receipt.state, ['complete', 'failed', 'cancelled'])
        && isString(value.execution_receipt.completed_at)));
};

export const isTalkStatusResponse: JsonGuard<TalkStatusResponse> = (value): value is TalkStatusResponse => {
  if (!isRecord(value) || !hasCommonStatus(
    value,
    'talk_id',
    ['queued', 'processing', 'complete', 'failed', 'cancelled']
  )) return false;
  return isTalkRequest(value.request)
    && (value.result === null || isTalkResult(value.result))
    && isBoolean(value.direct_audio);
};

export const isAsrStatusResponse: JsonGuard<AsrStatusResponse> = (value): value is AsrStatusResponse => {
  if (!isRecord(value) || !hasCommonStatus(
    value,
    'asr_id',
    ['queued', 'processing', 'complete', 'failed', 'cancelled']
  )) return false;
  return isAsrRequest(value.request) && (value.result === null || isAsrResult(value.result));
};

export const isEmbedStatusResponse: JsonGuard<EmbedStatusResponse> = (value): value is EmbedStatusResponse => {
  if (!isRecord(value) || !hasCommonStatus(
    value,
    'embed_id',
    ['queued', 'processing', 'complete', 'failed', 'cancelled']
  )) return false;
  return isEmbedRequest(value.request) && (value.result === null || isEmbedResult(value.result));
};

export const isOcrStatusResponse: JsonGuard<OcrStatusResponse> = (value): value is OcrStatusResponse => {
  if (!isRecord(value) || !hasCommonStatus(
    value,
    'ocr_id',
    ['queued', 'processing', 'complete', 'failed', 'cancelled']
  )) return false;
  return isOcrRequest(value.request) && (value.result === null || isOcrResult(value.result));
};

export const isCancelResponse: JsonGuard<CancelJobResponse> = (value): value is CancelJobResponse =>
  isRecord(value) && isBoolean(value.cancelled);
export const isDeleteResponse: JsonGuard<DeleteJobImageResponse> = (value): value is DeleteJobImageResponse =>
  isRecord(value) && isBoolean(value.deleted);
export const isUploadResponse: JsonGuard<InputUploadResponse> = (value): value is InputUploadResponse =>
  isRecord(value) && isString(value.url);

export const isJobStreamConnectedEvent: JsonGuard<JobStreamConnectedEvent> =
  (value): value is JobStreamConnectedEvent => isRecord(value) && isString(value.job_id);
export const isJobStreamDoneEvent: JsonGuard<JobStreamDoneEvent> =
  (value): value is JobStreamDoneEvent => isRecord(value)
    && isString(value.job_id)
    && isOneOf(value.status, ['queued', 'assigned', 'generating', 'complete', 'failed', 'cancelled']);

export function isAbortError(value: unknown): boolean {
  return isRecord(value) && value.name === 'AbortError';
}
