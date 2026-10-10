import type { DiscoveryStorage } from './discovery.js';
import type { SupportedToken } from './catalog.js';
export type Instrument = SupportedToken & { active: boolean; eligibility: 'ELIGIBLE'|'SELL_ONLY'|'DISABLED'; eligibilityReason: string|null };
export type UniversePolicy = { universe_mode: 'LEGACY_ALLOWLIST'|'DYNAMIC_SPOT'; allowed_instruments: string[] };
export const dynamicTradingEnabled = () => process.env.PAPER_DYNAMIC_MARKETS_ENABLED === 'true';
/** Global eligibility and vault permission, shared by context, preview, submit and worker.
 * active=false pauses buys; DISABLED is an explicit emergency halt including sells. */
export function assetTradeReason(instrument: Instrument | undefined, policy: UniversePolicy, side: 'BUY'|'SELL', held = false): string|null {
  if (!instrument) return 'unsupported_instrument';
  if (instrument.id === 'USDC') return 'quote_asset';
  if (instrument.eligibility === 'DISABLED') return instrument.eligibilityReason ?? 'asset_disabled';
  if (side === 'SELL' && held) return null;
  if (!instrument.active || instrument.eligibility !== 'ELIGIBLE') return instrument.eligibilityReason ?? 'asset_disabled';
  if (policy.allowed_instruments.includes(instrument.id)) return null;
  if (policy.universe_mode === 'DYNAMIC_SPOT' && dynamicTradingEnabled()) return null;
  return policy.universe_mode === 'DYNAMIC_SPOT' && !dynamicTradingEnabled() ? 'dynamic_buys_paused' : 'asset_not_allowed';
}
export async function registeredInstruments(pool: DiscoveryStorage, ids?: string[], mints?: string[]): Promise<Instrument[]> {
  const rows = (await pool.query(`SELECT i.id,i.mint_address AS mint,i.symbol,i.decimals,i.active,i.eligibility,
    i.eligibility_reason AS "eligibilityReason",COALESCE(m.payload->>'name',i.symbol) AS name
    FROM instruments i LEFT JOIN market_token_metadata m ON m.mint=i.mint_address
    WHERE i.mint_address IS NOT NULL AND ($1::text[] IS NULL OR i.id=ANY($1)) AND ($2::text[] IS NULL OR i.mint_address=ANY($2))
    ORDER BY i.id LIMIT 1000`,[ids ?? null,mints ?? null])).rows as Omit<Instrument,'category'|'tradable'>[];
  return rows.map(row=>({...row,category: row.id==='SOL'||row.id==='USDC'?'Major assets':row.id==='BONK'?'Memecoins':'Tokens',tradable:row.id!=='USDC' && row.active && row.eligibility==='ELIGIBLE'}));
}
