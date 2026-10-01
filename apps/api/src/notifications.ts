import type { FastifyInstance } from "fastify";
import type { DbPool } from "@socially/db";
import { requireActor } from "./auth.js";
import { ApiFault } from "./errors.js";
import { sequenceCursor } from "./request.js";

export function registerNotificationRoutes(app: FastifyInstance, db: () => DbPool): void {
  app.get<{ Querystring: { after?: string } }>("/v0/me/notifications", async (request) => {
    const actor = await requireActor(request, db());
    const after = sequenceCursor(request.query.after);
    const result = await db().query<{
      id: string; fund_id: string; type: string; payload: Record<string, unknown>;
      created_at: Date; read_at: Date | null;
    }>(
      `SELECT id::text, fund_id, type, payload, created_at, read_at
       FROM notifications WHERE user_id = $1 AND id > $2
       ORDER BY notifications.id ASC LIMIT 100`,
      [actor.id, after],
    );
    return { mode: "PAPER", notifications: result.rows.map((row) => ({
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
