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
} from './types';
import type { ConnectedAgentRecord, QueuedWorkDescriptor, RelayContext } from './relay-context';
import { getInputImageKey, getInputImageUrl } from './r2';
import {
  agentCanAcceptWork,
  getFleetSettings,
  graphCachedInputBytes,
  scoreAgentForGraph,
  scoreAgentForWork,
} from './relay-fleet';
import { graphUploadUrlBase, materializeRelayBundle } from './relay-graph-storage';

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
  const kind = inferJobKind(job);
  if (kind === 'music') {
    return supportsRequestedModelOrMarker(info, job.request.model, 'music', 'music-');
  }
  if (kind === 'video') {
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
  if (chat.model?.trim()) {
    if (!agentHasModel(info, chat.model) && !agentHasModel(info, 'text')) {
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

  return true;
}

export function supportsTalk(info: AgentInfo): boolean {
  return agentHasModel(info, 'talk-nano');
}

export function supportsAsr(info: AgentInfo): boolean {
  return agentHasModel(info, 'asr');
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

export function graphCapabilityBlockers(
  info: AgentInfo,
  graph: GraphJob
): GraphPlacementBlocker[] {
  const blockers: GraphPlacementBlocker[] = [];
  const worker = info.capabilities.graph_worker;
  if (!worker) {
    return [{ code: 'graph_worker_missing', message: 'Node does not advertise graph worker support' }];
  }
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
  for (const required of graph.job.requirements.providers ?? []) {
    const provider = (worker.providers ?? []).find((candidate) => candidate.id === required.id);
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
  const parse = (value: string): number[] => value.split('.').slice(0, 3).map((part) => Number.parseInt(part, 10) || 0);
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
  return anyCapableAgent(ctx, (info) => supportsJob(info, job));
}

export function hasCapableAgentForChat(ctx: RelayContext, chat: Chat): boolean {
  return anyCapableAgent(ctx, (info) => supportsChat(info, chat));
}

export function hasCapableAgentForTalk(ctx: RelayContext): boolean {
  return anyCapableAgent(ctx, supportsTalk);
}

export function hasCapableAgentForAsr(ctx: RelayContext): boolean {
  return anyCapableAgent(ctx, supportsAsr);
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

async function getOnlineAgent(
  ctx: RelayContext,
  supports: (info: AgentInfo) => boolean,
  model: string,
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
    ) {
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
  return candidates[0];
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
    model: chat.model,
  };

  try {
    agent.ws.send(JSON.stringify(message));
    chat.agent_id = agent.info.agent_id;
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
  ctx: RelayContext,
  graph: GraphJob,
  agent: ConnectedAgentRecord
): Promise<boolean> {
  const message: GraphRequestMessage = {
    type: 'graph_request',
    job_id: graph.job_id,
    client_id: graph.client_id,
    owner_user_id: graph.user_id,
    bundle_files: await materializeRelayBundle(ctx, graph),
    upload_url_base: graphUploadUrlBase(graph),
  };

  try {
    agent.ws.send(JSON.stringify(message));
    graph.agent_id = agent.info.agent_id;
    graph.state = 'assigned';
    graph.assigned_at = new Date().toISOString();
    graph.updated_at = graph.assigned_at;
    graph.attempt += 1;
    await ctx.saveGraphJob(graph);
    updateAssignedAgentState(ctx, agent.ws, graph.job_id);
    console.log(`Graph ${graph.job_id} assigned to ${agent.info.agent_id}`);
    return true;
  } catch (error) {
    console.error('Failed to send graph request to agent:', error);
    return false;
  }
}

export async function assignJobToAgent(
  ctx: RelayContext,
  job: Job,
  preferredAgentId?: string
): Promise<boolean> {
  const model = job.request.model?.trim() || inferJobKind(job);
  const agent = await getOnlineAgent(ctx, (info) => supportsJob(info, job), model, preferredAgentId);
  if (!agent) {
    return false;
  }
  return sendJobToAgent(ctx, job, agent);
}

export async function assignChatToAgent(ctx: RelayContext, chat: Chat): Promise<boolean> {
  const agent = await getOnlineAgent(ctx, (info) => supportsChat(info, chat), chat.model?.trim() || 'text');
  if (!agent) {
    return false;
  }
  return sendChatToAgent(ctx, chat, agent);
}

export async function assignTalkToAgent(ctx: RelayContext, talk: Talk): Promise<boolean> {
  const agent = await getOnlineAgent(ctx, supportsTalk, 'talk-nano');
  if (!agent) {
    return false;
  }
  return sendTalkToAgent(ctx, talk, agent);
}

export async function assignAsrToAgent(ctx: RelayContext, asr: Asr): Promise<boolean> {
  const agent = await getOnlineAgent(ctx, supportsAsr, 'asr');
  if (!agent) {
    return false;
  }
  return sendAsrToAgent(ctx, asr, agent);
}

export async function assignEmbedToAgent(ctx: RelayContext, embed: Embed): Promise<boolean> {
  const agent = await getOnlineAgent(ctx, supportsEmbed, embed.request.model?.trim() || 'embed');
  if (!agent) {
    return false;
  }
  return sendEmbedToAgent(ctx, embed, agent);
}

export async function assignOcrToAgent(ctx: RelayContext, ocr: Ocr): Promise<boolean> {
  const agent = await getOnlineAgent(ctx, supportsOcr, 'ocr');
  if (!agent) {
    return false;
  }
  return sendOcrToAgent(ctx, ocr, agent);
}

export async function assignToolToAgent(
  ctx: RelayContext,
  tool: Tool,
  preferredAgentId?: string
): Promise<boolean> {
  const model = `${tool.request.plugin}:${tool.request.command}`;
  const agent = await getOnlineAgent(ctx, (info) => supportsTool(info, tool), model, preferredAgentId);
  if (!agent) {
    return false;
  }
  return sendToolToAgent(ctx, tool, agent);
}

export async function assignGraphToAgent(
  ctx: RelayContext,
  graph: GraphJob
): Promise<boolean> {
  const agent = await getOnlineAgent(
    ctx,
    (info) => supportsGraph(info, graph),
    'graph',
    undefined,
    (info, mode) => scoreAgentForGraph(info, graph, mode)
  );
  if (!agent) return false;
  return sendGraphToAgent(ctx, graph, agent);
}

export async function assignQueuedWork(ctx: RelayContext): Promise<void> {
  for (const work of collectQueuedWork(ctx)) {
    if (work.type === 'job') {
      const job = ctx.jobs.get(work.id);
      if (job && !(await assignJobToAgent(ctx, job))) {
        continue;
      }
      continue;
    }

    if (work.type === 'chat') {
      const chat = ctx.chats.get(work.id);
      if (chat && !(await assignChatToAgent(ctx, chat))) {
        continue;
      }
      continue;
    }

    if (work.type === 'talk') {
      const talk = ctx.talks.get(work.id);
      if (talk && !(await assignTalkToAgent(ctx, talk))) {
        continue;
      }
      continue;
    }

    if (work.type === 'asr') {
      const asr = ctx.asrs.get(work.id);
      if (asr && !(await assignAsrToAgent(ctx, asr))) {
        continue;
      }
      continue;
    }

    if (work.type === 'embed') {
      const embed = ctx.embeds.get(work.id);
      if (embed && !(await assignEmbedToAgent(ctx, embed))) {
        continue;
      }
      continue;
    }

    if (work.type === 'ocr') {
      const ocr = ctx.ocrs.get(work.id);
      if (ocr && !(await assignOcrToAgent(ctx, ocr))) {
        continue;
      }
      continue;
    }

    if (work.type === 'graph') {
      const graph = ctx.graphJobs.get(work.id);
      if (graph && !(await assignGraphToAgent(ctx, graph))) {
        continue;
      }
      continue;
    }

    const tool = ctx.tools.get(work.id);
    if (tool && !(await assignToolToAgent(ctx, tool))) {
      continue;
    }
  }
}
