import type { FastifyInstance } from "fastify";
import { inTransaction, type DbPool } from "@socially/db";
import { mintPattern, supportedByMint } from "@socially/market-data/catalog";
import { MarketCatalog, readHistory, historyRanges, type HistoryRange } from "./market-catalog.js";
import { requireActor } from "./auth.js";
import { ApiFault } from "./errors.js";

export function registerMarketCatalogRoutes(app: FastifyInstance, db: () => DbPool) {
  let catalog: MarketCatalog | undefined;
  const service = () => catalog ??= new MarketCatalog(db());
  const mint = (value: string) => { if (!mintPattern.test(value)) throw new ApiFault(400, "invalid_mint", "Invalid Solana mint"); return value; };
  app.get<{ Querystring: { query?: string } }>("/v0/market/tokens", { schema: { querystring: {
    type: "object", additionalProperties: false, properties: { query: { type: "string", maxLength: 100 } },
  } } }, async (request, reply) => {
    reply.header("cache-control", "no-store");
    return { mode: "PAPER", asOf: new Date().toISOString(), tokens: await service().list(request.query.query?.trim() ?? "") };
  });
  app.get<{ Params: { mint: string } }>("/v0/market/tokens/:mint", async (request, reply) => {
    reply.header("cache-control", "no-store");
    const address = mint(request.params.mint);
    const token = (await service().list(supportedByMint.has(address) ? "" : address, supportedByMint.has(address) ? [address] : undefined)).find(item => item.mint === address);
    if (!token) throw new ApiFault(404, "token_not_found", "Token not found");
    return { mode: "PAPER", token };
  });
  app.get<{ Params: { mint: string }; Querystring: { range?: HistoryRange } }>("/v0/market/tokens/:mint/history", {
    schema: { querystring: { type: "object", additionalProperties: false, properties: { range: { type: "string", enum: Object.keys(historyRanges) } } } },
  }, async (request, reply) => {
    reply.header("cache-control", "public, max-age=5");
    return { mode: "PAPER", ...await readHistory(db(), mint(request.params.mint), request.query.range ?? "24H") };
  });
  app.get("/v0/me/watchlist", async (request, reply) => {
    const actor = await requireActor(request, db()); reply.header("cache-control", "no-store");
    const mints = (await db().query<{ mint: string }>("SELECT mint FROM market_watchlist WHERE user_id=$1 ORDER BY created_at,mint", [actor.id])).rows.map(row => row.mint);
    return { mode: "PAPER", mints, tokens: await service().list("", mints) };
  });
  app.put<{ Params: { mint: string } }>("/v0/me/watchlist/:mint", async (request, reply) => {
    const actor = await requireActor(request, db()), address = mint(request.params.mint);
    if (!(await db().query("SELECT 1 FROM market_token_metadata WHERE mint=$1", [address])).rowCount) {
      if (!(await service().search(address)).some(token => token.mint === address)) throw new ApiFault(404, "token_not_found", "Token not found");
    }
    await inTransaction(db(), async client => {
      await client.query("SELECT id FROM users WHERE id=$1 FOR NO KEY UPDATE", [actor.id]);
      const count = await client.query<{ count: string }>("SELECT count(*)::text FROM market_watchlist WHERE user_id=$1 AND mint<>$2", [actor.id, address]);
      if (Number(count.rows[0]!.count) >= 100) throw new ApiFault(422, "watchlist_full", "You can save up to 100 markets");
      await client.query("INSERT INTO market_watchlist(user_id,mint) VALUES($1,$2) ON CONFLICT DO NOTHING", [actor.id, address]);
    });
    reply.header("cache-control", "no-store"); return { mode: "PAPER", mint: address, saved: true };
  });
  app.delete<{ Params: { mint: string } }>("/v0/me/watchlist/:mint", async (request, reply) => {
    const actor = await requireActor(request, db()), address = mint(request.params.mint);
    await db().query("DELETE FROM market_watchlist WHERE user_id=$1 AND mint=$2", [actor.id, address]);
    reply.header("cache-control", "no-store"); return { mode: "PAPER", mint: address, saved: false };
  });
  app.addHook("onClose", async () => catalog?.close());
}
