import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {readdir,readFile,mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import pg from 'pg';
import {Redis} from 'ioredis';
import {createApp} from '../dist/app.js';
import {configurePrivyFixture} from './privy-fixture.mjs';
import {registerInstrument,validateMintMetadata} from '../dist/market-tracking.js';
import {registeredInstruments,assetTradeReason} from '../../../packages/market-data/dist/registry.js';
import {BirdeyeHistoryProvider,enqueueHistory,processHistoryJob,historyPermit} from '../../../packages/market-data/dist/backfill.js';
import {recordMarketPrice} from '../../ingestor/dist/ingest.js';
import {processValuationJobs} from '../../worker/dist/valuation-jobs.js';
import {reconcileFund} from '../../worker/dist/reconciliation.js';
import {appendFundEvent,inTransaction} from '../../../packages/db/dist/index.js';
import {MarketHistory} from '../dist/market-history.js';
import {RevisionCache} from '../dist/revision-cache.js';
import {processPendingOrders,processOrder} from '../../worker/dist/orders.js';
import {advanceVaultRound} from '../../worker/dist/vault-rounds.js';
import {parseTradingReturns} from '../../../packages/contracts/dist/index.js';
import {Amount} from '../../../packages/domain/dist/index.js';
const mint='EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm';
const metadata={mint,symbol:'WIF',name:'dogwifhat',decimals:6,icon:null,schemaVersion:2,stats:{},verified:null,suspicious:null,usdPrice:null,liquidityUsd:null,volume24hUsd:null,change1h:null,change24h:null,providerUpdatedAt:null};
test('dynamic mint registration, versioned execution, recovery, charts and private authorization',{timeout:60000},async t=>{
  const url=process.env.TEST_DATABASE_URL;assert.ok(url);
  const schema=`dynamic_${randomUUID().replaceAll('-','')}`,admin=new pg.Pool({connectionString:url});
  const directory=await mkdtemp(join(tmpdir(),'dynamic-market-')),socket=join(directory,'redis.sock');
  const server=spawn('redis-server',['--port','0','--unixsocket',socket,'--save','','--appendonly','no','--dir',directory],{stdio:['ignore','pipe','pipe']});
  let output='';server.stdout.on('data',v=>output+=v);server.stderr.on('data',v=>output+=v);
  let pool,app,redis;const previous={...process.env};const originalFetch=globalThis.fetch;
  try{
    for(let i=0;i<100&&!output.toLowerCase().includes('ready to accept connections');i++)await delay(20);
    assert.match(output.toLowerCase(),/ready to accept connections/);
    redis=new Redis(socket);await new Promise(resolve=>redis.once('ready',resolve));
    await admin.query(`CREATE SCHEMA ${schema}`);pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`,max:15});
    const migrations=new URL('../../../packages/db/migrations/',import.meta.url);
    for(const file of (await readdir(migrations)).filter(f=>f.endsWith('.sql')).sort())await pool.query(await readFile(new URL(file,migrations),'utf8'));
    process.env.PAPER_DYNAMIC_MARKETS_ENABLED='true';process.env.PAPER_PRIVATE_UPDATES_ENABLED='true';process.env.REDIS_URL=socket;process.env.NODE_ENV='development';delete process.env.USDG_MINT;
    const tokenFor=configurePrivyFixture();app=createApp(pool);app.log.level='silent';
    const call=async(method,url,subject,payload,key,status=200)=>{const r=await app.inject({method,url,payload,headers:{...(subject?{authorization:`Bearer ${tokenFor(subject)}`} : {}),...(key?{'idempotency-key':key}:{})}});assert.equal(r.statusCode,status,r.body);return r.json();};
    await pool.query('INSERT INTO market_token_metadata(mint,payload) VALUES($1,$2)',[mint,metadata]);
    let instrument;
    await t.test('concurrent mint resolution retains one identity, legacy IDs and administrative state',async()=>{
      const rows=await Promise.all(Array.from({length:20},()=>registerInstrument(pool,metadata)));
      assert.equal(new Set(rows.map(r=>r.id)).size,1);instrument=rows[0];assert.equal(instrument.id,`solana:${mint}`);
      assert.equal((await pool.query('SELECT id FROM instruments WHERE mint_address=$1',[mint])).rowCount,1);
      await assert.rejects(registerInstrument(pool,{...metadata,decimals:9}),e=>e.code==='mint_metadata_conflict');
      await assert.rejects(registerInstrument(pool,{...metadata,mint:'1'.repeat(44)}),e=>e.code==='invalid_mint');
      const sol=(await registeredInstruments(pool,['SOL']))[0];assert.equal((await registerInstrument(pool,{...metadata,mint:sol.mint,decimals:9})).id,'SOL');
      await pool.query("UPDATE instruments SET active=false WHERE id=$1",[instrument.id]);
      assert.equal((await registerInstrument(pool,metadata)).active,false);await pool.query('UPDATE instruments SET active=true WHERE id=$1',[instrument.id]);
      const legacy={universe_mode:'LEGACY_ALLOWLIST',allowed_instruments:['SOL']};
      assert.equal(assetTradeReason(instrument,legacy,'BUY'),'asset_not_allowed');assert.equal(assetTradeReason({...instrument,active:false},legacy,'SELL',true),null);
      assert.equal(assetTradeReason({...instrument,eligibility:'DISABLED'},legacy,'SELL',true),'asset_disabled');
    });
    await t.test('RPC precision and owner conflicts fail before registration',async()=>{
      const saved=globalThis.fetch;
      globalThis.fetch=async(_url,options)=>{const request=JSON.parse(options.body);return Response.json({jsonrpc:'2.0',id:request.id,result:{context:{slot:1},value:{data:{program:'spl-token',parsed:{type:'mint',info:{decimals:9,isInitialized:true}},space:82},owner:'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',lamports:1,executable:false,rentEpoch:0}}});};
      try{await assert.rejects(validateMintMetadata(mint,6,'http://127.0.0.1:3333'),e=>e.code==='mint_metadata_conflict');}finally{globalThis.fetch=saved;}
    });
    await call('POST','/v0/captains','captain',{handle:'dynamic_captain'},null,201);
    const fund=(await call('POST','/v0/funds','captain',{name:'Dynamic trial'},randomUUID(),201)).id;
    const ctx=()=>call('GET',`/v0/funds/${fund}/trading-context?instrumentId=${encodeURIComponent(instrument.id)}`,'captain');
    let slot=800000;
    const observe=async(price='2')=>{
      slot++;const at=new Date().toISOString();
      await recordMarketPrice(pool,{instrumentId:instrument.id,mint,source:'JUPITER_PRICE_V3',priceUsd:price,priceUsdc:price,sourceBlockId:String(slot),sourceAt:at,quoteSourceBlockId:String(slot),quoteSourceAt:at,observationId:null,receivedAt:at,status:'CURRENT',reason:null},'1');
    };
    const fill=async id=>{await pool.query("UPDATE orders SET submitted_at=now()-interval '5 seconds' WHERE id=$1",[id]);await observe();assert.equal(await processOrder(pool,id),true);assert.equal((await pool.query('SELECT status FROM orders WHERE id=$1',[id])).rows[0].status,'FILLED');};
    let buy;
    await t.test('tracking warms, selected context resolves and buy persists accepted policy evidence',async()=>{
      const tracking=await call('POST',`/v1/markets/${mint}/tracking`,'captain');assert.equal(tracking.state,'WARMING');
      await observe();assert.equal((await call('POST',`/v1/markets/${mint}/tracking`,'captain')).state,'READY');
      const snapshot=await call('GET','/v0/market/prices');assert.ok(snapshot.prices.some(p=>p.instrumentId===instrument.id));
      if(snapshot.transport==='database'){assert.equal(snapshot.cursor,null);assert.equal(snapshot.firstCursor,null);}
      assert.equal((await ctx()).limits.find(l=>l.instrumentId===instrument.id).canBuy,true);
      const intent={side:'BUY',instrumentId:instrument.id,notionalUsdc:'10'},key=randomUUID();
      const preview=await call('POST',`/v0/funds/${fund}/orders/preview`,'captain',intent);assert.equal(preview.policy.allowed,true);
      buy=(await call('POST',`/v0/funds/${fund}/orders`,'captain',intent,key,202)).orderId;
      assert.equal((await call('POST',`/v0/funds/${fund}/orders`,'captain',intent,key,202)).orderId,buy);
      assert.equal((await pool.query('SELECT policy_version FROM orders WHERE id=$1',[buy])).rows[0].policy_version,1);
      await fill(buy);await processOrder(pool,buy);
      const c=await ctx();assert.equal(Number(c.cashUsdc),990);assert.equal(c.holdings.length,1);assert.ok(Number(c.holdings[0].quantity)>0);
    });
    await t.test('durable affected valuation preserves a price arriving while the fund is locked',async()=>{
      await pool.query("UPDATE paper_job_sweeps SET next_run_at=now()+interval '1 day'");
      await pool.query('DELETE FROM fund_valuation_jobs');await observe();
      assert.deepEqual((await pool.query('SELECT fund_id FROM fund_valuation_jobs')).rows.map(r=>r.fund_id),[fund]);
      const lock=await pool.connect();await lock.query('BEGIN');await lock.query('SELECT id FROM funds WHERE id=$1 FOR NO KEY UPDATE',[fund]);
      let work;
      try{
        work=processValuationJobs(pool,1);
        for(let i=0;i<50;i++){if((await pool.query('SELECT lease_token FROM fund_valuation_jobs WHERE fund_id=$1',[fund])).rows[0]?.lease_token)break;await delay(10);}
        assert.ok((await pool.query('SELECT lease_token FROM fund_valuation_jobs WHERE fund_id=$1',[fund])).rows[0].lease_token);
        await observe();await lock.query('COMMIT');await work;
        const next=(await pool.query('SELECT lease_token,generation FROM fund_valuation_jobs WHERE fund_id=$1',[fund])).rows[0];assert.ok(next);assert.equal(next.lease_token,null);
      }finally{await lock.query('ROLLBACK');lock.release();await work;}
      await Promise.all([processValuationJobs(pool,1),processValuationJobs(pool,1)]);
      assert.equal((await pool.query('SELECT * FROM fund_valuation_jobs')).rowCount,0);
      await pool.query("INSERT INTO fund_valuation_jobs(fund_id,reason,lease_token,lease_until) VALUES($1,'crashed',$2,now()-interval '1 second')",[fund,randomUUID()]);
      await processValuationJobs(pool,1);assert.equal((await pool.query('SELECT * FROM fund_valuation_jobs')).rowCount,0);
    });
    await t.test('reconciliation detects drift once, never repairs cash and retains resolved incidents',async()=>{
      assert.equal((await reconcileFund(pool,fund)).status,'HEALTHY');
      await pool.query('UPDATE funds SET cash_usdc=cash_usdc+1 WHERE id=$1',[fund]);
      const broken=await reconcileFund(pool,fund);assert.equal(broken.status,'MISMATCH');assert.deepEqual(broken.findings,['cash_ledger']);
      await reconcileFund(pool,fund);assert.equal((await pool.query('SELECT * FROM paper_reconciliation_incidents WHERE fund_id=$1',[fund])).rowCount,1);
      assert.equal(Number((await pool.query('SELECT cash_usdc FROM funds WHERE id=$1',[fund])).rows[0].cash_usdc),991);
      await pool.query('UPDATE funds SET cash_usdc=cash_usdc-1 WHERE id=$1',[fund]);assert.equal((await reconcileFund(pool,fund)).status,'HEALTHY');
      assert.ok((await pool.query('SELECT resolved_at FROM paper_reconciliation_incidents WHERE fund_id=$1',[fund])).rows[0].resolved_at);
      const health=await call('GET','/v1/me/captain/paper-health','captain');assert.equal(health.reconciliation[0].status,'HEALTHY');
    });
    await t.test('context warm readers coalesce and eligibility changes invalidate immediately',async()=>{
      await observe();await ctx();const started=performance.now();
      const readers=await Promise.all(Array.from({length:100},()=>ctx()));assert.ok(readers.every(r=>r.cashUsdc===readers[0].cashUsdc));
      console.log('100 warm authorized context readers ms',Math.round(performance.now()-started));
      await pool.query("UPDATE instruments SET eligibility='DISABLED' WHERE id=$1",[instrument.id]);assert.equal((await ctx()).limits.find(l=>l.instrumentId===instrument.id).canBuy,false);
      await pool.query("UPDATE instruments SET eligibility='ELIGIBLE' WHERE id=$1",[instrument.id]);assert.equal((await ctx()).limits.find(l=>l.instrumentId===instrument.id).canBuy,true);
      const progress=(await call('GET',`/v0/funds/${fund}/orders/${buy}`,'captain')).order.execution;assert.equal(progress.stage,'FILLED');assert.ok(progress.attempts>0);
    });
    await t.test('paused new buys still allow partial and exact sell-all with balanced immutable fills',async()=>{
      process.env.PAPER_DYNAMIC_MARKETS_ENABLED='false';await pool.query('UPDATE instruments SET active=false WHERE id=$1',[instrument.id]);
      const intent={side:'BUY',instrumentId:instrument.id,notionalUsdc:'1'};
      await call('POST',`/v0/funds/${fund}/orders`,'captain',intent,randomUUID(),422);
      let c=await ctx();assert.equal(c.limits.find(l=>l.instrumentId===instrument.id).canSell,true);
      const qty=new Amount(c.holdings[0].quantity).div(2).toFixed(6,1);
      const partial=(await call('POST',`/v0/funds/${fund}/orders`,'captain',{side:'SELL',instrumentId:instrument.id,quantity:qty},randomUUID(),202)).orderId;await fill(partial);
      c=await ctx();const all=(await call('POST',`/v0/funds/${fund}/orders`,'captain',{side:'SELL',instrumentId:instrument.id,quantity:c.holdings[0].quantity.replace(/0+$/,'').replace(/\.$/,'')},randomUUID(),202)).orderId;await fill(all);
      assert.equal((await ctx()).holdings.length,0);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM fills')).rows[0].n,3);
      assert.equal((await pool.query('SELECT event_id,a.asset_id FROM ledger_entries e JOIN ledger_accounts a ON a.id=e.account_id GROUP BY event_id,a.asset_id HAVING sum(amount)<>0')).rowCount,0);
      process.env.PAPER_DYNAMIC_MARKETS_ENABLED='true';await pool.query('UPDATE instruments SET active=true WHERE id=$1',[instrument.id]);
    });
    await t.test('v1 vault preserves 100 seed, fundraising lock, contribution terms and dynamic execution',async()=>{
      process.env.VAULT_PAPER_ENABLED='true';process.env.VAULT_TERMS_APPROVAL='locked-v1-retain-residue';
      await call('GET','/v0/me','round-captain');await call('GET','/v0/me','round-crew');
      await call('POST','/v0/me/onboarding','round-captain',{username:'dynamic_round_captain',role:'captain'});
      process.env.PAPER_DYNAMIC_MARKETS_ENABLED='false';
      const created=await call('POST','/v1/vaults','round-captain',{name:'Dynamic round',description:'Spot',fundingWindowHours:12,durationDays:7,termsVersion:1},randomUUID(),201);
      process.env.PAPER_DYNAMIC_MARKETS_ENABLED='true';
      const path=`/v1/vaults/${created.vaultId}`;
      const original=await call('GET',path);assert.equal(original.universeMode,'LEGACY_ALLOWLIST');
      const isolatedUrl=new URL(url);isolatedUrl.searchParams.set('options',`-c search_path=${schema}`);
      await promisify(execFile)(process.execPath,['scripts/enable-dynamic-paper-markets.mjs',created.vaultId],{cwd:fileURLToPath(new URL('../../../',import.meta.url)),env:{...process.env,DATABASE_URL:isolatedUrl.toString()},timeout:10000});
      const summary=await call('GET',path);assert.equal(summary.acceptedCapitalUsdc,'100.000000');assert.equal(summary.universeMode,'DYNAMIC_SPOT');
      assert.notEqual(summary.termsHash,original.termsHash);
      const amendment=(await pool.query('SELECT previous_hash FROM vault_universe_amendments WHERE fund_id=$1',[created.vaultId])).rows[0];assert.equal(amendment.previous_hash,original.termsHash);
      await assert.rejects(pool.query("UPDATE vault_rounds SET terms=jsonb_set(terms,'{captainSeedUsdc}','\"101.000000\"') WHERE fund_id=$1",[created.vaultId]),/immutable/);
      const intent={side:'BUY',instrumentId:instrument.id,notionalUsdc:'10'};
      await call('POST',`${path}/orders`,'round-captain',intent,randomUUID(),409);
      assert.equal((await call('GET','/v1/me/captain/returns?range=ALL','round-captain')).netReturnPercent,'0.000000');
      await call('POST',`${path}/contributions`,'round-crew',{amountUsdc:'900',termsHash:summary.termsHash},randomUUID(),201);
      assert.equal((await call('GET','/v1/me/captain/returns?range=ALL','round-captain')).netReturnPercent,'0.000000');
      // Travel only in disposable storage; production has no clock override.
      await pool.query('ALTER TABLE vault_rounds DISABLE TRIGGER vault_terms_immutable');
      try{await pool.query("UPDATE vault_rounds SET funding_started_at=now()-interval '13 hours',funding_closes_at=now()-interval '1 hour',trading_ends_at=now()-interval '1 hour'+interval '7 days' WHERE fund_id=$1",[created.vaultId]);}
      finally{await pool.query('ALTER TABLE vault_rounds ENABLE TRIGGER vault_terms_immutable');}
      assert.equal(await advanceVaultRound(pool,created.vaultId),true);await observe();
      const preview=await call('POST',`${path}/orders/preview`,'round-captain',intent);assert.equal(preview.policy.allowed,true);
      const order=await call('POST',`${path}/orders`,'round-captain',intent,randomUUID(),202);await fill(order.orderId);
      assert.equal((await pool.query('SELECT policy_version FROM orders WHERE id=$1',[order.orderId])).rows[0].policy_version,2);
      assert.ok(Number((await call('GET','/v1/me/captain/returns?range=ALL','round-captain')).netReturnPercent)<0);
      const context=await call('GET',`${path}/trading-context?instrumentId=${encodeURIComponent(instrument.id)}`,'round-captain');
      assert.equal(Number(context.cashUsdc),990);assert.equal(context.holdings.length,1);
      const sell=await call('POST',`${path}/orders`,'round-captain',{side:'SELL',instrumentId:instrument.id,quantity:new Amount(context.holdings[0].quantity).toFixed(6)},randomUUID(),202);await fill(sell.orderId);
      assert.equal((await call('GET',`${path}/trading-context`,'round-captain')).holdings.length,0);
      await observe();const another=await call('POST',`${path}/orders`,'round-captain',intent,randomUUID(),202);await fill(another.orderId);
      const held=await call('GET',`${path}/trading-context`,'round-captain');
      const exit=await call('POST',`${path}/orders`,'round-captain',{side:'SELL',instrumentId:instrument.id,quantity:new Amount(held.holdings[0].quantity).toFixed(6)},randomUUID(),202);
      await pool.query("UPDATE orders SET submitted_at=now()-interval '5 seconds' WHERE id=$1",[exit.orderId]);await observe('3');await processOrder(pool,exit.orderId);
      await pool.query('ALTER TABLE vault_rounds DISABLE TRIGGER vault_terms_immutable');
      try{await pool.query("UPDATE vault_rounds SET funding_started_at=now()-interval '8 days 12 hours',funding_closes_at=now()-interval '8 days',trading_ends_at=now()-interval '1 day' WHERE fund_id=$1",[created.vaultId]);}
      finally{await pool.query('ALTER TABLE vault_rounds ENABLE TRIGGER vault_terms_immutable');}
      await advanceVaultRound(pool,created.vaultId);await advanceVaultRound(pool,created.vaultId);
      const settled=(await pool.query('SELECT r.captain_fee_usdc,f.final_share_price_usdc FROM vault_rounds r JOIN funds f ON f.id=r.fund_id WHERE f.id=$1',[created.vaultId])).rows[0];
      assert.ok(Number(settled.captain_fee_usdc)>0);
      const returns=parseTradingReturns(await call('GET','/v1/me/captain/returns?range=ALL','round-captain'));
      for(const range of ['7D','30D','90D','ALL'])parseTradingReturns((await call('GET',`/v1/me/captain/performance?range=${range}`,'round-captain')).tradingReturn);
      assert.equal(returns.netReturnPercent,new Amount(settled.final_share_price_usdc).minus(1).mul(100).toFixed(6));
      assert.equal((await reconcileFund(pool,created.vaultId)).status,'HEALTHY');
      const next=await call('POST','/v1/vaults','round-captain',{name:'Sequential round',description:'Spot',fundingWindowHours:12,durationDays:7,termsVersion:1},randomUUID(),201);
      assert.equal((await call('GET','/v1/me/captain/returns?range=ALL','round-captain')).netReturnPercent,returns.netReturnPercent);
      await inTransaction(pool,async c=>{await appendFundEvent(c,next.vaultId,'valuation_unavailable',{});await c.query("INSERT INTO nav_snapshots(id,fund_id,status,priced_at,event_sequence) SELECT $2,id,'UNAVAILABLE',clock_timestamp(),event_sequence FROM funds WHERE id=$1",[next.vaultId,randomUUID()]);});
      assert.equal((await call('GET','/v1/me/captain/returns?range=ALL','round-captain')).netReturnPercent,null);

      assert.equal((await pool.query('SELECT event_id,a.asset_id FROM ledger_entries e JOIN ledger_accounts a ON a.id=e.account_id GROUP BY event_id,a.asset_id HAVING sum(amount)<>0')).rowCount,0);
    });
    await t.test('unpriced orders do not starve the twenty-first pending order',async()=>{
      const ids=[];const captain=(await pool.query('SELECT captain_id FROM funds WHERE id=$1',[fund])).rows[0].captain_id;
      for(let i=0;i<21;i++){
        const id=randomUUID();ids.push(id);await pool.query("INSERT INTO orders(id,fund_id,captain_id,idempotency_key,side,instrument_id,notional_usdc,submitted_at) VALUES($1::uuid,$2,$3,$1::text,'BUY','JTO',1,clock_timestamp()-interval '5 seconds')",[id,fund,captain]);
      }
      await processPendingOrders(pool);await processPendingOrders(pool);
      assert.equal((await pool.query('SELECT id FROM orders WHERE id=ANY($1::uuid[]) AND execution_attempts>0',[ids])).rowCount,21);
      await pool.query("UPDATE orders SET status='CANCELLED',progress_state='CANCELLED' WHERE id=ANY($1::uuid[])",[ids]);
    });
    await t.test('Captain changes are committed, scoped and revision-only',async()=>{
      const captain=(await pool.query('SELECT captain_id FROM funds WHERE id=$1',[fund])).rows[0].captain_id;
      const before=(await pool.query('SELECT revision::text FROM captain_change_state WHERE captain_id=$1',[captain])).rows[0].revision;
      await assert.rejects(inTransaction(pool,async c=>{await appendFundEvent(c,fund,'test_rollback',{});throw Error('rollback');}),/rollback/);
      assert.equal((await pool.query('SELECT revision::text FROM captain_change_state WHERE captain_id=$1',[captain])).rows[0].revision,before);
      const ws=await app.injectWS('/v0/ws'),messages=[];ws.on('message',raw=>messages.push(JSON.parse(raw.toString())));
      const wait=async predicate=>{for(let i=0;i<150;i++){const frame=messages.find(predicate);if(frame)return frame;await delay(20);}assert.fail(JSON.stringify(messages));};
      try{
        ws.send(JSON.stringify({type:'authenticate',accessToken:tokenFor('captain')}));await wait(m=>m.type==='authenticated');
        ws.send(JSON.stringify({type:'subscribe',channel:'captain.dashboard',captainId:randomUUID()}));await wait(m=>m.type==='error');
        ws.send(JSON.stringify({type:'subscribe',channel:'captain.dashboard'}));await wait(m=>m.type==='resync_required'&&m.channel==='captain.dashboard');
        await inTransaction(pool,c=>appendFundEvent(c,fund,'test_committed',{}));
        const update=await wait(m=>m.type==='captain.updated');assert.ok(BigInt(update.revision)>BigInt(before));assert.ok(!JSON.stringify(update).includes('cash'));
      }finally{ws.terminate();}
    });
    await t.test('warm history readers coalesce without upstream; jobs and provider series remain isolated',async()=>{
      const observationsBefore=(await pool.query('SELECT count(*)::int AS n FROM price_observations')).rows[0].n;
      const path=`/v1/markets/${mint}/history?range=24h&resolution=5m`;
      const h=await call('GET',path);assert.equal(h.source,'JUPITER_PRICE_V3');assert.notEqual(h.status,'COMPLETE');
      const readers=await Promise.all(Array.from({length:100},()=>call('GET',path)));assert.ok(readers.every(r=>r.seriesId===h.seriesId));
      const end=new Date(Math.floor(Date.now()/300000)*300000),start=new Date(end.getTime()-600000);
      const keys=await Promise.all(Array.from({length:20},()=>enqueueHistory(pool,instrument.id,start,end,300)));assert.equal(new Set(keys).size,1);
      const fake={source:'BIRDEYE_TOKEN_USD',fetch:async()=>[{at:start,open:'2',high:'3',low:'1',close:'2.5',volume:null,final:true}]};
      assert.equal(await processHistoryJob(pool,fake,async()=>true),true);assert.equal(await processHistoryJob(pool,fake,async()=>true),false);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM market_chart_candles')).rows[0].n,1);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM price_observations')).rows[0].n,observationsBefore);
      await call('GET',`/v1/markets/${mint}/history?range=30d&resolution=1m`,null,null,null,400);
    });
    await t.test('list reads cannot enqueue Birdeye; 24h sheet reads share one job',async()=>{
      await pool.query('DELETE FROM market_history_jobs');
      process.env.MARKET_HISTORY_PROVIDER_ENABLED='true';process.env.BIRDEYE_API_KEY='history-fixture';
      const history=new MarketHistory(pool);
      try {
        await history.read(mint,'24H');
        assert.equal((await pool.query('SELECT count(*)::int AS n FROM market_history_jobs')).rows[0].n,0);
        await Promise.all(Array.from({length:20},()=>history.read(mint,'24H',300,true)));
        assert.equal((await pool.query('SELECT count(*)::int AS n FROM market_history_jobs')).rows[0].n,1);
        await assert.rejects(history.read(mint,'7D',900,true),/24 hours/);
      } finally { await history.close();process.env.MARKET_HISTORY_PROVIDER_ENABLED='false';delete process.env.BIRDEYE_API_KEY; }
    });
    await t.test('Birdeye permits atomically enforce pacing and monthly CU reserve',async()=>{
      process.env.BIRDEYE_API_KEY='budget-fixture';process.env.BIRDEYE_HISTORY_MONTHLY_CU_BUDGET='100';
      try {
        const results=await Promise.all(Array.from({length:20},()=>historyPermit(redis,new Date('2026-10-10'))));
        assert.equal(results.filter(Boolean).length,1);
        await delay(1150);
        assert.equal(await historyPermit(redis,new Date('2026-10-10')),false);
        assert.equal(await historyPermit(redis,new Date('2026-11-01')),true);
      }finally{delete process.env.BIRDEYE_API_KEY;delete process.env.BIRDEYE_HISTORY_MONTHLY_CU_BUDGET;}
    });
    await t.test('strict history admission survives concurrent unique requests and quota waits preserve attempts',async()=>{
      await pool.query('DELETE FROM market_history_jobs');const end=new Date(Math.floor(Date.now()/300000)*300000);
      await Promise.all(Array.from({length:240},(_,i)=>enqueueHistory(pool,instrument.id,new Date(end.getTime()-(i+1)*300000),end,300)));
      assert.equal((await pool.query("SELECT * FROM market_history_jobs WHERE status IN ('PENDING','RUNNING')")).rowCount,200);
      await pool.query('DELETE FROM market_history_jobs');const key=await enqueueHistory(pool,instrument.id,new Date(end.getTime()-600000),end,300);
      let calls=0;const provider={source:'BIRDEYE_TOKEN_USD',fetch:async()=>{calls++;return [];}};
      for(let i=0;i<6;i++){await pool.query('UPDATE market_history_jobs SET next_run_at=now()');assert.equal(await processHistoryJob(pool,provider,async()=>false),false);}
      assert.equal(calls,0);assert.equal((await pool.query('SELECT attempts FROM market_history_jobs WHERE work_key=$1',[key])).rows[0].attempts,0);
      await pool.query('UPDATE market_history_jobs SET next_run_at=now()');await processHistoryJob(pool,provider,async()=>true);assert.equal(calls,1);
      assert.equal((await pool.query('SELECT empty_coverage FROM market_history_jobs WHERE work_key=$1',[key])).rows[0].empty_coverage,true);
    });
    await t.test('stored stale charts return immediately while refresh remains coalesced',async()=>{
      const history=new MarketHistory(pool),clock=Date.now;let now=clock();
      try{
        Date.now=()=>now;await history.read(mint,'24H');now+=6000;
        const readers=await Promise.all(Array.from({length:100},()=>history.read(mint,'24H')));assert.ok(readers.every(r=>r.cacheStatus==='STALE'));
        assert.equal(history.metrics.staleHits,100);assert.ok(history.metrics.builds<=2);
      }finally{Date.now=clock;await history.close();}
    });
    await t.test('chart reads retain stored provenance when Redis cannot connect',async()=>{
      const previous=process.env.REDIS_URL;process.env.REDIS_URL=join(directory,'unreachable.sock');const history=new MarketHistory(pool);
      try{const result=await history.read(mint,'24H');assert.equal(result.source,'BIRDEYE_TOKEN_USD');assert.equal(history.metrics.builds,1);}
      finally{await history.close();process.env.REDIS_URL=previous;}
    });
    await t.test('private subscriptions deny outsiders, recheck membership and resync on reconnect',async()=>{
      await call('GET','/v0/me','outsider');
      const ws=await app.injectWS('/v0/ws'),messages=[];ws.on('message',raw=>messages.push(JSON.parse(raw.toString())));
      const wait=async predicate=>{for(let n=0;n<100;n++){const m=messages.find(predicate);if(m)return m;await delay(20);}assert.fail(JSON.stringify(messages));};
      try{
        ws.send(JSON.stringify({type:'authenticate',accessToken:tokenFor('outsider')}));await wait(m=>m.type==='authenticated');
        ws.send(JSON.stringify({type:'subscribe',channel:'vault.context',vaultId:fund}));await wait(m=>m.type==='error');assert.ok(!messages.some(m=>m.vaultId===fund));
        messages.length=0;ws.send(JSON.stringify({type:'authenticate',accessToken:tokenFor('captain')}));await wait(m=>m.type==='authenticated');
        ws.send(JSON.stringify({type:'subscribe',channel:'vault.context',vaultId:fund,after:'999999999'}));await wait(m=>m.type==='resync_required');
        const revision=(await pool.query('UPDATE funds SET event_sequence=event_sequence+1 WHERE id=$1 RETURNING event_sequence::text',[fund])).rows[0].event_sequence;
        const update=await wait(m=>m.type==='vault.updated'&&m.accountingRevision===revision);assert.ok(!JSON.stringify(update).includes('cash'));
      }finally{ws.terminate();}
    });
  }finally{globalThis.fetch=originalFetch;redis?.disconnect();await app?.close();if(!app)await pool?.end();await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();server.kill('SIGTERM');await delay(100);await rm(directory,{recursive:true,force:true});for(const k of Object.keys(process.env))if(!(k in previous))delete process.env[k];Object.assign(process.env,previous);}
});
