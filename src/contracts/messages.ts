import { z } from 'zod';
import type {
  AsrErrorMessage,
  AsrResponseMessage,
  AsrSentenceAlignment,
  AsrTokenAlignment,
  ChatErrorMessage,
  ChatResponseMessage,
  EmbedErrorMessage,
  EmbedResponseMessage,
  OcrErrorMessage,
  OcrResponseMessage,
  ResultMessage,
  TalkErrorMessage,
  TalkResponseMessage,
  ToolArtifact,
  ToolErrorMessage,
  ToolResultMessage,
} from '../types';
import { unknownRecordSchema } from './primitives';

export const resultMessageSchema = z.object({
  type: z.literal('result'),
  job_id: z.string(),
  owner_user_id: z.string().optional(),
  success: z.boolean(),
  image_url: z.string().optional(),
  image_data: z.string().optional(),
  media_url: z.string().optional(),
  media_data: z.string().optional(),
  content_type: z.string().optional(),
  output_kind: z.enum(['image', 'music', 'video']).optional(),
  seed: z.number().optional(),
  generation_time_ms: z.number().optional(),
  error: z.string().optional(),
  lease_id: z.string().optional(),
}).passthrough() satisfies z.ZodType<ResultMessage>;

export const chatResponseMessageSchema = z.object({
  type: z.literal('chat_response'),
  chat_id: z.string(),
  response: z.string(),
  tokens_generated: z.number().optional(),
}).passthrough() satisfies z.ZodType<ChatResponseMessage>;

export const chatErrorMessageSchema = z.object({
  type: z.literal('chat_error'),
  chat_id: z.string(),
  error: z.string(),
}).passthrough() satisfies z.ZodType<ChatErrorMessage>;

export const talkResponseMessageSchema = z.object({
  type: z.literal('talk_response'),
  talk_id: z.string(),
  owner_user_id: z.string().optional(),
  audio_url: z.string().optional(),
  audio_data: z.string().optional(),
  duration_seconds: z.number().optional(),
  sample_rate: z.number().optional(),
  output_format: z.literal('wav').optional(),
}).passthrough() satisfies z.ZodType<TalkResponseMessage>;

export const talkErrorMessageSchema = z.object({
  type: z.literal('talk_error'),
  talk_id: z.string(),
  owner_user_id: z.string().optional(),
  error: z.string(),
}).passthrough() satisfies z.ZodType<TalkErrorMessage>;

export const asrTokenAlignmentSchema = z.object({
  id: z.number().optional(),
  text: z.string(),
  start_seconds: z.number(),
  duration_seconds: z.number(),
  end_seconds: z.number(),
}).passthrough() satisfies z.ZodType<AsrTokenAlignment>;

export const asrSentenceAlignmentSchema = z.object({
  text: z.string(),
  start_seconds: z.number(),
  duration_seconds: z.number(),
  end_seconds: z.number(),
  tokens: z.array(asrTokenAlignmentSchema),
}).passthrough() satisfies z.ZodType<AsrSentenceAlignment>;

export const asrResponseMessageSchema = z.object({
  type: z.literal('asr_response'),
  asr_id: z.string(),
  owner_user_id: z.string().optional(),
  text: z.string(),
  language: z.string().optional(),
  duration_seconds: z.number().optional(),
  token_alignments: z.array(asrTokenAlignmentSchema).optional(),
  sentence_alignments: z.array(asrSentenceAlignmentSchema).optional(),
}).passthrough() satisfies z.ZodType<AsrResponseMessage>;

export const asrErrorMessageSchema = z.object({
  type: z.literal('asr_error'),
  asr_id: z.string(),
  owner_user_id: z.string().optional(),
  error: z.string(),
}).passthrough() satisfies z.ZodType<AsrErrorMessage>;

const embedDataRowSchema = z.object({
  index: z.number(),
  embedding: z.array(z.number()),
}).passthrough();

export const embedResponseMessageSchema = z.object({
  type: z.literal('embed_response'),
  embed_id: z.string(),
  owner_user_id: z.string().optional(),
  model: z.string().optional(),
  dimensions: z.number().optional(),
  data: z.array(embedDataRowSchema),
}).passthrough() satisfies z.ZodType<EmbedResponseMessage>;

export const embedErrorMessageSchema = z.object({
  type: z.literal('embed_error'),
  embed_id: z.string(),
  owner_user_id: z.string().optional(),
  error: z.string(),
}).passthrough() satisfies z.ZodType<EmbedErrorMessage>;

export const ocrResponseMessageSchema = z.object({
  type: z.literal('ocr_response'),
  ocr_id: z.string(),
  owner_user_id: z.string().optional(),
  text: z.string(),
  tokens_generated: z.number().optional(),
}).passthrough() satisfies z.ZodType<OcrResponseMessage>;

export const ocrErrorMessageSchema = z.object({
  type: z.literal('ocr_error'),
  ocr_id: z.string(),
  owner_user_id: z.string().optional(),
  error: z.string(),
}).passthrough() satisfies z.ZodType<OcrErrorMessage>;

export const toolArtifactSchema = z.object({
  name: z.string(),
  kind: z.string(),
  label: z.string().optional(),
  content_type: z.string(),
  url: z.string().optional(),
  bytes: z.number().optional(),
  sha256: z.string().optional(),
  metadata: unknownRecordSchema.optional(),
}).passthrough() satisfies z.ZodType<ToolArtifact>;

export const toolResultMessageSchema = z.object({
  type: z.literal('tool_result'),
  tool_id: z.string(),
  owner_user_id: z.string().optional(),
  artifacts: z.array(toolArtifactSchema),
  run_manifest: unknownRecordSchema.optional(),
  summary: unknownRecordSchema.optional(),
}).passthrough() satisfies z.ZodType<ToolResultMessage>;

export const toolErrorMessageSchema = z.object({
  type: z.literal('tool_error'),
  tool_id: z.string(),
  owner_user_id: z.string().optional(),
  error: z.string(),
}).passthrough() satisfies z.ZodType<ToolErrorMessage>;
