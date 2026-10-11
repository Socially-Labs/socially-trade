import type { FastifyInstance } from "fastify";
import type { DbPool } from "@socially/db";
import { requireActor } from "./auth.js";
import { ApiFault } from "./errors.js";

export interface HistoryQuery { after?: string; limit?: string }
export const historySchema = {
  querystring: { type: "object", additionalProperties: false, properties: {
    after: { type: "string", format: "uuid" },
    limit: { type: "string", pattern: "^([1-9]|[1-9][0-9]|100)$" },
  } },
} as const;

function page<T extends { id: string }>(rows: T[], limit: number) {
  const items = rows.slice(0, limit);
  return { items, nextCursor: rows.length > limit ? items.at(-1)!.id : null };
}

/** Cursor anchors retain PostgreSQL timestamp precision and scope to the same owner/fund. */
export async function orderHistory(pool: DbPool, scope: "fund" | "captain", id: string, query: HistoryQuery) {
  const field = scope === "fund" ? "fund_id" : "captain_id";
  const limit = Number(query.limit ?? "100");
  if (query.after && !(await pool.query(`SELECT 1 FROM orders WHERE id=$1 AND ${field}=$2`, [query.after, id])).rowCount) {
    throw new ApiFault(400, "invalid_cursor", "Order cursor does not belong to this history");
  }
  const rows = await pool.query<{ id: string }>(`SELECT o.id,o.fund_id,o.side,o.instrument_id,
    o.notional_usdc::text,o.status,o.reject_reason,o.submitted_at,o.processed_at,
    fl.quantity::text,fl.market_price_usdc::text,fl.fill_price_usdc::text,fl.fee_usdc::text,
    fl.model_version,fl.model_parameters,fl.observation_id,fl.realized_pnl_usdc::text,fl.cost_basis_sold_usdc::text
    FROM orders o LEFT JOIN fills fl ON fl.order_id=o.id
    WHERE o.${field}=$1 AND ($2::uuid IS NULL OR (o.submitted_at,o.id)<
      (SELECT submitted_at,id FROM orders WHERE id=$2 AND ${field}=$1))
    ORDER BY o.submitted_at DESC,o.id DESC LIMIT $3`, [id, query.after ?? null, limit + 1]);
  const result = page(rows.rows, limit);
  return { orders: result.items, nextCursor: result.nextCursor };
}

const personalEvents = `SELECT e.id,e.fund_id,e.sequence::text,e.recorded_at,e.type,
  CASE WHEN e.type='crew_joined' THEN e.payload->>'amountUsdc'
       ELSE coalesce(payout.value->>'payoutUsdc',e.payload->>'payoutUsdc') END AS amount_usdc,
  coalesce(payout.value->>'shares',e.payload->>'shares') AS shares,
  CASE WHEN e.type='crew_left' THEN e.payload->>'exitCostUsdc' ELSE NULL END AS exit_cost_usdc
  FROM fund_events e
  LEFT JOIN LATERAL (SELECT value FROM jsonb_array_elements(
    CASE WHEN e.type='trial_completed' THEN e.payload->'payouts' ELSE '[]'::jsonb END)
    WHERE value->>'userId'=$1) payout ON true
  WHERE (e.type IN ('crew_joined','crew_left') AND e.payload->>'userId'=$1)
     OR (e.type='trial_completed' AND payout.value IS NOT NULL
         AND EXISTS(SELECT 1 FROM funds f WHERE f.id=e.fund_id AND f.captain_id<>$1::uuid))`;

export function registerHistoryRoutes(app: FastifyInstance, db: () => DbPool): void {
  app.get<{ Params: { captainId: string }; Querystring: HistoryQuery }>(
    "/v0/captains/:captainId/orders", { schema: historySchema }, async request => {
      await requireActor(request,db());
      const captainId = request.params.captainId;
      if (!(await db().query("SELECT 1 FROM users u WHERE u.id=$1 AND (u.role='captain' OR EXISTS(SELECT 1 FROM funds f WHERE f.captain_id=u.id))", [captainId])).rowCount)
        throw new ApiFault(404, "captain_not_found", "Captain not found");
      return { mode: "PAPER", captainId, ...await orderHistory(db(), "captain", captainId, request.query) };
    });
  app.get<{ Params: { captainId: string } }>("/v0/captains/:captainId/trade-statistics", async request => {
    const captainId = request.params.captainId;
    const result = await db().query(`SELECT c.id AS user_id,
      (SELECT count(*)::integer FROM funds WHERE captain_id=c.id) AS fund_count,
      count(o.id)::integer AS submitted_orders,
      count(o.id) FILTER(WHERE o.status IN ('FILLED','PARTIALLY_FILLED'))::integer AS completed_trades,
      count(o.id) FILTER(WHERE o.status='PENDING')::integer AS pending,
      count(o.id) FILTER(WHERE o.status='FILLED')::integer AS filled,
      count(o.id) FILTER(WHERE o.status='PARTIALLY_FILLED')::integer AS partially_filled,
      count(o.id) FILTER(WHERE o.status='REJECTED')::integer AS rejected,
      count(o.id) FILTER(WHERE o.status='CANCELLED')::integer AS cancelled,
      count(o.id) FILTER(WHERE o.side='BUY' AND o.status IN ('FILLED','PARTIALLY_FILLED'))::integer AS completed_buys,
      count(o.id) FILTER(WHERE o.side='SELL' AND o.status IN ('FILLED','PARTIALLY_FILLED'))::integer AS completed_sells,
      coalesce(sum(fl.quantity*fl.fill_price_usdc),0)::text AS executed_value_usdc,
      coalesce(sum(fl.fee_usdc),0)::text AS trading_fee_usdc,
      min(o.processed_at) FILTER(WHERE fl.order_id IS NOT NULL) AS first_trade_at,
      max(o.processed_at) FILTER(WHERE fl.order_id IS NOT NULL) AS last_trade_at
      FROM users c LEFT JOIN orders o ON o.captain_id=c.id
      LEFT JOIN fills fl ON fl.order_id=o.id WHERE c.id=$1 AND (c.role='captain' OR EXISTS(SELECT 1 FROM funds f WHERE f.captain_id=c.id)) GROUP BY c.id`, [captainId]);
    if (!result.rows[0]) throw new ApiFault(404, "captain_not_found", "Captain not found");
    return { mode: "PAPER", captainId, statistics: result.rows[0],
      methodology: "All Captain funds, including completed trials. Completed trades are filled or partially filled orders. Executed value is fill quantity times fill price, excluding fees; independent fund returns are not combined." };
  });
  app.get<{ Querystring: HistoryQuery }>("/v0/me/crew-transactions", { schema: historySchema }, async request => {
    const actor = await requireActor(request, db());
    const limit = Number(request.query.limit ?? "100");
    const cursor = request.query.after ?? null;
    if (cursor && !(await db().query(`WITH personal AS (${personalEvents}) SELECT 1 FROM personal WHERE id=$2`, [actor.id, cursor])).rowCount)
      throw new ApiFault(400, "invalid_cursor", "Transaction cursor does not belong to your Crew history");
    const rows = await db().query<{ id: string }>(`WITH personal AS (${personalEvents})
      SELECT * FROM personal WHERE $2::uuid IS NULL OR (recorded_at,id)<
        (SELECT recorded_at,id FROM personal WHERE id=$2)
      ORDER BY recorded_at DESC,id DESC LIMIT $3`, [actor.id, cursor, limit + 1]);
    const result = page(rows.rows, limit);
    return { mode: "PAPER", transactions: result.items, nextCursor: result.nextCursor };
  });
}
