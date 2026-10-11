import { paperObservation } from '@socially/db';
import { createHash } from "node:crypto";
import { saveFundNav, type DbClient } from "@socially/db";
import { Amount, fixed, MAX_PRICE_AGE_MS, SHARE_DECIMALS, USDC_DECIMALS } from "@socially/domain";
import { ApiFault } from "./errors.js";

export interface PositionValue {
  instrumentId: string;
  quantity: Amount;
  costBasis: Amount;
  decimals: number;
  price: Amount;
}

export interface Valuation {
  nav: Amount;
  sharePrice: Amount;
  positions: PositionValue[];
  pricedAt: Date;
}

export async function valueFund(
  client: DbClient,
  fund: { id: string; cash_usdc: string; total_shares: string },
): Promise<Valuation> {
  const rows = await client.query<{instrument_id:string;quantity:string;cost_basis_usdc:string;decimals:number}>(
    `SELECT p.instrument_id,p.quantity::text,p.cost_basis_usdc::text,i.decimals FROM positions p JOIN instruments i ON i.id=p.instrument_id WHERE p.fund_id=$1 AND p.quantity>0`,[fund.id]);
  let nav = new Amount(fund.cash_usdc);
  const now = Date.now();
  let pricedAt = new Date(now);
  const positions: PositionValue[] = [];
  for (const row of rows.rows) {
    const mark=await paperObservation(client,row.instrument_id);
    if(!mark)throw new ApiFault(503,'valuation_unavailable',`Fresh price unavailable for ${row.instrument_id}`);
    if(mark.source_at < pricedAt)pricedAt=mark.source_at;
    const position = {
      instrumentId: row.instrument_id,
      quantity: new Amount(row.quantity),
      costBasis: new Amount(row.cost_basis_usdc),
      decimals: row.decimals,
      price: new Amount(mark.price_usdc),
    };
    nav = nav.plus(position.quantity.mul(position.price));
    positions.push(position);
  }
  const shares = new Amount(fund.total_shares);
  if (shares.lte(0)) throw new ApiFault(409, "invalid_share_supply", "Fund has no shares");
  return { nav, sharePrice: nav.div(shares), positions, pricedAt };
}

export async function saveNav(
  client: DbClient,
  fundId: string,
  nav: Amount,
  totalShares: Amount,
  pricedAt = new Date(),
): Promise<void> {
  const sharePrice = fixed(nav.div(totalShares), SHARE_DECIMALS);
  await saveFundNav(client, { fundId, navUsdc: fixed(nav, SHARE_DECIMALS), sharePriceUsdc: sharePrice, pricedAt });
}

export async function beginIdempotent<T>(
  client: DbClient,
  userId: string,
  key: string,
  route: string,
  body: unknown,
): Promise<T | null> {
  const hash = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  await client.query(
    `INSERT INTO api_idempotency (user_id, key, route, request_hash)
     VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
    [userId, key, route, hash],
  );
  const result = await client.query<{ route: string; request_hash: string; response: T | null }>(
    `SELECT route, request_hash, response FROM api_idempotency
     WHERE user_id = $1 AND key = $2 FOR UPDATE`,
    [userId, key],
  );
  const record = result.rows[0]!;
  if (record.route !== route || record.request_hash !== hash) {
    throw new ApiFault(409, "idempotency_conflict", "Idempotency key was used for another request");
  }
  return record.response;
}

export async function finishIdempotent(
  client: DbClient,
  userId: string,
  key: string,
  response: unknown,
  statusCode: number,
): Promise<void> {
  await client.query(
    `UPDATE api_idempotency SET response = $3, status_code = $4
     WHERE user_id = $1 AND key = $2`,
    [userId, key, response, statusCode],
  );
}

export function usdc(value: Amount): string {
  return fixed(value, USDC_DECIMALS);
}
