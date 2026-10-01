import { Amount, fixed } from "./index.js";

export interface PerformancePoint {
  sequence: string;
  recordedAt: string;
  pricedAt: string;
  navUsdc: string;
  sharePriceUsdc: string;
  performanceFeeFactor: string;
}

export function returnPercent(end: string, start: string): string | null {
  if (new Amount(start).lte(0)) return null;
  return fixed(new Amount(end).div(start).minus(1).mul(100), 18);
}

/** Unit prices remove subscriptions/redemptions from returns. Gross retains trading costs. */
export function calculatePerformance(points: readonly PerformancePoint[], asOf: Date) {
  if (!points.length) return null;
  const first = points[0]!;
  const last = points[points.length - 1]!;
  const gross = (point: PerformancePoint) => new Amount(point.sharePriceUsdc).mul(point.performanceFeeFactor).toString();
  let peak = new Amount(first.sharePriceUsdc);
  let maxDrawdown = new Amount(0);
  for (const point of points) {
    const price = new Amount(point.sharePriceUsdc);
    peak = Amount.max(peak, price);
    if (peak.gt(0)) maxDrawdown = Amount.max(maxDrawdown, peak.minus(price).div(peak).mul(100));
  }
  const period = (days: number) => {
    const cutoff = asOf.getTime() - days * 86_400_000;
    const baseline = points.filter((point) => Date.parse(point.recordedAt) <= cutoff).at(-1);
    if (!baseline || Date.parse(last.recordedAt) <= cutoff) return null;
    return {
      baselineAt: baseline.recordedAt,
      endAt: last.recordedAt,
      netReturnPercent: returnPercent(last.sharePriceUsdc, baseline.sharePriceUsdc),
      grossReturnPercent: returnPercent(gross(last), gross(baseline)),
    };
  };
  return {
    sinceInception: {
      netReturnPercent: returnPercent(last.sharePriceUsdc, first.sharePriceUsdc),
      grossReturnPercent: returnPercent(gross(last), gross(first)),
    },
    period7d: period(7),
    period30d: period(30),
    maxDrawdownPercent: fixed(maxDrawdown, 18),
    currentDrawdownPercent: peak.gt(0) ? fixed(peak.minus(last.sharePriceUsdc).div(peak).mul(100), 18) : null,
    sampleCount: points.length,
    firstRecordedAt: first.recordedAt,
    lastRecordedAt: last.recordedAt,
  };
}

export function personalPerformance(contributions: string, withdrawals: string, currentValue: string | null) {
  const pnl = currentValue === null ? null : new Amount(withdrawals).plus(currentValue).minus(contributions);
  return {
    contributionsUsdc: fixed(contributions, 6),
    withdrawalsUsdc: fixed(withdrawals, 6),
    currentValueUsdc: currentValue === null ? null : fixed(currentValue, 6),
    pnlUsdc: pnl === null ? null : fixed(pnl, 6),
    pnlPercentOfContributions: pnl === null || new Amount(contributions).lte(0)
      ? null : fixed(pnl.div(contributions).mul(100), 18),
    returnMethod: "SIMPLE_PNL_OVER_CONTRIBUTIONS",
    explanation: "Includes earned Captain fee shares. This percentage ignores cash-flow timing and is not IRR or a time-weighted return.",
  };
}
