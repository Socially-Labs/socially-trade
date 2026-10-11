import type { FastifyInstance } from 'fastify';
import { inTransaction,type DbPool } from '@socially/db';
import { envInteger } from '@socially/domain';
import { marketRedis } from '@socially/market-stream';
export function registerReadiness(app:FastifyInstance,db:()=>DbPool){
 let redis:ReturnType<typeof marketRedis>|undefined;
 const check=async()=>{
  const checks:Record<string,boolean>={postgres:false,redis:false,worker:false,ingestor:false};
  await Promise.allSettled([
   (async()=>{const rows=await inTransaction(db(),client=>client.query<{service:string;fresh:boolean}>(
     "SELECT service,completed_at>=clock_timestamp()-($1::int*interval '1 millisecond') AS fresh FROM paper_service_heartbeats",[envInteger('PAPER_HEARTBEAT_MAX_AGE_MS',60000)]));
     checks.postgres=true;for(const row of rows.rows)checks[row.service]=row.fresh;})(),
   (async()=>{if(!process.env.REDIS_URL)return;redis??=marketRedis(process.env.REDIS_URL);checks.redis=await redis.ping()==='PONG';})()
  ]);
  return {status:Object.values(checks).every(Boolean)?'ok':'unavailable',mode:'PAPER',checks};
 };
 for(const path of ['/health','/ready'])app.get(path,async(_request,reply)=>{
  reply.header('cache-control','no-store');const result=await check();if(result.status!=='ok')reply.code(503);return result;
 });
 app.get('/live',async()=>({status:'ok',mode:'PAPER'}));
 app.addHook('onClose',async()=>redis?.disconnect());
}
