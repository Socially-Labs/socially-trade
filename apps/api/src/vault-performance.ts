import type { DbPool } from '@socially/db';
import { Amount,fixed } from '@socially/domain';
import { vaultDetail } from './vaults.js';
/** Read at most one persisted rollup per bucket. Fund-level normalized unit price excludes
 * contributions; round-v2 fees are assessed once, at finalization, without legacy dilution.
 */
export async function vaultPerformance(pool:DbPool,id:string,range:'7D'|'30D'|'ALL') {
  const vault=await vaultDetail(pool,id);
  const days=range==='7D'?7:range==='30D'?30:Math.min(400,vault.durationDays+3);
  const intervalSeconds=days<=7?3600:86400;
  const points=(await pool.query<{ at:Date; price:string; nav:string }>(`SELECT priced_at AS at,share_price_usdc::text AS price,nav_usdc::text AS nav
    FROM vault_performance_rollups WHERE fund_id=$1 AND interval_seconds=$3
    AND bucket_at>=to_timestamp(floor(extract(epoch FROM clock_timestamp()-$2*interval '24 hours')/$3)*$3)
    AND priced_at<=clock_timestamp() ORDER BY bucket_at LIMIT 401`,[id,days,intervalSeconds])).rows;
  return { mode:'PAPER',vaultId:id,range,intervalSeconds,
    points:points.map(point=>({ at:point.at.toISOString(),navUsdc:fixed(point.nav,6),sharePriceUsdc:fixed(point.price,18),netReturnPercent:fixed(new Amount(point.price).minus(1).mul(100),6) })),
    coverage:points.length?'PARTIAL':'UNAVAILABLE',valuationStatus:vault.valuationStatus,
    captainFeeUsdc:vault.settlement?.captainFeeUsdc ?? '0.000000',
    methodology:'Economic share price; contributions excluded from return. Final price is net of the round performance fee. No annualized projection.' };
}
