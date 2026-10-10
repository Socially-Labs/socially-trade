import assert from 'node:assert/strict';
import test from 'node:test';
import { BirdeyeHistoryProvider } from '../../../packages/market-data/dist/backfill.js';

test('Birdeye candles accept an inclusive end but never store outside the requested window', async () => {
  const original = globalThis.fetch;
  const from = new Date('2026-10-10T00:00:00Z'), to = new Date('2026-10-11T00:00:00Z');
  const rows = Array.from({ length: 289 }, (_, i) => ({ unix_time: from.getTime()/1000+i*300,
    o: 100, h: 102, l: 99, c: 101, v_usd: 500 }));
  try {
    globalThis.fetch = async (url, options) => {
      assert.equal(new URL(url).searchParams.get('time_to'), String(to.getTime()/1000-1));
      assert.equal(options.headers['x-chain'], 'solana');
      return Response.json({ success: true, data: { items: rows } });
    };
    const candles = await new BirdeyeHistoryProvider('fixture').fetch('fixture', from, to, 300);
    assert.equal(candles.length, 288);
    assert.ok(candles.every(c => c.at >= from && c.at < to));
    assert.equal(candles[0].close, '101.000000000000000000');
    rows[0].h = 90;
    await assert.rejects(new BirdeyeHistoryProvider('fixture').fetch('fixture', from, to, 300), /history_provider_invalid/);
  } finally { globalThis.fetch = original; }
});

test('Birdeye missing coverage stays empty and authorization errors are explicit', async () => {
  const original = globalThis.fetch, from = new Date('2026-10-10T00:00:00Z'), to = new Date('2026-10-11T00:00:00Z');
  try {
    globalThis.fetch = async () => Response.json({ success: true, data: { items: [] } });
    assert.deepEqual(await new BirdeyeHistoryProvider('fixture').fetch('fixture', from, to, 300), []);
    globalThis.fetch = async () => new Response('', { status: 403 });
    await assert.rejects(new BirdeyeHistoryProvider('fixture').fetch('fixture', from, to, 300), /history_provider_403/);
  } finally { globalThis.fetch = original; }
});
