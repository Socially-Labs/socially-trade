import type { FastifyInstance } from "fastify";
import { inTransaction, orderReservations, type DbPool } from "@socially/db";
import { Amount, fixed, paperPolicy } from "@socially/domain";
import { registeredInstruments, assetTradeReason } from "@socially/market-data/registry";
import { currentPrice, type MarketEvent } from "@socially/market-stream";
import { requireActor } from "./auth.js";
import { ApiFault } from "./errors.js";
import { RevisionCache } from './revision-cache.js';
import { testVaultActivationEnabled } from './test-vault-activation.js';

export function registerTradingContextRoutes(app: FastifyInstance, db: () => DbPool) {
  const cache=new RevisionCache();app.addHook('onClose',async()=>cache.close());
  app.get("/v0/me/captain/funds", async (request, reply) => {
    const actor = await requireActor(request, db()); reply.header("cache-control", "no-store");
    const funds = (await db().query(`SELECT f.id,f.name,f.status,t.ends_at AS "trialEnd"
      FROM funds f JOIN trials t ON t.fund_id=f.id WHERE f.captain_id=$1
      ORDER BY f.created_at DESC LIMIT 100`, [actor.id])).rows;
    return { mode: "PAPER", funds };
  });
  for (const version of [0,1]) app.get<{ Params: { fundId: string }; Querystring: {instrumentId?:string} }>(version === 0 ? "/v0/funds/:fundId/trading-context" : "/v1/vaults/:fundId/trading-context", async (request, reply) => {
    const actor = await requireActor(request, db()); reply.header("cache-control", "no-store");
    const selected=request.query.instrumentId;
    if(selected!==undefined&&(typeof selected!=='string'||selected.length>64))throw new ApiFault(400,'invalid_instrument','Invalid instrument');
    // Single indexed probe binds permission and all dependencies to this cache key.
    const probe=(await db().query(`SELECT f.captain_id,f.event_sequence::text,f.status,f.cash_usdc::text,f.total_shares::text,
      COALESCE(t.ends_at,r.trading_ends_at) AS ends_at,r.phase,p.version,p.universe_mode,p.allowed_instruments,p.max_order_bps,p.max_position_bps,
      (SELECT jsonb_agg(jsonb_build_array(i.id,i.active,i.eligibility,i.eligibility_reason,m.sequence,m.payload->'price',pos.quantity,pos.cost_basis_usdc) ORDER BY i.id)
        FROM instruments i LEFT JOIN market_latest m ON m.instrument_id=i.id LEFT JOIN positions pos ON pos.instrument_id=i.id AND pos.fund_id=f.id
        WHERE i.id IN(SELECT unnest(p.allowed_instruments) UNION SELECT instrument_id FROM positions WHERE fund_id=f.id AND quantity>0 UNION SELECT $3::text)) AS dependencies
      FROM funds f LEFT JOIN trials t ON t.fund_id=f.id LEFT JOIN vault_rounds r ON r.fund_id=f.id
      JOIN LATERAL(SELECT * FROM fund_policy_versions WHERE fund_id=f.id ORDER BY version DESC LIMIT 1)p ON true
      WHERE f.id=$1 AND f.round_model_version=$2`,[request.params.fundId,version===0?1:2,selected??null])).rows[0];
    if(!probe)throw new ApiFault(404,'fund_not_found','Fund not found');
    if(probe.captain_id!==actor.id)throw new ApiFault(403,'captain_required',"Only this fund's captain can view trading context");
    return cache.read([actor.id,version,request.params.fundId,selected,process.env.PAPER_DYNAMIC_MARKETS_ENABLED,testVaultActivationEnabled(),probe],()=>inTransaction(db(), async client => {
      await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await client.query("SET LOCAL statement_timeout='5s'");
      const fund = (await client.query<{ id: string; captain_id: string; name: string; status: string; cash_usdc: string; ends_at: Date; round_phase: string | null; event_sequence:string }>(`
        SELECT f.id,f.captain_id,f.name,f.status,f.cash_usdc::text,f.event_sequence::text,COALESCE(t.ends_at,r.trading_ends_at) AS ends_at,r.phase AS round_phase FROM funds f
        LEFT JOIN trials t ON t.fund_id=f.id LEFT JOIN vault_rounds r ON r.fund_id=f.id WHERE f.id=$1 AND f.round_model_version=$2`, [request.params.fundId,version === 0 ? 1 : 2])).rows[0];
      if (!fund) throw new ApiFault(404, "fund_not_found", "Fund not found");
      if (fund.captain_id !== actor.id) throw new ApiFault(403, "captain_required", "Only this fund's captain can view trading context");
      const policy = (await client.query<{ max_order_bps: number; max_position_bps: number; allowed_instruments: string[]; universe_mode:"LEGACY_ALLOWLIST"|"DYNAMIC_SPOT"; version:number }>(
        "SELECT * FROM fund_policy_versions WHERE fund_id=$1 ORDER BY version DESC LIMIT 1", [fund.id])).rows[0]!;
      const selectedId = request.query.instrumentId;
      if(selectedId!==undefined && (typeof selectedId!=='string'||selectedId.length>64))throw new ApiFault(400,'invalid_instrument','Invalid instrument');
      const positions = (await client.query<{ instrument_id: string; quantity: string; cost_basis_usdc: string }>(
        "SELECT instrument_id,quantity::text,cost_basis_usdc::text FROM positions WHERE fund_id=$1 AND quantity>0 ORDER BY instrument_id", [fund.id])).rows;
      const ids = [...new Set([...policy.allowed_instruments,...positions.map(p=>p.instrument_id),...(selectedId?[selectedId]:[])])];
      const registry = await registeredInstruments(client,ids);
      const byId = new Map(registry.map(t=>[t.id,t]));
      const marks = new Map((await client.query<{ payload: MarketEvent }>("SELECT payload FROM market_latest WHERE instrument_id=ANY($1::text[])",[ids])).rows.map(row => [row.payload.price.instrumentId, currentPrice(row.payload.price)]));
      let nav = new Amount(fund.cash_usdc), valued = true;
      const holdings = positions.map(position => {
        const mark = marks.get(position.instrument_id), token = byId.get(position.instrument_id);
        const value = mark?.status === "CURRENT" && mark.priceUsdc ? new Amount(position.quantity).mul(mark.priceUsdc) : null;
        if (value) nav = nav.plus(value); else valued = false;
        return { instrumentId: position.instrument_id, mint: token?.mint ?? null, symbol: token?.symbol ?? position.instrument_id,
          quantity: position.quantity, costBasisUsdc: position.cost_basis_usdc, valueUsdc: value ? fixed(value, 18) : null,unrealizedPnlUsdc:value?fixed(value.minus(position.cost_basis_usdc),18):null };
      });
      const usable = ["ACTIVE","FROZEN"].includes(fund.status) && (fund.round_phase === null || fund.round_phase === "ACTIVE") && fund.ends_at.getTime() > Date.now();
      const pending = (await client.query("SELECT id,side,instrument_id AS \"instrumentId\",notional_usdc::text AS \"notionalUsdc\" FROM orders WHERE fund_id=$1 AND status='PENDING' ORDER BY submitted_at LIMIT 100", [fund.id])).rows;
      const reservationRows=(await client.query<{instrument_id:string;cash:string;quantity:string}>(`SELECT instrument_id,sum(reserved_cash_usdc)::text AS cash,sum(reserved_quantity)::text AS quantity FROM orders WHERE fund_id=$1 AND status='PENDING' GROUP BY instrument_id`,[fund.id])).rows;
      const reservedCash=reservationRows.reduce((sum,row)=>sum.plus(row.cash),new Amount(0)).toString();
      const reservations=registry.map(token=>{const row=reservationRows.find(row=>row.instrument_id===token.id);return {quantity:row?.quantity??'0',exposure:row?.cash??'0'};});
      const availableCash=Amount.max(0,new Amount(fund.cash_usdc).minus(reservedCash));
      const limits = registry.map((token,index) => {
        const reserved=reservations[index]!;
        const mark = marks.get(token.id);
        const held = holdings.find(position => position.instrumentId === token.id);
        const buyReason = assetTradeReason(token,policy,"BUY",!!held), sellReason = assetTradeReason(token,policy,"SELL",!!held);
        const reason = !usable ? "fund_not_tradable" : !valued ? "valuation_unavailable" : mark?.status !== "CURRENT" ? "price_unavailable" : null;
        const cap = valued ? Amount.min(paperPolicy.maxOrderUsdc, nav.mul(policy.max_order_bps).div(10000)) : new Amount(0);
        const sellCap = held?.valueUsdc && new Amount(held.valueUsdc).lt(1) ? new Amount(held.valueUsdc) : cap;
        const headroom = valued ? Amount.max(0, nav.mul(policy.max_position_bps).div(10000).minus(held?.valueUsdc ?? 0).minus(reserved.exposure)) : new Amount(0);
        return { instrumentId: token.id, canBuy: !buyReason && !reason && fund.status === "ACTIVE", canSell: !sellReason && !reason && !!held,
          reason: reason ?? buyReason ?? (fund.status === "FROZEN" ? "buys_frozen" : null),
          maxBuyNotionalUsdc: !buyReason && !reason && fund.status === "ACTIVE" ? fixed(Amount.min(cap, availableCash, headroom), 6) : "0.000000",
          maxSellNotionalUsdc: !sellReason && !reason && held ? fixed(Amount.min(sellCap, Amount.max(0,new Amount(held.quantity).minus(reserved.quantity)).mul(mark!.priceUsdc!)), 6) : "0.000000",
          maxSellQuantity: !sellReason && !reason && held && mark?.priceUsdc
            ? fixed(Amount.min(Amount.max(0,new Amount(held.quantity).minus(reserved.quantity)), sellCap.div(mark.priceUsdc)), token.decimals) : fixed(0, token.decimals) };
      });
      const value={ mode: "PAPER", fund: { id: fund.id, name: fund.name, status: fund.status, trialEnd: fund.ends_at.toISOString(), ...(fund.round_phase ? {phase:fund.round_phase} : {}) },
        cashUsdc: fixed(fund.cash_usdc,6), availableCashUsdc:fixed(availableCash,6), reservedCashUsdc:fixed(reservedCash,6), navUsdc: valued ? fixed(nav, 18) : null, holdings, policy: {
          maxOrderBps: policy.max_order_bps, maxPositionBps: policy.max_position_bps, allowedInstruments: policy.allowed_instruments,universeMode:policy.universe_mode,version:policy.version },
        testActivationAllowed: version===1 && fund.round_phase==='FUNDRAISING' && testVaultActivationEnabled(),
        accountingRevision: fund.event_sequence, limits, pending, capacityIsEstimate: true, asOf: new Date().toISOString() };
      const expiry=[...marks.values()].filter(m=>m.status==='CURRENT').flatMap(m=>[m.sourceAt?Date.parse(m.sourceAt)+paperPolicy.priceMaxAgeMs:0,Date.parse(m.receivedAt)+paperPolicy.priceMaxAgeMs]);
      return {value,validUntil:Math.min(Date.now()+1000,fund.ends_at.getTime(),...expiry)};
    }));
  });
}
