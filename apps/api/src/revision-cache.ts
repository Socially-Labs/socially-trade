import { createHash,randomUUID } from 'node:crypto';
import { marketRedis } from '@socially/market-stream';
import { ApiFault } from './errors.js';
type Entry<T>={value:T;validUntil:number};
/** Authorization/revision probes run before this cache. No credentials in keys. */
export class RevisionCache {
  private redis?:ReturnType<typeof marketRedis>;
  private values=new Map<string,Entry<unknown>>();
  private pending=new Map<string,Promise<unknown>>();
  private fallback=0;
  readonly metrics={memoryHits:0,redisHits:0,builds:0,coalesced:0,busy:0,redisFailures:0};
  close(){this.redis?.disconnect();this.values.clear();}
  async read<T>(identity:unknown,work:()=>Promise<Entry<T>>):Promise<T>{
    const key='socially:private:v2:'+createHash('sha256').update(JSON.stringify(identity)).digest('hex');
    const cached=this.values.get(key) as Entry<T>|undefined;
    if(cached&&cached.validUntil>Date.now()){this.metrics.memoryHits++;return cached.value;}
    const prior=this.pending.get(key);if(prior){this.metrics.coalesced++;return prior as Promise<T>;}
    if(this.pending.size>=512){this.metrics.busy++;throw new ApiFault(503,'private_read_busy','Your vault is updating; retry shortly');}
    const promise=this.shared(key,work).finally(()=>this.pending.delete(key));this.pending.set(key,promise);return promise;
  }
  private remember<T>(key:string,entry:Entry<T>){
    if(this.values.size>=256)this.values.delete(this.values.keys().next().value!);
    this.values.set(key,entry);return entry.value;
  }
  private async shared<T>(key:string,work:()=>Promise<Entry<T>>):Promise<T>{
    const owner=randomUUID();let locked=false,available=false;
    if(process.env.REDIS_URL){
      this.redis??=marketRedis(process.env.REDIS_URL);
      try{
        if(this.redis.status==='ready'){
          available=true;
          const cached=await this.redis.get(key);
          if(cached){const entry=JSON.parse(cached) as Entry<T>;if(entry.validUntil>Date.now()){this.metrics.redisHits++;return this.remember(key,entry);}}
          locked=!!await this.redis.set(key+':lock',owner,'PX',6000,'NX');
          if(!locked){
            for(let i=0;i<20;i++){await new Promise(r=>setTimeout(r,25));const value=await this.redis.get(key);if(value){const entry=JSON.parse(value) as Entry<T>;if(entry.validUntil>Date.now()){this.metrics.redisHits++;return this.remember(key,entry);}}}
            this.metrics.busy++;throw new ApiFault(503,'private_read_busy','Your vault is updating; retry shortly');
          }
        }
      }catch(error){if(error instanceof ApiFault)throw error;available=false;this.metrics.redisFailures++;}
    }
    if(!available&&this.fallback>=8){this.metrics.busy++;throw new ApiFault(503,'private_read_busy','Your vault is updating; retry shortly');}
    if(!available)this.fallback++;
    try{
      this.metrics.builds++;const entry=await work();entry.validUntil=Math.min(entry.validUntil,Date.now()+1000);
      if(available&&entry.validUntil>Date.now())await this.redis!.set(key,JSON.stringify(entry),'PX',Math.ceil(entry.validUntil-Date.now())).catch(()=>{this.metrics.redisFailures++;});
      return this.remember(key,entry);
    }finally{
      if(!available)this.fallback--;
      if(locked)await this.redis?.eval("if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0",1,key+':lock',owner).catch(()=>undefined);
    }
  }
}
