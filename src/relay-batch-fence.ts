// Close the in-memory dispatch fence synchronously before durable cancellation yields.
// Durable parent records remain authoritative after a cold restart.
const cancelled = new WeakMap<DurableObjectStorage, Map<string, symbol>>();

export function fenceBatchCancellation(storage: DurableObjectStorage, batchId: string): symbol {
  const ids = cancelled.get(storage) ?? new Map<string, symbol>();
  const token = Symbol('batch-cancellation');
  ids.set(batchId, token); cancelled.set(storage, ids);
  return token;
}

export function batchFenceToken(storage: DurableObjectStorage, batchId: string): symbol | undefined {
  return cancelled.get(storage)?.get(batchId);
}

export function releaseBatchFence(storage: DurableObjectStorage, batchId: string, token: symbol | undefined): void {
  if (batchFenceToken(storage, batchId) === token) clearBatchFence(storage, batchId);
}

export function clearBatchFence(storage: DurableObjectStorage, batchId: string): void {
  cancelled.get(storage)?.delete(batchId);
}

export function batchIsFenced(storage: DurableObjectStorage, batchId: string): boolean {
  return cancelled.get(storage)?.has(batchId) ?? false;
}
