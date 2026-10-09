export interface SwapConfig {
  rpcUrl: string; venueUrl: string; slippageBps: number; maxPriceImpact: number;
  priorityMicroLamports: number; maxNetworkFeeLamports: number; feeReserveLamports: number;
  quotesPerHour: number; preparesPerHour: number; quoteLifetimeMs: number;
}
export function loadSwapConfig(): SwapConfig | null {
  const enabled = process.env.SWAP_ENABLED ?? 'true';
  if (!['true','false'].includes(enabled)) throw new Error('SWAP_ENABLED must be true or false');
  if (enabled === 'false') return null;
  const number = (name: string, fallback: number, min: number, max: number) => {
    const raw = process.env[name] ?? String(fallback), value = Number(raw);
    if (!/^\d+(\.\d+)?$/.test(raw) || !Number.isFinite(value) || value < min || value > max) throw new Error(`Invalid ${name}`);
    return value;
  };
  const integer = (name: string, fallback: number, min: number, max: number) => {
    const value = number(name,fallback,min,max);
    if (!Number.isSafeInteger(value)) throw new Error(`Invalid ${name}`);
    return value;
  };
  const url = (name: string, fallback: string) => {
    const value = new URL(process.env[name] ?? fallback);
    if (value.protocol !== 'https:' || value.username || value.password || value.hash || value.search) throw new Error(`Invalid ${name}: HTTPS URL required`);
    return value.toString().replace(/\/$/,'');
  };
  return {
    // SOLANA_RPC_URL is the user's canonical devnet endpoint for wallet swaps.
    rpcUrl: url('SOLANA_RPC_URL',process.env.DEVNET_RPC_URL ?? 'https://api.devnet.solana.com'),
    venueUrl: url('SWAP_VENUE_URL','https://transaction-v1-devnet.raydium.io'),
    slippageBps: integer('SWAP_SLIPPAGE_BPS',100,1,100), maxPriceImpact: number('SWAP_MAX_PRICE_IMPACT_PCT',5,0,5),
    priorityMicroLamports: integer('SWAP_PRIORITY_MICRO_LAMPORTS',10000,0,1000000),
    maxNetworkFeeLamports: integer('SWAP_MAX_NETWORK_FEE_LAMPORTS',1000000,5000,10000000),
    // A visible swap sheet polls every three seconds, leaving headroom for edits/retries.
    feeReserveLamports: 10000000, quotesPerHour: integer('SWAP_QUOTES_PER_HOUR',1800,1,10000),
    preparesPerHour: integer('SWAP_PREPARES_PER_HOUR',30,1,1000), quoteLifetimeMs: 30000,
  };
}
