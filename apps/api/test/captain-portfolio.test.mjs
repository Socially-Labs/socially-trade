import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';
import { configurePrivyFixture } from './privy-fixture.mjs';
import { refreshCaptainDiscovery } from '../../../packages/db/dist/index.js';
import { compactDiscoveryPoints } from '../../../packages/db/dist/captain-discovery.js';
import { seedDiscoveryDemo, demoCaptains } from '../../../scripts/seed-discovery-demo.mjs';
import { advanceVaultRound } from '../../worker/dist/vault-rounds.js';
import { reconcileFund, reconcilePaperUser } from '../../worker/dist/reconciliation.js';
import { createApp } from '../dist/app.js';

test('Captain portfolio projects cash-flow-adjusted aggregate investment performance', { timeout: 120000 }, async t => {
  const connectionString = process.env.TEST_DATABASE_URL;
  assert.ok(connectionString, 'TEST_DATABASE_URL is required');
  assert.match(new URL(connectionString).hostname, /^(localhost|127\.0\.0\.1|\[::1\])$/);
  process.env.VAULT_PAPER_ENABLED = 'true';
  process.env.VAULT_TERMS_APPROVAL = 'locked-v1-retain-residue';
  process.env.NODE_ENV = 'development';
  process.env.PAPER_WALLET_SNAPSHOT_ENABLED = 'false';
  process.env.PAPER_TEST_SKIP_FUNDRAISING = 'false';
  delete process.env.USDG_MINT;
  const tokenFor = configurePrivyFixture();
  const schema = `portfolio_test_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ connectionString, options: `-c search_path=${schema}`, max: 8 });
  const app = createApp(pool); app.log.level = 'silent';
  async function call(method, url, subject, body, status = 200) {
    const r = await app.inject({ method, url, payload: body, headers: {
      ...(subject ? { authorization: `Bearer ${tokenFor(subject)}` } : {}),
      ...(method === 'POST' ? { 'idempotency-key': randomUUID() } : {}),
    } });
    assert.equal(r.statusCode, status, `${method} ${url}: ${r.body}`);
    return r.json();
  }
  const portfolio = (subject = 'captain', range = 'ALL') => call('GET', `/v1/me/captain/portfolio?range=${range}`, subject);
  async function create(subject, name) {
    return (await call('POST', '/v1/vaults', subject, { name, description: 'Portfolio test', fundingWindowHours: 72, durationDays: 7, termsVersion: 1 }, 201)).vaultId;
  }
  async function mark(id, nav, options = {}) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const seq = (await client.query('UPDATE funds SET event_sequence=event_sequence+1 WHERE id=$1 RETURNING event_sequence,total_shares', [id])).rows[0];
      await client.query(`INSERT INTO nav_snapshots(id,fund_id,nav_usdc,share_price_usdc,status,priced_at,event_sequence,created_at)
        VALUES($1,$2,$3,CASE WHEN $3::numeric IS NULL THEN NULL ELSE $3::numeric/$7::numeric END,$4,clock_timestamp()-$5::interval,$6,clock_timestamp())`,
      [randomUUID(), id, nav, nav == null ? 'UNAVAILABLE' : 'CURRENT', options.age ?? '0 seconds', seq.event_sequence, seq.total_shares]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
  let captain, a, b;
  try {
    const dir = new URL('../../../packages/db/migrations/', import.meta.url);
    for (const file of (await readdir(dir)).filter(f => f.endsWith('.sql')).sort()) await pool.query(await readFile(new URL(file, dir), 'utf8'));
    await t.test('private scope, validation and empty state', async () => {
      await call('GET', '/v1/me/captain/portfolio', null, undefined, 401);
      await call('GET', '/v1/me/captain/portfolio/vaults', 'crew', undefined, 403);
      captain = await call('POST', '/v0/me/onboarding', 'captain', { username: 'portfolio_captain', role: 'captain' });
      await call('POST', '/v0/me/onboarding', 'other', { username: 'portfolio_other', role: 'captain' });
      const p = await portfolio();
      assert.equal(p.aumUsdc, '0.000000'); assert.equal(p.netPnlUsdc, '0.000000');
      assert.equal(p.netReturnPercent, null); assert.equal(p.coverage, 'UNAVAILABLE'); assert.deepEqual(p.points, []);
      await call('GET', '/v1/me/captain/portfolio?range=1D', 'captain', undefined, 400);
      await call('GET', '/v1/me/captain/portfolio/vaults?limit=51', 'captain', undefined, 400);
    });
    await t.test('seed, contributions and cancellation never generate P&L', async () => {
      a = await create('captain', 'Black Pearl');
      let p = await portfolio(); assert.equal(p.aumUsdc, '100.000000'); assert.equal(p.netReturnPercent, '0.000000');
      const terms = (await call('GET', `/v1/vaults/${a}`)).termsHash;
      await call('POST', `/v1/vaults/${a}/contributions`, 'crew', { amountUsdc: '50.000001', termsHash: terms }, 201);
      p = await portfolio(); assert.equal(p.aumUsdc, '150.000001'); assert.equal(p.netPnlUsdc, '0.000000'); assert.equal(p.netReturnPercent, '0.000000');
      await call('POST', `/v1/vaults/${a}/contribution-cancellations`, 'crew', {});
      p = await portfolio(); assert.equal(p.aumUsdc, '100.000000'); assert.equal(p.netPnlUsdc, '0.000000'); assert.equal(p.netReturnPercent, '0.000000');
      await call('POST', `/v1/vaults/${a}/contributions`, 'crew', { amountUsdc: '900', termsHash: terms }, 201);
      assert.equal((await portfolio()).aumUsdc, '1000.000000');
    });
    await t.test('unequal concurrent vaults are weighted by actual capital', async () => {
      // Disposable fixture only: retain production's one-open-vault restriction.
      await pool.query("UPDATE funds SET status='COMPLETED' WHERE id=$1", [a]);
      b = await create('captain', 'North Star');
      await mark(a, '1100'); await mark(b, '90');
      const p = await portfolio();
      assert.equal(p.aumUsdc, '1190.000000'); assert.equal(p.netPnlUsdc, '90.000000');
      assert.equal(p.netFlowsUsdc, '1100.000000');
      assert.equal(p.netReturnPercent, '8.181818'); assert.equal(p.openVaultPnlUsdc, '90.000000');
      assert.equal(p.settledVaultPnlUsdc, '0.000000'); assert.equal(p.totalVaults, 2);
      assert.equal(p.points.at(-1).netPnlUsdc, p.netPnlUsdc);
      assert.equal(p.points.at(-1).netReturnPercent, p.netReturnPercent);
      assert.equal((await portfolio('other')).aumUsdc, '0.000000');
      const first = await call('GET', '/v1/me/captain/portfolio/vaults?range=ALL&limit=1', 'captain');
      assert.equal(first.vaults.length, 1); assert.ok(first.nextCursor); assert.equal(first.revision, p.revision);
      const second = await call('GET', `/v1/me/captain/portfolio/vaults?range=ALL&limit=1&after=${first.nextCursor}`, 'captain');
      assert.equal(second.vaults.length, 1); assert.equal(second.nextCursor, null);
      assert.notEqual(first.vaults[0].vaultId, second.vaults[0].vaultId);
      const all = [...first.vaults, ...second.vaults];
      assert.equal(all.find(v => v.vaultId === a).netReturnPercent, '10.000000');
      assert.equal(all.find(v => v.vaultId === b).netReturnPercent, '-10.000000');
      assert.deepEqual((await call('GET', '/v1/me/captain/portfolio/vaults', 'other')).vaults, []);
    });
    await t.test('final net distribution exits AUM once and retains historical profit', async () => {
      await pool.query('ALTER TABLE vault_rounds DISABLE TRIGGER vault_terms_immutable');
      await pool.query(`UPDATE vault_rounds SET phase='COMPLETED',finalized_at=clock_timestamp(),final_supply=1000,
        final_assets_usdc=1100,distribution_pool_usdc=1090,captain_fee_usdc=10,residue_liability_usdc=0 WHERE fund_id=$1`, [a]);
      await pool.query('ALTER TABLE vault_rounds ENABLE TRIGGER vault_terms_immutable');
      await mark(a, '1090');
      let p = await portfolio();
      assert.equal(p.aumUsdc, '90.000000'); assert.equal(p.netPnlUsdc, '80.000000');
      assert.equal(p.netFlowsUsdc, '10.000000');
      assert.equal(p.settledVaultPnlUsdc, '90.000000'); assert.equal(p.openVaultPnlUsdc, '-10.000000');
      assert.equal(p.netReturnPercent, '7.272727');
      const revision = p.revision;
      // Claim changes the fund cash only; final investment economics are immutable.
      await pool.query('UPDATE funds SET cash_usdc=0,total_shares=0 WHERE id=$1', [a]);
      p = await portfolio(); assert.equal(p.netPnlUsdc, '80.000000'); assert.equal(p.revision, revision);
      for (const range of ['7D', '30D', '90D', 'ALL']) {
        p = await portfolio('captain', range); assert.equal(p.netPnlUsdc, '80.000000'); assert.ok(p.points.length <= 401);
      }
    });
    await t.test('unknown valuations break returns; recovery never bridges the gap', async () => {
      const before = await portfolio();
      await mark(b, null);
      let p = await portfolio();
      assert.equal(p.aumUsdc, null); assert.equal(p.netPnlUsdc, null); assert.equal(p.netReturnPercent, null);
      assert.equal(p.valuationStatus, 'PARTIAL'); assert.equal(p.points.at(-1).hasGap, true);
      await mark(b, '95'); p = await portfolio();
      assert.equal(p.aumUsdc, '95.000000'); assert.equal(p.netPnlUsdc, '85.000000');
      assert.equal(p.netReturnPercent, null); assert.notEqual(p.points.at(-1).segment, before.points.at(-1).segment);
      assert.equal(p.points.at(-1).hasGap, true); assert.equal(p.coverage, 'PARTIAL');
    });
    await t.test('stale holdings never masquerade as current zero balances', async () => {
      const instrument = (await pool.query('SELECT id FROM instruments LIMIT 1')).rows[0].id;
      await pool.query('INSERT INTO positions(fund_id,instrument_id,quantity,cost_basis_usdc) VALUES($1,$2,1,50)', [b, instrument]);
      await mark(b, '95', { age: '2 minutes' });
      const p = await portfolio(); assert.equal(p.aumUsdc, null); assert.equal(p.netReturnPercent, null);
      const rows = (await call('GET', '/v1/me/captain/portfolio/vaults?range=ALL', 'captain')).vaults;
      assert.equal(rows.find(v => v.vaultId === b).valuationStatus, 'UNAVAILABLE');
      await mark(b, '95');
      await pool.query("UPDATE vault_portfolio_state SET priced_at=clock_timestamp()-interval '2 minutes' WHERE fund_id=$1", [b]);
      await pool.query("UPDATE nav_snapshots SET priced_at=clock_timestamp()-interval '2 minutes' WHERE id=(SELECT snapshot_id FROM vault_portfolio_state WHERE fund_id=$1)", [b]);
      const stale = (await call('GET', '/v1/me/captain/portfolio/vaults?range=ALL', 'captain')).vaults.find(v => v.vaultId === b);
      assert.equal(stale.valuationStatus, 'STALE'); assert.equal(stale.aumUsdc, null);
      assert.equal((await portfolio()).netReturnPercent, null);
    });
    await t.test('capture is idempotent and out-of-order snapshots cannot rewind the projection', async () => {
      const state = (await pool.query('SELECT * FROM vault_portfolio_state WHERE fund_id=$1', [b])).rows[0];
      const revision = (await portfolio()).revision;
      await pool.query('SELECT capture_captain_portfolio($1)', [state.snapshot_id]);
      const old = (await pool.query('SELECT id FROM nav_snapshots WHERE fund_id=$1 ORDER BY event_sequence LIMIT 1', [b])).rows[0].id;
      await pool.query('SELECT capture_captain_portfolio($1)', [old]);
      assert.equal((await portfolio()).revision, revision);
    });
    await t.test('exact period baseline survives downsampling and historical replay', async () => {
      const historyCaptain = await call('POST', '/v0/me/onboarding', 'history', { username: 'portfolio_history', role: 'captain' });
      const id = await create('history', 'Historical vault');
      const terms = (await call('GET', `/v1/vaults/${id}`)).termsHash;
      await call('POST', `/v1/vaults/${id}/contributions`, 'history-crew', { amountUsdc: '50', termsHash: terms }, 201);
      await call('POST', `/v1/vaults/${id}/contribution-cancellations`, 'history-crew', {});
      await mark(id, '120'); await mark(id, '130'); await mark(id, '140');
      const snapshots = (await pool.query('SELECT id FROM nav_snapshots WHERE fund_id=$1 ORDER BY event_sequence', [id])).rows;
      const days = [10, 9, 8.5, 8, 6, 0];
      for (let i = 0; i < snapshots.length; i++) await pool.query(`UPDATE nav_snapshots SET
        created_at=clock_timestamp()-$2::numeric*interval '1 day',priced_at=clock_timestamp()-$2::numeric*interval '1 day' WHERE id=$1`, [snapshots[i].id, days[i]]);
      await pool.query('ALTER TABLE vault_rounds DISABLE TRIGGER vault_terms_immutable');
      await pool.query(`UPDATE vault_rounds SET funding_started_at=funding_started_at-interval '11 days',
        funding_closes_at=funding_closes_at-interval '11 days',trading_ends_at=trading_ends_at-interval '11 days' WHERE fund_id=$1`, [id]);
      await pool.query('ALTER TABLE vault_rounds ENABLE TRIGGER vault_terms_immutable');
      async function replay() {
        await pool.query('DELETE FROM captain_portfolio_observations WHERE captain_id=$1', [historyCaptain.id]);
        await pool.query('DELETE FROM captain_portfolio_rollups WHERE captain_id=$1', [historyCaptain.id]);
        await pool.query('DELETE FROM vault_portfolio_state WHERE captain_id=$1', [historyCaptain.id]);
        await pool.query('DELETE FROM captain_portfolio_state WHERE captain_id=$1', [historyCaptain.id]);
        for (const snapshot of snapshots) await pool.query('SELECT capture_captain_portfolio($1,true)', [snapshot.id]);
      }
      await replay();
      let p = await portfolio('history', '7D');
      assert.equal(p.netPnlUsdc, '20.000000'); assert.equal(p.netReturnPercent, '16.666666');
      assert.equal(p.points.at(-1).netPnlUsdc, p.netPnlUsdc);
      assert.equal(p.points.at(-1).netReturnPercent, p.netReturnPercent);
      assert.ok(Date.parse(p.baselineAt) < Date.parse(p.requestedFrom));
      const vault = (await call('GET', '/v1/me/captain/portfolio/vaults?range=7D', 'history')).vaults[0];
      assert.equal(vault.netPnlUsdc, p.netPnlUsdc); assert.equal(vault.netReturnPercent, p.netReturnPercent);
      p = await portfolio('history', 'ALL'); assert.equal(p.netPnlUsdc, '40.000000'); assert.equal(p.netReturnPercent, '40.000000');
      await replay();
      const again = await portfolio('history', 'ALL'); assert.equal(again.netPnlUsdc, p.netPnlUsdc); assert.equal(again.netReturnPercent, p.netReturnPercent);
      // Dollar P&L recovers from endpoints; return across a missing baseline does not.
      await pool.query(`UPDATE captain_portfolio_observations SET source_fund_pnl_usdc=NULL,cumulative_pnl_usdc=NULL,index_value=NULL
        WHERE source_fund_id=$1 AND revision=(SELECT revision FROM captain_portfolio_observations
          WHERE source_fund_id=$1 AND recorded_at<=clock_timestamp()-interval '7 days' ORDER BY recorded_at DESC,revision DESC LIMIT 1)`, [id]);
      p = await portfolio('history', '7D'); assert.equal(p.netPnlUsdc, null); assert.equal(p.netReturnPercent, null);
    });
    await t.test('a total loss retains its evidence and fresh capital starts a new comparable segment', async () => {
      await call('POST', '/v0/me/onboarding', 'loss', { username: 'portfolio_loss', role: 'captain' });
      const id = await create('loss', 'Lost vault');
      await mark(id, '0'); let p = await portfolio('loss');
      assert.equal(p.netPnlUsdc, '-100.000000'); assert.equal(p.netReturnPercent, '-100.000000');
      await pool.query('ALTER TABLE vault_rounds DISABLE TRIGGER vault_terms_immutable');
      await pool.query(`UPDATE vault_rounds SET phase='COMPLETED',finalized_at=clock_timestamp(),final_supply=100,
        final_assets_usdc=0,distribution_pool_usdc=0,captain_fee_usdc=0,residue_liability_usdc=0 WHERE fund_id=$1`, [id]);
      await pool.query('ALTER TABLE vault_rounds ENABLE TRIGGER vault_terms_immutable');
      await mark(id, '0'); await pool.query("UPDATE funds SET status='COMPLETED' WHERE id=$1", [id]);
      const next = await create('loss', 'Fresh capital'); await mark(next, '110'); p = await portfolio('loss');
      assert.equal(p.netPnlUsdc, '-90.000000'); assert.equal(p.netReturnPercent, null);
      assert.equal(p.points.at(-1).segment, '1'); assert.equal(p.points.at(-1).indexValue, '110.000000000000000000');
    });
    await t.test('flows into one vault do not distort a peer gain and concurrent marks serialize', async () => {
      await call('POST', '/v0/me/onboarding', 'flows', { username: 'portfolio_flows', role: 'captain' });
      const first = await create('flows', 'Peer gain');
      const firstTerms = (await call('GET', `/v1/vaults/${first}`)).termsHash;
      await call('POST', `/v1/vaults/${first}/contributions`, 'flow-crew', { amountUsdc: '900', termsHash: firstTerms }, 201);
      await mark(first, '1100');
      await pool.query("UPDATE funds SET status='COMPLETED' WHERE id=$1", [first]);
      const second = await create('flows', 'Funding peer');
      const secondTerms = (await call('GET', `/v1/vaults/${second}`)).termsHash;
      await call('POST', `/v1/vaults/${second}/contributions`, 'flow-crew', { amountUsdc: '100', termsHash: secondTerms }, 201);
      let p = await portfolio('flows'); assert.equal(p.netPnlUsdc, '100.000000'); assert.equal(p.netReturnPercent, '10.000000');
      const revision = BigInt(p.revision);
      await Promise.all([mark(first, '1210'), mark(second, '200')]);
      p = await portfolio('flows'); assert.equal(BigInt(p.revision), revision + 2n);
      assert.equal(p.netPnlUsdc, '210.000000'); assert.equal(p.netReturnPercent, '19.307692');
      await call('POST', `/v1/vaults/${second}/contribution-cancellations`, 'flow-crew', {});
      p = await portfolio('flows'); assert.equal(p.netPnlUsdc, '210.000000'); assert.equal(p.netReturnPercent, '19.307692');
      assert.equal(p.netFlowsUsdc, '1100.000000');
    });
    await t.test('discovery projections share accounting, refresh on revisions, and expire safely', async () => {
      await refreshCaptainDiscovery(pool, 50);
      const list = await call('GET', '/v1/discover/captains?query=portfolio_flows');
      const card = list.captains[0];
      const direct = await portfolio('flows', '30D');
      assert.equal(card.aumUsdc, direct.aumUsdc);
      assert.equal(card.netReturnPercent, direct.netReturnPercent);
      assert.equal(card.performance.netPnlUsdc, direct.netPnlUsdc);
      assert.equal(card.performance.revision, direct.revision);
      assert.ok(card.performance.points.length <= 32);
      assert.equal(await refreshCaptainDiscovery(pool, 50), 0);
      const fund = (await pool.query('SELECT id FROM funds WHERE captain_id=$1 ORDER BY created_at DESC LIMIT 1', [card.id])).rows[0].id;
      await mark(fund, '105');
      assert.ok(await refreshCaptainDiscovery(pool, 50) > 0);
      const updated = (await call('GET', '/v1/discover/captains?query=portfolio_flows')).captains[0];
      assert.notEqual(updated.performance.revision, direct.revision);
      assert.equal(updated.netReturnPercent, (await portfolio('flows', '30D')).netReturnPercent);
      await pool.query("UPDATE captain_discovery_metrics SET computed_at=clock_timestamp()-interval '2 minutes' WHERE captain_id=$1", [card.id]);
      const stale = (await call('GET', '/v1/discover/captains?query=portfolio_flows')).captains[0];
      assert.equal(stale.aumUsdc, null); assert.equal(stale.netReturnPercent, null);
      assert.equal(stale.performance.valuationStatus, 'STALE');
      assert.ok(await refreshCaptainDiscovery(pool, 50) > 0);
      const fresh = (await call('GET', '/v1/discover/captains?query=portfolio_flows')).captains[0];
      assert.notEqual(fresh.aumUsdc, null);
      await call('POST', '/v0/me/onboarding', 'brand-new', { username: 'new_discovery_captain', role: 'captain' });
      const newCard = (await call('GET', '/v1/discover/captains?query=new_discovery_captain')).captains[0];
      assert.equal(newCard.performance, null); assert.equal(newCard.netReturnPercent, null);
      await refreshCaptainDiscovery(pool, 50);
      const newReady = (await call('GET', '/v1/discover/captains?query=new_discovery_captain')).captains[0];
      assert.equal(newReady.performance.coverage, 'UNAVAILABLE'); assert.equal(newReady.netReturnPercent, null);
      const points = Array.from({length: 401}, (_, i) => ({at: new Date(i * 1000).toISOString(),netPnlUsdc: '0',netReturnPercent: i === 47 ? null : '0',indexValue: '100',hasGap: i === 47,segment: i < 47 ? '0' : '1'}));
      const small = compactDiscoveryPoints(points);
      assert.ok(small.length <= 32); assert.equal(small[0], points[0]); assert.equal(small.at(-1), points.at(-1));
      assert.ok(small.includes(points[47])); assert.ok(small.includes(points[46]));
    });
    await t.test('public Crew discovery searches, ranks and exposes aggregate performance without private fields', async () => {
      const all = await call('GET', '/v1/discover/captains?limit=50&sort=AUM');
      assert.ok(all.captains.length >= 3);
      for (const c of all.captains) {
        assert.equal('earnings' in c, false); assert.equal('paperCash' in c, false);
        assert.equal('rank' in c, false); assert.equal('created_at' in c, false);
      }
      const search = await call('GET', '/v1/discover/captains?query=%40PORTFOLIO_CAPTAIN');
      assert.equal(search.captains.length, 1); assert.equal(search.captains[0].id, captain.id);
      const literal = await call('GET', '/v1/discover/captains?query=%25');
      assert.equal(literal.captains.length, 0);
      for (const sort of ['AUM','CREW','RETURN','RECENT']) {
        const first = await call('GET', `/v1/discover/captains?limit=1&sort=${sort}`);
        assert.ok(first.nextCursor);
        const second = await call('GET', `/v1/discover/captains?limit=1&sort=${sort}&after=${first.nextCursor}`);
        assert.notEqual(first.captains[0].id, second.captains[0].id);
      }
      const publicProfile = await call('GET', `/v1/discover/captains/${captain.id}?range=ALL`);
      const privatePortfolio = await portfolio();
      assert.equal(publicProfile.portfolio.netReturnPercent, privatePortfolio.netReturnPercent);
      assert.equal(publicProfile.portfolio.aumUsdc, privatePortfolio.aumUsdc);
      assert.equal('earnings' in publicProfile, false);
      assert.equal('paperCash' in publicProfile.captain, false);
      const vaults = await call('GET', `/v1/vaults?captainId=${captain.id}&query=BLACK`);
      assert.equal(vaults.vaults.length, 1); assert.equal(vaults.vaults[0].id, a);
      assert.equal(vaults.vaults[0].captainUsername, 'portfolio_captain');
      assert.equal((await call('GET', `/v1/vaults?captainId=${captain.id}&query=BLACK&phase=FUNDRAISING&durationGroup=long`)).vaults.length, 0);
      await call('GET', '/v1/discover/captains?sort=BAD', null, undefined, 400);
      await call('GET', `/v1/discover/captains/${captain.id}?range=1D`, null, undefined, 400);
    });
    await t.test('demo seed is idempotent, reconciles, and rejects real contributions', async () => {
      assert.equal((await seedDiscoveryDemo(pool)).status, 'created');
      assert.equal((await seedDiscoveryDemo(pool)).status, 'already present');
      const list=(await call('GET','/v1/discover/captains?query=demo_&limit=50')).captains;
      assert.equal(list.length,5);assert.ok(list.every(c=>c.isDemo));
      assert.ok(list.some(c=>Number(c.netReturnPercent)<0));assert.ok(list.some(c=>Number(c.netReturnPercent)>0));
      for(const c of demoCaptains){
        const reconciliation=await reconcileFund(pool,c.fundId);
        assert.equal(reconciliation.status,'HEALTHY',JSON.stringify(reconciliation));
        const user=await reconcilePaperUser(pool,c.captainId);assert.equal(user.status,'HEALTHY',JSON.stringify(user));
        const detail=await call('GET',`/v1/vaults/${c.fundId}`);assert.equal(detail.isDemo,true);
        assert.ok(Number(detail.acceptedCapitalUsdc)<=30000);
      }
      const funding=demoCaptains.at(-1),detail=await call('GET',`/v1/vaults/${funding.fundId}`);
      const rejected=await call('POST',`/v1/vaults/${funding.fundId}/contributions`,'crew',{amountUsdc:'50',termsHash:detail.termsHash},409);
      assert.match(rejected.message,/read-only demo/);
      // Even a due demo round remains read-only when a worker is called directly.
      await pool.query('ALTER TABLE vault_rounds DISABLE TRIGGER vault_terms_immutable');
      try {
        const close=new Date(Date.now()-86400000),start=new Date(close.getTime()-72*3600000),end=new Date(close.getTime()+90*86400000);
        await pool.query('UPDATE vault_rounds SET funding_started_at=$2,funding_closes_at=$3,trading_ends_at=$4 WHERE fund_id=$1',[funding.fundId,start,close,end]);
      }finally{await pool.query('ALTER TABLE vault_rounds ENABLE TRIGGER vault_terms_immutable');}
      assert.equal(await advanceVaultRound(pool,funding.fundId),false);
      assert.equal((await call('GET',`/v1/vaults/${funding.fundId}`)).phase,'FUNDRAISING');
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM discovery_demo_seeds')).rows[0].n,5);
    });
  } finally {
    await app.close(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
  }
});
