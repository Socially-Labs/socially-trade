import { dynamicTradingEnabled } from "@socially/market-data/registry";
import { walletPaperEnabled,paperOwner } from './paper-portfolio.js';
import { createHash, randomUUID } from 'node:crypto';
import { appendFundEvent, inTransaction, ledgerAccountId, type DbClient, type DbPool } from '@socially/db';
import { Amount, contributionReason, fixed, microUsdc, roundEntitlement, usdcFromMicro, VAULT_RULES } from '@socially/domain';
import type { VaultCreateInput, VaultOperation, VaultSummary, VaultPosition } from '@socially/contracts';
import { tradableInstrumentIds } from '@socially/market-data/catalog';
import type { Actor } from './auth.js';
import { beginIdempotent, finishIdempotent } from './accounting.js';
import { ApiFault } from './errors.js';
import { activateTestVault, testVaultActivationEnabled } from './test-vault-activation.js';

interface RejectedVaultRequest { rejectedVaultRequest: true; statusCode: number; error: string; message: string }
async function vaultMutation(pool:DbPool,actor:Actor,key:string,route:string,body:unknown,statusCode:number,
  work:(client:DbClient)=>Promise<VaultOperation>):Promise<VaultOperation> {
  const outcome=await inTransaction(pool,async client => {
    await client.query("SET LOCAL lock_timeout='3s'");
    await client.query("SET LOCAL statement_timeout='10s'");
    const prior=await beginIdempotent<VaultOperation|RejectedVaultRequest>(client,actor.id,key,route,body);
    if (prior) return prior;
    // Keep the request hash/row lock while rolling back a rejected financial attempt.
    await client.query('SAVEPOINT vault_money');
    try {
      const result=await work(client);
      await finishIdempotent(client,actor.id,key,result,statusCode);
      return result;
    } catch (error) {
      if (!(error instanceof ApiFault) || error.statusCode<400 || error.statusCode>=500 || [408,429].includes(error.statusCode)) throw error;
      await client.query('ROLLBACK TO SAVEPOINT vault_money');
      const rejected:RejectedVaultRequest={ rejectedVaultRequest:true,statusCode:error.statusCode,error:error.code,message:error.message };
      await finishIdempotent(client,actor.id,key,rejected,error.statusCode);
      return rejected;
    }
  });
  if ('rejectedVaultRequest' in outcome) throw new ApiFault(outcome.statusCode,'vault_request_rejected',outcome.message);
  return outcome;
}

// Explicit deployment decision, never a client body field. Existing funded rounds remain recoverable.
export function vaultConfig() {
  const enabled = (!process.env.USDG_MINT || walletPaperEnabled()) && process.env.VAULT_PAPER_ENABLED === 'true' && process.env.VAULT_TERMS_APPROVAL === 'locked-v1-retain-residue';
  return { schemaVersion: 1, mode: 'PAPER', ...VAULT_RULES, enabled, liveEnabled: false, walletSnapshotEnabled: walletPaperEnabled(),
    residuePolicy: 'RETAIN_AS_LIABILITY', emergencyUnwindEnabled: false,
    serverTime: new Date().toISOString() };
}
function requireCreationEnabled() {
  if (!vaultConfig().enabled) throw new ApiFault(503, 'vault_creation_disabled', 'New paper vaults are awaiting approved round terms');
  if (process.env.USDG_MINT && !walletPaperEnabled()) throw new ApiFault(409, 'mode_unavailable', 'Paper rounds require an isolated paper balance environment');
}
export interface RoundRow {
  id: string; captain_id: string; name: string; description: string; status: string; cash_usdc: string; total_shares: string;
  is_demo:boolean; balance_source:'LEGACY'|'WALLET_SNAPSHOT'; phase: VaultSummary['phase']; risk_state: 'NORMAL' | 'FROZEN'; terms_hash: string; terms: Record<string, unknown>; duration_days: number; funding_window_hours: number;
  accepted_capital_usdc: string; funding_closes_at: Date; trading_ends_at: Date; actual_activated_at: Date | null;
  event_sequence: string; blocked_reason: string | null; avatar_url:string|null; banner_url:string|null; final_assets_usdc: string | null; residue_liability_usdc: string | null; final_supply: string | null; distribution_pool_usdc: string | null; captain_fee_usdc: string | null;
}
const roundSql = `SELECT EXISTS(SELECT 1 FROM discovery_demo_seeds d WHERE d.fund_id=f.id) AS is_demo,f.id,f.created_at,f.captain_id,f.name,f.description,f.status,f.cash_usdc::text,f.total_shares::text,
 f.event_sequence::text,r.balance_source,r.phase,r.risk_state,r.terms_hash,r.terms,r.duration_days,r.funding_window_hours,r.accepted_capital_usdc::text,
 (SELECT public_url FROM vault_media WHERE fund_id=f.id AND kind='avatar') AS avatar_url,
 (SELECT public_url FROM vault_media WHERE fund_id=f.id AND kind='banner') AS banner_url,
 r.funding_closes_at,r.trading_ends_at,r.actual_activated_at,r.blocked_reason,r.residue_liability_usdc::text,r.final_assets_usdc::text,r.final_supply::text,r.distribution_pool_usdc::text,r.captain_fee_usdc::text
 FROM funds f JOIN vault_rounds r ON r.fund_id=f.id`;
export async function lockedRound(client: DbClient, id: string) {
  await client.query('SELECT id FROM funds WHERE id=$1 FOR NO KEY UPDATE',[id]);
  // Read the joined round only after the lock: a waiting joined SELECT can retain old round fields.
  const row = (await client.query<RoundRow>(`${roundSql} WHERE f.id=$1`, [id])).rows[0];
  if (!row) throw new ApiFault(404, 'vault_not_found', 'Vault not found');
  if(row.is_demo)throw new ApiFault(409,'demo_read_only','This is a read-only demo vault with simulated performance.');
  return row;
}
export async function databaseNow(client: DbClient): Promise<Date> {
  return (await client.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]!.now;
}
function summary(row: RoundRow & { participants: number; nav_usdc: string | null; priced_at: Date | null; valuation_status: string | null; has_positions: boolean }, now: Date): VaultSummary {
  const fresh = !row.has_positions || !!row.priced_at && now.getTime() - row.priced_at.getTime() <= 90_000 && row.priced_at.getTime() <= now.getTime() + 5000;
  const available = fresh && row.valuation_status === 'CURRENT' && row.phase !== 'SETTLING';
  return { schemaVersion: 1, roundModelVersion: 2, mode: 'PAPER', isDemo:row.is_demo, id: row.id, captainId: row.captain_id,
    name: row.name, description: row.description,avatarUrl:row.avatar_url,bannerUrl:row.banner_url, phase: row.phase, riskState: row.risk_state,
    termsVersion: 1, termsHash: row.terms_hash, durationDays: row.duration_days, fundingWindowHours: row.funding_window_hours,
    universeMode: row.terms.universeMode === 'DYNAMIC_SPOT' ? 'DYNAMIC_SPOT' : 'LEGACY_ALLOWLIST',
    acceptedCapitalUsdc: fixed(row.accepted_capital_usdc,6), remainingCapacityUsdc: fixed(new Amount(30000).minus(row.accepted_capital_usdc),6),
    economicShares: fixed(row.total_shares,6), participants: row.participants,
    fundingClosesAt: row.funding_closes_at.toISOString(), tradingStartsAt: row.funding_closes_at.toISOString(),
    actualActivatedAt: row.actual_activated_at?.toISOString() ?? null, tradingEndsAt: row.trading_ends_at.toISOString(),
    navUsdc: available && row.nav_usdc !== null ? fixed(row.nav_usdc,6) : null,
    valuationStatus: available ? 'CURRENT' : 'UNAVAILABLE', valuedAt: row.priced_at?.toISOString() ?? null,
    eventSequence: row.event_sequence, serverTime: now.toISOString(),blockedReason: row.blocked_reason,
    settlement: row.final_supply && row.final_assets_usdc !== null && row.distribution_pool_usdc !== null && row.captain_fee_usdc !== null ? {
      assetsUsdc: fixed(row.final_assets_usdc,6),distributionPoolUsdc: fixed(row.distribution_pool_usdc,6),captainFeeUsdc: fixed(row.captain_fee_usdc,6),
      finalEconomicShares: fixed(row.final_supply,6),residueLiabilityUsdc: row.residue_liability_usdc === null ? null : fixed(row.residue_liability_usdc,6) } : null };
}
const detailSql = `SELECT base.*, (SELECT count(DISTINCT user_id)::integer FROM vault_contributions WHERE fund_id=base.id AND state='ACCEPTED') AS participants,
 n.nav_usdc::text,n.status AS valuation_status,n.priced_at,
 EXISTS(SELECT 1 FROM positions WHERE fund_id=base.id AND quantity>0) AS has_positions
 FROM (${roundSql}) base LEFT JOIN LATERAL (
 SELECT nav_usdc,status,priced_at FROM nav_snapshots WHERE fund_id=base.id ORDER BY event_sequence DESC NULLS LAST,created_at DESC LIMIT 1
 ) n ON true`;
export async function vaultDetail(pool: DbPool | DbClient, id: string) {
  const row = (await pool.query(`${detailSql} WHERE base.id=$1`,[id])).rows[0];
  if (!row) throw new ApiFault(404,'vault_not_found','Vault not found');
  return summary(row,new Date());
}
export async function vaultList(pool: DbPool, input: { after?: string; limit: number; phase?: string; durationGroup?: string; query?: string; captainId?: string; sort?: string }, actorId?: string, ownedOnly=false) {
  const rows = (await pool.query(`WITH filtered AS (${detailSql} WHERE ($3::text IS NULL OR base.phase=$3) AND ($4::text IS NULL OR
      ($4='short' AND base.duration_days<30) OR ($4='long' AND base.duration_days>=30))
    AND ($5::uuid IS NULL OR base.captain_id=$5 OR EXISTS(SELECT 1 FROM vault_contributions c WHERE c.fund_id=base.id AND c.user_id=$5 AND c.state='ACCEPTED'))
    AND (NOT $6::boolean OR base.captain_id=$5)
    AND ($7::text='' OR strpos(lower(base.name),lower($7))>0)
    AND ($8::uuid IS NULL OR base.captain_id=$8)), ranked AS (
      SELECT *,row_number() OVER(ORDER BY
      CASE WHEN $9='AUM' AND valuation_status='CURRENT' AND phase NOT IN ('SETTLING','REFUNDING')
        AND (NOT has_positions OR priced_at>=clock_timestamp()-interval '90 seconds' AND priced_at<=clock_timestamp()+interval '5 seconds')
        THEN nav_usdc::numeric END DESC NULLS LAST,
      CASE WHEN $9 IN ('RECENT','AUM') THEN created_at END DESC NULLS LAST,id DESC) AS list_rank FROM filtered)
    SELECT * FROM ranked WHERE ($1::uuid IS NULL OR list_rank>(SELECT list_rank FROM ranked WHERE id=$1))
    ORDER BY list_rank LIMIT $2`,[input.after ?? null,input.limit+1,input.phase ?? null,input.durationGroup ?? null,actorId ?? null,ownedOnly,input.query?.trim() ?? '',input.captainId ?? null,input.sort ?? 'ID'])).rows;
  const now = new Date();
  const captains = rows.length ? (await pool.query<{id:string;username:string|null}>('SELECT id,username FROM users WHERE id=ANY($1::uuid[])', [[...new Set(rows.map(row=>row.captain_id))]])).rows : [];
  const handles = new Map(captains.map(c=>[c.id,c.username]));
  return { vaults: rows.slice(0,input.limit).map(row => ({...summary(row,now),captainUsername:handles.get(row.captain_id) ?? null})), nextCursor: rows.length>input.limit ? rows[input.limit-1]!.id : null };
}
async function transfer(client: DbClient, event: string, fromType: string, from: string, toType: string, to: string, asset: string, amount: string, isolated=false) {
  if(isolated&&asset==='USDC'){if(fromType==='USER')from=paperOwner(from);if(toType==='USER')to=paperOwner(to);}
  if (microUsdc(amount) === 0n) return;
  const debit = await ledgerAccountId(client, fromType as 'USER',from,asset);
  const credit = await ledgerAccountId(client, toType as 'USER',to,asset);
  await client.query('INSERT INTO ledger_entries(event_id,account_id,amount) VALUES($1,$2,-$4::numeric),($1,$3,$4)',[event,debit,credit,amount]);
}
async function operation(client: DbClient, actor: Actor, key: string, fundId: string, kind: VaultOperation['kind'], eventId: string, amountUsdc: string): Promise<VaultOperation> {
  const id = randomUUID();
  await client.query(`INSERT INTO vault_operations(id,user_id,client_request_id,fund_id,kind,event_id,amount_usdc) VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [id,actor.id,key,fundId,kind,eventId,amountUsdc]);
  return { id,vaultId: fundId,kind,status: 'SUCCEEDED',mode: 'PAPER',eventId,amountUsdc };
}
async function fundContribution(client: DbClient, actor: Actor, fundId: string, amountUsdc: string, eventId: string, isolated: boolean) {
  const column=isolated?'vault_paper_cash':'paper_cash';
  const user = (await client.query<{ paper_cash: string }>(`SELECT ${column}::text AS paper_cash FROM users WHERE id=$1 FOR NO KEY UPDATE`,[actor.id])).rows[0];
  if (!user || new Amount(user.paper_cash).lt(amountUsdc)) throw new ApiFault(422,'insufficient_virtual_cash','Not enough paper USDC');
  await client.query(`UPDATE users SET ${column}=${column}-$2::numeric WHERE id=$1`,[actor.id,amountUsdc]);
  await client.query('UPDATE funds SET cash_usdc=cash_usdc+$2::numeric,total_shares=total_shares+$2::numeric WHERE id=$1',[fundId,amountUsdc]);
  await client.query(`INSERT INTO fund_shares(fund_id,user_id,shares) VALUES($1,$2,$3)
    ON CONFLICT(fund_id,user_id) DO UPDATE SET shares=fund_shares.shares+EXCLUDED.shares`,[fundId,actor.id,amountUsdc]);
  await client.query('UPDATE vault_rounds SET accepted_capital_usdc=accepted_capital_usdc+$2::numeric WHERE fund_id=$1',[fundId,amountUsdc]);
  await client.query('INSERT INTO vault_contributions(id,fund_id,user_id,amount_usdc,event_id) VALUES($1,$2,$3,$4,$5)',[randomUUID(),fundId,actor.id,amountUsdc,eventId]);
  await transfer(client,eventId,'USER',actor.id,'FUND',fundId,'USDC',amountUsdc,isolated);
  await transfer(client,eventId,'ISSUANCE',fundId,'USER',actor.id,`SHARE:${fundId}`,amountUsdc);
  await client.query(`INSERT INTO nav_snapshots(id,fund_id,nav_usdc,share_price_usdc,status,priced_at,event_sequence)
    SELECT $2,id,cash_usdc,1,'CURRENT',clock_timestamp(),event_sequence FROM funds WHERE id=$1`,[fundId,randomUUID()]);
}
export async function createVault(pool: DbPool, actor: Actor, input: VaultCreateInput, key: string) {
  const name = input.name.trim(), description = input.description.trim();
  if (name.length<3) throw new ApiFault(400,'invalid_name','Vault name is too short');
  const body = { name,description,fundingWindowHours: input.fundingWindowHours,durationDays: input.durationDays,termsVersion: input.termsVersion };
  return vaultMutation(pool,actor,key,'POST /v1/vaults',body,201,async client => {
    requireCreationEnabled();
    const user = (await client.query<{ role: string }>('SELECT role FROM users WHERE id=$1 FOR NO KEY UPDATE',[actor.id])).rows[0];
    if (user?.role !== 'captain') throw new ApiFault(403,'captain_required','Choose the Captain role first');
    // Shared Captain lock also serializes legacy creation across versions.
    const active = await client.query("SELECT 1 FROM funds WHERE captain_id=$1 AND status IN ('ACTIVE','FROZEN')",[actor.id]);
    if (active.rowCount) throw new ApiFault(409,'active_round_exists','Captain already has an open round');
    const now = await databaseNow(client), fundId = randomUUID();
    const close = new Date(now.getTime()+input.fundingWindowHours*3600_000), end = new Date(close.getTime()+input.durationDays*86400_000);
    const terms = { ...VAULT_RULES,universeMode: dynamicTradingEnabled()?'DYNAMIC_SPOT':'LEGACY_ALLOWLIST',fundingWindowHours: input.fundingWindowHours,durationDays: input.durationDays,
      fundingCancellation: 'FULL_BEFORE_DEADLINE',captainCancellation: 'BEFORE_FIRST_CREW_COMMITMENT',
      residuePolicy: 'RETAIN_AS_LIABILITY', emergencyUnwind: 'DISABLED',captainTopUps: false,mode: 'PAPER' };
    const hash = createHash('sha256').update(JSON.stringify(terms)).digest('hex');
    await client.query(`INSERT INTO funds(id,captain_id,name,description,status,round_model_version) VALUES($1,$2,$3,$4,'FROZEN',2)`,[fundId,actor.id,name,description]);
    await client.query(`INSERT INTO vault_rounds(fund_id,balance_source,terms_version,terms,terms_hash,phase,funding_window_hours,duration_days,funding_started_at,funding_closes_at,trading_ends_at,accepted_capital_usdc)
      VALUES($1,$9,1,$2,$3,'FUNDRAISING',$4,$5,$6,$7,$8,0)`,[fundId,terms,hash,input.fundingWindowHours,input.durationDays,now,close,end,walletPaperEnabled()?'WALLET_SNAPSHOT':'LEGACY']);
    await client.query(`INSERT INTO fund_policy_versions(fund_id,version,max_order_bps,max_position_bps,drawdown_breaker_bps,allowed_instruments,effective_at,universe_mode)
      VALUES($1,1,1000,2500,3000,$2,$3,$4)`,[fundId,tradableInstrumentIds,now,dynamicTradingEnabled()?"DYNAMIC_SPOT":"LEGACY_ALLOWLIST"]);
    const event = await appendFundEvent(client,fundId,'vault_created',{ termsHash: hash });
    await fundContribution(client,actor,fundId,VAULT_RULES.captainSeedUsdc,event,walletPaperEnabled());
    if (testVaultActivationEnabled()) await activateTestVault(client,actor,fundId);
    const result = await operation(client,actor,key,fundId,'CREATE',event,VAULT_RULES.captainSeedUsdc);
    return result;
  });
}
export async function contributeVault(pool: DbPool, actor: Actor, id: string, amount: string, termsHash: string, key: string) {
  let amountUsdc: string;
  try { amountUsdc = usdcFromMicro(microUsdc(amount)); } catch { throw new ApiFault(400,'invalid_amount','Use an exact USDC decimal amount'); }
  return vaultMutation(pool,actor,key,`POST /v1/vaults/${id}/contributions`,{ amountUsdc,termsHash },201,async client => {
    const row = await lockedRound(client,id);
    // Sample after both financial locks: waiting for a user balance cannot admit a late join.
    await client.query('SELECT id FROM users WHERE id=$1 FOR NO KEY UPDATE',[actor.id]);
    const now = await databaseNow(client);
    if (row.terms_hash !== termsHash) throw new ApiFault(409,'terms_changed','Review the current vault terms');
    const reason = contributionReason({ phase: row.phase,now: now.getTime(),fundingClosesAt: row.funding_closes_at.getTime(),
      acceptedCapitalUsdc: row.accepted_capital_usdc,amountUsdc,isCaptain: row.captain_id === actor.id });
    if (reason) throw new ApiFault(409,reason,'This contribution cannot be accepted');
    if ((process.env.USDG_MINT && row.balance_source!=='WALLET_SNAPSHOT') || process.env.VAULT_CONTRIBUTIONS_PAUSED === 'true') throw new ApiFault(503,'contributions_paused','New contributions are temporarily paused');
    const event = await appendFundEvent(client,id,'vault_contributed',{});
    await fundContribution(client,actor,id,amountUsdc,event,row.balance_source==='WALLET_SNAPSHOT');
    const result = await operation(client,actor,key,id,'CONTRIBUTE',event,amountUsdc); return result;
  });
}
export async function cancelContribution(pool: DbPool, actor: Actor, id: string, key: string) {
  return vaultMutation(pool,actor,key,`POST /v1/vaults/${id}/contribution-cancellations`,{},200,async client => {
    const row = await lockedRound(client,id);
    await client.query('SELECT id FROM users WHERE id=$1 FOR NO KEY UPDATE',[actor.id]);
    const now = await databaseNow(client);
    if (row.phase !== 'FUNDRAISING' || now >= row.funding_closes_at) throw new ApiFault(409,'funding_closed','Funding cancellation is closed');
    if (actor.id === row.captain_id) {
      // Even a cancelled historical Crew commitment prevents discretionary Captain cancellation.
      const crew = await client.query('SELECT 1 FROM vault_contributions WHERE fund_id=$1 AND user_id<>$2 LIMIT 1',[id,actor.id]);
      if (crew.rowCount) throw new ApiFault(409,'captain_stake_locked','Captain cancellation closes after the first Crew commitment');
      await client.query("UPDATE vault_rounds SET phase='REFUNDING',transition_version=transition_version+1 WHERE fund_id=$1",[id]);
      const event = await appendFundEvent(client,id,'vault_refunding',{});
      const result = await operation(client,actor,key,id,'CANCEL',event,'0.000000'); return result;
    }
    const held = (await client.query<{ shares: string }>('SELECT shares::text FROM fund_shares WHERE fund_id=$1 AND user_id=$2',[id,actor.id])).rows[0];
    if (!held || new Amount(held.shares).lte(0)) throw new ApiFault(409,'no_contribution','No accepted contribution to cancel');
    const amount = fixed(held.shares,6), event = await appendFundEvent(client,id,'vault_contribution_cancelled',{});
    await client.query("UPDATE vault_contributions SET state='CANCELLED',cancelled_event_id=$3 WHERE fund_id=$1 AND user_id=$2 AND state='ACCEPTED'",[id,actor.id,event]);
    await client.query(`UPDATE users SET ${row.balance_source==='WALLET_SNAPSHOT'?'vault_paper_cash':'paper_cash'}=${row.balance_source==='WALLET_SNAPSHOT'?'vault_paper_cash':'paper_cash'}+$2::numeric WHERE id=$1`,[actor.id,amount]);
    await client.query('UPDATE funds SET cash_usdc=cash_usdc-$2::numeric,total_shares=total_shares-$2::numeric WHERE id=$1',[id,amount]);
    await client.query('UPDATE vault_rounds SET accepted_capital_usdc=accepted_capital_usdc-$2::numeric WHERE fund_id=$1',[id,amount]);
    await client.query('UPDATE fund_shares SET shares=0 WHERE fund_id=$1 AND user_id=$2',[id,actor.id]);
    await transfer(client,event,'FUND',id,'USER',actor.id,'USDC',amount,row.balance_source==='WALLET_SNAPSHOT');
    await transfer(client,event,'USER',actor.id,'ISSUANCE',id,`SHARE:${id}`,amount);
    await client.query(`INSERT INTO nav_snapshots(id,fund_id,nav_usdc,share_price_usdc,status,priced_at,event_sequence)
      SELECT $2,id,cash_usdc,1,'CURRENT',clock_timestamp(),event_sequence FROM funds WHERE id=$1`,[id,randomUUID()]);
    const result = await operation(client,actor,key,id,'CANCEL',event,amount); return result;
  });
}
export async function claimVault(pool: DbPool, actor: Actor, id: string, key: string) {
  return vaultMutation(pool,actor,key,`POST /v1/vaults/${id}/claims`,{},200,async client => {
    const row = await lockedRound(client,id);
    if (!row.final_supply || row.distribution_pool_usdc === null || row.captain_fee_usdc === null) throw new ApiFault(409,'claim_unavailable','Settlement is not final');
    const paid = await client.query('SELECT 1 FROM vault_claims WHERE fund_id=$1 AND user_id=$2',[id,actor.id]);
    if (paid.rowCount) throw new ApiFault(409,'already_claimed','This payout has already been claimed');
    const shares = (await client.query<{ shares: string }>('SELECT shares::text FROM fund_shares WHERE fund_id=$1 AND user_id=$2',[id,actor.id])).rows[0]?.shares;
    if (!shares || new Amount(shares).lte(0)) throw new ApiFault(409,'no_entitlement','No payout entitlement');
    await client.query('SELECT id FROM users WHERE id=$1 FOR NO KEY UPDATE',[actor.id]);
    const investment = roundEntitlement(row.distribution_pool_usdc,fixed(shares,6),row.final_supply);
    const fee = actor.id === row.captain_id ? row.captain_fee_usdc : '0.000000';
    const total = usdcFromMicro(microUsdc(investment)+microUsdc(fee));
    const event = await appendFundEvent(client,id,'vault_claimed',{});
    const result = await operation(client,actor,key,id,'CLAIM',event,total);
    await client.query('INSERT INTO vault_claims(fund_id,user_id,investment_usdc,captain_fee_usdc,operation_id) VALUES($1,$2,$3,$4,$5)',[id,actor.id,investment,fee,result.id]);
    await transfer(client,event,'FUND',id,'USER',actor.id,'USDC',total,row.balance_source==='WALLET_SNAPSHOT');
    await transfer(client,event,'USER',actor.id,'ISSUANCE',id,`SHARE:${id}`,fixed(shares,6));
    await client.query(`UPDATE users SET ${row.balance_source==='WALLET_SNAPSHOT'?'vault_paper_cash':'paper_cash'}=${row.balance_source==='WALLET_SNAPSHOT'?'vault_paper_cash':'paper_cash'}+$2::numeric WHERE id=$1`,[actor.id,total]);
    await client.query('UPDATE funds SET cash_usdc=cash_usdc-$2::numeric,total_shares=total_shares-$3::numeric WHERE id=$1',[id,total,shares]);
    await client.query('UPDATE fund_shares SET shares=0 WHERE fund_id=$1 AND user_id=$2',[id,actor.id]);
    // Residue stays in the fund as an explicit outstanding liability; never protocol income.
    return result;
  });
}
export async function vaultPosition(pool: DbPool, actor: Actor, id: string): Promise<VaultPosition> {
  return inTransaction(pool,async client => {
    await client.query("SET LOCAL lock_timeout='3s'");
    await client.query("SET LOCAL statement_timeout='10s'");
    await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const row = (await client.query<RoundRow>(`${roundSql} WHERE f.id=$1`,[id])).rows[0];
    if (!row) throw new ApiFault(404,'vault_not_found','Vault not found');
    const shares = fixed((await client.query<{ shares: string }>('SELECT shares::text FROM fund_shares WHERE fund_id=$1 AND user_id=$2',[id,actor.id])).rows[0]?.shares ?? '0',6);
    const capital = (await client.query<{ capital: string }>("SELECT COALESCE(sum(amount_usdc),0)::text AS capital FROM vault_contributions WHERE fund_id=$1 AND user_id=$2 AND state='ACCEPTED'",[id,actor.id])).rows[0]!.capital;
    const available = (await client.query<{ paper_cash: string }>(`SELECT ${row.balance_source==='WALLET_SNAPSHOT'?'vault_paper_cash':'paper_cash'}::text AS paper_cash FROM users WHERE id=$1`,[actor.id])).rows[0]!.paper_cash;
    const paidRow = (await client.query<{ investment_usdc: string; captain_fee_usdc: string }>('SELECT investment_usdc::text,captain_fee_usdc::text FROM vault_claims WHERE fund_id=$1 AND user_id=$2',[id,actor.id])).rows[0];
    const paid = !!paidRow;
    const detail = await vaultDetail(client,id);
    const investment = row.final_supply && row.distribution_pool_usdc !== null ? roundEntitlement(row.distribution_pool_usdc,shares,row.final_supply) : null;
    const value = paidRow ? paidRow.investment_usdc : investment ?? (detail.navUsdc !== null && new Amount(row.total_shares).gt(0) ? fixed(new Amount(detail.navUsdc).mul(shares).div(row.total_shares),6) : null);
    return { investmentValueUsdc: value,personalPnlUsdc: value !== null ? fixed(new Amount(value).minus(capital),6) : null,
      captainFeeUsdc: paidRow?.captain_fee_usdc ?? (actor.id === row.captain_id ? row.captain_fee_usdc ?? '0.000000' : '0.000000'),
      vaultId: id,availableUsdc: fixed(available,6),contributedUsdc: fixed(capital,6),shares,
      claimableUsdc: paid ? '0.000000' : investment === null ? null : fixed(new Amount(investment).plus(row.captain_id === actor.id ? row.captain_fee_usdc ?? '0' : '0'),6),
      claimPaid: paid,isCaptain: row.captain_id === actor.id };
  });
}
export async function getVaultOperation(pool: DbPool, actorId: string, id?: string, key?: string): Promise<VaultOperation> {
  const row = (await pool.query<{ id: string; fund_id: string; kind: VaultOperation['kind']; event_id: string; amount_usdc: string }>(
    `SELECT id,fund_id,kind,event_id,amount_usdc::text FROM vault_operations WHERE user_id=$1
      AND ($2::uuid IS NULL OR id=$2) AND ($3::text IS NULL OR client_request_id=$3) LIMIT 1`,[actorId,id ?? null,key ?? null])).rows[0];
  if (!row && key) {
    const rejected=(await pool.query<{ response:RejectedVaultRequest|null }>('SELECT response FROM api_idempotency WHERE user_id=$1 AND key=$2',[actorId,key])).rows[0]?.response;
    if (rejected?.rejectedVaultRequest) throw new ApiFault(rejected.statusCode,'vault_request_rejected',rejected.message);
  }
  if (!row) throw new ApiFault(404,'operation_not_found','Operation not found');
  return { id: row.id,vaultId: row.fund_id,kind: row.kind,status: 'SUCCEEDED',mode: 'PAPER',eventId: row.event_id,amountUsdc: fixed(row.amount_usdc,6) };
}
