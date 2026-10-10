import { assetTradeReason, registeredInstruments } from "@socially/market-data/registry";
import { randomUUID } from "node:crypto";
import { appendFundEvent, inTransaction, ledgerAccountId, saveFundNav, type DbClient, type DbPool } from "@socially/db";
import { Amount, evaluateSpotOrder, fixed, MAX_PRICE_AGE_MS, SHARE_DECIMALS, USDC_DECIMALS } from "@socially/domain";
import { simulateFill, simulateQuantitySell } from "@socially/market-data";
import { lockValuedFund } from "./valuation.js";
import { eligibleFundBatches } from "./fund-batches.js";

const ORDER_DELAY_MS = 3_000;
const ORDER_TIMEOUT_MS = 120_000;

interface PendingOrder {
  id: string;
  fund_id: string;
  side: "BUY" | "SELL";
  instrument_id: string;
  notional_usdc: string;
  requested_quantity: string | null;
  submitted_at: Date;
  policy_version: number|null;
}

interface FundState {
  id: string;
  status: string;
  cash_usdc: string;
  total_shares: string;
  peak_share_price: string;
  ends_at: Date;
  round_phase: string | null;
  db_now: Date;
  max_order_bps: number;
  max_position_bps: number;
  drawdown_breaker_bps: number;
  allowed_instruments: string[];
  universe_mode: "LEGACY_ALLOWLIST"|"DYNAMIC_SPOT";
}

interface Observation {
  id: string;
  price_usdc: string;
  source_at: Date;
  received_at: Date;
}

async function latestObservation(client: DbClient, instrumentId = "SOL", after?: Date): Promise<Observation | null> {
  const result = await client.query<Observation>(
    `SELECT id, price_usdc::text, source_at, received_at FROM price_observations
     WHERE instrument_id = $3
       AND (source = 'JUPITER_PRICE_V3' OR ($1::boolean AND source = 'DEV_SEED'))
       AND ($2::timestamptz IS NULL OR (received_at >= $2 AND source_at >= $2))
     ORDER BY source_at DESC, received_at DESC LIMIT 1`,
    [process.env.NODE_ENV !== "production" && process.env.DEV_PRICE_SEED_ENABLED === "true", after ?? null, instrumentId],
  );
  return result.rows[0] ?? null;
}

function fresh(observation: Observation): boolean {
  const age = Date.now() - observation.source_at.getTime();
  return age >= -5_000 && age <= MAX_PRICE_AGE_MS;
}

async function fundState(client: DbClient, fundId: string, policyVersion?: number|null): Promise<FundState> {
  await client.query('SELECT id FROM funds WHERE id=$1 FOR NO KEY UPDATE',[fundId]);
  const result = await client.query<FundState>(
    `SELECT f.id, f.status, f.cash_usdc::text, f.total_shares::text,
            f.peak_share_price::text, COALESCE(t.ends_at,r.trading_ends_at) AS ends_at, r.phase AS round_phase, clock_timestamp() AS db_now, p.max_order_bps, p.max_position_bps,
            p.drawdown_breaker_bps, p.allowed_instruments,p.universe_mode
     FROM funds f LEFT JOIN trials t ON t.fund_id = f.id LEFT JOIN vault_rounds r ON r.fund_id=f.id
     JOIN LATERAL (SELECT * FROM fund_policy_versions WHERE fund_id = f.id AND ($2::integer IS NULL OR version=$2)
                   ORDER BY version DESC LIMIT 1) p ON true
     WHERE f.id = $1`,
    [fundId,policyVersion ?? null],
  );
  const fund = result.rows[0]!;
  fund.db_now = (await client.query<{ now: Date }>("SELECT clock_timestamp() AS now")).rows[0]!.now;
  return fund;
}

async function position(client: DbClient, fundId: string, instrumentId: string) {
  const result = await client.query<{ quantity: string; cost_basis_usdc: string }>(
    `SELECT quantity::text, cost_basis_usdc::text FROM positions
     WHERE fund_id = $1 AND instrument_id = $2`, [fundId, instrumentId],
  );
  return result.rows[0] ?? { quantity: "0", cost_basis_usdc: "0" };
}

async function snapshot(client: DbClient, fund: FundState, nav: Amount, observation: Observation) {
  const sharePrice = fixed(nav.div(fund.total_shares), SHARE_DECIMALS);
  await saveFundNav(client, { fundId: fund.id, navUsdc: fixed(nav, SHARE_DECIMALS),
    sharePriceUsdc: sharePrice, pricedAt: observation.source_at, observationId: observation.id });
}

async function reject(client: DbClient, order: PendingOrder, reason: string) {
  await client.query(
    "UPDATE orders SET status = 'REJECTED',progress_state='REJECTED',progress_at=clock_timestamp(), reject_reason = $2, processed_at = now() WHERE id = $1",
    [order.id, reason],
  );
  await appendFundEvent(client, order.fund_id, "order_rejected", { orderId: order.id, reason });
}

async function progress(client:DbClient,order:PendingOrder,state:string,observationId:string|null=null){
  const changed=await client.query('UPDATE orders SET progress_state=$2,progress_at=clock_timestamp(),waiting_observation_id=$3 WHERE id=$1 AND progress_state<>$2 RETURNING id',[order.id,state,observationId]);
  if(changed.rowCount)await appendFundEvent(client,order.fund_id,'order_progress',{orderId:order.id,stage:state});
}

export async function processOrder(pool: DbPool, orderId: string): Promise<boolean> {
  return inTransaction(pool, async (client) => {
    const selected = await client.query<PendingOrder>(
      `SELECT id, fund_id, side, instrument_id, notional_usdc::text, requested_quantity::text, submitted_at,policy_version
       FROM orders WHERE id = $1 AND status = 'PENDING' FOR NO KEY UPDATE SKIP LOCKED`,
      [orderId],
    );
    const order = selected.rows[0];
    if (!order) return false;
    await client.query('UPDATE orders SET last_attempted_at=clock_timestamp(),execution_attempts=execution_attempts+1 WHERE id=$1',[order.id]);
    const fund = await fundState(client, order.fund_id,order.policy_version);
    if (fund.ends_at.getTime() <= fund.db_now.getTime() ||
        !(fund.status === "ACTIVE" || fund.status === "FROZEN" && order.side === "SELL") ||
        (fund.round_phase !== null && fund.round_phase !== "ACTIVE")) {
      await reject(client, order, "fund_not_tradable");
      return true;
    }
    const instrument = (await registeredInstruments(client,[order.instrument_id]))[0];
    const heldPosition = await position(client,fund.id,order.instrument_id);
    const assetReason = assetTradeReason(instrument,fund,order.side,new Amount(heldPosition.quantity).gt(0));
    if (assetReason) { await reject(client,order,assetReason); return true; }
    if(fund.db_now.getTime()<order.submitted_at.getTime()+ORDER_DELAY_MS){await progress(client,order,'WAITING_DELAY');return false;}
    const observation = await latestObservation(client, order.instrument_id, new Date(order.submitted_at.getTime() + ORDER_DELAY_MS));
    if (!observation || !fresh(observation)) {
      if (Date.now() - order.submitted_at.getTime() >= ORDER_TIMEOUT_MS) {
        await reject(client, order, "price_unavailable");
        return true;
      }
      await progress(client,order,'WAITING_PRICE');
      return false;
    }
    const held = await position(client, fund.id, order.instrument_id);
    const marketPrice = new Amount(observation.price_usdc);
    const valuation = await lockValuedFund(client, fund.id);
    if (!valuation) {
      if (Date.now() - order.submitted_at.getTime() >= ORDER_TIMEOUT_MS) { await reject(client, order, "valuation_unavailable"); return true; }
      await progress(client,order,'WAITING_VALUATION',observation.id);
      return false;
    }
    const nav = valuation.nav;
    const sharePrice = nav.div(fund.total_shares);
    let fill: ReturnType<typeof simulateFill>;
    try {
      if (order.requested_quantity) {
        const estimate = simulateQuantitySell(order.requested_quantity, observation.price_usdc, instrument!.decimals);
        order.notional_usdc = estimate.notionalUsdc; fill = estimate;
      } else fill = simulateFill(order.side, order.notional_usdc, observation.price_usdc, instrument!.decimals);
    }
    catch { await reject(client, order, "fill_model_rejected"); return true; }
    const reason = evaluateSpotOrder({
      side: order.side, instrumentId: order.instrument_id,
      allowedInstruments: [order.instrument_id], notionalUsdc: order.notional_usdc,
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
         VALUES ($1, $4, $2, $3)
         ON CONFLICT (fund_id, instrument_id) DO UPDATE SET
           quantity = positions.quantity + EXCLUDED.quantity,
           cost_basis_usdc = positions.cost_basis_usdc + EXCLUDED.cost_basis_usdc`,
        [fund.id, fill.quantity, order.notional_usdc, order.instrument_id],
      );
    } else {
      const basisSold = fixed(new Amount(held.cost_basis_usdc).mul(quantity).div(held.quantity), SHARE_DECIMALS);
      await client.query(
        `UPDATE positions SET quantity = quantity - $2::numeric,
         cost_basis_usdc = cost_basis_usdc - $3::numeric
         WHERE fund_id = $1 AND instrument_id = $4`,
        [fund.id, fill.quantity, basisSold, order.instrument_id],
      );
    }
    await client.query("UPDATE funds SET cash_usdc = cash_usdc + $2::numeric WHERE id = $1", [fund.id, fill.cashChangeUsdc]);
    const eventId = await appendFundEvent(client, fund.id, "order_filled", {
      orderId: order.id, side: order.side, instrumentId: order.instrument_id, quantity: fill.quantity,
      notionalUsdc: order.notional_usdc, marketPriceUsdc: fill.marketPriceUsdc,
      fillPriceUsdc: fill.fillPriceUsdc, feeUsdc: fill.feeUsdc,
      modelVersion: fill.modelVersion, observationId: observation.id,
    });
    const fundSol = await ledgerAccountId(client, "FUND", fund.id, order.instrument_id);
    const marketSol = await ledgerAccountId(client, "MARKET", "paper-market", order.instrument_id);
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
    await client.query("UPDATE orders SET status = 'FILLED',progress_state='FILLED',progress_at=clock_timestamp(), notional_usdc=$2, processed_at = clock_timestamp() WHERE id = $1", [order.id, order.notional_usdc]);
    const newNav = nav.plus(cashChange).plus(assetChange.mul(marketPrice));
    await snapshot(client, fund, newNav, observation);
    return true;
  });
}

export async function processPendingOrders(pool: DbPool): Promise<number> {
  const candidates = await pool.query<{ id: string }>(
    `SELECT id FROM orders WHERE status = 'PENDING'
     AND submitted_at <= now() - interval '3 seconds'
     ORDER BY last_attempted_at NULLS FIRST,submitted_at LIMIT 20`,
  );
  let processed = 0;
  for (const candidate of candidates.rows) {
    if (await processOrder(pool, candidate.id)) processed++;
  }
  return processed;
}

export async function markFund(pool:DbPool,fundId:string,recordUnavailable=false):Promise<boolean> {
  return inTransaction(pool, async (client) => {
        await client.query("SET LOCAL lock_timeout='500ms'");
        await client.query("SET LOCAL statement_timeout='2s'");
        const fund = await fundState(client, fundId);
        if (!['ACTIVE','FROZEN'].includes(fund.status) || fund.round_phase && fund.round_phase!=='ACTIVE') return false;
        const valuation = await lockValuedFund(client, fund.id);
        if (!valuation) {
          if (!recordUnavailable) return false;
          const previous=(await client.query("SELECT status FROM nav_snapshots WHERE fund_id=$1 ORDER BY event_sequence DESC NULLS LAST,created_at DESC LIMIT 1",[fund.id])).rows[0];
          if(previous?.status==='UNAVAILABLE')return false;
          await appendFundEvent(client,fund.id,'valuation_unavailable',{});
          await client.query("INSERT INTO nav_snapshots(id,fund_id,status,priced_at,event_sequence) SELECT $2,id,'UNAVAILABLE',clock_timestamp(),event_sequence FROM funds WHERE id=$1",[fund.id,randomUUID()]);
          return true;
        }
        if (!valuation.positions.length) return false;
        const observation = await latestObservation(client, valuation.positions[0]?.instrument_id ?? "SOL");
        if (!observation || !fresh(observation)) return false;
        const markRef = JSON.stringify(valuation.positions.map(p => [p.instrument_id,p.observation_id]).sort((a,b) => String(a[0]).localeCompare(String(b[0]))));
        const previous = await client.query<{ observation_id: string | null; market_mark_ref: string | null }>(
          `SELECT observation_id,market_mark_ref FROM nav_snapshots WHERE fund_id = $1
           ORDER BY event_sequence DESC NULLS LAST, created_at DESC LIMIT 1`,
          [fund.id],
        );
        if (previous.rows[0]?.market_mark_ref === markRef && previous.rows[0]?.observation_id === observation.id) return false;
        const nav = valuation.nav;
        const sharePrice = nav.div(fund.total_shares);
        const breaker = new Amount(fund.peak_share_price)
          .mul(new Amount(1).minus(new Amount(fund.drawdown_breaker_bps).div(10_000)));
        const frozen = fund.status === "ACTIVE" && sharePrice.lt(breaker);
        if (frozen) {
          await client.query("UPDATE funds SET status = 'FROZEN' WHERE id = $1", [fund.id]);
          await client.query("UPDATE vault_rounds SET risk_state='FROZEN' WHERE fund_id=$1",[fund.id]);
        }
        await appendFundEvent(client, fund.id, frozen ? "drawdown_breaker" : "fund_marked", {
          observationId: observation.id, navUsdc: fixed(nav, USDC_DECIMALS),
          sharePriceUsdc: fixed(sharePrice, SHARE_DECIMALS), frozen,
        });
        await snapshot(client, fund, nav, { ...observation, source_at: valuation.pricedAt });
        await client.query(`UPDATE nav_snapshots SET market_mark_ref=$2 WHERE id=(SELECT id FROM nav_snapshots WHERE fund_id=$1 ORDER BY event_sequence DESC NULLS LAST LIMIT 1)`, [fund.id, markRef]);
        return true;
      });
}

/** Explicit full sweep retained for operational recovery and compatibility. */
export async function markActiveFunds(pool: DbPool): Promise<number> {
  let marked=0;
  for await(const batch of eligibleFundBatches(pool,{kind:'VALUATION'}))
    for(const row of batch) if(await markFund(pool,row.id))marked++;
  return marked;
}
