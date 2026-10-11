import type { FastifyInstance } from "fastify";
import type { DbPool } from "@socially/db";
import { requireActor } from "./auth.js";
import { accountView } from "./user-profiles.js";
export function registerAuthRoutes(
  app: FastifyInstance, db: () => DbPool,
): void {
  app.post<{ Body: { walletAddress?: string } }>("/v0/auth/privy", {
    schema: { body: { type: "object", additionalProperties: false,
      properties: {} } },
    // The body is optional. A request without a body validates as {}.
    preValidation: async (request) => { request.body ??= {}; },
  }, async (request, reply) => {
    const actor = await requireActor(request, db());
    reply.header("cache-control", "no-store");
    const response = {
      mode: "PAPER", provider: "privy", privyUserId: actor.subject,
      user: accountView(actor),
    };
    return response;
  });
}
