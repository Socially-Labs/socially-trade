import { createHash, randomUUID } from "node:crypto";
import type { DbClient } from "@socially/db";
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
  const rows = await client.query<{
    instrument_id: string;
    quantity: string;
    cost_basis_usdc: string;
    decimals: number;
    price_usdc: string | null;
    source_at: Date | null;
  }>(
    `SELECT p.instrument_id, p.quantity::text, p.cost_basis_usdc::text, i.decimals,
            o.price_usdc::text, o.source_at
     FROM positions p JOIN instruments i ON i.id = p.instrument_id
     LEFT JOIN LATERAL (
       SELECT price_usdc, source_at FROM price_observations
       WHERE instrument_id = p.instrument_id
         AND (source = 'PYTH_HERMES' OR ($2::boolean AND source = 'DEV_SEED'))
       ORDER BY source_at DESC, received_at DESC LIMIT 1
     ) o ON true
     WHERE p.fund_id = $1 AND p.quantity > 0`,
    [fund.id, process.env.NODE_ENV !== "production" && process.env.DEV_PRICE_SEED_ENABLED === "true"],
  );
  let nav = new Amount(fund.cash_usdc);
  const now = Date.now();
  let pricedAt = new Date(now);
  const positions = rows.rows.map((row) => {
    const sourceTime = row.source_at?.getTime();
    if (!row.price_usdc || sourceTime === undefined || now - sourceTime > MAX_PRICE_AGE_MS || sourceTime - now > 5_000) {
      throw new ApiFault(503, "valuation_unavailable", `Fresh price unavailable for ${row.instrument_id}`);
    }
    if (sourceTime < pricedAt.getTime()) pricedAt = row.source_at!;
    const position = {
      instrumentId: row.instrument_id,
      quantity: new Amount(row.quantity),
      costBasis: new Amount(row.cost_basis_usdc),
      decimals: row.decimals,
      price: new Amount(row.price_usdc),
    };
    nav = nav.plus(position.quantity.mul(position.price));
    return position;
  });
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
  await client.query(
    `INSERT INTO nav_snapshots (id, fund_id, nav_usdc, share_price_usdc, status, priced_at, event_sequence)
     SELECT $1, $2, $3, $4, 'CURRENT', $5, event_sequence FROM funds WHERE id = $2`,
    [randomUUID(), fundId, fixed(nav, SHARE_DECIMALS), sharePrice, pricedAt],
  );
  await client.query(
    "UPDATE funds SET peak_share_price = GREATEST(peak_share_price, $2::numeric) WHERE id = $1",
    [fundId, sharePrice],
  );
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
