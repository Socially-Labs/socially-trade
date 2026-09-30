import { randomUUID } from "node:crypto";
import type { DbClient } from "./index.js";

export async function ledgerAccountId(
  client: DbClient,
  ownerType: string,
  ownerId: string,
  assetId: string,
): Promise<string> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO ledger_accounts (id, owner_type, owner_id, asset_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (owner_type, owner_id, asset_id) DO UPDATE SET owner_id = EXCLUDED.owner_id
     RETURNING id`,
    [randomUUID(), ownerType, ownerId, assetId],
  );
  return result.rows[0]!.id;
}
