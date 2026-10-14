import type { RelayContext } from './relay-context';
import { graphAssetKey } from './relay-graph-storage';

/** Hash and count input bytes with backpressure; expose only the verified object. */
export async function storeBatchAsset(
  ctx: RelayContext, owner: string, batchId: string, digest: string, size: number, contentType: string, request: Request,
): Promise<boolean> {
  const stageKey = `graph-jobs/${encodeURIComponent(owner)}/${batchId}/staging/${crypto.randomUUID()}`;
  const stream = new FixedLengthStream(size);
  const hash = new crypto.DigestStream('SHA-256');
  const writer = stream.writable.getWriter();
  const hashWriter = hash.getWriter();
  const stored = ctx.env.IMAGES.put(stageKey, stream.readable);
  // Attach rejection handlers immediately; all promises are awaited below.
  const storedResult = stored.then(() => null, (error: unknown) => error);
  const hashResult = hash.digest.then((bytes) => bytes, () => null);
  try {
    const validSize = await copyUpload(request, size, writer, hashWriter);
    if (!validSize) return false;
    await writer.close(); await hashWriter.close();
    const [storeError, hashBytes] = await Promise.all([storedResult, hashResult]);
    if (storeError) throw new Error('BATCH_ASSET_STORE_FAILED', { cause: storeError });
    if (!hashBytes || [...new Uint8Array(hashBytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('') !== digest) return false;
    const object = await ctx.env.IMAGES.get(stageKey);
    if (!object || object.size !== size) throw new Error('BATCH_ASSET_STAGING_LOST');
    await ctx.env.IMAGES.put(graphAssetKey(owner, digest), object.body, {
      httpMetadata: { contentType }, customMetadata: { sha256: digest },
    });
    return true;
  } finally {
    await Promise.allSettled([writer.abort(), hashWriter.abort()]);
    await storedResult;
    await ctx.env.IMAGES.delete(stageKey);
  }
}

async function copyUpload(
  request: Request, expected: number,
  writer: WritableStreamDefaultWriter<Uint8Array>,
  hash: WritableStreamDefaultWriter<ArrayBuffer | ArrayBufferView>,
): Promise<boolean> {
  const reader: ReadableStreamDefaultReader<Uint8Array> | undefined = request.body?.getReader();
  if (!reader) return expected === 0;
  let received = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return received === expected;
      received += chunk.value.length;
      if (received > expected) { await reader.cancel(); return false; }
      await hash.write(chunk.value);
      await writer.write(chunk.value);
    }
  } finally { reader.releaseLock(); }
}
