import type { FastifyInstance } from "fastify";
import { inTransaction, type DbPool } from "@socially/db";
import { requireActor } from "./auth.js";
import { myPositions } from "./crew.js";

/** Paper balances are database-only; wallet funding uses direct devnet transfers. */
export function registerWalletRoutes(app: FastifyInstance, db: () => DbPool) {
  app.get("/v0/me/wallet", async (request, reply) => {
    const pool = db();
    const actor = await requireActor(request, pool);
    reply.header("cache-control", "no-store");
    return inTransaction(pool, async client => {
      await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const cash = (await client.query<{ value: string }>("SELECT paper_cash::text AS value FROM users WHERE id=$1", [actor.id])).rows[0]!.value;
      // Keep the read response compatible with installed clients. Custom token deposits are retired.
      return { mode: "PAPER", enabled: false, token: null, available: { amount: cash, asset: "USDC" },
        positions: await myPositions(client, actor.id), deposits: [] };
    });
  });
}
