import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { readdir,readFile } from 'node:fs/promises';
import pg from 'pg';
import { Keypair } from '@solana/web3.js';
import { supportedById } from '../../../packages/market-data/dist/catalog.js';
import { snapshotValue,paperOwner } from '../dist/paper-portfolio.js';
import { createApp } from '../dist/app.js';
import { configurePrivyFixture } from './privy-fixture.mjs';
import { advanceVaultRound } from '../../worker/dist/vault-rounds.js';

const marks=(age=0)=>['SOL','USDC'].map(symbol=>({instrumentId:symbol,mint:supportedById.get(symbol).mint,status:'CURRENT',priceUsd:symbol==='SOL'?'100':'1',sourceAt:new Date(Date.now()-age).toISOString(),receivedAt:new Date(Date.now()-age).toISOString()}));
test('snapshot values both assets exactly and rejects partial, stale or mismatched valuations',()=>{
 const balance={solLamports:'5600000000',usdcRaw:'40000000',slot:10};
 assert.equal(snapshotValue(balance,marks()).value,'600.000000');
 assert.equal(snapshotValue({...balance,solLamports:'1',usdcRaw:'1'},marks()).value,'0.000001');
 for(const prices of [marks(91000),marks().slice(0,1),marks().map(p=>({...p,mint:'wrong'})),marks().map(p=>({...p,status:'STALE'}))])assert.throws(()=>snapshotValue(balance,prices),/Fresh/);
 assert.equal(snapshotValue({...balance,usdcRaw:'0'},marks().slice(0,1)).value,'560.000000');
 assert.throws(()=>snapshotValue({...balance,solLamports:'0',usdcRaw:'0'},[]),/Add devnet/);
});
test('wallet snapshots, paper vault funding, cancellation and claims remain isolated from redeemable cash',{timeout:120000},async t=>{
 const connectionString=process.env.TEST_DATABASE_URL;assert.ok(connectionString);assert.match(new URL(connectionString).hostname,/^(localhost|127\.0\.0\.1)$/);
 process.env.NODE_ENV='development';process.env.PAPER_WALLET_SNAPSHOT_ENABLED='true';process.env.PAPER_TEST_SKIP_FUNDRAISING='false';process.env.VAULT_PAPER_ENABLED='true';process.env.VAULT_TERMS_APPROVAL='locked-v1-retain-residue';process.env.PRIVY_APP_SECRET='fixture';process.env.USDG_MINT='4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';delete process.env.REDIS_URL;
 const wallets=Object.fromEntries(['captain','crew','stale'].map(s=>[s,Keypair.generate().publicKey.toBase58()]));wallets.duplicate=wallets.captain;
 const originalFetch=globalThis.fetch,tokenFor=configurePrivyFixture(),fixtureFetch=globalThis.fetch;
 globalThis.fetch=async(input,options)=>{if(String(input).startsWith('https://api.privy.io/v1/users/')){const subject=decodeURIComponent(String(input).split('/').at(-1)).replace('did:privy:','');return Response.json({linked_accounts:[{type:'wallet',chain_type:'solana',wallet_client_type:'privy',address:wallets[subject]}]});}return fixtureFetch(input,options);};
 const schema=`paper_snapshot_${randomUUID().replaceAll('-','')}`,admin=new pg.Pool({connectionString});await admin.query(`CREATE SCHEMA ${schema}`);
 const pool=new pg.Pool({connectionString,options:`-c search_path=${schema}`,max:8});let app,reads=0,captain,crew,id;
 const source={read:async()=>{reads++;return {solLamports:'5600000000',usdcRaw:'40000000',slot:10};}};
 const options={token:{chain:{mint:process.env.USDG_MINT},allowUnverifiedWallet:false},paperSnapshotSource:source};
 async function req(method,url,subject,payload,key,status=200){const r=await app.inject({method,url,payload,headers:{...(subject?{authorization:`Bearer ${tokenFor(subject)}`} :{}),...(key?{'idempotency-key':key}:{})}});assert.equal(r.statusCode,status,`${method} ${url}: ${r.body}`);return r.json();}
 async function seedPrices(age=0){for(const [index,price]of marks(age).entries()){const payload={price};await pool.query('INSERT INTO market_events(sequence,id,instrument_id,payload) VALUES($1,$2,$3,$4) ON CONFLICT(sequence) DO UPDATE SET payload=EXCLUDED.payload',[index+1,randomUUID(),price.instrumentId,payload]);await pool.query('INSERT INTO market_latest(instrument_id,sequence,payload) VALUES($1,$2,$3) ON CONFLICT(instrument_id) DO UPDATE SET payload=EXCLUDED.payload',[price.instrumentId,index+1,payload]);}}
 async function cash(user){return (await pool.query('SELECT vault_paper_cash::text AS virtual,paper_cash::text AS redeemable FROM users WHERE id=$1',[user.id])).rows[0];}
 try{
  const dir=new URL('../../../packages/db/migrations/',import.meta.url);for(const file of(await readdir(dir)).filter(f=>f.endsWith('.sql')).sort())await pool.query(await readFile(new URL(file,dir),'utf8'));
  app=createApp(pool,options);app.log.level='silent';await seedPrices();
  captain=await req('GET','/v0/me','captain');crew=await req('GET','/v0/me','crew');await req('POST','/v0/me/onboarding','captain',{username:'paper_captain',role:'captain'});
  await t.test('authentication, ownership, server-only amounts and stale marks',async()=>{
   await req('GET','/v1/me/paper-portfolio',undefined,undefined,undefined,401);
   await req('POST','/v1/me/paper-portfolio/initialize','captain',{wallet:wallets.crew},undefined,403);
   await req('POST','/v1/me/paper-portfolio/initialize','captain',{wallet:wallets.captain,amount:'1000000'},undefined,400);
   await seedPrices(91000);await req('POST','/v1/me/paper-portfolio/initialize','stale',{wallet:wallets.stale},undefined,503);assert.equal((await pool.query('SELECT 1 FROM paper_wallet_snapshots')).rowCount,0);await seedPrices();
  });
  await t.test('concurrent initialization and retries issue one snapshot only',async()=>{
   const results=await Promise.all([1,2].map(()=>req('POST','/v1/me/paper-portfolio/initialize','captain',{wallet:wallets.captain})));assert.ok(results.every(p=>p.initialUsdc==='600.000000'));assert.equal(Number((await cash(captain)).virtual),600);assert.equal(Number((await cash(captain)).redeemable),0);
   const before=reads;await req('POST','/v1/me/paper-portfolio/initialize','captain',{wallet:wallets.captain});assert.equal(reads,before);assert.equal((await pool.query('SELECT 1 FROM paper_wallet_snapshots')).rowCount,1);
   await req('POST','/v1/me/paper-portfolio/initialize','duplicate',{wallet:wallets.duplicate},undefined,409);
   assert.equal(Number((await pool.query("SELECT sum(e.amount) AS amount FROM ledger_entries e JOIN ledger_accounts a ON a.id=e.account_id WHERE a.owner_type='USER' AND a.owner_id=$1 AND a.asset_id='USDC'",[paperOwner(captain.id)])).rows[0].amount),600);
  });
  const body={name:'Harbor paper',description:'Wallet-valued simulation',fundingWindowHours:12,durationDays:7,termsVersion:1};
  await t.test('create preview, seed and replay work while the token layer is enabled',async()=>{
   const preview=await req('POST','/v1/vaults/preview','captain',body);assert.equal(preview.enabled,true);assert.equal(preview.walletSnapshotEnabled,true);assert.equal(preview.availableUsdc,'600.000000');
   const key=randomUUID(),created=await req('POST','/v1/vaults','captain',body,key,201);assert.deepEqual(await req('POST','/v1/vaults','captain',body,key,201),created);id=created.vaultId;assert.equal(Number((await cash(captain)).virtual),500);assert.equal(Number((await cash(captain)).redeemable),0);
   await assert.rejects(pool.query("UPDATE vault_rounds SET balance_source='LEGACY' WHERE fund_id=$1",[id]),/immutable/);
  });
  await t.test('Crew joins and cancellations debit and refund paper cash',async()=>{
   await req('POST','/v1/me/paper-portfolio/initialize','crew',{wallet:wallets.crew});const v=await req('GET',`/v1/vaults/${id}`);
   await req('POST',`/v1/vaults/${id}/contributions`,'crew',{amountUsdc:'50',termsHash:v.termsHash},randomUUID(),201);assert.equal(Number((await cash(crew)).virtual),550);
   await req('POST',`/v1/vaults/${id}/contribution-cancellations`,'crew',{},randomUUID());assert.equal(Number((await cash(crew)).virtual),600);
   await req('POST',`/v1/vaults/${id}/contributions`,'crew',{amountUsdc:'50',termsHash:v.termsHash},randomUUID(),201);
  });
  await t.test('failed fundraising and claims retain their balance source after rollback',async()=>{
   await pool.query('ALTER TABLE vault_rounds DISABLE TRIGGER vault_terms_immutable');try{await pool.query("UPDATE vault_rounds SET funding_started_at=now()-interval '13 hours',funding_closes_at=now()-interval '1 hour',trading_ends_at=now()-interval '1 hour'+interval '7 days' WHERE fund_id=$1",[id]);}finally{await pool.query('ALTER TABLE vault_rounds ENABLE TRIGGER vault_terms_immutable');}
   await advanceVaultRound(pool,id);await advanceVaultRound(pool,id);process.env.PAPER_WALLET_SNAPSHOT_ENABLED='false';
   for(const subject of ['captain','crew']){const key=randomUUID();const claimed=await req('POST',`/v1/vaults/${id}/claims`,subject,{},key);assert.deepEqual(await req('POST',`/v1/vaults/${id}/claims`,subject,{},key),claimed);}
   for(const user of [captain,crew]){assert.equal(Number((await cash(user)).virtual),600);assert.equal(Number((await cash(user)).redeemable),0);}
   assert.equal((await pool.query('SELECT event_id FROM ledger_entries GROUP BY event_id HAVING sum(amount)<>0')).rowCount,0);
   assert.equal((await pool.query("SELECT 1 FROM ledger_accounts WHERE owner_type='USER' AND asset_id='USDC' AND owner_id IN ($1,$2)",[captain.id,crew.id])).rowCount,0);
   // A restart must allow isolated paper rounds alongside token routes.
   const restartPool=new pg.Pool({connectionString,options:`-c search_path=${schema}`});const restarted=createApp(restartPool,options);restarted.log.level='silent';try{await restarted.ready();}finally{await restarted.close();}
  });
 }finally{globalThis.fetch=originalFetch;if(app)await app.close();else await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
});
