import { MarketHistory } from "./market-history.js";
import type { FastifyInstance } from "fastify";
import { inTransaction, type DbPool } from "@socially/db";
import { mintPattern, supportedByMint } from "@socially/market-data/catalog";
import { MarketCatalog, readHistory, historyRanges, type HistoryRange } from "./market-catalog.js";
import { requireActor } from "./auth.js";
import { ApiFault } from "./errors.js";

export function registerMarketCatalogRoutes(app: FastifyInstance, db: () => DbPool) {
  let history: MarketHistory|undefined;
  const charts=()=>history??=new MarketHistory(db());
  let catalog: MarketCatalog | undefined;
  const service = () => catalog ??= new MarketCatalog(db());
  const mint = (value: string) => { if (!mintPattern.test(value)) throw new ApiFault(400, "invalid_mint", "Invalid Solana mint"); return value; };
  app.get<{Querystring:{mints:string;range?:string}}>('/v1/markets/history/batch', {
    schema:{querystring:{type:'object',additionalProperties:false,required:['mints'],properties:{
      mints:{type:'string',maxLength:449},range:{type:'string',enum:['24h']}}}},
  },async(request,reply)=>{
    const addresses=request.query.mints.split(',');
    if(addresses.length>10||new Set(addresses).size!==addresses.length)throw new ApiFault(400,'invalid_history_batch','Choose at most ten distinct markets');
    addresses.forEach(mint);
    // Cached/stored reads only. Batch loading must never spend the provider budget.
    const items=[];
    for(let offset=0;offset<addresses.length;offset+=3){
      items.push(...await Promise.all(addresses.slice(offset,offset+3).map(async address=>{
        try{return {mint:address,history:await charts().read(address,'24H'),status:'READY'};}
        catch(error){if(error instanceof ApiFault&&error.code==='history_unsupported')return {mint:address,history:null,status:'UNAVAILABLE'};throw error;}
      })));
    }
    reply.header('cache-control','public, max-age=15');
    return {mode:'PAPER',range:'24H',items};
  });
  app.get<{ Querystring: { query?: string } }>("/v0/market/tokens", { schema: { querystring: {
    type: "object", additionalProperties: false, properties: { query: { type: "string", maxLength: 100 } },
  } } }, async (request, reply) => {
    reply.header("cache-control", "no-store");
    return { mode: "PAPER", asOf: new Date().toISOString(), tokens: await service().list(request.query.query?.trim() ?? "") };
  });
  app.get<{ Params: { mint: string } }>("/v0/market/tokens/:mint", async (request, reply) => {
    reply.header("cache-control", "no-store");
    const address = mint(request.params.mint);
    const known = (await db().query('SELECT 1 FROM market_token_metadata WHERE mint=$1',[address])).rowCount || supportedByMint.has(address);
    const token = (await service().list(known ? "" : address, known ? [address] : undefined)).find(item => item.mint === address);
    if (!token) throw new ApiFault(404, "token_not_found", "Token not found");
    return { mode: "PAPER", token };
  });
  app.get<{ Params: { mint: string }; Querystring: { range?: HistoryRange; backfill?: string } }>("/v0/market/tokens/:mint/history", {
    schema: { querystring: { type: "object", additionalProperties: false, properties: { backfill: { type: 'string', enum: ['true','false'] }, range: { type: "string", enum: Object.keys(historyRanges) } } } },
  }, async (request, reply) => {
    reply.header("cache-control", "public, max-age=5");
    return { mode: "PAPER", ...await charts().read(mint(request.params.mint), request.query.range ?? "24H", undefined, request.query.backfill==='true') as object };
  });
  app.get<{Params:{mint:string};Querystring:{range?:string;resolution?:string;backfill?:string}}>('/v1/markets/:mint/history',{schema:{querystring:{type:'object',additionalProperties:false,properties:{backfill:{type:'string',enum:['true','false']},range:{type:'string',enum:Object.keys(historyRanges).map(s=>s.toLowerCase())},resolution:{type:'string',enum:['1m','5m','15m','1h']}}}}},async(req,reply)=>{
    reply.header('cache-control','public, max-age=5');
    const resolutions:Record<string,number>={'1m':60,'5m':300,'15m':900,'1h':3600};
    return charts().read(mint(req.params.mint),(req.query.range??'24h').toUpperCase() as HistoryRange,req.query.resolution?resolutions[req.query.resolution]:undefined,req.query.backfill==='true');
  });
  app.get("/v0/me/watchlist", async (request, reply) => {
    const actor = await requireActor(request, db()); reply.header("cache-control", "no-store");
    const mints = (await db().query<{ mint: string }>("SELECT mint FROM market_watchlist WHERE user_id=$1 ORDER BY created_at,mint", [actor.id])).rows.map(row => row.mint);
    return { mode: "PAPER", mints, tokens: await service().list("", mints) };
  });
  app.put<{ Params: { mint: string } }>("/v0/me/watchlist/:mint", async (request, reply) => {
    const actor = await requireActor(request, db()), address = mint(request.params.mint);
    if (!(await db().query("SELECT 1 FROM market_token_metadata WHERE mint=$1", [address])).rowCount) {
      if (!(await service().search(address)).some(token => token.mint === address)) throw new ApiFault(404, "token_not_found", "Token not found");
    }
    await inTransaction(db(), async client => {
      await client.query("SELECT id FROM users WHERE id=$1 FOR NO KEY UPDATE", [actor.id]);
      const count = await client.query<{ count: string }>("SELECT count(*)::text FROM market_watchlist WHERE user_id=$1 AND mint<>$2", [actor.id, address]);
      if (Number(count.rows[0]!.count) >= 100) throw new ApiFault(422, "watchlist_full", "You can save up to 100 markets");
      await client.query("INSERT INTO market_watchlist(user_id,mint) VALUES($1,$2) ON CONFLICT DO NOTHING", [actor.id, address]);
    });
    reply.header("cache-control", "no-store"); return { mode: "PAPER", mint: address, saved: true };
  });
  app.delete<{ Params: { mint: string } }>("/v0/me/watchlist/:mint", async (request, reply) => {
    const actor = await requireActor(request, db()), address = mint(request.params.mint);
    await db().query("DELETE FROM market_watchlist WHERE user_id=$1 AND mint=$2", [actor.id, address]);
    reply.header("cache-control", "no-store"); return { mode: "PAPER", mint: address, saved: false };
  });
  app.addHook("onClose", async () => {catalog?.close();await history?.close();});
}
