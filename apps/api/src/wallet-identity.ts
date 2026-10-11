import type { DbPool, DbClient } from "@socially/db";

/** Historical wallet bindings remain valid for ownership checks. */
export async function walletOf(db: DbPool | DbClient, userId: string): Promise<string | null> {
  const result = await db.query<{ address: string }>("SELECT address FROM user_wallets WHERE user_id = $1", [userId]);
  return result.rows[0]?.address ?? null;
}
