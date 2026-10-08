import { Decimal } from "decimal.js";

export const Amount = Decimal.clone({ precision: 60, rounding: Decimal.ROUND_DOWN });
export type Amount = Decimal;

export const USDC_DECIMALS = 6;
export const SHARE_DECIMALS = 18;
export const MAX_PRICE_AGE_MS = 90_000;
export const MAX_SIMULATED_ORDER_USDC = "1000";

const decimalInput = /^(0|[1-9]\d*)(\.\d+)?$/;

export function parsePositiveAmount(raw: unknown, scale: number): Decimal {
  if (typeof raw !== "string" || !decimalInput.test(raw)) {
    throw new Error("Amount must be a nonnegative decimal string");
  }
  const value = new Amount(raw);
  if (value.lte(0) || value.decimalPlaces() > scale) {
    throw new Error(`Amount must be positive with at most ${scale} decimal places`);
  }
  return value;
}

export function fixed(value: Decimal.Value, scale: number): string {
  return new Amount(value).toFixed(scale, Decimal.ROUND_DOWN);
}

export function fixedUp(value: Decimal.Value, scale: number): string {
  return new Amount(value).toFixed(scale, Decimal.ROUND_UP);
}

export { evaluateSpotOrder } from "./policy.js";
export type { SpotPolicyInput, PolicyReason } from "./policy.js";
export { calculatePerformanceFee, PERFORMANCE_FEE_MODEL_VERSION } from "./fees.js";
export { calculatePerformance, personalPerformance, returnPercent } from "./performance.js";
export type { PerformancePoint } from "./performance.js";
export * from './vault-rounds.js';
