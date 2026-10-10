export const PAPER_MODE = "PAPER" as const;

export type FundMode = typeof PAPER_MODE;
export type FundStatus = "ACTIVE" | "FROZEN" | "COMPLETED";
export type OrderStatus = "PENDING" | "FILLED" | "PARTIALLY_FILLED" | "REJECTED" | "CANCELLED";
export type OrderSide = "BUY" | "SELL";
export type ValuationStatus = "CURRENT" | "UNAVAILABLE";

export interface ApiError {
  error: string;
  message: string;
}

export interface PaperAmount {
  /** Exact decimal string. Never parse financial values as a JavaScript number. */
  value: string;
  asset: string;
}

export interface FundSummary {
  id: string;
  mode: FundMode;
  status: FundStatus;
  name: string;
  captainId: string;
  nav: PaperAmount;
  sharePrice: PaperAmount;
  valuationStatus: ValuationStatus;
  trialEndsAt: string;
}
export * from './vaults.js';
export * from './markets.js';
export * from './paper-trading.js';
