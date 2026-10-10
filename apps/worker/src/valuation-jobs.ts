import { randomUUID } from 'node:crypto';
import { inTransaction, type DbPool } from '@socially/db';
import { markFund } from './orders.js';

/** A persisted bounded cursor catches lost triggers, newly exposed funds and aged marks.
 * Completing a scan starts its cooldown; UUID insertions behind the cursor wait one scan.
 */
export async function valuationSweep(pool:DbPool):Promise<number> {
  return inTransaction(pool,async client=>{
    const state=(await client.query("SELECT * FROM paper_job_sweeps WHERE name='valuation' AND next_run_at<=now() FOR UPDATE SKIP LOCKED")).rows[0];
    if(!state)return 0;
    const upper=state.upper_id??(await client.query("SELECT id FROM funds ORDER BY id DESC LIMIT 1")).rows[0]?.id;
    const rows=upper?(await client.query(`SELECT f.id FROM funds f WHERE ($1::uuid IS NULL OR f.id>$1) AND f.id<=$2
      AND f.status IN ('ACTIVE','FROZEN') AND EXISTS(SELECT 1 FROM positions p WHERE p.fund_id=f.id AND p.quantity>0)
      ORDER BY f.id LIMIT 100`,[state.cursor_id,upper])).rows:[];
    if(rows.length)await client.query(`INSERT INTO fund_valuation_jobs(fund_id,reason)
      SELECT unnest($1::uuid[]),'safety_sweep' ON CONFLICT(fund_id) DO UPDATE SET generation=fund_valuation_jobs.generation+1,
      next_run_at=least(fund_valuation_jobs.next_run_at,now()),updated_at=now()`,[rows.map(r=>r.id)]);
    const complete=rows.length<100;
    await client.query("UPDATE paper_job_sweeps SET cursor_id=$1,upper_id=$2,next_run_at=CASE WHEN $3 THEN now()+interval '30 seconds' ELSE now() END WHERE name='valuation'",[complete?null:rows.at(-1)!.id,complete?null:upper,complete]);
    return rows.length;
  });
}

export async function processValuationJobs(pool:DbPool,limit=100):Promise<number> {
  await valuationSweep(pool);
  let marked=0;const deadline=Date.now()+1500;
  // Four consumers keep transactions bounded by the existing 10-connection pool.
  let remaining=Math.min(200,Math.max(0,limit));
  await Promise.all(Array.from({length:4},async()=>{
    while(remaining-->0&&Date.now()<deadline){
      const token=randomUUID();
      const job=(await pool.query(`WITH due AS(SELECT fund_id FROM fund_valuation_jobs
        WHERE next_run_at<=now() AND (lease_until IS NULL OR lease_until<=now()) ORDER BY next_run_at,fund_id
        LIMIT 1 FOR UPDATE SKIP LOCKED)
        UPDATE fund_valuation_jobs j SET lease_token=$1,lease_until=now()+interval '30 seconds',attempts=attempts+1
        FROM due WHERE j.fund_id=due.fund_id RETURNING j.fund_id,j.generation`,[token])).rows[0];
      if(!job)break;
      try{
        if(await markFund(pool,job.fund_id,true))marked++;
        // A newer generation during the fund transaction remains due; no lost wakeup.
        await pool.query('DELETE FROM fund_valuation_jobs WHERE fund_id=$1 AND lease_token=$2 AND generation=$3',[job.fund_id,token,job.generation]);
        await pool.query('UPDATE fund_valuation_jobs SET lease_token=NULL,lease_until=NULL,attempts=0 WHERE fund_id=$1 AND lease_token=$2',[job.fund_id,token]);
      }catch(error){
        await pool.query("UPDATE fund_valuation_jobs SET lease_token=NULL,lease_until=NULL,next_run_at=now()+least(60,power(2,least(attempts,5)))*interval '1 second' WHERE fund_id=$1 AND lease_token=$2",[job.fund_id,token]);
        console.warn('Valuation work deferred',{fundId:job.fund_id,reason:error instanceof Error?error.message:'storage_failure'});
      }
    }
  }));
  return marked;
}
