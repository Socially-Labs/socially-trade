import type { FastifyInstance } from "fastify";
import { inTransaction, type DbPool } from "@socially/db";
import { Amount, fixed } from "@socially/domain";
import { supportedById } from "@socially/market-data/catalog";
import { currentPrice, type MarketEvent } from "@socially/market-stream";
import { requireActor } from "./auth.js";
import { ApiFault } from "./errors.js";

export function registerTradingContextRoutes(app: FastifyInstance, db: () => DbPool) {
  app.get("/v0/me/captain/funds", async (request, reply) => {
    const actor = await requireActor(request, db()); reply.header("cache-control", "no-store");
    const funds = (await db().query(`SELECT f.id,f.name,f.status,t.ends_at AS "trialEnd"
      FROM funds f JOIN trials t ON t.fund_id=f.id WHERE f.captain_id=$1
      ORDER BY f.created_at DESC LIMIT 100`, [actor.id])).rows;
    return { mode: "PAPER", funds };
  });
  app.get<{ Params: { fundId: string } }>("/v0/funds/:fundId/trading-context", async (request, reply) => {
    const actor = await requireActor(request, db()); reply.header("cache-control", "no-store");
    return inTransaction(db(), async client => {
      await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const fund = (await client.query<{ id: string; captain_id: string; name: string; status: string; cash_usdc: string; ends_at: Date }>(`
        SELECT f.id,f.captain_id,f.name,f.status,f.cash_usdc::text,t.ends_at FROM funds f
        JOIN trials t ON t.fund_id=f.id WHERE f.id=$1`, [request.params.fundId])).rows[0];
      if (!fund) throw new ApiFault(404, "fund_not_found", "Fund not found");
      if (fund.captain_id !== actor.id) throw new ApiFault(403, "captain_required", "Only this fund's captain can view trading context");
      const policy = (await client.query<{ max_order_bps: number; max_position_bps: number; allowed_instruments: string[] }>(
        "SELECT * FROM fund_policy_versions WHERE fund_id=$1 ORDER BY version DESC LIMIT 1", [fund.id])).rows[0]!;
      const marks = new Map((await client.query<{ payload: MarketEvent }>("SELECT payload FROM market_latest")).rows.map(row => [row.payload.price.instrumentId, currentPrice(row.payload.price)]));
      const active = new Map((await client.query<{ id: string; active: boolean }>("SELECT id,active FROM instruments")).rows.map(row => [row.id,row.active]));
      const positions = (await client.query<{ instrument_id: string; quantity: string; cost_basis_usdc: string }>(
        "SELECT instrument_id,quantity::text,cost_basis_usdc::text FROM positions WHERE fund_id=$1 AND quantity>0 ORDER BY instrument_id", [fund.id])).rows;
      let nav = new Amount(fund.cash_usdc), valued = true;
      const holdings = positions.map(position => {
        const mark = marks.get(position.instrument_id), token = supportedById.get(position.instrument_id);
        const value = mark?.status === "CURRENT" && mark.priceUsdc ? new Amount(position.quantity).mul(mark.priceUsdc) : null;
        if (value) nav = nav.plus(value); else valued = false;
        return { instrumentId: position.instrument_id, mint: token?.mint ?? null, symbol: token?.symbol ?? position.instrument_id,
          quantity: position.quantity, costBasisUsdc: position.cost_basis_usdc, valueUsdc: value ? fixed(value, 18) : null };
      });
      const usable = fund.status !== "COMPLETED" && fund.ends_at.getTime() > Date.now();
      const pending = (await client.query("SELECT id,side,instrument_id AS \"instrumentId\",notional_usdc::text AS \"notionalUsdc\" FROM orders WHERE fund_id=$1 AND status='PENDING' ORDER BY submitted_at LIMIT 100", [fund.id])).rows;
      const limits = [...supportedById.values()].map(token => {
        const mark = marks.get(token.id), allowed = token.tradable && active.get(token.id) === true && policy.allowed_instruments.includes(token.id);
        const held = holdings.find(position => position.instrumentId === token.id);
        const reason = !allowed ? "asset_not_allowed" : !usable ? "fund_not_tradable" : !valued ? "valuation_unavailable" : mark?.status !== "CURRENT" ? "price_unavailable" : null;
        const cap = valued ? Amount.min(1000, nav.mul(policy.max_order_bps).div(10000)) : new Amount(0);
        const headroom = valued ? Amount.max(0, nav.mul(policy.max_position_bps).div(10000).minus(held?.valueUsdc ?? 0)) : new Amount(0);
        return { instrumentId: token.id, canBuy: !reason && fund.status === "ACTIVE", canSell: !reason && !!held,
          reason: reason ?? (fund.status === "FROZEN" ? "buys_frozen" : null),
          maxBuyNotionalUsdc: !reason && fund.status === "ACTIVE" ? fixed(Amount.min(cap, fund.cash_usdc, headroom), 6) : "0.000000",
          maxSellNotionalUsdc: !reason && held ? fixed(Amount.min(cap, held.valueUsdc ?? 0), 6) : "0.000000",
          maxSellQuantity: !reason && held && mark?.priceUsdc
            ? fixed(Amount.min(held.quantity, cap.div(mark.priceUsdc)), token.decimals) : fixed(0, token.decimals) };
      });
      return { mode: "PAPER", fund: { id: fund.id, name: fund.name, status: fund.status, trialEnd: fund.ends_at.toISOString() },
        cashUsdc: fund.cash_usdc, navUsdc: valued ? fixed(nav, 18) : null, holdings, policy: {
          maxOrderBps: policy.max_order_bps, maxPositionBps: policy.max_position_bps, allowedInstruments: policy.allowed_instruments },
        limits, pending, capacityIsEstimate: true, asOf: new Date().toISOString() };
    });
  });
}
