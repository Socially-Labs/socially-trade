import { randomUUID } from 'node:crypto';
import { Connection, PublicKey, type ParsedTransactionWithMeta } from '@solana/web3.js';
import { inTransaction, type DbPool, type DbClient } from '@socially/db';
import type { FastifyInstance } from 'fastify';
import { requireActor } from './auth.js';
import { privySolanaWallets } from './privy.js';
import { ApiFault } from './errors.js';
import { SWAP_NETWORK } from './swap-types.js';

type Receipt={index:string;token:'SOL'|'USDC';amountAtomic:string;decimals:number;slot:number};
/** Transfers only: never infer a deposit from a balance change or trust client amounts. */
export function incomingWalletTransfers(tx:ParsedTransactionWithMeta,address:string):Receipt[]{
 if(!tx.meta || tx.meta.err || tx.transaction.message.accountKeys.some(k=>k.signer&&k.pubkey.toBase58()===address))return [];
 const owners=new Map<number,{owner?:string;mint:string}>();
 for(const balance of [...tx.meta.preTokenBalances??[],...tx.meta.postTokenBalances??[]])owners.set(balance.accountIndex,balance);
 const account=(pubkey:string)=>{const index=tx.transaction.message.accountKeys.findIndex(k=>k.pubkey.toBase58()===pubkey);return owners.get(index);};
 const instructions=tx.transaction.message.instructions.flatMap((instruction,index)=>[
  {instruction,index:`${index}`},...(tx.meta!.innerInstructions?.find(i=>i.index===index)?.instructions??[]).map((instruction,inner)=>({instruction,index:`${index}.${inner}`})),
 ]);
 const receipts:Receipt[]=[];
 for(const {instruction,index}of instructions){
  if(!('parsed' in instruction))continue;
  const parsed=instruction.parsed as {type?:string;info?:Record<string,unknown>},info=parsed.info;
  if(!info || !['transfer','transferChecked'].includes(parsed.type??''))continue;
  if(instruction.program==='system' && instruction.programId.toBase58()==='11111111111111111111111111111111' && info.destination===address && info.source!==address && Number.isSafeInteger(info.lamports) && Number(info.lamports)>0){
   receipts.push({index,token:'SOL',amountAtomic:String(info.lamports),decimals:9,slot:tx.slot});
  }else if(instruction.program==='spl-token' && instruction.programId.toBase58()==='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' && typeof info.destination==='string'){
   const destination=account(info.destination),source=typeof info.source==='string'?account(info.source):undefined;
   const amount=parsed.type==='transferChecked'?(info.tokenAmount as {amount?:unknown;decimals?:unknown}|undefined)?.amount:info.amount;
   if(destination?.owner!==address || destination.mint!==SWAP_NETWORK.usdcMint || source?.owner===address || info.authority===address || typeof amount!=='string' || !/^\d{1,20}$/.test(amount) || BigInt(amount)<=0n)continue;
   if(parsed.type==='transferChecked' && (info.mint!==SWAP_NETWORK.usdcMint || (info.tokenAmount as {decimals?:unknown})?.decimals!==6))continue;
   receipts.push({index,token:'USDC',amountAtomic:amount,decimals:6,slot:tx.slot});
  }
 }
 return receipts;
}
export function walletNotificationConnection(){return new Connection(process.env.SOLANA_RPC_URL??process.env.DEVNET_RPC_URL??'https://api.devnet.solana.com',{commitment:'finalized',...(process.env.SOLANA_WS_URL?{wsEndpoint:process.env.SOLANA_WS_URL}:{}),disableRetryOnRateLimit:true,fetch:(url,init)=>fetch(url,{...init,signal:AbortSignal.timeout(10000)})});}
export function registerWalletNotifications(app:FastifyInstance,db:()=>DbPool){
 app.get('/v0/me/wallet-notifications',async(request,reply)=>{
  reply.header('cache-control','no-store');
  const actor=await requireActor(request,db());
  const watch=(await db().query(`SELECT w.address,max(a.updated_at) AS last_scan_at,count(a.address)::int AS addresses
    FROM wallet_notification_watches w LEFT JOIN wallet_notification_addresses a USING(user_id)
    WHERE w.user_id=$1 GROUP BY w.user_id`,[actor.id])).rows[0];
  return {enabled:process.env.WALLET_NOTIFICATIONS_ENABLED==='true',watching:!!watch,network:'devnet',address:watch?.address??null,lastScanAt:watch?.last_scan_at?.toISOString()??null};
 });
 app.put<{Body:{address?:unknown}}>('/v0/me/wallet-notifications',async request=>{
  const actor=await requireActor(request,db());
  if(process.env.WALLET_NOTIFICATIONS_ENABLED!=='true')throw new ApiFault(503,'wallet_notifications_disabled','Wallet notifications are not enabled');
  const address=request.body?.address;
  if(typeof address!=='string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address))throw new ApiFault(400,'invalid_wallet','Valid wallet required');
  const wallets=await privySolanaWallets(actor.subject);
  if(!wallets)throw new ApiFault(503,'wallet_verification_unavailable','Wallet ownership could not be verified');
  if(!wallets.includes(address))throw new ApiFault(403,'wallet_not_owned','Use your linked wallet');
  const connection=walletNotificationConnection();
  if(await connection.getGenesisHash()!==SWAP_NETWORK.genesisHash)throw new ApiFault(503,'wrong_cluster','Wallet notifications require devnet');
  const tokenProgram=new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
  const ata=PublicKey.findProgramAddressSync([new PublicKey(address).toBuffer(),tokenProgram.toBuffer(),new PublicKey(SWAP_NETWORK.usdcMint).toBuffer()],new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'))[0].toBase58();
  const existingTokens=await connection.getParsedTokenAccountsByOwner(new PublicKey(address),{mint:new PublicKey(SWAP_NETWORK.usdcMint)},'finalized');
  const addresses=[...new Set([address,ata,...existingTokens.value.map(a=>a.pubkey.toBase58())])];
  if(addresses.length>32)throw new ApiFault(422,'wallet_scan_budget','Wallet has too many token accounts for this observer');
  const baselines=await Promise.all(addresses.map(async address=>({address,signature:(await connection.getSignaturesForAddress(new PublicKey(address),{limit:1},'finalized'))[0]?.signature??null})));
  await inTransaction(db(),async client=>{
    const prior=(await client.query('SELECT address FROM wallet_notification_watches WHERE user_id=$1 FOR UPDATE',[actor.id])).rows[0];
    if(prior && prior.address!==address)await client.query('DELETE FROM wallet_notification_addresses WHERE user_id=$1',[actor.id]);
    await client.query(`INSERT INTO wallet_notification_watches(user_id,address,network,initialized) VALUES($1,$2,'devnet',true)
      ON CONFLICT(user_id) DO UPDATE SET address=EXCLUDED.address,updated_at=now()`,[actor.id,address]);
    for(const item of baselines)await client.query(`INSERT INTO wallet_notification_addresses(user_id,address,last_signature) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,[actor.id,item.address,item.signature]);
    await client.query("SELECT pg_notify('wallet_watches_changed','')");
  });
  return {watching:true,network:'devnet'};
 });
}
export async function scanWalletNotifications(pool:DbPool,connection:Connection=walletNotificationConnection(),addresses?:string[]){
 if(await connection.getGenesisHash()!==SWAP_NETWORK.genesisHash)throw new Error('Wallet notifications: wrong genesis hash');
 const watches=(await pool.query<{user_id:string;address:string;wallet:string;last_signature:string|null;backfill_before:string|null;head_signature:string|null}>(`SELECT a.user_id,a.address,a.last_signature,a.backfill_before,a.head_signature,w.address AS wallet FROM wallet_notification_addresses a JOIN wallet_notification_watches w ON w.user_id=a.user_id WHERE ($1::text[] IS NULL OR a.address=ANY($1)) ORDER BY a.updated_at LIMIT 20`,[addresses??null])).rows;
 const errors:unknown[]=[];
 for(const watch of watches){
  try {
  const batch=await connection.getSignaturesForAddress(new PublicKey(watch.address),{limit:50,...(watch.backfill_before?{before:watch.backfill_before}:{}),...(watch.last_signature?{until:watch.last_signature}:{})},'finalized');
  const signatures=batch.map(row=>row.signature),head=watch.head_signature??signatures[0]??watch.last_signature;
  const hasMore=batch.length===50;
  const ordered=[...signatures].reverse();
  const transactions=ordered.length?await connection.getParsedTransactions(ordered,{commitment:'finalized',maxSupportedTransactionVersion:0}):[];
  const receipts:Array<Receipt&{signature:string}>=[];
  for(let index=0;index<ordered.length;index++){
   const tx=transactions[index];
   if(!tx)throw new Error('Finalized transaction unavailable; retain cursor');
   receipts.push(...incomingWalletTransfers(tx,watch.wallet).map(receipt=>({...receipt,signature:ordered[index]!})));
  }
  await inTransaction(pool,async client=>{
   const current=(await client.query('SELECT address,last_signature,backfill_before FROM wallet_notification_addresses WHERE user_id=$1 AND address=$2 FOR UPDATE',[watch.user_id,watch.address])).rows[0];
   if(!current || current.address!==watch.address || current.last_signature!==watch.last_signature || current.backfill_before!==watch.backfill_before)return;
   for(const receipt of receipts){
    const inserted=await client.query(`INSERT INTO wallet_notification_receipts(network,signature,transfer_index,user_id,token,amount_atomic,decimals,slot)
     VALUES('devnet',$1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING RETURNING signature`,[receipt.signature,receipt.index,watch.user_id,receipt.token,receipt.amountAtomic,receipt.decimals,receipt.slot]);
    if(!inserted.rowCount)continue;
    const eventId=randomUUID(),payload={userId:watch.user_id,network:'devnet',wallet:watch.wallet,signature:receipt.signature,transferIndex:receipt.index,token:receipt.token,amountAtomic:receipt.amountAtomic,decimals:receipt.decimals,slot:receipt.slot,commitment:'finalized'};
    await client.query("INSERT INTO fund_events(id,type,payload) VALUES($1,'wallet_received',$2)",[eventId,payload]);
    await client.query("INSERT INTO outbox_events(id,fund_event_id,type,payload) VALUES($1,$2,'wallet_received',$3)",[randomUUID(),eventId,payload]);
   }
   await client.query(`UPDATE wallet_notification_addresses SET last_signature=$2,backfill_before=$4,head_signature=$5,updated_at=now() WHERE user_id=$1 AND address=$3`,[watch.user_id,hasMore?watch.last_signature:head,watch.address,hasMore?signatures.at(-1):null,hasMore?head:null]);
  });
  } catch(error) {
    errors.push(error);
    // A failing account cannot starve every other wallet; its cursor stays intact.
    await pool.query('UPDATE wallet_notification_addresses SET updated_at=now() WHERE user_id=$1 AND address=$2',[watch.user_id,watch.address]);
  }
 }
 if(errors.length)throw new AggregateError(errors,'Wallet notification scans failed; cursors retained');
}
/** One leader owns RPC subscriptions; all API gateways receive private DB hints. */
export function startWalletNotificationScanner(pool:DbPool,onError:(error:unknown)=>void,connection:Connection=walletNotificationConnection()){
 let stopped=false,leader:DbClient|undefined,busy:Promise<void>|undefined,registryBusy=false;
 const subscriptions=new Map<string,{users:Set<string>;ids:number[]}>();
 const dirty=new Set<string>();
 let recovery=true;
 const removeSubscriptions=async()=>{
  const ids=[...subscriptions.values()].flatMap(value=>value.ids);subscriptions.clear();
  await Promise.allSettled(ids.map(id=>connection.removeAccountChangeListener(id)));
 };
 const tick=()=>{
  if(stopped || !leader || busy)return;
  const addresses=recovery?undefined:[...dirty].slice(0,20);
  if(addresses?.length===0)return;
  recovery=false;
  if(addresses)for(const address of addresses)dirty.delete(address);
  busy=scanWalletNotifications(pool,connection,addresses).catch(onError).finally(()=>{
   busy=undefined;
   if(!stopped && dirty.size)queueMicrotask(tick);
  });
 };
 const refreshRegistry=async()=>{
  if(stopped || registryBusy)return;
  registryBusy=true;
  try{
   if(!leader){
    const candidate=await pool.connect();
    candidate.on('error',error=>{
     onError(error);
     if(leader===candidate){leader=undefined;candidate.release(true);void removeSubscriptions();}
    });
    try{
     const lock=await candidate.query<{locked:boolean}>("SELECT pg_try_advisory_lock(hashtext(current_database() || ':' || current_schema()),73192) AS locked");
     if(stopped || !lock.rows[0]?.locked){candidate.release(true);return;}
     if(await connection.getGenesisHash()!==SWAP_NETWORK.genesisHash)throw new Error('Wallet subscriptions require devnet');
     leader=candidate;
     candidate.on('notification',message=>{if(message.channel==='wallet_watches_changed')void refreshRegistry();});
     await candidate.query('LISTEN wallet_watches_changed');
    }catch(error){if(leader===candidate)leader=undefined;candidate.release(true);throw error;}
    recovery=true;
   }
   const rows=(await pool.query<{user_id:string;address:string}>('SELECT user_id,address FROM wallet_notification_addresses')).rows;
   if(stopped || !leader)return;
   const desired=new Map<string,Set<string>>();
   for(const row of rows){let users=desired.get(row.address);if(!users)desired.set(row.address,users=new Set());users.add(row.user_id);}
   for(const [address,value]of subscriptions){
    if(desired.has(address)){value.users=desired.get(address)!;continue;}
    subscriptions.delete(address);
    await Promise.allSettled(value.ids.map(id=>connection.removeAccountChangeListener(id)));
   }
   for(const [address,users]of desired){
    if(subscriptions.has(address))continue;
    const value={users,ids:[] as number[]};subscriptions.set(address,value);
    value.ids.push(connection.onAccountChange(new PublicKey(address),()=>{
     if(stopped || !leader || subscriptions.get(address)!==value)return;
     // This is an invalidation only; clients read balances at confirmed commitment.
     for(const user of value.users)void pool.query("SELECT pg_notify('wallet_balance_changed',$1)",[user]).catch(onError);
    },'confirmed'));
    value.ids.push(connection.onAccountChange(new PublicKey(address),()=>{
     if(stopped || !leader || subscriptions.get(address)!==value)return;
     dirty.add(address);tick();
    },'finalized'));
    // Catch transfers between initial baseline and subscription establishment.
    dirty.add(address);
   }
   tick();
  }catch(error){onError(error);}
  finally{registryBusy=false;}
 };
 const registryTimer=setInterval(()=>{void refreshRegistry();},30000);registryTimer.unref();
 // Recovery preserves durable cursors after RPC disconnects or missed callbacks.
 const recoveryTimer=setInterval(()=>{recovery=true;tick();},15000);recoveryTimer.unref();
 void refreshRegistry();
 return async()=>{
  stopped=true;clearInterval(registryTimer);clearInterval(recoveryTimer);
  while(registryBusy)await new Promise(resolve=>setTimeout(resolve,10));
  await busy;await removeSubscriptions();
  const client=leader;leader=undefined;
  if(client){await client.query('UNLISTEN wallet_watches_changed').catch(()=>undefined);await client.query("SELECT pg_advisory_unlock(hashtext(current_database() || ':' || current_schema()),73192)").catch(()=>undefined);client.release();}
 };
}
