import type {
  Env,
  AgentInfo,
  Job,
  Chat,
  Talk,
  Asr,
  Embed,
  Ocr,
  Tool,
  GraphJob,
} from './types';

export interface WebSocketAttachment {
  kind?: 'agent';
  agentId: string;
  info: AgentInfo;
  superseded?: boolean;
}

export interface AsrBrowserWebSocketAttachment {
  kind: 'asr_browser';
  sessionId: string;
  agentId: string;
  clientId: string;
  connectedAtMs: number;
  startedAtMs?: number;
  readyAtMs?: number;
  lastAudioAtMs: number;
  forwardedAudioBytes: number;
  started: boolean;
  terminal: boolean;
  nextFrameSequence: number;
  nextEventSequence: number;
  stopRequestedAtMs?: number;
}

export type AnyWebSocketAttachment = WebSocketAttachment | AsrBrowserWebSocketAttachment;

export function isAgentWebSocketAttachment(
  value: AnyWebSocketAttachment | null
): value is WebSocketAttachment {
  return value !== null && value.kind !== 'asr_browser' && 'info' in value;
}

export function isAsrBrowserWebSocketAttachment(
  value: AnyWebSocketAttachment | null
): value is AsrBrowserWebSocketAttachment {
  return value?.kind === 'asr_browser';
}

export interface ConnectedAgentRecord {
  ws: WebSocket;
  info: AgentInfo;
}

export type QueuedWorkKind = 'job' | 'chat' | 'talk' | 'asr' | 'embed' | 'ocr' | 'tool' | 'graph';

export interface QueuedWorkDescriptor {
  type: QueuedWorkKind;
  id: string;
  createdAt: string;
}

export interface RelayContext {
  env: Env;
  storage: DurableObjectStorage;
  jobs: Map<string, Job>;
  chats: Map<string, Chat>;
  talks: Map<string, Talk>;
  asrs: Map<string, Asr>;
  embeds: Map<string, Embed>;
  ocrs: Map<string, Ocr>;
  tools: Map<string, Tool>;
  graphJobs: Map<string, GraphJob>;
  userId: string;
  setUserId(userId: string): void;
  acceptWebSocket(ws: WebSocket): void;
  getConnectedAgents(): Map<string, ConnectedAgentRecord>;
  getWebSockets(): WebSocket[];
  updateAgentInfo(ws: WebSocket, updates: Partial<AgentInfo>): void;
  getRequestUserId(request: Request): string;
  getJob(jobId: string): Promise<Job | undefined>;
  saveJob(job: Job): Promise<void>;
  getChat(chatId: string): Promise<Chat | undefined>;
  saveChat(chat: Chat): Promise<void>;
  getTalk(talkId: string): Promise<Talk | undefined>;
  saveTalk(talk: Talk): Promise<void>;
  getAsr(asrId: string): Promise<Asr | undefined>;
  saveAsr(asr: Asr): Promise<void>;
  getEmbed(embedId: string): Promise<Embed | undefined>;
  saveEmbed(embed: Embed): Promise<void>;
  getOcr(ocrId: string): Promise<Ocr | undefined>;
  saveOcr(ocr: Ocr): Promise<void>;
  getTool(toolId: string): Promise<Tool | undefined>;
  saveTool(tool: Tool): Promise<void>;
  getGraphJob(jobId: string): Promise<GraphJob | undefined>;
  saveGraphJob(job: GraphJob): Promise<void>;
  prepareJobForStorage(job: Job): Job;
  prepareTalkForStorage(talk: Talk): Talk;
  assignQueuedWork(): Promise<void>;
  failInProgressWorkForAgent(info: AgentInfo, reason: string): Promise<void>;
  scheduleJobWebhookIfNeeded(job: Job): Promise<void>;
  scheduleAsrWebhookIfNeeded(asr: Asr): Promise<void>;
  scheduleEmbedWebhookIfNeeded(embed: Embed): Promise<void>;
  scheduleToolWebhookIfNeeded(tool: Tool): Promise<void>;
}
