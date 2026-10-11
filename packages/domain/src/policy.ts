import { Amount, MAX_SIMULATED_ORDER_USDC } from "./index.js";

export interface SpotPolicyInput {
  side: "BUY" | "SELL";
  instrumentId: string;
  allowedInstruments: string[];
  notionalUsdc: string;
  quantity: string;
  marketPriceUsdc: string;
  cashUsdc: string;
  positionQuantity: string;
  navUsdc: string;
  sharePriceUsdc: string;
  peakSharePriceUsdc: string;
  maxOrderBps: number;
  maxPositionBps: number;
  drawdownBreakerBps: number;
}

export type PolicyReason =
  | "asset_not_allowed"
  | "order_too_large"
  | "insufficient_cash"
  | "insufficient_position"
  | "position_limit"
  | "drawdown_breaker";

export function evaluateSpotOrder(input: SpotPolicyInput): PolicyReason | null {
  if (!input.allowedInstruments.includes(input.instrumentId)) return "asset_not_allowed";
  const notional = new Amount(input.notionalUsdc);
  const nav = new Amount(input.navUsdc);
  const closesDust = input.side === "SELL" && notional.gt(0) && notional.lt(1) && new Amount(input.quantity).eq(input.positionQuantity);
  if (!closesDust && (notional.gt(MAX_SIMULATED_ORDER_USDC) ||
      notional.gt(nav.mul(input.maxOrderBps).div(10_000)))) return "order_too_large";
  const quantity = new Amount(input.quantity);
  const position = new Amount(input.positionQuantity);
  if (input.side === "SELL") {
    return quantity.gt(position) ? "insufficient_position" : null;
  }
  if (notional.gt(input.cashUsdc)) return "insufficient_cash";
  const breaker = new Amount(input.peakSharePriceUsdc)
    .mul(new Amount(1).minus(new Amount(input.drawdownBreakerBps).div(10_000)));
  if (new Amount(input.sharePriceUsdc).lt(breaker)) return "drawdown_breaker";
  const nextPositionValue = position.plus(quantity).mul(input.marketPriceUsdc);
  if (nextPositionValue.gt(nav.mul(input.maxPositionBps).div(10_000))) return "position_limit";
  return null;
}
