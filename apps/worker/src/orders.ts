import { randomUUID } from "node:crypto";
import { appendFundEvent, inTransaction, ledgerAccountId, type DbClient, type DbPool } from "@socially/db";
import { Amount, evaluateSpotOrder, fixed, MAX_PRICE_AGE_MS, SHARE_DECIMALS, USDC_DECIMALS } from "@socially/domain";
import { simulateFill } from "@socially/market-data";

const ORDER_DELAY_MS = 3_000;
const ORDER_TIMEOUT_MS = 120_000;

interface PendingOrder {
  id: string;
  fund_id: string;
  side: "BUY" | "SELL";
  instrument_id: string;
  notional_usdc: string;
  submitted_at: Date;
}

interface FundState {
  id: string;
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

interface Observation {
  id: string;
  price_usdc: string;
  source_at: Date;
  received_at: Date;
}

async function latestObservation(client: DbClient, after?: Date): Promise<Observation | null> {
  const result = await client.query<Observation>(
    `SELECT id, price_usdc::text, source_at, received_at FROM price_observations
     WHERE instrument_id = 'SOL'
       AND (source = 'PYTH_HERMES' OR ($1::boolean AND source = 'DEV_SEED'))
       AND ($2::timestamptz IS NULL OR (received_at >= $2 AND source_at >= $2))
     ORDER BY source_at DESC, received_at DESC LIMIT 1`,
    [process.env.NODE_ENV !== "production" && process.env.DEV_PRICE_SEED_ENABLED === "true", after ?? null],
  );
  return result.rows[0] ?? null;
}

function fresh(observation: Observation): boolean {
  const age = Date.now() - observation.source_at.getTime();
  return age >= -5_000 && age <= MAX_PRICE_AGE_MS;
}

async function fundState(client: DbClient, fundId: string): Promise<FundState> {
  const result = await client.query<FundState>(
    `SELECT f.id, f.status, f.cash_usdc::text, f.total_shares::text,
            f.peak_share_price::text, t.ends_at, p.max_order_bps, p.max_position_bps,
            p.drawdown_breaker_bps, p.allowed_instruments
     FROM funds f JOIN trials t ON t.fund_id = f.id
     JOIN LATERAL (SELECT * FROM fund_policy_versions WHERE fund_id = f.id
                   ORDER BY version DESC LIMIT 1) p ON true
     WHERE f.id = $1 FOR UPDATE OF f`,
    [fundId],
  );
  return result.rows[0]!;
}

async function position(client: DbClient, fundId: string) {
  const result = await client.query<{ quantity: string; cost_basis_usdc: string }>(
    `SELECT quantity::text, cost_basis_usdc::text FROM positions
     WHERE fund_id = $1 AND instrument_id = 'SOL'`, [fundId],
  );
  return result.rows[0] ?? { quantity: "0", cost_basis_usdc: "0" };
}

async function snapshot(client: DbClient, fund: FundState, nav: Amount, observation: Observation) {
  const sharePrice = fixed(nav.div(fund.total_shares), SHARE_DECIMALS);
  await client.query(
    `INSERT INTO nav_snapshots
     (id, fund_id, nav_usdc, share_price_usdc, status, priced_at, event_sequence, observation_id)
     SELECT $1, $2, $3, $4, 'CURRENT', $5, event_sequence, $6 FROM funds WHERE id = $2`,
    [randomUUID(), fund.id, fixed(nav, SHARE_DECIMALS), sharePrice, observation.source_at, observation.id],
  );
  await client.query(
    "UPDATE funds SET peak_share_price = GREATEST(peak_share_price, $2::numeric) WHERE id = $1",
    [fund.id, sharePrice],
  );
}

async function reject(client: DbClient, order: PendingOrder, reason: string) {
  await client.query(
    "UPDATE orders SET status = 'REJECTED', reject_reason = $2, processed_at = now() WHERE id = $1",
    [order.id, reason],
  );
  await appendFundEvent(client, order.fund_id, "order_rejected", { orderId: order.id, reason });
}

export async function processOrder(pool: DbPool, orderId: string): Promise<boolean> {
  return inTransaction(pool, async (client) => {
    const selected = await client.query<PendingOrder>(
      `SELECT id, fund_id, side, instrument_id, notional_usdc::text, submitted_at
       FROM orders WHERE id = $1 AND status = 'PENDING' FOR UPDATE SKIP LOCKED`,
      [orderId],
    );
    const order = selected.rows[0];
    if (!order) return false;
    const fund = await fundState(client, order.fund_id);
    if (fund.status === "COMPLETED" || fund.ends_at.getTime() <= Date.now() ||
        (fund.status === "FROZEN" && order.side === "BUY")) {
      await reject(client, order, "fund_not_tradable");
      return true;
    }
    if (order.instrument_id !== "SOL") {
      await reject(client, order, "asset_not_allowed");
      return true;
    }
    const observation = await latestObservation(client, new Date(order.submitted_at.getTime() + ORDER_DELAY_MS));
    if (!observation || !fresh(observation)) {
      if (Date.now() - order.submitted_at.getTime() >= ORDER_TIMEOUT_MS) {
        await reject(client, order, "price_unavailable");
        return true;
      }
      return false;
    }
    const held = await position(client, fund.id);
    const marketPrice = new Amount(observation.price_usdc);
    const nav = new Amount(fund.cash_usdc).plus(new Amount(held.quantity).mul(marketPrice));
    const sharePrice = nav.div(fund.total_shares);
    let fill: ReturnType<typeof simulateFill>;
    try { fill = simulateFill(order.side, order.notional_usdc, observation.price_usdc, 9); }
    catch { await reject(client, order, "fill_model_rejected"); return true; }
    const reason = evaluateSpotOrder({
      side: order.side, instrumentId: order.instrument_id,
      allowedInstruments: fund.allowed_instruments, notionalUsdc: order.notional_usdc,
      quantity: fill.quantity, marketPriceUsdc: fill.marketPriceUsdc,
      cashUsdc: fund.cash_usdc, positionQuantity: held.quantity,
      navUsdc: nav.toString(), sharePriceUsdc: sharePrice.toString(),
      peakSharePriceUsdc: fund.peak_share_price, maxOrderBps: fund.max_order_bps,
      maxPositionBps: fund.max_position_bps, drawdownBreakerBps: fund.drawdown_breaker_bps,
    });
    if (reason) { await reject(client, order, reason); return true; }

    const quantity = new Amount(fill.quantity);
    const cashChange = new Amount(fill.cashChangeUsdc);
    if (order.side === "BUY") {
      await client.query(
        `INSERT INTO positions (fund_id, instrument_id, quantity, cost_basis_usdc)
         VALUES ($1, 'SOL', $2, $3)
         ON CONFLICT (fund_id, instrument_id) DO UPDATE SET
           quantity = positions.quantity + EXCLUDED.quantity,
           cost_basis_usdc = positions.cost_basis_usdc + EXCLUDED.cost_basis_usdc`,
        [fund.id, fill.quantity, order.notional_usdc],
      );
    } else {
      const basisSold = fixed(new Amount(held.cost_basis_usdc).mul(quantity).div(held.quantity), SHARE_DECIMALS);
      await client.query(
        `UPDATE positions SET quantity = quantity - $2::numeric,
         cost_basis_usdc = cost_basis_usdc - $3::numeric
         WHERE fund_id = $1 AND instrument_id = 'SOL'`,
        [fund.id, fill.quantity, basisSold],
      );
    }
    await client.query("UPDATE funds SET cash_usdc = cash_usdc + $2::numeric WHERE id = $1", [fund.id, fill.cashChangeUsdc]);
    const eventId = await appendFundEvent(client, fund.id, "order_filled", {
      orderId: order.id, side: order.side, instrumentId: "SOL", quantity: fill.quantity,
      notionalUsdc: order.notional_usdc, marketPriceUsdc: fill.marketPriceUsdc,
      fillPriceUsdc: fill.fillPriceUsdc, feeUsdc: fill.feeUsdc,
      modelVersion: fill.modelVersion, observationId: observation.id,
    });
    const fundSol = await ledgerAccountId(client, "FUND", fund.id, "SOL");
    const marketSol = await ledgerAccountId(client, "MARKET", "paper-market", "SOL");
    const fundUsdc = await ledgerAccountId(client, "FUND", fund.id, "USDC");
    const marketUsdc = await ledgerAccountId(client, "MARKET", "paper-market", "USDC");
    const assetChange = order.side === "BUY" ? quantity : quantity.neg();
    await client.query(
      `INSERT INTO ledger_entries (event_id, account_id, amount)
       VALUES ($1, $2, $6), ($1, $3, -$6::numeric),
              ($1, $4, $7), ($1, $5, -$7::numeric)`,
      [eventId, fundSol, marketSol, fundUsdc, marketUsdc,
        assetChange.toString(), cashChange.toString()],
    );
    await client.query(
      `INSERT INTO fills (id, order_id, observation_id, quantity, market_price_usdc,
       fill_price_usdc, fee_usdc, model_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [randomUUID(), order.id, observation.id, fill.quantity, fill.marketPriceUsdc,
        fill.fillPriceUsdc, fill.feeUsdc, fill.modelVersion],
    );
    await client.query("UPDATE orders SET status = 'FILLED', processed_at = now() WHERE id = $1", [order.id]);
    const newQuantity = new Amount(held.quantity).plus(assetChange);
    const newNav = new Amount(fund.cash_usdc).plus(cashChange).plus(newQuantity.mul(marketPrice));
    await snapshot(client, fund, newNav, observation);
    return true;
  });
}

export async function processPendingOrders(pool: DbPool): Promise<number> {
  const candidates = await pool.query<{ id: string }>(
    `SELECT id FROM orders WHERE status = 'PENDING'
     AND submitted_at <= now() - interval '3 seconds'
     ORDER BY submitted_at LIMIT 20`,
  );
  let processed = 0;
  for (const candidate of candidates.rows) {
    if (await processOrder(pool, candidate.id)) processed++;
  }
  return processed;
}

export async function markActiveFunds(pool: DbPool): Promise<number> {
  const funds = await pool.query<{ id: string }>(
    `SELECT DISTINCT f.id FROM funds f JOIN positions p ON p.fund_id = f.id
     WHERE f.status IN ('ACTIVE', 'FROZEN') AND p.quantity > 0 LIMIT 100`,
  );
  let marked = 0;
  for (const row of funds.rows) {
    const didMark = await inTransaction(pool, async (client) => {
      const fund = await fundState(client, row.id);
      const observation = await latestObservation(client);
      if (!observation || !fresh(observation)) return false;
      const previous = await client.query<{ observation_id: string | null }>(
        `SELECT observation_id FROM nav_snapshots WHERE fund_id = $1
         ORDER BY event_sequence DESC NULLS LAST, created_at DESC LIMIT 1`,
        [fund.id],
      );
      if (previous.rows[0]?.observation_id === observation.id) return false;
      const held = await position(client, fund.id);
      const nav = new Amount(fund.cash_usdc).plus(new Amount(held.quantity).mul(observation.price_usdc));
      const sharePrice = nav.div(fund.total_shares);
      const breaker = new Amount(fund.peak_share_price)
        .mul(new Amount(1).minus(new Amount(fund.drawdown_breaker_bps).div(10_000)));
      const frozen = fund.status === "ACTIVE" && sharePrice.lt(breaker);
      if (frozen) await client.query("UPDATE funds SET status = 'FROZEN' WHERE id = $1", [fund.id]);
      await appendFundEvent(client, fund.id, frozen ? "drawdown_breaker" : "fund_marked", {
        observationId: observation.id, navUsdc: fixed(nav, USDC_DECIMALS),
        sharePriceUsdc: fixed(sharePrice, SHARE_DECIMALS), frozen,
      });
      await snapshot(client, fund, nav, observation);
      return true;
    });
    if (didMark) marked++;
  }
  return marked;
}
