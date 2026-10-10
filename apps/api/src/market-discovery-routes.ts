import type { FastifyInstance } from 'fastify';
import type { DbPool } from '@socially/db';
import { MarketDiscovery, parseMarketQuery } from './market-discovery.js';
import { ApiFault } from './errors.js';
export function registerMarketDiscoveryRoutes(app: FastifyInstance, db: () => DbPool) {
  let service: MarketDiscovery | undefined;
  const get = () => {
    if (process.env.MARKET_DISCOVERY_V1_ENABLED !== 'true') throw new ApiFault(404,'market_discovery_disabled','Market discovery is not enabled');
    return service ??= new MarketDiscovery(db());
  };
  const handle = async (reply: { header: (key:string,value:string)=>unknown }, work: () => Promise<unknown>) => {
    reply.header('cache-control','no-store');
    try { return await work(); }
    catch (error) {
      if (error instanceof ApiFault && [429,503].includes(error.statusCode)) reply.header('retry-after','5');
      throw error;
    }
  };
  app.get<{Querystring:Record<string,unknown>}>('/v1/markets',async (req,reply)=>handle(reply,()=>get().list(parseMarketQuery(req.query))));
  app.get<{Querystring:Record<string,unknown>}>('/v1/markets/search',async (req,reply)=>handle(reply,()=>get().list(parseMarketQuery(req.query,true))));
  app.get<{Params:{mint:string}}>('/v1/markets/:mint',async (req,reply)=>handle(reply,()=>get().detail(req.params.mint)));
  app.addHook('onClose',async()=>service?.close());
}
