import { SOL_MINT, USDC_MINT } from "./jupiter.js";

export const mintPattern = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export type MarketCategory = "Major assets" | "Tokens" | "Memecoins";
export interface SupportedToken { id: string; mint: string; symbol: string; name: string; decimals: number; category: MarketCategory; tradable: boolean }
// Explicit identities. BTC remains absent until a wrapped representation is selected.
export const supportedTokens: readonly SupportedToken[] = [
  { id: "SOL", mint: SOL_MINT, symbol: "SOL", name: "Solana", decimals: 9, category: "Major assets", tradable: true },
  { id: "JUP", mint: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN", symbol: "JUP", name: "Jupiter", decimals: 6, category: "Tokens", tradable: true },
  { id: "JTO", mint: "jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL", symbol: "JTO", name: "Jito", decimals: 9, category: "Tokens", tradable: true },
  { id: "BONK", mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", symbol: "BONK", name: "Bonk", decimals: 5, category: "Memecoins", tradable: true },
  { id: "USDC", mint: USDC_MINT, symbol: "USDC", name: "USD Coin", decimals: 6, category: "Major assets", tradable: false },
];
export const supportedByMint = new Map(supportedTokens.map(token => [token.mint, token]));
export const supportedById = new Map(supportedTokens.map(token => [token.id, token]));
export const tradableInstrumentIds = supportedTokens.filter(token => token.tradable).map(token => token.id);

export function instrumentSubset(value?: string[]): string[] {
  const ids = value ?? supportedTokens.map(token => token.id);
  if (!ids.length || ids.length > 50 || new Set(ids).size !== ids.length || ids.some(id => !supportedById.has(id))) {
    throw new Error("Unsupported instrument subset");
  }
  return ids;
}
