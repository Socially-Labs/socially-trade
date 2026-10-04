import { randomUUID } from "node:crypto";
import { inTransaction, type DbPool } from "@socially/db";
import { Amount, fixed, MAX_PRICE_AGE_MS } from "@socially/domain";
import { fetchJupiterPrices, blockTime, SOL_MINT, USDC_MINT } from "@socially/market-data";
import type { MarketEvent, MarketPrice } from "@socially/market-stream";

const times = new Map<number, Date>();
async function sourceTime(rpc: string, slot: number): Promise<Date | null> {
  const cached = times.get(slot); if (cached) return cached;
  const time = await blockTime(rpc, slot);
  if (time) { if (times.size >= 100) times.delete(times.keys().next().value!); times.set(slot, time); }
  return time;
}

export async function recordMarketPrice(pool: DbPool, price: MarketPrice, quoteUsd?: string): Promise<void> {
  await inTransaction(pool, async client => {
    // Serializes event numbering with transaction commit order across all writers.
    await client.query("SELECT sequence FROM market_feed_state WHERE singleton FOR UPDATE");
    const prior = (await client.query<{ payload: MarketEvent }>("SELECT payload FROM market_latest WHERE instrument_id='SOL'")).rows[0]?.payload.price;
    if (prior && prior.status === price.status && prior.reason === price.reason && prior.sourceAt === price.sourceAt &&
      prior.sourceBlockId === price.sourceBlockId && prior.priceUsdc === price.priceUsdc) return;
    if (price.sourceAt) {
      const accepted = (await client.query<{ source_at: Date }>("SELECT source_at FROM price_observations WHERE instrument_id='SOL' AND source='JUPITER_PRICE_V3' ORDER BY source_at DESC LIMIT 1")).rows[0];
      if (accepted && Date.parse(price.sourceAt) < accepted.source_at.getTime()) return;
    }
    if (price.status !== "UNAVAILABLE" && price.priceUsdc && price.sourceAt && quoteUsd) {
      const observationId = randomUUID();
      const ref = `${price.sourceBlockId}:${price.sourceAt}:${price.priceUsdc}`;
      const inserted = await client.query<{ id: string }>(`INSERT INTO price_observations
        (id,instrument_id,source,source_ref,price_usdc,source_at,received_at,source_block_id,price_usd,quote_usd,quote_source_block_id,quote_source_at)
        VALUES($1,'SOL','JUPITER_PRICE_V3',$2,$3,$4,$5,$6,$7,$8,$9,$10)
        ON CONFLICT(source,instrument_id,source_ref) DO NOTHING RETURNING id`,
        [observationId, ref, price.priceUsdc, price.sourceAt, price.receivedAt, price.sourceBlockId, price.priceUsd, quoteUsd, price.quoteSourceBlockId, price.quoteSourceAt]);
      price = { ...price, observationId: inserted.rows[0]?.id ?? (await client.query<{ id: string }>(
        "SELECT id FROM price_observations WHERE source='JUPITER_PRICE_V3' AND instrument_id='SOL' AND source_ref=$1", [ref],
      )).rows[0]!.id };
    }
    const sequence = (await client.query<{ sequence: string }>("UPDATE market_feed_state SET sequence=sequence+1 WHERE singleton RETURNING sequence::text")).rows[0]!.sequence;
    const payload: MarketEvent = { type: price.status === "UNAVAILABLE" ? "market_status" : "price_update", eventId: randomUUID(), price };
    await client.query("INSERT INTO market_events(sequence,id,instrument_id,payload) VALUES($1,$2,'SOL',$3)", [sequence, payload.eventId, payload]);
    await client.query(`INSERT INTO market_latest(instrument_id,sequence,payload) VALUES('SOL',$1,$2)
      ON CONFLICT(instrument_id) DO UPDATE SET sequence=EXCLUDED.sequence,payload=EXCLUDED.payload`, [sequence, payload]);
  });
}

export function unavailable(reason: string): MarketPrice {
  return { instrumentId: "SOL", mint: SOL_MINT, source: "JUPITER_PRICE_V3", priceUsd: null, priceUsdc: null,
    sourceBlockId: null, sourceAt: null, quoteSourceBlockId: null, quoteSourceAt: null, observationId: null, receivedAt: new Date().toISOString(), status: "UNAVAILABLE", reason };
}
export async function ingestJupiter(pool: DbPool, key: string, rpc: string): Promise<void> {
  const result = await fetchJupiterPrices(key, [SOL_MINT, USDC_MINT]);
  const receivedAt = new Date().toISOString();
  const sol = result.get(SOL_MINT); const usdc = result.get(USDC_MINT);
  if (!sol || !usdc || sol.decimals !== 9 || usdc.decimals !== 6) {
    await recordMarketPrice(pool, unavailable("price_missing_or_invalid")); return;
  }
  const [solAt, usdcAt] = await Promise.all([sourceTime(rpc, sol.blockId), sourceTime(rpc, usdc.blockId)]);
  if (!solAt || !usdcAt) { await recordMarketPrice(pool, unavailable("source_time_unavailable")); return; }
  const sourceAt = new Date(Math.min(solAt.getTime(), usdcAt.getTime()));
  const age = Date.now() - sourceAt.getTime();
  if (age < -5_000 || age > MAX_PRICE_AGE_MS) { await recordMarketPrice(pool, unavailable("source_price_stale")); return; }
  await recordMarketPrice(pool, {
    instrumentId: "SOL", mint: SOL_MINT, source: "JUPITER_PRICE_V3", sourceBlockId: String(sol.blockId),
    quoteSourceBlockId: String(usdc.blockId), quoteSourceAt: usdcAt.toISOString(),
    priceUsd: sol.priceUsd, priceUsdc: fixed(new Amount(sol.priceUsd).div(usdc.priceUsd), 18),
    sourceAt: sourceAt.toISOString(), receivedAt, observationId: null,
    status: age > 15_000 ? "STALE" : "CURRENT", reason: age > 15_000 ? "observation_stale" : null,
  }, usdc.priceUsd);
}
