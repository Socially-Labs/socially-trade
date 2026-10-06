import { Amount, fixed } from "@socially/domain";
import { JupiterDataError, JupiterHttpError } from "./jupiter.js";
import { mintPattern } from "./catalog.js";

export interface TokenMetadata {
  mint: string; name: string; symbol: string; decimals: number; icon: string | null;
  verified: boolean | null; suspicious: boolean; liquidityUsd: string | null;
  volume24hUsd: string | null; change1h: string | null; change24h: string | null;
  providerUpdatedAt: string | null;
}
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const decimal = (v: unknown, positive = false): string | null => typeof v === "number" && Number.isFinite(v) &&
  Math.abs(v) < 1e20 && (!positive || v >= 0) ? fixed(new Amount(String(v)), 18) : null;
export function parseTokenMetadata(data: unknown): TokenMetadata[] {
  if (!Array.isArray(data) || data.length > 100) throw new JupiterDataError("Invalid token response");
  const result = new Map<string, TokenMetadata>();
  for (const row of data) {
    if (!record(row) || typeof row.id !== "string" || !mintPattern.test(row.id) ||
      typeof row.name !== "string" || typeof row.symbol !== "string" || !row.name || !row.symbol ||
      typeof row.decimals !== "number" || !Number.isInteger(row.decimals) || row.decimals < 0 || row.decimals > 18) continue;
    const stats = record(row.stats24h) ? row.stats24h : {};
    const buy = decimal(stats.buyVolume, true), sell = decimal(stats.sellVolume, true);
    result.set(row.id, { mint: row.id, name: row.name.slice(0, 120), symbol: row.symbol.slice(0, 24), decimals: row.decimals,
      icon: typeof row.icon === "string" && row.icon.length <= 2048 && /^https:\/\//.test(row.icon) ? row.icon : null,
      verified: typeof row.isVerified === "boolean" ? row.isVerified : null,
      suspicious: record(row.audit) && row.audit.isSus === true,
      liquidityUsd: decimal(row.liquidity, true), volume24hUsd: buy !== null && sell !== null ? fixed(new Amount(buy).plus(sell), 18) : null,
      change1h: record(row.stats1h) ? decimal(row.stats1h.priceChange) : null, change24h: decimal(stats.priceChange),
      providerUpdatedAt: typeof row.updatedAt === "string" && Number.isFinite(Date.parse(row.updatedAt)) ? new Date(row.updatedAt).toISOString() : null });
  }
  return [...result.values()];
}
export async function fetchJupiterTokens(key: string, query: string, options: { signal?: AbortSignal } = {}): Promise<TokenMetadata[]> {
  const url = new URL("https://api.jup.ag/tokens/v2/search"); url.searchParams.set("query", query);
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(4_000)]) : AbortSignal.timeout(4_000);
  const response = await fetch(url, { headers: { "x-api-key": key }, signal });
  const reset = response.headers.get("x-ratelimit-reset");
  if (!response.ok) throw new JupiterHttpError(response.status, reset && Number.isFinite(Number(reset)) ? Number(reset) * 1000 : null);
  let data: unknown;
  try { data = await response.json(); } catch (error) { if (error instanceof SyntaxError) throw new JupiterDataError("Invalid token JSON"); throw error; }
  return parseTokenMetadata(data);
}
