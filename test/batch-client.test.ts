import { describe, expect, it, vi } from 'vitest';
import { MereRunRelayClient } from '../clients/typescript/MereRunRelayClient';
import { isGraphBatchResponse } from '../clients/typescript/batch-contracts';

function page(batchId: string, start: number, count: number, total: number) {
  return { schema_version: 1, batch_id: batchId, request_sha256: 'a'.repeat(64), state: 'running',
    max_in_flight: 8, max_attempts: 2, item_count: total, created_at: '2026-10-14T12:00:00.000Z',
    updated_at: '2026-10-14T12:00:00.000Z', error: null,
    counts: { pending: total, queued: 0, running: 0, finished: 0, failed: 0, cancelled: 0 },
    next_cursor: start + count < total ? start + count : null,
    items: Array.from({ length: count }, (_, offset) => ({ key: `item-${start + offset}`, ordinal: start + offset,
      job_id: crypto.randomUUID(), state: 'pending', attempt: 0, error: null, artifacts: [] })) };
}

describe('public batch client', () => {
  it('assembles paged indexes, exposes account listing, and preserves retry operation keys', async () => {
    const id = crypto.randomUUID(); const pages = [page(id, 0, 100, 101), page(id, 100, 1, 101)];
    const retryKey = crypto.randomUUID();
    const fetchImpl = vi.fn<typeof fetch>((input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith('/graph-batches')) return Promise.resolve(Response.json({ batches: [{ ...pages[0] }] }));
      if (url.includes('/retry')) expect(init?.body).toBe(JSON.stringify({ retry_key: retryKey }));
      return Promise.resolve(Response.json(url.includes('cursor=100') ? pages[1] : pages[0]));
    });
    const client = new MereRunRelayClient({ authorization: 'fixture', baseUrl: 'https://relay.example', fetchImpl });
    expect((await client.getGraphBatch(id)).items.length).toBe(101);
    expect((await client.listGraphBatches())[0].batch_id).toBe(id);
    expect((await client.retryGraphBatch(id, retryKey)).items.length).toBe(101);
  });

  it('rejects malformed counts, negative counts, duplicate items, and nonadvancing cursors', async () => {
    const id = crypto.randomUUID(); const response = page(id, 0, 2, 2);
    expect(isGraphBatchResponse(response)).toBe(true);
    expect(isGraphBatchResponse({ ...response, counts: { ...response.counts, pending: -2 } })).toBe(false);
    expect(isGraphBatchResponse({ ...response, items: [response.items[0], response.items[0]] })).toBe(false);
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(Response.json({ ...response, next_cursor: 1 })));
    const client = new MereRunRelayClient({ authorization: 'fixture', baseUrl: 'https://relay.example', fetchImpl });
    await expect(client.getGraphBatch(id)).rejects.toThrow('Invalid batch page cursor');
  });
});
