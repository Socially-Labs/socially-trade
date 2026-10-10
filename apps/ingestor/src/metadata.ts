import type { DbPool } from "@socially/db";
import type { JupiterClient } from "@socially/market-data/client";
import { supportedTokens, supportedByMint } from "@socially/market-data/catalog";

export async function refreshMarketMetadata(pool: DbPool, client: JupiterClient, signal?: AbortSignal): Promise<void> {
  const tokens = await client.getTokens(supportedTokens.map(token => token.mint).join(","), signal);
  const valid = tokens.filter(token => supportedByMint.get(token.mint)?.decimals === token.decimals);
  if (valid.length) await pool.query(`INSERT INTO market_token_metadata(mint,payload,fetched_at)
    SELECT value->>'mint',value,now() FROM jsonb_array_elements($1::jsonb)
    ON CONFLICT(mint) DO UPDATE SET payload=EXCLUDED.payload,fetched_at=EXCLUDED.fetched_at`, [JSON.stringify(valid)]);
  // Retain chart samples for 35 days; execution evidence has independent retention.
  await pool.query("DELETE FROM market_samples WHERE source_at < now()-interval '35 days'");
}
