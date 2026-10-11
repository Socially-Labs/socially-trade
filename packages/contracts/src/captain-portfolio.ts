/** Independent of the legacy sequential-round TradingReturns contract. */
export type CaptainPortfolioRange = '7D' | '30D' | '90D' | 'ALL';
export type PortfolioValuationStatus = 'CURRENT' | 'STALE' | 'PARTIAL' | 'UNAVAILABLE';
export interface CaptainPortfolio {
  schemaVersion: 1;
  mode: 'PAPER';
  method: 'AGGREGATE_NAV_TWR_V1';
  range: CaptainPortfolioRange;
  revision: string;
  serverTime: string;
  asOf: string | null;
  valuationAsOf: string | null;
  requestedFrom: string;
  baselineAt: string | null;
  intervalSeconds: number;
  valuationStatus: PortfolioValuationStatus;
  coverage: 'COMPLETE' | 'PARTIAL' | 'UNAVAILABLE';
  aumUsdc: string | null;
  netPnlUsdc: string | null;
  netFlowsUsdc: string | null;
  netReturnPercent: string | null;
  settledVaultPnlUsdc: string | null;
  openVaultPnlUsdc: string | null;
  activeVaults: number;
  openVaults: number;
  totalVaults: number;
  points: { at: string; netPnlUsdc: string | null; netReturnPercent: string | null; indexValue: string | null; hasGap: boolean; segment: string }[];
  methodology: string;
}
export interface CaptainVaultPerformance {
  vaultId: string;
  name: string;
  phase: string;
  aumUsdc: string | null;
  netPnlUsdc: string | null;
  lifetimePnlUsdc: string | null;
  netReturnPercent: string | null;
  baselineAt: string | null;
  valuationStatus: PortfolioValuationStatus;
  valuationAsOf: string | null;
}
