import type { FastifyInstance } from "fastify";
import type { DbPool } from "@socially/db";
import { requireActor } from "./auth.js";
import { ApiFault } from "./errors.js";
import { sequenceCursor } from "./request.js";

export function registerNotificationRoutes(app: FastifyInstance, db: () => DbPool): void {
  app.get<{ Querystring: { after?: string; before?: string } }>("/v0/me/notifications", async (request, reply) => {
    reply.header("cache-control", "no-store");
    const actor = await requireActor(request, db());
    const after = sequenceCursor(request.query.after);
    const before = sequenceCursor(request.query.before);
    if (after && before) throw new ApiFault(400, "invalid_cursor", "Use after or before, not both");
    const incremental = request.query.after !== undefined;

    const result = await db().query<{
      id: string; fund_id: string; type: string; payload: Record<string, unknown>;
      created_at: Date; read_at: Date | null;
    }>(
      `SELECT id::text, fund_id, type, payload, created_at, read_at
       FROM notifications WHERE user_id = $1
       AND ($2::bigint = 0 OR id > $2) AND ($3::bigint = 0 OR id < $3)
       ORDER BY ${incremental ? 'notifications.id ASC' : 'notifications.id DESC'} LIMIT 101`,
      [actor.id, after, before],
    );
    return { mode: "PAPER", nextCursor: !incremental && result.rows.length > 100 ? result.rows[99]!.id : null,
      hasMore: result.rows.length > 100,
      notifications: result.rows.slice(0, 100).map((row) => ({
      id: row.id, fundId: row.fund_id, type: row.type, payload: row.payload,
      createdAt: row.created_at.toISOString(), readAt: row.read_at?.toISOString() ?? null,
    })) };
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
