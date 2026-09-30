import type { FastifyInstance } from "fastify";
import type { DbPool } from "@socially/db";
import { requireActor } from "./auth.js";
import { myPositions } from "./crew.js";
import { ApiFault } from "./errors.js";

export function registerAccountRoutes(app: FastifyInstance, db: () => DbPool): void {
  app.get("/v0/me", async (request) => {
    const actor = await requireActor(request, db());
    return {
      id: actor.id,
      displayName: actor.displayName,
      mode: "PAPER",
      paperCash: { value: actor.paperCash, asset: "USDC" },
    };
  });

  app.get("/v0/me/paper-balance", async (request) => {
    const actor = await requireActor(request, db());
    return { mode: "PAPER", available: { value: actor.paperCash, asset: "USDC" } };
  });

  app.get("/v0/me/paper-positions", async (request) => {
    const actor = await requireActor(request, db());
    return { mode: "PAPER", positions: await myPositions(db(), actor.id) };
  });

  app.post<{ Body: { handle: string; bio?: string } }>("/v0/captains", {
    schema: {
      body: {
        type: "object",
        required: ["handle"],
        additionalProperties: false,
        properties: {
          handle: { type: "string", pattern: "^[a-z0-9_]{3,24}$" },
          bio: { type: "string", maxLength: 500 },
        },
      },
    },
  }, async (request, reply) => {
    const actor = await requireActor(request, db());
    const handle = request.body.handle;
    const bio = request.body.bio ?? "";
    const existing = await db().query<{ handle: string; bio: string }>(
      "SELECT handle, bio FROM captain_profiles WHERE user_id = $1",
      [actor.id],
    );
    if (existing.rows[0]) {
      if (existing.rows[0].handle !== handle) {
        throw new ApiFault(409, "captain_profile_exists", "Captain profile already exists");
      }
      return { userId: actor.id, handle: existing.rows[0].handle, bio: existing.rows[0].bio };
    }
    await db().query(
      "INSERT INTO captain_profiles (user_id, handle, bio) VALUES ($1, $2, $3)",
      [actor.id, handle, bio],
    );
    reply.code(201);
    return { userId: actor.id, handle, bio };
  });

  app.get<{ Params: { captainId: string } }>("/v0/captains/:captainId", async (request) => {
    const result = await db().query<{ user_id: string; handle: string; bio: string }>(
      "SELECT user_id, handle, bio FROM captain_profiles WHERE user_id = $1",
      [request.params.captainId],
    );
    if (!result.rows[0]) throw new ApiFault(404, "captain_not_found", "Captain not found");
    return { userId: result.rows[0].user_id, handle: result.rows[0].handle, bio: result.rows[0].bio };
  });
}
