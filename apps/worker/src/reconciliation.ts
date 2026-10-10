import { inTransaction, type DbPool } from '@socially/db';

/** Observe one committed snapshot. Never repair ledger, balances, orders or shares. */
export async function reconcileFund(pool:DbPool,id:string) {
  return inTransaction(pool,async client=>{
    await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await client.query("SET LOCAL statement_timeout='10s'");
    // Serialize auditors only, without blocking financial transactions.
    if(!(await client.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,7731)) AS locked',[id])).rows[0].locked)return null;
    const fund=(await client.query('SELECT cash_usdc,total_shares,protocol_shares,event_sequence FROM funds WHERE id=$1',[id])).rows[0];
    if(!fund)return null;
    const findings=(await client.query(`WITH balances AS(
      SELECT a.asset_id,COALESCE(sum(e.amount),0) AS amount FROM ledger_accounts a LEFT JOIN ledger_entries e ON e.account_id=a.id
      WHERE a.owner_type='FUND' AND a.owner_id=$1 GROUP BY a.asset_id
    ), assets AS(SELECT instrument_id AS asset,quantity FROM positions WHERE fund_id=$1::uuid
      UNION SELECT asset_id,0 FROM balances WHERE asset_id<>'USDC' AND asset_id NOT LIKE 'SHARE:%')
    SELECT 'cash_ledger' AS check_name WHERE $2::numeric<>COALESCE((SELECT amount FROM balances WHERE asset_id='USDC'),0)
    UNION ALL SELECT 'share_supply' WHERE $3::numeric<>$4::numeric+COALESCE((SELECT sum(shares) FROM fund_shares WHERE fund_id=$1::uuid),0)
    UNION ALL SELECT 'position_ledger:'||a.asset FROM (SELECT asset,max(quantity) AS quantity FROM assets GROUP BY asset) a
      WHERE a.quantity<>COALESCE((SELECT amount FROM balances WHERE asset_id=a.asset),0)
    UNION ALL SELECT 'unbalanced_event' WHERE EXISTS(SELECT e.event_id,a.asset_id FROM ledger_entries e JOIN ledger_accounts a ON a.id=e.account_id
      WHERE e.event_id IN(SELECT id FROM fund_events WHERE fund_id=$1::uuid) GROUP BY e.event_id,a.asset_id HAVING sum(e.amount)<>0)
    UNION ALL SELECT 'fill_status' WHERE EXISTS(SELECT 1 FROM orders o LEFT JOIN fills f ON f.order_id=o.id
      WHERE o.fund_id=$1::uuid AND ((o.status='FILLED')<>(f.id IS NOT NULL)))
    UNION ALL SELECT 'fill_event' WHERE EXISTS(SELECT 1 FROM fills fl JOIN orders o ON o.id=fl.order_id
      WHERE o.fund_id=$1::uuid AND NOT EXISTS(SELECT 1 FROM fund_events e WHERE e.fund_id=o.fund_id AND e.type='order_filled'
        AND e.payload->>'orderId'=o.id::text AND (e.payload->>'quantity')::numeric=fl.quantity
        AND (e.payload->>'feeUsdc')::numeric=fl.fee_usdc))`,[id,fund.cash_usdc,fund.total_shares,fund.protocol_shares])).rows.map(r=>r.check_name as string);
    const status=findings.length?'MISMATCH':'HEALTHY';
    await client.query(`INSERT INTO paper_reconciliation_state(fund_id,checked_revision,status,findings,mismatch_since)
      VALUES($1,$2,$3,$4,CASE WHEN $3='MISMATCH' THEN now() END) ON CONFLICT(fund_id) DO UPDATE SET
      checked_revision=EXCLUDED.checked_revision,status=EXCLUDED.status,findings=EXCLUDED.findings,checked_at=now(),
      mismatch_since=CASE WHEN EXCLUDED.status='MISMATCH' THEN COALESCE(paper_reconciliation_state.mismatch_since,now()) END`,[id,fund.event_sequence,status,JSON.stringify(findings)]);
    if(findings.length){
      const opened=await client.query(`INSERT INTO paper_reconciliation_incidents(fund_id,checked_revision,findings) VALUES($1,$2,$3)
        ON CONFLICT(fund_id) WHERE resolved_at IS NULL DO NOTHING RETURNING id`,[id,fund.event_sequence,JSON.stringify(findings)]);
      if(opened.rowCount)console.error('Paper accounting discrepancy',{fundId:id,revision:String(fund.event_sequence),checks:findings});
    }else await client.query('UPDATE paper_reconciliation_incidents SET resolved_at=now() WHERE fund_id=$1 AND resolved_at IS NULL',[id]);
    return {fundId:id,revision:String(fund.event_sequence),status,findings};
  });
}

export async function reconcilePaperFunds(pool:DbPool):Promise<number> {
  const ids=await inTransaction(pool,async client=>{
    const state=(await client.query("SELECT * FROM paper_job_sweeps WHERE name='reconciliation' AND next_run_at<=now() FOR UPDATE SKIP LOCKED")).rows[0];
    if(!state)return [];
    const upper=state.upper_id??(await client.query("SELECT id FROM funds WHERE mode='PAPER' ORDER BY id DESC LIMIT 1")).rows[0]?.id;
    const rows=upper?(await client.query("SELECT id FROM funds WHERE mode='PAPER' AND ($1::uuid IS NULL OR id>$1) AND id<=$2 ORDER BY id LIMIT 20",[state.cursor_id,upper])).rows:[];
    const complete=rows.length<20;
    await client.query("UPDATE paper_job_sweeps SET cursor_id=$1,upper_id=$2,next_run_at=CASE WHEN $3 THEN now()+interval '5 minutes' ELSE now() END WHERE name='reconciliation'",[complete?null:rows.at(-1)!.id,complete?null:upper,complete]);
    return rows.map(r=>r.id as string);
  });
  let checked=0;const failures:unknown[]=[];
  for(const id of ids){try{if(await reconcileFund(pool,id))checked++;}catch(error){failures.push(error);}}
  if(failures.length)throw new AggregateError(failures,'Paper reconciliation checks failed; remaining funds were still checked');
  return checked;
}
