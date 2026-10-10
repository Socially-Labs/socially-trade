import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { MarketBus } from '../../../packages/market-stream/dist/index.js';
import { createApp } from '../dist/app.js';
import { configurePrivyFixture } from './privy-fixture.mjs';
import { ingestJupiter, recordMarketPrice, unavailable } from '../../ingestor/dist/ingest.js';
import { processOrder, markActiveFunds } from '../../worker/dist/orders.js';
import { supportedTokens } from '../../../packages/market-data/dist/catalog.js';
import { parseTokenMetadata } from '../../../packages/market-data/dist/tokens.js';
import { Amount } from '../../../packages/domain/dist/index.js';
import { readHistory } from '../dist/market-catalog.js';

test('market catalog, history, watchlist and multi-asset paper execution', { timeout: 120000 }, async t => {
  const connectionString = process.env.TEST_DATABASE_URL;
  assert.ok(connectionString); assert.match(new URL(connectionString).hostname, /^(localhost|127\.0\.0\.1|\[::1\])$/);
  process.env.NODE_ENV = 'development'; delete process.env.USDG_MINT; delete process.env.DEV_PRICE_SEED_ENABLED; delete process.env.REDIS_URL;
  const tokenFor = configurePrivyFixture(), schema = `markets_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString }); await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ connectionString, options: `-c search_path=${schema}`, max: 10 }), app = createApp(pool); app.log.level = 'silent';
  const dir = new URL('../../../packages/db/migrations/', import.meta.url);
  const originalFetch = globalThis.fetch;
  let slot = 1000;
  const marks = { SOL: '100', JUP: '2', JTO: '3', BONK: '0.00002', USDC: '1.01' };
  const route = async (method, url, subject, payload, key, expected = 200) => {
    const response = await app.inject({ method, url, ...(payload ? { payload } : {}), headers: {
      ...(subject ? { authorization: `Bearer ${tokenFor(subject)}` } : {}), ...(key ? { 'idempotency-key': key } : {}) } });
    assert.equal(response.statusCode, expected, response.body); return response.json();
  };
  const ingest = async (omit = null, invalidDecimals = null) => {
    slot++;
    return ingestJupiter(pool, { getPrices: async mints => {
      assert.equal(mints.length, supportedTokens.length); assert.equal(new Set(mints).size, mints.length);
      return new Map(supportedTokens.filter(token => token.id !== omit).map(token => [token.mint,
        { priceUsd: marks[token.id], blockId: slot, decimals: token.id === invalidDecimals ? 0 : token.decimals, change24h: '1.25' }]));
    } }, 'https://rpc.market-fixture.invalid');
  };
  let fundId;
  const submit = async (body, key = randomUUID()) => route('POST', `/v0/funds/${fundId}/orders`, 'captain', body, key, 202);
  const fill = async id => {
    await pool.query("UPDATE orders SET submitted_at=now()-interval '5 seconds' WHERE id=$1", [id]);
    await ingest(); assert.equal(await processOrder(pool, id), true);
    return (await route('GET', `/v0/funds/${fundId}/orders/${id}`)).order;
  };
  try {
    for (const file of (await readdir(dir)).filter(f => f.endsWith('.sql')).sort()) await pool.query(await readFile(new URL(file, dir), 'utf8'));
    globalThis.fetch = (input, options) => {
      if (String(input) === 'https://rpc.market-fixture.invalid') return Promise.resolve(Response.json({ result: Math.floor(Date.now()/1000) }));
      if (String(input) === 'https://api.privy.io/v1/apps/local-paper-test/jwks.json') return originalFetch(input, options);
      throw new Error('This suite must not contact an upstream provider');
    };
    await t.test('one batch isolates missing tokens, bad decimals, quote failures and real USD/USDC normalization', async () => {
      await ingest('JUP'); let rows = (await pool.query('SELECT instrument_id,payload FROM market_latest')).rows;
      assert.equal(rows.length, 5); assert.equal(rows.find(r => r.instrument_id === 'JUP').payload.price.status, 'UNAVAILABLE');
      assert.equal(rows.find(r => r.instrument_id === 'SOL').payload.price.status, 'CURRENT');
      assert.ok(new Amount(rows.find(r => r.instrument_id === 'SOL').payload.price.priceUsdc).eq(new Amount(100).div('1.01').toDecimalPlaces(18)));
      await ingest(null, 'BONK'); assert.equal((await pool.query("SELECT payload FROM market_latest WHERE instrument_id='BONK'")).rows[0].payload.price.status, 'UNAVAILABLE');
      await ingest('USDC'); rows = (await pool.query('SELECT payload FROM market_latest')).rows; assert.ok(rows.every(row => row.payload.price.status === 'UNAVAILABLE'));
      await ingest();
    });
    await t.test('repeated source marks retain original receipt, history deduplicates, reversal and failures cannot create false chart samples', async () => {
      const previous = (await pool.query("SELECT payload FROM market_latest WHERE instrument_id='JUP'")).rows[0].payload.price;
      const count = (await pool.query("SELECT count(*)::int AS n FROM market_samples WHERE instrument_id='JUP'")).rows[0].n;
      await recordMarketPrice(pool, { ...previous, receivedAt: new Date().toISOString() }, '1.01');
      await recordMarketPrice(pool, { ...previous, sourceAt: new Date(Date.parse(previous.sourceAt)-10000).toISOString(), sourceBlockId: '1' }, '1.01');
      await recordMarketPrice(pool, unavailable('upstream_unavailable', supportedTokens.find(t => t.id === 'JUP')));
      const last = (await pool.query("SELECT payload FROM market_latest WHERE instrument_id='JUP'")).rows[0].payload.price;
      assert.equal(last.receivedAt, previous.receivedAt); assert.equal(last.priceUsd, previous.priceUsd); assert.equal(last.status, 'UNAVAILABLE');
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM market_samples WHERE instrument_id='JUP'")).rows[0].n, count);
      await ingest();
    });
    await t.test('catalog returns only canonical tracked identities, supported REST subsets and honest missing history', async () => {
      const list = await route('GET', '/v0/market/tokens'); assert.equal(list.tokens.length, 5);
      assert.ok(list.tokens.every(token => !token.mint.startsWith('sample')));
      assert.equal(list.tokens.find(token => token.symbol === 'USDC').tradable, false);
      assert.equal(list.tokens.find(token => token.symbol === 'SOL').metrics.volume24h, null);
      const subset = await route('GET', '/v0/market/prices?instruments=JUP,SOL'); assert.equal(subset.prices.length, 2);
      await route('GET', '/v0/market/prices?instruments=BTC', null, null, null, 400);
      const history = await route('GET', `/v0/market/tokens/${supportedTokens[1].mint}/history?range=30D`);
      assert.equal(history.changePercent, null); assert.notEqual(history.coverage.status, 'COMPLETE');
      await route('GET', `/v0/market/tokens/${supportedTokens[1].mint}/history?range=ALL`, null, null, null, 400);
    });
    await t.test('owned funds and persistent watchlists are authenticated, isolated and idempotent', async () => {
      await route('POST', '/v0/captains', 'captain', { handle: 'market_captain' }, null, 201);
      fundId = (await route('POST', '/v0/funds', 'captain', { name: 'Market Trial' }, randomUUID(), 201)).id;
      assert.equal((await route('GET', '/v0/me/captain/funds', 'captain')).funds[0].id, fundId);
      assert.equal((await route('GET', '/v0/me/captain/funds', 'outsider')).funds.length, 0);
      await route('GET', `/v0/funds/${fundId}/trading-context`, 'outsider', null, null, 403);
      await route('GET', '/v0/me/watchlist', null, null, null, 401);
      const mint = supportedTokens[1].mint;
      const metadata = parseTokenMetadata([{ id: mint, symbol: 'JUP', name: 'Jupiter', decimals: 6, liquidity: 0, stats24h: { buyVolume: 0, sellVolume: 0 }, updatedAt: new Date().toISOString() }])[0];
      await pool.query('INSERT INTO market_token_metadata(mint,payload) VALUES($1,$2) ON CONFLICT(mint) DO UPDATE SET payload=EXCLUDED.payload', [mint, metadata]);
      for (let i=0;i<2;i++) await route('PUT', `/v0/me/watchlist/${mint}`, 'captain');
      assert.deepEqual((await route('GET', '/v0/me/watchlist', 'captain')).mints, [mint]);
      assert.deepEqual((await route('GET', '/v0/me/watchlist', 'outsider')).mints, []);
      for (let i=0;i<2;i++) await route('DELETE', `/v0/me/watchlist/${mint}`, 'captain');
      assert.deepEqual((await route('GET', '/v0/me/watchlist', 'captain')).mints, []);
      // Saved search results survive after leaving the search, without promoting them into execution.
      const unknownMint = '11111111111111111111111111111112';
      const unknown = parseTokenMetadata([{ id: unknownMint, symbol: 'SOL', name: 'Untracked fixture', decimals: 6 }])[0];
      await pool.query('INSERT INTO market_token_metadata(mint,payload) VALUES($1,$2)', [unknownMint, unknown]);
      await route('PUT', `/v0/me/watchlist/${unknownMint}`, 'captain');
      const restored = (await route('GET', '/v0/me/watchlist', 'captain')).tokens[0];
      assert.equal(restored.mint, unknownMint); assert.equal(restored.tracked, false); assert.equal(restored.tradable, false); assert.equal(restored.price, null);
      await route('DELETE', `/v0/me/watchlist/${unknownMint}`, 'captain');
      assert.equal((await route('GET', `/v0/market/tokens/${mint}`)).token.instrumentId, 'JUP');
    });
    await t.test('new fund trades multiple assets with correct precision and full portfolio NAV; USDC cannot trade', async () => {
      for (const instrumentId of ['SOL','JUP','BONK']) {
        const placed = await submit({ side: 'BUY', instrumentId, notionalUsdc: '50' });
        assert.equal((await fill(placed.orderId)).status, 'FILLED');
      }
      await submit({ side: 'BUY', instrumentId: 'USDC', notionalUsdc: '1' }).then(() => assert.fail('Quote asset accepted'), e => assert.match(String(e), /422/));
      const context = await route('GET', `/v0/funds/${fundId}/trading-context`, 'captain');
      assert.equal(context.holdings.length, 3);
      const expected = context.holdings.reduce((sum, holding) => sum.plus(holding.valueUsdc), new Amount(context.cashUsdc));
      assert.ok(expected.minus(context.navUsdc).abs().lt("0.000000000000001"));
      const nav = (await pool.query('SELECT nav_usdc::text FROM nav_snapshots WHERE fund_id=$1 ORDER BY event_sequence DESC LIMIT 1', [fundId])).rows[0].nav_usdc;
      assert.ok(new Amount(nav).eq(context.navUsdc));
      assert.match(context.holdings.find(h => h.instrumentId === 'BONK').quantity, /\.\d{18}$/);
    });
    await t.test('exact quantity sells preserve intent through price change, retries, policy checks and balanced ledgers', async () => {
      const key = randomUUID(), body = { side: 'SELL', instrumentId: 'JUP', quantity: '1.123456' };
      const first = await submit(body, key); marks.JUP='2.5'; await ingest();
      assert.equal((await submit({ ...body, quantity: '1.123456000' }, key)).orderId, first.orderId);
      const order = await fill(first.orderId); assert.equal(order.status, 'FILLED'); assert.ok(new Amount(order.quantity).eq(body.quantity));
      await route('POST', `/v0/funds/${fundId}/orders/preview`, 'captain', { ...body, quantity: '1.1234567' }, null, 422);
      await route('POST', `/v0/funds/${fundId}/orders`, 'captain', { ...body, notionalUsdc: '2' }, randomUUID(), 400);
      const balances = await pool.query(`SELECT e.event_id,a.asset_id,sum(e.amount)::text total FROM ledger_entries e JOIN ledger_accounts a ON a.id=e.account_id GROUP BY e.event_id,a.asset_id HAVING sum(e.amount)<>0`);
      assert.equal(balances.rowCount, 0);
    });
    await t.test('other stale holdings block execution; mark updates notice price changes in any held asset', async () => {
      await ingest(); await markActiveFunds(pool);
      const before = (await pool.query('SELECT count(*)::int n FROM nav_snapshots WHERE fund_id=$1', [fundId])).rows[0].n;
      const sol = supportedTokens[0], prior = (await pool.query("SELECT payload FROM market_latest WHERE instrument_id='SOL'")).rows[0].payload.price;
      await recordMarketPrice(pool, { ...prior, priceUsd: '110', priceUsdc: new Amount(110).div('1.01').toFixed(18), sourceBlockId: String(++slot), sourceAt: new Date().toISOString(), receivedAt: new Date().toISOString() }, '1.01');
      await markActiveFunds(pool); assert.ok((await pool.query('SELECT count(*)::int n FROM nav_snapshots WHERE fund_id=$1',[fundId])).rows[0].n > before);
      const placed = await submit({ side: 'BUY', instrumentId: 'JTO', notionalUsdc: '1' });
      await pool.query("UPDATE orders SET submitted_at=now()-interval '5 seconds' WHERE id=$1",[placed.orderId]); await ingest();
      await pool.query("UPDATE price_observations SET source_at=now()-interval '3 minutes' WHERE instrument_id='SOL'");
      assert.equal(await processOrder(pool,placed.orderId), false);
      await pool.query("UPDATE orders SET submitted_at=now()-interval '3 minutes' WHERE id=$1",[placed.orderId]);
      assert.equal(await processOrder(pool,placed.orderId), true); assert.equal((await route('GET', `/v0/funds/${fundId}/orders/${placed.orderId}`)).order.reject_reason, 'valuation_unavailable');
    });
    await t.test('history downsamples to bounded real points, detects gaps and computes returns only with a valid baseline', async () => {
      const token = supportedTokens[2], now = new Date(), start = new Date(now.getTime()-3600000);
      await pool.query('DELETE FROM market_samples WHERE instrument_id=$1',[token.id]);
      const observationId = (await pool.query('SELECT id FROM price_observations WHERE instrument_id=$1 LIMIT 1',[token.id])).rows[0].id;
      await pool.query(`INSERT INTO market_samples(instrument_id,source_at,price_usd,observation_id)
        SELECT $1,$2::timestamptz+g*interval '10 seconds',2+g::numeric/360,$3 FROM generate_series(0,360) g`,[token.id,start,observationId]);
      const h = await readHistory(pool, token.mint, '1H',now); assert.equal(h.coverage.status,'COMPLETE'); assert.equal(h.points.length,361); assert.ok(new Amount(h.changePercent).eq(50));
      await pool.query("DELETE FROM market_samples WHERE instrument_id=$1 AND source_at>$2::timestamptz+interval '10 minutes' AND source_at<$2::timestamptz+interval '30 minutes'",[token.id,start]);
      const partial = await readHistory(pool,token.mint,'1H',now); assert.equal(partial.coverage.status,'PARTIAL'); assert.equal(partial.coverage.hasGaps,true);
    });
    await t.test('WebSocket subsets advance cursors across excluded assets and resync correctly after a changed subscription', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'socially-market-stream-')), socket = join(directory, 'redis.sock');
      const server = spawn('redis-server',['--port','0','--unixsocket',socket,'--save','','--appendonly','no','--dir',directory],{stdio:['ignore','pipe','pipe']});
      let output=''; server.stdout.on('data',chunk=>{output+=chunk;}); server.stderr.on('data',chunk=>{output+=chunk;});
      let ws, bus;
      try {
        for (let i=0;i<100&&!output.toLowerCase().includes('ready to accept connections');i++) await delay(20);
        assert.match(output.toLowerCase(),/ready to accept connections/);
        process.env.REDIS_URL=socket; bus=new MarketBus(pool,socket);
        await delay(50); await bus.deliver(); await app.ready(); ws=await app.injectWS('/v0/ws');
        const messages=[]; ws.on('message', raw=>messages.push(JSON.parse(raw.toString())));
        const waitFor=async predicate=>{for(let i=0;i<100;i++){const found=messages.find(predicate);if(found)return found;await delay(20);}assert.fail(`Expected stream message did not arrive: ${JSON.stringify(messages)}`);};
        ws.send(JSON.stringify({type:'subscribe',channel:'market.prices',instruments:['JUP']}));
        const snapshot=await waitFor(m=>m.type==='snapshot'); assert.deepEqual(snapshot.prices.map(p=>p.instrumentId),['JUP']);
        messages.length=0;
        const previous=(await pool.query("SELECT payload FROM market_latest WHERE instrument_id='SOL'")).rows[0].payload.price;
        await recordMarketPrice(pool,{...previous,sourceAt:new Date().toISOString(),receivedAt:new Date().toISOString(),sourceBlockId:String(++slot),priceUsd:'111',priceUsdc:'110'},'1.01');
        await bus.deliver(); const skipped=await waitFor(m=>m.type==='cursor'); assert.ok(BigInt(skipped.cursor.split('-')[0])>BigInt(snapshot.cursor.split('-')[0]));
        assert.ok(!messages.some(m=>m.price?.instrumentId==='SOL'));
        messages.length=0;
        ws.send(JSON.stringify({type:'subscribe',channel:'market.prices',instruments:['SOL'],after:'0-0'}));
        const resync=await waitFor(m=>m.type==='snapshot'); assert.deepEqual(resync.prices.map(p=>p.instrumentId),['SOL']);
        messages.length=0;
        ws.send(JSON.stringify({type:'subscribe',channel:'market.prices',instruments:['BTC']}));
        await waitFor(m=>m.type==='error');
      } finally {
        ws?.terminate(); bus?.close(); delete process.env.REDIS_URL;
        if(server.exitCode===null){const stopped=new Promise(resolve=>server.once('exit',resolve));server.kill('SIGTERM');await stopped;}
        await rm(directory,{recursive:true,force:true});
      }
    });
    await t.test('buy disablement retains browse identity and permits existing holdings to exit', async () => {
      await pool.query("UPDATE instruments SET active=false WHERE id='JUP'");
      const catalog = await route('GET', '/v0/market/tokens');
      const token = catalog.tokens.find(token => token.instrumentId === 'JUP');
      assert.equal(token.tracked, true); assert.equal(token.tradable, false); assert.equal(token.tradeReason, 'asset_disabled');
      const context = await route('GET', `/v0/funds/${fundId}/trading-context`, 'captain');
      const limit = context.limits.find(limit => limit.instrumentId === 'JUP');
      assert.equal(limit.canBuy, false); assert.equal(limit.canSell, true);
      await pool.query("UPDATE instruments SET active=true WHERE id='JUP'");
    });
  } finally { globalThis.fetch=originalFetch; await app.close(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); }
});
