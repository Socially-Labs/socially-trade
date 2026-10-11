import { assetTradeReason, registeredInstruments } from "@socially/market-data/registry";
import { randomUUID } from "node:crypto";
import type { DbPool } from "@socially/db";
import { appendFundEvent, inTransaction, paperObservation, orderReservations } from "@socially/db";
import { Amount, evaluateSpotOrder, fixed, paperPolicy, MAX_SIMULATED_ORDER_USDC,
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
    throw new ApiFault(400, "order_size_out_of_range", "Order notional must fit the configured virtual USDC limit");
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
  round_phase: string | null;
  db_now: Date;
  max_order_bps: number;
  max_position_bps: number;
  drawdown_breaker_bps: number;
  allowed_instruments: string[];
  universe_mode: "LEGACY_ALLOWLIST"|"DYNAMIC_SPOT";
  policy_version: number;
}

async function context(client: import("@socially/db").DbClient, fundId: string): Promise<OrderContext> {
  await client.query('SELECT id FROM funds WHERE id=$1 FOR NO KEY UPDATE',[fundId]);
  const result = await client.query<OrderContext>(
    `SELECT f.id, f.captain_id, f.status, f.cash_usdc::text, f.total_shares::text,
            f.peak_share_price::text, COALESCE(t.ends_at,r.trading_ends_at) AS ends_at, r.phase AS round_phase, clock_timestamp() AS db_now, p.max_order_bps, p.max_position_bps,
            p.drawdown_breaker_bps, p.allowed_instruments,p.universe_mode,p.version AS policy_version
     FROM funds f LEFT JOIN trials t ON t.fund_id = f.id LEFT JOIN vault_rounds r ON r.fund_id=f.id
     JOIN LATERAL (SELECT * FROM fund_policy_versions WHERE fund_id = f.id
                   ORDER BY version DESC LIMIT 1) p ON true
     WHERE f.id = $1`,
    [fundId],
  );
  if (!result.rows[0]) throw new ApiFault(404, "fund_not_found", "Fund not found");
  result.rows[0].db_now = (await client.query<{ now: Date }>("SELECT clock_timestamp() AS now")).rows[0]!.now;
  return result.rows[0];
}

function authorize(actor: Actor, fund: OrderContext, side: string): void {
  if (fund.captain_id !== actor.id) throw new ApiFault(403, "captain_required", "Only this fund's Captain can trade");
  if (fund.ends_at.getTime() <= fund.db_now.getTime() ||
      !(fund.status === "ACTIVE" || fund.status === "FROZEN" && side === "SELL") ||
      (fund.round_phase !== null && fund.round_phase !== "ACTIVE")) {
    throw new ApiFault(409, "fund_not_tradable", "Fund is not accepting this trade");
  }
}

async function prepareOrder(client: import('@socially/db').DbClient, actor: Actor, fundId: string, input: OrderInput) {
  const requestedQuantity = quantityIntent(input);
  let notionalUsdc = requestedQuantity ? '0' : amount(input);
  const fund = await context(client,fundId);
  authorize(actor,fund,input.side);
  const instrument = (await registeredInstruments(client,[input.instrumentId]))[0];
  const holding = (await client.query<{quantity:string}>('SELECT quantity::text FROM positions WHERE fund_id=$1 AND instrument_id=$2 AND quantity>0',[fundId,input.instrumentId])).rows[0];
  const assetReason = assetTradeReason(instrument,fund,input.side,!!holding);
  if(assetReason)throw new ApiFault(422,assetReason,'Asset is not allowed by the fund policy');
  const observation = await paperObservation(client,input.instrumentId);
  if(!observation)throw new ApiFault(503,'price_unavailable','Fresh market price unavailable');
  const valuation = await valueFund(client,fund);
  const reservations = await orderReservations(client,fundId,input.instrumentId);
  const availableCash = Amount.max(0,new Amount(fund.cash_usdc).minus(reservations.cash));
  const availableQuantity = Amount.max(0,new Amount(holding?.quantity??0).minus(reservations.quantity));
  let fill;
  try {
    fill=requestedQuantity ? simulateQuantitySell(requestedQuantity,observation.price_usdc,instrument!.decimals,holding?.quantity)
      : simulateFill(input.side,notionalUsdc,observation.price_usdc,instrument!.decimals);
    if('notionalUsdc' in fill && typeof fill.notionalUsdc==='string')notionalUsdc=fill.notionalUsdc;
  } catch {throw new ApiFault(422,requestedQuantity?'invalid_quantity':'invalid_order_amount','Order must fit token precision, holding and simulation limits');}
  const reason = evaluateSpotOrder({side:input.side,instrumentId:input.instrumentId,allowedInstruments:[input.instrumentId],
    notionalUsdc,quantity:fill.quantity,marketPriceUsdc:fill.marketPriceUsdc,cashUsdc:availableCash.toString(),
    positionQuantity:input.side==='SELL'?availableQuantity.toString():new Amount(holding?.quantity??0).plus(new Amount(reservations.exposure).div(observation.price_usdc)).toString(),
    navUsdc:valuation.nav.toString(),sharePriceUsdc:valuation.sharePrice.toString(),peakSharePriceUsdc:fund.peak_share_price,
    maxOrderBps:fund.max_order_bps,maxPositionBps:fund.max_position_bps,drawdownBreakerBps:fund.drawdown_breaker_bps});
  return {fund,fill,reason,notionalUsdc,requestedQuantity,observation,held:!!holding};
}
export async function previewOrder(pool:DbPool,actor:Actor,fundId:string,input:OrderInput){
  return inTransaction(pool,async client=>{
    const result=await prepareOrder(client,actor,fundId,input);
    return {mode:'PAPER',estimate:result.fill,policy:{allowed:result.reason===null,reason:result.reason},
      observationId:result.observation.id,observedAt:result.observation.source_at.toISOString()};
  });
}
export async function submitOrder(pool:DbPool,actor:Actor,fundId:string,input:OrderInput,key:string,
  route=`POST /v0/funds/${fundId}/orders`){
  const requestedQuantity=quantityIntent(input);
  const intent=requestedQuantity?{side:input.side,instrumentId:input.instrumentId,quantity:requestedQuantity}
    :{side:input.side,instrumentId:input.instrumentId,notionalUsdc:amount(input)};
  return inTransaction(pool,async client=>{
    const prior=await beginIdempotent<{mode:'PAPER';orderId:string;status:'PENDING'}>(client,actor.id,key,route,intent);
    if(prior)return prior;
    const result=await prepareOrder(client,actor,fundId,input);
    if(result.reason)throw new ApiFault(422,result.reason,'Order exceeds available resources or fund policy');
    if(input.side==='BUY'&&!result.held){
      await client.query('SELECT pg_advisory_xact_lock(7810232)');
      const demand=(await client.query<{n:number;tracked:boolean}>(`WITH demand AS(
        SELECT p.instrument_id FROM positions p JOIN funds f ON f.id=p.fund_id WHERE p.quantity>0 AND f.status<>'COMPLETED'
        UNION SELECT instrument_id FROM orders WHERE status='PENDING')
        SELECT count(*)::int AS n,COALESCE(bool_or(instrument_id=$1),false) AS tracked FROM demand`,[input.instrumentId])).rows[0]!;
      if(!demand.tracked&&demand.n>=paperPolicy.trackedAssetLimit)throw new ApiFault(503,'market_capacity','Shared price capacity is full');
    }
    const orderId=randomUUID(),reservedCash=input.side==='BUY'?result.notionalUsdc:'0',reservedQuantity=input.side==='SELL'?result.fill.quantity:'0';
    await client.query(`INSERT INTO orders(id,fund_id,captain_id,idempotency_key,side,instrument_id,notional_usdc,requested_quantity,policy_version,reserved_cash_usdc,reserved_quantity)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [orderId,fundId,actor.id,key,input.side,input.instrumentId,result.notionalUsdc,requestedQuantity,result.fund.policy_version,reservedCash,reservedQuantity]);
    await appendFundEvent(client,fundId,'order_submitted',{orderId,side:input.side,instrumentId:input.instrumentId,notionalUsdc:result.notionalUsdc,reservedCashUsdc:reservedCash,reservedQuantity});
    const response={mode:'PAPER' as const,orderId,status:'PENDING' as const};
    await finishIdempotent(client,actor.id,key,response,202);return response;
  });
}

export async function getOrder(pool: DbPool, fundId: string, orderId: string) {
  const result = await pool.query(
    `SELECT o.id, o.side, o.instrument_id, o.notional_usdc::text, o.requested_quantity::text, o.status,
            o.reject_reason, o.submitted_at, o.processed_at,o.reserved_cash_usdc::text,o.reserved_quantity::text,
            f.quantity::text, f.market_price_usdc::text, f.fill_price_usdc::text,
            f.fee_usdc::text,f.model_parameters,f.realized_pnl_usdc::text,f.cost_basis_sold_usdc::text, f.model_version, f.observation_id,o.progress_state,o.last_attempted_at,o.execution_attempts,
            p.source_at AS latest_source_at,clock_timestamp() AS db_now
     FROM orders o LEFT JOIN fills f ON f.order_id = o.id
     LEFT JOIN LATERAL(SELECT source_at FROM price_observations WHERE instrument_id=o.instrument_id
       AND (source='JUPITER_PRICE_V3' OR ($3::boolean AND source='DEV_SEED')) ORDER BY source_at DESC,received_at DESC LIMIT 1)p ON true
     WHERE o.fund_id = $1 AND o.id = $2`, [fundId, orderId,process.env.NODE_ENV!=='production'&&process.env.DEV_PRICE_SEED_ENABLED==='true'],
  );
  if (!result.rows[0]) throw new ApiFault(404, "order_not_found", "Order not found");
  const row=result.rows[0],now=row.db_now as Date,submitted=row.submitted_at as Date;
  const eligible=new Date(submitted.getTime()+paperPolicy.orderDelayMs),expires=new Date(submitted.getTime()+paperPolicy.orderTimeoutMs);
  const stage=row.status!=='PENDING'?row.status:now<eligible?'WAITING_DELAY':row.progress_state==='WAITING_VALUATION'?'WAITING_VALUATION':'WAITING_PRICE';
  const execution={stage,eligibleAt:eligible.toISOString(),expiresAt:expires.toISOString(),lastAttemptedAt:row.last_attempted_at?.toISOString()??null,
    attempts:row.execution_attempts,observationSourceAt:row.latest_source_at?.toISOString()??null,
    observationAgeMs:row.latest_source_at?Math.max(0,now.getTime()-row.latest_source_at.getTime()):null,
    reason:row.status==='REJECTED'?row.reject_reason:stage==='WAITING_DELAY'?'execution_delay':stage==='WAITING_PRICE'?'fresh_observation_required':stage==='WAITING_VALUATION'?'held_asset_price_required':null,
    retryAfterMs:row.status==='PENDING'?Math.max(500,Math.min(2000,eligible.getTime()-now.getTime())):0};
  const {db_now:_clock,latest_source_at:_source,...order}=row;
  return {...order,execution};
}

export async function cancelOrder(pool: DbPool, actor: Actor, fundId: string, orderId: string) {
  return inTransaction(pool, async (client) => {
    await client.query('SELECT id FROM funds WHERE id=$1 FOR NO KEY UPDATE',[fundId]);
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
      "UPDATE orders SET status = 'CANCELLED',progress_state='CANCELLED',progress_at=clock_timestamp(), processed_at = now() WHERE id = $1",
      [orderId],
    );
    await appendFundEvent(client, fundId, "order_cancelled", { orderId });
    return { mode: "PAPER" as const, orderId, status: "CANCELLED" as const };
  });
}
