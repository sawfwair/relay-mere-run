import type {
  ToolErrorMessage,
  ToolProgressMessage,
  ToolResultMessage,
} from './types';
import type { RelayContext } from './relay-context';
import {
  finishTerminalWork,
  forwardMessageToOwnerIfNeeded,
} from './relay-lifecycle';
import { durationMs, recordNodePerformance } from './relay-fleet';

const TERMINAL_WORK_RETAIN_MS = 60_000;

export async function handleToolProgress(
  ctx: RelayContext,
  msg: ToolProgressMessage
): Promise<void> {
  const tool = await ctx.getTool(msg.tool_id);
  if (!tool) {
    console.warn(`Progress for unknown tool job: ${msg.tool_id}`);
    return;
  }

  tool.progress = {
    step: msg.step,
    total_steps: msg.total_steps,
    message: msg.message,
  };
  await ctx.saveTool(tool);
}

export async function handleToolResult(
  ctx: RelayContext,
  msg: ToolResultMessage
): Promise<void> {
  const tool = await ctx.getTool(msg.tool_id);
  if (!tool) {
    await forwardMessageToOwnerIfNeeded(
      ctx,
      msg.owner_user_id,
      '/internal/tool-result',
      msg,
      `Result for unknown tool job: ${msg.tool_id}`
    );
    return;
  }

  const completedAt = new Date().toISOString();
  tool.status = 'complete';
  tool.result = {
    artifacts: msg.artifacts ?? [],
    run_manifest: msg.run_manifest,
    summary: msg.summary,
  };
	tool.error = null;
	tool.completed_at = completedAt;
	await recordNodePerformance(
		ctx,
		tool.agent_id,
		`${tool.request.plugin}:${tool.request.command}`,
		true,
		durationMs(tool.started_at, tool.completed_at) ?? undefined
	);

  await finishTerminalWork({
    ctx,
    work: tool,
    workId: tool.tool_id,
    agentId: tool.agent_id,
    map: ctx.tools,
    persist: (currentTool) => ctx.saveTool(currentTool),
    retainInMemoryMs: TERMINAL_WORK_RETAIN_MS,
    afterPersist: async () => {
      await ctx.scheduleToolWebhookIfNeeded(tool);
    },
    logMessage: `Tool ${tool.tool_id} completed`,
  });
}

export async function handleToolError(
  ctx: RelayContext,
  msg: ToolErrorMessage
): Promise<void> {
  const tool = await ctx.getTool(msg.tool_id);
  if (!tool) {
    await forwardMessageToOwnerIfNeeded(
      ctx,
      msg.owner_user_id,
      '/internal/tool-error',
      msg,
      `Error for unknown tool job: ${msg.tool_id}`
    );
    return;
  }

  tool.status = 'failed';
	tool.error = msg.error;
	tool.completed_at = new Date().toISOString();
	await recordNodePerformance(
		ctx,
		tool.agent_id,
		`${tool.request.plugin}:${tool.request.command}`,
		false
	);

  await finishTerminalWork({
    ctx,
    work: tool,
    workId: tool.tool_id,
    agentId: tool.agent_id,
    map: ctx.tools,
    persist: (currentTool) => ctx.saveTool(currentTool),
    retainInMemoryMs: TERMINAL_WORK_RETAIN_MS,
    afterPersist: async () => {
      await ctx.scheduleToolWebhookIfNeeded(tool);
    },
    logMessage: `Tool ${tool.tool_id} failed: ${msg.error}`,
  });
}
