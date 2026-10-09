import { randomUUID } from 'node:crypto';
import { Connection,PublicKey } from '@solana/web3.js';
import { inTransaction,ledgerAccountId,type DbPool } from '@socially/db';
import { Amount,fixed } from '@socially/domain';
import type { FastifyInstance } from 'fastify';
import type { MarketPrice } from '@socially/market-stream';
import { supportedById } from '@socially/market-data/catalog';
import { requireActor,type Actor } from './auth.js';
import { privySolanaWallets } from './privy.js';
import { ApiFault } from './errors.js';
import { SWAP_NETWORK as N } from './swap-types.js';
export const walletPaperEnabled=()=>process.env.PAPER_WALLET_SNAPSHOT_ENABLED==='true';
export const paperCashColumn=()=>walletPaperEnabled()?'vault_paper_cash':'paper_cash';
export const paperOwner=(id:string)=>`paper-vault:${id}`;
export type WalletSnapshot={solLamports:string;usdcRaw:string;slot:number};
export interface PaperSnapshotSource { read(wallet:string):Promise<WalletSnapshot> }
export class DevnetPaperSnapshotSource implements PaperSnapshotSource {
 private connection:Connection;
 constructor(rpc:string){this.connection=new Connection(rpc,{commitment:'finalized',disableRetryOnRateLimit:true,fetch:(url,init)=>fetch(url,{...init,signal:AbortSignal.timeout(10000)})});}
 async read(wallet:string){
  if(await this.connection.getGenesisHash()!==N.genesisHash)throw new ApiFault(503,'wrong_cluster','Paper snapshots require devnet wallet balances');
  const address=new PublicKey(wallet);
  const [sol,tokens]=await Promise.all([this.connection.getBalanceAndContext(address),this.connection.getParsedTokenAccountsByOwner(address,{mint:new PublicKey(N.usdcMint)})]);
  if(!Number.isSafeInteger(sol.value))throw new ApiFault(422,'balance_out_of_range','Wallet balance is too large');
  let usdc=0n;for(const {account}of tokens.value){const data=account.data;if(!('parsed' in data))throw new ApiFault(503,'balance_unavailable','Token balance unavailable');const info=data.parsed.info;if(info.mint!==N.usdcMint||info.owner!==wallet||info.tokenAmount.decimals!==6)throw new ApiFault(503,'balance_unavailable','Invalid wallet token account');usdc+=BigInt(info.tokenAmount.amount);}
  return {solLamports:String(sol.value),usdcRaw:usdc.toString(),slot:Math.min(sol.context.slot,tokens.context.slot)};
 }
}
export function snapshotValue(balances:WalletSnapshot,prices:MarketPrice[],now=Date.now()){
 let total=new Amount(0);const marks:{SOL:string|null;USDC:string|null}={SOL:null,USDC:null};
 for(const [symbol,raw,scale]of [['SOL',balances.solLamports,9],['USDC',balances.usdcRaw,6]]as const){
  if(!/^\d{1,20}$/.test(raw))throw new ApiFault(503,'balance_unavailable','Invalid wallet balance');
  if(BigInt(raw)===0n)continue;
  const p=prices.find(p=>p.instrumentId===symbol&&p.mint===supportedById.get(symbol)!.mint);
  const fresh=(v:string|null)=>v!==null&&Number.isFinite(Date.parse(v))&&Date.parse(v)<=now+5000&&now-Date.parse(v)<=90000;
  if(!p||p.status!=='CURRENT'||!fresh(p.sourceAt)||!fresh(p.receivedAt)||!p.priceUsd||!/^\d{1,18}(\.\d{1,18})?$/.test(p.priceUsd)||new Amount(p.priceUsd).lte(0))throw new ApiFault(503,'prices_unavailable','Fresh SOL and USDC market prices are required. Try again shortly.');
  marks[symbol]=p.priceUsd;total=total.plus(new Amount(raw).div(new Amount(10).pow(scale)).mul(p.priceUsd));
 }
 const value=fixed(total,6);if(new Amount(value).lte(0))throw new ApiFault(422,'empty_wallet','Add devnet SOL or USDC before starting your paper portfolio');
 return {value,marks};
}
export async function paperPortfolio(pool:DbPool,userId:string){
 const row=(await pool.query(`SELECT u.vault_paper_cash::text AS "availableUsdc",s.initial_usdc::text AS "initialUsdc",s.wallet_address AS wallet,s.created_at AS "initializedAt" FROM users u LEFT JOIN paper_wallet_snapshots s ON s.user_id=u.id WHERE u.id=$1`,[userId])).rows[0];
 return {mode:'PAPER',enabled:walletPaperEnabled(),initialized:!!row?.wallet,availableUsdc:fixed(row?.availableUsdc??'0',6),initialUsdc:row?.initialUsdc?fixed(row.initialUsdc,6):null,wallet:row?.wallet??null,initializedAt:row?.initializedAt?.toISOString()??null};
}
export async function initializePaperPortfolio(pool:DbPool,actor:Actor,wallet:string,source:PaperSnapshotSource){
 if(!walletPaperEnabled())throw new ApiFault(503,'paper_portfolio_disabled','Wallet-based paper portfolios are disabled');
 const existing=await paperPortfolio(pool,actor.id);if(existing.initialized)return existing;
 const owned=await privySolanaWallets(actor.subject);if(owned===null)throw new ApiFault(503,'auth_unconfigured','Wallet ownership verification is unavailable');if(!owned.includes(wallet))throw new ApiFault(403,'wallet_not_owned','Use your linked Solana wallet');
 // RPC and price reads happen before financial locks. No token transaction is built.
 let balances:WalletSnapshot;try{balances=await source.read(wallet);}catch(error){if(error instanceof ApiFault)throw error;throw new ApiFault(503,'balance_unavailable','Wallet balances are temporarily unavailable. Try again shortly.');}
 const prices=(await pool.query<{payload:{price:MarketPrice}}>("SELECT payload FROM market_latest WHERE instrument_id IN ('SOL','USDC')")).rows.map(row=>row.payload.price);
 const {value,marks}=snapshotValue(balances,prices);
 await inTransaction(pool,async client=>{
  await client.query("SET LOCAL lock_timeout='3s'");
  await client.query('SELECT id FROM users WHERE id=$1 FOR NO KEY UPDATE',[actor.id]);
  if((await client.query('SELECT 1 FROM paper_wallet_snapshots WHERE user_id=$1',[actor.id])).rowCount)return;
  // A wallet cannot seed another account after its tokens have been reused.
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[wallet]);
  if((await client.query('SELECT 1 FROM paper_wallet_snapshots WHERE wallet_address=$1',[wallet])).rowCount)throw new ApiFault(409,'wallet_already_snapshotted','This wallet has already initialized a paper portfolio');
  const event=randomUUID();await client.query("INSERT INTO fund_events(id,type,payload) VALUES($1,'paper_wallet_snapshotted',$2)",[event,{userId:actor.id,amount:value,asset:'USDC',mode:'PAPER'}]);
  await client.query(`INSERT INTO paper_wallet_snapshots(user_id,wallet_address,sol_lamports,usdc_raw,sol_price_usd,usdc_price_usd,initial_usdc,observed_slot,event_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[actor.id,wallet,balances.solLamports,balances.usdcRaw,marks.SOL,marks.USDC,value,balances.slot,event]);
  await client.query('UPDATE users SET vault_paper_cash=vault_paper_cash+$2::numeric WHERE id=$1',[actor.id,value]);
  const issuance=await ledgerAccountId(client,'ISSUANCE','paper-wallet-snapshots','USDC'),cash=await ledgerAccountId(client,'USER',paperOwner(actor.id),'USDC');
  await client.query('INSERT INTO ledger_entries(event_id,account_id,amount) VALUES($1,$2,-$4::numeric),($1,$3,$4)',[event,issuance,cash,value]);
 });
 return paperPortfolio(pool,actor.id);
}
export function registerPaperPortfolioRoutes(app:FastifyInstance,db:()=>DbPool,source:PaperSnapshotSource){
 app.get('/v1/me/paper-portfolio',async(req,reply)=>{reply.header('cache-control','no-store');const actor=await requireActor(req,db());return paperPortfolio(db(),actor.id);});
 app.post<{Body:{wallet:string}}>('/v1/me/paper-portfolio/initialize',{schema:{body:{type:'object',additionalProperties:false,required:['wallet'],properties:{wallet:{type:'string',pattern:'^[1-9A-HJ-NP-Za-km-z]{32,44}$'}}}}},async(req,reply)=>{reply.header('cache-control','no-store');const actor=await requireActor(req,db());return initializePaperPortfolio(db(),actor,req.body.wallet,source);});
}
