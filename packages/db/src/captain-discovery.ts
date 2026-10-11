import { captainPortfolio } from './captain-portfolio.js';
import { inTransaction, type DbPool } from './index.js';
import type { CaptainPortfolio, CaptainPortfolioRange } from '@socially/contracts';

// Keep endpoints and both sides of a gap when shrinking a graph. A gap must
// never disappear simply because the list card has fewer pixels.
export function compactDiscoveryPoints(points: CaptainPortfolio['points']) {
  if (points.length <= 32) return points;
  const selected = new Set([0, points.length - 1]);
  for (let i = 0; i < points.length; i++) {
    if (points[i]!.hasGap || points[i]!.netReturnPercent === null || (i && points[i]!.segment !== points[i - 1]!.segment)) {
      selected.add(i); if (i) selected.add(i - 1);
    }
  }
  // Too many breaks: retain a bounded recent window rather than bridge gaps.
  if (selected.size > 32) return points.slice(-32);
  for (let i = 0; i < 32 && selected.size < 32; i++) selected.add(Math.round(i * (points.length - 1) / 31));
  return [...selected].sort((a, b) => a - b).map(i => points[i]!);
}

/** Bounded reconciliation also refreshes moving boundaries and aging marks.
 * Revision mismatch accelerates trading updates; 30s sweep repairs missed work.
 * Each Captain is read in one consistent snapshot. Advisory locks allow workers
 * to overlap without publishing an older calculation over a newer one.
 */
export async function refreshCaptainDiscovery(pool: DbPool, limit = 10) {
  const due = (await pool.query(`SELECT u.id FROM users u
    LEFT JOIN captain_portfolio_state s ON s.captain_id=u.id
    LEFT JOIN captain_discovery_metrics m ON m.captain_id=u.id AND m.range='30D'
    WHERE u.username IS NOT NULL AND (u.role='captain' OR EXISTS(SELECT 1 FROM funds f WHERE f.captain_id=u.id))
      AND (m.captain_id IS NULL OR m.source_revision IS DISTINCT FROM COALESCE(s.revision,0)
        OR m.computed_at<clock_timestamp()-interval '30 seconds')
    ORDER BY m.computed_at NULLS FIRST,u.id LIMIT $1`, [limit])).rows;
  let refreshed = 0;
  const errors: unknown[] = [];
  for (const row of due) {
    try {
      refreshed += await inTransaction(pool, async client => {
        await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
        const lock = (await client.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,3691)) AS locked', [row.id])).rows[0];
        if (!lock.locked) return 0;
        const crew = (await client.query(`SELECT count(DISTINCT c.user_id)::integer AS count FROM vault_contributions c
          JOIN funds f ON f.id=c.fund_id JOIN vault_rounds r ON r.fund_id=f.id
          WHERE f.captain_id=$1 AND c.user_id<>$1 AND c.state='ACCEPTED'
          AND r.phase IN ('FUNDRAISING','ACTIVE','SETTLING','REFUNDING')`, [row.id])).rows[0]!.count;
        for (const range of ['7D','30D','90D','ALL'] as CaptainPortfolioRange[]) {
          const p = await captainPortfolio(client, row.id, range);
          const portfolio = { ...p, points: compactDiscoveryPoints(p.points) };
          await client.query(`INSERT INTO captain_discovery_metrics
            (captain_id,range,source_revision,aum_usdc,net_pnl_usdc,net_return_percent,crew_members,active_vaults,total_vaults,portfolio)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
            ON CONFLICT(captain_id,range) DO UPDATE SET source_revision=EXCLUDED.source_revision,
            aum_usdc=EXCLUDED.aum_usdc,net_pnl_usdc=EXCLUDED.net_pnl_usdc,net_return_percent=EXCLUDED.net_return_percent,
            crew_members=EXCLUDED.crew_members,active_vaults=EXCLUDED.active_vaults,total_vaults=EXCLUDED.total_vaults,
            portfolio=EXCLUDED.portfolio,computed_at=transaction_timestamp()`,
          [row.id, range, p.revision, p.aumUsdc, p.netPnlUsdc, p.netReturnPercent, crew, p.activeVaults, p.totalVaults, JSON.stringify(portfolio)]);
        }
        return 1;
      });
    } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, 'Captain discovery refresh failed');
  return refreshed;
}
