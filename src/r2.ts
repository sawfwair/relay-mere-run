import type { Env } from './types';

function getAssetBaseUrl(env: Env): string {
  return env.MERE_RUN_ASSET_BASE_URL.replace(/\/+$/, '');
}

export function buildAssetUrl(env: Env, key: string): string {
  return `${getAssetBaseUrl(env)}/${key}`;
}

/**
 * Generate the R2 object key for a job's result image
 */
export function getImageKey(userId: string, jobId: string): string {
  return `relay/${userId}/${jobId}.png`;
}

function extensionForContentType(contentType: string): string {
  if (contentType.includes('video/mp4')) return 'mp4';
  if (contentType.includes('audio/wav') || contentType.includes('audio/x-wav')) return 'wav';
  if (contentType.includes('audio/mpeg')) return 'mp3';
  if (contentType.includes('application/json')) return 'json';
  if (contentType.includes('text/markdown')) return 'md';
  if (contentType.includes('text/plain')) return 'txt';
  if (contentType.includes('image/jpeg')) return 'jpg';
  return 'png';
}

export function getJobOutputKey(userId: string, jobId: string, contentType: string): string {
  return `relay/${userId}/${jobId}.${extensionForContentType(contentType)}`;
}

function sanitizeArtifactName(name: string): string {
  const sanitized = name.replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '');
  return sanitized.slice(0, 160) || 'artifact';
}

export function getToolArtifactKey(
  userId: string,
  toolId: string,
  artifactName: string,
  contentType: string
): string {
  const safeName = sanitizeArtifactName(artifactName);
  const hasExtension = /\.[A-Za-z0-9]{2,8}$/.test(safeName);
  const filename = hasExtension ? safeName : `${safeName}.${extensionForContentType(contentType)}`;
  return `relay/${userId}/${toolId}/${filename}`;
}

/**
 * Generate the R2 object key for a job's input image (img2img)
 */
export function getInputImageKey(userId: string, jobId: string): string {
  return `inputs-inline/${userId}/${jobId}.jpg`;
}

/**
 * Get public URL for input image
 */
export function getInputImageUrl(env: Env, userId: string, jobId: string): string {
  return buildAssetUrl(env, getInputImageKey(userId, jobId));
}

/**
 * Generate the R2 object key for a talk result audio file
 */
export function getAudioKey(userId: string, talkId: string): string {
  return `relay/${userId}/${talkId}.wav`;
}

/**
 * Generate the public URL for a stored image
 * Assumes R2 bucket has public access or is behind a CDN
 */
export function getPublicImageUrl(env: Env, userId: string, jobId: string): string {
  return buildAssetUrl(env, getImageKey(userId, jobId));
}

export function getPublicJobOutputUrl(
  env: Env,
  userId: string,
  jobId: string,
  contentType: string
): string {
  return buildAssetUrl(env, getJobOutputKey(userId, jobId, contentType));
}

export function getPublicToolArtifactUrl(
  env: Env,
  userId: string,
  toolId: string,
  artifactName: string,
  contentType: string
): string {
  return buildAssetUrl(env, getToolArtifactKey(userId, toolId, artifactName, contentType));
}

/**
 * Generate the public URL for a stored audio file
 */
export function getPublicAudioUrl(env: Env, userId: string, talkId: string): string {
  return buildAssetUrl(env, getAudioKey(userId, talkId));
}

/**
 * Store an image in R2
 * Returns the public URL
 */
export async function storeImage(
  env: Env,
  userId: string,
  jobId: string,
  imageData: ArrayBuffer
): Promise<string> {
  const key = getImageKey(userId, jobId);

  await env.IMAGES.put(key, imageData, {
    httpMetadata: {
      contentType: 'image/png',
    },
  });

  return getPublicImageUrl(env, userId, jobId);
}

export async function storeJobOutput(
  env: Env,
  userId: string,
  jobId: string,
  data: ArrayBuffer,
  contentType: string
): Promise<string> {
  const normalizedContentType = contentType || 'image/png';
  const key = getJobOutputKey(userId, jobId, normalizedContentType);

  await env.IMAGES.put(key, data, {
    httpMetadata: {
      contentType: normalizedContentType,
    },
  });

  return getPublicJobOutputUrl(env, userId, jobId, normalizedContentType);
}

export async function storeToolArtifact(
  env: Env,
  userId: string,
  toolId: string,
  artifactName: string,
  data: ArrayBuffer,
  contentType: string
): Promise<string> {
  const normalizedContentType = contentType || 'application/octet-stream';
  const key = getToolArtifactKey(userId, toolId, artifactName, normalizedContentType);

  await env.IMAGES.put(key, data, {
    httpMetadata: {
      contentType: normalizedContentType,
    },
  });

  return getPublicToolArtifactUrl(env, userId, toolId, artifactName, normalizedContentType);
}

/**
 * Generate upload URL for agent
 * For MVP, this returns a relay upload endpoint rather than a presigned R2 URL
 * The agent will POST the image data to this endpoint
 * URL includes userId to ensure upload routes to correct Durable Object
 */
export function generateUploadUrl(relayOrigin: string, userId: string, jobId: string): string {
  // For MVP: agent uploads through relay
  // Format: POST /api/upload/{user_id}/{job_id}
  // userId ensures upload routes to the DO that owns the job
  // Later: can switch to presigned R2 URLs for direct upload
  return `${relayOrigin}/api/upload/${encodeURIComponent(userId)}/${jobId}`;
}

export function generateToolUploadUrlBase(relayOrigin: string, userId: string, toolId: string): string {
  return `${relayOrigin}/api/tool-upload/${encodeURIComponent(userId)}/${toolId}`;
}

/**
 * Generate audio upload URL for agent
 * Format: POST /api/audio-upload/{user_id}/{talk_id}
 */
export function generateAudioUploadUrl(relayOrigin: string, userId: string, talkId: string): string {
  return `${relayOrigin}/api/audio-upload/${encodeURIComponent(userId)}/${talkId}`;
}

/**
 * Convert ArrayBuffer to base64 string (chunk-safe for large images)
 */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 32768;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

/**
 * Fetch an image from R2
 * Returns base64 string or null if not found
 */
export async function getImage(env: Env, userId: string, jobId: string): Promise<string | null> {
  const key = getImageKey(userId, jobId);
  const object = await env.IMAGES.get(key);
  if (!object) return null;
  const arrayBuffer = await object.arrayBuffer();
  return arrayBufferToBase64(arrayBuffer);
}

/**
 * Fetch and delete an image from R2 (for direct_image delivery)
 * Returns base64 string or null if not found
 */
export async function getAndDeleteImage(env: Env, userId: string, jobId: string): Promise<string | null> {
  const base64 = await getImage(env, userId, jobId);
  if (base64) {
    await deleteImage(env, userId, jobId);
  }
  return base64;
}

/**
 * Delete an image from R2
 * Returns true if deleted, false if not found
 */
export async function deleteImage(env: Env, userId: string, jobId: string): Promise<boolean> {
  const key = getImageKey(userId, jobId);
  await env.IMAGES.delete(key);
  return true;
}

/**
 * Store an audio file in R2
 * Returns the public URL
 */
export async function storeAudio(
  env: Env,
  userId: string,
  talkId: string,
  audioData: ArrayBuffer
): Promise<string> {
  const key = getAudioKey(userId, talkId);

  await env.IMAGES.put(key, audioData, {
    httpMetadata: {
      contentType: 'audio/wav',
    },
  });

  return getPublicAudioUrl(env, userId, talkId);
}

/**
 * Fetch an audio file from R2
 * Returns base64 string or null if not found
 */
export async function getAudio(env: Env, userId: string, talkId: string): Promise<string | null> {
  const key = getAudioKey(userId, talkId);
  const object = await env.IMAGES.get(key);
  if (!object) return null;
  const arrayBuffer = await object.arrayBuffer();
  return arrayBufferToBase64(arrayBuffer);
}

/**
 * Fetch and delete an audio file from R2 (for direct_audio delivery)
 * Returns base64 string or null if not found
 */
export async function getAndDeleteAudio(env: Env, userId: string, talkId: string): Promise<string | null> {
  const base64 = await getAudio(env, userId, talkId);
  if (base64) {
    await deleteAudio(env, userId, talkId);
  }
  return base64;
}

/**
 * Delete an audio file from R2
 * Returns true if deleted
 */
export async function deleteAudio(env: Env, userId: string, talkId: string): Promise<boolean> {
  const key = getAudioKey(userId, talkId);
  await env.IMAGES.delete(key);
  return true;
}
