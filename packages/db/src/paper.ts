import type { DbClient, DbPool } from './index.js';
import { appendFundEvent } from './events.js';
import { freshPaperPrice } from '@socially/domain';
export interface PaperObservation { id: string; price_usdc: string; source_at: Date; received_at: Date; confirmed_at: Date }
/** Financial reads use PostgreSQL observations and authoritative feed state, never the Redis delivery hash. */
export async function paperObservation(db: DbClient | DbPool, instrumentId: string, after?: Date): Promise<PaperObservation | null> {
  const row = (await db.query<PaperObservation>(`SELECT o.id,o.price_usdc::text,o.source_at,o.received_at,
    COALESCE(o.last_confirmed_at,o.received_at) AS confirmed_at
    FROM price_observations o LEFT JOIN market_latest m ON m.instrument_id=o.instrument_id
    WHERE o.instrument_id=$1 AND (
      (o.source='JUPITER_PRICE_V3' AND m.payload->'price'->>'status'='CURRENT' AND m.payload->'price'->>'observationId'=o.id::text)
      OR ($2::boolean AND o.source='DEV_SEED'))
    ORDER BY o.source_at DESC,o.received_at DESC LIMIT 1`,
    [instrumentId,process.env.NODE_ENV!=='production' && process.env.DEV_PRICE_SEED_ENABLED==='true'])).rows[0];
  if (!row || !freshPaperPrice(row.source_at,row.confirmed_at) || (after && row.confirmed_at < after)) return null;
  return row;
}
/** Caller holds the fund lock; terminal transitions release reservations atomically. */
export async function cancelFundOrders(client: DbClient, fundId: string, reason: string): Promise<void> {
  const rows = (await client.query(`UPDATE orders SET status='CANCELLED',progress_state='CANCELLED',
    progress_at=clock_timestamp(),processed_at=clock_timestamp(),reject_reason=$2
    WHERE fund_id=$1 AND status='PENDING' RETURNING id`,[fundId,reason])).rows;
  for (const row of rows) await appendFundEvent(client,fundId,'order_cancelled',{orderId:row.id,reason});
}
export async function orderReservations(db: DbClient | DbPool, fundId: string, instrumentId: string, excludeId?: string) {
  return (await db.query<{cash: string; quantity: string; exposure: string}>(`SELECT COALESCE(sum(reserved_cash_usdc),0)::text AS cash,
    COALESCE(sum(reserved_quantity) FILTER(WHERE instrument_id=$2),0)::text AS quantity,
    COALESCE(sum(reserved_cash_usdc) FILTER(WHERE instrument_id=$2),0)::text AS exposure
    FROM orders WHERE fund_id=$1 AND status='PENDING' AND ($3::uuid IS NULL OR id<>$3)`,[fundId,instrumentId,excludeId??null])).rows[0]!;
}
