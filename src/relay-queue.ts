import type {
  AgentInfo,
  Job,
  Chat,
  Talk,
  Asr,
  Embed,
  Ocr,
  Tool,
  GraphJob,
  JobMessage,
  ChatRequestMessage,
  TalkRequestMessage,
  AsrRequestMessage,
  EmbedRequestMessage,
  OcrRequestMessage,
  ToolRequestMessage,
  GraphRequestMessage,
  GraphPlacementBlocker,
  GraphPlacementReport,
  SchedulerMode,
  AsrBackend,
} from './types';
import type { ConnectedAgentRecord, QueuedWorkDescriptor, RelayContext } from './relay-context';
import { getInputImageKey, getInputImageUrl } from './r2';
import { batchIsFenced } from './relay-batch-fence';
import {
  agentCanAcceptWork,
  getFleetSettings,
  graphCachedInputBytes,
  scoreAgentForGraph,
  scoreAgentForWork,
} from './relay-fleet';
import { graphUploadUrlBase, materializeRelayBundle } from './relay-graph-storage';
import { hasLocalCustody, LOCAL_CUSTODY_POLICY } from './relay-graph-custody';

function normalizeModelName(model: string): string {
  const normalized = model.toLowerCase();
  if (normalized === 'zero-nano') {
    return 'mere-nano';
  }
  return normalized;
}

export function agentHasModel(info: AgentInfo, model: string): boolean {
  const expected = normalizeModelName(model);
  return info.capabilities.models.some((candidate) => normalizeModelName(candidate) === expected);
}

function agentHasModelPrefix(info: AgentInfo, prefix: string): boolean {
  const expected = prefix.toLowerCase();
  return info.capabilities.models.some((candidate) => candidate.toLowerCase().startsWith(expected));
}

function inferJobKind(job: Job): 'image' | 'music' | 'video' {
  if (job.request.kind) return job.request.kind;
  const model = job.request.model?.toLowerCase() ?? '';
  if (model === 'ltxvideo' || model.startsWith('video-')) return 'video';
  if (model.startsWith('music-')) return 'music';
  return 'image';
}

function supportsRequestedModelOrMarker(
  info: AgentInfo,
  model: string | undefined,
  marker: string,
  prefix: string
): boolean {
  if (model?.trim()) {
    return agentHasModel(info, model) || agentHasModel(info, marker);
  }
  return agentHasModel(info, marker) || agentHasModelPrefix(info, prefix);
}

export function supportsJob(info: AgentInfo, job: Job): boolean {
  if (job.required_device_id && info.device_id !== job.required_device_id) return false;
  if (job.required_device_id && job.request.model?.trim() && !agentHasModel(info, job.request.model)) return false;
  const kind = inferJobKind(job);
  if (kind === 'music') {
    return supportsRequestedModelOrMarker(info, job.request.model, 'music', 'music-');
  }
  if (kind === 'video') {
    if (job.request.video_controls_version === 1 && info.capabilities.video_request_controls !== 1) return false;
    return supportsRequestedModelOrMarker(info, job.request.model, 'video', 'video-');
  }

  if (
    job.request.width > info.capabilities.max_resolution
    || job.request.height > info.capabilities.max_resolution
  ) {
    return false;
  }

  if ((job.request.input_image_url || job.request.input_image_data) && !info.capabilities.img2img) {
    return false;
  }

  return supportsRequestedModelOrMarker(info, job.request.model, 'image', 'image-');
}

export function supportsChat(info: AgentInfo, chat: Chat): boolean {
  if (chat.required_device_id && info.device_id !== chat.required_device_id) {
    return false;
  }
  const effectiveModel = chat.model?.trim() || chat.adapter?.base_model_id;
  if (effectiveModel) {
    const requiresExactModel = Boolean(chat.adapter || chat.execution_spec_sha256);
    const hasModel = requiresExactModel
      ? agentHasModel(info, effectiveModel)
      : agentHasModel(info, effectiveModel) || agentHasModel(info, 'text');
    if (!hasModel) {
      return false;
    }
  } else if (
    !agentHasModel(info, 'text')
    && !agentHasModel(info, 'mere-nano')
    && !agentHasModelPrefix(info, 'text-chat-')
  ) {
    return false;
  }

  if (chat.use_lora === true && !info.capabilities.lora) {
    return false;
  }

  if (chat.adapter) {
    const installed = info.capabilities.text_adapters ?? [];
    if (!installed.some((adapter) =>
      adapter.manifest_sha256 === chat.adapter?.manifest_sha256
      && adapter.base_model_id === chat.adapter.base_model_id
    )) return false;
  }

  return true;
}

export function supportsTalk(info: AgentInfo): boolean {
  return agentHasModel(info, 'talk-nano');
}

function asrBackendModel(backend: AsrBackend): string | null {
  if (backend === 'parakeet') return 'speech-asr-parakeet';
  if (backend === 'qwen') return 'speech-asr-qwen3';
  return null;
}

function agentReportsInstalledModel(info: AgentInfo, model: string): boolean {
  return agentHasModel(info, model)
    || (info.runtime?.installed_models ?? []).some((candidate) =>
      normalizeModelName(candidate) === normalizeModelName(model)
    );
}

function supportsConcreteAsrBackend(
  info: AgentInfo,
  backend: Exclude<AsrBackend, 'auto'>
): boolean {
  if (info.capabilities.asr_streaming?.backends?.includes(backend)) return true;
  const model = asrBackendModel(backend);
  if (!model) return false;

  // Node 0.2.10 predates backend advertisement. mere.run 0.24+ guarantees
  // that auto transcription with an installed Parakeet model selects Parakeet.
  return backend === 'parakeet'
    && agentReportsInstalledModel(info, model)
    && compareVersions(info.runtime?.mere_run_version ?? '', '0.24.0') >= 0;
}

export function resolveAsrBackend(
  info: AgentInfo,
  backend: AsrBackend
): Exclude<AsrBackend, 'auto'> | null {
  if (backend !== 'auto') {
    return supportsConcreteAsrBackend(info, backend) ? backend : null;
  }
  if (supportsConcreteAsrBackend(info, 'parakeet')) return 'parakeet';
  if (
    supportsConcreteAsrBackend(info, 'qwen')
    || agentReportsInstalledModel(info, 'speech-asr-qwen3')
    || agentHasModel(info, 'asr')
  ) {
    return 'qwen';
  }
  return null;
}

export function supportsAsrBackend(info: AgentInfo, backend: AsrBackend): boolean {
  return resolveAsrBackend(info, backend) !== null;
}

export function supportsAsr(info: AgentInfo, asr?: Asr): boolean {
  if (!agentHasModel(info, 'asr') && !agentHasModelPrefix(info, 'speech-asr-')) return false;
  if (asr?.request.diarize && !agentReportsInstalledModel(info, 'speech-diarization-sortformer')) {
    return false;
  }
  return supportsAsrBackend(info, asr?.request.backend ?? 'auto');
}

export function supportsEmbed(info: AgentInfo): boolean {
  return agentHasModel(info, 'embed') || agentHasModel(info, 'text-embed-qwen3-0.6b');
}

export function supportsOcr(info: AgentInfo): boolean {
  return agentHasModel(info, 'ocr');
}

export function supportsTool(info: AgentInfo, tool: Tool): boolean {
  const plugins = info.capabilities.plugins ?? [];
  return plugins.some((plugin) => {
    if (plugin.name !== tool.request.plugin) return false;
    if (!plugin.commands.includes(tool.request.command)) return false;
    return true;
  });
}

function requiredDeviceBlockers(info: AgentInfo, graph: GraphJob): GraphPlacementBlocker[] {
  const custody: GraphPlacementBlocker[] = [];
  if (hasLocalCustody(graph)) {
    if (!info.capabilities.graph_worker?.data_policies?.includes(LOCAL_CUSTODY_POLICY)) {
      custody.push({ code: 'data_policy_unsupported', message: 'Node must support the requested local-custody data policy' });
    }
    if (graph.payload_redacted && ['planned', 'queued'].includes(graph.state)) {
      custody.push({ code: 'payload_replay_required', message: 'Resubmit the exact original request to recover its transient payload' });
    }
  }
  const requiredDeviceId = graph.job.requirements.required_device_id;
  if (!requiredDeviceId || info.device_id === requiredDeviceId) return custody;
  return [...custody, {
    code: 'required_device_mismatch',
    message: `Job is pinned to device ${requiredDeviceId}`,
  }];
}

function graphProviderBlockers(info: AgentInfo, graph: GraphJob): GraphPlacementBlocker[] {
  const blockers: GraphPlacementBlocker[] = [];
  const providers = info.capabilities.graph_worker?.providers ?? [];
  for (const required of graph.job.requirements.providers ?? []) {
    const provider = providers.find((candidate) => candidate.id === required.id);
    if (!provider) {
      blockers.push({
        code: 'graph_provider_missing',
        message: `Required graph provider ${required.id} is not installed`,
      });
      continue;
    }
    if (provider.version !== required.version || provider.catalog_sha256 !== required.catalog_sha256) {
      blockers.push({
        code: 'graph_provider_mismatch',
        message: `Graph provider ${required.id} does not match required version ${required.version} and catalog ${required.catalog_sha256}`,
      });
      continue;
    }
    for (const kind of required.node_kinds) {
      if (!provider.node_kinds.includes(kind)) {
        blockers.push({
          code: 'graph_provider_node_kind_missing',
          message: `Graph provider ${required.id} does not advertise node kind ${kind}`,
        });
      }
    }
  }
  return blockers;
}

function assignmentTokenBlockers(info: AgentInfo, graph: GraphJob): GraphPlacementBlocker[] {
  return graph.requires_assignment_token && info.capabilities.graph_worker?.assignment_tokens !== true
    ? [{ code: 'assignment_tokens_required', message: 'Batch jobs require attempt-token-aware workers' }] : [];
}

export function graphCapabilityBlockers(
  info: AgentInfo,
  graph: GraphJob
): GraphPlacementBlocker[] {
  const blockers = requiredDeviceBlockers(info, graph);
  const worker = info.capabilities.graph_worker;
  if (!worker) {
    return [{ code: 'graph_worker_missing', message: 'Node does not advertise graph worker support' }];
  }
  blockers.push(...assignmentTokenBlockers(info, graph));
  if (!worker.contract_versions.includes(graph.job.contract_version)) {
    blockers.push({
      code: 'contract_version_unsupported',
      message: `Graph contract ${graph.job.contract_version} is not supported`,
    });
  }
  if (compareVersions(worker.worker_version, graph.job.requirements.minimum_mere_run_version) < 0) {
    blockers.push({
      code: 'worker_version_too_old',
      message: `Worker ${worker.worker_version} is older than required ${graph.job.requirements.minimum_mere_run_version}`,
    });
  }
  for (const kind of graph.job.requirements.node_kinds) {
    if (!worker.node_kinds.includes(kind)) {
      blockers.push({ code: 'node_kind_missing', message: `Node kind ${kind} is not supported` });
    }
  }
  blockers.push(...graphProviderBlockers(info, graph));
  for (const model of graph.job.requirements.model_ids) {
    if (!worker.installed_model_ids.includes(model)) {
      blockers.push({ code: 'model_missing', message: `Required model ${model} is not installed` });
    }
  }
  if (!graph.job.requirements.accelerator_backends.includes(worker.accelerator_backend)) {
    blockers.push({
      code: 'accelerator_backend_unsupported',
      message: `Accelerator ${worker.accelerator_backend} is not accepted by this graph`,
    });
  }
  const minimumMemory = graph.job.requirements.minimum_accelerator_memory_bytes;
  if (minimumMemory !== undefined && worker.memory_bytes < minimumMemory) {
    blockers.push({
      code: 'accelerator_memory_insufficient',
      message: `Accelerator memory ${worker.memory_bytes} is below required ${minimumMemory} bytes`,
    });
  }
  const minimumSystemMemory = graph.job.requirements.minimum_system_memory_bytes;
  if (minimumSystemMemory !== undefined && (worker.system_memory_bytes ?? 0) < minimumSystemMemory) {
    blockers.push({
      code: 'system_memory_insufficient',
      message: `System memory ${worker.system_memory_bytes ?? 0} is below required ${minimumSystemMemory} bytes`,
    });
  }
  const minimumCPUCores = graph.job.requirements.minimum_cpu_cores;
  if (minimumCPUCores !== undefined && (worker.logical_cpu_cores ?? 0) < minimumCPUCores) {
    blockers.push({
      code: 'cpu_capacity_insufficient',
      message: `Logical CPU cores ${worker.logical_cpu_cores ?? 0} are below required ${minimumCPUCores}`,
    });
  }
  if (graph.job.requirements.network_access && worker.network_access !== true) {
    blockers.push({
      code: 'network_access_unavailable',
      message: 'Graph requires network access that this node does not advertise',
    });
  }
  const availableSecrets = new Set(worker.available_secret_names ?? []);
  for (const secret of graph.job.requirements.secret_names ?? []) {
    if (!availableSecrets.has(secret)) {
      blockers.push({ code: 'secret_missing', message: `Required configured secret ${secret} is unavailable` });
    }
  }
  const inputBytes = graph.assets.groups
    .flatMap((group) => group.entries)
    .reduce((total, entry) => total + entry.size_bytes, 0);
  const requiredBytes = Math.max(inputBytes, graph.job.requirements.minimum_disk_bytes ?? 0);
  if (requiredBytes > 0 && (worker.available_disk_bytes === undefined || worker.available_disk_bytes < requiredBytes)) {
    blockers.push({
      code: 'disk_space_insufficient',
      message: `Available disk ${worker.available_disk_bytes ?? 0} is below required ${requiredBytes} bytes`,
    });
  }
  return blockers;
}

export function supportsGraph(info: AgentInfo, graph: GraphJob): boolean {
  return graphCapabilityBlockers(info, graph).length === 0;
}

export function graphPlacementReport(
  ctx: RelayContext,
  graph: GraphJob
): GraphPlacementReport {
  const totalInputBytes = graph.assets.groups
    .flatMap((group) => group.entries)
    .reduce((total, entry) => total + entry.size_bytes, 0);
  const nodes = [...ctx.getConnectedAgents().values()].map(({ info }) => {
    const blockers: GraphPlacementBlocker[] = [];
    if (info.status !== 'online') {
      blockers.push({ code: 'node_busy', message: `Node is busy with ${info.current_job_id ?? 'another job'}` });
    }
    if (info.policy?.enabled === false) {
      blockers.push({ code: 'node_disabled', message: 'Node is disabled by fleet policy' });
    }
    if (info.policy?.draining) {
      blockers.push({ code: 'node_draining', message: 'Node is draining and cannot accept new work' });
    }
    if (info.policy?.revoked) {
      blockers.push({ code: 'node_revoked', message: 'Node access is revoked' });
    }
    blockers.push(...graphCapabilityBlockers(info, graph));
    return {
      agent_id: info.agent_id,
      device_id: info.device_id,
      device_name: info.device_name,
      status: info.status,
      eligible: blockers.length === 0,
      blockers,
      cached_input_bytes: graphCachedInputBytes(info, graph),
      total_input_bytes: totalInputBytes,
    };
  }).sort((left, right) => left.device_name.localeCompare(right.device_name));
  const graphWorkerNodes = nodes.filter((node) =>
    !node.blockers.some((blocker) => blocker.code === 'graph_worker_missing')
  ).length;
  const eligibleNodes = nodes.filter((node) => node.eligible).length;
  let diagnostic: string | null = null;
  if (eligibleNodes === 0) {
    const hasCapabilityMatch = nodes.some((node) =>
      node.blockers.every((blocker) => [
        'node_busy',
        'node_disabled',
        'node_draining',
        'node_revoked',
      ].includes(blocker.code))
    );
    if (nodes.length === 0) {
      diagnostic = 'No nodes are connected to this relay fleet';
    } else if (graphWorkerNodes === 0) {
      diagnostic = 'Connected nodes do not advertise graph worker support';
    } else if (hasCapabilityMatch) {
      diagnostic = 'Compatible graph workers are busy or blocked by fleet policy';
    } else {
      const reasons = [...new Set(nodes.flatMap((node) => node.blockers.map((blocker) => blocker.message)))];
      diagnostic = `No connected graph worker satisfies this job: ${reasons.slice(0, 3).join('; ')}`;
    }
  }
  return {
    connected_nodes: nodes.length,
    graph_worker_nodes: graphWorkerNodes,
    eligible_nodes: eligibleNodes,
    diagnostic,
    nodes,
  };
}

function compareVersions(left: string, right: string): number {
  const parse = (value: string): number[] => {
    const version = value.match(/\d+(?:\.\d+){0,2}/u)?.[0] ?? '';
    return version.split('.').slice(0, 3).map((part) => Number.parseInt(part, 10) || 0);
  };
  const lhs = parse(left);
  const rhs = parse(right);
  for (let index = 0; index < Math.max(lhs.length, rhs.length); index++) {
    const difference = (lhs[index] || 0) - (rhs[index] || 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function anyCapableAgent(
  ctx: RelayContext,
  supports: (info: AgentInfo) => boolean
): boolean {
  for (const agent of ctx.getConnectedAgents().values()) {
    if (agentCanAcceptWork(agent.info) && supports(agent.info)) {
      return true;
    }
  }
  return false;
}

export function hasCapableAgentForJob(ctx: RelayContext, job: Job): boolean {
  if (job.required_device_id && job.user_id !== ctx.userId) return false;
  return anyCapableAgent(ctx, (info) => supportsJob(info, job));
}

export function hasCapableAgentForChat(ctx: RelayContext, chat: Chat): boolean {
  return anyCapableAgent(ctx, (info) => supportsChat(info, chat));
}

export function hasCapableAgentForTalk(ctx: RelayContext): boolean {
  return anyCapableAgent(ctx, supportsTalk);
}

export function hasCapableAgentForAsr(ctx: RelayContext, asr?: Asr): boolean {
  return anyCapableAgent(ctx, (info) => supportsAsr(info, asr));
}

export function hasCapableAgentForEmbed(ctx: RelayContext): boolean {
  return anyCapableAgent(ctx, supportsEmbed);
}

export function hasCapableAgentForOcr(ctx: RelayContext): boolean {
  return anyCapableAgent(ctx, supportsOcr);
}

export function hasCapableAgentForTool(ctx: RelayContext, tool: Tool): boolean {
  return anyCapableAgent(ctx, (info) => supportsTool(info, tool));
}

export function hasCapableAgentForGraph(ctx: RelayContext, graph: GraphJob): boolean {
  return anyCapableAgent(ctx, (info) => supportsGraph(info, graph));
}

function getQueuedPosition<T>(
  items: Iterable<T>,
  targetId: string,
  getId: (item: T) => string,
  isQueued: (item: T) => boolean
): number {
  let position = 0;
  for (const item of items) {
    if (getId(item) === targetId) return position;
    if (isQueued(item)) position++;
  }
  return position;
}

export function getQueuePosition(ctx: RelayContext, jobId: string): number {
  return getQueuedPosition(ctx.jobs.values(), jobId, (job) => job.job_id, (job) => job.status === 'queued');
}

export function getChatQueuePosition(ctx: RelayContext, chatId: string): number {
  return getQueuedPosition(ctx.chats.values(), chatId, (chat) => chat.chat_id, (chat) => chat.status === 'queued');
}

export function getTalkQueuePosition(ctx: RelayContext, talkId: string): number {
  return getQueuedPosition(ctx.talks.values(), talkId, (talk) => talk.talk_id, (talk) => talk.status === 'queued');
}

export function getAsrQueuePosition(ctx: RelayContext, asrId: string): number {
  return getQueuedPosition(ctx.asrs.values(), asrId, (asr) => asr.asr_id, (asr) => asr.status === 'queued');
}

export function getEmbedQueuePosition(ctx: RelayContext, embedId: string): number {
  return getQueuedPosition(
    ctx.embeds.values(),
    embedId,
    (embed) => embed.embed_id,
    (embed) => embed.status === 'queued'
  );
}

export function getOcrQueuePosition(ctx: RelayContext, ocrId: string): number {
  return getQueuedPosition(ctx.ocrs.values(), ocrId, (ocr) => ocr.ocr_id, (ocr) => ocr.status === 'queued');
}

export function getToolQueuePosition(ctx: RelayContext, toolId: string): number {
  return getQueuedPosition(ctx.tools.values(), toolId, (tool) => tool.tool_id, (tool) => tool.status === 'queued');
}

export function getGraphQueuePosition(ctx: RelayContext, jobId: string): number {
  return getQueuedPosition(
    ctx.graphJobs.values(),
    jobId,
    (job) => job.job_id,
    (job) => job.state === 'queued'
  );
}

export function countQueuedWork(ctx: RelayContext): number {
  return collectQueuedWork(ctx).length;
}

export function collectQueuedWork(ctx: RelayContext): QueuedWorkDescriptor[] {
  const allWork: QueuedWorkDescriptor[] = [];

  for (const job of ctx.jobs.values()) {
    if (job.status === 'queued') {
      allWork.push({ type: 'job', id: job.job_id, createdAt: job.created_at });
    }
  }

  for (const chat of ctx.chats.values()) {
    if (chat.status === 'queued') {
      allWork.push({ type: 'chat', id: chat.chat_id, createdAt: chat.created_at });
    }
  }

  for (const talk of ctx.talks.values()) {
    if (talk.status === 'queued') {
      allWork.push({ type: 'talk', id: talk.talk_id, createdAt: talk.created_at });
    }
  }

  for (const asr of ctx.asrs.values()) {
    if (asr.status === 'queued') {
      allWork.push({ type: 'asr', id: asr.asr_id, createdAt: asr.created_at });
    }
  }

  for (const embed of ctx.embeds.values()) {
    if (embed.status === 'queued') {
      allWork.push({ type: 'embed', id: embed.embed_id, createdAt: embed.created_at });
    }
  }

  for (const ocr of ctx.ocrs.values()) {
    if (ocr.status === 'queued') {
      allWork.push({ type: 'ocr', id: ocr.ocr_id, createdAt: ocr.created_at });
    }
  }

  for (const tool of ctx.tools.values()) {
    if (tool.status === 'queued') {
      allWork.push({ type: 'tool', id: tool.tool_id, createdAt: tool.created_at });
    }
  }

  for (const graph of ctx.graphJobs.values()) {
    if (graph.state === 'queued') {
      allWork.push({ type: 'graph', id: graph.job_id, createdAt: graph.created_at });
    }
  }

  allWork.sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime());
  return allWork;
}

const preparingAgents = new WeakMap<DurableObjectStorage, Map<string, { ws: WebSocket; workId: string }>>();

function reserveAgent(ctx: RelayContext, agent: ConnectedAgentRecord, workId: string): void {
  const reservations = preparingAgents.get(ctx.storage) ?? new Map<string, { ws: WebSocket; workId: string }>();
  reservations.set(agent.info.agent_id, { ws: agent.ws, workId });
  preparingAgents.set(ctx.storage, reservations);
  updateAssignedAgentState(ctx, agent.ws, workId);
}

function agentIsPreparing(ctx: RelayContext, agent: ConnectedAgentRecord): boolean {
  return preparingAgents.get(ctx.storage)?.get(agent.info.agent_id)?.ws === agent.ws;
}

function releasePreparation(ctx: RelayContext, agent: ConnectedAgentRecord, workId: string): void {
  const reservations = preparingAgents.get(ctx.storage);
  const reservation = reservations?.get(agent.info.agent_id);
  if (reservation?.ws === agent.ws && reservation.workId === workId) reservations?.delete(agent.info.agent_id);
}

function agentHasAssignedGraph(ctx: RelayContext, agentId: string): boolean {
  return [...ctx.graphJobs.values()].some((job) => job.agent_id === agentId && ['assigned', 'preflighting', 'running'].includes(job.state));
}

async function getOnlineAgent(
  ctx: RelayContext,
  supports: (info: AgentInfo) => boolean,
  model: string,
  workId: string,
  preferredAgentId?: string,
  scoreOverride?: (info: AgentInfo, mode: SchedulerMode) => number
): Promise<ConnectedAgentRecord | undefined> {
  const agents = ctx.getConnectedAgents();
  if (preferredAgentId) {
    const preferred = agents.get(preferredAgentId);
    if (
      preferred
      && preferred.info.status === 'online'
      && agentCanAcceptWork(preferred.info)
      && supports(preferred.info)
      && !agentIsPreparing(ctx, preferred) && !agentHasAssignedGraph(ctx, preferred.info.agent_id)
    ) {
      reserveAgent(ctx, preferred, workId);
      return preferred;
    }
  }

  const settings = await getFleetSettings(ctx);
  const candidates: ConnectedAgentRecord[] = [];
  for (const agent of agents.values()) {
    if (
      agent.info.status === 'online'
      && agentCanAcceptWork(agent.info)
      && supports(agent.info)
      && !agentIsPreparing(ctx, agent) && !agentHasAssignedGraph(ctx, agent.info.agent_id)
    ) {
      candidates.push(agent);
    }
  }
  const score = scoreOverride
    ?? ((info: AgentInfo): number => scoreAgentForWork(info, model, settings.scheduler_mode));
  candidates.sort((left, right) =>
    score(right.info, settings.scheduler_mode)
    - score(left.info, settings.scheduler_mode)
    || left.info.connected_at.localeCompare(right.info.connected_at)
    || left.info.agent_id.localeCompare(right.info.agent_id)
  );
  const selected = candidates[0];
  if (selected) reserveAgent(ctx, selected, workId);
  return selected;
}

function updateAssignedAgentState(
  ctx: RelayContext,
  ws: WebSocket,
  workId: string
): void {
  ctx.updateAgentInfo(ws, { status: 'busy', current_job_id: workId });
}

async function sendJobToAgent(
  ctx: RelayContext,
  job: Job,
  agent: ConnectedAgentRecord
): Promise<boolean> {
  let request = job.request;
  if (request.input_image_data) {
    const imageBytes = Uint8Array.from(atob(request.input_image_data), (char) => char.charCodeAt(0));
    const key = getInputImageKey(job.user_id, job.job_id);
    await ctx.env.IMAGES.put(key, imageBytes, { httpMetadata: { contentType: 'image/jpeg' } });
    request = {
      ...request,
      input_image_data: null,
      input_image_url: getInputImageUrl(ctx.env, job.user_id, job.job_id),
    };
  }

  const leaseId = `lease_${crypto.randomUUID()}`;
  const nextAttempt = (job.attempts ?? 0) + 1;
  const message: JobMessage = {
    type: 'job',
    job_id: job.job_id,
    lease_id: leaseId,
    client_id: job.client_id,
    owner_user_id: job.user_id,
    upload_url: job.upload_url,
    direct_image: job.direct_image,
    request,
  };

  try {
    agent.ws.send(JSON.stringify(message));
    job.agent_id = agent.info.agent_id;
    job.lease_id = leaseId;
    job.lease_aware = agent.info.capacity?.lease_protocol === true;
    job.attempts = nextAttempt;
    job.status = 'assigned';
    job.assigned_at = new Date().toISOString();
    await ctx.saveJob(job);
    updateAssignedAgentState(ctx, agent.ws, job.job_id);
    console.log(`Job ${job.job_id} assigned to ${agent.info.agent_id}`);
    return true;
  } catch (error) {
    console.error('Failed to send job to agent:', error);
    return false;
  }
}

async function sendChatToAgent(
  ctx: RelayContext,
  chat: Chat,
  agent: ConnectedAgentRecord
): Promise<boolean> {
  const message: ChatRequestMessage = {
    type: 'chat_request',
    chat_id: chat.chat_id,
    client_id: chat.client_id,
    messages: chat.messages,
    max_tokens: chat.max_tokens ?? 512,
    temperature: chat.temperature ?? 0.7,
    requires_json: chat.requires_json,
    use_lora: chat.use_lora,
    adapter: chat.adapter,
    model: chat.model,
  };

  try {
    agent.ws.send(JSON.stringify(message));
    chat.agent_id = agent.info.agent_id;
    chat.assigned_node = {
      device_id: agent.info.device_id,
      provider_version: agent.info.runtime?.mere_run_version || agent.info.version,
    };
    chat.status = 'processing';
    chat.started_at = new Date().toISOString();
    await ctx.saveChat(chat);
    updateAssignedAgentState(ctx, agent.ws, chat.chat_id);
    console.log(`Chat ${chat.chat_id} assigned to ${agent.info.agent_id}`);
    return true;
  } catch (error) {
    console.error('Failed to send chat to agent:', error);
    return false;
  }
}

async function sendTalkToAgent(
  ctx: RelayContext,
  talk: Talk,
  agent: ConnectedAgentRecord
): Promise<boolean> {
  const message: TalkRequestMessage = {
    type: 'talk_request',
    talk_id: talk.talk_id,
    client_id: talk.client_id,
    owner_user_id: talk.user_id,
    upload_url: talk.upload_url,
    direct_audio: talk.direct_audio,
    request: talk.request,
  };

  try {
    agent.ws.send(JSON.stringify(message));
    talk.agent_id = agent.info.agent_id;
    talk.status = 'processing';
    talk.started_at = new Date().toISOString();
    await ctx.saveTalk(talk);
    updateAssignedAgentState(ctx, agent.ws, talk.talk_id);
    console.log(`Talk ${talk.talk_id} assigned to ${agent.info.agent_id}`);
    return true;
  } catch (error) {
    console.error('Failed to send talk request to agent:', error);
    return false;
  }
}

async function sendAsrToAgent(
  ctx: RelayContext,
  asr: Asr,
  agent: ConnectedAgentRecord
): Promise<boolean> {
  const message: AsrRequestMessage = {
    type: 'asr_request',
    asr_id: asr.asr_id,
    client_id: asr.client_id,
    owner_user_id: asr.user_id,
    request: asr.request,
  };

  try {
    agent.ws.send(JSON.stringify(message));
    asr.agent_id = agent.info.agent_id;
    asr.status = 'processing';
    asr.started_at = new Date().toISOString();
    await ctx.saveAsr(asr);
    updateAssignedAgentState(ctx, agent.ws, asr.asr_id);
    console.log(`ASR ${asr.asr_id} assigned to ${agent.info.agent_id}`);
    return true;
  } catch (error) {
    console.error('Failed to send ASR request to agent:', error);
    return false;
  }
}

async function sendEmbedToAgent(
  ctx: RelayContext,
  embed: Embed,
  agent: ConnectedAgentRecord
): Promise<boolean> {
  const message: EmbedRequestMessage = {
    type: 'embed_request',
    embed_id: embed.embed_id,
    client_id: embed.client_id,
    owner_user_id: embed.user_id,
    request: embed.request,
  };

  try {
    agent.ws.send(JSON.stringify(message));
    embed.agent_id = agent.info.agent_id;
    embed.status = 'processing';
    embed.started_at = new Date().toISOString();
    await ctx.saveEmbed(embed);
    updateAssignedAgentState(ctx, agent.ws, embed.embed_id);
    console.log(`Embed ${embed.embed_id} assigned to ${agent.info.agent_id}`);
    return true;
  } catch (error) {
    console.error('Failed to send embed request to agent:', error);
    return false;
  }
}

async function sendOcrToAgent(
  ctx: RelayContext,
  ocr: Ocr,
  agent: ConnectedAgentRecord
): Promise<boolean> {
  const message: OcrRequestMessage = {
    type: 'ocr_request',
    ocr_id: ocr.ocr_id,
    client_id: ocr.client_id,
    owner_user_id: ocr.user_id,
    request: ocr.request,
  };

  try {
    agent.ws.send(JSON.stringify(message));
    ocr.agent_id = agent.info.agent_id;
    ocr.status = 'processing';
    ocr.started_at = new Date().toISOString();
    await ctx.saveOcr(ocr);
    updateAssignedAgentState(ctx, agent.ws, ocr.ocr_id);
    console.log(`OCR ${ocr.ocr_id} assigned to ${agent.info.agent_id}`);
    return true;
  } catch (error) {
    console.error('Failed to send OCR request to agent:', error);
    return false;
  }
}

async function sendToolToAgent(
  ctx: RelayContext,
  tool: Tool,
  agent: ConnectedAgentRecord
): Promise<boolean> {
  const message: ToolRequestMessage = {
    type: 'tool_request',
    tool_id: tool.tool_id,
    client_id: tool.client_id,
    owner_user_id: tool.user_id,
    upload_url_base: tool.upload_url_base,
    request: tool.request,
  };

  try {
    agent.ws.send(JSON.stringify(message));
    tool.agent_id = agent.info.agent_id;
    tool.status = 'processing';
    tool.started_at = new Date().toISOString();
    await ctx.saveTool(tool);
    updateAssignedAgentState(ctx, agent.ws, tool.tool_id);
    console.log(`Tool ${tool.tool_id} assigned to ${agent.info.agent_id}`);
    return true;
  } catch (error) {
    console.error('Failed to send tool request to agent:', error);
    return false;
  }
}

async function sendGraphToAgent(
  ctx: RelayContext, graph: GraphJob, agent: ConnectedAgentRecord
): Promise<boolean> {
  if (graph.state !== 'queued') { releasePreparation(ctx, agent, graph.job_id); return false; }
  const token = crypto.randomUUID().replaceAll('-', '');
  updateAssignedAgentState(ctx, agent.ws, graph.job_id);
  graph.node_token = token;
  graph.agent_id = agent.info.agent_id;
  graph.assigned_device_id = agent.info.device_id;
  graph.state = 'assigned';
  graph.assigned_at = new Date().toISOString();
  graph.updated_at = graph.assigned_at;
  graph.attempt += 1;
  try {
    await ctx.saveGraphJob(graph);
    const bundleFiles = await materializeRelayBundle(ctx, graph);
    const message = await prepareGraphMessage(ctx, graph, agent, token, bundleFiles);
    if (!message) return false;
    const latest = ctx.graphJobs.get(graph.job_id);
    if (latest?.node_token !== token || latest.state !== 'assigned') return false;
    if (latest.batch_id && batchIsFenced(ctx.storage, latest.batch_id)) {
      latest.agent_id = null;
      await ctx.saveGraphJob(latest);
      ctx.updateAgentInfo(agent.ws, { status: 'online', current_job_id: null });
      await ctx.assignQueuedWork();
      return false;
    }
    agent.ws.send(JSON.stringify(message));
    return true;
  } catch (error) {
    await graphAssignmentFailed(ctx, graph, agent, token, error);
    return false;
  } finally {
    releasePreparation(ctx, agent, graph.job_id);
  }
}

async function graphParentAllowsDispatch(ctx: RelayContext, graph: GraphJob): Promise<boolean> {
  if (!graph.batch_id) return true;
  const parent = await ctx.storage.get<{ state: string }>(`batch:${graph.batch_id}`);
  return parent?.state === 'running';
}

async function prepareGraphMessage(
  ctx: RelayContext, graph: GraphJob, agent: ConnectedAgentRecord, token: string, bundleFiles: GraphRequestMessage['bundle_files']
): Promise<GraphRequestMessage | null> {
    const current = await ctx.getGraphJob(graph.job_id);
    if (!current || current.node_token !== token) return null;
    if (!(await graphParentAllowsDispatch(ctx, current))) {
      current.agent_id = null;
      await ctx.saveGraphJob(current);
      ctx.updateAgentInfo(agent.ws, { status: 'online', current_job_id: null });
      await ctx.assignQueuedWork();
      return null;
    }
    if (ctx.getConnectedAgents().get(agent.info.agent_id)?.ws !== agent.ws) throw new Error('GRAPH_CONNECTION_CHANGED');
    if (current.state !== 'assigned') {
      if (current.state === 'cancelled') {
        current.agent_id = null;
        await ctx.saveGraphJob(current);
        ctx.updateAgentInfo(agent.ws, { status: 'online', current_job_id: null });
      }
      return null;
    }
    return {
      type: 'graph_request', job_id: graph.job_id, client_id: graph.client_id,
      owner_user_id: graph.user_id, bundle_files: bundleFiles,
      upload_url_base: graphUploadUrlBase(graph), assignment_token: token,
      ...(hasLocalCustody(graph) ? { data_policy: graph.job.data_policy, request_sha256: graph.request_sha256 } : {}),
    };
 }

async function graphAssignmentFailed(ctx: RelayContext, graph: GraphJob, agent: ConnectedAgentRecord, token: string, error: unknown): Promise<void> {
    const current = await ctx.getGraphJob(graph.job_id);
    if (current?.node_token === token && current.state === 'assigned') {
      await ctx.failInProgressWorkForAgent({ ...agent.info, current_job_id: graph.job_id }, 'GRAPH_ASSIGNMENT_FAILED');
    }
    const attached = ctx.getConnectedAgents().get(agent.info.agent_id);
    if (current?.node_token === token && attached?.ws === agent.ws && attached.info.current_job_id === graph.job_id) {
      ctx.updateAgentInfo(agent.ws, { status: 'online', current_job_id: null });
    }
    await ctx.assignQueuedWork();
    console.error('Failed to assign graph:', error);
 }

async function sendReservedWork(
  ctx: RelayContext, agent: ConnectedAgentRecord, workId: string, send: () => Promise<boolean>
): Promise<boolean> {
  let sent = false;
  try {
    sent = await send();
    if (sent && ctx.getConnectedAgents().get(agent.info.agent_id)?.ws === agent.ws) updateAssignedAgentState(ctx, agent.ws, workId);
    return sent;
  }
  finally {
    releasePreparation(ctx, agent, workId);
    const current = ctx.getConnectedAgents().get(agent.info.agent_id);
    if (!sent && current?.ws === agent.ws && current.info.current_job_id === workId) {
      ctx.updateAgentInfo(agent.ws, { status: 'online', current_job_id: null });
    }
  }
}

export async function assignJobToAgent(
  ctx: RelayContext,
  job: Job,
  preferredAgentId?: string
): Promise<boolean> {
  if (job.required_device_id && job.user_id !== ctx.userId) return false;
  const model = job.request.model?.trim() || inferJobKind(job);
  const agent = await getOnlineAgent(ctx, (info) => supportsJob(info, job), model, job.job_id, preferredAgentId);
  if (!agent) {
    return false;
  }
  return sendReservedWork(ctx, agent, job.job_id, () => sendJobToAgent(ctx, job, agent));
}

export async function assignChatToAgent(ctx: RelayContext, chat: Chat): Promise<boolean> {
  const agent = await getOnlineAgent(ctx, (info) => supportsChat(info, chat), chat.model?.trim() || 'text', chat.chat_id);
  if (!agent) {
    return false;
  }
  return sendReservedWork(ctx, agent, chat.chat_id, () => sendChatToAgent(ctx, chat, agent));
}

export async function assignTalkToAgent(ctx: RelayContext, talk: Talk): Promise<boolean> {
  const agent = await getOnlineAgent(ctx, supportsTalk, 'talk-nano', talk.talk_id);
  if (!agent) {
    return false;
  }
  return sendReservedWork(ctx, agent, talk.talk_id, () => sendTalkToAgent(ctx, talk, agent));
}

export async function assignAsrToAgent(ctx: RelayContext, asr: Asr): Promise<boolean> {
  const preferredModel = asr.request.diarize
    ? 'speech-diarization-sortformer'
    : asrBackendModel(asr.request.backend ?? 'auto') ?? 'asr';
  const agent = await getOnlineAgent(
    ctx,
    (info) => supportsAsr(info, asr),
    preferredModel,
    asr.asr_id
  );
  if (!agent) {
    return false;
  }
  return sendReservedWork(ctx, agent, asr.asr_id, () => sendAsrToAgent(ctx, asr, agent));
}

export async function assignEmbedToAgent(ctx: RelayContext, embed: Embed): Promise<boolean> {
  const agent = await getOnlineAgent(ctx, supportsEmbed, embed.request.model?.trim() || 'embed', embed.embed_id);
  if (!agent) {
    return false;
  }
  return sendReservedWork(ctx, agent, embed.embed_id, () => sendEmbedToAgent(ctx, embed, agent));
}

export async function assignOcrToAgent(ctx: RelayContext, ocr: Ocr): Promise<boolean> {
  const agent = await getOnlineAgent(ctx, supportsOcr, 'ocr', ocr.ocr_id);
  if (!agent) {
    return false;
  }
  return sendReservedWork(ctx, agent, ocr.ocr_id, () => sendOcrToAgent(ctx, ocr, agent));
}

export async function assignToolToAgent(
  ctx: RelayContext,
  tool: Tool,
  preferredAgentId?: string
): Promise<boolean> {
  const model = `${tool.request.plugin}:${tool.request.command}`;
  const agent = await getOnlineAgent(ctx, (info) => supportsTool(info, tool), model, tool.tool_id, preferredAgentId);
  if (!agent) {
    return false;
  }
  return sendReservedWork(ctx, agent, tool.tool_id, () => sendToolToAgent(ctx, tool, agent));
}

export async function assignGraphToAgent(
  ctx: RelayContext,
  graph: GraphJob
): Promise<boolean> {
  const agent = await getOnlineAgent(
    ctx,
    (info) => supportsGraph(info, graph),
    'graph',
    graph.job_id,
    undefined,
    (info, mode) => scoreAgentForGraph(info, graph, mode)
  );
  if (!agent) return false;
  return sendGraphToAgent(ctx, graph, agent);
}

async function assignWork(ctx: RelayContext, work: QueuedWorkDescriptor): Promise<boolean> {
  switch (work.type) {
    case 'job': { const job = ctx.jobs.get(work.id); return job ? assignJobToAgent(ctx, job) : false; }
    case 'chat': { const job = ctx.chats.get(work.id); return job ? assignChatToAgent(ctx, job) : false; }
    case 'talk': { const job = ctx.talks.get(work.id); return job ? assignTalkToAgent(ctx, job) : false; }
    case 'asr': { const job = ctx.asrs.get(work.id); return job ? assignAsrToAgent(ctx, job) : false; }
    case 'embed': { const job = ctx.embeds.get(work.id); return job ? assignEmbedToAgent(ctx, job) : false; }
    case 'ocr': { const job = ctx.ocrs.get(work.id); return job ? assignOcrToAgent(ctx, job) : false; }
    case 'tool': { const job = ctx.tools.get(work.id); return job ? assignToolToAgent(ctx, job) : false; }
    case 'graph': { const job = ctx.graphJobs.get(work.id); return job ? assignGraphToAgent(ctx, job) : false; }
  }
}

function workGroup(ctx: RelayContext, work: QueuedWorkDescriptor): string {
  return work.type === 'graph' ? ctx.graphJobs.get(work.id)?.batch_id ?? 'foreground' : 'foreground';
}

export async function assignQueuedWork(ctx: RelayContext): Promise<void> {
  const groups = new Map<string, QueuedWorkDescriptor[]>();
  for (const work of collectQueuedWork(ctx)) {
    const key = workGroup(ctx, work);
    const group = groups.get(key) ?? [];
    group.push(work); groups.set(key, group);
  }
  const keys = [...groups.keys()].sort();
  const last = await ctx.storage.get<string>('relay:queue-turn');
  const start = last ? (keys.indexOf(last) + 1) % Math.max(1, keys.length) : 0;
  const ordered = [...keys.slice(start), ...keys.slice(0, start)];
  for (;;) {
    let more = false;
    for (const key of ordered) {
      const work = groups.get(key)?.shift();
      if (!work) continue;
      more = true;
      if (await assignWork(ctx, work)) await ctx.storage.put('relay:queue-turn', key);
    }
    if (!more) return;
  }
}
