import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { readdir,readFile } from 'node:fs/promises';
import pg from 'pg';
import { configurePrivyFixture } from './privy-fixture.mjs';
import { createApp } from '../dist/app.js';

test('Captain dashboard uses owned rounds, unique Crew, exact fees and recorded AUM', { timeout:120000 },async t=>{
 const connectionString=process.env.TEST_DATABASE_URL;assert.ok(connectionString,'TEST_DATABASE_URL is required');
 assert.match(new URL(connectionString).hostname,/^(localhost|127\.0\.0\.1|\[::1\])$/);
 process.env.VAULT_PAPER_ENABLED='true';process.env.VAULT_TERMS_APPROVAL='locked-v1-retain-residue';delete process.env.USDG_MINT;process.env.NODE_ENV='development';
 const tokenFor=configurePrivyFixture(),schema=`captain_test_${randomUUID().replaceAll('-','')}`;
 const admin=new pg.Pool({connectionString});await admin.query(`CREATE SCHEMA ${schema}`);
 const pool=new pg.Pool({connectionString,options:`-c search_path=${schema}`,max:8});const app=createApp(pool);app.log.level='silent';
 async function call(method,url,subject,body,status=200){const r=await app.inject({method,url,payload:body,headers:{...(subject?{authorization:`Bearer ${tokenFor(subject)}`} : {}),...(method==='POST'?{'idempotency-key':randomUUID()}: {})}});assert.equal(r.statusCode,status,`${method} ${url}: ${r.body}`);return r.json();}
 let captain,crew,id;
 try{
 const dir=new URL('../../../packages/db/migrations/',import.meta.url);
 for(const file of(await readdir(dir)).filter(f=>f.endsWith('.sql')).sort())await pool.query(await readFile(new URL(file,dir),'utf8'));
 await t.test('private routes reject unsigned and non-Captain requests; new Captain has no fabricated data',async()=>{
  for(const path of ['dashboard','crew','earnings','performance']){await call('GET',`/v1/me/captain/${path}`,null,undefined,401);await call('GET',`/v1/me/captain/${path}`,'crew',undefined,403);}
  captain=await call('POST','/v0/me/onboarding','captain',{username:'dashboard_captain',role:'captain'});crew=await call('GET','/v0/me','crew');
  await call('POST','/v0/me/onboarding','other',{username:'other_captain',role:'captain'});
  const d=await call('GET','/v1/me/captain/dashboard','captain');assert.equal(d.state,'NEW');assert.equal(d.aumUsdc,'0.000000');assert.equal(d.crewMembers,0);assert.equal(d.creation.allowed,true);
  assert.deepEqual((await call('GET','/v1/me/captain/performance?range=90D','captain')).points,[]);
  await call('GET','/v1/me/captain/performance?range=1D','captain',undefined,400);
 });
 await t.test('seed is AUM, not Crew or earnings; repeated contributions count one member',async()=>{
  id=(await call('POST','/v1/vaults','captain',{name:'Actual vault',description:'Round test',fundingWindowHours:72,durationDays:7,termsVersion:1},201)).vaultId;
  const v=await call('GET',`/v1/vaults/${id}`);
  for(const amountUsdc of ['50','50.000001'])await call('POST',`/v1/vaults/${id}/contributions`,'crew',{amountUsdc,termsHash:v.termsHash},201);
  const d=await call('GET','/v1/me/captain/dashboard','captain');assert.equal(d.state,'EXISTING');assert.equal(d.aumUsdc,'200.000001');assert.equal(d.crewMembers,1);assert.equal(d.activeVaults,0);assert.equal(d.openVaults,1);assert.equal(d.creation.reason,'open_round_exists');assert.equal(d.earnings.earnedUsdc,'0.000000');
  for(const range of ['7D','30D','90D','ALL']){const history=await call('GET',`/v1/me/captain/performance?range=${range}`,'captain');assert.equal(history.range,range);assert.equal(history.points.at(-1).aumUsdc,'200.000001');assert.ok(history.points.length<=401);}
  const list=await call('GET','/v1/me/captain/crew?limit=1','captain');assert.equal(list.members.length,1);assert.equal(list.members[0].allocatedUsdc,'100.000001');assert.equal(list.members[0].id,crew.id);assert.equal(list.nextCursor,null);
  assert.equal((await call('GET','/v1/me/captain/dashboard','other')).aumUsdc,'0.000000');assert.deepEqual((await call('GET','/v1/me/captain/crew','other')).members,[]);
  assert.equal((await call('GET','/v1/me/captain/vaults?limit=1','captain')).vaults[0].id,id);
 });
 await t.test('roster pagination and creation gates remain explicit',async()=>{
  await call('POST','/v0/me/onboarding','crew-second',{username:'crew_second',role:'crew'});
  const v=await call('GET',`/v1/vaults/${id}`);
  await call('POST',`/v1/vaults/${id}/contributions`,'crew-second',{amountUsdc:'50',termsHash:v.termsHash},201);
  const first=await call('GET','/v1/me/captain/crew?limit=1','captain');assert.ok(first.nextCursor);
  const second=await call('GET',`/v1/me/captain/crew?limit=1&after=${first.nextCursor}`,'captain');assert.equal(second.members.length,1);assert.notEqual(first.members[0].id,second.members[0].id);assert.equal(second.nextCursor,null);
  assert.equal((await call('GET','/v1/me/captain/dashboard','captain')).crewMembers,2);
  await call('GET','/v1/me/captain/crew?limit=51','captain',undefined,400);
  await call('GET','/v1/me/captain/earnings?after=bad','captain',undefined,400);
  await call('POST',`/v1/vaults/${id}/contribution-cancellations`,'crew-second',{});
  process.env.VAULT_PAPER_ENABLED='false';assert.equal((await call('GET','/v1/me/captain/dashboard','other')).creation.reason,'funding_unavailable');process.env.VAULT_PAPER_ENABLED='true';
  const other=await call('GET','/v0/me','other');await pool.query('UPDATE users SET paper_cash=0 WHERE id=$1',[other.id]);
  assert.equal((await call('GET','/v1/me/captain/dashboard','other')).creation.reason,'insufficient_seed');
 });
 await t.test('recorded points retain unknown marks; cancellation removes Crew and capital',async()=>{
  await pool.query(`INSERT INTO captain_vault_aum_rollups(fund_id,interval_seconds,bucket_at,recorded_at,nav_usdc,valuation_status)
    VALUES($1,86400,date_trunc('day',now())-interval '1 day',now()-interval '1 day',100,'CURRENT')`,[id]);
  // Test-only historical start; production terms are immutable.
  await pool.query('ALTER TABLE vault_rounds DISABLE TRIGGER vault_terms_immutable');
  await pool.query("UPDATE vault_rounds SET funding_started_at=funding_started_at-interval '2 days',funding_closes_at=funding_closes_at-interval '2 days',trading_ends_at=trading_ends_at-interval '2 days' WHERE fund_id=$1",[id]);
  await pool.query('ALTER TABLE vault_rounds ENABLE TRIGGER vault_terms_immutable');
  const p=await call('GET','/v1/me/captain/performance?range=90D','captain');assert.equal(p.points.length,2);assert.equal(p.changeUsdc,'100.000001');
  await pool.query('UPDATE funds SET event_sequence=event_sequence+1 WHERE id=$1',[id]);
  await pool.query(`INSERT INTO nav_snapshots(id,fund_id,status,priced_at,event_sequence,performance_fee_factor) SELECT $2,id,'UNAVAILABLE',clock_timestamp(),event_sequence,1 FROM funds WHERE id=$1`,[id,randomUUID()]);
  assert.equal((await call('GET','/v1/me/captain/dashboard','captain')).aumUsdc,null);
  const unavailable=await call('GET','/v1/me/captain/performance','captain');assert.equal(unavailable.points.at(-1).aumUsdc,null);assert.equal(unavailable.changeUsdc,null);
  await call('POST',`/v1/vaults/${id}/contribution-cancellations`,'crew',{});
  const d=await call('GET','/v1/me/captain/dashboard','captain');assert.equal(d.crewMembers,0);assert.equal(d.aumUsdc,'100.000000');
 });
 await t.test('settled fees are separate from investment; claimed fees cannot be counted twice',async()=>{
  // Construct terminal economic state in this disposable schema to exercise reads
  // independently of the worker lifecycle (covered by vault-rounds-simulation).
  await pool.query('ALTER TABLE vault_rounds DISABLE TRIGGER vault_terms_immutable');
  await pool.query(`UPDATE vault_rounds SET phase='COMPLETED',finalized_at=now(),final_supply=100,final_assets_usdc=120,distribution_pool_usdc=118,captain_fee_usdc=2,residue_liability_usdc=0 WHERE fund_id=$1`,[id]);
  await pool.query("UPDATE funds SET status='COMPLETED' WHERE id=$1",[id]);
  await pool.query('ALTER TABLE vault_rounds ENABLE TRIGGER vault_terms_immutable');
  let d=await call('GET','/v1/me/captain/dashboard','captain');assert.equal(d.state,'EXISTING');assert.equal(d.aumUsdc,'0.000000');assert.equal(d.earnings.earnedUsdc,'2.000000');assert.equal(d.earnings.claimableUsdc,'2.000000');assert.equal(d.creation.allowed,true);
  assert.equal((await call('GET','/v1/me/captain/performance','captain')).points.at(-1).aumUsdc,'0.000000');
  const op=(await call('GET',`/v1/vaults/${id}/position`,'captain'));assert.equal(op.captainFeeUsdc,'2.000000');
  const eventId=randomUUID(),operationId=randomUUID();await pool.query("INSERT INTO fund_events(id,fund_id,type,payload) VALUES($1,$2,'test_claim','{}')",[eventId,id]);
  await pool.query("INSERT INTO vault_operations(id,user_id,client_request_id,fund_id,kind,event_id,amount_usdc) VALUES($1,$2,$5,$3,'CLAIM',$4,120)",[operationId,captain.id,id,eventId,randomUUID()]);
  await pool.query('INSERT INTO vault_claims(fund_id,user_id,investment_usdc,captain_fee_usdc,operation_id) VALUES($1,$2,118,2,$3)',[id,captain.id,operationId]);
  d=await call('GET','/v1/me/captain/dashboard','captain');assert.deepEqual(d.earnings,{earnedUsdc:'2.000000',claimedUsdc:'2.000000',claimableUsdc:'0.000000'});
  const earnings=await call('GET','/v1/me/captain/earnings?limit=1','captain');assert.equal(earnings.earnings[0].claimedUsdc,'2.000000');assert.ok(earnings.earnings[0].claimedAt);
  assert.deepEqual((await call('GET','/v1/me/captain/earnings','other')).earnings,[]);
 });
 }finally{await app.close();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
});
