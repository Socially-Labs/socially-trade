import { Amount, fixed } from "@socially/domain";
export const SOL_MINT = "So11111111111111111111111111111111111111112";
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export interface JupiterPrice { priceUsd: string; blockId: number; decimals: number; change24h?: string | null }
export class JupiterHttpError extends Error {
  constructor(readonly status: number, readonly resetAt: number | null) { super(`Jupiter HTTP ${status}`); }
}
export class JupiterDataError extends Error {}
export async function fetchJupiterPrices(key: string, mints: string[], options: { signal?: AbortSignal } = {}): Promise<Map<string, JupiterPrice>> {
  if (!mints.length || mints.length > 50) throw new JupiterDataError("Jupiter batches require 1-50 mints");
  const url = new URL("https://api.jup.ag/price/v3"); url.searchParams.set("ids", mints.join(","));
  const timeout = AbortSignal.timeout(4_000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const response = await fetch(url, { headers: { "x-api-key": key }, signal });
  const header = response.headers.get("x-ratelimit-reset");
  const resetAt = header && Number.isFinite(Number(header)) ? Number(header) * 1000 : null;
  if (!response.ok) throw new JupiterHttpError(response.status, resetAt);
  let data: unknown;
  try { data = await response.json(); }
  catch (error) {
    if (error instanceof SyntaxError) throw new JupiterDataError("Invalid Jupiter JSON");
    throw error;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new JupiterDataError("Invalid Jupiter response");
  const prices = new Map<string, JupiterPrice>();
  for (const mint of mints) {
    const row = (data as Record<string, unknown>)[mint];
    if (!row || typeof row !== "object") continue;
    const fields = row as Record<string, unknown>;
    if (typeof fields.usdPrice !== "number" || !Number.isFinite(fields.usdPrice) || fields.usdPrice <= 0 ||
      typeof fields.blockId !== "number" || !Number.isSafeInteger(fields.blockId) || fields.blockId < 0 ||
      typeof fields.decimals !== "number" || !Number.isInteger(fields.decimals) || fields.decimals < 0 || fields.decimals > 18) continue;
    const price = new Amount(String(fields.usdPrice));
    if (price.gte("100000000000000000000") || price.lt("0.000000000000000001")) continue;
    prices.set(mint, { priceUsd: fixed(price, 18), blockId: fields.blockId, decimals: fields.decimals,
      change24h: typeof fields.priceChange24h === "number" && Number.isFinite(fields.priceChange24h) && Math.abs(fields.priceChange24h) < 1e10
        ? fixed(String(fields.priceChange24h), 18) : null });
  }
  return prices;
}
/** Do not turn receipt time into source time when the RPC cannot establish block recency. */
export async function blockTime(rpcUrl: string, slot: number): Promise<Date | null> {
  const response = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getBlockTime", params: [slot] }), signal: AbortSignal.timeout(3_000) });
  if (!response.ok) return null;
  const data = await response.json() as { result?: unknown };
  return typeof data.result === "number" && Number.isSafeInteger(data.result) && data.result > 0 ? new Date(data.result * 1000) : null;
}
