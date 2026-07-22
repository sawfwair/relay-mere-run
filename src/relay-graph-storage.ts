import type {
  GraphArtifactUpload,
  GraphBundleFile,
  GraphJob,
  GraphRunArtifact,
} from './types';
import type { RelayContext } from './relay-context';

const encoder = new TextEncoder();
const BUNDLE_DOCUMENT_PATHS = ['job.json', 'graph.json', 'inputs.json', 'assets.json'] as const;

export async function sha256Hex(data: ArrayBuffer | Uint8Array): Promise<string> {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function graphAssetKey(userId: string, digest: string): string {
  return `graph-assets/${encodeURIComponent(userId)}/${digest}`;
}

export function graphBundleKey(userId: string, jobId: string, path: string): string {
  return `graph-jobs/${encodeURIComponent(userId)}/${jobId}/bundle/${path}`;
}

export function graphRunManifestKey(userId: string, jobId: string): string {
  return `graph-jobs/${encodeURIComponent(userId)}/${jobId}/run.json`;
}

export function graphArtifactKey(userId: string, jobId: string, name: string): string {
  const safeName = name.replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 160);
  return `graph-jobs/${encodeURIComponent(userId)}/${jobId}/artifacts/${safeName || 'artifact'}`;
}

export function graphArtifactPartKey(
  userId: string,
  jobId: string,
  digest: string,
  index: number,
): string {
  return `graph-jobs/${encodeURIComponent(userId)}/${jobId}/artifact-parts/${digest}/${index}`;
}

function nodeBaseUrl(job: GraphJob): string {
  return `${job.relay_origin.replace(/\/+$/, '')}/api/graph-node/${encodeURIComponent(job.user_id)}/${job.job_id}/${job.node_token}`;
}

async function storeBundleDocument(
  ctx: RelayContext,
  job: GraphJob,
  path: string,
  value: unknown
): Promise<GraphBundleFile> {
  const bytes = encoder.encode(JSON.stringify(value));
  const sha256 = await sha256Hex(bytes);
  await ctx.env.IMAGES.put(graphBundleKey(job.user_id, job.job_id, path), bytes, {
    httpMetadata: { contentType: 'application/json' },
    customMetadata: { sha256 },
  });
  return {
    path,
    url: `${nodeBaseUrl(job)}/bundle/${encodeURIComponent(path)}`,
    sha256,
    size_bytes: bytes.byteLength,
  };
}

export async function storeSubmittedBundleDocuments(
  ctx: RelayContext,
  job: GraphJob,
  documents: Record<string, Uint8Array>,
): Promise<void> {
  for (const path of BUNDLE_DOCUMENT_PATHS) {
    const bytes = documents[path];
    if (!bytes) throw new Error(`Missing graph bundle document: ${path}`);
    const sha256 = await sha256Hex(bytes);
    await ctx.env.IMAGES.put(graphBundleKey(job.user_id, job.job_id, path), bytes, {
      httpMetadata: { contentType: 'application/json' },
      customMetadata: { sha256 },
    });
  }
}

async function existingBundleDocument(
  ctx: RelayContext,
  job: GraphJob,
  path: string,
): Promise<GraphBundleFile | null> {
  const object = await ctx.env.IMAGES.head(graphBundleKey(job.user_id, job.job_id, path));
  const sha256 = object?.customMetadata?.sha256;
  if (!object || !sha256) return null;
  return {
    path,
    url: `${nodeBaseUrl(job)}/bundle/${encodeURIComponent(path)}`,
    sha256,
    size_bytes: object.size,
  };
}

export async function materializeRelayBundle(ctx: RelayContext, job: GraphJob): Promise<GraphBundleFile[]> {
  const values: Record<(typeof BUNDLE_DOCUMENT_PATHS)[number], unknown> = {
    'job.json': job.job,
    'graph.json': job.graph,
    'inputs.json': job.inputs,
    'assets.json': job.assets,
  };
  const files = await Promise.all(BUNDLE_DOCUMENT_PATHS.map(async (path) => (
    await existingBundleDocument(ctx, job, path)
      ?? storeBundleDocument(ctx, job, path, values[path])
  )));
  const entries = job.assets.groups.flatMap((group) => group.entries);
  const unique = new Map(entries.map((entry) => [entry.digest, entry]));
  for (const entry of unique.values()) {
    files.push({
      path: `assets/sha256/${entry.digest}`,
      url: `${nodeBaseUrl(job)}/bundle/${encodeURIComponent(`assets/sha256/${entry.digest}`)}`,
      sha256: entry.digest,
      size_bytes: entry.size_bytes,
    });
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

export function graphUploadUrlBase(job: GraphJob): string {
  return nodeBaseUrl(job);
}

export async function graphBundleObject(
  ctx: RelayContext,
  job: GraphJob,
  path: string
): Promise<R2ObjectBody | null> {
  if (path.startsWith('assets/sha256/')) {
    const digest = path.slice('assets/sha256/'.length);
    if (!/^[a-f0-9]{64}$/.test(digest)) return null;
    const declared = job.assets.groups.some((group) => group.entries.some((entry) => entry.digest === digest));
    if (!declared) return null;
    return ctx.env.IMAGES.get(graphAssetKey(job.user_id, digest));
  }
  if (!['job.json', 'graph.json', 'inputs.json', 'assets.json'].includes(path)) return null;
  return ctx.env.IMAGES.get(graphBundleKey(job.user_id, job.job_id, path));
}

export async function storeGraphArtifact(
  ctx: RelayContext,
  job: GraphJob,
  artifact: GraphRunArtifact,
  bytes: ArrayBuffer,
): Promise<void> {
  await ctx.env.IMAGES.put(graphArtifactKey(job.user_id, job.job_id, artifact.name), bytes, {
    httpMetadata: { contentType: artifact.content_type || 'application/octet-stream' },
    customMetadata: { sha256: artifact.sha256 },
  });
}

export async function storeGraphArtifactPart(
  ctx: RelayContext,
  job: GraphJob,
  digest: string,
  index: number,
  partDigest: string,
  bytes: ArrayBuffer,
): Promise<void> {
  await ctx.env.IMAGES.put(graphArtifactPartKey(job.user_id, job.job_id, digest, index), bytes, {
    httpMetadata: { contentType: 'application/octet-stream' },
    customMetadata: { sha256: partDigest },
  });
}

function orderedCompleteParts(upload: GraphArtifactUpload): GraphArtifactUpload['parts'] | null {
  if (upload.part_count < 1 || upload.parts.length !== upload.part_count) return null;
  const parts = [...upload.parts].sort((left, right) => left.index - right.index);
  if (parts.some((part, index) => part.index !== index)) return null;
  if (parts.reduce((total, part) => total + part.size_bytes, 0) !== upload.size_bytes) return null;
  return parts;
}

async function verifiedPartMetadata(
  ctx: RelayContext,
  job: GraphJob,
  upload: GraphArtifactUpload,
): Promise<GraphArtifactUpload['parts'] | null> {
  const parts = orderedCompleteParts(upload);
  if (!parts) return null;
  const present = await Promise.all(parts.map(async (part) => {
    const object = await ctx.env.IMAGES.head(graphArtifactPartKey(
      job.user_id,
      job.job_id,
      upload.sha256,
      part.index,
    ));
    return object?.size === part.size_bytes && object.customMetadata?.sha256 === part.sha256;
  }));
  return present.every(Boolean) ? parts : null;
}

export async function verifiedGraphArtifactUpload(
  ctx: RelayContext,
  job: GraphJob,
  digest: string,
): Promise<(GraphArtifactUpload & { complete: boolean }) | null> {
  const upload = job.artifact_uploads?.[digest];
  if (!upload) return null;
  if (upload.object_name) {
    const object = await ctx.env.IMAGES.head(graphArtifactKey(job.user_id, job.job_id, upload.object_name));
    if (!object || object.size !== upload.size_bytes || object.customMetadata?.sha256 !== upload.sha256) return null;
    return { ...upload, complete: true };
  }
  const verifiedParts = (await Promise.all(upload.parts.map(async (part) => {
    const object = await ctx.env.IMAGES.head(graphArtifactPartKey(
      job.user_id,
      job.job_id,
      upload.sha256,
      part.index,
    ));
    return object?.size === part.size_bytes && object.customMetadata?.sha256 === part.sha256
      ? part
      : null;
  }))).filter((part): part is GraphArtifactUpload['parts'][number] => part !== null)
    .sort((left, right) => left.index - right.index);
  const complete = verifiedParts.length === upload.part_count
    && verifiedParts.every((part, index) => part.index === index)
    && verifiedParts.reduce((total, part) => total + part.size_bytes, 0) === upload.size_bytes;
  return { ...upload, parts: verifiedParts, complete };
}

export async function hasStoredGraphArtifact(
  ctx: RelayContext,
  job: GraphJob,
  artifact: GraphRunArtifact,
): Promise<boolean> {
  const upload = job.artifact_uploads?.[artifact.sha256];
  if (!upload) {
    const legacy = await ctx.env.IMAGES.head(graphArtifactKey(job.user_id, job.job_id, artifact.name));
    return legacy?.size === artifact.size_bytes && legacy.customMetadata?.sha256 === artifact.sha256;
  }
  if (upload.sha256 !== artifact.sha256 || upload.size_bytes !== artifact.size_bytes) return false;
  if (upload.object_name) {
    const object = await ctx.env.IMAGES.head(graphArtifactKey(job.user_id, job.job_id, upload.object_name));
    return object?.size === upload.size_bytes && object.customMetadata?.sha256 === upload.sha256;
  }
  return await verifiedPartMetadata(ctx, job, upload) !== null;
}

export async function graphArtifactResponse(
  ctx: RelayContext,
  job: GraphJob,
  artifact: GraphRunArtifact,
): Promise<Response | null> {
  const upload = job.artifact_uploads?.[artifact.sha256];
  if (!upload) {
    const legacy = await ctx.env.IMAGES.get(graphArtifactKey(job.user_id, job.job_id, artifact.name));
    return legacy ? new Response(legacy.body, { headers: { 'Content-Type': artifact.content_type } }) : null;
  }
  if (upload.object_name) {
    const object = await ctx.env.IMAGES.get(graphArtifactKey(job.user_id, job.job_id, upload.object_name));
    if (!object || object.size !== upload.size_bytes || object.customMetadata?.sha256 !== upload.sha256) return null;
    return new Response(object.body, {
      headers: {
        'Content-Type': artifact.content_type,
        'Content-Length': String(artifact.size_bytes),
      },
    });
  }

  const parts = await verifiedPartMetadata(ctx, job, upload);
  if (!parts) return null;
  let partIndex = 0;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller): Promise<void> {
      while (partIndex < parts.length) {
        if (!reader) {
          const part = parts[partIndex];
          const object = await ctx.env.IMAGES.get(graphArtifactPartKey(
            job.user_id,
            job.job_id,
            upload.sha256,
            part.index,
          ));
          if (!object || object.size !== part.size_bytes || object.customMetadata?.sha256 !== part.sha256) {
            controller.error(new Error('Graph artifact part disappeared during fetch'));
            return;
          }
          reader = object.body.getReader();
        }
        const next = await reader.read();
        if (!next.done) {
          controller.enqueue(next.value);
          return;
        }
        reader = null;
        partIndex += 1;
      }
      controller.close();
    },
    async cancel(reason): Promise<void> {
      await reader?.cancel(reason);
    },
  });
  return new Response(body, {
    headers: {
      'Content-Type': artifact.content_type,
      'Content-Length': String(artifact.size_bytes),
    },
  });
}
