import { randomUUID } from "node:crypto";
import type { DbPool } from "@socially/db";
import { fetchSolPrice } from "@socially/market-data";

export async function ingestSolPrice(pool: DbPool, apiKey: string): Promise<void> {
  const observation = await fetchSolPrice(apiKey);
  await pool.query(
    `INSERT INTO price_observations
     (id, instrument_id, source, source_ref, price_usdc, source_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (source, instrument_id, source_ref) DO NOTHING`,
    [randomUUID(), observation.instrumentId, observation.source, observation.sourceRef,
      observation.priceUsdc, observation.sourceAt],
  );
}
