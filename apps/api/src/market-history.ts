import type { DbPool } from '@socially/db';
import { marketRedis } from '@socially/market-stream';
import { registeredInstruments } from '@socially/market-data/registry';
import { readHistory, historyRanges, type HistoryRange } from '@socially/market-data/history';
import { enqueueHistory, historyProviderEnabled } from '@socially/market-data/backfill';
import { Amount, fixed } from '@socially/domain';
import { ApiFault } from './errors.js';
const defaults:Record<HistoryRange,number>={'5M':60,'1H':60,'6H':60,'24H':300,'7D':900,'30D':3600};
export class MarketHistory {
  private redis?:ReturnType<typeof marketRedis>;
  private pending=new Map<string,Promise<unknown>>();
  private memory=new Map<string,{value:unknown;freshUntil:number;staleUntil:number}>();
  private closing=false;
  readonly metrics={freshHits:0,staleHits:0,builds:0,busy:0};
  constructor(private pool:DbPool){}
  async close(){this.closing=true;await Promise.allSettled(this.pending.values());this.redis?.disconnect();}
  async read(mint:string,range:HistoryRange,resolution?:number, backfill=false):Promise<unknown> {
    const seconds=historyRanges[range][0],step=resolution??defaults[range];
    if(![60,300,900,3600].includes(step)||seconds/step>720)throw new ApiFault(400,'invalid_history_resolution','Choose a resolution with at most 720 points');
    if(backfill&&(range!=='24H'||step!==300))throw new ApiFault(400,'invalid_history_backfill','Historical backfill supports 24 hours at five-minute resolution');
    const key=`socially:history:v3:${mint}:${range}:${step}:${backfill?'backfill':'cached'}`;
    let cached=this.memory.get(key);
    if(!cached&&process.env.REDIS_URL){
      this.redis??=marketRedis(process.env.REDIS_URL);
      try{if(this.redis.status==='ready'){const raw=await this.redis.get(key);if(raw)cached=JSON.parse(raw);}}catch{/* Bounded stored-data fallback below. */}
    }
    if(cached&&cached.staleUntil>Date.now()){
      if(cached.freshUntil>Date.now()){this.metrics.freshHits++;return cached.value;}
      this.metrics.staleHits++;
      if(!this.closing&&this.pending.size<16&&!this.pending.has(key))void this.refresh(key,mint,range,step,backfill).catch(()=>undefined);
      return {...cached.value as object,cacheStatus:'STALE',nextRefreshAt:new Date(Date.now()+5000).toISOString()};
    }
    const prior=this.pending.get(key);if(prior)return prior;
    if(this.closing||this.pending.size>=16){this.metrics.busy++;throw new ApiFault(503,'history_busy','History is updating; retry shortly');}
    return this.refresh(key,mint,range,step,backfill);
  }
  private refresh(key:string,mint:string,range:HistoryRange,step:number,backfill:boolean){
    const promise=this.shared(key,mint,range,step,backfill).finally(()=>this.pending.delete(key));this.pending.set(key,promise);return promise;
  }
  private async shared(key:string,mint:string,range:HistoryRange,step:number,backfill:boolean) {
    let locked=false;const owner=crypto.randomUUID();
    try{
      if(this.redis?.status==='ready'){
        let reachable=false;
        try{locked=!!await this.redis.set(`${key}:lock`,owner,'PX',10000,'NX');reachable=true;}catch{/* Redis outage: bounded stored-data build, without provider admission. */}
        if(reachable&&!locked){
          for(let i=0;i<20;i++){await new Promise(r=>setTimeout(r,25));const raw=await this.redis.get(key);if(raw){const cached=JSON.parse(raw);if(cached.staleUntil>Date.now())return cached.value;}}
          throw new ApiFault(503,'history_busy','History is updating; retry shortly');
        }
      }
      this.metrics.builds++;
      const value=await this.build(mint,range,step,backfill&&(!!locked||!process.env.REDIS_URL));
      const entry={value,freshUntil:Date.now()+5000,staleUntil:Date.now()+300000};
      if(this.memory.size>=256)this.memory.delete(this.memory.keys().next().value!);
      this.memory.set(key,entry);
      if(this.redis?.status==='ready')await this.redis.set(key,JSON.stringify(entry),'EX',300).catch(()=>undefined);
      return value;
    }finally{if(locked)await this.redis?.eval("if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1])end return 0",1,`${key}:lock`,owner).catch(()=>undefined);}
  }
  private async build(mint:string,range:HistoryRange,step:number,enqueue=true) {
    const token=(await registeredInstruments(this.pool,undefined,[mint]))[0];
    if(!token)throw new ApiFault(422,'history_unsupported','Register this market to collect history');
    const now=new Date(),duration=historyRanges[range][0]*1000,end=new Date(Math.floor(now.getTime()/(step*1000))*step*1000),start=new Date(end.getTime()-duration);
    const rows=(await this.pool.query<{bucket_at:Date;close:string;final:boolean}>(`SELECT bucket_at,close::text,final FROM market_chart_candles
      WHERE instrument_id=$1 AND source='BIRDEYE_TOKEN_USD' AND series_id=$2 AND resolution_seconds=$3 AND bucket_at>=$4 AND bucket_at<$5
      ORDER BY bucket_at LIMIT 720`,[token.id,`solana:${mint}:usd`,step,start,end])).rows;
    let backfillStatus='DISABLED';
    if(process.env.MARKET_HISTORY_PROVIDER_ENABLED==='true')backfillStatus=historyProviderEnabled()?(enqueue?'PENDING':'CACHED_ONLY'):'CREDENTIAL_MISSING';
    if(historyProviderEnabled()&&enqueue){
      const recent=(await this.pool.query<{status:string}>(`SELECT status FROM market_history_jobs
        WHERE instrument_id=$1 AND source='BIRDEYE_TOKEN_USD' AND resolution_seconds=$2 AND (
          status IN ('PENDING','RUNNING') OR status='COMPLETE' AND next_run_at>now()-interval '10 minutes'
          OR status='UNAVAILABLE' AND next_run_at>now()-interval '6 hours')
        ORDER BY next_run_at DESC LIMIT 1`,[token.id,step])).rows[0];
      if(recent) { backfillStatus=recent.status==='COMPLETE'?'CACHED':recent.status; }
      else {
      const existing=new Set(rows.map(r=>r.bucket_at.getTime()));
      let missing:number|undefined,until=end.getTime();
      for(let at=start.getTime();at<end.getTime();at+=step*1000){if(!existing.has(at)){missing=at;break;}}
      if(missing!==undefined){for(let at=missing+step*1000;at<end.getTime();at+=step*1000)if(existing.has(at)){until=at;break;}
        const key=await enqueueHistory(this.pool,token.id,new Date(missing),new Date(until),step);
        const job=(await this.pool.query<{status:string;last_error:string|null}>('SELECT status,last_error FROM market_history_jobs WHERE work_key=$1',[key])).rows[0];
        backfillStatus=job?.status??'QUEUE_FULL';
      }else backfillStatus='COMPLETE';
      }
    }
    const nextRefreshAt=new Date(now.getTime()+30000).toISOString();
    if(!rows.length){
      const samples=await readHistory(this.pool,mint,range,now);
      return {...samples,mode:'PAPER',seriesId:`jupiter:${mint}:recorded`,coverageStart:samples.coverage.start,coverageEnd:samples.coverage.end,
        hasGaps:samples.coverage.hasGaps,status:samples.coverage.status,backfillStatus,nextRefreshAt};
    }
    const points=rows.map(r=>({at:r.bucket_at.toISOString(),price:r.close})),first=rows[0]!,last=rows.at(-1)!;
    const hasGaps=rows.some((r,i)=>i>0&&r.bucket_at.getTime()-rows[i-1]!.bucket_at.getTime()>step*1000);
    const complete=rows.length===duration/(step*1000)&&rows.every(r=>r.final)&&!hasGaps;
    const coverage={start:first.bucket_at.toISOString(),end:last.bucket_at.toISOString(),hasGaps,status:complete?'COMPLETE':'PARTIAL'};
    return {mode:'PAPER',mint,instrumentId:token.id,range,denomination:'USD',source:'BIRDEYE_TOKEN_USD',seriesId:`solana:${mint}:usd`,intervalSeconds:step,
      from:start.toISOString(),to:end.toISOString(),coverage,coverageStart:coverage.start,coverageEnd:coverage.end,hasGaps,status:coverage.status,backfillStatus,nextRefreshAt,
      changePercent:complete?fixed(new Amount(last.close).div(first.close).minus(1).mul(100),18):null,points};
  }
}
