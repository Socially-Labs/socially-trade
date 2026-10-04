import { Amount, MAX_PRICE_AGE_MS } from "@socially/domain";
import type { DbClient } from "@socially/db";

export interface ValuedFund {
  id: string;
  captain_id: string;
  status: string;
  cash_usdc: string;
  total_shares: string;
  protocol_shares: string;
  high_water_mark: string;
  performance_fee_factor: string;
  ends_at: Date;
}

export async function lockValuedFund(client: DbClient, fundId: string) {
  const fundResult = await client.query<ValuedFund>(
    `SELECT f.id,f.captain_id,f.status,f.cash_usdc::text,f.total_shares::text,
      f.protocol_shares::text,f.high_water_mark::text,f.performance_fee_factor::text,t.ends_at
     FROM funds f JOIN trials t ON t.fund_id=f.id WHERE f.id=$1 FOR NO KEY UPDATE OF f`, [fundId],
  );
  const fund = fundResult.rows[0];
  if (!fund || fund.status === "COMPLETED" || new Amount(fund.total_shares).lte(0)) return null;
  const positions = await client.query<{
    instrument_id: string; quantity: string; cost_basis_usdc: string;
    observation_id: string | null; price_usdc: string | null; source_at: Date | null;
  }>(
    `SELECT p.instrument_id,p.quantity::text,p.cost_basis_usdc::text,
       o.id observation_id,o.price_usdc::text,o.source_at
     FROM positions p LEFT JOIN LATERAL (
       SELECT id,price_usdc,source_at FROM price_observations WHERE instrument_id=p.instrument_id
        AND (source='JUPITER_PRICE_V3' OR ($2::boolean AND source='DEV_SEED'))
       ORDER BY source_at DESC,received_at DESC LIMIT 1
     ) o ON true WHERE p.fund_id=$1 AND p.quantity>0`,
    [fundId, process.env.NODE_ENV !== "production" && process.env.DEV_PRICE_SEED_ENABLED === "true"],
  );
  let nav = new Amount(fund.cash_usdc);
  let pricedAt = new Date();
  for (const position of positions.rows) {
    if (!position.price_usdc || !position.source_at) return null;
    const age = Date.now() - position.source_at.getTime();
    if (age > MAX_PRICE_AGE_MS || age < -5_000) return null;
    nav = nav.plus(new Amount(position.quantity).mul(position.price_usdc));
    if (position.source_at < pricedAt) pricedAt = position.source_at;
  }
  return { fund, nav, pricedAt, positions: positions.rows };
}
