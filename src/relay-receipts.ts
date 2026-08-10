import { sha256Json, terminalErrorCode } from './execution';
import type { RelayContext } from './relay-context';
import type { Chat, GraphJob, RelayExecutionReceipt } from './types';

export function buildChatReceiptBase(
  ctx: RelayContext,
  chat: Chat,
  completedAt: string,
): Omit<RelayExecutionReceipt, 'state'> {
  const node = chat.agent_id ? ctx.getConnectedAgents().get(chat.agent_id)?.info : undefined;
  const startedAt = chat.started_at;
  const duration = startedAt ? Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)) : undefined;
  return {
    schema: 'relay.execution-receipt.v1',
    execution_id: chat.chat_id,
    request_sha256: chat.request_sha256,
    ...(chat.execution_spec_sha256 ? { execution_spec_sha256: chat.execution_spec_sha256 } : {}),
    model_id: chat.model?.trim() || chat.adapter?.base_model_id || 'text',
    ...(chat.adapter ? { adapter_manifest_sha256: chat.adapter.manifest_sha256 } : {}),
    provider_id: 'mere.run',
    ...(node?.runtime?.mere_run_version
      ? { provider_version: node.runtime.mere_run_version }
      : node?.version
        ? { provider_version: node.version }
        : {}),
    ...(node?.device_id ? { device_id: node.device_id } : {}),
    started_at: startedAt,
    completed_at: completedAt,
    ...(Number.isFinite(duration) ? { duration_ms: duration } : {}),
  };
}

export async function buildGraphReceipt(
  graph: GraphJob,
  state: RelayExecutionReceipt['state'],
  completedAt: string,
  values: { output?: unknown; error?: string } = {},
): Promise<RelayExecutionReceipt> {
  const provider = graph.job.requirements.providers?.[0];
  const startedAt = graph.started_at || graph.assigned_at;
  const duration = startedAt ? Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)) : undefined;
  return {
    schema: 'relay.execution-receipt.v1',
    execution_id: graph.job_id,
    request_sha256: graph.request_sha256 ?? await sha256Json({
      graph_fingerprint: graph.job.graph_fingerprint,
      input_fingerprint: graph.job.input_fingerprint,
    }),
    ...(graph.job.execution_spec_sha256
      ? { execution_spec_sha256: graph.job.execution_spec_sha256 }
      : {}),
    model_id: graph.job.requirements.model_ids[0] || 'graph',
    provider_id: provider?.id ?? 'mere.run',
    ...(provider?.version ? { provider_version: provider.version } : {}),
    ...(provider?.catalog_sha256 ? { provider_catalog_sha256: provider.catalog_sha256 } : {}),
    ...(graph.assigned_device_id ? { device_id: graph.assigned_device_id } : {}),
    started_at: startedAt,
    completed_at: completedAt,
    ...(Number.isFinite(duration) ? { duration_ms: duration } : {}),
    state,
    ...(values.output === undefined ? {} : { output_sha256: await sha256Json(values.output) }),
    ...(values.error ? { error_code: terminalErrorCode(values.error) ?? 'EXECUTION_FAILED' } : {}),
  };
}
