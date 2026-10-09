import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash,randomUUID } from 'node:crypto';
import { readdir,readFile } from 'node:fs/promises';
import pg from 'pg';
import { Keypair,TransactionMessage,VersionedTransaction,SystemProgram } from '@solana/web3.js';
import { createApp } from '../dist/app.js';
import { configurePrivyFixture } from './privy-fixture.mjs';
import { createFundInstruction,fundAddresses,readFund,LIVE_PROGRAM,SEED_MINIMUM,SolanaLiveVaultChain } from '../dist/live-vault-chain.js';
import { verifySignedSwap,associatedAccount,TOKEN } from '../dist/swap-chain.js';
import { sweepLiveVaults } from '../dist/live-vault-routes.js';
import { SWAP_NETWORK as N } from '../dist/swap-types.js';
const wallet=Keypair.generate(),address=wallet.publicKey.toBase58();
const wire=tx=>Buffer.from(tx.serialize()).toString('base64');
function transaction(number=7n){return new VersionedTransaction(new TransactionMessage({payerKey:wallet.publicKey,recentBlockhash:N.solMint,instructions:[createFundInstruction(address,number,SEED_MINIMUM)]}).compileToV0Message());}
test('create instruction matches Anchor account order, dollar minimum and PDA seeds',()=>{
 const ix=createFundInstruction(address,7n,100000000n),a=fundAddresses(address,7n);
 assert.equal(ix.programId.toBase58(),LIVE_PROGRAM.toBase58());assert.equal(ix.keys.length,14);
 assert.equal(ix.keys[0].pubkey.toBase58(),address);assert.ok(ix.keys[0].isSigner);
 assert.equal(ix.keys[2].pubkey.toBase58(),a.fund.toBase58());assert.equal(ix.keys[8].pubkey.toBase58(),a.vault.toBase58());
 assert.equal(ix.data.readBigUInt64LE(8),7n);assert.equal(ix.data.readBigUInt64LE(16),100000000n);assert.equal(ix.data[24],0);
 assert.throws(()=>createFundInstruction(address,7n,99999999n));
 assert.notEqual(fundAddresses(address,8n).fund.toBase58(),a.fund.toBase58());
 const data=Buffer.alloc(353);createHash('sha256').update('account:Fund').digest().copy(data,0,0,8);wallet.publicKey.toBuffer().copy(data,8);data.writeBigUInt64LE(7n,40);a.shares.toBuffer().copy(data,48);wallet.publicKey.toBuffer().copy(data,80);data[336]=1;data.writeBigUInt64LE(100000000n,337);
 const decoded=readFund(data);assert.equal(decoded.supply,100000000n);assert.equal(decoded.number,7n);assert.equal(decoded.holdings.length,1);
 data[336]=9;assert.throws(()=>readFund(data));
});
test('funding is one transaction, accepts split wallet USDC and refuses SOL routes below the guaranteed seed',async()=>{
 const canonical=associatedAccount(address,N.usdcMint),other=Keypair.generate().publicKey;
 const account=(pubkey,amount)=>{const data=Buffer.alloc(165);data.set(new (wallet.publicKey.constructor)(N.usdcMint).toBuffer(),0);data.set(wallet.publicKey.toBuffer(),32);data.writeBigUInt64LE(amount,64);return {pubkey,account:{owner:TOKEN,data}};};
 let accounts=[account(other,100000000n)],minimum='100000000',prepared=0;
 const swapTx=new VersionedTransaction(new TransactionMessage({payerKey:wallet.publicKey,recentBlockhash:N.solMint,instructions:[SystemProgram.transfer({fromPubkey:wallet.publicKey,toPubkey:wallet.publicKey,lamports:1})]}).compileToV0Message());
 const chain=new SolanaLiveVaultChain('https://api.devnet.solana.com',{quote:async()=>({minimumOutput:minimum}),prepare:async()=>{prepared++;return {transaction:wire(swapTx),fees:{priorityFeeLamports:'0'}};}},true);
 chain.readiness=async()=>({enabled:true,reason:null});
 chain.connection={getTokenAccountsByOwner:async()=>({value:accounts}),getLatestBlockhash:async()=>({blockhash:N.solMint,lastValidBlockHeight:100}),getMultipleAccountsInfo:async keys=>keys.map((_,i)=>i===0?{lamports:3000000000}:null),simulateTransaction:async(tx,opts)=>({value:{err:null,accounts:opts.accounts.addresses.map(()=>null)}}),getFeeForMessage:async()=>({value:5000})};
 const instructions=prepared=>TransactionMessage.decompile(VersionedTransaction.deserialize(Buffer.from(prepared.transaction,'base64')).message).instructions;
 let built=await chain.prepare(address,'USDC','100000000');let ins=instructions(built);assert.equal(ins.at(-1).keys[7].pubkey.toBase58(),other.toBase58());assert.equal(ins.filter(i=>i.programId.equals(LIVE_PROGRAM)).length,1);
 accounts=[account(canonical,30000000n),account(other,70000000n)];built=await chain.prepare(address,'USDC','100000000');ins=instructions(built);const transfer=ins.find(i=>i.programId.equals(TOKEN));assert.equal(transfer.data.readBigUInt64LE(1),70000000n);assert.equal(ins.at(-1).keys[7].pubkey.toBase58(),canonical.toBase58());
 accounts=[account(other,99999999n)];await assert.rejects(chain.prepare(address,'USDC','100000000'),/Not enough wallet USDC/);
 minimum='99999999';await assert.rejects(chain.prepare(address,'SOL','1000000000'),/minimum/);assert.equal(prepared,0);
 minimum='100000000';built=await chain.prepare(address,'SOL','1000000000');ins=instructions(built);assert.equal(ins.filter(i=>i.programId.equals(SystemProgram.programId)).length,1);assert.ok(ins.at(-1).programId.equals(LIVE_PROGRAM));assert.equal(built.seedRaw,'100000000');assert.equal(prepared,1);
});
test('real vault routes persist before broadcast, recover ambiguous sends, isolate owners and never credit paper cash',{timeout:120000},async()=>{
 const connectionString=process.env.TEST_DATABASE_URL;assert.ok(connectionString,'TEST_DATABASE_URL must point to local PostgreSQL');assert.match(new URL(connectionString).hostname,/^(localhost|127\.0\.0\.1|\[::1\])$/);
 delete process.env.USDG_MINT;process.env.PRIVY_APP_SECRET='fixture';const tokenFor=configurePrivyFixture(),fixtureFetch=globalThis.fetch;
 globalThis.fetch=async(input,options)=>String(input).startsWith('https://api.privy.io/v1/users/')?Response.json({linked_accounts:[{type:'wallet',chain_type:'solana',address}]}):fixtureFetch(input,options);
 const schema=`live_vault_test_${randomUUID().replaceAll('-','')}`,admin=new pg.Pool({connectionString});await admin.query(`CREATE SCHEMA ${schema}`);
 const db=new pg.Pool({connectionString,options:`-c search_path=${schema}`});let prepared=0,broadcasts=0,status='pending',enabled=true;
 const chain={readiness:async()=>({enabled,reason:enabled?null:'vault_program_not_deployed'}),prepare:async(wallet,asset,raw)=>{assert.equal(wallet,address);assert.ok(['SOL','USDC'].includes(asset));prepared++;if(!enabled)throw Error('not deployed');const number=BigInt(prepared),a=fundAddresses(wallet,number);return {transaction:wire(transaction(number)),number:number.toString(),fund:a.fund.toBase58(),shares:a.shares.toBase58(),seedRaw:'100000000',blockhash:N.solMint,lastValidBlockHeight:100,fees:{networkFeeLamports:'5000',priorityFeeLamports:'0',accountRentLamports:'4000000'}};},
  prepareExit:async()=>({transaction:wire(transaction(9n)),sharesRaw:'100000000',lastValidBlockHeight:100,blockhash:N.solMint,fees:{networkFeeLamports:'5000',priorityFeeLamports:'0',accountRentLamports:'0'}}),verifySigned:verifySignedSwap,observe:async()=>status,
  broadcast:async bytes=>{assert.ok((await db.query('SELECT 1 FROM live_vault_transactions WHERE signed_transaction=$1 AND status=\'SUBMITTED\'',[bytes])).rowCount);broadcasts++;throw Error('lost RPC acknowledgement');},holdings:async()=>({sharesRaw:'100000000',holdings:[{mint:N.usdcMint,amountRaw:'100000000'}]})};
 const app=createApp(db,{liveVaults:chain,liveVaultWorker:false});app.log.level='silent';
 const call=async(method,url,payload,expected=200,user='owner')=>{const r=await app.inject({method,url,payload,headers:user?{authorization:`Bearer ${tokenFor(user)}`}:{}});assert.equal(r.statusCode,expected,r.body);return r.json();};
 try{
  const dir=new URL('../../../packages/db/migrations/',import.meta.url);for(const file of(await readdir(dir)).filter(f=>f.endsWith('.sql')).sort())await db.query(await readFile(new URL(file,dir),'utf8'));
  await call('GET','/v0/me');await call('GET','/v0/me',undefined,200,'stranger');
  await db.query("UPDATE users SET role='captain',username='captainowner' WHERE auth_subject='did:privy:owner'");
  const paper=async()=>JSON.stringify({cash:(await db.query('SELECT id,paper_cash::text FROM users ORDER BY id')).rows,ledger:(await db.query('SELECT count(*)::text AS n FROM ledger_entries')).rows,funds:(await db.query('SELECT count(*)::text AS n FROM funds')).rows});const before=await paper();
  const body={clientRequestId:randomUUID(),wallet:address,asset:'SOL',amountRaw:'1000000000',name:'Harbor growth',description:'Test vault'};
  await call('POST','/v1/live-vaults',body,401,null);await call('POST','/v1/live-vaults',body,403,'stranger');
  await call('POST','/v1/live-vaults',{...body,wallet:Keypair.generate().publicKey.toBase58()},403);
  const [a,b]=await Promise.all([call('POST','/v1/live-vaults',body,201),call('POST','/v1/live-vaults',body,201)]);assert.equal(a.operation.id,b.operation.id);assert.equal(prepared,1);assert.equal(a.operation.wallet,address);assert.equal(a.operation.seedUsdcRaw,'100000000');
  await call('POST','/v1/live-vaults',{...body,name:'Changed'},409);
  await call('GET',`/v1/me/live-vault-operations?clientRequestId=${body.clientRequestId}`,undefined,404,'stranger');
  assert.equal((await call('GET','/v1/me/live-vault-pending')).operations.length,1);
  assert.equal((await call('GET','/v1/me/live-vaults')).vaults.length,0);
  const path=`/v1/live-vault-operations/${a.operation.id}/submit`;
  await call('POST',path,{signedTransaction:a.operation.transaction},422);
  const tx=VersionedTransaction.deserialize(Buffer.from(a.operation.transaction,'base64'));tx.sign([wallet]);
  await call('POST',path,{signedTransaction:wire(tx)},202);assert.equal(broadcasts,0);
  await sweepLiveVaults(db,chain,()=>{});assert.equal(broadcasts,1);
  await call('POST',path,{signedTransaction:wire(tx)},202);
  status='confirmed';await db.query('UPDATE live_vault_transactions SET next_check_at=now()');await sweepLiveVaults(db,chain,e=>{throw e;});
  const recovered=await call('GET',`/v1/me/live-vault-operations?clientRequestId=${body.clientRequestId}`);assert.equal(recovered.operation.status,'CONFIRMED');assert.equal(recovered.operation.transaction,null);
  assert.equal((await call('GET','/v1/me/live-vaults')).vaults.length,1);
  await call('GET',`/v1/live-vaults/${a.operation.vaultId}`,undefined,404,'stranger');assert.equal((await call('GET',`/v1/live-vaults/${a.operation.vaultId}`)).position.sharesRaw,'100000000');
  enabled=false;assert.equal((await call('GET','/v1/live-vaults/config',undefined,200,null)).reason,'vault_program_not_deployed');
  const exitBody={clientRequestId:randomUUID()},exitPath=`/v1/live-vaults/${a.operation.vaultId}/exits`;
  const exit=await call('POST',exitPath,exitBody,201);assert.equal(exit.operation.kind,'EXIT');assert.equal((await call('POST',exitPath,exitBody,201)).operation.id,exit.operation.id);
  assert.equal(await paper(),before);
 }finally{await app.close();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
});
