/** Shared, validated policy. Defaults are versioned simulation assumptions, configurable per environment. */
export function envInteger(name: string, fallback: number, min = 1, max = 2_147_483_647): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}`);
  return value;
}
export const paperPolicy = Object.freeze({
  priceMaxAgeMs: envInteger('PAPER_PRICE_MAX_AGE_MS', 15_000),
  priceFutureSkewMs: envInteger('PAPER_PRICE_FUTURE_SKEW_MS', 5_000, 0),
  orderDelayMs: envInteger('PAPER_ORDER_DELAY_MS', 3_000, 0),
  orderTimeoutMs: envInteger('PAPER_ORDER_TIMEOUT_MS', 120_000),
  maxOrderUsdc: envInteger('PAPER_MAX_ORDER_USDC', 1000),
  trackedAssetLimit: envInteger('PAPER_TRACKED_ASSET_LIMIT', 100, 1, 1000),
  spreadBps: envInteger('PAPER_SPREAD_BPS', 20, 0, 9999),
  unwindCostBps: envInteger('PAPER_UNWIND_COST_BPS',20,0,9999),
  feeBps: envInteger('PAPER_FEE_BPS', 10, 0, 9999),
  impactBpsPerThousand: envInteger('PAPER_IMPACT_BPS_PER_THOUSAND', 1, 0, 1000),
  maxImpactBps: envInteger('PAPER_MAX_IMPACT_BPS', 50, 0, 9999),
});
if (paperPolicy.orderTimeoutMs <= paperPolicy.orderDelayMs || paperPolicy.spreadBps + paperPolicy.maxImpactBps + paperPolicy.feeBps >= 10000) throw new Error('Invalid paper execution policy');
export function freshPaperPrice(sourceAt: Date | string | null, confirmedAt: Date | string | null, now = Date.now()): boolean {
  return [sourceAt, confirmedAt].every(value => {
    const time = value instanceof Date ? value.getTime() : value ? Date.parse(value) : NaN;
    return Number.isFinite(time) && time <= now + paperPolicy.priceFutureSkewMs && now - time <= paperPolicy.priceMaxAgeMs;
  });
}
