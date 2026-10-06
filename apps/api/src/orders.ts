import { randomUUID } from "node:crypto";
import type { DbPool } from "@socially/db";
import { appendFundEvent, inTransaction } from "@socially/db";
import { Amount, evaluateSpotOrder, fixed, MAX_PRICE_AGE_MS, MAX_SIMULATED_ORDER_USDC,
  parsePositiveAmount, USDC_DECIMALS } from "@socially/domain";
import { simulateFill, simulateQuantitySell } from "@socially/market-data";
import type { Actor } from "./auth.js";
import { beginIdempotent, finishIdempotent, valueFund } from "./accounting.js";
import { ApiFault } from "./errors.js";

export interface OrderInput {
  side: "BUY" | "SELL";
  instrumentId: string;
  notionalUsdc?: string;
  quantity?: string;
}

function quantityIntent(input: OrderInput): string | null {
  if (input.quantity === undefined) return null;
  if (input.side !== "SELL" || input.notionalUsdc !== undefined) throw new ApiFault(400, "invalid_order", "Quantity is exclusive to SELL intents");
  try { return fixed(parsePositiveAmount(input.quantity, 18), 18); }
  catch { throw new ApiFault(400, "invalid_quantity", "quantity must be a positive decimal string"); }
}
function amount(input: OrderInput): string {
  let parsed: Amount;
  try { parsed = parsePositiveAmount(input.notionalUsdc, USDC_DECIMALS); }
  catch { throw new ApiFault(400, "invalid_notional", "notionalUsdc must be a positive decimal string with at most 6 places"); }
  if (parsed.lt(1) || parsed.gt(MAX_SIMULATED_ORDER_USDC)) {
    throw new ApiFault(400, "order_size_out_of_range", "Order notional must be 1-1000 virtual USDC");
  }
  return fixed(parsed, USDC_DECIMALS);
}

interface OrderContext {
  id: string;
  captain_id: string;
  status: string;
  cash_usdc: string;
  total_shares: string;
  peak_share_price: string;
  ends_at: Date;
  max_order_bps: number;
  max_position_bps: number;
  drawdown_breaker_bps: number;
  allowed_instruments: string[];
}

async function context(client: import("@socially/db").DbClient, fundId: string): Promise<OrderContext> {
  const result = await client.query<OrderContext>(
    `SELECT f.id, f.captain_id, f.status, f.cash_usdc::text, f.total_shares::text,
            f.peak_share_price::text, t.ends_at, p.max_order_bps, p.max_position_bps,
            p.drawdown_breaker_bps, p.allowed_instruments
     FROM funds f JOIN trials t ON t.fund_id = f.id
     JOIN LATERAL (SELECT * FROM fund_policy_versions WHERE fund_id = f.id
                   ORDER BY version DESC LIMIT 1) p ON true
     WHERE f.id = $1`,
    [fundId],
  );
  if (!result.rows[0]) throw new ApiFault(404, "fund_not_found", "Fund not found");
  return result.rows[0];
}

function authorize(actor: Actor, fund: OrderContext, side: string): void {
  if (fund.captain_id !== actor.id) throw new ApiFault(403, "captain_required", "Only this fund's Captain can trade");
  if (fund.ends_at.getTime() <= Date.now() || fund.status === "COMPLETED" ||
      (fund.status === "FROZEN" && side !== "SELL")) {
    throw new ApiFault(409, "fund_not_tradable", "Fund is not accepting this trade");
  }
}

export async function previewOrder(pool: DbPool, actor: Actor, fundId: string, input: OrderInput) {
  const requestedQuantity = quantityIntent(input);
  let notionalUsdc = requestedQuantity ? "0" : amount(input);
  return inTransaction(pool, async (client) => {
    const fund = await context(client, fundId);
    authorize(actor, fund, input.side);
    const instrument = await client.query<{ decimals: number; active: boolean }>(
      "SELECT decimals, active FROM instruments WHERE id = $1", [input.instrumentId],
    );
    if (!instrument.rows[0]?.active || !fund.allowed_instruments.includes(input.instrumentId)) {
      throw new ApiFault(422, "asset_not_allowed", "Asset is not allowed by the fund policy");
    }
    const quote = await client.query<{ id: string; price_usdc: string; source_at: Date }>(
      `SELECT id, price_usdc::text, source_at FROM price_observations
       WHERE instrument_id = $1 AND (source = 'JUPITER_PRICE_V3' OR ($2::boolean AND source = 'DEV_SEED'))
       ORDER BY source_at DESC, received_at DESC LIMIT 1`,
      [input.instrumentId, process.env.NODE_ENV !== "production" && process.env.DEV_PRICE_SEED_ENABLED === "true"],
    );
    const observation = quote.rows[0];
    if (!observation || Date.now() - observation.source_at.getTime() > MAX_PRICE_AGE_MS ||
        observation.source_at.getTime() - Date.now() > 5_000) {
      throw new ApiFault(503, "price_unavailable", "Fresh market price unavailable");
    }
    const valuation = await valueFund(client, fund);
    let fill;
    try {
      fill = requestedQuantity ? simulateQuantitySell(requestedQuantity, observation.price_usdc, instrument.rows[0].decimals)
        : simulateFill(input.side, notionalUsdc, observation.price_usdc, instrument.rows[0].decimals);
      if ("notionalUsdc" in fill && typeof fill.notionalUsdc === "string") notionalUsdc = fill.notionalUsdc;
    } catch { throw requestedQuantity
      ? new ApiFault(422, "invalid_quantity", "Sell quantity must match token precision and the 1-1000 USDC order range")
      : new ApiFault(422, "invalid_order_amount", "Order amount is too small for this token's precision"); }
    const position = valuation.positions.find((item) => item.instrumentId === input.instrumentId);
    const reason = evaluateSpotOrder({
      side: input.side, instrumentId: input.instrumentId,
      allowedInstruments: fund.allowed_instruments, notionalUsdc, quantity: fill.quantity,
      marketPriceUsdc: fill.marketPriceUsdc, cashUsdc: fund.cash_usdc,
      positionQuantity: position?.quantity.toString() ?? "0", navUsdc: valuation.nav.toString(),
      sharePriceUsdc: valuation.sharePrice.toString(), peakSharePriceUsdc: fund.peak_share_price,
      maxOrderBps: fund.max_order_bps, maxPositionBps: fund.max_position_bps,
      drawdownBreakerBps: fund.drawdown_breaker_bps,
    });
    return { mode: "PAPER", estimate: fill, policy: { allowed: reason === null, reason },
      observationId: observation.id, observedAt: observation.source_at.toISOString() };
  });
}

export async function submitOrder(
  pool: DbPool, actor: Actor, fundId: string, input: OrderInput, key: string,
) {
  const requestedQuantity = quantityIntent(input);
  let notionalUsdc = requestedQuantity ? "0" : amount(input);
  return inTransaction(pool, async (client) => {
    const prior = await beginIdempotent<{ mode: "PAPER"; orderId: string; status: "PENDING" }>(
      client, actor.id, key, `POST /v0/funds/${fundId}/orders`, requestedQuantity
        ? { side: input.side, instrumentId: input.instrumentId, quantity: requestedQuantity }
        : { side: input.side, instrumentId: input.instrumentId, notionalUsdc },
    );
    if (prior) return prior;
    const fund = await context(client, fundId);
    authorize(actor, fund, input.side);
    const instrument = await client.query<{ active: boolean; decimals: number }>(
      "SELECT active,decimals FROM instruments WHERE id = $1", [input.instrumentId],
    );
    if (!instrument.rows[0]?.active) throw new ApiFault(422, "asset_not_allowed", "Asset is not active");
    if (requestedQuantity) {
      if (!fund.allowed_instruments.includes(input.instrumentId)) throw new ApiFault(422, "asset_not_allowed", "Asset is not allowed by fund policy");
      const observation = (await client.query<{ price_usdc: string; source_at: Date }>(`SELECT price_usdc::text,source_at FROM price_observations
        WHERE instrument_id=$1 AND (source='JUPITER_PRICE_V3' OR ($2::boolean AND source='DEV_SEED')) ORDER BY source_at DESC,received_at DESC LIMIT 1`,
        [input.instrumentId, process.env.NODE_ENV !== "production" && process.env.DEV_PRICE_SEED_ENABLED === "true"])).rows[0];
      if (!observation || Date.now()-observation.source_at.getTime()>MAX_PRICE_AGE_MS || observation.source_at.getTime()>Date.now()+5000)
        throw new ApiFault(503, "price_unavailable", "Fresh market price unavailable");
      try { notionalUsdc = simulateQuantitySell(requestedQuantity, observation.price_usdc, instrument.rows[0]!.decimals).notionalUsdc; }
      catch { throw new ApiFault(422, "invalid_quantity", "Sell quantity must match token precision and the 1-1000 USDC order range"); }
    }
    const orderId = randomUUID();
    await client.query(
      `INSERT INTO orders (id, fund_id, captain_id, idempotency_key, side, instrument_id, notional_usdc, requested_quantity)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [orderId, fundId, actor.id, key, input.side, input.instrumentId, notionalUsdc, requestedQuantity],
    );
    await appendFundEvent(client, fundId, "order_submitted", {
      orderId, side: input.side, instrumentId: input.instrumentId, notionalUsdc,
    });
    const response = { mode: "PAPER" as const, orderId, status: "PENDING" as const };
    await finishIdempotent(client, actor.id, key, response, 202);
    return response;
  });
}

export async function getOrder(pool: DbPool, fundId: string, orderId: string) {
  const result = await pool.query(
    `SELECT o.id, o.side, o.instrument_id, o.notional_usdc::text, o.requested_quantity::text, o.status,
            o.reject_reason, o.submitted_at, o.processed_at,
            f.quantity::text, f.market_price_usdc::text, f.fill_price_usdc::text,
            f.fee_usdc::text, f.model_version, f.observation_id
     FROM orders o LEFT JOIN fills f ON f.order_id = o.id
     WHERE o.fund_id = $1 AND o.id = $2`, [fundId, orderId],
  );
  if (!result.rows[0]) throw new ApiFault(404, "order_not_found", "Order not found");
  return result.rows[0];
}

export async function cancelOrder(pool: DbPool, actor: Actor, fundId: string, orderId: string) {
  return inTransaction(pool, async (client) => {
    const selected = await client.query<{ status: string; captain_id: string }>(
      "SELECT status, captain_id FROM orders WHERE id = $1 AND fund_id = $2 FOR NO KEY UPDATE",
      [orderId, fundId],
    );
    const order = selected.rows[0];
    if (!order) throw new ApiFault(404, "order_not_found", "Order not found");
    if (order.captain_id !== actor.id) {
      throw new ApiFault(403, "captain_required", "Only this fund's Captain can cancel an order");
    }
    if (order.status === "CANCELLED") return { mode: "PAPER" as const, orderId, status: "CANCELLED" as const };
    if (order.status !== "PENDING") {
      throw new ApiFault(409, "order_already_processed", "Only pending orders can be cancelled");
    }
    await client.query(
      "UPDATE orders SET status = 'CANCELLED', processed_at = now() WHERE id = $1",
      [orderId],
    );
    await appendFundEvent(client, fundId, "order_cancelled", { orderId });
    return { mode: "PAPER" as const, orderId, status: "CANCELLED" as const };
  });
}
