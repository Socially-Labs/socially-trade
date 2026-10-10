import type { FastifyInstance } from 'fastify';
import { inTransaction, type DbPool } from '@socially/db';
import { marketRedis, currentPrice, type MarketEvent } from '@socially/market-stream';
import { registeredInstruments, dynamicTradingEnabled } from '@socially/market-data/registry';
import { PublicKey, Connection } from '@solana/web3.js';
import type { TokenMetadata } from '@socially/market-data/tokens';
import { MarketCatalog } from './market-catalog.js';
import { requireActor } from './auth.js';
import { ApiFault } from './errors.js';

/** Provider identity is checked against a mainnet mint account, outside accounting transactions. */
export async function validateMintMetadata(mint: string, decimals: number, rpc: string) {
  let key: PublicKey;
  try { key = new PublicKey(mint); if(key.toBase58()!==mint) throw new Error(); }
  catch { throw new ApiFault(400,'invalid_mint','Invalid Solana public key'); }
  const connection = new Connection(rpc,{commitment:'confirmed',disableRetryOnRateLimit:true,fetch:(url,init)=>fetch(url,{...init,signal:AbortSignal.timeout(5000)})});
  let account;
  try { account = await Promise.race([connection.getParsedAccountInfo(key),new Promise<never>((_,reject)=>{const timer=setTimeout(()=>reject(new Error('rpc_timeout')),5000);timer.unref();})]); }
  catch { throw new ApiFault(503,'identity_unavailable','Mainnet mint verification is temporarily unavailable'); }
  const value = account.value;
  const parsed = value && 'parsed' in value.data ? value.data.parsed : null;
  if (!value || !['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA','TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'].includes(value.owner.toBase58()) ||
    parsed?.type!=='mint' || parsed.info.decimals!==decimals || !parsed.info.isInitialized)
    throw new ApiFault(422,'mint_metadata_conflict','Provider metadata does not match the mainnet mint');
}
export async function registerInstrument(pool: DbPool, token: TokenMetadata) {
  try {if(new PublicKey(token.mint).toBase58()!==token.mint)throw new Error();}catch{throw new ApiFault(400,'invalid_mint','Invalid Solana mint');}
  if(!Number.isInteger(token.decimals)||token.decimals<0||token.decimals>18) throw new ApiFault(422,'unsupported_precision','Unsupported token precision');
  return inTransaction(pool,async client=>{
    // Serialize the mint resolver across processes, preserving legacy identities and admin state.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[token.mint]);
    const existing=(await registeredInstruments(client,undefined,[token.mint]))[0];
    if(existing){ if(existing.decimals!==token.decimals) throw new ApiFault(422,'mint_metadata_conflict','Mint precision changed'); return existing; }
    const id=`solana:${token.mint}`;
    await client.query(`INSERT INTO instruments(id,symbol,mint_address,decimals,registration_source) VALUES($1,$2,$3,$4,'JUPITER_MAINNET_RPC')`,[id,token.symbol,token.mint,token.decimals]);
    return (await registeredInstruments(client,[id]))[0]!;
  });
}
export function registerMarketTrackingRoutes(app: FastifyInstance, db: ()=>DbPool) {
  let redis: ReturnType<typeof marketRedis>|undefined, catalog: MarketCatalog|undefined;
  app.post<{Params:{mint:string}}>('/v1/markets/:mint/tracking',async (req,reply)=>{
    const actor=await requireActor(req,db()); reply.header('cache-control','no-store');
    let mint: string;
    try { mint=new PublicKey(req.params.mint).toBase58(); if(mint!==req.params.mint)throw new Error(); }
    catch {throw new ApiFault(400,'invalid_mint','Invalid Solana mint');}
    if(!process.env.REDIS_URL) throw new ApiFault(503,'tracking_unavailable','Market tracking requires Redis');
    redis ??=marketRedis(process.env.REDIS_URL);
    for(let i=0;i<20&&['connecting','connect'].includes(redis.status);i++)await new Promise(resolve=>setTimeout(resolve,25));
    if(redis.status!=='ready')throw new ApiFault(503,'tracking_unavailable','Market tracking is temporarily unavailable');
    // Bound both account and shared admission before any provider/RPC work.
    const admitted=Number(await redis.eval(`local now=tonumber(ARGV[1]); redis.call('ZREMRANGEBYSCORE',KEYS[1],'-inf',now); redis.call('ZREMRANGEBYSCORE',KEYS[2],'-inf',now)
      if redis.call('ZSCORE',KEYS[1],ARGV[2])==false and redis.call('ZCARD',KEYS[1])>=10 then return 0 end
      if redis.call('ZSCORE',KEYS[2],ARGV[2])==false and redis.call('ZCARD',KEYS[2])>=200 then return 0 end
      local n=redis.call('INCR',KEYS[3]);if n==1 then redis.call('PEXPIRE',KEYS[3],60000)end;if n>30 then return 0 end
      redis.call('ZADD',KEYS[1],now+30000,ARGV[2]);redis.call('PEXPIRE',KEYS[1],60000);redis.call('ZADD',KEYS[2],now+30000,ARGV[2]);return 1`,3,
      `socially:market:leases:${actor.id}`,'socially:market:lease-mints',`socially:market:tracking-rate:${actor.id}`,Date.now(),mint));
    if(!admitted)throw new ApiFault(429,'tracking_capacity','Too many active market requests; retry shortly');
    let token=(await registeredInstruments(db(),undefined,[mint]))[0];
    if(!token){
      if(!dynamicTradingEnabled())throw new ApiFault(422,'dynamic_buys_paused','Dynamic market registration is paused');
      const owner=`${actor.id}:${Date.now()}`,lock=`socially:market:registration:${mint}`;
      if(!await redis.set(lock,owner,'PX',15000,'NX'))throw new ApiFault(503,'registration_pending','Market identity is being verified; retry shortly');
      try {
        token=(await registeredInstruments(db(),undefined,[mint]))[0];
        if(!token){
          catalog ??=new MarketCatalog(db());
          let metadata=(await db().query<{payload:TokenMetadata}>("SELECT payload FROM market_token_metadata WHERE mint=$1 AND fetched_at>now()-interval '1 hour'",[mint])).rows[0]?.payload;
          metadata ??=(await catalog.search(mint)).find(t=>t.mint===mint);
          if(!metadata)throw new ApiFault(404,'token_not_found','Token not found');
          await validateMintMetadata(mint,metadata.decimals,process.env.MARKET_RPC_URL??'https://api.mainnet-beta.solana.com');
          token=await registerInstrument(db(),metadata);
        }
      } finally {await redis.eval("if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1])end return 0",1,lock,owner);}
    }
    const expires=Date.now()+30000;
    await redis.zadd('socially:market:watched',expires,token.id);
    const mark=(await db().query<{payload:MarketEvent}>('SELECT payload FROM market_latest WHERE instrument_id=$1',[token.id])).rows[0]?.payload.price;
    const price=mark?currentPrice(mark):null;
    return {mode:'PAPER',instrumentId:token.id,mint,state:token.eligibility==='DISABLED'?'UNAVAILABLE':price?.status==='CURRENT'?'READY':price?.status==='STALE'?'STALE':'WARMING',
      reason:token.eligibility==='DISABLED'?token.eligibilityReason??'asset_disabled':price?.reason??(price?.status==='CURRENT'?null:'price_pending'),retryAfterMs:1500,leaseExpiresAt:new Date(expires).toISOString()};
  });
  app.addHook('onClose',async()=>{redis?.disconnect();catalog?.close();});
}
