import { Amount, fixed } from "@socially/domain";
import { registeredInstruments } from "./registry.js";
import type { DiscoveryStorage } from "./discovery.js";
export const historyRanges = { "5M": [300, 5], "6H": [21600, 30], "1H": [3600, 10], "24H": [86400, 120], "7D": [604800, 900], "30D": [2592000, 3600] } as const;
export type HistoryRange = keyof typeof historyRanges;
export async function readHistory(pool: DiscoveryStorage, mint: string, range: HistoryRange, now = new Date()) {
  const token = (await registeredInstruments(pool,undefined,[mint]))[0];
  if (!token) throw new Error("History is collected for supported markets only");
  const [seconds, intervalSeconds] = historyRanges[range];
  const start = new Date(now.getTime() - seconds * 1000);
  const points = (await pool.query(`
    SELECT source_at,price_usd::text FROM (
      SELECT DISTINCT ON (floor(extract(epoch FROM source_at)/$4)) source_at,price_usd
      FROM market_samples WHERE instrument_id=$1 AND source_at >= $2 AND source_at <= $3
      ORDER BY floor(extract(epoch FROM source_at)/$4),source_at DESC
    ) samples ORDER BY source_at LIMIT 721`, [token.id, start, now, intervalSeconds])).rows as { source_at: Date; price_usd: string }[];
  const first = points[0], last = points.at(-1);
  const hasStart = !!first && first.source_at.getTime() - start.getTime() <= Math.max(intervalSeconds * 1000, 60_000);
  const freshEnd = !!last && now.getTime() - last.source_at.getTime() <= Math.max(intervalSeconds * 1000, 15_000);
  const gaps = points.some((point, i) => i > 0 && point.source_at.getTime() - points[i - 1]!.source_at.getTime() > Math.max(intervalSeconds * 3000, 60_000));
  return { mint, instrumentId: token.id, range, denomination: "USD", source: "JUPITER_PRICE_V3", intervalSeconds,
    from: start.toISOString(), to: now.toISOString(),
    coverage: { start: first?.source_at.toISOString() ?? null, end: last?.source_at.toISOString() ?? null,
      status: points.length < 2 ? "UNAVAILABLE" : hasStart && freshEnd && !gaps ? "COMPLETE" : "PARTIAL", hasGaps: gaps },
    changePercent: hasStart && freshEnd && !gaps && first && last ? fixed(new Amount(last.price_usd).div(first.price_usd).minus(1).mul(100), 18) : null,
    points: points.map(point => ({ at: point.source_at.toISOString(), price: point.price_usd })) };
}
