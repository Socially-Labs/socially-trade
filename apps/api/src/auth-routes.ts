import type { FastifyInstance } from "fastify";
import type { DbPool } from "@socially/db";
import { requireActor } from "./auth.js";

export function registerAuthRoutes(app: FastifyInstance, db: () => DbPool): void {
  app.post("/v0/auth/privy", {
    schema: { body: { type: "object", additionalProperties: false, properties: {} } },
  }, async (request, reply) => {
    const actor = await requireActor(request, db());
    reply.header("cache-control", "no-store");
    return {
      mode: "PAPER", provider: "privy", privyUserId: actor.subject,
      user: { id: actor.id, displayName: actor.displayName,
        paperCash: { value: actor.paperCash, asset: "USDC" } },
    };
  });
}
