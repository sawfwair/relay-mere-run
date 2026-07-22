import { z } from 'zod';
import type {
  SubmitAsrRequest,
  SubmitChatRequest,
  SubmitEmbedRequest,
  SubmitJobRequest,
  SubmitOcrRequest,
  SubmitTalkRequest,
  SubmitToolRequest,
  ToolInputAsset,
} from '../types';
import { unknownRecordSchema } from './primitives';

export const submitJobRequestSchema = z.object({
  kind: z.enum(['image', 'music', 'video']).optional(),
  prompt: z.string(),
  negative_prompt: z.string().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  steps: z.number().optional(),
  seed: z.number().optional(),
  input_image_url: z.string().optional(),
  input_image_data: z.string().optional(),
  input_strength: z.number().optional(),
  reference_image_urls: z.array(z.string()).optional(),
  agent_id: z.string().optional(),
  webhook_url: z.string().optional(),
  direct_image: z.boolean().optional(),
  model: z.string().optional(),
  duration_seconds: z.number().optional(),
  fps: z.number().optional(),
  num_frames: z.number().optional(),
  lyrics: z.string().optional(),
}).passthrough() satisfies z.ZodType<SubmitJobRequest>;

export const chatMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.string(),
  image_url: z.string().optional(),
}).passthrough();

export const submitChatRequestSchema = z.object({
  messages: z.array(chatMessageSchema),
  max_tokens: z.number().optional(),
  temperature: z.number().optional(),
  requires_json: z.boolean().optional(),
  use_lora: z.boolean().optional(),
  model: z.string().optional(),
}).passthrough() satisfies z.ZodType<SubmitChatRequest>;

export const submitTalkRequestSchema = z.object({
  text: z.string(),
  voice_description: z.string().optional(),
  speed: z.number().optional(),
  temperature: z.number().optional(),
  output_format: z.literal('wav').optional(),
  direct_audio: z.boolean().optional(),
}).passthrough() satisfies z.ZodType<SubmitTalkRequest>;

export const submitAsrRequestSchema = z.object({
  audio_url: z.string(),
  language: z.string().optional(),
  task: z.enum(['transcribe', 'translate']).optional(),
  max_tokens: z.number().optional(),
  webhook_url: z.string().optional(),
}).passthrough() satisfies z.ZodType<SubmitAsrRequest>;

export const submitEmbedRequestSchema = z.object({
  texts: z.array(z.string()),
  model: z.string().optional(),
  max_tokens: z.number().optional(),
  webhook_url: z.string().optional(),
}).passthrough() satisfies z.ZodType<SubmitEmbedRequest>;

export const submitOcrRequestSchema = z.object({
  image_url: z.string(),
  max_tokens: z.number().optional(),
  temperature: z.number().optional(),
}).passthrough() satisfies z.ZodType<SubmitOcrRequest>;

export const toolInputAssetSchema = z.object({
  name: z.string().optional(),
  url: z.string().optional(),
  path: z.string().optional(),
  content_type: z.string().optional(),
  metadata: unknownRecordSchema.optional(),
}).passthrough() satisfies z.ZodType<ToolInputAsset>;

export const submitToolRequestSchema = z.object({
  plugin: z.string().optional(),
  command: z.string(),
  inputs: unknownRecordSchema.optional(),
  options: unknownRecordSchema.optional(),
  assets: z.array(toolInputAssetSchema).optional(),
  agent_id: z.string().optional(),
  webhook_url: z.string().optional(),
}).passthrough() satisfies z.ZodType<SubmitToolRequest>;

export const graphClientEnvelopeSchema = z.record(z.string(), z.unknown());
export const asrStreamTicketRequestSchema = z.object({ client_id: z.unknown().optional() }).passthrough();

export const submitJobInternalSchema = submitJobRequestSchema.extend({
  client_id: z.string(),
  relay_origin: z.string().optional(),
});
export const submitChatInternalSchema = submitChatRequestSchema.extend({ client_id: z.string() });
export const submitTalkInternalSchema = submitTalkRequestSchema.extend({
  client_id: z.string(),
  relay_origin: z.string().optional(),
});
export const submitAsrInternalSchema = submitAsrRequestSchema.extend({ client_id: z.string() });
export const submitEmbedInternalSchema = submitEmbedRequestSchema.extend({ client_id: z.string() });
export const submitOcrInternalSchema = submitOcrRequestSchema.extend({ client_id: z.string() });
export const submitToolInternalSchema = submitToolRequestSchema.extend({
  client_id: z.string(),
  relay_origin: z.string().optional(),
});
