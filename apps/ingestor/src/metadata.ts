import type { DbPool } from "@socially/db";
import type { JupiterClient } from "@socially/market-data/client";
import { supportedTokens, supportedByMint } from "@socially/market-data/catalog";

export async function refreshMarketMetadata(pool: DbPool, client: JupiterClient, signal?: AbortSignal): Promise<void> {
  const tokens = await client.getTokens(supportedTokens.map(token => token.mint).join(","), signal);
  for (const token of tokens) {
    const supported = supportedByMint.get(token.mint);
    if (!supported || supported.decimals !== token.decimals) continue;
    await pool.query(`INSERT INTO market_token_metadata(mint,payload,fetched_at) VALUES($1,$2,now())
      ON CONFLICT(mint) DO UPDATE SET payload=EXCLUDED.payload,fetched_at=EXCLUDED.fetched_at`, [token.mint, token]);
  }
  // Retain chart samples for 35 days; execution evidence has independent retention.
  await pool.query("DELETE FROM market_samples WHERE source_at < now()-interval '35 days'");
}
