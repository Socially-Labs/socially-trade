import type { DbClient } from './index.js';
import { Amount, fixed } from '@socially/domain';
import type { CaptainPortfolio, CaptainPortfolioRange, CaptainVaultPerformance } from '@socially/contracts';

const amount = (value: string | null | undefined) => value == null ? null : fixed(value, 6);
const iso = (value: Date | null | undefined) => value?.toISOString() ?? null;

// The same economic scope and boundary rules serve the card and its drilldown.
// Terminal distributions already include the final Captain fee. Claims do not
// alter either capital or final economic NAV and cannot count a payout twice.
const vaultPerformanceSql = `WITH performance AS (
 SELECT f.id,f.name,r.phase,r.finalized_at,s.priced_at,
   r.accepted_capital_usdc-CASE WHEN r.finalized_at IS NOT NULL THEN r.distribution_pool_usdc ELSE 0 END AS cumulative_flows,
   CASE WHEN r.finalized_at IS NOT NULL THEN 0 ELSE m.managed_usdc END AS aum,
   CASE WHEN r.finalized_at IS NOT NULL THEN 'CURRENT'
     WHEN m.managed_usdc IS NOT NULL THEN 'CURRENT'
     WHEN s.economic_nav_usdc IS NOT NULL AND s.has_exposure AND s.priced_at<$3::timestamptz-interval '90 seconds'
       AND r.phase NOT IN ('SETTLING','REFUNDING') THEN 'STALE' ELSE 'UNAVAILABLE' END AS status,
   CASE WHEN r.finalized_at IS NOT NULL THEN r.distribution_pool_usdc-r.accepted_capital_usdc
     WHEN m.managed_usdc IS NOT NULL THEN m.managed_usdc-r.accepted_capital_usdc ELSE NULL END AS lifetime_pnl,
   CASE WHEN $4::boolean OR r.funding_started_at>=$2::timestamptz THEN 0 ELSE baseline.source_fund_pnl_usdc END AS baseline_pnl,
   CASE WHEN $4::boolean OR r.funding_started_at>=$2::timestamptz THEN r.funding_started_at ELSE baseline.recorded_at END AS baseline_at,
   CASE WHEN $4::boolean OR r.funding_started_at>=$2::timestamptz THEN 1 ELSE baseline.source_unit_price END AS baseline_price,
   CASE WHEN r.finalized_at IS NOT NULL THEN r.distribution_pool_usdc/NULLIF(r.accepted_capital_usdc,0)
     WHEN m.managed_usdc IS NOT NULL THEN m.managed_usdc/NULLIF(r.accepted_capital_usdc,0) ELSE NULL END AS unit_price
 FROM funds f JOIN vault_rounds r ON r.fund_id=f.id
 JOIN captain_vault_metrics m ON m.id=f.id
 LEFT JOIN vault_portfolio_state s ON s.fund_id=f.id
 LEFT JOIN LATERAL(SELECT source_fund_pnl_usdc,source_unit_price,recorded_at FROM captain_portfolio_observations
   WHERE source_fund_id=f.id AND recorded_at<=$2::timestamptz ORDER BY recorded_at DESC,revision DESC LIMIT 1) baseline ON true
 WHERE f.captain_id=$1 AND f.round_model_version=2
), measured AS (SELECT *,lifetime_pnl-baseline_pnl AS period_pnl FROM performance)`;

async function boundary(client: DbClient, captainId: string, range: CaptainPortfolioRange) {
  const state = (await client.query('SELECT * FROM captain_portfolio_state WHERE captain_id=$1', [captainId])).rows[0];
  const now = (await client.query('SELECT transaction_timestamp() AS now')).rows[0]!.now as Date;
  const inception = state?.inception_at as Date | undefined;
  const start = range === 'ALL' ? inception ?? now : new Date(now.getTime() - parseInt(range) * 86400000);
  const startsAtInception = !!inception && inception >= start;
  const baseline = startsAtInception ? { index_value: '100', chain_id: '0', cumulative_pnl_usdc: '0', net_flows_usdc: '0', recorded_at: inception }
    : (await client.query(`SELECT index_value::text,chain_id::text,cumulative_pnl_usdc::text,net_flows_usdc::text,recorded_at
      FROM captain_portfolio_observations WHERE captain_id=$1 AND recorded_at<=$2 ORDER BY recorded_at DESC,revision DESC LIMIT 1`, [captainId, start])).rows[0];
  return { state, now, start, baseline };
}

export async function captainPortfolio(client: DbClient, captainId: string, range: CaptainPortfolioRange): Promise<CaptainPortfolio> {
  const { state, now, start, baseline } = await boundary(client, captainId, range);
  const summary = (await client.query(`${vaultPerformanceSql}
    SELECT count(*)::integer AS total,count(*) FILTER(WHERE phase='ACTIVE')::integer AS active,
      count(*) FILTER(WHERE finalized_at IS NULL)::integer AS open,
      count(*) FILTER(WHERE status='CURRENT')::integer AS current,
      count(*) FILTER(WHERE status='STALE')::integer AS stale,
      bool_or(aum IS NULL) AS missing_aum,bool_or(period_pnl IS NULL) AS missing_pnl,
      COALESCE(sum(aum),0)::text AS aum,COALESCE(sum(period_pnl),0)::text AS pnl,COALESCE(sum(cumulative_flows),0)::text AS flows,
      COALESCE(sum(period_pnl) FILTER(WHERE finalized_at IS NOT NULL),0)::text AS settled,
      COALESCE(sum(period_pnl) FILTER(WHERE finalized_at IS NULL),0)::text AS ongoing,
      min(priced_at) FILTER(WHERE finalized_at IS NULL) AS valuation_at
    FROM measured`, [captainId, start, now, range === 'ALL'])).rows[0]!;
  const interval = range === 'ALL' ? Math.max(86400, Math.ceil((now.getTime() - start.getTime()) / 86400000 / 400) * 86400)
    : range === '7D' ? 3600 : 86400;
  const source = range === '7D' ? 3600 : 86400;
  const rows = (await client.query(`SELECT DISTINCT ON(floor(extract(epoch FROM bucket_at)/$4))
      recorded_at,cumulative_pnl_usdc::text,index_value::text,chain_id::text,
      bool_or(has_gap) OVER(PARTITION BY floor(extract(epoch FROM bucket_at)/$4)) AS has_gap
    FROM captain_portfolio_rollups WHERE captain_id=$1 AND interval_seconds=$2 AND recorded_at>=$3 AND recorded_at<=transaction_timestamp()
    ORDER BY floor(extract(epoch FROM bucket_at)/$4),revision DESC LIMIT 401`, [captainId, source, start, interval])).rows;
  const percent = (index: string | null, chain: string) => index != null && baseline?.index_value != null
    && String(baseline.chain_id) === chain && new Amount(baseline.index_value).gt(0)
    ? fixed(new Amount(index).div(baseline.index_value).minus(1).mul(100), 6) : null;
  const status = summary.current === summary.total ? 'CURRENT' : summary.current > 0 ? 'PARTIAL'
    : summary.stale === summary.total ? 'STALE' : 'UNAVAILABLE';
  const current = status === 'CURRENT';
  const points = rows.map(row => ({ at: iso(row.recorded_at)!,
    netPnlUsdc: row.cumulative_pnl_usdc != null && baseline?.cumulative_pnl_usdc != null
      ? fixed(new Amount(row.cumulative_pnl_usdc).minus(baseline.cumulative_pnl_usdc), 6) : null,
    netReturnPercent: row.has_gap ? null : percent(row.index_value, row.chain_id), indexValue: row.index_value == null ? null : fixed(row.index_value, 18),
    hasGap: row.has_gap as boolean, segment: row.chain_id as string }));
  const netReturn = current && state ? percent(state.index_value, String(state.chain_id)) : null;
  return {
    schemaVersion: 1, mode: 'PAPER', method: 'AGGREGATE_NAV_TWR_V1', range,
    revision: state?.revision ?? '0', serverTime: now.toISOString(), asOf: iso(state?.recorded_at), valuationAsOf: iso(summary.valuation_at),
    requestedFrom: start.toISOString(), baselineAt: iso(baseline?.recorded_at), intervalSeconds: interval,
    valuationStatus: status, coverage: !state ? 'UNAVAILABLE' : current && baseline && netReturn != null && points.length >= 2 && !points.some(p => p.hasGap) ? 'COMPLETE' : 'PARTIAL',
    aumUsdc: summary.missing_aum ? null : amount(summary.aum),
    netPnlUsdc: summary.missing_pnl ? null : amount(summary.pnl),
    netFlowsUsdc: baseline ? fixed(new Amount(summary.flows).minus(baseline.net_flows_usdc), 6) : summary.total === 0 ? '0.000000' : null,
    netReturnPercent: netReturn,
    settledVaultPnlUsdc: summary.missing_pnl ? null : amount(summary.settled),
    openVaultPnlUsdc: summary.missing_pnl ? null : amount(summary.ongoing),
    activeVaults: summary.active, openVaults: summary.open, totalVaults: summary.total, points,
    methodology: 'Aggregate recorded NAV time-weighted return; external contributions and cancellations are excluded. Final net distributions exit AUM once and retain investment P&L; later claims have no performance effect. Trading costs and assessed final Captain fees are included, Captain fee income is separate. Open-vault and settled-vault P&L classify period gains by current lifecycle, not by trade realization. Historical boundary uses the last recorded mark at or before the requested start; baselineAt identifies that mark. Missing or stale peer valuations break the return chain; gaps are never interpolated.',
  };
}

export async function vaultPerformance(client: DbClient, captainId: string, range: CaptainPortfolioRange, after: string | null, limit: number) {
  const { state, now, start } = await boundary(client, captainId, range);
  const rows = (await client.query(`${vaultPerformanceSql}
    SELECT id,name,phase,aum::text,lifetime_pnl::text,period_pnl::text,status,priced_at,baseline_at,
      CASE WHEN baseline_price>0 THEN ((unit_price/baseline_price-1)*100)::text ELSE NULL END AS return_percent FROM measured
    WHERE ($5::uuid IS NULL OR id>$5) ORDER BY id LIMIT $6`, [captainId, start, now, range === 'ALL', after, limit + 1])).rows;
  const vaults: CaptainVaultPerformance[] = rows.slice(0, limit).map(row => ({ vaultId: row.id, name: row.name, phase: row.phase,
    aumUsdc: amount(row.aum), netPnlUsdc: amount(row.period_pnl), lifetimePnlUsdc: amount(row.lifetime_pnl),
    netReturnPercent: amount(row.return_percent), baselineAt: iso(row.baseline_at),
    valuationStatus: row.status, valuationAsOf: iso(row.priced_at) }));
  return { schemaVersion: 1, mode: 'PAPER', range, revision: state?.revision ?? '0', serverTime: now.toISOString(),
    asOf: iso(state?.recorded_at), vaults, nextCursor: rows.length > limit ? rows[limit - 1]!.id : null };
}

