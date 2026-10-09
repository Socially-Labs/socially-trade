import { randomUUID } from 'node:crypto';
import { inTransaction, type DbPool } from '@socially/db';
import type { Actor } from './auth.js';
import { ApiFault } from './errors.js';
import { privySolanaWallets } from './privy.js';
import { walletOf } from './token-flows.js';
import type { SwapConfig } from './swap-config.js';
import type { SwapChain, SwapFees, VenueQuote, SwapToken } from './swap-types.js';
export interface SwapLayer { chain: SwapChain; config: SwapConfig }
interface QuoteRow { id:string; user_id:string; wallet:string; quote:VenueQuote; expires_at:Date }
export interface SwapRow {
  id:string; user_id:string; client_request_id:string; quote_id:string; wallet:string; cluster:'devnet'; quote:VenueQuote;
  status:'PREPARED'|'SUBMITTED'|'CONFIRMED'|'FAILED'|'EXPIRED'; unsigned_transaction:string; signed_transaction:string|null;
  signature:string|null; blockhash:string; last_valid_block_height:string; fees:SwapFees; filled_output_raw:string|null;
  actual_network_fee_lamports:string|null; failure:string|null; created_at:Date; updated_at:Date;
}
export function swapView(row:SwapRow) {
  const {response:_,...quote}=row.quote;
  return {id:row.id,quoteId:row.quote_id,clientRequestId:row.client_request_id,wallet:row.wallet,cluster:row.cluster,status:row.status,quote:{...quote,id:row.quote_id,wallet:row.wallet,cluster:row.cluster},
    transaction:row.status==='PREPARED'?row.unsigned_transaction:null,signature:row.signature,blockhash:row.blockhash,
    lastValidBlockHeight:Number(row.last_valid_block_height),fees:row.fees,filledOutputRaw:row.filled_output_raw,
    actualNetworkFeeLamports:row.actual_network_fee_lamports,failure:row.failure,createdAt:row.created_at.toISOString(),updatedAt:row.updated_at.toISOString()};
}
export async function swapRateLimit(pool:DbPool,userId:string,kind:'quote'|'prepare'|'submit'|'read',limit:number) {
  await inTransaction(pool,async client=>{
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('wallet_swap_rate:'||$1,0))",[userId]);
    const result=await client.query<{count:string}>("SELECT count(*)::text AS count FROM wallet_swap_requests WHERE user_id=$1 AND kind=$2 AND created_at>now()-interval '1 hour'",[userId,kind]);
    if(Number(result.rows[0]!.count)>=limit)throw new ApiFault(429,'rate_limited','Too many swap requests. Please retry later.');
    await client.query('INSERT INTO wallet_swap_requests(user_id,kind) VALUES($1,$2)',[userId,kind]);
  });
}
export async function quoteSwap(pool:DbPool,layer:SwapLayer,actor:Actor,body:{wallet:string;input:SwapToken;amountRaw:string}) {
  await swapRateLimit(pool,actor.id,'quote',layer.config.quotesPerHour);
  // Never accept an arbitrary wallet just because it came from an authenticated device.
  const bound=await walletOf(pool,actor.id);
  if(bound && bound!==body.wallet)throw new ApiFault(409,'wallet_mismatch','This account is bound to another wallet');
  const linked=await privySolanaWallets(actor.subject);
  if(!linked)throw new ApiFault(503,'wallet_verification_unconfigured','PRIVY_APP_SECRET is required for wallet swaps');
  if(!linked.includes(body.wallet))throw new ApiFault(403,'wallet_not_linked','This wallet is not linked to your account');
  const quote=await layer.chain.quote(body.input,body.amountRaw);
  // The route must use a bounded server TTL; Raydium does not promise a quote expiry timestamp.
  const id=randomUUID(),expiresAt=new Date(Date.now()+layer.config.quoteLifetimeMs);
  await pool.query('INSERT INTO wallet_swap_quotes(id,user_id,wallet,quote,expires_at) VALUES($1,$2,$3,$4,$5)',[id,actor.id,body.wallet,{...quote,expiresAt:expiresAt.toISOString()},expiresAt]);
  const {response:_,...publicQuote}=quote;
  return {id,wallet:body.wallet,cluster:'devnet' as const,...publicQuote,expiresAt:expiresAt.toISOString()};
}
export async function prepareWalletSwap(pool:DbPool,layer:SwapLayer,actor:Actor,body:{quoteId:string;clientRequestId:string}) {
  await swapRateLimit(pool,actor.id,'prepare',layer.config.preparesPerHour);
  return inTransaction(pool,async client=>{
    // Serialize duplicate requests across API instances, including a lost prepare response.
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('wallet_swap_prepare:'||$1,0))",[actor.id]);
    const prior=(await client.query<SwapRow>('SELECT * FROM wallet_swaps WHERE user_id=$1 AND client_request_id=$2',[actor.id,body.clientRequestId])).rows[0];
    if(prior) {
      if(prior.quote_id!==body.quoteId)throw new ApiFault(409,'idempotency_conflict','This request ID was used for another quote');
      return swapView(prior);
    }
    if((await client.query('SELECT 1 FROM wallet_swaps WHERE quote_id=$1 AND user_id=$2',[body.quoteId,actor.id])).rowCount)throw new ApiFault(409,'quote_already_prepared','This quote already has a swap intent');
    const q=(await client.query<QuoteRow>('SELECT * FROM wallet_swap_quotes WHERE id=$1 AND user_id=$2',[body.quoteId,actor.id])).rows[0];
    if(!q)throw new ApiFault(404,'quote_not_found','Swap quote not found');
    if(q.expires_at.getTime()<=Date.now())throw new ApiFault(409,'quote_expired','Refresh your swap quote');
    const prepared=await layer.chain.prepare(q.quote,q.wallet);
    if(q.expires_at.getTime()<=Date.now())throw new ApiFault(409,'quote_expired','Your quote expired while preparing; refresh it');
    const row=(await client.query<SwapRow>(`INSERT INTO wallet_swaps(id,user_id,client_request_id,quote_id,wallet,cluster,quote,status,unsigned_transaction,blockhash,last_valid_block_height,fees)
      VALUES($1,$2,$3,$4,$5,'devnet',$6,'PREPARED',$7,$8,$9,$10) RETURNING *`,
      [randomUUID(),actor.id,body.clientRequestId,q.id,q.wallet,q.quote,prepared.transaction,prepared.blockhash,prepared.lastValidBlockHeight,prepared.fees])).rows[0]!;
    return swapView(row);
  });
}
export async function ownedSwap(pool:DbPool,userId:string,id:string) {
  const row=(await pool.query<SwapRow>('SELECT * FROM wallet_swaps WHERE id=$1 AND user_id=$2',[id,userId])).rows[0];
  if(!row)throw new ApiFault(404,'swap_not_found','Swap not found');
  return row;
}
export async function submitWalletSwap(pool:DbPool,layer:SwapLayer,actor:Actor,id:string,signedTransaction:string) {
  await swapRateLimit(pool,actor.id,'submit',120);
  const initial=await ownedSwap(pool,actor.id,id);
  const signed=layer.chain.verifySigned(initial.unsigned_transaction,signedTransaction,initial.wallet);
  await inTransaction(pool,async client=>{
    const row=(await client.query<SwapRow>('SELECT * FROM wallet_swaps WHERE id=$1 AND user_id=$2 FOR UPDATE',[id,actor.id])).rows[0]!;
    if(row.signature && row.signature!==signed.signature)throw new ApiFault(409,'signature_conflict','This swap already has another signature');
    if(row.signature)return;
    // Persist signed bytes BEFORE the first RPC send. The worker can resume after any crash.
    await client.query("UPDATE wallet_swaps SET signed_transaction=$2,signature=$3,status='SUBMITTED',next_check_at=now(),updated_at=now() WHERE id=$1",[id,signed.wire,signed.signature]);
  });
  // Do not treat an RPC timeout or preflight rejection as proof of on-chain failure.
  // Durable reconciliation owns the send and final outcome, including process restarts.
  return swapView(await ownedSwap(pool,actor.id,id));
}
export async function reconcileWalletSwap(pool:DbPool,chain:SwapChain,row:SwapRow) {
  if(!['PREPARED','SUBMITTED'].includes(row.status))return;
  const outcome=await chain.observe({signature:row.signature,unsigned:row.unsigned_transaction,quote:row.quote,wallet:row.wallet,lastValidBlockHeight:Number(row.last_valid_block_height)});
  if(outcome.status==='pending') {
    // Same signed bytes => same deterministic signature. Never rebuild on a retry.
    if(row.signed_transaction)try{await chain.broadcast(row.signed_transaction);}catch{/* Preserve pending; RPC may already have accepted it. */}
    await pool.query("UPDATE wallet_swaps SET next_check_at=now()+interval '5 seconds' WHERE id=$1 AND status=$2 AND signature IS NOT DISTINCT FROM $3",[row.id,row.status,row.signature]);
    return;
  }
  const status=outcome.status==='confirmed'?'CONFIRMED':outcome.status==='expired'?'EXPIRED':'FAILED';
  await pool.query(`UPDATE wallet_swaps SET status=$2,filled_output_raw=$3,actual_network_fee_lamports=$4,failure=$5,updated_at=now()
    WHERE id=$1 AND status=$6 AND signature IS NOT DISTINCT FROM $7`,[row.id,status,outcome.status==='confirmed'?outcome.filledOutputRaw:null,
    outcome.status==='confirmed'?outcome.networkFeeLamports:null,outcome.status==='failed'?outcome.failure??'transaction_failed':null,row.status,row.signature]);
}
export async function sweepWalletSwaps(pool:DbPool,chain:SwapChain,onError:(error:unknown)=>void) {
  const rows=await pool.query<SwapRow>(`UPDATE wallet_swaps SET next_check_at=now()+interval '2 minutes' WHERE id IN
    (SELECT id FROM wallet_swaps WHERE status IN ('PREPARED','SUBMITTED') AND next_check_at<=now() ORDER BY next_check_at LIMIT 8 FOR UPDATE SKIP LOCKED) RETURNING *`);
  await Promise.all(rows.rows.map(async row=>{
    try{await reconcileWalletSwap(pool,chain,row);}catch(error){onError(error);await pool.query("UPDATE wallet_swaps SET next_check_at=now()+interval '15 seconds' WHERE id=$1",[row.id]);}
  }));
  await pool.query("DELETE FROM wallet_swap_requests WHERE id IN (SELECT id FROM wallet_swap_requests WHERE created_at<now()-interval '1 day' LIMIT 1000)");
}
export function startSwapWorker(pool:DbPool,chain:SwapChain,onError:(error:unknown)=>void) {
  let stopped=false,timer:ReturnType<typeof setTimeout>,running=Promise.resolve();
  const tick=()=>{running=sweepWalletSwaps(pool,chain,onError).catch(onError).finally(()=>{if(!stopped){timer=setTimeout(tick,2000);timer.unref();}});};
  timer=setTimeout(tick,0);
  return async()=>{stopped=true;clearTimeout(timer);await running;};
}
