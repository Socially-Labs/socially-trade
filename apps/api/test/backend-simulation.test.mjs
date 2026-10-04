import { configurePrivyFixture } from './privy-fixture.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';
import { createApp } from '../dist/app.js';
import { processOrder, markActiveFunds } from '../../worker/dist/orders.js';
import { deliverOutbox } from '../../worker/dist/notifications.js';
import { runWorkerCycle } from '../../worker/dist/cycle.js';
import { assessDailyFees, assessFundFee } from '../../worker/dist/fees.js';
import { completeExpiredTrials, completeTrial } from '../../worker/dist/trials.js';
import { inTransaction } from '../../../packages/db/dist/index.js';
import { Amount, evaluateSpotOrder } from '../../../packages/domain/dist/index.js';
import { simulateFill } from '../../../packages/market-data/dist/index.js';

// A unique schema isolates every run; no existing application tables are modified.
test('seeded-price backend simulation (no Pyth)', { timeout: 120_000 }, async (t) => {
  const connectionString = process.env.TEST_DATABASE_URL;
  assert.ok(connectionString, 'Set TEST_DATABASE_URL to a local PostgreSQL database');
  assert.match(new URL(connectionString).hostname, /^(localhost|127\.0\.0\.1|\[::1\])$/);
  delete process.env.PYTH_API_KEY;
  process.env.NODE_ENV = 'development';
  const tokenFor = configurePrivyFixture();
  process.env.DEV_PRICE_SEED_ENABLED = 'true';
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input, options) => {
    const hostname = new URL(typeof input === 'string' ? input : input.url ?? input).hostname;
    if (String(input) === 'https://api.privy.io/v1/apps/local-paper-test/jwks.json') return originalFetch(input, options);
    assert.match(hostname, /^(localhost|127\.0\.0\.1|\[::1\])$/, 'Tests must never contact a market-data provider');
    return originalFetch(input, options);
  };
  const schema = `simulation_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ connectionString, options: `-c search_path=${schema}`, max: 15 });
  const app = createApp(pool);
  app.log.level = 'silent';
  const migrationDir = new URL('../../../packages/db/migrations/', import.meta.url);
  const ids = {};
  let fundId;
  let buyId;
  let noteId;
  let settlementPendingOrder;
  const route = (suffix = '') => `/v0/funds/${fundId}${suffix}`;
  const headers = (subject, key) => ({ authorization: `Bearer ${tokenFor(subject)}`, ...(key ? { 'idempotency-key': key } : {}) });
  async function request(method, url, subject, payload, key, expected = 200) {
    const response = await app.inject({ method, url, headers: subject ? headers(subject, key) : {}, payload });
    assert.equal(response.statusCode, expected, `${method} ${url}: ${response.body}`);
    return response.json();
  }
  async function seed(price = '150', ageSeconds = 0) {
    const id = randomUUID();
    await pool.query(`INSERT INTO price_observations
      (id,instrument_id,source,source_ref,price_usdc,source_at,received_at)
      VALUES ($1::uuid,'SOL','DEV_SEED',$1::text,$2,now()-$3*interval '1 second',now())`, [id, price, ageSeconds]);
    return id;
  }
  async function clearPrices() { await pool.query('DELETE FROM price_observations WHERE id NOT IN (SELECT observation_id FROM fills) AND id NOT IN (SELECT observation_id FROM nav_snapshots WHERE observation_id IS NOT NULL)');
    await pool.query("UPDATE price_observations SET source_at=now()-interval '5 minutes'"); }
  async function order(side = 'BUY', notionalUsdc = '50', key = randomUUID()) {
    return (await request('POST', route('/orders'), 'captain', { side, instrumentId: 'SOL', notionalUsdc }, key, 202)).orderId;
  }
  async function ageOrder(id, seconds = 10) {
    await pool.query("UPDATE orders SET submitted_at=now()-$2*interval '1 second' WHERE id=$1", [id, seconds]);
  }
  async function settled(id, price = '150') { await ageOrder(id); await seed(price); await processOrder(pool, id);
    return (await request('GET', route(`/orders/${id}`))).order; }
  async function reconcile() {
    const unbalanced = await pool.query(`SELECT e.event_id,a.asset_id FROM ledger_entries e
      JOIN ledger_accounts a ON a.id=e.account_id GROUP BY e.event_id,a.asset_id HAVING SUM(e.amount)<>0`);
    assert.equal(unbalanced.rowCount, 0, 'Every event must balance per asset');
    const mismatches = await pool.query(`WITH balances AS (
      SELECT a.owner_type,a.owner_id,a.asset_id,COALESCE(SUM(e.amount),0) amount
      FROM ledger_accounts a LEFT JOIN ledger_entries e ON e.account_id=a.id
      GROUP BY a.owner_type,a.owner_id,a.asset_id)
      SELECT 'fund cash' kind FROM funds f LEFT JOIN balances b ON b.owner_type='FUND' AND b.owner_id=f.id::text AND b.asset_id='USDC' WHERE f.cash_usdc<>COALESCE(b.amount,0)
      UNION ALL SELECT 'user cash' FROM users u LEFT JOIN balances b ON b.owner_type='USER' AND b.owner_id=u.id::text AND b.asset_id='USDC' WHERE u.paper_cash<>COALESCE(b.amount,0)
      UNION ALL SELECT 'position' FROM positions p LEFT JOIN balances b ON b.owner_type='FUND' AND b.owner_id=p.fund_id::text AND b.asset_id=p.instrument_id WHERE p.quantity<>COALESCE(b.amount,0)
      UNION ALL SELECT 'shares' FROM fund_shares s LEFT JOIN balances b ON b.owner_type='USER' AND b.owner_id=s.user_id::text AND b.asset_id='SHARE:'||s.fund_id::text WHERE s.shares<>COALESCE(b.amount,0)
      UNION ALL SELECT 'protocol shares' FROM funds f LEFT JOIN balances b ON b.owner_type='PROTOCOL' AND b.owner_id='paper-protocol' AND b.asset_id='SHARE:'||f.id::text WHERE f.protocol_shares<>COALESCE(b.amount,0)
      UNION ALL SELECT 'supply' FROM funds f WHERE total_shares<>protocol_shares+(SELECT COALESCE(SUM(shares),0) FROM fund_shares WHERE fund_id=f.id)`);
    assert.deepEqual(mismatches.rows, [], 'Ledger and all money/share projections must reconcile');
  }
  try {
    for (const name of (await readdir(migrationDir)).filter(x => x.endsWith('.sql')).sort()) {
      await pool.query(await readFile(new URL(name, migrationDir), 'utf8'));
    }
    await t.test('health, unauthorized access, malformed requests and identifiers', async () => {
      await request('GET', '/health');
      await request('GET', '/v0/me', undefined, undefined, undefined, 401);
      await request('GET', '/v0/funds/not-a-uuid', undefined, undefined, undefined, 400);
      await request('GET', `/v0/funds/${randomUUID()}`, undefined, undefined, undefined, 404);
      await request('POST', '/v0/funds', 'captain', { name: 'Valid' }, undefined, 400);
      const malformed = await app.inject({ method: 'POST', url: '/v0/funds',
        headers: { ...headers('captain'), 'content-type': 'application/json' }, payload: '{invalid' });
      assert.equal(malformed.statusCode, 400);
    });
    await t.test('concurrent sign-in grants one allowance and one ledger event', async () => {
      const responses = await Promise.all(Array.from({ length: 8 }, () => request('GET', '/v0/me', 'captain')));
      assert.equal(new Set(responses.map(x => x.id)).size, 1);
      ids.captain = responses[0].id;
      assert.equal(new Amount(responses[0].paperCash.value).toString(), '10000');
      const grants = await pool.query("SELECT 1 FROM fund_events WHERE type='paper_budget_granted' AND payload->>'userId'=$1", [ids.captain]);
      assert.equal(grants.rowCount, 1);
      for (const subject of ['crew', 'outsider']) ids[subject] = (await request('GET', '/v0/me', subject)).id;
    });
    await t.test('Captain creation, duplicate fund retry and one active trial', async () => {
      await request('POST', '/v0/funds', 'outsider', { name: 'No Captain' }, randomUUID(), 403);
      await request('POST', '/v0/captains', 'captain', { handle: 'captain_test' }, undefined, 201);
      const payload = { name: 'Simulation Fund' }, key = randomUUID();
      const created = await Promise.all(Array.from({ length: 4 }, () => request('POST', '/v0/funds', 'captain', payload, key, 201)));
      fundId = created[0].id;
      assert.ok(created.every(x => x.id === fundId));
      assert.equal(new Amount(created[0].nav.value).toString(), '1000');
      await request('POST', '/v0/funds', 'captain', payload, randomUUID(), 409);
      await request('POST', '/v0/funds', 'captain', { name: 'Changed' }, key, 409);
      assert.equal((await pool.query('SELECT event_sequence FROM funds WHERE id=$1', [fundId])).rows[0].event_sequence, '1');
    });
    await t.test('Crew join concurrency, idempotency, allowance and Captain lock', async () => {
      const key = randomUUID();
      const results = await Promise.all(Array.from({ length: 6 }, () => request('POST', route('/joins'), 'crew', { amountUsdc: '100' }, key, 201)));
      assert.ok(results.every(x => x.eventId === results[0].eventId));
      assert.equal(new Amount(results[0].shares).toString(), '100');
      await request('POST', route('/joins'), 'crew', { amountUsdc: '101' }, key, 409);
      await request('POST', route('/joins'), 'crew', { amountUsdc: '10000' }, randomUUID(), 422);
      await request('POST', route('/joins'), 'captain', { amountUsdc: '1' }, randomUUID(), 403);
      await request('POST', route('/exits'), 'captain', { shares: '1' }, randomUUID(), 403);
      await request('POST', route('/exits'), 'crew', { shares: '101' }, randomUUID(), 422);
      await reconcile();
    });
    await t.test('invalid decimal values cannot change balances', async () => {
      for (const amount of ['0', '-1', 'NaN', 'Infinity', '1e2', '1.0000001', '01', '', '0.1']) {
        await request('POST', route('/joins'), 'crew', { amountUsdc: amount }, randomUUID(), 400);
        await request('POST', route('/orders'), 'captain', { side: 'BUY', instrumentId: 'SOL', notionalUsdc: amount }, randomUUID(), 400);
      }
      await request('POST', route('/orders'), 'captain', { side: 'BUY', instrumentId: 'SOL', notionalUsdc: 50 }, randomUUID(), 400);
      await request('POST', route('/orders'), 'captain', { side: 'BUY', instrumentId: 'SOL', notionalUsdc: '1001' }, randomUUID(), 400);
      await request('POST', route('/exits'), 'crew', { shares: '1.0000000000000000001' }, randomUUID(), 400);
      await reconcile();
    });
    await t.test('missing, stale and future prices block previews', async () => {
      const input = { side: 'BUY', instrumentId: 'SOL', notionalUsdc: '50' };
      await request('POST', route('/orders/preview'), 'captain', input, undefined, 503);
      await seed('150', 120);
      await request('POST', route('/orders/preview'), 'captain', input, undefined, 503);
      await seed('150', -30);
      await request('POST', route('/orders/preview'), 'captain', input, undefined, 503);
      await clearPrices(); await seed();
      const preview = await request('POST', route('/orders/preview'), 'captain', input);
      assert.equal(preview.policy.allowed, true);
      assert.ok(new Amount(preview.estimate.fillPriceUsdc).gt(150));
    });
    await t.test('Captain authority and unsupported instruments', async () => {
      await request('POST', route('/orders'), 'crew', { side: 'BUY', instrumentId: 'SOL', notionalUsdc: '50' }, randomUUID(), 403);
      await request('POST', route('/orders'), 'captain', { side: 'BUY', instrumentId: 'BTC', notionalUsdc: '50' }, randomUUID(), 422);
      await request('POST', route('/orders'), 'captain', { side: 'BUY', instrumentId: 'SOL', notionalUsdc: '50', price: '1' }, randomUUID(), 400);
    });
    await t.test('order retries share an ID; pre-submit prices and delay cannot fill', async () => {
      const key = randomUUID(), payload = { side: 'BUY', instrumentId: 'SOL', notionalUsdc: '50' };
      const results = await Promise.all(Array.from({ length: 5 }, () => request('POST', route('/orders'), 'captain', payload, key, 202)));
      buyId = results[0].orderId;
      assert.ok(results.every(x => x.orderId === buyId));
      await request('POST', route('/orders'), 'captain', { ...payload, notionalUsdc: '51' }, key, 409);
      assert.equal(await processOrder(pool, buyId), false);
      await ageOrder(buyId);
      await pool.query("UPDATE price_observations SET source_at=now()-interval '30 seconds',received_at=now()-interval '30 seconds'");
      assert.equal(await processOrder(pool, buyId), false);
    });
    await t.test('concurrent workers fill exactly once with balanced cash and SOL', async () => {
      const observation = await seed('151');
      const results = await Promise.all(Array.from({ length: 8 }, () => processOrder(pool, buyId)));
      assert.equal(results.filter(Boolean).length, 1);
      const record = (await request('GET', route(`/orders/${buyId}`))).order;
      assert.equal(record.status, 'FILLED');
      assert.equal(record.observation_id, observation);
      assert.equal(record.model_version, 1);
      assert.equal((await pool.query('SELECT 1 FROM fills WHERE order_id=$1', [buyId])).rowCount, 1);
      assert.equal(new Amount((await request('GET', route('/holdings'))).cashUsdc).toString(), '1050');
      await request('POST', route(`/orders/${buyId}/cancel`), 'captain', undefined, undefined, 409);
      await reconcile();
    });
    await t.test('mark uses source timestamp and repeated observation creates no extra mark', async () => {
      await clearPrices();
      await seed('160', 20);
      await markActiveFunds(pool);
      assert.equal(await markActiveFunds(pool), 0);
      const nav = (await pool.query('SELECT priced_at FROM nav_snapshots WHERE fund_id=$1 ORDER BY event_sequence DESC LIMIT 1', [fundId])).rows[0];
      assert.ok(Date.now() - nav.priced_at.getTime() >= 19_000);
    });
    await t.test('Crew entry/exit at a marked price preserves share price and ledger', async () => {
      await seed('160');
      const key = randomUUID();
      const joins = await Promise.all([request('POST', route('/joins'), 'crew', { amountUsdc: '10' }, key, 201), request('POST', route('/joins'), 'crew', { amountUsdc: '10' }, key, 201)]);
      assert.equal(joins[0].eventId, joins[1].eventId);
      const exits = await request('POST', route('/exits'), 'crew', { shares: joins[0].shares }, randomUUID());
      assert.ok(new Amount(exits.virtualUsdc).lte(10));
      assert.ok(new Amount(exits.virtualUsdc).gt('9.99'));
      assert.ok(new Amount(exits.sharePrice).minus(joins[0].sharePrice).abs().lt('0.000001'));
      await reconcile();
    });
    await t.test('sell reduces holdings; oversell and order-size cap reject atomically', async () => {
      const sell = await settled(await order('SELL', '10'), '160');
      assert.equal(sell.status, 'FILLED');
      assert.ok(new Amount(sell.fill_price_usdc).lt(160));
      const oversell = await settled(await order('SELL', '90'), '160');
      assert.equal(oversell.reject_reason, 'insufficient_position');
      const large = await settled(await order('BUY', '500'), '160');
      assert.equal(large.reject_reason, 'order_too_large');
      await reconcile();
    });
    await t.test('position cap prevents excessive exposure', async () => {
      await pool.query('UPDATE fund_policy_versions SET max_position_bps=1 WHERE fund_id=$1', [fundId]);
      const record = await settled(await order(), '160');
      assert.equal(record.reject_reason, 'position_limit');
      await pool.query('UPDATE fund_policy_versions SET max_position_bps=2500 WHERE fund_id=$1', [fundId]);
      await reconcile();
    });
    await t.test('disabled instruments cannot fill an already pending order', async () => {
      const id = await order(); await ageOrder(id); await seed();
      await pool.query("UPDATE instruments SET active=false WHERE id='SOL'");
      await processOrder(pool, id);
      const record = (await request('GET', route(`/orders/${id}`))).order;
      await pool.query("UPDATE instruments SET active=true WHERE id='SOL'");
      assert.equal(record.reject_reason, 'asset_not_allowed');
    });
    await t.test('production ignores seeded prices and development credentials', async () => {
      const id = await order(); await ageOrder(id); await seed();
      process.env.NODE_ENV = 'production';
      try {
        assert.equal(await processOrder(pool, id), false);
        assert.equal(await markActiveFunds(pool), 0);
        const response = await app.inject({ method: 'GET', url: '/v0/me', headers: headers('captain') });
        assert.notEqual(response.statusCode, 200);
      } finally { process.env.NODE_ENV = 'development'; }
      await request('POST', route(`/orders/${id}/cancel`), 'captain');
    });
    await t.test('database failure rolls back a fill and retry settles once', async () => {
      const id = await order(); await ageOrder(id); await seed();
      const before = (await request('GET', route('/holdings')));
      await pool.query(`CREATE FUNCTION fail_fill() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'simulation fill failure'; END; $$;
        CREATE TRIGGER fail_fill BEFORE INSERT ON fills FOR EACH ROW EXECUTE FUNCTION fail_fill()`);
      await assert.rejects(processOrder(pool, id), /simulation fill failure/);
      assert.deepEqual(await request('GET', route('/holdings')), before);
      assert.equal((await request('GET', route(`/orders/${id}`))).order.status, 'PENDING');
      await pool.query('DROP TRIGGER fail_fill ON fills; DROP FUNCTION fail_fill()');
      assert.equal(await processOrder(pool, id), true);
      assert.equal(await processOrder(pool, id), false);
      await reconcile();
    });
    await t.test('unpriced order times out without any fill', async () => {
      const id = await order(); await ageOrder(id, 180); await clearPrices();
      assert.equal(await processOrder(pool, id), true);
      assert.equal((await request('GET', route(`/orders/${id}`))).order.reject_reason, 'price_unavailable');
    });
    await t.test('price-ingestion failure does not block timeouts or notification delivery', async () => {
      const id = await order(); await ageOrder(id, 180); await clearPrices();
      const result = await runWorkerCycle(pool, async () => { throw new Error('Simulated source outage'); });
      assert.equal(result.failures.length, 1);
      assert.equal(result.failures[0].job, 'price_ingestion');
      assert.equal(result.processed, 1);
      assert.ok(result.delivered > 0);
      assert.equal((await request('GET', route(`/orders/${id}`))).order.reject_reason, 'price_unavailable');
    });
    await t.test('stale holdings block joins/exits and report unavailable valuation', async () => {
      await clearPrices();
      await request('POST', route('/joins'), 'crew', { amountUsdc: '10' }, randomUUID(), 503);
      await request('POST', route('/exits'), 'crew', { shares: '1' }, randomUUID(), 503);
      await pool.query("UPDATE nav_snapshots SET priced_at=now()-interval '5 minutes'");
      assert.equal((await request('GET', route())).valuationStatus, 'UNAVAILABLE');
      await seed();
    });
    await t.test('pending cancellation is authorized, idempotent and excludes worker fill', async () => {
      const id = await order();
      await request('POST', route(`/orders/${id}/cancel`), 'crew', undefined, undefined, 403);
      await request('POST', route(`/orders/${id}/cancel`), 'captain');
      await request('POST', route(`/orders/${id}/cancel`), 'captain');
      await ageOrder(id); await seed();
      assert.equal(await processOrder(pool, id), false);
      assert.equal((await request('GET', route(`/orders/${id}`))).order.status, 'CANCELLED');
    });
    await t.test('cancellation racing execution has one terminal result', async () => {
      const id = await order(); await ageOrder(id); await seed();
      const [cancel] = await Promise.all([
        app.inject({ method: 'POST', url: route(`/orders/${id}/cancel`), headers: headers('captain') }),
        processOrder(pool, id),
      ]);
      assert.ok([200, 409].includes(cancel.statusCode));
      const record = (await request('GET', route(`/orders/${id}`))).order;
      assert.ok(['FILLED', 'CANCELLED'].includes(record.status));
      const fills = (await pool.query('SELECT 1 FROM fills WHERE order_id=$1', [id])).rowCount;
      assert.equal(fills, record.status === 'FILLED' ? 1 : 0);
      await reconcile();
    });
    await t.test('drawdown freezes buys but permits a risk-reducing sell', async () => {
      await pool.query('UPDATE fund_policy_versions SET drawdown_breaker_bps=1 WHERE fund_id=$1', [fundId]);
      await seed('100'); await markActiveFunds(pool);
      assert.equal((await request('GET', route())).status, 'FROZEN');
      await request('POST', route('/orders'), 'captain', { side: 'BUY', instrumentId: 'SOL', notionalUsdc: '1' }, randomUUID(), 409);
      const sell = await settled(await order('SELL', '1'), '100');
      assert.equal(sell.status, 'FILLED');
      await pool.query("UPDATE funds SET status='ACTIVE' WHERE id=$1", [fundId]);
      await pool.query('UPDATE fund_policy_versions SET drawdown_breaker_bps=3000 WHERE fund_id=$1', [fundId]);
    });
    await t.test('chat membership, whitespace validation, retries and Captain corrections', async () => {
      await request('POST', route('/messages'), 'outsider', { body: 'hello' }, randomUUID(), 403);
      await request('POST', route('/messages'), 'crew', { body: '   ' }, randomUUID(), 400);
      const key = randomUUID();
      const messages = await Promise.all(Array.from({ length: 3 }, () => request('POST', route('/messages'), 'crew', { body: 'Crew message' }, key, 201)));
      assert.ok(messages.every(x => x.message.id === messages[0].message.id));
      await request('POST', route(`/orders/${buyId}/notes`), 'crew', { body: 'Not my order' }, randomUUID(), 403);
      const note = await request('POST', route(`/orders/${buyId}/notes`), 'captain', { body: 'Original rationale' }, randomUUID(), 201);
      noteId = note.message.id;
      await request('POST', route(`/orders/${buyId}/notes`), 'captain', { body: 'Correction', correctsMessageId: noteId }, randomUUID(), 201);
      const notes = (await request('GET', route('/decisions'))).notes;
      assert.equal(notes.length, 2); assert.equal(notes[0].body, 'Original rationale');
      assert.equal(notes[1].correctsMessageId, noteId);
      await pool.query("UPDATE messages SET moderation_status='HIDDEN' WHERE id=$1", [messages[0].message.id]);
      assert.ok(!(await request('GET', route('/messages'))).messages.some(x => x.id === messages[0].message.id));
      assert.equal((await request('GET', route(`/decisions?after=${notes[0].sequence}`))).notes.length, 1);
    });
    await t.test('events have gap-free sequences and exactly one outbox intent', async () => {
      const events = (await request('GET', route('/events'))).events;
      events.forEach((event, index) => assert.equal(Number(event.sequence), index + 1));
      const absent = await pool.query('SELECT e.id FROM fund_events e LEFT JOIN outbox_events o ON o.fund_event_id=e.id WHERE e.fund_id=$1 AND o.id IS NULL', [fundId]);
      assert.equal(absent.rowCount, 0);
      await request('GET', route('/events?after=-1'), undefined, undefined, undefined, 400);
      await request('GET', route('/events?after=9007199254740992'), undefined, undefined, undefined, 400);
    });
    await t.test('concurrent outbox delivery deduplicates inbox and protects ownership', async () => {
      await Promise.all([deliverOutbox(pool), deliverOutbox(pool), deliverOutbox(pool)]);
      assert.equal(await deliverOutbox(pool), 0);
      const notifications = (await request('GET', '/v0/me/notifications', 'crew')).notifications;
      assert.ok(notifications.every((item, i) => i === 0 || BigInt(item.id) > BigInt(notifications[i - 1].id)));
      assert.ok(notifications.some(x => x.type === 'order_filled'));
      assert.ok(notifications.some(x => x.type === 'trade_note_posted'));
      const id = notifications[0].id;
      await request('POST', `/v0/me/notifications/${id}/read`, 'outsider', undefined, undefined, 404);
      const read = await request('POST', `/v0/me/notifications/${id}/read`, 'crew');
      assert.deepEqual(await request('POST', `/v0/me/notifications/${id}/read`, 'crew'), read);
      assert.equal((await request('GET', '/v0/me/notifications', 'outsider')).notifications.length, 0);
    });
    await t.test('notification failure keeps outbox recoverable without duplicate alerts', async () => {
      const id = await order(); await request('POST', route(`/orders/${id}/cancel`), 'captain');
      await pool.query(`CREATE FUNCTION fail_notification() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'simulation inbox failure'; END; $$;
        CREATE TRIGGER fail_notification BEFORE INSERT ON notifications FOR EACH ROW EXECUTE FUNCTION fail_notification()`);
      const savedError = console.error;
      const errors = [];
      try {
        console.error = (...args) => errors.push(args);
        await deliverOutbox(pool);
      } finally { console.error = savedError; }
      assert.ok(errors.length > 0, 'Injected delivery errors must be reported');
      const pending = await pool.query('SELECT id,attempts FROM outbox_events WHERE delivered_at IS NULL');
      assert.ok(pending.rowCount > 0); assert.ok(pending.rows.every(x => x.attempts === 1));
      await pool.query('DROP TRIGGER fail_notification ON notifications; DROP FUNCTION fail_notification()');
      await pool.query('UPDATE outbox_events SET next_attempt_at=now() WHERE delivered_at IS NULL');
      await deliverOutbox(pool);
      assert.equal((await pool.query('SELECT 1 FROM outbox_events WHERE delivered_at IS NULL')).rowCount, 0);
      assert.equal(await deliverOutbox(pool), 0);
    });
    await t.test('40 deterministic price and order scenarios preserve all ledger projections', async () => {
      let state = 12345;
      for (let i = 0; i < 40; i++) {
        state = (state * 16807) % 2147483647;
        const price = String(100 + state % 100);
        const record = await settled(await order(i % 2 ? 'SELL' : 'BUY', String(1 + state % 30)), price);
        assert.ok(['FILLED', 'REJECTED'].includes(record.status));
        await reconcile();
      }
    });
    await t.test('concurrent join, exit and fill serialize without projection drift', async () => {
      for (let i = 0; i < 12; i++) {
        await seed('150');
        const id = await order('BUY', '5'); await ageOrder(id); await seed('150');
        await Promise.all([
          request('POST', route('/joins'), 'crew', { amountUsdc: '5' }, randomUUID(), 201),
          request('POST', route('/exits'), 'crew', { shares: '1' }, randomUUID()),
          processOrder(pool, id),
        ]);
        await reconcile();
      }
    });
    await t.test('different fund creation keys race without duplicate trials or deadlocks', async () => {
      await request('POST', '/v0/captains', 'racer', { handle: 'race_captain' }, undefined, 201);
      const responses = await Promise.all(Array.from({ length: 5 }, () => app.inject({
        method: 'POST', url: '/v0/funds', headers: headers('racer', randomUUID()), payload: { name: 'Concurrent Trial' },
      })));
      assert.equal(responses.filter(x => x.statusCode === 201).length, 1);
      assert.equal(responses.filter(x => x.statusCode === 409).length, 4);
      await reconcile();
    });
    await t.test('Crew allocation across funds uses one shared allowance', async () => {
      const otherFund = (await pool.query('SELECT id FROM funds WHERE id<>$1', [fundId])).rows[0].id;
      await request('POST', `/v0/funds/${otherFund}/joins`, 'outsider', { amountUsdc: '4000' }, randomUUID(), 201);
      await request('POST', route('/joins'), 'outsider', { amountUsdc: '6001' }, randomUUID(), 422);
      await seed('150');
      await request('POST', route('/joins'), 'outsider', { amountUsdc: '6000' }, randomUUID(), 201);
      assert.equal(new Amount((await request('GET', '/v0/me/paper-balance', 'outsider')).available.value).toString(), '0');
      await reconcile();
    });
    await t.test('event pagination recovers all history beyond 100 events', async () => {
      const seen = []; let after = '0';
      for (;;) {
        const page = (await request('GET', route(`/events?after=${after}`))).events;
        if (!page.length) break;
        seen.push(...page.map(x => x.sequence)); after = page.at(-1).sequence;
      }
      const expected = (await pool.query('SELECT sequence::text FROM fund_events WHERE fund_id=$1 ORDER BY fund_events.sequence', [fundId])).rows.map(x => x.sequence);
      assert.ok(expected.length > 100);
      assert.deepEqual(seen, expected);
    });
    await t.test('chat reads keep numeric sequence order across cursor digit lengths', async () => {
      const posted = [];
      for (let i = 0; i < 12; i++) posted.push((await request('POST', route('/messages'), 'crew', { body: `Message ${i}` }, randomUUID(), 201)).message);
      const page = (await request('GET', route(`/messages?after=${Number(posted[0].sequence) - 1}`))).messages;
      assert.deepEqual(page.map(x => x.id), posted.map(x => x.id));
    });
    await t.test('fill model is reproducible and 100 static-price round trips never create cash', async () => {
      for (let i = 1; i <= 100; i++) {
        const notional = String(i * 10), price = String(70 + i);
        const buy = simulateFill('BUY', notional, price, 9);
        assert.deepEqual(simulateFill('BUY', notional, price, 9), buy);
        const sell = simulateFill('SELL', new Amount(buy.quantity).mul(price).toString(), price, 9);
        assert.ok(new Amount(sell.cashChangeUsdc).lt(notional));
        assert.ok(new Amount(buy.quantity).gt(0));
        assert.ok(new Amount(sell.quantity).lte(buy.quantity));
      }
      const base = { side: 'BUY', instrumentId: 'SOL', allowedInstruments: ['SOL'], notionalUsdc: '10',
        quantity: '0.1', marketPriceUsdc: '100', cashUsdc: '9', positionQuantity: '0', navUsdc: '1000',
        sharePriceUsdc: '1', peakSharePriceUsdc: '1', maxOrderBps: 1000, maxPositionBps: 2500, drawdownBreakerBps: 3000 };
      assert.equal(evaluateSpotOrder(base), 'insufficient_cash');
      assert.equal(evaluateSpotOrder({ ...base, cashUsdc: '100', sharePriceUsdc: '0.69' }), 'drawdown_breaker');
      assert.equal(evaluateSpotOrder({ ...base, cashUsdc: '100', sharePriceUsdc: '0.70' }), null);
    });
    await t.test('expired trials reject submissions and pending execution', async () => {
      const id = await order(); await ageOrder(id); await seed();
      await pool.query("UPDATE trials SET starts_at=now()-interval '31 days',ends_at=now()-interval '1 day' WHERE fund_id=$1", [fundId]);
      await request('POST', route('/joins'), 'crew', { amountUsdc: '1' }, randomUUID(), 409);
      await request('POST', route('/orders'), 'captain', { side: 'BUY', instrumentId: 'SOL', notionalUsdc: '1' }, randomUUID(), 409);
      assert.equal(await processOrder(pool, id), true);
      assert.equal((await request('GET', route(`/orders/${id}`))).order.reject_reason, 'fund_not_tradable');
    });
    await t.test('SSE replays after cursor and Last-Event-ID on a real connection', async () => {
      const address = await app.listen({ host: '127.0.0.1', port: 0 });
      for (const byHeader of [false, true]) {
        const controller = new AbortController();
        const response = await fetch(address + route('/events/stream') + (byHeader ? '' : '?after=1'), {
          headers: byHeader ? { 'Last-Event-ID': '1' } : {}, signal: controller.signal,
        });
        assert.equal(response.status, 200);
        const reader = response.body.getReader(); let text = '';
        while (!text.includes('event: fund-event')) {
          const result = await reader.read(); text += new TextDecoder().decode(result.value);
        }
        assert.equal(text.match(/id: (\d+)\nevent: fund-event/)[1], '2');
        assert.ok(!text.includes('id: 1\n'));
        controller.abort(); await reader.cancel().catch(() => {});
      }
    });
    await t.test('cash-only trial settles once across concurrent workers', async () => {
      const cashFund = (await pool.query('SELECT id FROM funds WHERE id<>$1', [fundId])).rows[0].id;
      assert.equal(await completeTrial(pool, cashFund), false);
      await pool.query("UPDATE trials SET starts_at=now()-interval '31 days',ends_at=now()-interval '1 day' WHERE fund_id=$1", [cashFund]);
      const results = await Promise.all(Array.from({ length: 6 }, () => completeTrial(pool, cashFund)));
      assert.equal(results.filter(Boolean).length, 1);
      const f = (await pool.query('SELECT * FROM funds WHERE id=$1', [cashFund])).rows[0];
      assert.equal(f.status, 'COMPLETED');
      assert.equal(new Amount(f.cash_usdc).toString(), '0');
      assert.equal(new Amount(f.total_shares).toString(), '0');
      assert.equal(new Amount(f.final_nav_usdc).toString(), '5000');
      const result = await request('GET', `/v0/funds/${cashFund}/performance`);
      assert.equal(result.valuationStatus, 'FINAL');
      assert.equal(new Amount(result.current.navUsdc).toString(), '5000');
      await reconcile();
    });
    await t.test('completion notifications reach Crew after their shares are redeemed', async () => {
      // Delivery is intentionally batched at 100; drain the accumulated scenario backlog.
      while (await deliverOutbox(pool)) {}
      const completion = await pool.query(`SELECT n.id FROM notifications n
        WHERE n.type='trial_completed' AND n.user_id=$1`, [ids.outsider]);
      assert.equal(completion.rowCount, 1);
      await deliverOutbox(pool);
      assert.equal((await pool.query(`SELECT n.id FROM notifications n
        WHERE n.type='trial_completed' AND n.user_id=$1`, [ids.outsider])).rowCount, 1);
    });
    await t.test('performance fee fixture: deposits cause no fee and profit produces exact dilution', async () => {
      // Settle the earlier trial first so the Captain can start a new record.
      await seed();
      assert.equal(await completeTrial(pool, fundId), true);
      fundId = (await request('POST', '/v0/funds', 'captain', { name: 'Performance Trial' }, randomUUID(), 201)).id;
      await request('POST', route('/joins'), 'crew', { amountUsdc: '100' }, randomUUID(), 201);
      assert.equal(await inTransaction(pool, c => assessFundFee(c, fundId, '2026-10-01')), false);
      const id = await order('BUY', '100'); await settled(id, '100');
      await seed('300'); await markActiveFunds(pool);
      const before = (await request('GET', route('/performance'))).current;
      const nav = new Amount(before.navUsdc);
      const expected = nav.minus('1100').mul('0.10').toDecimalPlaces(6, Amount.ROUND_DOWN);
      const results = await Promise.all(Array.from({ length: 8 }, () => inTransaction(pool, c => assessFundFee(c, fundId, '2026-10-01'))));
      assert.equal(results.filter(Boolean).length, 1);
      const fee = (await pool.query('SELECT * FROM fee_assessments WHERE fund_id=$1', [fundId])).rows[0];
      assert.ok(new Amount(fee.fee_usdc).eq(expected));
      assert.ok(new Amount(fee.captain_shares).plus(fee.protocol_shares).eq(fee.shares_minted));
      const after = (await request('GET', route('/performance'))).current;
      assert.ok(new Amount(after.navUsdc).eq(nav));
      assert.ok(new Amount(after.sharePriceUsdc).lt(before.sharePriceUsdc));
      assert.ok(new Amount(after.sinceInception.grossReturnPercent).gt(after.sinceInception.netReturnPercent));
      await reconcile();
    });
    await t.test('loss and recovery below the high-water mark charge no further fee', async () => {
      await seed('100'); await markActiveFunds(pool);
      assert.equal(await inTransaction(pool, c => assessFundFee(c, fundId, '2026-10-02')), false);
      await seed('200'); await markActiveFunds(pool);
      assert.equal(await inTransaction(pool, c => assessFundFee(c, fundId, '2026-10-02')), false);
      await seed('400'); await markActiveFunds(pool);
      assert.equal(await inTransaction(pool, c => assessFundFee(c, fundId, '2026-10-02')), true);
      assert.equal((await pool.query('SELECT * FROM fee_assessments WHERE fund_id=$1', [fundId])).rowCount, 2);
      await reconcile();
    });
    await t.test('fees racing Crew deposits serialize and pending orders cannot survive completion', async () => {
      await seed('500'); await markActiveFunds(pool);
      const results = await Promise.all([
        inTransaction(pool, c => assessFundFee(c, fundId, '2026-10-03')),
        request('POST', route('/joins'), 'crew', { amountUsdc: '10' }, randomUUID(), 201),
      ]);
      assert.equal(results[0], true);
      await reconcile();
      settlementPendingOrder = await order('BUY', '1');
      await ageOrder(settlementPendingOrder);
    });
    await t.test('API performance periods and fee totals match persisted valuations and assessments', async () => {
      const snapshots = (await pool.query(`SELECT id,event_sequence,share_price_usdc::text,performance_fee_factor::text
        FROM nav_snapshots WHERE fund_id=$1 ORDER BY event_sequence`, [fundId])).rows;
      assert.ok(snapshots.length >= 3);
      const midIndex = Math.floor(snapshots.length / 2), mid = snapshots[midIndex], first = snapshots[0], last = snapshots.at(-1);
      // Simulate a month of recorded history without changing its financial values.
      await pool.query(`UPDATE nav_snapshots SET created_at=now()-interval '1 day' WHERE fund_id=$1`, [fundId]);
      await pool.query(`UPDATE nav_snapshots SET created_at=now()-interval '9 days' WHERE id=ANY($1::uuid[])`, [snapshots.slice(1, midIndex).map(x => x.id)]);
      await pool.query(`UPDATE nav_snapshots SET created_at=now()-interval '31 days' WHERE id=$1`, [first.id]);
      await pool.query(`UPDATE nav_snapshots SET created_at=now()-interval '8 days' WHERE id=$1`, [mid.id]);
      const result = await request('GET', route('/performance'));
      const expected = base => new Amount(last.share_price_usdc).div(base.share_price_usdc).minus(1).mul(100);
      assert.ok(new Amount(result.current.period7d.netReturnPercent).minus(expected(mid)).abs().lt('0.000000000000001'));
      assert.ok(new Amount(result.current.period30d.netReturnPercent).minus(expected(first)).abs().lt('0.000000000000001'));
      assert.ok(new Amount(result.current.sinceInception.netReturnPercent).minus(expected(first)).abs().lt('0.000000000000001'));
      const aggregate = (await pool.query(`SELECT SUM(fee_usdc)::text AS total,COUNT(*)::int AS count,
        SUM(captain_shares)::text AS captain,SUM(protocol_shares)::text AS protocol FROM fee_assessments WHERE fund_id=$1`, [fundId])).rows[0];
      assert.ok(new Amount(result.fees.performanceFeeUsdc).eq(aggregate.total));
      assert.equal(result.fees.assessmentCount, aggregate.count);
      assert.ok(new Amount(result.fees.captainFeeShares).eq(aggregate.captain));
      assert.ok(new Amount(result.fees.protocolFeeShares).eq(aggregate.protocol));
      const counts = (await pool.query('SELECT COUNT(*)::int AS count FROM orders WHERE fund_id=$1', [fundId])).rows[0].count;
      assert.equal(Object.values(result.orders).reduce((sum, value) => sum + value, 0), counts);
      assert.equal(result.mode, 'PAPER');
      await reconcile();
    });
    await t.test('performance history recovers every valuation with numeric cursors and exact gross prices', async () => {
      const points = []; let after = '0';
      for (;;) {
        const page = await request('GET', route(`/history?after=${after}&limit=2`));
        points.push(...page.points);
        if (!page.nextCursor) break;
        assert.ok(BigInt(page.nextCursor) > BigInt(after)); after = page.nextCursor;
      }
      const stored = (await pool.query(`SELECT event_sequence::text AS sequence,nav_usdc::text,share_price_usdc::text,
        performance_fee_factor::text FROM nav_snapshots WHERE fund_id=$1 ORDER BY event_sequence`, [fundId])).rows;
      assert.deepEqual(points.map(x => x.sequence), stored.map(x => x.sequence));
      for (let i = 0; i < points.length; i++) {
        assert.ok(new Amount(points[i].navUsdc).eq(stored[i].nav_usdc));
        assert.ok(new Amount(points[i].sharePriceUsdc).eq(stored[i].share_price_usdc));
        assert.ok(new Amount(points[i].grossSharePriceUsdc).minus(new Amount(stored[i].share_price_usdc).mul(stored[i].performance_fee_factor)).abs().lt('0.000000000000000002'));
      }
      assert.equal(new Set(points.map(x => x.sequence)).size, points.length);
      for (const query of ['limit=0','limit=101','after=-1','after=1.5','after=9223372036854775808','unexpected=1']) {
        await request('GET', route(`/history?${query}`), undefined, undefined, undefined, 400);
      }
    });
    await t.test('stale prices suppress current returns and defer expired settlement', async () => {
      await clearPrices();
      await pool.query("UPDATE nav_snapshots SET priced_at=now()-interval '5 minutes' WHERE fund_id=$1", [fundId]);
      await markActiveFunds(pool);
      const perf = await request('GET', route('/performance'));
      assert.equal(perf.current, null);
      assert.equal(perf.valuationStatus, 'UNAVAILABLE');
      await pool.query("UPDATE trials SET starts_at=now()-interval '31 days',ends_at=now()-interval '1 day' WHERE fund_id=$1", [fundId]);
      assert.equal(await completeTrial(pool, fundId), false);
      assert.equal((await pool.query('SELECT status FROM funds WHERE id=$1', [fundId])).rows[0].status, 'ACTIVE');
    });
    await t.test('settlement failure rolls back liquidation, fees and payouts; retry settles exactly once', async () => {
      await seed('450');
      const before = (await pool.query('SELECT cash_usdc,total_shares FROM funds WHERE id=$1', [fundId])).rows[0];
      const balances = (await pool.query('SELECT id,paper_cash FROM users ORDER BY id')).rows;
      await pool.query(`CREATE FUNCTION fail_completion() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.type='trial_completed' THEN RAISE EXCEPTION 'simulated settlement failure'; END IF; RETURN NEW; END $$`);
      await pool.query('CREATE TRIGGER fail_completion BEFORE INSERT ON fund_events FOR EACH ROW EXECUTE FUNCTION fail_completion()');
      await assert.rejects(completeTrial(pool, fundId), /simulated settlement failure/);
      assert.deepEqual((await pool.query('SELECT cash_usdc,total_shares FROM funds WHERE id=$1', [fundId])).rows[0], before);
      assert.deepEqual((await pool.query('SELECT id,paper_cash FROM users ORDER BY id')).rows, balances);
      await reconcile();
      await pool.query('DROP TRIGGER fail_completion ON fund_events');
      const results = await Promise.all(Array.from({ length: 6 }, () => completeTrial(pool, fundId)));
      assert.equal(results.filter(Boolean).length, 1);
      assert.equal((await pool.query("SELECT id FROM fund_events WHERE fund_id=$1 AND type='trial_completed'", [fundId])).rowCount, 1);
      assert.equal((await pool.query('SELECT * FROM positions WHERE fund_id=$1 AND quantity<>0', [fundId])).rowCount, 0);
      assert.equal(await processOrder(pool, settlementPendingOrder), true);
      assert.equal((await request('GET', route(`/orders/${settlementPendingOrder}`))).order.reject_reason, 'fund_not_tradable');
      await reconcile();
    });
    await t.test('final records preserve returns and personal realized P&L', async () => {
      const perf = await request('GET', route('/performance'));
      assert.equal(perf.valuationStatus, 'FINAL');
      assert.ok(new Amount(perf.current.sinceInception.netReturnPercent).gt(0));
      const personal = await request('GET', `/v0/me/funds/${fundId}/performance`, 'crew');
      assert.ok(new Amount(personal.contributionsUsdc).eq('110'));
      assert.ok(new Amount(personal.currentValueUsdc).eq('0'));
      assert.ok(new Amount(personal.withdrawalsUsdc).minus(personal.contributionsUsdc).eq(personal.pnlUsdc));
      assert.ok(new Amount(personal.pnlUsdc).gt(0));
      const personalRecords = await request('GET', '/v0/me/paper-record', 'crew');
      const savedRecord = personalRecords.records.find(x => x.fund.fundId === fundId);
      assert.equal(savedRecord.fund.valuationStatus, 'FINAL');
      assert.deepEqual(savedRecord.personal, personal);
      await request('GET', '/v0/me/paper-record', undefined, undefined, undefined, 401);
      const outsiderRecords = await request('GET', '/v0/me/paper-record', 'outsider');
      assert.ok(outsiderRecords.records.every(x => x.fund.fundId !== fundId));
      const records = await request('GET', `/v0/captains/${ids.captain}/paper-record`);
      assert.equal(records.records.filter(x => x.status === 'COMPLETED').length, 2);
      assert.ok(records.records.every(x => x.valuationStatus === 'FINAL'));
      await request('POST', '/v0/funds', 'captain', { name: 'Next Trial' }, randomUUID(), 201);
    });
    await t.test('rankings disclose method and include only eligible valued records in return order', async () => {
      const rankings = await request('GET', '/v0/funds/rankings');
      assert.equal(rankings.mode, 'PAPER');
      assert.equal(rankings.rankingMethod, 'SINCE_INCEPTION_NET_RETURN');
      assert.equal(rankings.minimumAgeDays, 7);
      assert.match(rankings.disclaimer, /Not risk-adjusted/);
      assert.ok(rankings.funds.some(x => x.fundId === fundId && x.valuationStatus === 'FINAL'));
      for (let i = 0; i < rankings.funds.length; i++) {
        const fund = rankings.funds[i];
        assert.equal(fund.rank, i + 1); assert.ok(fund.trial.elapsedDays >= 7); assert.ok(fund.current);
        if (i > 0) assert.ok(new Amount(rankings.funds[i - 1].current.sinceInception.netReturnPercent).gte(fund.current.sinceInception.netReturnPercent));
      }
      const newTrial = (await pool.query(`SELECT id FROM funds WHERE captain_id=$1 AND status='ACTIVE'`, [ids.captain])).rows[0].id;
      assert.ok(rankings.funds.every(x => x.fundId !== newTrial));
    });
    await t.test('performance APIs reject invalid or absent funds without leaking private records', async () => {
      for (const suffix of ['performance','history']) {
        await request('GET', `/v0/funds/not-a-uuid/${suffix}`, undefined, undefined, undefined, 400);
        await request('GET', `/v0/funds/${randomUUID()}/${suffix}`, undefined, undefined, undefined, 404);
      }
      await request('GET', `/v0/me/funds/${fundId}/performance`, undefined, undefined, undefined, 401);
      await request('GET', `/v0/captains/${randomUUID()}/paper-record`, undefined, undefined, undefined, 404);
      const personal = await request('GET', `/v0/me/funds/${fundId}/performance`, 'outsider');
      assert.ok(new Amount(personal.contributionsUsdc).eq(0));
      assert.ok(new Amount(personal.withdrawalsUsdc).eq(0));
      assert.ok(new Amount(personal.currentValueUsdc).eq(0));
      assert.equal(personal.pnlPercentOfContributions, null);
    });
    await t.test('worker valuation fee and expiry sweeps reach funds beyond a 100-fund batch', async () => {
      const funds = [];
      for (let i = 0; i < 101; i++) {
        const subject = `batch_${i}`;
        await request('POST', '/v0/captains', subject, { handle: subject }, undefined, 201);
        const fund = await request('POST', '/v0/funds', subject, { name: `Batch fund ${i}` }, randomUUID(), 201);
        funds.push(fund.id);
        await seed('100');
        const order = await request('POST', `/v0/funds/${fund.id}/orders`, subject, { side: 'BUY', instrumentId: 'SOL', notionalUsdc: '50' }, randomUUID(), 202);
        await ageOrder(order.orderId); await seed('100'); await processOrder(pool, order.orderId);
      }
      const observation = await seed('200');
      await markActiveFunds(pool);
      const marked = await pool.query(`SELECT fund_id FROM nav_snapshots WHERE fund_id=ANY($1::uuid[]) AND observation_id=$2`, [funds, observation]);
      assert.equal(marked.rowCount, 101, 'Every exposed fund must reach the latest observation');
      await assessDailyFees(pool);
      const assessed = await pool.query(`SELECT DISTINCT fund_id FROM fee_assessments WHERE fund_id=ANY($1::uuid[])`, [funds]);
      assert.equal(assessed.rowCount, 101, 'Every eligible profitable fund must be assessed');
      await reconcile();
      await pool.query(`UPDATE trials SET starts_at=now()-interval '31 days',ends_at=now()-interval '1 day'
        WHERE fund_id=ANY($1::uuid[])`, [funds]);
      assert.equal(await completeExpiredTrials(pool), 101);
      const completed = await pool.query(`SELECT id FROM funds WHERE id=ANY($1::uuid[]) AND status='COMPLETED'`, [funds]);
      assert.equal(completed.rowCount, 101, 'Every expired fund must settle');
      assert.equal(await completeExpiredTrials(pool), 0, 'Repeating the sweep must not pay out twice');
      await reconcile();
    });
    await t.test('final ledger/projection reconciliation', reconcile);
  } finally {
    globalThis.fetch = originalFetch;
    await app.close();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
