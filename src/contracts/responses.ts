import { z } from 'zod';
import type {
  AsrStatusResponse,
  EmbedStatusResponse,
  JobStatusResponse,
  OcrStatusResponse,
  TalkStatusResponse,
  ToolStatusResponse,
} from '../types';
import {
  asrSentenceAlignmentSchema,
  asrSpeakerSegmentSchema,
  asrTokenAlignmentSchema,
  toolArtifactSchema,
} from './messages';
import { unknownRecordSchema } from './primitives';
import { chatMessageSchema, toolInputAssetSchema } from './requests';

const nullableDateSchema = z.string().nullable();

const jobRequestSchema = z.object({
  kind: z.enum(['image', 'music', 'video']).optional(),
  prompt: z.string(),
  negative_prompt: z.string().nullable(),
  width: z.number(),
  height: z.number(),
  steps: z.number(),
  seed: z.number().nullable(),
  input_image_url: z.string().nullable(),
  input_image_data: z.string().nullable(),
  input_strength: z.number().nullable(),
  reference_image_urls: z.array(z.string()).nullable(),
  model: z.string().optional(),
  duration_seconds: z.number().optional(),
  fps: z.number().optional(),
  num_frames: z.number().optional(),
  lyrics: z.string().optional(),
  end_image_url: z.string().optional(),
  end_image_strength: z.number().min(0).max(1).optional(),
}).passthrough();

const jobResultSchema = z.object({
  image_url: z.string().optional(),
  image_data: z.string().optional(),
  media_url: z.string().optional(),
  media_data: z.string().optional(),
  content_type: z.string().optional(),
  output_kind: z.enum(['image', 'music', 'video']).optional(),
  seed: z.number(),
  generation_time_ms: z.number(),
}).passthrough();

export const jobStatusResponseSchema = z.object({
  job_id: z.string(),
  user_id: z.string(),
  client_id: z.string(),
  agent_id: z.string().nullable(),
  status: z.enum(['queued', 'assigned', 'generating', 'complete', 'failed', 'cancelled']),
  request: jobRequestSchema,
  progress: z.object({ step: z.number(), total_steps: z.number() }).passthrough().nullable(),
  result: jobResultSchema.nullable(),
  error: z.string().nullable(),
  created_at: z.string(),
  assigned_at: nullableDateSchema,
  started_at: nullableDateSchema,
  completed_at: nullableDateSchema,
  direct_image: z.boolean(),
}).passthrough() satisfies z.ZodType<JobStatusResponse>;

const toolRequestSchema = z.object({
  plugin: z.string(),
  command: z.string(),
  inputs: unknownRecordSchema,
  options: unknownRecordSchema,
  assets: z.array(toolInputAssetSchema).optional(),
}).passthrough();

export const toolStatusResponseSchema = z.object({
  tool_id: z.string(),
  user_id: z.string(),
  client_id: z.string(),
  agent_id: z.string().nullable(),
  status: z.enum(['queued', 'processing', 'complete', 'failed', 'cancelled']),
  request: toolRequestSchema,
  progress: z.object({
    step: z.number(),
    total_steps: z.number(),
    message: z.string().optional(),
  }).passthrough().nullable(),
  result: z.object({
    artifacts: z.array(toolArtifactSchema),
    run_manifest: unknownRecordSchema.optional(),
    summary: unknownRecordSchema.optional(),
  }).passthrough().nullable(),
  error: z.string().nullable(),
  created_at: z.string(),
  started_at: nullableDateSchema,
  completed_at: nullableDateSchema,
}).passthrough() satisfies z.ZodType<ToolStatusResponse>;

const talkRequestSchema = z.object({
  text: z.string(),
  voice_description: z.string().nullable(),
  speed: z.number(),
  temperature: z.number(),
  output_format: z.literal('wav'),
}).passthrough();

export const talkStatusResponseSchema = z.object({
  talk_id: z.string(),
  user_id: z.string(),
  client_id: z.string(),
  agent_id: z.string().nullable(),
  status: z.enum(['queued', 'processing', 'complete', 'failed', 'cancelled']),
  request: talkRequestSchema,
  result: z.object({
    audio_url: z.string().optional(),
    audio_data: z.string().optional(),
    duration_seconds: z.number(),
    sample_rate: z.number(),
    output_format: z.literal('wav'),
  }).passthrough().nullable(),
  error: z.string().nullable(),
  created_at: z.string(),
  started_at: nullableDateSchema,
  completed_at: nullableDateSchema,
  direct_audio: z.boolean(),
}).passthrough() satisfies z.ZodType<TalkStatusResponse>;

export const asrStatusResponseSchema = z.object({
  asr_id: z.string(),
  user_id: z.string(),
  client_id: z.string(),
  agent_id: z.string().nullable(),
  status: z.enum(['queued', 'processing', 'complete', 'failed', 'cancelled']),
  request: z.object({
    audio_url: z.string(),
    language: z.string().nullable(),
    task: z.enum(['transcribe', 'translate']),
    backend: z.enum(['auto', 'parakeet', 'qwen']).optional(),
    diarize: z.boolean(),
    max_tokens: z.number(),
  }).passthrough(),
  result: z.object({
    text: z.string(),
    language: z.string().nullable(),
    duration_seconds: z.number(),
    token_alignments: z.array(asrTokenAlignmentSchema).optional(),
    sentence_alignments: z.array(asrSentenceAlignmentSchema).optional(),
    speaker_segments: z.array(asrSpeakerSegmentSchema).optional(),
  }).passthrough().nullable(),
  error: z.string().nullable(),
  created_at: z.string(),
  started_at: nullableDateSchema,
  completed_at: nullableDateSchema,
}).passthrough() satisfies z.ZodType<AsrStatusResponse>;

const embedDataRowSchema = z.object({
  index: z.number(),
  embedding: z.array(z.number()),
}).passthrough();

export const embedStatusResponseSchema = z.object({
  embed_id: z.string(),
  user_id: z.string(),
  client_id: z.string(),
  agent_id: z.string().nullable(),
  status: z.enum(['queued', 'processing', 'complete', 'failed', 'cancelled']),
  request: z.object({
    texts: z.array(z.string()),
    model: z.string(),
    max_tokens: z.number(),
  }).passthrough(),
  result: z.object({
    model: z.string(),
    dimensions: z.number(),
    data: z.array(embedDataRowSchema),
  }).passthrough().nullable(),
  error: z.string().nullable(),
  created_at: z.string(),
  started_at: nullableDateSchema,
  completed_at: nullableDateSchema,
}).passthrough() satisfies z.ZodType<EmbedStatusResponse>;

export const ocrStatusResponseSchema = z.object({
  ocr_id: z.string(),
  user_id: z.string(),
  client_id: z.string(),
  agent_id: z.string().nullable(),
  status: z.enum(['queued', 'processing', 'complete', 'failed', 'cancelled']),
  request: z.object({
    image_url: z.string(),
    max_tokens: z.number(),
    temperature: z.number(),
  }).passthrough(),
  result: z.object({ text: z.string(), tokens_generated: z.number() }).passthrough().nullable(),
  error: z.string().nullable(),
  created_at: z.string(),
  started_at: nullableDateSchema,
  completed_at: nullableDateSchema,
}).passthrough() satisfies z.ZodType<OcrStatusResponse>;

export const graphStateResponseSchema = z.object({ state: z.string() }).passthrough();
export const asrStreamTicketResponseSchema = z.object({
  ticket_id: z.string(),
  protocol: z.number(),
  device_label: z.string(),
  expires_at_ms: z.number(),
}).passthrough();
export const unknownJsonSchema = z.unknown();

export const clientAuthResponseSchema = z.object({
  user_id: z.string(),
  email: z.string().optional(),
  name: z.string().optional(),
}).passthrough();

export const tokenResponseSchema = z.object({
  access_token: z.string().optional(),
  id_token: z.string().optional(),
  refresh_token: z.string().optional(),
  expires_in: z.number().optional(),
  error: z.string().optional(),
  error_description: z.string().optional(),
}).passthrough();

// Exported to keep response contracts discoverable beside request contracts.
export { chatMessageSchema };
