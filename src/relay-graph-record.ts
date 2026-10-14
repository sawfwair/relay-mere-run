import type { GraphJob, SubmitGraphJobRequest } from './types';

export async function* storedGraphJobs(storage: DurableObjectStorage): AsyncGenerator<GraphJob> {
  let startAfter: string | undefined;
  for (;;) {
    const page = await storage.list<GraphJob>({ prefix: 'graph:', limit: 32, startAfter });
    for (const [key, job] of page) { startAfter = key; yield job; }
    if (page.size < 32) return;
  }
}

export function graphPlacementRecord(body: SubmitGraphJobRequest, userId: string): GraphJob {
  const createdAt = new Date().toISOString();
  return {
    job_id: body.job.job_id,
    user_id: userId,
    client_id: body.client_id ?? 'graph-studio',
    agent_id: null,
    state: 'preflighting',
    job: body.job,
    graph: body.graph,
    inputs: body.inputs,
    assets: body.assets,
    missing_asset_digests: [],
    events: [],
    artifacts: [],
    artifact_uploads: {},
    run_manifest: null,
    metrics: null,
    error: null,
    created_at: createdAt,
    updated_at: createdAt,
    assigned_at: null,
    started_at: null,
    completed_at: null,
    attempt: 0,
    max_attempts: 1,
    node_token: '',
    relay_origin: '',
    webhook_url: body.job.webhook_url ?? null,
    webhook_sent: false,
  };
}
