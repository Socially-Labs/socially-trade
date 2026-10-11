import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { inTransaction, type DbPool } from '@socially/db';
import { requireActor } from './auth.js';
import { ApiFault } from './errors.js';
import { privySolanaWallets } from './privy.js';
import { walletOf } from './wallet-identity.js';
import { SEED_MINIMUM, type LiveChain } from './live-vault-chain.js';
import { SWAP_NETWORK } from './swap-types.js';
import { PublicKey } from '@solana/web3.js';

interface Row {id:string;user_id:string;client_request_id:string;request_hash:string;vault_id:string;kind:'CREATE'|'EXIT';input_asset:string;input_raw:string;fund_address:string;seed_usdc_raw:string;wallet:string;
 status:'PREPARED'|'SUBMITTED'|'CONFIRMED'|'FAILED'|'EXPIRED';unsigned_transaction:string;signed_transaction:string|null;signature:string|null;last_valid_block_height:string;fees:unknown;failure:string|null}
const view=(r:Row)=>({id:r.id,clientRequestId:r.client_request_id,vaultId:r.vault_id,fundAddress:r.fund_address,seedUsdcRaw:r.seed_usdc_raw,wallet:r.wallet,kind:r.kind,mode:'ONCHAIN',cluster:'devnet',asset:r.input_asset,amountRaw:r.input_raw,status:r.status,
 transaction:r.status==='PREPARED'?r.unsigned_transaction:null,signature:r.signature,lastValidBlockHeight:Number(r.last_valid_block_height),fees:r.fees,failure:r.failure});
const uuid={type:'string',format:'uuid'},raw={type:'string',pattern:'^[1-9][0-9]{0,19}$'},params={type:'object',required:['id'],additionalProperties:false,properties:{id:uuid}};
const operationSql='SELECT t.*,v.fund_address,v.seed_usdc_raw::text,v.wallet FROM live_vault_transactions t JOIN live_vaults v ON v.id=t.vault_id';
export function registerLiveVaultRoutes(app:FastifyInstance,db:()=>DbPool,chain:LiveChain|null) {
 const requireChain=()=>{if(!chain)throw new ApiFault(503,'live_vaults_unconfigured','Onchain vault funding is not configured');return chain;};
 app.get('/v1/live-vaults/config',async(_req,reply)=>{
  reply.header('cache-control','no-store');const readiness=chain?await chain.readiness():{enabled:false,reason:'live_vaults_unconfigured'};
  return {mode:'ONCHAIN',cluster:'devnet',...readiness,minimumSeedUsdcRaw:SEED_MINIMUM.toString(),assets:['SOL','USDC'],settlementAsset:'USDC',exitPolicy:'IN_KIND_ON_DEMAND',performanceFeeBps:1000};
 });
 const verifyWallet=async(user:{id:string;subject:string},wallet:string)=>{
  try{if(new PublicKey(wallet).toBase58()!==wallet)throw Error();}catch{throw new ApiFault(400,'invalid_wallet','Invalid wallet');}
  const bound=await walletOf(db(),user.id);if(bound&&bound!==wallet)throw new ApiFault(409,'wallet_mismatch','Your linked wallet has changed');
  const linked=await privySolanaWallets(user.subject);if(!linked)throw new ApiFault(503,'wallet_verification_unconfigured','Wallet ownership verification is not configured');
  if(!linked.includes(wallet))throw new ApiFault(403,'wallet_not_linked','Wallet is not linked to this account');
 };
 app.post<{Body:{clientRequestId:string;wallet:string;asset:'SOL'|'USDC';amountRaw:string;name:string;description:string}}>('/v1/live-vaults',{
  schema:{body:{type:'object',additionalProperties:false,required:['clientRequestId','wallet','asset','amountRaw','name','description'],properties:{clientRequestId:uuid,wallet:{type:'string',minLength:32,maxLength:44},asset:{type:'string',enum:['SOL','USDC']},amountRaw:raw,name:{type:'string',minLength:3,maxLength:80},description:{type:'string',maxLength:1000}}}},
 },async(req,reply)=>{
  const actor=await requireActor(req,db());if(actor.role!=='captain')throw new ApiFault(403,'captain_required','Choose the Captain role first');
  if(req.body.name.trim().length<3||BigInt(req.body.amountRaw)>18446744073709551615n)throw new ApiFault(400,'invalid_request','Invalid name or amount');
  const c=requireChain();await verifyWallet(actor,req.body.wallet);
  const body={...req.body,name:req.body.name.trim(),description:req.body.description.trim()},hash=createHash('sha256').update(JSON.stringify(body)).digest('hex');
  const row=await inTransaction(db(),async client=>{
   await client.query("SET LOCAL lock_timeout='3s'");
   await client.query("SELECT pg_advisory_xact_lock(hashtextextended('live_vault:'||$1,0))",[actor.id]);
   const prior=(await client.query<Row>(`${operationSql} WHERE t.user_id=$1 AND t.client_request_id=$2`,[actor.id,body.clientRequestId])).rows[0];
   if(prior){if(prior.request_hash!==hash)throw new ApiFault(409,'idempotency_conflict','Request ID already used');return prior;}
   if(((await client.query("SELECT 1 FROM live_vault_transactions WHERE user_id=$1 AND created_at>now()-interval '1 hour' LIMIT 30",[actor.id])).rowCount ?? 0)>=30)throw new ApiFault(429,'rate_limited','Too many vault preparations');
   if((await client.query("SELECT 1 FROM live_vault_transactions WHERE user_id=$1 AND kind='CREATE' AND status IN ('PREPARED','SUBMITTED')",[actor.id])).rowCount)throw new ApiFault(409,'pending_creation','Recover your pending vault creation first');
   const prepared=await c.prepare(body.wallet,body.asset,body.amountRaw),vaultId=randomUUID();
   await client.query(`INSERT INTO live_vaults(id,user_id,wallet,fund_address,fund_number,share_mint,name,description,seed_usdc_raw) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[vaultId,actor.id,body.wallet,prepared.fund,prepared.number,prepared.shares,body.name,body.description,prepared.seedRaw]);
   const result=(await client.query<Row>(`INSERT INTO live_vault_transactions(id,user_id,client_request_id,request_hash,vault_id,kind,input_asset,input_raw,status,unsigned_transaction,last_valid_block_height,fees)
    VALUES($1,$2,$3,$4,$5,'CREATE',$6,$7,'PREPARED',$8,$9,$10) RETURNING *`,[randomUUID(),actor.id,body.clientRequestId,hash,vaultId,body.asset,body.amountRaw,prepared.transaction,prepared.lastValidBlockHeight,prepared.fees])).rows[0]!;
   return {...result,fund_address:prepared.fund,seed_usdc_raw:prepared.seedRaw,wallet:body.wallet};
  });
  reply.header('cache-control','no-store').code(201);return {operation:view(row)};
 });
 app.get('/v1/me/live-vaults',async(req,reply)=>{
  const actor=await requireActor(req,db());reply.header('cache-control','no-store');
  return {vaults:(await db().query(`SELECT v.id,v.name,v.description,v.fund_address AS "fundAddress",v.seed_usdc_raw::text AS "seedUsdcRaw",v.created_at AS "createdAt"
   FROM live_vaults v WHERE v.user_id=$1 AND EXISTS(SELECT 1 FROM live_vault_transactions t WHERE t.vault_id=v.id AND t.kind='CREATE' AND t.status='CONFIRMED') ORDER BY v.created_at DESC LIMIT 50`,[actor.id])).rows};
 });
 app.get<{Querystring:{clientRequestId:string}}>('/v1/me/live-vault-operations',{schema:{querystring:{type:'object',required:['clientRequestId'],additionalProperties:false,properties:{clientRequestId:uuid}}}},async(req,reply)=>{
  const actor=await requireActor(req,db());const row=(await db().query<Row>(`${operationSql} WHERE t.user_id=$1 AND t.client_request_id=$2`,[actor.id,req.query.clientRequestId])).rows[0];
  if(!row)throw new ApiFault(404,'operation_missing','Vault operation not found');reply.header('cache-control','no-store');return {operation:view(row)};
 });
 app.get('/v1/me/live-vault-pending',async(req,reply)=>{
  const actor=await requireActor(req,db());reply.header('cache-control','no-store');
  return {operations:(await db().query<Row>(`${operationSql} WHERE t.user_id=$1 AND t.status IN ('PREPARED','SUBMITTED') ORDER BY t.created_at DESC LIMIT 10`,[actor.id])).rows.map(view)};
 });
 app.get<{Params:{id:string}}>('/v1/live-vaults/:id',{schema:{params}},async(req,reply)=>{
  const actor=await requireActor(req,db());const row=(await db().query(`SELECT v.*,t.status FROM live_vaults v JOIN live_vault_transactions t ON t.vault_id=v.id AND t.kind='CREATE' WHERE v.id=$1 AND v.user_id=$2`,[req.params.id,actor.id])).rows[0];
  if(!row)throw new ApiFault(404,'vault_missing','Vault not found');reply.header('cache-control','no-store');
  return {vault:{id:row.id,name:row.name,description:row.description,fundAddress:row.fund_address,wallet:row.wallet,seedUsdcRaw:row.seed_usdc_raw,status:row.status,mode:'ONCHAIN',cluster:SWAP_NETWORK.cluster},
   position:row.status==='CONFIRMED'?await requireChain().holdings(row.wallet,row.fund_address):null};
 });
 app.post<{Params:{id:string};Body:{clientRequestId:string}}>('/v1/live-vaults/:id/exits',{schema:{params,body:{type:'object',additionalProperties:false,required:['clientRequestId'],properties:{clientRequestId:uuid}}}},async(req,reply)=>{
  const actor=await requireActor(req,db()),c=requireChain();
  const vault=(await db().query('SELECT * FROM live_vaults WHERE id=$1 AND user_id=$2',[req.params.id,actor.id])).rows[0];
  if(!vault)throw new ApiFault(404,'vault_missing','Vault not found');await verifyWallet(actor,vault.wallet);
  const hash=createHash('sha256').update(`EXIT:${vault.id}`).digest('hex');
  const row=await inTransaction(db(),async client=>{
   await client.query("SET LOCAL lock_timeout='3s'");await client.query("SELECT pg_advisory_xact_lock(hashtextextended('live_vault:'||$1,0))",[actor.id]);
   const prior=(await client.query<Row>(`${operationSql} WHERE t.user_id=$1 AND t.client_request_id=$2`,[actor.id,req.body.clientRequestId])).rows[0];
   if(prior){if(prior.request_hash!==hash)throw new ApiFault(409,'idempotency_conflict','Request ID already used');return prior;}
   if((await client.query("SELECT 1 FROM live_vault_transactions WHERE vault_id=$1 AND kind='EXIT' AND status IN ('PREPARED','SUBMITTED')",[vault.id])).rowCount)throw new ApiFault(409,'pending_exit','Recover the pending withdrawal first');
   const prepared=await c.prepareExit(vault.wallet,vault.fund_address);
   const result=(await client.query<Row>(`INSERT INTO live_vault_transactions(id,user_id,client_request_id,request_hash,vault_id,kind,input_asset,input_raw,status,unsigned_transaction,last_valid_block_height,fees)
    VALUES($1,$2,$3,$4,$5,'EXIT','SHARES',$6,'PREPARED',$7,$8,$9) RETURNING *`,[randomUUID(),actor.id,req.body.clientRequestId,hash,vault.id,prepared.sharesRaw,prepared.transaction,prepared.lastValidBlockHeight,prepared.fees])).rows[0]!;
   return {...result,fund_address:vault.fund_address,seed_usdc_raw:String(vault.seed_usdc_raw),wallet:vault.wallet};
  });reply.header('cache-control','no-store').code(201);return {operation:view(row)};
 });
 app.post<{Params:{id:string};Body:{signedTransaction:string}}>('/v1/live-vault-operations/:id/submit',{schema:{params,body:{type:'object',required:['signedTransaction'],additionalProperties:false,properties:{signedTransaction:{type:'string',maxLength:1644}}}}},async(req,reply)=>{
  const actor=await requireActor(req,db()),c=requireChain();
  const row=await inTransaction(db(),async client=>{
   const row=(await client.query<Row>(`${operationSql} WHERE t.id=$1 AND t.user_id=$2 FOR UPDATE OF t`,[req.params.id,actor.id])).rows[0];
   if(!row)throw new ApiFault(404,'operation_missing','Vault operation not found');
   const signed=c.verifySigned(row.unsigned_transaction,req.body.signedTransaction,row.wallet);
   if(row.signature&&row.signature!==signed.signature)throw new ApiFault(409,'signature_conflict','A different signed transaction is already saved');
   if(row.status!=='PREPARED')return row;
   const observed=await c.observe(row);if(observed==='expired')throw new ApiFault(409,'transaction_expired','The transaction expired. Prepare again.');
   return {...row,...(await client.query<Row>("UPDATE live_vault_transactions SET signed_transaction=$2,signature=$3,status='SUBMITTED',next_check_at=now(),updated_at=now() WHERE id=$1 RETURNING *",[row.id,signed.wire,signed.signature])).rows[0]!};
  });reply.header('cache-control','no-store').code(202);return {operation:view(row)};
 });
}
/** Lease a bounded batch; persist signatures before broadcasting; finalized chain data wins. */
export async function sweepLiveVaults(db:DbPool,chain:LiveChain,onError:(error:unknown)=>void) {
 const rows=(await db.query<Row>(`UPDATE live_vault_transactions SET next_check_at=now()+interval '30 seconds' WHERE id IN
  (SELECT id FROM live_vault_transactions WHERE status IN ('PREPARED','SUBMITTED') AND next_check_at<=now() ORDER BY next_check_at LIMIT 20 FOR UPDATE SKIP LOCKED) RETURNING *`)).rows;
 for(const row of rows)try{
  const status=await chain.observe(row);
  if(status!=='pending')await db.query("UPDATE live_vault_transactions SET status=$2,failure=$3,updated_at=now() WHERE id=$1 AND status IN ('PREPARED','SUBMITTED')",[row.id,status.toUpperCase(),status==='failed'?'transaction_failed':null]);
  else {
   if(row.status==='SUBMITTED'&&row.signed_transaction)await chain.broadcast(row.signed_transaction);
   await db.query("UPDATE live_vault_transactions SET next_check_at=now()+interval '3 seconds' WHERE id=$1 AND status IN ('PREPARED','SUBMITTED')",[row.id]);
  }
 }catch(error){onError(error);}
}
export function startLiveVaultWorker(db:DbPool,chain:LiveChain,onError:(error:unknown)=>void) {
 let busy:Promise<void>|null=null;const tick=()=>{if(!busy)busy=sweepLiveVaults(db,chain,onError).catch(onError).finally(()=>{busy=null;});};
 tick();const timer=setInterval(tick,5000);timer.unref();return async()=>{clearInterval(timer);await busy;};
}
