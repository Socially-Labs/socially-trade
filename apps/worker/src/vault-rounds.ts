import { appendFundEvent, inTransaction, ledgerAccountId, saveFundNav, type DbClient, type DbPool } from '@socially/db';
import { Amount, dueRoundPhase, fixed, MAX_PRICE_AGE_MS, roundSettlement, type VaultPhase } from '@socially/domain';

interface Round {
  id: string; phase: VaultPhase; cash_usdc: string; total_shares: string; accepted_capital_usdc: string;
  funding_closes_at: Date; trading_ends_at: Date;
}
async function move(client: DbClient,event: string,from: string,to: string,amount: string) {
  if (new Amount(amount).eq(0)) return;
  await client.query('INSERT INTO ledger_entries(event_id,account_id,amount) VALUES($1,$2,-$4::numeric),($1,$3,$4)',[event,from,to,amount]);
}
/** One transition, one asset unwind, or finalization per round per tick. Each checkpoint commits
 * atomically with its ledger/event. No pending order is locked while holding the fund lock.
 */
export async function advanceVaultRound(pool: DbPool,id: string): Promise<boolean> {
  return inTransaction(pool,async client => {
    await client.query("SET LOCAL lock_timeout='2s'");
    await client.query("SET LOCAL statement_timeout='10s'");
    const locked = await client.query('SELECT id FROM funds WHERE id=$1 FOR NO KEY UPDATE SKIP LOCKED',[id]);
    if (!locked.rowCount) return false;
    const round = (await client.query<Round>(`SELECT f.id,f.cash_usdc::text,f.total_shares::text,r.phase,
      r.accepted_capital_usdc::text,r.funding_closes_at,r.trading_ends_at
      FROM funds f JOIN vault_rounds r ON r.fund_id=f.id WHERE f.id=$1`,[id])).rows[0];
    if (!round) return false;
    await client.query('UPDATE vault_rounds SET last_attempted_at=clock_timestamp() WHERE fund_id=$1',[id]);
    const now = (await client.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]!.now;
    const phase = dueRoundPhase(round.phase,now.getTime(),round.funding_closes_at.getTime(),round.trading_ends_at.getTime(),round.accepted_capital_usdc);
    if (phase !== round.phase) {
      await client.query(`UPDATE vault_rounds SET phase=$2,transition_version=transition_version+1,
        actual_activated_at=CASE WHEN $2 IN ('ACTIVE','SETTLING') AND phase='FUNDRAISING' THEN $3 ELSE actual_activated_at END WHERE fund_id=$1`,[id,phase,now]);
      await client.query("UPDATE funds SET status=CASE WHEN $2='ACTIVE' THEN 'ACTIVE' ELSE 'FROZEN' END WHERE id=$1",[id,phase]);
      await appendFundEvent(client,id,phase === 'ACTIVE' ? 'vault_active' : phase === 'REFUNDING' ? 'vault_refunding' : 'vault_settling',{});
      return true;
    }
    if (phase !== 'SETTLING' && phase !== 'REFUNDING') return false;
    const position = (await client.query<{ instrument_id: string; quantity: string }>(
      'SELECT instrument_id,quantity::text FROM positions WHERE fund_id=$1 AND quantity>0 ORDER BY instrument_id LIMIT 1',[id])).rows[0];
    if (position) {
      if (phase === 'REFUNDING') throw new Error('Fundraising round unexpectedly has market exposure');
      const mark = (await client.query<{ id: string; price_usdc: string; source_at: Date }>(`SELECT id,price_usdc::text,source_at FROM price_observations
        WHERE instrument_id=$1 AND source_at<=$3 AND price_usdc>0
        AND (source='JUPITER_PRICE_V3' OR ($2::boolean AND source='DEV_SEED')) ORDER BY source_at DESC,received_at DESC LIMIT 1`,
        [position.instrument_id,process.env.NODE_ENV !== 'production' && process.env.DEV_PRICE_SEED_ENABLED === 'true',now])).rows[0];
      if (!mark) {
        await client.query("UPDATE vault_rounds SET blocked_reason='price_unavailable' WHERE fund_id=$1",[id]);
        return false;
      }
      const proceeds = fixed(new Amount(position.quantity).mul(mark.price_usdc).mul('0.998'),6);
      const event = await appendFundEvent(client,id,'vault_asset_unwound',{ instrumentId: position.instrument_id,quantity: position.quantity,proceedsUsdc: proceeds,observationId: mark.id,modelVersion: 1,priceSourceAt: mark.source_at.toISOString(),priceAgeMs: now.getTime()-mark.source_at.getTime(),pricingPolicy: now.getTime()-mark.source_at.getTime()>MAX_PRICE_AGE_MS ? 'LAST_RECORDED_PRICE' : 'FRESH_PRICE' });
      const fundAsset = await ledgerAccountId(client,'FUND',id,position.instrument_id), marketAsset = await ledgerAccountId(client,'MARKET','paper-market',position.instrument_id);
      const fundCash = await ledgerAccountId(client,'FUND',id,'USDC'), marketCash = await ledgerAccountId(client,'MARKET','paper-market','USDC');
      await move(client,event,fundAsset,marketAsset,position.quantity);
      await move(client,event,marketCash,fundCash,proceeds);
      await client.query('UPDATE positions SET quantity=0,cost_basis_usdc=0 WHERE fund_id=$1 AND instrument_id=$2',[id,position.instrument_id]);
      await client.query('UPDATE funds SET cash_usdc=cash_usdc+$2::numeric WHERE id=$1',[id,proceeds]);
      await client.query('UPDATE vault_rounds SET blocked_reason=NULL,transition_version=transition_version+1 WHERE fund_id=$1',[id]);
      return true;
    }
    const assets = fixed(round.cash_usdc,6);
    const settlement = phase === 'REFUNDING' ? { captainFeeUsdc: '0.000000',distributionPoolUsdc: assets } : roundSettlement(round.accepted_capital_usdc,assets);
    if (phase === 'REFUNDING' && !new Amount(assets).eq(round.accepted_capital_usdc)) throw new Error('Refund principal mismatch');
    if (new Amount(round.total_shares).lte(0)) throw new Error('Missing economic supply');
    const liabilities = (await client.query<{ residue: string }>(`SELECT ($2::numeric-COALESCE(sum(trunc($2::numeric*shares/$3::numeric,6)),0))::text AS residue FROM fund_shares WHERE fund_id=$1 AND shares>0`,[id,settlement.distributionPoolUsdc,round.total_shares])).rows[0]!.residue;
    await client.query(`UPDATE vault_rounds SET phase=$2,final_supply=$3,final_assets_usdc=$4,distribution_pool_usdc=$5,
      captain_fee_usdc=$6,finalized_at=$7,residue_liability_usdc=$8,blocked_reason=NULL,transition_version=transition_version+1 WHERE fund_id=$1`,
      [id,phase === 'REFUNDING' ? 'CANCELLED' : 'COMPLETED',fixed(round.total_shares,6),assets,settlement.distributionPoolUsdc,settlement.captainFeeUsdc,now,liabilities]);
    const finalPrice = fixed(new Amount(settlement.distributionPoolUsdc).div(round.total_shares),18);
    await appendFundEvent(client,id,'vault_finalized',{});
    await saveFundNav(client,{ fundId: id,navUsdc: settlement.distributionPoolUsdc,sharePriceUsdc: finalPrice,pricedAt: now });
    await client.query("UPDATE funds SET status='COMPLETED',final_nav_usdc=$2,final_share_price_usdc=$3 WHERE id=$1",[id,settlement.distributionPoolUsdc,finalPrice]);
    return true;
  });
}
export async function advanceDueVaultRounds(pool: DbPool): Promise<number> {
  const rows = (await pool.query<{ fund_id: string }>(`SELECT fund_id FROM vault_rounds WHERE
    (phase='FUNDRAISING' AND funding_closes_at<=clock_timestamp()) OR
    (phase='ACTIVE' AND trading_ends_at<=clock_timestamp()) OR phase IN ('REFUNDING','SETTLING')
    ORDER BY last_attempted_at NULLS FIRST,fund_id LIMIT 100`)).rows;
  let advanced = 0;
  const errors:unknown[]=[];
  for (const row of rows) {
    try { if (await advanceVaultRound(pool,row.fund_id)) advanced++; }
    catch (error) {
      // A malformed round must not starve healthy rounds. The failed money transaction rolled back.
      await pool.query("UPDATE vault_rounds SET last_attempted_at=clock_timestamp(),blocked_reason='reconciliation_required' WHERE fund_id=$1 AND finalized_at IS NULL",[row.fund_id]);
      errors.push(error);
    }
  }
  if (errors.length) throw new AggregateError(errors,'Vault rounds require reconciliation');
  return advanced;
}
