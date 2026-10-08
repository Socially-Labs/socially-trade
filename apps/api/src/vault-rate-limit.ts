import type { FastifyInstance } from 'fastify';
import { ApiFault } from './errors.js';
/** Gateway budget. Financial deduplication records never expire with this transient limiter. */
export function registerVaultRateLimit(app:FastifyInstance) {
  const buckets=new Map<string,{ count:number; expiresAt:number }>();
  app.addHook('onRequest',async(req,reply)=>{
    const now=Date.now();
    if (buckets.size>=5000) for (const [key,bucket] of buckets) if (bucket.expiresAt<=now) buckets.delete(key);
    let bucket=buckets.get(req.ip);
    if (!bucket || bucket.expiresAt<=now) {
      if (!bucket && buckets.size>=5000) throw new ApiFault(503,'gateway_busy','Try again shortly');
      bucket={ count:0,expiresAt:now+60000 }; buckets.set(req.ip,bucket);
    }
    if (++bucket.count>240) { reply.header('retry-after',Math.ceil((bucket.expiresAt-now)/1000)); throw new ApiFault(429,'vault_rate_limited','Too many vault requests; retry shortly'); }
  });
}
