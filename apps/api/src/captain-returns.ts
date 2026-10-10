import { Amount,fixed } from '@socially/domain';
import type { DbClient } from '@socially/db';
import type { TradingReturns } from '@socially/contracts';
export async function captainTradingReturns(client:DbClient,captainId:string,range:TradingReturns['range']):Promise<TradingReturns>{
  const now=new Date(),source=range==='7D'?3600:86400;
  const inception=(await client.query('SELECT inception_at FROM captain_return_state WHERE captain_id=$1',[captainId])).rows[0]?.inception_at as Date|undefined;
  const start=range==='ALL'?inception??now:new Date(now.getTime()-parseInt(range)*86400000);
  const step=range==='ALL'?Math.max(86400,Math.ceil((now.getTime()-start.getTime())/86400000/400)*86400):source;
  const baseline=(await client.query('SELECT index_value,recorded_at,has_gap FROM captain_return_rollups WHERE captain_id=$1 AND interval_seconds=$2 AND recorded_at<$3 ORDER BY recorded_at DESC LIMIT 1',[captainId,source,start])).rows[0];
  const rows=(await client.query(`SELECT DISTINCT ON(floor(extract(epoch FROM bucket_at)/$4)) recorded_at,index_value::text,bool_or(has_gap) OVER(PARTITION BY floor(extract(epoch FROM bucket_at)/$4)) AS has_gap FROM captain_return_rollups
    WHERE captain_id=$1 AND interval_seconds=$2 AND recorded_at>=$3
    AND recorded_at<=clock_timestamp() ORDER BY floor(extract(epoch FROM bucket_at)/$4),recorded_at DESC LIMIT 401`,[captainId,source,start,step])).rows;
  const points=rows.map(r=>({at:(r.recorded_at as Date).toISOString(),indexValue:r.index_value===null?null:fixed(r.index_value as string,18),hasGap:r.has_gap as boolean}));
  const base=range==='ALL'||inception&&inception>=start?'100':baseline?.index_value??null;
  const last=points.at(-1),valid=base!==null&&new Amount(base).gt(0)&&last?.indexValue!==null&&last?.indexValue!==undefined&&points.every(p=>p.indexValue!==null&&!p.hasGap)&&!baseline?.has_gap;
  return {mode:'PAPER',range,method:'CHAINED_ECONOMIC_UNIT_PRICE',intervalSeconds:step,baselineAt:(range==='ALL'||inception&&inception>=start?inception:baseline?.recorded_at)?.toISOString()??null,
    asOf:last?.at??null,coverage:points.length?'PARTIAL':'UNAVAILABLE',netReturnPercent:valid?fixed(new Amount(last!.indexValue!).div(base!).minus(1).mul(100),6):null,points,
    methodology:'Chained economic share-price changes across sequential paper rounds; deposits and cancellations excluded, trading costs and final round fees included. AUM and Captain fee income are separate. Recorded buckets only; gaps and zero baselines cannot produce a return.'};
}
