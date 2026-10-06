import type { FastifyInstance } from "fastify";
import type { DbPool } from "@socially/db";
import { requireActor, type Actor } from "./auth.js";
import { ApiFault } from "./errors.js";
import { profileProperties, updateUserProfile, userColumns, type ProfileUpdate } from "./user-profiles.js";

export function captainProfile(row: Actor) {
  return { userId: row.id, handle: row.username, bio: row.bio, avatarUrl: row.avatarUrl, bannerUrl: row.bannerUrl };
}
const paramsSchema = { type: "object", required: ["captainId"], additionalProperties: false,
  properties: { captainId: { type: "string", format: "uuid" } } };
export function registerCaptainProfileRoutes(app: FastifyInstance, db: () => DbPool): void {
  app.get<{ Params: { captainId: string } }>("/v0/captains/:captainId", {
    schema: { params: paramsSchema },
  }, async (request, reply) => {
    reply.header("cache-control", "no-store");
    const row = (await db().query<Actor>(`SELECT ${userColumns} FROM users u WHERE id=$1
      AND (role='captain' OR EXISTS(SELECT 1 FROM funds f WHERE f.captain_id=u.id))`, [request.params.captainId])).rows[0];
    if (!row) throw new ApiFault(404, "captain_not_found", "Captain not found");
    return captainProfile(row);
  });
  app.patch<{ Params: { captainId: string }; Body: ProfileUpdate }>("/v0/captains/:captainId", {
    schema: { params: paramsSchema, body: { type: "object", minProperties: 1, additionalProperties: false,
      properties: { bio: profileProperties.bio, avatarUrl: profileProperties.avatarUrl, bannerUrl: profileProperties.bannerUrl } } },
  }, async (request, reply) => {
    const actor = await requireActor(request, db());
    if (actor.id !== request.params.captainId.toLowerCase()) {
      throw new ApiFault(403, "captain_profile_forbidden", "Only the owner can update their profile");
    }
    if (!actor.username) throw new ApiFault(404, "captain_not_found", "Complete account setup first");
    reply.header("cache-control", "no-store");
    return captainProfile(await updateUserProfile(db(), actor.id, request.body));
  });
}
