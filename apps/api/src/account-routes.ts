import type { FastifyInstance } from "fastify";
import type { DbPool } from "@socially/db";
import { requireActor } from "./auth.js";
import { myPositions } from "./crew.js";
import { ApiFault } from "./errors.js";
import { registerUserUploadRoutes } from "./user-uploads.js";
import { captainProfile, registerCaptainProfileRoutes } from "./captain-profiles.js";
import { UsernameIndex, captainHandleSchema, usernameSchema } from "./username-index.js";
import { accountView, profileProperties, updateUserProfile, type ProfileUpdate } from "./user-profiles.js";

export function registerAccountRoutes(app: FastifyInstance, db: () => DbPool): void {
  let usernameIndex: UsernameIndex | undefined;
  const usernames = () => usernameIndex ??= new UsernameIndex(db(), app.log, process.env.REDIS_URL);
  app.addHook("onClose", async () => { await usernameIndex?.close(); });
  registerCaptainProfileRoutes(app, db);
  registerUserUploadRoutes(app, db);
  app.get<{ Querystring: { username: string } }>("/v0/users/username-availability", {
    schema: { querystring: { type: "object", required: ["username"], additionalProperties: false,
      properties: { username: usernameSchema } } },
  }, async (request, reply) => {
    reply.header("cache-control", "no-store");
    return { mode: "PAPER", username: request.query.username, available: await usernames().available(request.query.username) };
  });
  // Compatibility alias; both routes check the global username namespace.
  app.get<{ Querystring: { handle: string } }>("/v0/captains/handle-availability", {
    schema: { querystring: { type: "object", required: ["handle"], additionalProperties: false,
      properties: { handle: captainHandleSchema } } },
  }, async (request, reply) => {
    reply.header("cache-control", "no-store");
    return { mode: "PAPER", handle: request.query.handle, available: await usernames().available(request.query.handle) };
  });
  app.get("/v0/me", async (request, reply) => {
    reply.header("cache-control", "no-store");
    return accountView(await requireActor(request, db()));
  });
  app.post<{ Body: ProfileUpdate }>("/v0/me/onboarding", {
    schema: { body: { type: "object", required: ["username", "role"], additionalProperties: false,
      properties: { username: usernameSchema, role: profileProperties.role, displayName: profileProperties.displayName } } },
  }, async (request, reply) => {
    const actor = await requireActor(request, db());
    const user = await updateUserProfile(db(), actor.id, request.body, usernames(), true);
    reply.header("cache-control", "no-store");
    return accountView(user);
  });
  app.patch<{ Body: ProfileUpdate }>("/v0/me", {
    schema: { body: { type: "object", minProperties: 1, additionalProperties: false, properties: profileProperties } },
  }, async (request, reply) => {
    const actor = await requireActor(request, db());
    if (!actor.username) throw new ApiFault(409, "signup_required", "Complete account setup first");
    const user = await updateUserProfile(db(), actor.id, request.body, usernames());
    reply.header("cache-control", "no-store");
    return accountView(user);
  });
  app.get("/v0/me/paper-balance", async request => {
    const actor = await requireActor(request, db());
    return { mode: "PAPER", available: { value: actor.paperCash, asset: "USDC" } };
  });
  app.get("/v0/me/paper-positions", async request => {
    const actor = await requireActor(request, db());
    return { mode: "PAPER", positions: await myPositions(db(), actor.id) };
  });
  app.post<{ Body: { handle: string; bio?: string } }>("/v0/captains", {
    schema: { body: { type: "object", required: ["handle"], additionalProperties: false,
      properties: { handle: captainHandleSchema, bio: profileProperties.bio } } },
  }, async (request, reply) => {
    const actor = await requireActor(request, db());
    if (actor.username && actor.username !== request.body.handle) {
      throw new ApiFault(409, "captain_profile_exists", "Account already has a username. Rename it through your profile.");
    }
    const user = await updateUserProfile(db(), actor.id, {
      username: request.body.handle, role: "captain", ...(actor.username ? {} : { bio: request.body.bio ?? "" }),
    }, usernames(), "captain");
    reply.code(actor.username ? 200 : 201).header("cache-control", "no-store");
    return captainProfile(user);
  });
}
