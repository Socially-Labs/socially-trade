export const vaultPhases = ['FUNDRAISING', 'ACTIVE', 'SETTLING', 'COMPLETED', 'REFUNDING', 'CANCELLED'] as const;
export type VaultPhase = typeof vaultPhases[number];
export interface VaultCreateInput { name: string; description: string; fundingWindowHours: number; durationDays: number; termsVersion: 1 }
export const vaultCreateSchema = {
  type: 'object', additionalProperties: false,
  required: ['name', 'description', 'fundingWindowHours', 'durationDays', 'termsVersion'],
  properties: {
    name: { type: 'string', minLength: 3, maxLength: 80 }, description: { type: 'string', maxLength: 1000 },
    fundingWindowHours: { type: 'integer', enum: [12, 24, 72] },
    durationDays: { type: 'integer', enum: [3, 7, 14, 21, 28, 30, 60, 90, 180, 365] }, termsVersion: { const: 1 },
  },
} as const;
export interface VaultSummary {
  schemaVersion: 1; roundModelVersion: 2; mode: 'PAPER'; id: string; captainId: string;
  name: string; description: string; avatarUrl?: string|null; bannerUrl?:string|null; phase: VaultPhase; riskState: 'NORMAL' | 'FROZEN';
  termsVersion: 1; termsHash: string; durationDays: number; fundingWindowHours: number;
  universeMode?: 'LEGACY_ALLOWLIST' | 'DYNAMIC_SPOT';
  acceptedCapitalUsdc: string; remainingCapacityUsdc: string; economicShares: string; participants: number;
  fundingClosesAt: string; tradingStartsAt: string; actualActivatedAt: string | null; tradingEndsAt: string;
  navUsdc: string | null; valuationStatus: 'CURRENT' | 'UNAVAILABLE'; valuedAt: string | null;
  eventSequence: string; serverTime: string;
  settlement: { assetsUsdc: string; distributionPoolUsdc: string; captainFeeUsdc: string; finalEconomicShares: string; residueLiabilityUsdc: string | null } | null;
  blockedReason: string | null;
}
export interface VaultOperation { id: string; vaultId: string; kind: 'CREATE' | 'CONTRIBUTE' | 'CANCEL' | 'CLAIM';
  status: 'SUCCEEDED'; mode: 'PAPER'; eventId: string; amountUsdc: string }
export interface VaultPosition { vaultId: string; availableUsdc: string; contributedUsdc: string; shares: string;
  claimableUsdc: string | null; claimPaid: boolean; isCaptain: boolean;
  investmentValueUsdc: string | null; personalPnlUsdc: string | null; captainFeeUsdc: string }
/** Public WS messages carry invalidations only: no raw event payload or user data. */
export interface VaultUpdate { type: 'vault.updated' | 'resync'; vaultId: string; eventSequence: string }
export const vaultContributionSchema = { type: 'object', additionalProperties: false, required: ['amountUsdc', 'termsHash'],
  properties: { amountUsdc: { type: 'string', pattern: '^(0|[1-9][0-9]{0,23})(\\.[0-9]{1,6})?$' },
    termsHash: { type: 'string', pattern: '^[a-f0-9]{64}$' } } } as const;
export function parseVaultSummary(value: unknown): VaultSummary {
  if (!value || typeof value !== 'object') throw new Error('Invalid vault response');
  const v = value as Record<string, unknown>;
  const amount = (s: unknown) => typeof s === 'string' && /^(0|[1-9]\d{0,23})\.\d{6}$/.test(s);
  const date = (s: unknown) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(s) && Number.isFinite(Date.parse(s));
  const image = (s:unknown) => { if (s===undefined || s===null) return true; try { const url=new URL(String(s)); return typeof s==='string' && url.protocol==='https:' && !url.username && !url.password; } catch { return false; } };
  const uuid = (s: unknown) => typeof s === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(s);
  if (v.schemaVersion !== 1 || v.roundModelVersion !== 2 || v.mode !== 'PAPER' || !uuid(v.id) || !uuid(v.captainId) ||
    !image(v.avatarUrl) || !image(v.bannerUrl) || typeof v.name !== 'string' || typeof v.description !== 'string' || !vaultPhases.includes(v.phase as VaultPhase) ||
    !['NORMAL','FROZEN'].includes(String(v.riskState)) || v.termsVersion !== 1 ||
    (v.universeMode !== undefined && !['LEGACY_ALLOWLIST','DYNAMIC_SPOT'].includes(String(v.universeMode))) ||
    typeof v.termsHash !== 'string' || !/^[a-f0-9]{64}$/.test(v.termsHash) ||
    ![12,24,72].includes(Number(v.fundingWindowHours)) || typeof v.fundingWindowHours !== 'number' ||
    ![3,7,14,21,28,30,60,90,180,365].includes(Number(v.durationDays)) || typeof v.durationDays !== 'number' ||
    !Number.isInteger(v.participants) || Number(v.participants) < 1 ||
    !['acceptedCapitalUsdc','remainingCapacityUsdc','economicShares'].every(k => amount(v[k])) ||
    !['fundingClosesAt','tradingStartsAt','tradingEndsAt','serverTime'].every(k => date(v[k])) ||
    !(v.actualActivatedAt === null || date(v.actualActivatedAt)) || !(v.valuedAt === null || date(v.valuedAt)) ||
    !(v.navUsdc === null || amount(v.navUsdc)) || !['CURRENT','UNAVAILABLE'].includes(String(v.valuationStatus)) ||
    (v.valuationStatus === 'CURRENT' && (v.navUsdc === null || v.valuedAt === null)) ||
    !(v.blockedReason === null || typeof v.blockedReason === 'string') ||
    !(v.settlement === null || typeof v.settlement === 'object' && v.settlement !== null &&
      ['assetsUsdc','distributionPoolUsdc','captainFeeUsdc','finalEconomicShares'].every(k => amount((v.settlement as Record<string,unknown>)[k])) &&
      ((v.settlement as Record<string,unknown>).residueLiabilityUsdc === null || amount((v.settlement as Record<string,unknown>).residueLiabilityUsdc))) ||
    typeof v.eventSequence !== 'string' || !/^(0|[1-9]\d*)$/.test(v.eventSequence)) throw new Error('Invalid vault response');
  return v as unknown as VaultSummary;
}
