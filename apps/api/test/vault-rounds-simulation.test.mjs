import { reserveVaultUpload,completeVaultUpload } from '../dist/vault-uploads.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { readdir,readFile } from 'node:fs/promises';
import pg from 'pg';
import { configurePrivyFixture } from './privy-fixture.mjs';
import { createApp } from '../dist/app.js';
import { advanceVaultRound } from '../../worker/dist/vault-rounds.js';
import { assessFundFee } from '../../worker/dist/fees.js';
import { completeTrial } from '../../worker/dist/trials.js';
import { processOrder } from '../../worker/dist/orders.js';
import { appendFundEvent,inTransaction } from '../../../packages/db/dist/index.js';
import { parseVaultSummary } from '../../../packages/contracts/dist/index.js';

test('paper vault lifecycle and concurrency', { timeout:120_000 }, async t => {
  const connectionString=process.env.TEST_DATABASE_URL;
  assert.ok(connectionString,'TEST_DATABASE_URL must point to local PostgreSQL');
  assert.match(new URL(connectionString).hostname,/^(localhost|127\.0\.0\.1|\[::1\])$/);
  process.env.VAULT_PAPER_ENABLED='true'; process.env.VAULT_TERMS_APPROVAL='locked-v1-retain-residue'; delete process.env.USDG_MINT;
  process.env.NODE_ENV='development';
  process.env.PAPER_TEST_SKIP_FUNDRAISING='false';
  process.env.PAPER_WALLET_SNAPSHOT_ENABLED='false';
  const tokenFor=configurePrivyFixture();
  const schema=`vault_test_${randomUUID().replaceAll('-','')}`;
  const admin=new pg.Pool({ connectionString }); await admin.query(`CREATE SCHEMA ${schema}`);
  const pool=new pg.Pool({ connectionString,options:`-c search_path=${schema}`,max:12 });
  const app=createApp(pool); app.log.level='silent';
  const body={ name:'Round test',description:'Paper spot strategy',fundingWindowHours:12,durationDays:7,termsVersion:1 };
  let id,captain,crew;
  const route=suffix=>`/v1/vaults/${id}${suffix}`;
  async function request(method,url,subject,payload,key,status=200) {
    const r=await app.inject({ method,url,payload,headers:{ ...(subject?{ authorization:`Bearer ${tokenFor(subject)}` }:{}),...(key?{ 'idempotency-key':key }:{}) } });
    assert.equal(r.statusCode,status,`${method} ${url}: ${r.body}`); return r.json();
  }
  async function travel(hours) {
    // Test-only fixture manipulation in a disposable schema. Production has no clock override.
    await pool.query('ALTER TABLE vault_rounds DISABLE TRIGGER vault_terms_immutable');
    try { await pool.query(`UPDATE vault_rounds SET funding_started_at=now()-($2::numeric+12)*interval '1 hour',
      funding_closes_at=now()-$2::numeric*interval '1 hour',trading_ends_at=now()-$2::numeric*interval '1 hour'+interval '7 days' WHERE fund_id=$1`,[id,hours]); }
    finally { await pool.query('ALTER TABLE vault_rounds ENABLE TRIGGER vault_terms_immutable'); }
  }
  async function join(subject,amount,key=randomUUID(),status=201) {
    const v=await request('GET',route(''));
    return request('POST',route('/contributions'),subject,{ amountUsdc:amount,termsHash:v.termsHash },key,status);
  }
  async function reconcile() {
    assert.equal((await pool.query(`SELECT e.event_id,a.asset_id FROM ledger_entries e JOIN ledger_accounts a ON a.id=e.account_id
      GROUP BY e.event_id,a.asset_id HAVING SUM(e.amount)<>0`)).rowCount,0);
    assert.equal((await pool.query(`SELECT f.id FROM funds f WHERE total_shares<>(SELECT COALESCE(sum(shares),0) FROM fund_shares WHERE fund_id=f.id)+protocol_shares`)).rowCount,0);
    assert.equal((await pool.query(`SELECT f.id FROM funds f LEFT JOIN ledger_accounts a ON a.owner_type='FUND' AND a.owner_id=f.id::text AND a.asset_id='USDC'
      LEFT JOIN ledger_entries e ON e.account_id=a.id GROUP BY f.id HAVING f.cash_usdc<>COALESCE(sum(e.amount),0)`)).rowCount,0);
  }
  try {
    const dir=new URL('../../../packages/db/migrations/',import.meta.url);
    for (const file of (await readdir(dir)).filter(f=>f.endsWith('.sql')).sort()) await pool.query(await readFile(new URL(file,dir),'utf8'));
    await t.test('atomic creation, idempotency, private operation recovery and immutable terms',async()=>{
      captain=await request('GET','/v0/me','vault-captain'); crew=await request('GET','/v0/me','vault-crew');
      await request('POST','/v0/me/onboarding','vault-captain',{ username:'vault_captain',role:'captain' });
      const key=randomUUID();
      const all=await Promise.all(Array.from({ length:4 },()=>request('POST','/v1/vaults','vault-captain',body,key,201)));
      id=all[0].vaultId; assert.ok(all.every(r=>r.vaultId===id));
      assert.equal((await request('GET',`/v1/me/operations?clientRequestId=${key}`,'vault-captain')).vaultId,id);
      await request('GET',`/v1/operations/${all[0].id}`,'vault-crew',undefined,undefined,404);
      await request('POST','/v1/vaults','vault-captain',{ ...body,name:'Changed' },key,409);
      await request('POST','/v1/vaults','vault-captain',body,randomUUID(),409);
      const v=parseVaultSummary(await request('GET',route('')));
      assert.equal(v.acceptedCapitalUsdc,'100.000000'); assert.equal(v.phase,'FUNDRAISING');
      assert.equal((await pool.query('SELECT 1 FROM trials WHERE fund_id=$1',[id])).rowCount,0);
      await assert.rejects(pool.query("UPDATE vault_rounds SET terms='{}' WHERE fund_id=$1",[id]),/immutable/);
      assert.ok(!(await request('GET','/v0/funds')).funds.some(f=>f.id===id)); await reconcile();
    });
    await t.test('vault art ownership, concurrent completion and retry are isolated from money/profile',async()=>{
      let publishing=false,release; const waiting=new Promise(resolve=>{ release=resolve; });
      let calls=0;
      const storage={ sign:async()=> 'https://staging.example/upload',discard:async()=>{},publish:async(_row,kind,owner,_upload,prefix)=>{
        calls++; publishing=true; assert.equal(owner,id); assert.equal(prefix,'vaults');
        await waiting; return `https://assets.example/vaults/${owner}/${kind}/art.webp`;
      } };
      const before=await request('GET',route('/position'),'vault-captain');
      const profile=await request('GET','/v0/me','vault-captain');
      await assert.rejects(reserveVaultUpload(pool,crew.id,id,{ kind:'banner',contentType:'image/jpeg',byteSize:100 },()=>storage),/Owned vault/);
      const upload=await reserveVaultUpload(pool,captain.id,id,{ kind:'banner',contentType:'image/jpeg',byteSize:100 },()=>storage);
      await assert.rejects(completeVaultUpload(pool,crew.id,id,upload.uploadId,()=>storage),/Upload not found/);
      const done=completeVaultUpload(pool,captain.id,id,upload.uploadId,()=>storage);
      while (!publishing) await new Promise(resolve=>setTimeout(resolve,5));
      await assert.rejects(completeVaultUpload(pool,captain.id,id,upload.uploadId,()=>storage),/in progress/);
      release(); const asset=await done;
      assert.deepEqual(await completeVaultUpload(pool,captain.id,id,upload.uploadId,()=>storage),asset); assert.equal(calls,1);
      assert.equal((await request('GET',route(''))).bannerUrl,asset.url);
      assert.deepEqual(await request('GET',route('/position'),'vault-captain'),before);
      assert.deepEqual(await request('GET','/v0/me','vault-captain'),profile);
      const retry=await reserveVaultUpload(pool,captain.id,id,{ kind:'avatar',contentType:'image/jpeg',byteSize:100 },()=>storage);
      await assert.rejects(completeVaultUpload(pool,captain.id,id,retry.uploadId,()=>({ ...storage,publish:async()=>{ throw new Error('temporary storage failure'); } })),/temporary/);
      assert.equal((await pool.query('SELECT status FROM vault_asset_uploads WHERE id=$1',[retry.uploadId])).rows[0].status,'PENDING');
      await completeVaultUpload(pool,captain.id,id,retry.uploadId,()=>storage); await reconcile();
    });
    await t.test('legacy joins/exits and fundraising trades are denied',async()=>{
      await request('POST',`/v0/funds/${id}/joins`,'vault-crew',{ amountUsdc:'50' },randomUUID(),404);
      await request('POST',`/v0/funds/${id}/exits`,'vault-crew',{ shares:'50' },randomUUID(),404);
      for (const [suffix,side] of [['','BUY'],['/preview','SELL']]) await request('POST',`/v0/funds/${id}/orders${suffix}`,'vault-captain',{ side,instrumentId:'SOL',notionalUsdc:'10' },randomUUID(),404);
    });
    await t.test('exact minima, fixed seed, duplicate joins and full cancellation',async()=>{
      const rejectedKey=randomUUID();
      await join('vault-crew','49.999999',rejectedKey,409);
      await join('vault-crew','49.999999',rejectedKey,409);
      await join('vault-crew','50',rejectedKey,409);
      assert.equal((await request('GET',`/v1/me/operations?clientRequestId=${rejectedKey}`,'vault-crew',undefined,undefined,409)).error,'vault_request_rejected');
      await join('vault-captain','50',randomUUID(),409);
      const key=randomUUID(); await join('vault-crew','50',key); await join('vault-crew','50.000000',key);
      assert.equal((await request('GET',route('/position'),'vault-crew')).shares,'50.000000');
      await request('POST',route('/contribution-cancellations'),'vault-crew',{},randomUUID());
      assert.equal((await request('GET',route(''))).acceptedCapitalUsdc,'100.000000');
      await request('POST',route('/contribution-cancellations'),'vault-captain',{},randomUUID(),409); await reconcile();
    });
    await t.test('capacity race has one winner and one debit',async()=>{
      await join('vault-crew','9850');
      await request('GET','/v0/me','vault-racer');
      await join('vault-racer','10000');
      await request('GET','/v0/me','vault-last');
      await join('vault-last','10000');
      for (const subject of ['vault-a','vault-b']) await request('GET','/v0/me',subject);
      const v=await request('GET',route(''));
      const responses=await Promise.all(['vault-a','vault-b'].map(subject=>app.inject({ method:'POST',url:route('/contributions'),headers:{ authorization:`Bearer ${tokenFor(subject)}`,'idempotency-key':randomUUID() },payload:{ amountUsdc:'50',termsHash:v.termsHash } })));
      assert.deepEqual(responses.map(r=>r.statusCode).sort(),[201,409]);
      assert.equal((await request('GET',route(''))).acceptedCapitalUsdc,'30000.000000'); await reconcile();
    });
    await t.test('deadline holds before keeper and legacy fee jobs never touch round-v2',async()=>{
      await travel(1); await join('vault-a','50',randomUUID(),409);
      await request('POST',route('/contribution-cancellations'),'vault-crew',{},randomUUID(),409);
      assert.equal(await advanceVaultRound(pool,id),true);
      assert.equal((await request('GET',route(''))).phase,'ACTIVE');
      assert.equal(await inTransaction(pool,c=>assessFundFee(c,id,'2026-10-08')),false);
      assert.equal(await completeTrial(pool,id,new Date('2100-01-01')),false);
    });
    await t.test('cash settlement and exactly-once claim with immutable denominator',async()=>{
      await travel(200); await advanceVaultRound(pool,id); await advanceVaultRound(pool,id);
      assert.equal((await request('GET',route(''))).phase,'COMPLETED');
      const performance=await request('GET',route('/performance?range=7D'));
      assert.ok(performance.points.length>0 && performance.points.length<=169);
      assert.ok(performance.points.every(point=>point.netReturnPercent==='0.000000'));
      assert.equal(performance.captainFeeUsdc,'0.000000');
      const key=randomUUID(),first=await request('POST',route('/claims'),'vault-captain',{},key);
      assert.deepEqual(await request('POST',route('/claims'),'vault-captain',{},key),first);
      await request('POST',route('/claims'),'vault-captain',{},randomUUID(),409);
      for (const subject of ['vault-crew','vault-racer','vault-last','vault-a','vault-b']) {
        const pos=await request('GET',route('/position'),subject);
        if (pos.shares!=='0.000000') await request('POST',route('/claims'),subject,{},randomUUID());
      }
      assert.equal(Number((await pool.query('SELECT cash_usdc FROM funds WHERE id=$1',[id])).rows[0].cash_usdc),0); await reconcile();
      const events=JSON.stringify(await request('GET',route('/activity')));
      assert.ok(!events.includes(captain.id) && !events.includes(crew.id) && !events.includes('payout'));
    });
    await t.test('WS fanout sends sanitized invalidations and reconnect requires REST resync',async()=>{
      const clients=[await app.injectWS('/v1/vaults/ws'),await app.injectWS('/v1/vaults/ws')];
      const messages=clients.map(()=>[]);
      const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
      const waitFor=async(index,predicate)=>{ for(let n=0;n<100;n++){const result=messages[index].find(predicate);if(result)return result;await delay(25);}assert.fail(JSON.stringify(messages[index])); };
      try {
        clients.forEach((ws,index)=>{ws.on('message',raw=>messages[index].push(JSON.parse(raw.toString())));ws.send(JSON.stringify({ type:'subscribe',vaultIds:[id] }));});
        await waitFor(0,m=>m.type==='resync'); await waitFor(1,m=>m.type==='resync');
        const event=await inTransaction(pool,c=>appendFundEvent(c,id,'test_private',{ userId:crew.id,payouts:[{ userId:captain.id,amount:'secret' }] }));
        const sequence=(await pool.query('SELECT sequence::text FROM fund_events WHERE id=$1',[event])).rows[0].sequence;
        for(let index=0;index<2;index++) {
          const message=await waitFor(index,m=>m.type==='vault.updated'&&m.eventSequence===sequence);
          assert.deepEqual(Object.keys(message).sort(),['eventSequence','type','vaultId']);
          assert.ok(!JSON.stringify(messages[index]).includes(crew.id));
        }
        clients[0].send(JSON.stringify({ type:'subscribe',vaultIds:[id] }));
        await delay(25); assert.ok(messages[0].filter(m=>m.type==='resync').length>=2);
      } finally { clients.forEach(ws=>ws.terminate()); }
    });
    await t.test('minimum failure refunds all principal without fees',async()=>{
      id=(await request('POST','/v1/vaults','vault-captain',body,randomUUID(),201)).vaultId;
      await join('vault-crew','50'); await travel(1); await advanceVaultRound(pool,id); await advanceVaultRound(pool,id);
      assert.equal((await request('GET',route(''))).phase,'CANCELLED');
      assert.equal((await request('GET',route('/position'),'vault-crew')).claimableUsdc,'50.000000');
      await request('POST',route('/claims'),'vault-crew',{},randomUUID()); await request('POST',route('/claims'),'vault-captain',{},randomUUID()); await reconcile();
    });
    await t.test('join waiting across deadline is rejected using the post-lock database clock',async()=>{
      id=(await request('POST','/v1/vaults','vault-captain',body,randomUUID(),201)).vaultId;
      await travel(-0.00014); // ~500ms remaining.
      const lock=await pool.connect(); await lock.query('BEGIN'); await lock.query('SELECT id FROM funds WHERE id=$1 FOR NO KEY UPDATE',[id]);
      try {
        const joining=join('vault-crew','50',randomUUID(),409);
        await new Promise(resolve=>setTimeout(resolve,700)); await lock.query('COMMIT'); await joining;
      } finally { await lock.query('ROLLBACK'); lock.release(); }
      assert.equal((await request('GET',route(''))).acceptedCapitalUsdc,'100.000000');
      await advanceVaultRound(pool,id); await advanceVaultRound(pool,id);
      await request('POST',route('/claims'),'vault-captain',{},randomUUID());
    });
    await t.test('real paper order, last-recorded-price settlement, restart resume and profit conservation',async()=>{
      process.env.DEV_PRICE_SEED_ENABLED='true';
      id=(await request('POST','/v1/vaults','vault-captain',body,randomUUID(),201)).vaultId;
      await join('vault-crew','900'); await travel(1); await advanceVaultRound(pool,id);
      const seed=async(price,age=0)=>{const mark=randomUUID();await pool.query(`INSERT INTO price_observations(id,instrument_id,source,source_ref,price_usdc,source_at,received_at)
        VALUES($1::uuid,'SOL','DEV_SEED',$1::text,$2,now()-$3*interval '1 second',now())`,[mark,price,age]);};
      await seed('100');
      const order=await request('POST',route('/orders'),'vault-captain',{ side:'BUY',instrumentId:'SOL',notionalUsdc:'100' },randomUUID(),202);
      await pool.query("UPDATE orders SET submitted_at=now()-interval '10 seconds' WHERE id=$1",[order.orderId]); await seed('100');
      assert.equal(await processOrder(pool,order.orderId),true);
      assert.equal((await request('GET',route(`/orders/${order.orderId}`),'vault-captain')).order.status,'FILLED');
      const activity=await request('GET','/v1/me/paper-activity?limit=1','vault-captain');
      assert.equal(activity.items.length,1);
      const allActivity=await request('GET','/v1/me/paper-activity?limit=100','vault-captain');
      assert.equal(allActivity.items.find(item=>item.id===order.orderId).kind,'BUY');
      assert.ok(activity.nextCursor);
      const older=await request('GET',`/v1/me/paper-activity?limit=1&after=${activity.nextCursor}`,'vault-captain');
      assert.notEqual(older.items[0].id,activity.items[0].id);
      await request('GET',`/v1/me/paper-activity?after=${order.orderId}`,'vault-crew',undefined,undefined,400);
      const crewActivity=await request('GET','/v1/me/paper-activity','vault-crew');
      assert.ok(crewActivity.items.every(item=>!['BUY','SELL','CREATE'].includes(item.kind)));

      await seed('200');
      await travel(200); await advanceVaultRound(pool,id);
      await pool.query("UPDATE price_observations SET source_at=source_at-interval '5 minutes'");
      assert.equal(await advanceVaultRound(pool,id),true); // unwind using the last recorded price
      const audit=(await pool.query("SELECT payload FROM fund_events WHERE fund_id=$1 AND type='vault_asset_unwound' ORDER BY sequence DESC LIMIT 1",[id])).rows[0].payload;
      assert.equal(audit.pricingPolicy,'LAST_RECORDED_PRICE');
      assert.ok(audit.priceAgeMs>=300000);
      assert.ok(audit.observationId);
      assert.equal((await request('GET',route(''))).phase,'SETTLING');
      assert.equal(await advanceVaultRound(pool,id),true); // finalize on a separate checkpoint
      assert.equal(await advanceVaultRound(pool,id),false); // replay does nothing
      const v=await request('GET',route(''));
      assert.ok(Number(v.settlement.captainFeeUsdc)>0); assert.equal(v.phase,'COMPLETED');
      const captainPosition=await request('GET',route('/position'),'vault-captain');
      assert.equal(captainPosition.captainFeeUsdc,v.settlement.captainFeeUsdc);
      await request('POST',route('/claims'),'vault-crew',{},randomUUID()); await request('POST',route('/claims'),'vault-captain',{},randomUUID()); await reconcile();
      const remaining=(await request('GET',route(''))).settlement.residueLiabilityUsdc;
      assert.ok(Number(remaining)<0.000002);
    });
  } finally { await app.close(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); }
});
