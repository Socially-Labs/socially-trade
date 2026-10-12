import type { FastifyInstance } from "fastify";
import type { DbPool } from "@socially/db";
import { requireActor } from "./auth.js";
import { ApiFault } from "./errors.js";
import { sequenceCursor } from "./request.js";

export function registerNotificationRoutes(app: FastifyInstance, db: () => DbPool): void {
  app.get<{ Querystring: { after?: string; before?: string; afterCursor?: string; beforeCursor?: string; cursorVersion?: string } }>("/v0/me/notifications", async (request, reply) => {
    reply.header("cache-control", "no-store");
    const actor = await requireActor(request, db());
    const after = sequenceCursor(request.query.afterCursor ?? request.query.after);
    if (request.query.afterCursor !== undefined && request.query.after !== undefined) throw new ApiFault(400,"invalid_cursor","Choose one cursor version");
    const modern = request.query.cursorVersion === "2" || request.query.afterCursor !== undefined || request.query.beforeCursor !== undefined;
    const column = modern ? "stream_sequence" : "id";
    const before = sequenceCursor(request.query.beforeCursor ?? request.query.before);
    if ((request.query.after !== undefined || request.query.afterCursor !== undefined) && (request.query.before !== undefined || request.query.beforeCursor !== undefined)) throw new ApiFault(400, "invalid_cursor", "Use after or before, not both");
    const incremental = request.query.after !== undefined || request.query.afterCursor !== undefined;

    const result = await db().query<{
      id: string; stream_sequence: string; fund_id: string | null; type: string; payload: Record<string, unknown>;
      created_at: Date; read_at: Date | null;
    }>(
      `SELECT id::text, stream_sequence::text, fund_id, type, payload, created_at, read_at
       FROM notifications WHERE user_id = $1 AND ${modern ? 'true' : 'fund_id IS NOT NULL'}
       AND ($2::bigint = 0 OR ${column} > $2) AND ($3::bigint = 0 OR ${column} < $3)
       ORDER BY ${incremental ? `notifications.${column} ASC` : `notifications.${column} DESC`} LIMIT 101`,
      [actor.id, after, before],
    );
    return { mode: "PAPER", nextCursor: !incremental && result.rows.length > 100 ? (modern ? result.rows[99]!.stream_sequence : result.rows[99]!.id) : null,
      hasMore: result.rows.length > 100,
      notifications: result.rows.slice(0, 100).map((row) => ({
      id: row.id, cursor: row.stream_sequence, fundId: row.fund_id, type: row.type, payload: row.payload,
      createdAt: row.created_at.toISOString(), readAt: row.read_at?.toISOString() ?? null,
    })) };
  });

  app.get<{Params:{notificationId:string}}>('/v0/me/notifications/:notificationId',async(request,reply)=>{
    reply.header('cache-control','no-store');
    const actor=await requireActor(request,db()),id=sequenceCursor(request.params.notificationId);
    const row=(await db().query('SELECT id::text,stream_sequence::text,fund_id,type,payload,created_at,read_at FROM notifications WHERE id=$1 AND user_id=$2',[id,actor.id])).rows[0];
    if(!row)throw new ApiFault(404,'notification_not_found','Notification not found');
    return {id:row.id,cursor:row.stream_sequence,fundId:row.fund_id,type:row.type,payload:row.payload,createdAt:row.created_at.toISOString(),readAt:row.read_at?.toISOString()??null};
  });
  app.post<{ Params: { notificationId: string } }>(
    "/v0/me/notifications/:notificationId/read", async (request) => {
      const actor = await requireActor(request, db());
      const notificationId = sequenceCursor(request.params.notificationId);
      if (notificationId === 0) throw new ApiFault(400, "invalid_identifier", "Invalid notification ID");
      const updated = await db().query<{ id: string; read_at: Date }>(
        `UPDATE notifications SET read_at = COALESCE(read_at, now())
         WHERE id = $1 AND user_id = $2 RETURNING id::text, read_at`,
        [notificationId, actor.id],
      );
      if (!updated.rows[0]) throw new ApiFault(404, "notification_not_found", "Notification not found");
      return { mode: "PAPER", id: updated.rows[0].id, readAt: updated.rows[0].read_at.toISOString() };
    },
  );
}
