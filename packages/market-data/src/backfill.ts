import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';
import { Amount, fixed } from '@socially/domain';
import type { DiscoveryStorage } from './discovery.js';
export type Candle = { at:Date; open:string; high:string; low:string; close:string; volume:string|null; final:boolean };
export interface HistoryProvider { source:string; fetch(mint:string,from:Date,to:Date,resolution:number):Promise<Candle[]> }
const intervals:Record<number,string>={60:'1m',300:'5m',900:'15m',3600:'1H'};
/** Mint-level USD series. Historical values never enter executable observations. */
export class BirdeyeHistoryProvider implements HistoryProvider {
  source='BIRDEYE_TOKEN_USD';
  constructor(private key:string){}
  async fetch(mint:string,from:Date,to:Date,resolution:number):Promise<Candle[]> {
    if(!intervals[resolution] || to.getTime()-from.getTime()>resolution*720000)throw new Error('invalid_history_range');
    const url=new URL('https://public-api.birdeye.so/defi/v3/ohlcv');
    url.search=new URLSearchParams({address:mint,type:intervals[resolution]!,currency:'usd',time_from:String(Math.floor(from.getTime()/1000)),time_to:String(Math.floor(to.getTime()/1000)-1),mode:'range',padding:'false'}).toString();
    const response=await fetch(url,{headers:{'X-API-KEY':this.key,'x-chain':'solana'},signal:AbortSignal.timeout(8000)});
    if(!response.ok)throw new Error(`history_provider_${response.status}`);
    const raw=await response.json() as {success?:boolean;data?:{items?:Record<string,unknown>[]}};
    if(raw.success!==true || !Array.isArray(raw.data?.items) || raw.data.items.length>721)throw new Error('history_provider_invalid');
    const seen=new Set<number>();
    return raw.data.items.filter(row=>Number(row.unix_time)*1000!==to.getTime()).map(row=>{
      const timestamp=Number(row.unix_time)*1000;
      const values=[row.o,row.h,row.l,row.c].map(value=>{
        if(typeof value!=='number'||!Number.isFinite(value)||value<=0)throw new Error('history_provider_invalid');
        return fixed(new Amount(String(value)),18);
      });
      if(!Number.isSafeInteger(timestamp)||timestamp<from.getTime()||timestamp>=to.getTime()||timestamp%(resolution*1000)!==0||seen.has(timestamp))throw new Error('history_provider_invalid');
      seen.add(timestamp);
      const [open,high,low,close]=values as [string,string,string,string];
      if(new Amount(high).lt(Amount.max(open,close,low))||new Amount(low).gt(Amount.min(open,close,high)))throw new Error('history_provider_invalid');
      const volume=typeof row.v_usd==='number'&&Number.isFinite(row.v_usd)&&row.v_usd>=0?fixed(new Amount(String(row.v_usd)),18):null;
      return {at:new Date(timestamp),open,high,low,close,volume,final:timestamp+resolution*1000<=Date.now()};
    }).sort((a,b)=>a.at.getTime()-b.at.getTime());
  }
}
export const historyProviderEnabled=()=>process.env.MARKET_HISTORY_PROVIDER_ENABLED==='true' && !!process.env.BIRDEYE_API_KEY;
/** Reserve conservatively at 100 CU/call (up to 720 candles), including failed calls.
 * One shared budget for this backend; reserve other Birdeye usage separately. */
export async function historyPermit(redis:Redis, now=new Date()):Promise<boolean> {
  const configured=Number(process.env.BIRDEYE_HISTORY_MONTHLY_CU_BUDGET??25000);
  const budget=Number.isSafeInteger(configured)&&configured>=0?Math.min(configured,30000):25000;
  const scope=createHash('sha256').update(process.env.BIRDEYE_API_KEY??'').digest('hex').slice(0,16);
  const prefix=`socially:history:budget:${scope}`;
  const month=now.toISOString().slice(0,7);
  const expires=Math.ceil((Date.UTC(now.getUTCFullYear(),now.getUTCMonth()+1,1)-now.getTime())/1000)+86400;
  return Number(await redis.eval(`
    if redis.call('EXISTS',KEYS[1])==1 then return 0 end
    local used=tonumber(redis.call('GET',KEYS[2]) or '0')
    if used+100>tonumber(ARGV[1]) then return 0 end
    redis.call('SET',KEYS[1],'1','PX',1100)
    redis.call('INCRBY',KEYS[2],100);redis.call('EXPIRE',KEYS[2],ARGV[2]);return 1
  `,2,`${prefix}:pace`,`${prefix}:${month}`,budget,expires))===1;
}
export async function enqueueHistory(pool:DiscoveryStorage,instrumentId:string,from:Date,to:Date,resolution:number) {
  const key=createHash('sha256').update(JSON.stringify([instrumentId,'BIRDEYE_TOKEN_USD',from.toISOString(),to.toISOString(),resolution])).digest('hex');
  await pool.query('SELECT enqueue_market_history($1,$2,$3,$4,$5)',[key,instrumentId,from,to,resolution]);
  return key;
}
export async function processHistoryJob(pool:DiscoveryStorage,provider:HistoryProvider,permit:()=>Promise<boolean>):Promise<boolean> {
  const job=(await pool.query(`WITH due AS (
    SELECT work_key FROM market_history_jobs WHERE source=$1 AND next_run_at<=now() AND attempts<5
      AND (status='PENDING' OR status='RUNNING' AND lease_until<now()) ORDER BY next_run_at LIMIT 1 FOR UPDATE SKIP LOCKED
    ) UPDATE market_history_jobs j SET status='RUNNING',attempts=attempts+1,lease_until=now()+interval '30 seconds'
      FROM due WHERE j.work_key=due.work_key RETURNING j.*`,[provider.source])).rows[0];
  if(!job)return false;
  const key=String(job.work_key),attempt=Number(job.attempts);
  try {
    if(!await permit()){
      await pool.query("UPDATE market_history_jobs SET status='PENDING',attempts=attempts-1,lease_until=NULL,next_run_at=now()+interval '10 seconds',last_error='history_quota_wait' WHERE work_key=$1 AND attempts=$2 AND lease_until>now()",[key,attempt]);
      return false;
    }
    const instrument=(await pool.query('SELECT mint_address FROM instruments WHERE id=$1',[job.instrument_id])).rows[0]!;
    const candles=await provider.fetch(String(instrument.mint_address),job.from_at as Date,job.to_at as Date,Number(job.resolution_seconds));
    // Fence every write against the claimed attempt; an expired worker cannot complete a newer lease.
    for(const c of candles)await pool.query(`INSERT INTO market_chart_candles(instrument_id,source,series_id,denomination,resolution_seconds,bucket_at,open,high,low,close,volume,final)
      SELECT $1,$2,$3,'USD',$4,$5,$6,$7,$8,$9,$10,$11 WHERE EXISTS(SELECT 1 FROM market_history_jobs WHERE work_key=$12 AND attempts=$13 AND status='RUNNING' AND lease_until>now())
      ON CONFLICT(instrument_id,source,series_id,resolution_seconds,bucket_at) DO UPDATE SET open=EXCLUDED.open,high=EXCLUDED.high,low=EXCLUDED.low,close=EXCLUDED.close,volume=EXCLUDED.volume,final=EXCLUDED.final,revised_at=now()`,
      [job.instrument_id,provider.source,`solana:${instrument.mint_address}:usd`,job.resolution_seconds,c.at,c.open,c.high,c.low,c.close,c.volume,c.final,key,attempt]);
    await pool.query(`UPDATE market_history_jobs SET status=$3,covered_from=$4,covered_to=$5,lease_until=NULL,
      next_run_at=now()+interval '5 minutes',empty_coverage=$7,last_error=$6 WHERE work_key=$1 AND attempts=$2 AND lease_until>now()`,
      [key,attempt,candles.length?'COMPLETE':'UNAVAILABLE',candles[0]?.at??null,candles.at(-1)?.at??null,candles.length?null:'provider_no_coverage',!candles.length]);
  } catch(error) {
    await pool.query(`UPDATE market_history_jobs SET status=CASE WHEN attempts>=5 THEN 'UNAVAILABLE' ELSE 'PENDING' END,
      next_run_at=now()+CASE WHEN $3 IN ('history_provider_401','history_provider_403') THEN interval '24 hours' ELSE least(300,power(2,attempts)*5)*interval '1 second' END,lease_until=NULL,last_error=$3 WHERE work_key=$1 AND attempts=$2 AND lease_until>now()`,
      [key,attempt,error instanceof Error?error.message:'history_unavailable']);
  }
  return true;
}
