import type { AgentInfo, GraphWorkerCapabilities } from './types';

export const MAX_WEBSOCKET_ATTACHMENT_BYTES = 16_384;
const TARGET_WEBSOCKET_ATTACHMENT_BYTES = 15_000;
const MAX_ATTACHMENT_CACHE_DIGESTS = 32;

function attachmentBytes(info: AgentInfo, agentId = info.agent_id): number {
  return new TextEncoder().encode(JSON.stringify({ agentId, info })).byteLength;
}

function compactGraphWorker(
  worker: GraphWorkerCapabilities | undefined
): GraphWorkerCapabilities | undefined {
  if (!worker) return undefined;
  return {
    ...worker,
    cached_asset_digests: worker.cached_asset_digests?.slice(0, MAX_ATTACHMENT_CACHE_DIGESTS),
    catalog: undefined,
  };
}

/**
 * Cloudflare caps hibernatable WebSocket attachments at 16 KiB. Keep the
 * scheduling contract in the attachment while the full inventory remains in
 * durable fleet storage for UI, audit, and graph catalog responses.
 */
export function compactAgentInfoForAttachment(info: AgentInfo): AgentInfo {
  let compact: AgentInfo = {
    ...info,
    capabilities: {
      ...info.capabilities,
      plugins: info.capabilities.plugins?.map((plugin) => ({
        name: plugin.name,
        version: plugin.version,
        commands: plugin.commands,
        capabilities: [],
      })),
      graph_worker: compactGraphWorker(info.capabilities.graph_worker),
    },
  };

  if (attachmentBytes(compact) > TARGET_WEBSOCKET_ATTACHMENT_BYTES) {
    compact = { ...compact, performance: undefined };
  }
  if (attachmentBytes(compact) > TARGET_WEBSOCKET_ATTACHMENT_BYTES) {
    compact = {
      ...compact,
      capabilities: {
        ...compact.capabilities,
        graph_worker: compact.capabilities.graph_worker
          ? { ...compact.capabilities.graph_worker, cached_asset_digests: [] }
          : undefined,
      },
    };
  }
  if (attachmentBytes(compact) > TARGET_WEBSOCKET_ATTACHMENT_BYTES) {
    compact = { ...compact, system: undefined, telemetry: undefined };
  }

  const byteLength = attachmentBytes(compact);
  if (byteLength > MAX_WEBSOCKET_ATTACHMENT_BYTES) {
    throw new Error(
      `Node scheduling inventory exceeds the ${MAX_WEBSOCKET_ATTACHMENT_BYTES}-byte Relay attachment limit (${byteLength} bytes)`
    );
  }
  return compact;
}

export function agentAttachmentByteLength(info: AgentInfo): number {
  return attachmentBytes(info);
}
