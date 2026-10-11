import { paperObservation } from '@socially/db';
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
  round_model_version: number;
}

export async function lockValuedFund(client: DbClient, fundId: string) {
  const fundResult = await client.query<ValuedFund>(
    `SELECT f.id,f.captain_id,f.status,f.cash_usdc::text,f.total_shares::text,
      f.protocol_shares::text,f.high_water_mark::text,f.performance_fee_factor::text,COALESCE(t.ends_at,r.trading_ends_at) AS ends_at,f.round_model_version
     FROM funds f LEFT JOIN trials t ON t.fund_id=f.id LEFT JOIN vault_rounds r ON r.fund_id=f.id WHERE f.id=$1 FOR NO KEY UPDATE OF f`, [fundId],
  );
  const fund = fundResult.rows[0];
  if (!fund || fund.status === "COMPLETED" || new Amount(fund.total_shares).lte(0)) return null;
  const rows=await client.query<{instrument_id:string;quantity:string;cost_basis_usdc:string}>(
    'SELECT instrument_id,quantity::text,cost_basis_usdc::text FROM positions WHERE fund_id=$1 AND quantity>0 ORDER BY instrument_id',[fundId]);
  const positions: Array<{instrument_id:string;quantity:string;cost_basis_usdc:string;observation_id:string;price_usdc:string;source_at:Date}>=[];
  let nav = new Amount(fund.cash_usdc);
  let pricedAt = new Date();
  for(const row of rows.rows){
    const mark=await paperObservation(client,row.instrument_id);if(!mark)return null;
    positions.push({...row,observation_id:mark.id,price_usdc:mark.price_usdc,source_at:mark.source_at});
    nav=nav.plus(new Amount(row.quantity).mul(mark.price_usdc));
    if(mark.source_at<pricedAt)pricedAt=mark.source_at;
  }
  return { fund, nav, pricedAt, positions };
}
