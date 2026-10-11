import { createHash,randomUUID } from 'node:crypto';
import type { DbPool } from '@socially/db';
import { envInteger } from '@socially/domain';
import { marketRedis } from '@socially/market-stream';
import { ApiFault } from './errors.js';
import { streamQuery } from './stream-db.js';
export interface ConnectionLease { renew():Promise<boolean>; release():Promise<void> }
const acquireScript=`
local t=redis.call('TIME'); local now=t[1]*1000+math.floor(t[2]/1000)
for i,key in ipairs(KEYS) do
 redis.call('ZREMRANGEBYSCORE',key,'-inf',now)
 if redis.call('ZCARD',key)>=tonumber(ARGV[i+2]) then return 0 end
end
for _,key in ipairs(KEYS) do redis.call('ZADD',key,now+ARGV[2],ARGV[1]);redis.call('PEXPIRE',key,ARGV[2]*2) end
return 1`;
const renewScript=`
local t=redis.call('TIME');local now=t[1]*1000+math.floor(t[2]/1000)
for _,key in ipairs(KEYS) do local score=redis.call('ZSCORE',key,ARGV[1]);if not score or tonumber(score)<=now then return 0 end end
for _,key in ipairs(KEYS) do redis.call('ZADD',key,now+ARGV[2],ARGV[1]);redis.call('PEXPIRE',key,ARGV[2]*2) end
return 1`;
const releaseScript=`for _,key in ipairs(KEYS) do redis.call('ZREM',key,ARGV[1]) end return 1`;
/** Production admission fails closed on Redis loss; development without Redis uses bounded local leases. */
export class ConnectionLeases {
 private redis?:ReturnType<typeof marketRedis>;
 private namespace?:string;
 private local=new Map<string,Map<string,number>>();
 readonly ttlMs=envInteger('PAPER_CONNECTION_LEASE_MS',60000,5000);
 readonly renewMs=Math.floor(this.ttlMs/3);
 constructor(private db:()=>DbPool,private scope:'sse'|'market-ws'|'vault-ws'){}
 async acquire(ip:string,user?:string,onlyUser=false):Promise<ConnectionLease>{
  const prefix=this.scope.toUpperCase().replaceAll('-','_');
  let limits=[envInteger(`PAPER_${prefix}_MAX_CONNECTIONS`,this.scope==='market-ws'?1000:200),envInteger(`PAPER_${prefix}_MAX_PER_IP`,10),...(user?[envInteger(`PAPER_${prefix}_MAX_PER_USER`,5)]:[])];
  const identity=(s:string)=>createHash('sha256').update(s).digest('hex');
  let suffix=['all',`ip:${identity(ip??'unknown')}`,...(user?[`user:${identity(user)}`]:[])];
  if(onlyUser){if(!user)throw new Error('User identity required');limits=limits.slice(-1);suffix=suffix.slice(-1);}
  const token=randomUUID();let released=false;
  if(!process.env.REDIS_URL){
   if(process.env.NODE_ENV==='production')throw new ApiFault(503,'stream_unavailable','Redis is required for streaming admission');
   const now=Date.now();
   for(let i=0;i<suffix.length;i++){
    const entries=this.local.get(suffix[i]!)??new Map<string,number>();
    for(const [key,expiry]of entries)if(expiry<=now)entries.delete(key);
    this.local.set(suffix[i]!,entries);
    if(entries.size>=limits[i]!)throw new ApiFault(429,'connection_limit','Stream connection limit reached');
   }
   for(const key of suffix)this.local.get(key)!.set(token,now+this.ttlMs);
   return {renew:async()=>{if(released)return false;const now=Date.now();if(suffix.some(key=>(this.local.get(key)?.get(token)??0)<=now))return false;for(const key of suffix)this.local.get(key)!.set(token,now+this.ttlMs);return true;},release:async()=>{released=true;for(const key of suffix){const values=this.local.get(key);values?.delete(token);if(!values?.size)this.local.delete(key);}}};
  }
  this.redis??=marketRedis(process.env.REDIS_URL);
  try{
   if(this.redis.status!=='ready')await new Promise<void>((resolve,reject)=>{
    const ready=()=>{clearTimeout(timer);resolve();};const timer=setTimeout(()=>{this.redis!.off('ready',ready);reject(new Error('Redis unavailable'));},1500);this.redis!.once('ready',ready);
   });
   this.namespace??=(await streamQuery<{instance_id:string}>(this.db(),'SELECT instance_id::text FROM market_feed_state WHERE singleton')).rows[0]!.instance_id;
   const keys=suffix.map(key=>`socially:{connections:${this.namespace}}:${this.scope}:${key}`);
   if(Number(await this.redis.eval(acquireScript,keys.length,...keys,token,this.ttlMs,...limits))!==1)throw new ApiFault(429,'connection_limit','Stream connection limit reached');
   return {renew:async()=>{if(released)return false;try{return Number(await this.redis!.eval(renewScript,keys.length,...keys,token,this.ttlMs))===1;}catch{return false;}},
    release:async()=>{released=true;await this.redis!.eval(releaseScript,keys.length,...keys,token).catch(()=>undefined);}};
  }catch(error){if(error instanceof ApiFault)throw error;throw new ApiFault(503,'stream_unavailable','Streaming admission is temporarily unavailable');}
 }
 close(){this.redis?.disconnect();this.local.clear();}
}
