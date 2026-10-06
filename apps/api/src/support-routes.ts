import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { inTransaction, type DbPool } from "@socially/db";
import { requireActor } from "./auth.js";
import { ApiFault } from "./errors.js";

export function registerSupportRoutes(app: FastifyInstance, db: () => DbPool) {
  app.post<{ Body: { message: string; appVersion: string; platform: string } }>("/v0/me/support-requests", {
    schema: { body: { type: "object", required: ["message", "appVersion", "platform"], additionalProperties: false,
      properties: { message: { type: "string", minLength: 10, maxLength: 2000 },
        appVersion: { type: "string", minLength: 1, maxLength: 40 },
        platform: { type: "string", enum: ["android", "ios", "web"] } } } },
  }, async (request, reply) => {
    const actor = await requireActor(request, db());
    const message = request.body.message.trim();
    if (message.length < 10) throw new ApiFault(400, "invalid_support_message", "Add at least 10 characters describing the issue");
    const result = await inTransaction(db(), async client => {
      // Serialize submissions for this account so concurrent requests cannot bypass the limit.
      await client.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [actor.id]);
      const count = (await client.query<{ count: string }>("SELECT count(*)::text FROM support_requests WHERE user_id=$1 AND created_at>now()-interval '1 hour'", [actor.id])).rows[0]!;
      if (Number(count.count) >= 5) throw new ApiFault(429, "support_rate_limited", "You have sent 5 requests this hour. Please try again later.");
      return (await client.query<{ id: string; status: string }>(
        "INSERT INTO support_requests(id,user_id,message,app_version,platform) VALUES($1,$2,$3,$4,$5) RETURNING id,status",
        [randomUUID(), actor.id, message, request.body.appVersion, request.body.platform])).rows[0]!;
    });
    reply.code(201).header("cache-control", "no-store");
    return result;
  });
}
