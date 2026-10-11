import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import pg from 'pg';
import {createApp} from '../dist/app.js';
import {configurePrivyFixture} from './privy-fixture.mjs';
import {advanceVaultRound} from '../../worker/dist/vault-rounds.js';
import {recordMarketPrice} from '../../ingestor/dist/ingest.js';
import {processOrder} from '../../worker/dist/orders.js';

test('development activation skips fundraising while production and settled vaults stay protected',{timeout:30000},async()=>{
  const url=process.env.TEST_DATABASE_URL;assert.ok(url);
  const schema=`test_activation_${randomUUID().replaceAll('-','')}`,admin=new pg.Pool({connectionString:url});
  const before={...process.env},realFetch=globalThis.fetch;let pool,app;
  try{
    await admin.query(`CREATE SCHEMA ${schema}`);pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`});
    const migrations=new URL('../../../packages/db/migrations/',import.meta.url);
    for(const name of(await readdir(migrations)).filter(n=>n.endsWith('.sql')).sort())await pool.query(await readFile(new URL(name,migrations),'utf8'));
    process.env.NODE_ENV='development';process.env.PAPER_WALLET_SNAPSHOT_ENABLED='false';
    process.env.VAULT_PAPER_ENABLED='true';process.env.VAULT_TERMS_APPROVAL='locked-v1-retain-residue';
    process.env.PAPER_TEST_SKIP_FUNDRAISING='false';delete process.env.USDG_MINT;delete process.env.REDIS_URL;
    const tokenFor=configurePrivyFixture();app=createApp(pool);app.log.level='silent';
    const call=async(method,path,subject,payload,status=200)=>{
      const result=await app.inject({method,url:path,payload,headers:{authorization:`Bearer ${tokenFor(subject)}`,'idempotency-key':randomUUID()}});
      assert.equal(result.statusCode,status,result.body);return result.json();
    };
    for(const subject of ['captain','other','automatic','cancelled']){
      await call('GET','/v0/me',subject);
      await call('POST','/v0/me/onboarding',subject,{username:`test_${subject}`,role:'captain'});
    }
    // Disposable test accounts only; no live balance is changed.
    await pool.query('UPDATE users SET paper_cash=1000');
    const create=subject=>call('POST','/v1/vaults',subject,{name:`Test ${subject}`,description:'Local test',fundingWindowHours:12,durationDays:3,termsVersion:1},201);
    const created=await create('captain'),path=`/v1/vaults/${created.vaultId}`;
    assert.equal((await call('GET',`${path}/trading-context`,'captain')).fund.phase,'FUNDRAISING');
    await call('POST',`${path}/test-activation`,'captain',undefined,404);
    process.env.PAPER_TEST_SKIP_FUNDRAISING='true';
    assert.equal((await call('GET',`${path}/trading-context`,'captain')).testActivationAllowed,true);
    await call('POST',`${path}/test-activation`,'other',undefined,403);
    process.env.NODE_ENV='production';
    await call('POST',`${path}/test-activation`,'captain',undefined,404);
    assert.equal((await call('GET',`${path}/trading-context`,'captain')).testActivationAllowed,false);
    process.env.NODE_ENV='development';
    await pool.query("UPDATE vault_rounds SET risk_state='FROZEN' WHERE fund_id=$1",[created.vaultId]);
    await call('POST',`${path}/test-activation`,'captain',undefined,409);
    await pool.query("UPDATE vault_rounds SET risk_state='NORMAL' WHERE fund_id=$1",[created.vaultId]);
    const first=await call('POST',`${path}/test-activation`,'captain');
    assert.equal(first.phase,'ACTIVE');assert.equal(first.testOnly,true);
    await call('POST',`${path}/test-activation`,'captain');
    const active=await call('GET',`${path}/trading-context`,'captain');
    assert.equal(active.fund.phase,'ACTIVE');assert.equal(active.fund.status,'ACTIVE');assert.equal(Number(active.cashUsdc),100);
    assert.equal((await pool.query("SELECT 1 FROM fund_events WHERE fund_id=$1 AND type='vault_active'",[created.vaultId])).rowCount,1);
    const observed=async()=>{const at=new Date().toISOString();await recordMarketPrice(pool,{instrumentId:'SOL',mint:'So11111111111111111111111111111111111111112',source:'JUPITER_PRICE_V3',priceUsd:'100',priceUsdc:'100',sourceBlockId:String(Date.now()),sourceAt:at,quoteSourceBlockId:String(Date.now()),quoteSourceAt:at,observationId:null,receivedAt:at,status:'CURRENT',reason:null},'1');};
    await observed();
    const intent={side:'BUY',instrumentId:'SOL',notionalUsdc:'1'};
    assert.equal((await call('POST',`${path}/orders/preview`,'captain',intent)).policy.allowed,true);
    const order=await call('POST',`${path}/orders`,'captain',intent,202);
    await pool.query("UPDATE orders SET submitted_at=now()-interval '5 seconds' WHERE id=$1",[order.orderId]);await observed();
    assert.equal(await processOrder(pool,order.orderId),true);
    assert.equal((await call('GET',`${path}/orders/${order.orderId}`,'captain')).order.status,'FILLED');
    assert.equal((await call('GET',`${path}/trading-context`,'captain')).holdings.length,1);
    const automatic=await create('automatic');
    assert.equal((await call('GET',`/v1/vaults/${automatic.vaultId}/trading-context`,'automatic')).fund.phase,'ACTIVE');
    process.env.PAPER_TEST_SKIP_FUNDRAISING='false';
    const cancelled=await create('cancelled');
    // Advance only the isolated fixture clock beyond its funding deadline.
    await pool.query('ALTER TABLE vault_rounds DISABLE TRIGGER vault_terms_immutable');
    try{await pool.query("UPDATE vault_rounds SET funding_started_at=now()-interval '13 hours',funding_closes_at=now()-interval '1 hour',trading_ends_at=now()-interval '1 hour'+interval '3 days' WHERE fund_id=$1",[cancelled.vaultId]);}
    finally{await pool.query('ALTER TABLE vault_rounds ENABLE TRIGGER vault_terms_immutable');}
    await advanceVaultRound(pool,cancelled.vaultId);await advanceVaultRound(pool,cancelled.vaultId);
    process.env.PAPER_TEST_SKIP_FUNDRAISING='true';
    await call('POST',`/v1/vaults/${cancelled.vaultId}/test-activation`,'cancelled',undefined,409);
    assert.equal((await call('GET',`/v1/vaults/${cancelled.vaultId}`,'cancelled')).phase,'CANCELLED');
  }finally{
    await app?.close();if(pool&&!pool.ended)await pool.end();await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();
    globalThis.fetch=realFetch;for(const key of Object.keys(process.env))if(!(key in before))delete process.env[key];Object.assign(process.env,before);
  }
});
