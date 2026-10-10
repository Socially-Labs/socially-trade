import assert from 'node:assert/strict';
import { test } from 'node:test';
import { refreshPriceBatch } from '../dist/price-batch.js';
import { JupiterClientError } from '@socially/market-data/client';

test('quota deferral retains last good marks and failure history while scheduling a retry', async () => {
  const writes = []; let invalidations = 0;
  const pool = { query: async (sql, values) => { writes.push({ sql, values }); } };
  const wait = await refreshPriceBatch(pool, ['SOL'], async () => { throw new JupiterClientError('quota_wait', 2300); }, async () => { invalidations++; });
  assert.equal(wait, 2300); assert.equal(invalidations, 0); assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].values, [['SOL'], 2300]);
  assert.ok(!/failure_count|last_success_at|backoff_until/.test(writes[0].sql));
});

test('real provider failure still backs off and invalidates only the affected batch', async () => {
  const writes = []; let invalidations = 0;
  const pool = { query: async (sql, values) => { writes.push({ sql, values }); } };
  const failure = new JupiterClientError('upstream_unavailable');
  await assert.rejects(refreshPriceBatch(pool, ['JUP'], async () => { throw failure; }, async () => { invalidations++; }), error => error === failure);
  assert.equal(invalidations, 1); assert.match(writes[0].sql, /failure_count=failure_count\+1/);
  assert.deepEqual(writes[0].values, [['JUP']]);
});
