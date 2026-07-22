import type { RelayContext } from './relay-context';

export const GRAPH_MAINTENANCE_ALARM_KEY = 'graph-maintenance:next';
export const ASR_STREAM_ALARM_KEY = 'asr-stream:next-alarm';

interface PendingWebhookAlarm {
  next_attempt_at: number | null;
}

export async function scheduleNextRelayAlarm(ctx: RelayContext): Promise<void> {
  const pendingWebhooks = await ctx.storage.list<PendingWebhookAlarm>({ prefix: 'webhook:' });
  const graphMaintenance = await ctx.storage.get<number>(GRAPH_MAINTENANCE_ALARM_KEY);
  const asrStreamDeadline = await ctx.storage.get<number>(ASR_STREAM_ALARM_KEY);
  let nextAlarmAt = graphMaintenance ?? asrStreamDeadline ?? null;
  if (asrStreamDeadline !== undefined && (nextAlarmAt === null || asrStreamDeadline < nextAlarmAt)) {
    nextAlarmAt = asrStreamDeadline;
  }

  for (const state of pendingWebhooks.values()) {
    if (state.next_attempt_at === null) continue;
    if (nextAlarmAt === null || state.next_attempt_at < nextAlarmAt) {
      nextAlarmAt = state.next_attempt_at;
    }
  }

  if (nextAlarmAt === null) {
    await ctx.storage.deleteAlarm();
  } else {
    await ctx.storage.setAlarm(nextAlarmAt);
  }
}
