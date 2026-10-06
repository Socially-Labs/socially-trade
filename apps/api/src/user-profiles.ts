import type { DbPool } from "@socially/db";
import { inTransaction } from "@socially/db";
import type { Actor } from "./auth.js";
import { ApiFault } from "./errors.js";
import type { IndexState, UsernameIndex } from "./username-index.js";

export const userColumns = `id, auth_subject AS subject, display_name AS "displayName",
  paper_cash::text AS "paperCash", username, role, bio,
  avatar_url AS "avatarUrl", banner_url AS "bannerUrl", hide_balances AS "hideBalances", avatar_kind AS "avatarKind"`;
export function accountView(user: Actor) {
  return { id: user.id, displayName: user.displayName, username: user.username,
    role: user.role, bio: user.bio, avatarUrl: user.avatarUrl, bannerUrl: user.bannerUrl,
    hideBalances: user.hideBalances, avatarKind: user.avatarKind,
    mode: "PAPER", paperCash: { value: user.paperCash, asset: "USDC" } };
}
export interface ProfileUpdate {
  username?: string; role?: "crew" | "captain"; displayName?: string;
  bio?: string; avatarUrl?: string | null; bannerUrl?: string | null;
  hideBalances?: boolean; avatarKind?: "captain" | "initials";
}
const imageSchema = { anyOf: [{ type: "string", minLength: 1, maxLength: 2048 }, { type: "null" }] };
export const profileProperties = {
  username: { type: "string", pattern: "^[a-z0-9_]{3,24}$" },
  role: { type: "string", enum: ["crew", "captain"] },
  displayName: { type: "string", minLength: 1, maxLength: 40 },
  bio: { type: "string", maxLength: 500 }, avatarUrl: imageSchema, bannerUrl: imageSchema,
  hideBalances: { type: "boolean" }, avatarKind: { type: "string", enum: ["captain", "initials"] },
};
export async function updateUserProfile(pool: DbPool, id: string, patch: ProfileUpdate, index?: UsernameIndex, signupOnly: boolean | "captain" = false) {
  try {
    const result = await inTransaction(pool, async client => {
      const previous = (await client.query<Actor>(`SELECT ${userColumns} FROM users WHERE id=$1 FOR UPDATE`, [id])).rows[0]!;
      const username = patch.username ?? previous.username;
      const role = patch.role ?? previous.role;
      if (!username || !role) throw new ApiFault(400, "signup_required", "Choose a username and role together");
      if (signupOnly && previous.username && (previous.username !== username || (signupOnly !== "captain" && previous.role !== role))) {
        throw new ApiFault(409, "already_onboarded", "Account setup is complete. Edit your profile in Settings.");
      }
      if (username !== previous.username && !/^[a-z][a-z0-9_]{2,23}$/.test(username)) {
        throw new ApiFault(400, "invalid_username", "Use 3–24 lowercase letters, numbers or underscores, starting with a letter");
      }
      const displayName = patch.displayName?.trim() ?? previous.displayName;
      if (!displayName) throw new ApiFault(400, "invalid_display_name", "Display name cannot be blank");
      for (const [kind, url] of [["avatar", patch.avatarUrl], ["banner", patch.bannerUrl]] as const) {
        if (url && !(await client.query("SELECT 1 FROM user_asset_uploads WHERE user_id=$1 AND kind=$2 AND public_url=$3 AND status='COMPLETED'", [id, kind, url])).rowCount) {
          throw new ApiFault(400, "asset_not_verified", "Complete your own image upload before attaching it");
        }
      }
      const assignments = ["role=$2", "display_name=$3", "bio=$4", "avatar_url=$5", "banner_url=$6", "hide_balances=$7", "avatar_kind=$8"];
      const values: unknown[] = [id, role, displayName, patch.bio ?? previous.bio,
        patch.avatarUrl === undefined ? previous.avatarUrl : patch.avatarUrl,
        patch.bannerUrl === undefined ? previous.bannerUrl : patch.bannerUrl,
        patch.hideBalances ?? previous.hideBalances, patch.avatarKind ?? previous.avatarKind];
      // Balance/profile changes must not invalidate the username filter.
      if (username !== previous.username) { assignments.push("username=$9"); values.push(username); }
      const user = (await client.query<Actor>(`UPDATE users SET ${assignments.join(",")} WHERE id=$1 RETURNING ${userColumns}`, values)).rows[0]!;
      const state = username !== previous.username
        ? (await client.query<IndexState>("SELECT instance_id::text,revision::text FROM username_index_state WHERE singleton")).rows[0]
        : undefined;
      return { user, state };
    });
    if (result.state) await index?.added(result.user.username!, result.state);
    return result.user;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "23505" &&
      "constraint" in error && error.constraint === "users_username_key") {
      throw new ApiFault(409, "username_taken", "That username is already taken. Choose another one.");
    }
    throw error;
  }
}
