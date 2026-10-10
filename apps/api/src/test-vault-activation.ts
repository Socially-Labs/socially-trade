import { appendFundEvent, inTransaction, type DbClient, type DbPool } from '@socially/db';
import { Amount } from '@socially/domain';
import type { Actor } from './auth.js';
import { ApiFault } from './errors.js';

export const testVaultActivationEnabled = () => process.env.NODE_ENV === 'development' && process.env.PAPER_TEST_SKIP_FUNDRAISING === 'true';

/** End fundraising before trading, preserving the worker's lifecycle invariants. */
export async function activateTestVault(client: DbClient, actor: Actor, id: string) {
  if (!testVaultActivationEnabled()) throw new ApiFault(404, 'test_activation_disabled', 'Test activation is unavailable');
  const fund = (await client.query(`SELECT f.captain_id,f.mode,f.status,f.cash_usdc::text,f.total_shares::text,r.phase,r.risk_state,r.trading_ends_at
    FROM funds f JOIN vault_rounds r ON r.fund_id=f.id WHERE f.id=$1 FOR NO KEY UPDATE OF f,r`, [id])).rows[0];
  if (!fund) throw new ApiFault(404, 'fund_not_found', 'Vault not found');
  if (fund.captain_id !== actor.id) throw new ApiFault(403, 'captain_required', 'Only this vault’s Captain can start test trading');
  if (fund.mode !== 'PAPER' || !['FUNDRAISING','ACTIVE'].includes(fund.phase) || fund.trading_ends_at.getTime() <= Date.now()) {
    throw new ApiFault(409, 'fund_not_tradable', 'Only an open paper vault can start test trading');
  }
  if (fund.phase === 'ACTIVE') return { mode: 'PAPER', vaultId: id, phase: 'ACTIVE', testOnly: true };
  if (fund.risk_state !== 'NORMAL') throw new ApiFault(409, 'buys_frozen', 'This vault is paused');
  if (new Amount(fund.cash_usdc).lte(0) || new Amount(fund.total_shares).lte(0)) throw new ApiFault(409, 'seed_required', 'Fund the captain seed before test trading');
  await client.query("UPDATE vault_rounds SET phase='ACTIVE',actual_activated_at=clock_timestamp(),transition_version=transition_version+1 WHERE fund_id=$1", [id]);
  await client.query("UPDATE funds SET status='ACTIVE' WHERE id=$1", [id]);
  await appendFundEvent(client,id,'vault_active',{testOnly:true,reason:'development_skip_fundraising'});
  return { mode: 'PAPER', vaultId: id, phase: 'ACTIVE', testOnly: true };
}

export function startTestVaultTrading(pool: DbPool, actor: Actor, id: string) {
  return inTransaction(pool, client => activateTestVault(client, actor, id));
}
