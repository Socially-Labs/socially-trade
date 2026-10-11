import { randomUUID } from "node:crypto";
import { inTransaction, type DbPool } from "@socially/db";
import { Amount, fixed, MAX_PRICE_AGE_MS } from "@socially/domain";
import { blockTime, SOL_MINT, USDC_MINT } from "@socially/market-data";
import type { MarketEvent, MarketPrice } from "@socially/market-stream";
import { supportedTokens, type SupportedToken } from "@socially/market-data/catalog";
import type { JupiterClient } from "./client.js";

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
    const prior = (await client.query<{ payload: MarketEvent }>("SELECT payload FROM market_latest WHERE instrument_id=$1", [price.instrumentId])).rows[0]?.payload.price;
    // Keep the last known mark and its real timestamps visibly unavailable on failure.
    if (price.status === "UNAVAILABLE" && prior?.priceUsdc) {
      price = { ...prior, status: "UNAVAILABLE", reason: price.reason };
    }
    if (prior && prior.status === price.status && prior.reason === price.reason && prior.sourceAt === price.sourceAt &&
      prior.sourceBlockId === price.sourceBlockId && prior.priceUsdc === price.priceUsdc && price.status === 'UNAVAILABLE') return;
    if (price.sourceAt) {
      const accepted = (await client.query<{ source_at: Date; source_block_id: string | null }>("SELECT source_at,source_block_id::text FROM price_observations WHERE instrument_id=$1 AND source='JUPITER_PRICE_V3' ORDER BY source_at DESC,received_at DESC LIMIT 1", [price.instrumentId])).rows[0];
      if (accepted && (Date.parse(price.sourceAt) < accepted.source_at.getTime() ||
        Date.parse(price.sourceAt) === accepted.source_at.getTime() && accepted.source_block_id && price.sourceBlockId &&
        BigInt(price.sourceBlockId) < BigInt(accepted.source_block_id))) return;
    }
    if (price.status !== "UNAVAILABLE" && price.priceUsdc && price.sourceAt && quoteUsd) {
      const observationId = randomUUID();
      const ref = `${price.sourceBlockId}:${price.sourceAt}:${price.priceUsdc}`;
      const inserted = await client.query<{ id: string }>(`INSERT INTO price_observations
        (id,instrument_id,source,source_ref,price_usdc,source_at,received_at,source_block_id,price_usd,quote_usd,quote_source_block_id,quote_source_at)
        VALUES($1,$11,'JUPITER_PRICE_V3',$2,$3,$4,$5,$6,$7,$8,$9,$10)
        ON CONFLICT(source,instrument_id,source_ref) DO UPDATE SET last_confirmed_at=GREATEST(COALESCE(price_observations.last_confirmed_at,price_observations.received_at),EXCLUDED.received_at) RETURNING id`,
        [observationId, ref, price.priceUsdc, price.sourceAt, price.receivedAt, price.sourceBlockId, price.priceUsd, quoteUsd, price.quoteSourceBlockId, price.quoteSourceAt, price.instrumentId]);
      const stored = (await client.query<{ id: string; received_at: Date }>(
        "SELECT id,received_at FROM price_observations WHERE source='JUPITER_PRICE_V3' AND instrument_id=$2 AND source_ref=$1", [ref, price.instrumentId],
      )).rows[0]!;
      price = { ...price, observationId: inserted.rows[0]?.id ?? stored.id };
      await client.query(`INSERT INTO market_samples(instrument_id,source_at,price_usd,observation_id)
        VALUES($1,$2,$3,$4) ON CONFLICT(instrument_id,source_at) DO UPDATE SET price_usd=EXCLUDED.price_usd,observation_id=EXCLUDED.observation_id`,
        [price.instrumentId, price.sourceAt, price.priceUsd, price.observationId]);
    }
    const sequence = (await client.query<{ sequence: string }>("UPDATE market_feed_state SET sequence=sequence+1 WHERE singleton RETURNING sequence::text")).rows[0]!.sequence;
    const payload: MarketEvent = { type: price.status === "UNAVAILABLE" ? "market_status" : "price_update", eventId: randomUUID(), price };
    await client.query("INSERT INTO market_events(sequence,id,instrument_id,payload) VALUES($1,$2,$4,$3)", [sequence, payload.eventId, payload, price.instrumentId]);
    await client.query(`INSERT INTO market_latest(instrument_id,sequence,payload) VALUES($3,$1,$2)
      ON CONFLICT(instrument_id) DO UPDATE SET sequence=EXCLUDED.sequence,payload=EXCLUDED.payload`, [sequence, payload, price.instrumentId]);
  });
}

export function unavailable(reason: string, token: Pick<SupportedToken, "id" | "mint"> = { id: "SOL", mint: SOL_MINT }): MarketPrice {
  return { instrumentId: token.id, mint: token.mint, source: "JUPITER_PRICE_V3", priceUsd: null, priceUsdc: null,
    sourceBlockId: null, sourceAt: null, quoteSourceBlockId: null, quoteSourceAt: null, observationId: null, receivedAt: new Date().toISOString(), status: "UNAVAILABLE", reason };
}
export async function unavailableMarkets(pool: DbPool, reason: string, tokens: readonly SupportedToken[] = supportedTokens): Promise<void> {
  for (const token of tokens) await recordMarketPrice(pool, unavailable(reason, token));
}
export async function ingestJupiter(pool: DbPool, jupiter: Pick<JupiterClient, "getPrices">, rpc: string, signal?: AbortSignal,
  tokens: readonly SupportedToken[] = supportedTokens): Promise<void> {
  const mints = [...new Set([...tokens.map(token => token.mint), USDC_MINT])];
  if (mints.length > 50) throw new Error("Supported catalog exceeds the price batch budget");
  const result = await jupiter.getPrices(mints, signal);
  const receivedAt = new Date().toISOString();
  const usdc = result.get(USDC_MINT);
  // Coalesce same slots, including simultaneous RPC callers, and isolate failed slots.
  const pending = new Map<number, Promise<Date | null>>();
  const at = (slot: number) => {
    let promise = pending.get(slot);
    if (!promise) { promise = sourceTime(rpc, slot).catch(() => null); pending.set(slot, promise); }
    return promise;
  };
  const usdcAt = usdc?.decimals === 6 ? await at(usdc.blockId) : null;
  for (const token of tokens) {
    signal?.throwIfAborted();
    const mark = result.get(token.mint);
    if (mark && mark.decimals !== token.decimals) {
      await pool.query("UPDATE instruments SET eligibility='DISABLED',eligibility_reason='decimals_changed',active=false WHERE id=$1",[token.id]);
      await recordMarketPrice(pool,unavailable('decimals_changed',token)); continue;
    }
    let reason: string | null = !mark || mark.decimals !== token.decimals || !usdc || usdc.decimals !== 6 ? "price_missing_or_invalid" : null;
    const tokenAt = mark && !reason ? await at(mark.blockId) : null;
    if (!reason && (!tokenAt || !usdcAt)) reason = "source_time_unavailable";
    const sourceAt = tokenAt && usdcAt ? new Date(Math.min(tokenAt.getTime(), usdcAt.getTime())) : null;
    const age = sourceAt ? Date.now() - sourceAt.getTime() : Infinity;
    if (!reason && (age < -5_000 || age > MAX_PRICE_AGE_MS)) reason = "source_price_stale";
    if (reason || !mark || !usdc || !usdcAt || !sourceAt) { await recordMarketPrice(pool, unavailable(reason ?? "price_missing_or_invalid", token)); continue; }
    await recordMarketPrice(pool, {
      instrumentId: token.id, mint: token.mint, source: "JUPITER_PRICE_V3", sourceBlockId: String(mark.blockId),
      quoteSourceBlockId: String(usdc.blockId), quoteSourceAt: usdcAt.toISOString(),
      priceUsd: mark.priceUsd, priceUsdc: fixed(new Amount(mark.priceUsd).div(usdc.priceUsd), 18), change24h: mark.change24h ?? null,
      sourceAt: sourceAt.toISOString(), receivedAt, observationId: null,
      status: "CURRENT", reason: null,
    }, usdc.priceUsd);
  }
}
