import type { FastifyInstance } from 'fastify';
import type { DbPool } from '@socially/db';
import { requireActor } from './auth.js';
import { ApiFault } from './errors.js';
import { historySchema, type HistoryQuery } from './history.js';

export function registerPaperActivity(app: FastifyInstance, db: () => DbPool) {
  app.get<{ Querystring: HistoryQuery }>('/v1/me/paper-activity', { schema: historySchema }, async (request, reply) => {
    const actor = await requireActor(request, db());
    reply.header('cache-control', 'no-store');
    const limit = Number(request.query.limit ?? 20), after = request.query.after ?? null;
    // Keep the cursor timestamp in PostgreSQL: JS Date truncates microseconds.
    const anchor = `SELECT submitted_at AS at,id FROM orders WHERE captain_id=$1 AND id=$2
      UNION ALL SELECT created_at AS at,id FROM vault_operations WHERE user_id=$1 AND id=$2`;
    if (after && !(await db().query(anchor, [actor.id, after])).rowCount)
      throw new ApiFault(400, 'invalid_cursor', 'Activity cursor does not belong to your account');
    const rows = (await db().query(`WITH anchor AS (${anchor}), recent AS (
      (SELECT id,fund_id,side AS kind,status,reject_reason AS reason,instrument_id,
        notional_usdc::text AS amount_usdc,submitted_at AS at
       FROM orders WHERE captain_id=$1 AND ($2::uuid IS NULL OR (submitted_at,id)<(SELECT at,id FROM anchor LIMIT 1))
       ORDER BY submitted_at DESC,id DESC LIMIT $3)
      UNION ALL
      (SELECT id,fund_id,kind,'SUCCEEDED' AS status,NULL AS reason,NULL AS instrument_id,
        amount_usdc::text,created_at AS at
       FROM vault_operations WHERE user_id=$1 AND ($2::uuid IS NULL OR (created_at,id)<(SELECT at,id FROM anchor LIMIT 1))
       ORDER BY created_at DESC,id DESC LIMIT $3)
    ) SELECT r.*,f.name AS vault_name,i.symbol,fl.quantity::text,fl.fee_usdc::text,
        fl.fill_price_usdc::text
      FROM recent r JOIN funds f ON f.id=r.fund_id LEFT JOIN instruments i ON i.id=r.instrument_id
      LEFT JOIN fills fl ON fl.order_id=r.id
      ORDER BY r.at DESC,r.id DESC LIMIT $3`, [actor.id, after, limit+1])).rows;
    return { mode: 'PAPER', items: rows.slice(0,limit), nextCursor: rows.length>limit ? rows[limit-1]!.id : null };
  });
}
