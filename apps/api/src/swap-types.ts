export const SWAP_NETWORK = {
  cluster: 'devnet', genesisHash: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  solMint: 'So11111111111111111111111111111111111111112',
  usdcMint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
} as const;
export type SwapToken = 'SOL' | 'USDC';
export const mintOf = (token: SwapToken) => token === 'SOL' ? SWAP_NETWORK.solMint : SWAP_NETWORK.usdcMint;
export interface VenueFee { mint: string; amountRaw: string }
export interface VenueQuote {
  input: SwapToken; output: SwapToken; amount: string; outputAmount: string; minimumOutput: string;
  priceImpact: number; slippageBps: number; hops: number; venueFees: VenueFee[] | null;
  response: Record<string, unknown>; expiresAt?: string;
}
export interface SwapFees {
  // Total includes priority; never add priority to total again.
  networkFeeLamports: string; priorityFeeLamports: string; accountRentLamports: string;
}
export interface PreparedSwap {
  transaction: string; blockhash: string; lastValidBlockHeight: number; fees: SwapFees;
}
export type SwapObservation = { status: 'pending' | 'expired' | 'failed'; failure?: string } |
  { status: 'confirmed'; filledOutputRaw: string; networkFeeLamports: string };
export interface SwapChain {
  quote(input: SwapToken, amount: string): Promise<VenueQuote>;
  prepare(quote: VenueQuote, wallet: string): Promise<PreparedSwap>;
  verifySigned(unsigned: string, signed: string, wallet: string): { signature: string; wire: string };
  observe(input: { signature: string | null; unsigned: string; quote: VenueQuote; wallet: string; lastValidBlockHeight: number }): Promise<SwapObservation>;
  broadcast(wire: string): Promise<void>;
}
