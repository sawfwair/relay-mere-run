import type { GraphRunArtifact, GraphRunState, SubmitGraphJobRequest } from './types';

export interface GraphBatchRequest {
  schema_version: 1;
  batch_id: string;
  idempotency_key: string;
  max_in_flight: number;
  max_attempts: number;
  items: Array<{ key: string; submission: SubmitGraphJobRequest }>;
}

export interface GraphBatchRecord {
  retry_key?: string;
  schema_version: 1;
  batch_id: string;
  user_id: string;
  request_sha256: string;
  idempotency_key: string;
  state: 'planned' | 'running' | 'finished' | 'failed' | 'cancelled';
  max_in_flight: number;
  max_attempts: number;
  item_count: number;
  created_at: string;
  updated_at: string;
  error: string | null;
}

export interface GraphBatchStoredItem {
  key: string;
  ordinal: number;
  job_id: string;
  state: 'pending' | GraphRunState;
  submission: SubmitGraphJobRequest;
  attempt: number;
  error: string | null;
  artifacts: GraphRunArtifact[];
}

export interface GraphBatchResponse extends Omit<GraphBatchRecord, 'user_id' | 'idempotency_key'> {
  next_cursor: number | null;
  counts: Record<'pending' | 'queued' | 'running' | 'finished' | 'failed' | 'cancelled', number>;
  items: Array<Omit<GraphBatchStoredItem, 'submission'> & { placement?: unknown }>;
  missing_asset_digests?: string[];
}
