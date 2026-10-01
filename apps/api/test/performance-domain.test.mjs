import assert from 'node:assert/strict';
import test from 'node:test';
import { calculatePerformance, personalPerformance, returnPercent } from '../../../packages/domain/dist/index.js';
import { createApp } from '../dist/app.js';

const point = (day, sharePriceUsdc, performanceFeeFactor = '1', navUsdc = '1000') => ({
  sequence: String(day + 1), recordedAt: new Date(Date.UTC(2026, 0, day + 1)).toISOString(),
  pricedAt: new Date(Date.UTC(2026, 0, day + 1)).toISOString(),
  navUsdc, sharePriceUsdc, performanceFeeFactor,
});

test('cash flows do not masquerade as investment returns', () => {
  const result = calculatePerformance([point(0, '1'), point(1, '1', '1', '4000'), point(2, '1', '1', '500')], new Date('2026-01-03'));
  assert.equal(result.sinceInception.netReturnPercent, '0.000000000000000000');
  assert.equal(result.maxDrawdownPercent, '0.000000000000000000');
});

test('fee dilution separates net return from gross of performance fees', () => {
  const result = calculatePerformance([point(0, '1'), point(1, '1.08', '1.11111111111111111111111111111111111111111111111111111111111')], new Date('2026-01-02'));
  assert.equal(result.sinceInception.netReturnPercent, '8.000000000000000000');
  assert.match(result.sinceInception.grossReturnPercent, /^19\.999999999999999999$/);
});

test('drawdown uses unit prices through subscriptions and recovery', () => {
  const result = calculatePerformance([point(0, '1'), point(1, '1.25', '1', '2500'), point(2, '1'), point(3, '1.1')], new Date('2026-01-04'));
  assert.equal(result.maxDrawdownPercent, '20.000000000000000000');
  assert.equal(result.currentDrawdownPercent, '12.000000000000000000');
});

test('zero NAV preserves full loss and exact zero', () => {
  const result = calculatePerformance([point(0, '1'), point(1, '0', '1', '0')], new Date('2026-01-02'));
  assert.equal(result.sinceInception.netReturnPercent, '-100.000000000000000000');
  assert.equal(result.maxDrawdownPercent, '100.000000000000000000');
  assert.equal(returnPercent('1', '0'), null);
});

test('periods require actual baseline history and expose its time', () => {
  const now = new Date('2026-02-01T00:00:00Z');
  const result = calculatePerformance([point(0, '1'), point(23, '1.1'), point(31, '1.21')], now);
  assert.equal(result.period7d.baselineAt, point(23, '1.1').recordedAt);
  assert.equal(result.period7d.netReturnPercent, '10.000000000000000000');
  assert.equal(result.period30d.netReturnPercent, '21.000000000000000000');
  const short = calculatePerformance([point(30, '1'), point(31, '1.1')], now);
  assert.equal(short.period7d, null);
  assert.equal(short.period30d, null);
  assert.equal(calculatePerformance([], now), null);
});

test('personal returns reconcile partial and terminal redemptions', () => {
  assert.deepEqual(personalPerformance('100', '60', '50').pnlUsdc, '10.000000');
  assert.equal(personalPerformance('100', '110', '0').pnlPercentOfContributions, '10.000000000000000000');
  assert.equal(personalPerformance('100', '0', null).pnlUsdc, null);
  assert.equal(personalPerformance('0', '10', '5').pnlPercentOfContributions, null);
  assert.equal(personalPerformance('0', '10', '5').pnlUsdc, '15.000000');
});

test('large and tiny decimals avoid Number rounding', () => {
  assert.equal(returnPercent('100000000000000000000.1', '100000000000000000000'), '0.000000000000000000');
  assert.equal(personalPerformance('9007199254740993.000001', '9007199254740993.000003', '0').pnlUsdc, '0.000002');
});

// Exercise the public response contract independently of worker timing. PostgreSQL-backed
// simulations cover SQL, transactions and actual accounting mutations separately.
function responseFixture({ status = 'ACTIVE', hasPositions = false, snapshotStatus = 'CURRENT', finalNav = null,
  finalPrice = null, priceAgeMs = 120_000, latestPrice = '1.1', latestNav = '1100' } = {}) {
  const now = new Date();
  const old = new Date(now.getTime() - 32 * 86_400_000);
  const snapshots = [{ sequence: '1', recorded_at: old, priced_at: old, status: 'CURRENT', nav_usdc: '1000',
    share_price_usdc: '1', performance_fee_factor: '1' }, { sequence: '10', recorded_at: now,
    priced_at: new Date(now.getTime() - priceAgeMs), status: snapshotStatus, nav_usdc: latestNav,
    share_price_usdc: latestPrice, performance_fee_factor: '1.1' }];
  const fund = { id: '6f445efc-36d4-43e3-aee5-ef66d7fd9dd2', name: 'Trial', captain_id: 'captain', status,
    starts_at: old, ends_at: new Date(now.getTime() + 86_400_000), total_shares: status === 'COMPLETED' ? '0' : '1000',
    final_nav_usdc: finalNav, final_share_price_usdc: finalPrice, has_positions: hasPositions };
  const query = async (sql, args) => {
    if (/^(BEGIN|COMMIT|ROLLBACK|SET TRANSACTION)/.test(sql)) return { rows: [] };
    if (sql.includes('FROM funds f JOIN trials')) return { rows: [fund] };
    if (sql.includes('SELECT 1 FROM funds')) return { rows: [{}], rowCount: 1 };
    if (sql.includes('FROM nav_snapshots')) {
      assert.match(sql, /ORDER BY event_sequence ASC/);
      return { rows: sql.includes('event_sequence>') ? snapshots.filter((row) => BigInt(row.sequence) > BigInt(args[1])).slice(0, args[2]) : snapshots };
    }
    if (sql.includes('FROM orders WHERE')) return { rows: [{ status: 'FILLED', count: 2 }] };
    if (sql.includes('FROM fee_assessments')) return { rows: [{ total: '10', count: 1, last: old, captain_shares: '8', protocol_shares: '2' }] };
    if (sql.includes('FROM orders o JOIN fills')) return { rows: [{ fees: '0.02', filled_notional: '100' }] };
    assert.fail(`Unexpected fixture query: ${sql}`);
  };
  const app = createApp({ connect: async () => ({ query, release() {} }), query, end: async () => {} });
  app.log.level = 'silent';
  return { app, url: `/v0/funds/${fund.id}` };
}

test('response exposes fee terms and keeps historical performance when holdings are stale', async () => {
  const { app, url } = responseFixture({ hasPositions: true });
  try {
    const response = await app.inject({ method: 'GET', url: `${url}/performance` });
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json();
    assert.equal(body.valuationStatus, 'UNAVAILABLE');
    assert.equal(body.current, null);
    assert.equal(body.latestHistorical.sinceInception.netReturnPercent, '10.000000000000000000');
    assert.equal(body.latestHistorical.sinceInception.grossReturnPercent, '21.000000000000000000');
    assert.equal(body.fees.performanceFeePercent, '10');
    assert.equal(body.fees.captainShareOfFeePercent, '80');
    assert.equal(body.fees.protocolShareOfFeePercent, '20');
    assert.equal(body.fees.performanceFeeUsdc, '10');
    assert.equal(body.fees.captainFeeShares, '8');
    assert.equal(body.orders.filled, 2);
  } finally { await app.close(); }
});

test('cash-only funds remain valid and completed fund returns use final settlement value', async () => {
  const active = responseFixture();
  try {
    const response = await active.app.inject({ method: 'GET', url: `${active.url}/performance` });
    assert.equal(response.json().valuationStatus, 'CURRENT');
  } finally { await active.app.close(); }
  const completed = responseFixture({ status: 'COMPLETED', finalNav: '1200', finalPrice: '1.2', latestNav: '0', latestPrice: '0' });
  try {
    const response = await completed.app.inject({ method: 'GET', url: `${completed.url}/performance` });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().valuationStatus, 'FINAL');
    assert.equal(response.json().current.navUsdc, '1200');
    assert.equal(response.json().current.sinceInception.netReturnPercent, '20.000000000000000000');
  } finally { await completed.app.close(); }
});

test('history preserves explicit gaps, bigint cursors and pagination boundaries', async () => {
  const { app, url } = responseFixture({ snapshotStatus: 'UNAVAILABLE' });
  try {
    const first = await app.inject({ method: 'GET', url: `${url}/history?limit=1` });
    assert.equal(first.json().nextCursor, '1');
    const second = await app.inject({ method: 'GET', url: `${url}/history?after=1&limit=1` });
    assert.equal(second.json().nextCursor, null);
    assert.equal(second.json().points[0].sequence, '10');
    assert.equal(second.json().points[0].navUsdc, null);
    assert.equal(second.json().points[0].grossSharePriceUsdc, null);
    const bad = await app.inject({ method: 'GET', url: `${url}/history?after=9223372036854775808` });
    assert.equal(bad.statusCode, 400);
  } finally { await app.close(); }
});

test('future dated prices and empty CURRENT valuations never become current', async () => {
  for (const fixture of [{ hasPositions: true, priceAgeMs: -120_000 }, { latestNav: null }]) {
    const { app, url } = responseFixture(fixture);
    try {
      const response = await app.inject({ method: 'GET', url: `${url}/performance` });
      assert.equal(response.json().valuationStatus, 'UNAVAILABLE');
      assert.equal(response.json().current, null);
    } finally { await app.close(); }
  }
});
