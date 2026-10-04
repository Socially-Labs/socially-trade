import type { FastifyInstance } from "fastify";
import type { DbPool } from "@socially/db";
import { requireActor } from "./auth.js";
import { ApiFault } from "./errors.js";

export interface CaptainProfileRow {
  user_id: string; handle: string; bio: string; avatar_url: string | null; banner_url: string | null;
}
export function captainProfile(row: CaptainProfileRow) {
  return { userId: row.user_id, handle: row.handle, bio: row.bio,
    avatarUrl: row.avatar_url, bannerUrl: row.banner_url };
}
interface ProfileUpdate { bio?: string; avatarUrl?: string | null; bannerUrl?: string | null }

/** Store durable display URLs only. Never fetch user-supplied URLs on the API server. */
function assetUrl(value: string | null | undefined): string | null {
  if (value == null) return null;
  let url: URL;
  try { url = new URL(value); }
  catch { throw new ApiFault(400, "invalid_asset_url", "Image URL must be a public HTTPS URL"); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.port || url.href.length > 2048) {
    throw new ApiFault(400, "invalid_asset_url", "Use a permanent HTTPS image URL without credentials, query or fragment");
  }
  const origins = (process.env.CAPTAIN_ASSET_ORIGINS ?? "").split(",").map(origin => origin.trim()).filter(Boolean);
  if (origins.length && !origins.includes(url.origin)) {
    throw new ApiFault(400, "asset_origin_forbidden", "Image URL must use an approved asset origin");
  }
  return url.href;
}
const imageSchema = { anyOf: [{ type: "string", minLength: 1, maxLength: 2048 }, { type: "null" }] };
const paramsSchema = { type: "object", required: ["captainId"], additionalProperties: false,
  properties: { captainId: { type: "string", format: "uuid" } } };

export function registerCaptainProfileRoutes(app: FastifyInstance, db: () => DbPool): void {
  app.get<{ Params: { captainId: string } }>("/v0/captains/:captainId", {
    schema: { params: paramsSchema },
  }, async (request, reply) => {
    reply.header("cache-control", "no-store");
    const row = (await db().query<CaptainProfileRow>(
      "SELECT user_id,handle,bio,avatar_url,banner_url FROM captain_profiles WHERE user_id=$1",
      [request.params.captainId],
    )).rows[0];
    if (!row) throw new ApiFault(404, "captain_not_found", "Captain not found");
    return captainProfile(row);
  });

  app.patch<{ Params: { captainId: string }; Body: ProfileUpdate }>("/v0/captains/:captainId", {
    schema: { params: paramsSchema, body: { type: "object", minProperties: 1, additionalProperties: false,
      properties: { bio: { type: "string", maxLength: 500 }, avatarUrl: imageSchema, bannerUrl: imageSchema } } },
  }, async (request, reply) => {
    const actor = await requireActor(request, db());
    if (actor.id !== request.params.captainId.toLowerCase()) {
      throw new ApiFault(403, "captain_profile_forbidden", "Only the Captain can update their profile");
    }
    const { bio, avatarUrl, bannerUrl } = request.body;
    const avatar = assetUrl(avatarUrl); const banner = assetUrl(bannerUrl);
    const row = (await db().query<CaptainProfileRow>(
      `UPDATE captain_profiles SET
        bio=CASE WHEN $2::boolean THEN $3::text ELSE bio END,
        avatar_url=CASE WHEN $4::boolean THEN $5::text ELSE avatar_url END,
        banner_url=CASE WHEN $6::boolean THEN $7::text ELSE banner_url END
       WHERE user_id=$1 RETURNING user_id,handle,bio,avatar_url,banner_url`,
      [actor.id, bio !== undefined, bio ?? null, avatarUrl !== undefined, avatar, bannerUrl !== undefined, banner],
    )).rows[0];
    if (!row) throw new ApiFault(404, "captain_not_found", "Create a Captain profile first");
    reply.header("cache-control", "no-store");
    return captainProfile(row);
  });
}
