import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdir,readFile } from 'node:fs/promises';
import pg from 'pg';
import { Keypair,PublicKey,TransactionInstruction,TransactionMessage,VersionedTransaction,SystemProgram,ComputeBudgetProgram } from '@solana/web3.js';
import { createApp } from '../dist/app.js';
import { configurePrivyFixture } from './privy-fixture.mjs';
import { loadSwapConfig } from '../dist/swap-config.js';
import { SWAP_NETWORK as N } from '../dist/swap-types.js';
import { parseVenueQuote,verifySignedSwap,validatePreparedSwap,associatedAccount,TOKEN,ATA,ROUTER } from '../dist/swap-chain.js';
import { sweepWalletSwaps } from '../dist/swap-flows.js';
const wallet=Keypair.generate(),str=wallet.publicKey.toBase58(),poolId=Keypair.generate().publicKey.toBase58();
const config=loadSwapConfig();
function response(patch={}) {return {success:true,data:{swapType:'BaseIn',inputMint:N.solMint,outputMint:N.usdcMint,inputAmount:'1000000',outputAmount:'20000',otherAmountThreshold:'19800',slippageBps:100,priceImpactPct:1,
 routePlan:[{poolId,inputMint:N.solMint,outputMint:N.usdcMint,feeMint:N.solMint,feeAmount:'2500'}],...patch}};}
const quote=()=>parseVenueQuote(response(),'SOL','1000000',config);
const native=associatedAccount(str,N.solMint),usdc=associatedAccount(str,N.usdcMint);
const meta=(key,isSigner=false,isWritable=false)=>({pubkey:new PublicKey(key),isSigner,isWritable});
function instruction() {
 const data=Buffer.alloc(17);data.writeBigUInt64LE(1000000n,1);data.writeBigUInt64LE(19800n,9);
 return new TransactionInstruction({programId:new PublicKey(ROUTER),data,keys:[meta(TOKEN),meta('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'),meta(ATA),meta(SystemProgram.programId),meta(str,true,true),meta(native,false,true),meta(usdc,false,true),
 meta('DRaycpLY18LhpbydsBWbVJtxpNv9oXPgjRSfpF2bWpYb'),meta(usdc,false,true),meta(N.solMint),meta(N.usdcMint),meta(Keypair.generate().publicKey),meta(Keypair.generate().publicKey),meta(poolId,false,true),meta(Keypair.generate().publicKey,false,true),meta(Keypair.generate().publicKey,false,true),meta(Keypair.generate().publicKey,false,true)]});
}
function transaction(instructions=[instruction()]) {
 const close=new TransactionInstruction({programId:new PublicKey(ROUTER),data:Buffer.from([6]),keys:[meta(str,true,true),meta(native,false,true),meta(str,true,true),meta(TOKEN),meta(ATA),meta(SystemProgram.programId)]});
 instructions=[...instructions,close];return new VersionedTransaction(new TransactionMessage({payerKey:wallet.publicKey,recentBlockhash:N.solMint,instructions}).compileToV0Message());}
const wire=tx=>Buffer.from(tx.serialize()).toString('base64');
test('server quote parser enforces mint, amounts, route continuity, impact and slippage; costs stay separate',()=>{
 assert.equal(quote().venueFees[0].amountRaw,'2500');
 for(const patch of [{priceImpactPct:6},{inputMint:N.usdcMint},{inputAmount:'2'},{otherAmountThreshold:'1'},{slippageBps:1000},{outputAmount:'18446744073709551616'},{routePlan:[{poolId,inputMint:N.usdcMint,outputMint:N.solMint}]}])assert.throws(()=>parseVenueQuote(response(patch),'SOL','1000000',config));
 assert.equal(parseVenueQuote(response({routePlan:[{poolId,inputMint:N.solMint,outputMint:N.usdcMint}]}),'SOL','1000000',config).venueFees,null);
});
test('prepared transactions reject unsafe amounts, recipients, approvals, transfers, fee settings and programs',async()=>{
 await validatePreparedSwap(transaction(),str,quote(),{},config);
 const badAmount=instruction();badAmount.data.writeBigUInt64LE(2n,1);
 const badMin=instruction();badMin.data.writeBigUInt64LE(1n,9);
 const badRecipient=instruction();badRecipient.keys[6]=meta(Keypair.generate().publicKey,false,true);
 const approval=new TransactionInstruction({programId:TOKEN,keys:[meta(native)],data:Buffer.from([4])});
 for(const ins of [[badAmount],[badMin],[badRecipient],[instruction(),approval],[instruction(),SystemProgram.transfer({fromPubkey:wallet.publicKey,toPubkey:Keypair.generate().publicKey,lamports:100})],
  [instruction(),ComputeBudgetProgram.setComputeUnitPrice({microLamports:1000001})],
  [instruction(),new TransactionInstruction({programId:Keypair.generate().publicKey,keys:[],data:Buffer.alloc(0)})]])await assert.rejects(validatePreparedSwap(transaction(ins),str,quote(),{},config));
});
test('signed transaction requires a cryptographically valid wallet signature and exact prepared message',()=>{
 const unsigned=transaction(),signed=VersionedTransaction.deserialize(unsigned.serialize());signed.sign([wallet]);
 assert.ok(verifySignedSwap(wire(unsigned),wire(signed),str).signature);
 assert.throws(()=>verifySignedSwap(wire(unsigned),wire(unsigned),str));
 signed.signatures[0][0]^=1;assert.throws(()=>verifySignedSwap(wire(unsigned),wire(signed),str));
 signed.message.recentBlockhash=Keypair.generate().publicKey.toBase58();signed.sign([wallet]);assert.throws(()=>verifySignedSwap(wire(unsigned),wire(signed),str));
});
test('wallet swap API persists before broadcasting, recovers retries, isolates ownership and leaves paper accounting untouched',{timeout:120000},async t=>{
 const connectionString=process.env.TEST_DATABASE_URL;assert.ok(connectionString,'TEST_DATABASE_URL is required');assert.match(new URL(connectionString).hostname,/^(localhost|127\.0\.0\.1|\[::1\])$/);
 delete process.env.USDG_MINT;process.env.NODE_ENV='development';process.env.PRIVY_APP_SECRET='fixture';
 const tokenFor=configurePrivyFixture(),fixtureFetch=globalThis.fetch;
 globalThis.fetch=async(input,opts)=>String(input).startsWith('https://api.privy.io/v1/users/')?Response.json({linked_accounts:[{type:'wallet',chain_type:'solana',address:str}]}):fixtureFetch(input,opts);
 const schema=`swap_test_${randomUUID().replaceAll('-','')}`,admin=new pg.Pool({connectionString});await admin.query(`CREATE SCHEMA ${schema}`);
 const db=new pg.Pool({connectionString,options:`-c search_path=${schema}`});
 let builds=0,sends=0,outcome={status:'pending'};
 const chain={quote:async()=>quote(),prepare:async()=>{builds++;return {transaction:wire(transaction()),blockhash:N.solMint,lastValidBlockHeight:100,fees:{networkFeeLamports:'5000',priorityFeeLamports:'0',accountRentLamports:'0'}};},verifySigned:verifySignedSwap,
 observe:async()=>outcome,broadcast:async bytes=>{sends++;assert.ok((await db.query('SELECT 1 FROM wallet_swaps WHERE signed_transaction=$1 AND signature IS NOT NULL',[bytes])).rowCount);throw new Error('lost RPC reply');}};
 const app=createApp(db,{swaps:{config,chain},swapWorker:false});app.log.level='silent';
 const call=async(method,url,body,status=200,user='owner')=>{const r=await app.inject({method,url,payload:body,headers:user?{authorization:`Bearer ${tokenFor(user)}`}:{}});assert.equal(r.statusCode,status,r.body);return r.json();};
 try {
  const dir=new URL('../../../packages/db/migrations/',import.meta.url);for(const file of(await readdir(dir)).filter(f=>f.endsWith('.sql')).sort())await db.query(await readFile(new URL(file,dir),'utf8'));
  await call('GET','/v1/me/swaps',undefined,401,null);
  await call('GET','/v0/me');await call('GET','/v0/me',undefined,200,'stranger');
  const accounting=async()=>({cash:(await db.query('SELECT id,paper_cash::text FROM users ORDER BY id')).rows,ledger:(await db.query('SELECT count(*)::text AS n FROM ledger_entries')).rows});
  const before=await accounting();
  await call('POST','/v1/me/swaps/quotes',{wallet:Keypair.generate().publicKey.toBase58(),input:'SOL',amountRaw:'1000000'},403);
  await call('POST','/v1/me/swaps/quotes',{wallet:str,input:'SOL',amountRaw:'18446744073709551616'},400);
  const q=(await call('POST','/v1/me/swaps/quotes',{wallet:str,input:'SOL',amountRaw:'1000000'},201)).quote;
  const body={quoteId:q.id,clientRequestId:randomUUID()};
  const [a,b]=await Promise.all([call('POST','/v1/me/swaps',body,201),call('POST','/v1/me/swaps',body,201)]);assert.equal(a.swap.id,b.swap.id);assert.equal(builds,1);
  await call('POST','/v1/me/swaps',{...body,quoteId:randomUUID()},409);
  await call('POST','/v1/me/swaps',{...body,clientRequestId:randomUUID()},409);
  await call('GET',`/v1/me/swaps/${a.swap.id}`,undefined,404,'stranger');
  const signed=VersionedTransaction.deserialize(Buffer.from(a.swap.transaction,'base64'));signed.sign([wallet]);
  // The quote timer may expire while wallet approval is open. The prepared blockhash is authoritative now.
  await db.query("UPDATE wallet_swap_quotes SET expires_at=now()-interval '1 minute'");
  await call('POST',`/v1/me/swaps/${a.swap.id}/submit`,{signedTransaction:a.swap.transaction},422);
  const submitted=(await call('POST',`/v1/me/swaps/${a.swap.id}/submit`,{signedTransaction:wire(signed)},202)).swap;assert.equal(submitted.status,'SUBMITTED');assert.equal(sends,0);
  await sweepWalletSwaps(db,chain,e=>{throw e;});assert.equal(sends,1);
  await call('POST',`/v1/me/swaps/${a.swap.id}/submit`,{signedTransaction:wire(signed)},202);
  outcome={status:'confirmed',filledOutputRaw:'20001',networkFeeLamports:'5000'};
  await db.query('UPDATE wallet_swaps SET next_check_at=now()');await sweepWalletSwaps(db,chain,e=>{throw e;});
  const confirmed=(await call('GET',`/v1/me/swaps/${a.swap.id}`)).swap;assert.equal(confirmed.status,'CONFIRMED');assert.equal(confirmed.filledOutputRaw,'20001');
  await call('POST',`/v1/me/swaps/${a.swap.id}/submit`,{signedTransaction:wire(signed)},200);
  // A signature is claimed globally, even if another intent contains the same message.
  chain.prepare=async()=>({transaction:a.swap.transaction,blockhash:N.solMint,lastValidBlockHeight:100,fees:{networkFeeLamports:'5000',priorityFeeLamports:'0',accountRentLamports:'0'}});
  const duplicateQuote=(await call('POST','/v1/me/swaps/quotes',{wallet:str,input:'SOL',amountRaw:'1000000'},201)).quote;
  const duplicate=(await call('POST','/v1/me/swaps',{quoteId:duplicateQuote.id,clientRequestId:randomUUID()},201)).swap;
  await call('POST',`/v1/me/swaps/${duplicate.id}/submit`,{signedTransaction:wire(signed)},409);
  assert.deepEqual(await accounting(),before);
  assert.equal((await call('GET','/v1/me/swaps?status=CONFIRMED&limit=1')).swaps.length,1);
  assert.equal((await call('GET','/v1/me/swaps',undefined,200,'stranger')).swaps.length,0);
  const expiredQuote=(await call('POST','/v1/me/swaps/quotes',{wallet:str,input:'SOL',amountRaw:'1000000'},201)).quote;
  await db.query("UPDATE wallet_swap_quotes SET expires_at=now()-interval '1 minute' WHERE id=$1",[expiredQuote.id]);
  await call('POST','/v1/me/swaps',{quoteId:expiredQuote.id,clientRequestId:randomUUID()},409);
  // Reservation caps include upstream failures; no venue calls after the limit.
  await db.query("INSERT INTO wallet_swap_requests(user_id,kind) SELECT user_id,'quote' FROM wallet_swap_quotes LIMIT 1");
  const rateApp=createApp(new pg.Pool({connectionString,options:`-c search_path=${schema}`}),{swaps:{config:{...config,quotesPerHour:1},chain},swapWorker:false});rateApp.log.level='silent';
  const r=await rateApp.inject({method:'POST',url:'/v1/me/swaps/quotes',headers:{authorization:`Bearer ${tokenFor('owner')}`},payload:{wallet:str,input:'SOL',amountRaw:'1000000'}});assert.equal(r.statusCode,429);await rateApp.close();
 }finally{await app.close();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();globalThis.fetch=fixtureFetch;}
});

test('backend simulation checks both swap directions, exact debits, output and fee ceilings',async()=>{
 const {RaydiumSwapChain}=await import('../dist/swap-chain.js');
 const chain=new RaydiumSwapChain(config);let direction='SOL',badOutput=false,badFee=false;
 function tokenData(amount){const data=Buffer.alloc(165);new PublicKey(N.usdcMint).toBuffer().copy(data);wallet.publicKey.toBuffer().copy(data,32);data.writeBigUInt64LE(amount,64);return data;}
 const tokenAccount=amount=>({owner:TOKEN,data:tokenData(amount),lamports:2039280});
 const q=()=>parseVenueQuote(response(direction==='SOL'?{}:{inputMint:N.usdcMint,outputMint:N.solMint,outputAmount:'500000',otherAmountThreshold:'495000',routePlan:[{poolId,inputMint:N.usdcMint,outputMint:N.solMint}]}),direction,'1000000',config);
 const makeTx=()=>{
  const i=instruction();
  if(direction==='USDC'){[i.keys[5],i.keys[6]]=[i.keys[6],i.keys[5]];i.keys[8]=meta(native,false,true);[i.keys[9],i.keys[10]]=[i.keys[10],i.keys[9]];i.data.writeBigUInt64LE(495000n,9);}
  return transaction([i]);
 };
 chain.venue=async()=>({success:true,data:[{transaction:wire(makeTx())}]});
 chain.connection={getGenesisHash:async()=>N.genesisHash,getLatestBlockhash:async()=>({blockhash:N.solMint,lastValidBlockHeight:100}),
  getTokenAccountsByOwner:async()=>({value:[{pubkey:usdc,account:tokenAccount(2500000n)}]}),
  getMultipleAccountsInfo:async addresses=>addresses.map(a=>a.toBase58()===str?{owner:SystemProgram.programId,data:Buffer.alloc(0),lamports:1000000000}:a.equals(usdc)?tokenAccount(2500000n):null),
  getFeeForMessage:async()=>({value:badFee?1000001:5000}),
  simulateTransaction:async(_,options)=>({value:{err:null,accounts:options.accounts.addresses.map(a=>a===str?{owner:SystemProgram.programId.toBase58(),data:['','base64'],lamports:direction==='SOL'?998995000:1000495000}:a===usdc.toBase58()?{owner:TOKEN.toBase58(),data:[tokenData(badOutput?0n:direction==='SOL'?2520000n:1500000n).toString('base64'),'base64'],lamports:2039280}:null)}}),
 };
 for(direction of ['SOL','USDC']){assert.equal((await chain.prepare(q(),str)).fees.networkFeeLamports,'5000');badOutput=true;await assert.rejects(chain.prepare(q(),str),/Simulation differs/);badOutput=false;}
 badFee=true;await assert.rejects(chain.prepare(q(),str),/Network fee/);
});

test('finalized receipts bind the exact message, actual output and network fee; expiry never overrides a landed transaction',async()=>{
 const {RaydiumSwapChain}=await import('../dist/swap-chain.js');const chain=new RaydiumSwapChain(config),tx=transaction();
 const keys=tx.message.staticAccountKeys,ownerIndex=keys.findIndex(k=>k.toBase58()===str),tokenIndex=keys.findIndex(k=>k.equals(usdc));
 const pre=keys.map(()=>0),post=keys.map(()=>0);pre[ownerIndex]=1000000000;post[ownerIndex]=998995000;
 let status={confirmationStatus:'finalized',err:null},height=101,altered=false;
 const tokens=amount=>[{accountIndex:tokenIndex,mint:N.usdcMint,owner:str,uiTokenAmount:{amount,decimals:6,uiAmount:null}}];
 chain.connection={getGenesisHash:async()=>N.genesisHash,getSignatureStatuses:async()=>({value:[status]}),getBlockHeight:async()=>height,
  getTransaction:async()=>({transaction:{message:altered?transaction([instruction(),ComputeBudgetProgram.setComputeUnitLimit({units:200000})]).message:tx.message},meta:{err:null,fee:5000,preBalances:pre,postBalances:post,preTokenBalances:tokens('2500000'),postTokenBalances:tokens('2520000')}})};
 const args={signature:'signature',unsigned:wire(tx),quote:quote(),wallet:str,lastValidBlockHeight:100};
 assert.deepEqual(await chain.observe(args),{status:'confirmed',filledOutputRaw:'20000',networkFeeLamports:'5000'});
 altered=true;assert.equal((await chain.observe(args)).failure,'transaction_mismatch');altered=false;
 status={confirmationStatus:'confirmed',err:null};assert.equal((await chain.observe(args)).status,'pending');
 status=null;assert.equal((await chain.observe(args)).status,'expired');height=99;assert.equal((await chain.observe(args)).status,'pending');
 status={confirmationStatus:'finalized',err:{InstructionError:[0,'failure']}};assert.equal((await chain.observe(args)).status,'failed');
});

test('swap config uses SOLANA_RPC_URL and rejects invalid server limits',()=>{
 const names=['SOLANA_RPC_URL','DEVNET_RPC_URL','SWAP_RPC_URL','SWAP_SLIPPAGE_BPS','SWAP_ENABLED','SWAP_QUOTES_PER_HOUR'],saved=Object.fromEntries(names.map(n=>[n,process.env[n]]));
 try {
  process.env.SOLANA_RPC_URL='https://canonical-devnet-rpc.example';process.env.DEVNET_RPC_URL='https://other-devnet-rpc.example';process.env.SWAP_RPC_URL='https://unused-rpc.example';
  assert.equal(loadSwapConfig().rpcUrl,'https://canonical-devnet-rpc.example');
  delete process.env.SWAP_QUOTES_PER_HOUR;assert.equal(loadSwapConfig().quotesPerHour,1800);
  process.env.SWAP_QUOTES_PER_HOUR='240';assert.equal(loadSwapConfig().quotesPerHour,240);
  process.env.SWAP_QUOTES_PER_HOUR='10001';assert.throws(()=>loadSwapConfig(),/SWAP_QUOTES_PER_HOUR/);delete process.env.SWAP_QUOTES_PER_HOUR;
  process.env.SWAP_SLIPPAGE_BPS='101';assert.throws(()=>loadSwapConfig(),/SWAP_SLIPPAGE_BPS/);delete process.env.SWAP_SLIPPAGE_BPS;
  process.env.SOLANA_RPC_URL='http://insecure.example';assert.throws(()=>loadSwapConfig(),/HTTPS/);
  process.env.SWAP_ENABLED='false';assert.equal(loadSwapConfig(),null);
 }finally{for(const n of names){if(saved[n]===undefined)delete process.env[n];else process.env[n]=saved[n];}}
});
