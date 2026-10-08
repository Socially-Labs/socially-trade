/** Round-v2 uses integer micro-USDC and six-decimal economic shares. */
export const VAULT_RULES = Object.freeze({
  roundModelVersion: 2 as const, termsVersion: 1 as const, feeModelVersion: 2 as const,
  captainSeedUsdc: '100.000000', minimumCapitalUsdc: '1000.000000',
  maximumCapitalUsdc: '30000.000000', minimumCrewDepositUsdc: '50.000000',
  fundingWindowHours: [12, 24, 72] as readonly number[],
  durationDays: [3, 7, 14, 21, 28, 30, 60, 90, 180, 365] as readonly number[],
  performanceFeeBps: 1000, feeBasis: 'TOTAL_NET_ROUND_PROFIT' as const,
  feeTiming: 'FINAL_SETTLEMENT' as const, exitPolicy: 'LOCKED_UNTIL_SETTLEMENT' as const,
});
export const VAULT_PHASES = ['FUNDRAISING', 'ACTIVE', 'SETTLING', 'COMPLETED', 'REFUNDING', 'CANCELLED'] as const;
export type VaultPhase = typeof VAULT_PHASES[number];
export type VaultRiskState = 'NORMAL' | 'FROZEN';
export function microUsdc(raw: unknown): bigint {
  if (typeof raw !== 'string' || !/^(0|[1-9]\d{0,23})(\.\d{1,6})?$/.test(raw)) throw new Error('Invalid USDC amount');
  const [whole, fraction = ''] = raw.split('.');
  return BigInt(whole!) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
}
export function usdcFromMicro(value: bigint): string {
  if (value < 0n) throw new Error('Negative USDC amount');
  return `${value / 1_000_000n}.${(value % 1_000_000n).toString().padStart(6, '0')}`;
}
export function contributionReason(input: { phase: VaultPhase; now: number; fundingClosesAt: number;
  acceptedCapitalUsdc: string; amountUsdc: string; isCaptain: boolean }): string | null {
  const amount = microUsdc(input.amountUsdc);
  if (input.isCaptain) return 'captain_seed_fixed';
  if (input.phase !== 'FUNDRAISING' || input.now >= input.fundingClosesAt) return 'funding_closed';
  if (amount < microUsdc(VAULT_RULES.minimumCrewDepositUsdc)) return 'amount_too_small';
  if (microUsdc(input.acceptedCapitalUsdc) + amount > microUsdc(VAULT_RULES.maximumCapitalUsdc)) return 'capacity_exceeded';
  return null;
}
export function roundTradeAllowed(phase: VaultPhase, risk: VaultRiskState, now: number, endsAt: number, side: 'BUY' | 'SELL'): boolean {
  return phase === 'ACTIVE' && now < endsAt && (risk === 'NORMAL' || side === 'SELL');
}
export function dueRoundPhase(phase: VaultPhase, now: number, closesAt: number, endsAt: number, capital: string): VaultPhase {
  if (phase === 'FUNDRAISING' && now >= closesAt) {
    if (microUsdc(capital) < microUsdc(VAULT_RULES.minimumCapitalUsdc)) return 'REFUNDING';
    return now >= endsAt ? 'SETTLING' : 'ACTIVE';
  }
  return phase === 'ACTIVE' && now >= endsAt ? 'SETTLING' : phase;
}
/** Supply and pool are immutable at finalization; claims never use remaining supply. */
export function roundSettlement(principalUsdc: string, assetsUsdc: string) {
  const principal = microUsdc(principalUsdc), assets = microUsdc(assetsUsdc);
  const profit = assets > principal ? assets - principal : 0n;
  const fee = profit * BigInt(VAULT_RULES.performanceFeeBps) / 10_000n;
  return { captainFeeUsdc: usdcFromMicro(fee), distributionPoolUsdc: usdcFromMicro(assets - fee) };
}
export function roundEntitlement(poolUsdc: string, shares: string, finalSupply: string): string {
  const units = microUsdc(shares), supply = microUsdc(finalSupply);
  if (supply <= 0n || units > supply) throw new Error('Invalid economic supply');
  return usdcFromMicro(microUsdc(poolUsdc) * units / supply);
}
