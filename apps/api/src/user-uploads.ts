import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { inTransaction, type DbPool } from "@socially/db";
import { requireActor, type Actor } from "./auth.js";
import { ApiFault } from "./errors.js";
import { captainProfile } from "./captain-profiles.js";
import { AssetStorage, MAX_IMAGE_BYTES, type AssetKind, type UploadFile } from "./asset-storage.js";

import { accountView, userColumns } from "./user-profiles.js";

interface Upload extends UploadFile {
  id: string; user_id: string; kind: AssetKind; status: string; public_url: string | null; expires_at: Date;
}
const uuid = { type: "string", format: "uuid" };
export function registerUserUploadRoutes(app: FastifyInstance, db: () => DbPool): void {
  registerUploadPaths(app, db, "/v0/me/assets/uploads", false);
  registerUploadPaths(app, db, "/v0/captains/:captainId/assets/uploads", true);
}
function registerUploadPaths(app: FastifyInstance, db: () => DbPool, path: string, scoped: boolean): void {
  let configured: AssetStorage | undefined;
  const storage = () => configured ??= new AssetStorage();
  app.addHook("onClose", async () => { configured?.close(); });
  app.post<{ Params: { captainId: string }; Body: { kind: AssetKind; contentType: string; byteSize: number } }>(
    path, {
      schema: { params: { type: "object", required: scoped ? ["captainId"] : [], properties: { captainId: uuid }, additionalProperties: false },
        body: { type: "object", required: ["kind", "contentType", "byteSize"], additionalProperties: false,
          properties: { kind: { type: "string", enum: ["avatar", "banner"] },
            contentType: { type: "string", enum: ["image/jpeg", "image/png", "image/webp"] },
            byteSize: { type: "integer", minimum: 1, maximum: MAX_IMAGE_BYTES } } } },
    }, async (request, reply) => {
      const actor = await requireActor(request, db());
      if (scoped && actor.id !== request.params.captainId.toLowerCase()) throw new ApiFault(403, "captain_profile_forbidden", "Only the Captain can upload profile images");
      const store = storage();
      const id = randomUUID(); const stagingKey = `pending/${actor.id}/${id}`;
      const { kind, contentType, byteSize } = request.body;
      const result = await inTransaction(db(), async client => {
        if (!(await client.query("SELECT 1 FROM users WHERE id=$1 AND username IS NOT NULL FOR UPDATE", [actor.id])).rowCount) throw new ApiFault(404, "captain_not_found", "Complete account setup first");
        const count = (await client.query<{ count: string }>("SELECT count(*)::text FROM user_asset_uploads WHERE user_id=$1 AND created_at>now()-interval '1 hour'", [actor.id])).rows[0]!;
        if (Number(count.count) >= 20) throw new ApiFault(429, "upload_rate_limited", "Maximum 20 image upload requests per hour");
        const url = await store.sign({ staging_key: stagingKey, content_type: contentType, byte_size: byteSize });
        const row = (await client.query<{ expires_at: Date }>(`INSERT INTO user_asset_uploads(id,user_id,kind,content_type,byte_size,staging_key)
          VALUES($1,$2,$3,$4,$5,$6) RETURNING expires_at`, [id, actor.id, kind, contentType, byteSize, stagingKey])).rows[0]!;
        return { url, expiresAt: row.expires_at.toISOString() };
      });
      reply.code(201).header("cache-control", "no-store");
      return { uploadId: id, kind, method: "PUT", uploadUrl: result.url, headers: { "Content-Type": contentType },
        byteSize, uploadUrlExpiresAt: new Date(Date.now() + 300_000).toISOString(), completeBefore: result.expiresAt };
    });
  app.post<{ Params: { captainId: string; uploadId: string } }>(`${path}/:uploadId/complete`, {
    schema: { params: { type: "object", required: scoped ? ["captainId", "uploadId"] : ["uploadId"], additionalProperties: false,
      properties: { captainId: uuid, uploadId: uuid } } },
  }, async (request, reply) => {
    const actor = await requireActor(request, db());
    if (scoped && actor.id !== request.params.captainId.toLowerCase()) throw new ApiFault(403, "captain_profile_forbidden", "Only the Captain can complete their image uploads");
    const result = await inTransaction(db(), async client => {
      const row = (await client.query<Upload>("SELECT * FROM user_asset_uploads WHERE id=$1 AND user_id=$2 FOR UPDATE", [request.params.uploadId, actor.id])).rows[0];
      if (!row) throw new ApiFault(404, "asset_upload_not_found", "Upload not found");
      if (row.status === "COMPLETED") {
        const profile = (await client.query<Actor>(`SELECT ${userColumns} FROM users WHERE id=$1`, [actor.id])).rows[0]!;
        return { profile: scoped ? captainProfile(profile) : accountView(profile), asset: { id: row.id, kind: row.kind, url: row.public_url }, stagingKey: row.staging_key };
      }
      if (row.expires_at.getTime() <= Date.now()) throw new ApiFault(410, "asset_upload_expired", "Request a new upload URL");
      const url = await storage().publish(row, row.kind, actor.id, row.id);
      await client.query("UPDATE user_asset_uploads SET status='COMPLETED',public_url=$2,completed_at=now() WHERE id=$1", [row.id, url]);
      const profile = scoped ? (await client.query<Actor>(`UPDATE users SET
        avatar_url=CASE WHEN $2='avatar' THEN $3 ELSE avatar_url END,
        banner_url=CASE WHEN $2='banner' THEN $3 ELSE banner_url END
        WHERE id=$1 RETURNING ${userColumns}`, [actor.id, row.kind, url])).rows[0]!
        : (await client.query<Actor>(`SELECT ${userColumns} FROM users WHERE id=$1`, [actor.id])).rows[0]!;
      return { profile: scoped ? captainProfile(profile) : accountView(profile), asset: { id: row.id, kind: row.kind, url }, stagingKey: row.staging_key };
    });
    // A failed cleanup cannot turn a committed profile update into an API error.
    try { await storage().discard(result.stagingKey); } catch { app.log.warn("Staging asset cleanup deferred to bucket lifecycle"); }
    reply.header("cache-control", "no-store");
    return { profile: result.profile, asset: result.asset };
  });
}
