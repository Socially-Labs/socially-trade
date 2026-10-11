import type { FastifyInstance } from 'fastify';
import { inTransaction,type DbPool } from '@socially/db';
import { requireActor } from './auth.js';
import { authorize } from './admin-logs.js';
import { ApiFault } from './errors.js';
/** Low-cardinality process metrics; shared job/accounting state stays in PostgreSQL. */
export function registerPaperTradingHealth(app:FastifyInstance,db:()=>DbPool){
 const latency=new Map<string,{count:number;totalMs:number;buckets:number[]}>();
 const bounds=[25,50,100,250,500,1000,2500,5000];
 app.addHook('onResponse',async(request,reply)=>{
  const route=request.routeOptions.url??'';
  if(!/trading-context|orders|\/history/.test(route))return;
  const key=`${request.method} ${route} ${Math.floor(reply.statusCode/100)}xx`;
  if(!latency.has(key)&&latency.size>=40)return;
  const metric=latency.get(key)??{count:0,totalMs:0,buckets:bounds.map(()=>0)};
  metric.count++;metric.totalMs+=reply.elapsedTime;
  bounds.forEach((bound,index)=>{if(reply.elapsedTime<=bound)metric.buckets[index]=(metric.buckets[index]??0)+1;});latency.set(key,metric);
 });
 const health=(captainId:string|null)=>inTransaction(db(),async client=>{
  await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await client.query("SET LOCAL statement_timeout='5s'");
  const orders=(await client.query(`WITH recent AS(SELECT o.* FROM orders o JOIN funds f ON f.id=o.fund_id
   WHERE ($1::uuid IS NULL OR f.captain_id=$1) AND o.submitted_at>now()-interval '24 hours' ORDER BY o.submitted_at DESC LIMIT 10000)
   SELECT status,progress_state,count(*)::int AS count,max(execution_attempts)::int AS max_attempts,
   extract(epoch FROM now()-(min(submitted_at) FILTER(WHERE status='PENDING')))*1000 AS oldest_pending_ms,
   percentile_cont(.95) WITHIN GROUP(ORDER BY extract(epoch FROM processed_at-submitted_at)*1000) FILTER(WHERE processed_at IS NOT NULL) AS completion_p95_ms
   FROM recent GROUP BY status,progress_state`,[captainId])).rows;
  const valuation=(await client.query(`SELECT count(*)::int AS queued,count(*) FILTER(WHERE j.lease_until>now())::int AS leased,
   greatest(0,extract(epoch FROM now()-min(j.next_run_at))*1000) AS oldest_due_ms
   FROM fund_valuation_jobs j JOIN funds f ON f.id=j.fund_id WHERE ($1::uuid IS NULL OR f.captain_id=$1)`,[captainId])).rows[0];
  const reconciliation=(await client.query(`SELECT COALESCE(s.status,'UNCHECKED') AS status,count(*)::int AS funds,min(s.checked_at) AS oldest_check_at
   FROM funds f LEFT JOIN paper_reconciliation_state s ON s.fund_id=f.id WHERE f.mode='PAPER' AND ($1::uuid IS NULL OR f.captain_id=$1) GROUP BY s.status`,[captainId])).rows;
  const settlement=(await client.query(`SELECT r.phase,r.blocked_reason,count(*)::int AS count,
    min(r.last_attempted_at) AS oldest_attempt_at
    FROM vault_rounds r JOIN funds f ON f.id=r.fund_id
    WHERE r.phase IN ('SETTLING','REFUNDING') AND ($1::uuid IS NULL OR f.captain_id=$1)
    GROUP BY r.phase,r.blocked_reason`,[captainId])).rows;
  const capacity=captainId?undefined:(await client.query(`WITH demand AS (
    SELECT p.instrument_id FROM positions p JOIN funds f ON f.id=p.fund_id WHERE p.quantity>0 AND f.status<>'COMPLETED'
    UNION SELECT instrument_id FROM orders WHERE status='PENDING'
  ) SELECT count(*)::int AS tracked_assets,100 AS asset_limit FROM demand`)).rows[0];
  const history=captainId?undefined:(await client.query(`SELECT status,count(*)::int AS count,min(next_run_at) AS oldest_due_at FROM market_history_jobs GROUP BY status`)).rows;
  return {mode:'PAPER',asOf:new Date().toISOString(),orders,valuation,reconciliation,settlement,...(capacity?{capacity}:{}),...(history?{history}:{}),orderSampleLimit:10000,orderWindowHours:24};
 });
 app.get('/v1/me/captain/paper-health',async(request,reply)=>{
  const actor=await requireActor(request,db());reply.header('cache-control','no-store');
  if(actor.role!=='captain')throw new ApiFault(403,'captain_required','Captain access required');
  return health(actor.id);
 });
 app.get('/admin/paper-trading/health',async(request,reply)=>{
  authorize(request);reply.header('cache-control','no-store');
  return {...await health(null),requestMetrics:{scope:'THIS_API_PROCESS',boundsMs:bounds,series:Object.fromEntries(latency)}};
 });
}
