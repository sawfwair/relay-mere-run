import { DurableObject } from 'cloudflare:workers';
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
import type { RelayContext, WebSocketAttachment, AnyWebSocketAttachment } from './relay-context';
import { isAgentWebSocketAttachment, isAsrBrowserWebSocketAttachment } from './relay-context';
import { compactAgentInfoForAttachment } from './relay-agent-attachment';
import { handleRelayFetch } from './relay-routing';
import { createRelayRouteHandlers } from './relay-api';
import { createRelayWebSocketHandlers } from './relay-agent';
import {
  handleRelayWebSocketMessage,
  handleRelayWebSocketClose,
} from './relay-websocket';
import { failInProgressWorkForAgent } from './relay-lifecycle';
import { assignQueuedWork } from './relay-queue';
import { handleGraphMaintenanceAlarm } from './relay-graph-operations';
import {
  handleWebhookAlarm,
  scheduleAsrWebhookIfNeeded,
  scheduleEmbedWebhookIfNeeded,
  scheduleJobWebhookIfNeeded,
  scheduleToolWebhookIfNeeded,
} from './relay-webhooks';
import {
  acceptAsrBrowserWebSocket,
  createAsrStreamTicket,
  expireAsrStreamSessions,
  handleAsrBrowserClose,
  handleAsrBrowserMessage,
} from './relay-asr-stream';

export class MereRunRelay extends DurableObject<Env> {
  private jobs: Map<string, Job> = new Map();
  private chats: Map<string, Chat> = new Map();
  private talks: Map<string, Talk> = new Map();
  private asrs: Map<string, Asr> = new Map();
  private embeds: Map<string, Embed> = new Map();
  private ocrs: Map<string, Ocr> = new Map();
  private tools: Map<string, Tool> = new Map();
  private graphJobs: Map<string, GraphJob> = new Map();
  private userId = '';

  private async getJob(jobId: string): Promise<Job | undefined> {
    let job = this.jobs.get(jobId);
    if (!job) {
      job = await this.ctx.storage.get<Job>(`job:${jobId}`);
      if (job && job.status !== 'complete' && job.status !== 'failed' && job.status !== 'cancelled') {
        this.jobs.set(jobId, job);
      }
    }
    return job;
  }

  private async saveJob(job: Job): Promise<void> {
    this.jobs.set(job.job_id, job);
    await this.ctx.storage.put(`job:${job.job_id}`, this.prepareJobForStorage(job));
  }

  private async getChat(chatId: string): Promise<Chat | undefined> {
    let chat = this.chats.get(chatId);
    if (!chat) {
      chat = await this.ctx.storage.get<Chat>(`chat:${chatId}`);
      if (chat && chat.status !== 'complete' && chat.status !== 'failed') {
        this.chats.set(chatId, chat);
      }
    }
    return chat;
  }

  private async saveChat(chat: Chat): Promise<void> {
    this.chats.set(chat.chat_id, chat);
    await this.ctx.storage.put(`chat:${chat.chat_id}`, chat);
  }

  private async getTalk(talkId: string): Promise<Talk | undefined> {
    let talk = this.talks.get(talkId);
    if (!talk) {
      talk = await this.ctx.storage.get<Talk>(`talk:${talkId}`);
      if (talk && talk.status !== 'complete' && talk.status !== 'failed' && talk.status !== 'cancelled') {
        this.talks.set(talkId, talk);
      }
    }
    return talk;
  }

  private async saveTalk(talk: Talk): Promise<void> {
    this.talks.set(talk.talk_id, talk);
    await this.ctx.storage.put(`talk:${talk.talk_id}`, this.prepareTalkForStorage(talk));
  }

  private async getAsr(asrId: string): Promise<Asr | undefined> {
    let asr = this.asrs.get(asrId);
    if (!asr) {
      asr = await this.ctx.storage.get<Asr>(`asr:${asrId}`);
      if (asr && asr.status !== 'complete' && asr.status !== 'failed' && asr.status !== 'cancelled') {
        this.asrs.set(asrId, asr);
      }
    }
    return asr;
  }

  private async saveAsr(asr: Asr): Promise<void> {
    this.asrs.set(asr.asr_id, asr);
    await this.ctx.storage.put(`asr:${asr.asr_id}`, asr);
  }

  private async getEmbed(embedId: string): Promise<Embed | undefined> {
    let embed = this.embeds.get(embedId);
    if (!embed) {
      embed = await this.ctx.storage.get<Embed>(`embed:${embedId}`);
      if (embed && embed.status !== 'complete' && embed.status !== 'failed' && embed.status !== 'cancelled') {
        this.embeds.set(embedId, embed);
      }
    }
    return embed;
  }

  private async saveEmbed(embed: Embed): Promise<void> {
    this.embeds.set(embed.embed_id, embed);
    await this.ctx.storage.put(`embed:${embed.embed_id}`, embed);
  }

  private async getOcr(ocrId: string): Promise<Ocr | undefined> {
    let ocr = this.ocrs.get(ocrId);
    if (!ocr) {
      ocr = await this.ctx.storage.get<Ocr>(`ocr:${ocrId}`);
      if (ocr && ocr.status !== 'complete' && ocr.status !== 'failed' && ocr.status !== 'cancelled') {
        this.ocrs.set(ocrId, ocr);
      }
    }
    return ocr;
  }

  private async saveOcr(ocr: Ocr): Promise<void> {
    this.ocrs.set(ocr.ocr_id, ocr);
    await this.ctx.storage.put(`ocr:${ocr.ocr_id}`, ocr);
  }

  private async getTool(toolId: string): Promise<Tool | undefined> {
    let tool = this.tools.get(toolId);
    if (!tool) {
      tool = await this.ctx.storage.get<Tool>(`tool:${toolId}`);
      if (tool && tool.status !== 'complete' && tool.status !== 'failed' && tool.status !== 'cancelled') {
        this.tools.set(toolId, tool);
      }
    }
    return tool;
  }

  private async saveTool(tool: Tool): Promise<void> {
    this.tools.set(tool.tool_id, tool);
    await this.ctx.storage.put(`tool:${tool.tool_id}`, tool);
  }

  private async getGraphJob(jobId: string): Promise<GraphJob | undefined> {
    let job = this.graphJobs.get(jobId);
    if (!job) {
      job = await this.ctx.storage.get<GraphJob>(`graph:${jobId}`);
      if (job && job.state !== 'finished' && job.state !== 'failed' && job.state !== 'cancelled') {
        this.graphJobs.set(jobId, job);
      }
    }
    return job;
  }

  private async saveGraphJob(job: GraphJob): Promise<void> {
    this.graphJobs.set(job.job_id, job);
    await this.ctx.storage.put(`graph:${job.job_id}`, job);
  }

  private getConnectedAgents(): Map<string, { ws: WebSocket; info: AgentInfo }> {
    const agents = new Map<string, { ws: WebSocket; info: AgentInfo }>();
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as AnyWebSocketAttachment | null;
      if (isAgentWebSocketAttachment(attachment) && !attachment.superseded) {
        agents.set(attachment.agentId, { ws, info: attachment.info });
      }
    }
    return agents;
  }

  private updateAgentInfo(ws: WebSocket, updates: Partial<AgentInfo>): void {
    const attachment = ws.deserializeAttachment() as WebSocketAttachment | null;
    if (!attachment) return;

    attachment.info = compactAgentInfoForAttachment({ ...attachment.info, ...updates });
    ws.serializeAttachment(attachment);
  }

  private getRequestUserId(request: Request): string {
    return request.headers.get('X-User-Id') || '';
  }

  private prepareJobForStorage(job: Job): Job {
    const jobToStore = { ...job };
    if (jobToStore.result?.image_data) {
      jobToStore.result = { ...jobToStore.result, image_data: undefined };
    }
    if (jobToStore.request.input_image_data) {
      jobToStore.request = { ...jobToStore.request, input_image_data: null };
    }
    return jobToStore;
  }

  private prepareTalkForStorage(talk: Talk): Talk {
    const talkToStore = { ...talk };
    if (talkToStore.result?.audio_data) {
      talkToStore.result = { ...talkToStore.result, audio_data: undefined };
    }
    return talkToStore;
  }

  private createRelayContext(): RelayContext {
    const relayContext: RelayContext = {
      env: this.env,
      storage: this.ctx.storage,
      jobs: this.jobs,
      chats: this.chats,
      talks: this.talks,
      asrs: this.asrs,
      embeds: this.embeds,
      ocrs: this.ocrs,
      tools: this.tools,
      graphJobs: this.graphJobs,
      userId: this.userId,
      setUserId: (userId: string) => {
        this.userId = userId;
        relayContext.userId = userId;
      },
      acceptWebSocket: (ws: WebSocket) => {
        this.ctx.acceptWebSocket(ws);
      },
      getConnectedAgents: () => this.getConnectedAgents(),
      getWebSockets: () => this.ctx.getWebSockets(),
      updateAgentInfo: (ws: WebSocket, updates: Partial<AgentInfo>) => this.updateAgentInfo(ws, updates),
      getRequestUserId: (request: Request) => this.getRequestUserId(request),
      getJob: (jobId: string) => this.getJob(jobId),
      saveJob: (job: Job) => this.saveJob(job),
      getChat: (chatId: string) => this.getChat(chatId),
      saveChat: (chat: Chat) => this.saveChat(chat),
      getTalk: (talkId: string) => this.getTalk(talkId),
      saveTalk: (talk: Talk) => this.saveTalk(talk),
      getAsr: (asrId: string) => this.getAsr(asrId),
      saveAsr: (asr: Asr) => this.saveAsr(asr),
      getEmbed: (embedId: string) => this.getEmbed(embedId),
      saveEmbed: (embed: Embed) => this.saveEmbed(embed),
      getOcr: (ocrId: string) => this.getOcr(ocrId),
      saveOcr: (ocr: Ocr) => this.saveOcr(ocr),
      getTool: (toolId: string) => this.getTool(toolId),
      saveTool: (tool: Tool) => this.saveTool(tool),
      getGraphJob: (jobId: string) => this.getGraphJob(jobId),
      saveGraphJob: (job: GraphJob) => this.saveGraphJob(job),
      prepareJobForStorage: (job: Job) => this.prepareJobForStorage(job),
      prepareTalkForStorage: (talk: Talk) => this.prepareTalkForStorage(talk),
      assignQueuedWork: () => assignQueuedWork(relayContext),
      failInProgressWorkForAgent: (info: AgentInfo, reason: string) =>
        failInProgressWorkForAgent(relayContext, info, reason),
      scheduleJobWebhookIfNeeded: (job: Job) => scheduleJobWebhookIfNeeded(relayContext, job),
      scheduleAsrWebhookIfNeeded: (asr: Asr) => scheduleAsrWebhookIfNeeded(relayContext, asr),
      scheduleEmbedWebhookIfNeeded: (embed: Embed) => scheduleEmbedWebhookIfNeeded(relayContext, embed),
      scheduleToolWebhookIfNeeded: (tool: Tool) => scheduleToolWebhookIfNeeded(relayContext, tool),
    };

    return relayContext;
  }

  async fetch(request: Request): Promise<Response> {
    const relayContext = this.createRelayContext();
    const url = new URL(request.url);
    if (url.pathname === '/internal/asr/stream-ticket' && request.method === 'POST') {
      return createAsrStreamTicket(relayContext, request);
    }
    if (url.pathname === '/internal/asr/stream' && request.method === 'GET') {
      return acceptAsrBrowserWebSocket(relayContext, request);
    }
    return handleRelayFetch(createRelayRouteHandlers(relayContext), request);
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const relayContext = this.createRelayContext();
    const attachment = ws.deserializeAttachment() as AnyWebSocketAttachment | null;
    if (isAsrBrowserWebSocketAttachment(attachment)) {
      await handleAsrBrowserMessage(relayContext, ws, message);
      return;
    }
    await handleRelayWebSocketMessage(createRelayWebSocketHandlers(relayContext), ws, message);
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const relayContext = this.createRelayContext();
    const attachment = ws.deserializeAttachment() as AnyWebSocketAttachment | null;
    if (isAsrBrowserWebSocketAttachment(attachment)) {
      await handleAsrBrowserClose(relayContext, ws);
      return;
    }
    await handleRelayWebSocketClose(createRelayWebSocketHandlers(relayContext), ws);
  }

  async alarm(): Promise<void> {
    const relayContext = this.createRelayContext();
    await handleGraphMaintenanceAlarm(relayContext);
    await handleWebhookAlarm(relayContext);
    await expireAsrStreamSessions(relayContext);
  }
}
