import type { RelayContext } from './relay-context';

export interface SubmissionOptions<TResponse> {
  ctx: RelayContext;
  storageKey: string;
  removeFromMemory(): void;
  assign(): Promise<boolean>;
  hasCapableAgent(): boolean;
  getQueuePosition(): number;
  buildAssignedResponse(): TResponse;
  buildQueuedResponse(position: number): TResponse;
}

export async function finishSubmission<TResponse>(
  options: SubmissionOptions<TResponse>
): Promise<Response> {
  const assigned = await options.assign();
  if (assigned) {
    return Response.json(options.buildAssignedResponse());
  }

  if (options.ctx.getConnectedAgents().size === 0) {
    options.removeFromMemory();
    await options.ctx.storage.delete(options.storageKey);
    return Response.json({ error: 'No agents online', code: 'NO_AGENTS' }, { status: 503 });
  }

  if (!options.hasCapableAgent()) {
    options.removeFromMemory();
    await options.ctx.storage.delete(options.storageKey);
    return Response.json({ error: 'No compatible agents online', code: 'NO_COMPATIBLE_AGENTS' }, { status: 503 });
  }

  return Response.json(options.buildQueuedResponse(options.getQueuePosition()));
}

export function buildCancelResponse<TResponse extends { cancelled: boolean }>(
  outcome: 'already_cancelled' | 'already_completed' | 'cancelled',
  completedError: string
): Response {
  if (outcome === 'already_cancelled') {
    return Response.json({ cancelled: true } as TResponse);
  }

  if (outcome === 'already_completed') {
    return Response.json(
      { error: completedError, cancelled: false } as TResponse & { error: string },
      { status: 400 }
    );
  }

  return Response.json({ cancelled: true } as TResponse);
}
