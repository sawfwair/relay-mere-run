import { MereRunRelay } from './MereRunRelay';
import { handleClientApi } from './client-api';
import { authenticateAgent, authenticateClient } from './auth';
import type { Env } from './types';
import { getClientApiPath } from './client-api';
import { openAsrTicket } from './relay-asr-stream';
import {
  handleWebAuthCallback,
  handleWebAuthLogout,
  handleWebAuthRefresh,
  handleWebAuthSession,
  handleWebAuthStart,
} from './web-auth';
import { parseJson } from './json';
import { unknownJsonSchema } from './contracts/responses';

export { MereRunRelay };

const AGENT_PATHS = new Set(['/agent', '/zero-agent']);
const PUBLIC_MEDIA_PREFIX = '/media/';
const PUBLIC_MEDIA_KEY_PREFIXES = ['relay/', 'inputs/', 'inputs-inline/'];

type NodeReleaseFormat = 'dmg' | 'appimage' | 'deb';

interface NodeReleaseDownload {
  key: string;
  filename: string;
  contentType: string;
  label: string;
  platform: string;
  arch: string;
  format: NodeReleaseFormat;
  recommended: boolean;
  version: string;
  sha256?: string;
  publishedAt?: string;
}

interface NodeReleaseChannel {
  path: string;
  aliases?: string[];
  manifestKey: string;
  contentType: string;
  label: string;
  platform: string;
  arch: string;
  format: NodeReleaseFormat;
  recommended: boolean;
  fallback?: NodeReleaseDownload;
}

interface ResolvedNodeRelease {
  release: NodeReleaseDownload;
  source: 'r2-release-manifest' | 'legacy-fallback';
}

const NODE_RELEASE_CHANNELS: NodeReleaseChannel[] = [
  {
    path: '/downloads/mere-run-node/macos/latest',
    manifestKey: 'releases/mere-run-node/macos/latest.json',
    contentType: 'application/x-apple-diskimage',
    label: 'macOS DMG',
    platform: 'macos',
    arch: 'aarch64',
    format: 'dmg',
    recommended: true,
    fallback: {
      key: 'releases/mere-run-node/macos/mere.run-node-0.1.2-aarch64-notarized.dmg',
      filename: 'mere.run-node-0.1.2-aarch64.dmg',
      contentType: 'application/x-apple-diskimage',
      label: 'macOS DMG',
      platform: 'macos',
      arch: 'aarch64',
      format: 'dmg',
      recommended: true,
      version: '0.1.2',
    },
  },
  {
    path: '/downloads/mere-run-node/linux/x86_64/latest',
    manifestKey: 'releases/mere-run-node/linux/x86_64/latest.json',
    contentType: 'application/octet-stream',
    label: 'Linux x86_64 AppImage',
    platform: 'linux',
    arch: 'x86_64',
    format: 'appimage',
    recommended: false,
    fallback: {
      key: 'releases/mere-run-node/linux/x86_64/mere.run-node-0.1.1-x86_64.AppImage',
      filename: 'mere.run-node-0.1.1-x86_64.AppImage',
      contentType: 'application/octet-stream',
      label: 'Linux x86_64 AppImage',
      platform: 'linux',
      arch: 'x86_64',
      format: 'appimage',
      recommended: false,
      version: '0.1.1',
    },
  },
  {
    path: '/downloads/mere-run-node/linux/arm64/latest',
    aliases: ['/downloads/mere-run-node/linux/aarch64/latest'],
    manifestKey: 'releases/mere-run-node/linux/arm64/latest.json',
    contentType: 'application/octet-stream',
    label: 'Linux arm64 AppImage',
    platform: 'linux',
    arch: 'arm64',
    format: 'appimage',
    recommended: false,
    fallback: {
      key: 'releases/mere-run-node/linux/arm64/mere.run-node-0.1.1-arm64.AppImage',
      filename: 'mere.run-node-0.1.1-arm64.AppImage',
      contentType: 'application/octet-stream',
      label: 'Linux arm64 AppImage',
      platform: 'linux',
      arch: 'arm64',
      format: 'appimage',
      recommended: false,
      version: '0.1.1',
    },
  },
  {
    path: '/downloads/mere-run-node/linux/x86_64/deb/latest',
    aliases: ['/downloads/mere-run-node/linux/amd64/deb/latest'],
    manifestKey: 'releases/mere-run-node/linux/x86_64/deb/latest.json',
    contentType: 'application/vnd.debian.binary-package',
    label: 'Linux x86_64 Debian package',
    platform: 'linux',
    arch: 'x86_64',
    format: 'deb',
    recommended: true,
  },
  {
    path: '/downloads/mere-run-node/linux/arm64/deb/latest',
    aliases: ['/downloads/mere-run-node/linux/aarch64/deb/latest'],
    manifestKey: 'releases/mere-run-node/linux/arm64/deb/latest.json',
    contentType: 'application/vnd.debian.binary-package',
    label: 'Linux arm64 Debian package',
    platform: 'linux',
    arch: 'arm64',
    format: 'deb',
    recommended: true,
  },
];

const NODE_RELEASE_DOWNLOADS = new Map<string, NodeReleaseChannel>();
for (const channel of NODE_RELEASE_CHANNELS) {
  NODE_RELEASE_DOWNLOADS.set(channel.path, channel);
  for (const alias of channel.aliases || []) NODE_RELEASE_DOWNLOADS.set(alias, channel);
}

const NODE_RELEASE_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const NODE_RELEASE_SHA256_PATTERN = /^[a-f0-9]{64}$/;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
};

function relayDiscovery(env: Env): Response {
  const issuer = (env.BROKER_ORIGIN || 'https://mere.world').replace(/\/+$/, '');
  return Response.json({
    schema_version: 1,
    kind: 'mere.run/relay',
    graph_contract_versions: ['mere.run/job-bundle.v1'],
    auth: {
      issuer,
      authorization_endpoint: `${issuer}/oauth/authorize`,
      device_authorization_endpoint: `${issuer}/oauth/device_authorization`,
      token_endpoint: `${issuer}/oauth/token`,
      client_id: 'mererun-node',
      scope: 'openid profile email offline_access',
    },
  }, {
    headers: {
      ...corsHeaders,
      'Cache-Control': 'no-store',
    },
  });
}

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders)) {
    headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function uploadOwnerUserId(path: string, method: string): string | null {
  if (method !== 'POST') return null;
  const uploadMatch = path.match(/^\/upload\/([^/]+)\/[^/]+$/);
  if (uploadMatch) return decodeURIComponent(uploadMatch[1]);
  const audioUploadMatch = path.match(/^\/audio-upload\/([^/]+)\/[^/]+$/);
  if (audioUploadMatch) return decodeURIComponent(audioUploadMatch[1]);
  const toolUploadMatch = path.match(/^\/tool-upload\/([^/]+)\/[^/]+\/[^/]+$/);
  if (toolUploadMatch) return decodeURIComponent(toolUploadMatch[1]);
  return null;
}

async function handleNodeReleaseDownload(
  request: Request,
  env: Env,
  channel: NodeReleaseChannel
): Promise<Response> {
  const resolved = await resolveNodeRelease(env, channel);
  if (!resolved) {
    return Response.json(
      { error: `No ${channel.label} mere.run node build is published yet.` },
      { status: 404, headers: corsHeaders }
    );
  }
  const { release } = resolved;
  const object = await env.IMAGES.head(release.key);

  if (!object) {
    return Response.json(
      { error: `No ${release.label} mere.run node build is published yet.` },
      { status: 404, headers: corsHeaders }
    );
  }

  const headers = new Headers(corsHeaders);
  headers.set('Content-Type', release.contentType);
  headers.set('Content-Disposition', `attachment; filename="${release.filename}"`);
  // This URL is a mutable channel pointer. Never let an edge cache keep serving
  // the previous artifact after a manifest promotion.
  headers.set('Cache-Control', 'no-store');
  headers.set('X-Release-Key', release.key);
  headers.set('X-Release-Platform', release.platform);
  headers.set('X-Release-Arch', release.arch);
  headers.set('X-Release-Format', release.format);
  headers.set('X-Release-Version', release.version);
  if (release.sha256) headers.set('X-Release-Sha256', release.sha256);
  if (object.size) headers.set('Content-Length', String(object.size));
  if (object.uploaded) headers.set('Last-Modified', object.uploaded.toUTCString());
  if (object.httpEtag) headers.set('ETag', object.httpEtag);

  if (request.method === 'HEAD') {
    return new Response(null, { headers });
  }

  const objectBody = await env.IMAGES.get(release.key);
  if (!objectBody) {
    return Response.json(
      { error: `No ${release.label} mere.run node build is published yet.` },
      { status: 404, headers: corsHeaders }
    );
  }

  return new Response(objectBody.body, { headers });
}

function parseNodeReleaseManifest(value: unknown, channel: NodeReleaseChannel): NodeReleaseDownload | null {
  if (!value || typeof value !== 'object') return null;
  const manifest = value as Record<string, unknown>;
  const expectedKeyPrefix = channel.manifestKey.slice(0, -'latest.json'.length);
  const key = typeof manifest.key === 'string' ? manifest.key : '';
  const filename = typeof manifest.filename === 'string' ? manifest.filename : '';
  const version = typeof manifest.version === 'string' ? manifest.version : '';
  const sha256 = typeof manifest.sha256 === 'string' ? manifest.sha256.toLowerCase() : '';
  const publishedAt = typeof manifest.published_at === 'string' ? manifest.published_at : '';

  if (
    manifest.schema_version !== 1 ||
    manifest.product !== 'mere-run-node' ||
    manifest.platform !== channel.platform ||
    manifest.arch !== channel.arch ||
    (manifest.format !== undefined && manifest.format !== channel.format) ||
    manifest.content_type !== channel.contentType ||
    !key.startsWith(expectedKeyPrefix) ||
    key.endsWith('/latest.json') ||
    key.includes('..') ||
    !filename ||
    filename.includes('/') ||
    /[\r\n"]/u.test(filename) ||
    !NODE_RELEASE_VERSION_PATTERN.test(version) ||
    !NODE_RELEASE_SHA256_PATTERN.test(sha256) ||
    !publishedAt ||
    Number.isNaN(Date.parse(publishedAt))
  ) {
    return null;
  }

  return {
    key,
    filename,
    contentType: channel.contentType,
    label: channel.label,
    platform: channel.platform,
    arch: channel.arch,
    format: channel.format,
    recommended: channel.recommended,
    version,
    sha256,
    publishedAt,
  };
}

async function resolveNodeRelease(env: Env, channel: NodeReleaseChannel): Promise<ResolvedNodeRelease | null> {
  const manifestObject = await env.IMAGES.get(channel.manifestKey);
  if (!manifestObject) {
    return channel.fallback ? { release: channel.fallback, source: 'legacy-fallback' } : null;
  }

  try {
    const release = parseNodeReleaseManifest(
      parseJson(await manifestObject.text(), unknownJsonSchema),
      channel
    );
    if (release) return { release, source: 'r2-release-manifest' };
  } catch {
    // An incomplete or malformed promotion must not break the last known download.
  }

  return channel.fallback ? { release: channel.fallback, source: 'legacy-fallback' } : null;
}

function formatNodeReleaseBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}

async function handleNodeReleaseCatalog(env: Env): Promise<Response> {
  const resolved = await Promise.all(NODE_RELEASE_CHANNELS.map((channel) => resolveNodeRelease(env, channel)));
  const releases = (
    await Promise.all(
      resolved.map(async (resolvedRelease, index) => {
        if (!resolvedRelease) return null;
        const { release, source } = resolvedRelease;
        const object = await env.IMAGES.head(release.key);
        if (!object) return null;
        const channel = NODE_RELEASE_CHANNELS[index];
        return {
          version: release.version,
          platform: release.platform,
          arch: release.arch,
          format: release.format,
          recommended: release.recommended,
          label: release.label,
          filename: release.filename,
          content_type: release.contentType,
          size: object.size,
          size_label: formatNodeReleaseBytes(object.size),
          sha256: release.sha256 || null,
          published_at: release.publishedAt || object.uploaded?.toISOString() || null,
          download_url: `https://relay.mere.run${channel.path}`,
          source,
        };
      })
    )
  ).filter((release) => release !== null);

  return Response.json(
    {
      schema_version: 1,
      product: 'mere-run-node',
      releases,
      checked_at: new Date().toISOString(),
    },
    {
      headers: {
        ...corsHeaders,
        'Cache-Control': 'no-store',
      },
    }
  );
}

function mediaObjectKey(pathname: string): string | null {
  if (!pathname.startsWith(PUBLIC_MEDIA_PREFIX)) return null;
  let key: string;
  try {
    key = decodeURIComponent(pathname.slice(PUBLIC_MEDIA_PREFIX.length));
  } catch {
    return null;
  }
  const segments = key.split('/');
  if (
    !PUBLIC_MEDIA_KEY_PREFIXES.some((prefix) => key.startsWith(prefix))
    || segments.some((segment) => !segment || segment === '..' || segment === '.')
  ) {
    return null;
  }
  return key;
}

async function handlePublicMedia(request: Request, env: Env, key: string): Promise<Response> {
  const objectHead = await env.IMAGES.head(key);
  if (!objectHead) {
    return Response.json({ error: 'Media not found' }, { status: 404, headers: corsHeaders });
  }

  const headers = new Headers(corsHeaders);
  const meta = objectHead.httpMetadata;
  headers.set('Content-Type', meta?.contentType || 'application/octet-stream');
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Accept-Ranges', 'bytes');
  if (objectHead.uploaded) headers.set('Last-Modified', objectHead.uploaded.toUTCString());
  if (objectHead.httpEtag) headers.set('ETag', objectHead.httpEtag);

  if (request.method === 'HEAD') {
    headers.set('Content-Length', String(objectHead.size));
    return new Response(null, { headers });
  }

  const rangeHeader = request.headers.get('Range');
  if (rangeHeader) {
    const match = rangeHeader.match(/^bytes=(\d*)-(\d*)$/);
    const rawStart = match?.[1] ?? '';
    const rawEnd = match?.[2] ?? '';
    let offset = Number(rawStart);
    let end = rawEnd ? Number(rawEnd) : objectHead.size - 1;
    if (!rawStart && rawEnd) {
      const suffixLength = Number(rawEnd);
      offset = Math.max(0, objectHead.size - suffixLength);
      end = objectHead.size - 1;
    }
    if (!match || (!rawStart && !rawEnd) || !Number.isSafeInteger(offset) || !Number.isSafeInteger(end) || offset < 0 || end < offset || offset >= objectHead.size) {
      headers.set('Content-Range', `bytes */${objectHead.size}`);
      return new Response(null, { status: 416, headers });
    }
    end = Math.min(end, objectHead.size - 1);
    const length = end - offset + 1;
    const rangedObject = await env.IMAGES.get(key, { range: { offset, length } });
    if (!rangedObject) return Response.json({ error: 'Media not found' }, { status: 404, headers });
    headers.set('Content-Range', `bytes ${offset}-${end}/${objectHead.size}`);
    headers.set('Content-Length', String(length));
    return new Response(rangedObject.body, { status: 206, headers });
  }
  const object = await env.IMAGES.get(key);
  if (!object) return Response.json({ error: 'Media not found' }, { status: 404, headers });
  headers.set('Content-Length', String(objectHead.size));
  return new Response(object.body, { headers });
}

async function handleGraphNodeRequest(request: Request, env: Env, pathname: string): Promise<Response> {
  const match = pathname.match(/^\/api\/graph-node\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/);
  if (!match) return new Response('Not Found', { status: 404 });
  const ownerUserId = decodeURIComponent(match[1]);
  const jobId = match[2];
  const token = match[3];
  const action = match[4];
  const ownerId = env.MERE_RUN_RELAY.idFromName(ownerUserId);
  const relay = env.MERE_RUN_RELAY.get(ownerId);
  const headers = new Headers(request.headers);
  headers.set('X-User-Id', ownerUserId);
  return relay.fetch(new Request(
    `${new URL(request.url).origin}/internal/graph-node/${jobId}/${token}/${action}`,
    {
      method: request.method,
      headers,
      body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
    }
  ));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    if (url.pathname === '/auth/start' && request.method === 'GET') {
      return handleWebAuthStart(request, env);
    }
    if (url.pathname === '/auth/callback' && request.method === 'GET') {
      return handleWebAuthCallback(request, env);
    }
    if (url.pathname === '/auth/session' && request.method === 'GET') {
      return handleWebAuthSession(request, env);
    }
    if (url.pathname === '/auth/refresh' && request.method === 'POST') {
      return handleWebAuthRefresh(request, env);
    }
    if (url.pathname === '/auth/logout' && (request.method === 'GET' || request.method === 'POST')) {
      return handleWebAuthLogout(request);
    }

    if (
      url.pathname === '/.well-known/mere-run-node/releases.json' &&
      (request.method === 'GET' || request.method === 'HEAD')
    ) {
      const response = await handleNodeReleaseCatalog(env);
      if (request.method === 'HEAD') return new Response(null, response);
      return response;
    }

    if (
      url.pathname === '/.well-known/mere-run-relay' &&
      (request.method === 'GET' || request.method === 'HEAD')
    ) {
      const response = relayDiscovery(env);
      if (request.method === 'HEAD') return new Response(null, response);
      return response;
    }

    // WebSocket: Agent connection
    if (AGENT_PATHS.has(url.pathname)) {
      const upgrade = request.headers.get('Upgrade');
      if (upgrade?.toLowerCase() !== 'websocket') {
        return new Response('Expected WebSocket', { status: 426 });
      }

      // Authenticate account token or API key
      const auth = await authenticateAgent(request, env);
      if (!auth) {
        return new Response('Unauthorized', { status: 401 });
      }

      // Route to user's Durable Object
      const id = env.MERE_RUN_RELAY.idFromName(auth.user_id);
      const relay = env.MERE_RUN_RELAY.get(id);

      // Pass user_id to DO via header
      const doRequest = new Request(request.url, {
        headers: new Headers({
          ...Object.fromEntries(request.headers),
          'X-User-Id': auth.user_id,
        }),
      });

      return relay.fetch(doRequest);
    }

    const nodeReleaseDownload = NODE_RELEASE_DOWNLOADS.get(url.pathname);
    if ((request.method === 'GET' || request.method === 'HEAD') && nodeReleaseDownload) {
      return handleNodeReleaseDownload(request, env, nodeReleaseDownload);
    }

    const publicMediaKey = mediaObjectKey(url.pathname);
    if ((request.method === 'GET' || request.method === 'HEAD') && publicMediaKey) {
      return handlePublicMedia(request, env, publicMediaKey);
    }

    if (url.pathname.startsWith('/api/graph-node/')) {
      return withCors(await handleGraphNodeRequest(request, env, url.pathname));
    }

    if (url.pathname === '/api/asr/stream' && request.method === 'GET') {
      const token = url.searchParams.get('ticket') ?? '';
      const ticket = await openAsrTicket(env, token);
      if (!ticket) return new Response('Invalid or expired stream ticket', { status: 401 });
      const id = env.MERE_RUN_RELAY.idFromName(ticket.u);
      const relay = env.MERE_RUN_RELAY.get(id);
      const headers = new Headers(request.headers);
      headers.set('X-User-Id', ticket.u);
      return relay.fetch(new Request(
        `${url.origin}/internal/asr/stream?ticket=${encodeURIComponent(ticket.t)}`,
        { method: 'GET', headers }
      ));
    }

    const clientApiPath = getClientApiPath(url.pathname);

    // Relay-issued upload URLs are given to connected nodes. They carry the
    // owner id in the path and are accepted only by the owning DO/job handler.
    if (clientApiPath !== null) {
      const uploadOwner = uploadOwnerUserId(clientApiPath, request.method);
      if (uploadOwner) {
        return withCors(await handleClientApi(request, env, uploadOwner));
      }
    }

    // HTTP: Client API
    if (clientApiPath !== null) {
      const auth = await authenticateClient(request, env);
      if (!auth) {
        return Response.json(
          { error: 'Unauthorized' },
          { status: 401, headers: corsHeaders }
        );
      }

      if (
        !request.headers.has('Authorization')
        && request.method !== 'GET'
        && request.method !== 'HEAD'
        && request.headers.get('Origin') !== url.origin
      ) {
        return Response.json(
          { error: 'Cross-origin session mutation denied' },
          { status: 403, headers: corsHeaders }
        );
      }

      const response = await handleClientApi(request, env, auth.user_id);
      return withCors(response);
    }

    // Health check
    if (url.pathname === '/health') {
      return Response.json({ status: 'ok' });
    }

    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response('Not Found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
