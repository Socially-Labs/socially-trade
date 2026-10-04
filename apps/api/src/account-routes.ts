import type { FastifyInstance } from "fastify";
import type { DbPool } from "@socially/db";
import { requireActor } from "./auth.js";
import { myPositions } from "./crew.js";
import { ApiFault } from "./errors.js";
import { registerCaptainUploadRoutes } from "./captain-uploads.js";
import { captainProfile, registerCaptainProfileRoutes, type CaptainProfileRow } from "./captain-profiles.js";
import { CaptainHandleIndex, captainHandleSchema, insertCaptain } from "./captain-handles.js";

export function registerAccountRoutes(app: FastifyInstance, db: () => DbPool): void {
  registerCaptainProfileRoutes(app, db);
  registerCaptainUploadRoutes(app, db);
  let handleIndex: CaptainHandleIndex | undefined;
  const handles = () => handleIndex ??= new CaptainHandleIndex(db(), app.log, process.env.REDIS_URL);
  app.addHook("onClose", async () => { await handleIndex?.close(); });

  app.get<{ Querystring: { handle: string } }>("/v0/captains/handle-availability", {
    schema: { querystring: { type: "object", required: ["handle"], additionalProperties: false,
      properties: { handle: captainHandleSchema } } },
  }, async (request, reply) => {
    reply.header("cache-control", "no-store");
    return { mode: "PAPER", handle: request.query.handle, available: await handles().available(request.query.handle) };
  });
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
          handle: captainHandleSchema,
          bio: { type: "string", maxLength: 500 },
        },
      },
    },
  }, async (request, reply) => {
    const actor = await requireActor(request, db());
    const handle = request.body.handle;
    const bio = request.body.bio ?? "";
    const existing = await db().query<CaptainProfileRow>(
      "SELECT user_id,handle,bio,avatar_url,banner_url FROM captain_profiles WHERE user_id = $1",
      [actor.id],
    );
    if (existing.rows[0]) {
      if (existing.rows[0].handle !== handle) {
        throw new ApiFault(409, "captain_profile_exists", "Captain profile already exists");
      }
      return captainProfile(existing.rows[0]);
    }
    const state = await insertCaptain(db(), actor.id, handle, bio);
    await handles().added(handle, state);
    reply.code(201);
    return { userId: actor.id, handle, bio, avatarUrl: null, bannerUrl: null };
  });

}
