import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { readdir,readFile,mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const WebSocket=createRequire(require.resolve('@fastify/websocket'))('ws');
import { createApp } from '../dist/app.js';
import { configurePrivyFixture } from './privy-fixture.mjs';
import { processOrder } from '../../worker/dist/orders.js';
import { reconcilePaperUser,reconcileFund } from '../../worker/dist/reconciliation.js';
import { recordMarketPrice,unavailable } from '../../ingestor/dist/ingest.js';
import { supportedTokens } from '../../../packages/market-data/dist/catalog.js';
import { ConnectionLeases } from '../dist/connection-leases.js';
import { freshPaperPrice,paperPolicy } from '../../../packages/domain/dist/index.js';
import { paperObservation,serviceHeartbeat } from '../../../packages/db/dist/index.js';

async function eventually(fn){for(let i=0;i<60;i++){const value=await fn();if(value)return value;await delay(25);}throw new Error('Condition did not become true');}
test('paper production invariants with Postgres and shared Redis admission',{timeout:60000},async t=>{
 const connectionString=process.env.TEST_DATABASE_URL;assert.ok(connectionString);assert.match(new URL(connectionString).hostname,/^(localhost|127\.0\.0\.1|\[::1\])$/);
 process.env.NODE_ENV='development';delete process.env.USDG_MINT;delete process.env.REDIS_URL;process.env.DEV_PRICE_SEED_ENABLED='true';process.env.PAPER_PRIVATE_UPDATES_ENABLED='true';process.env.PAPER_WS_HEARTBEAT_MS='200';process.env.ADMIN_LOGS_TOKEN='local-production-test';process.env.CORS_ORIGINS='https://allowed.example,https://forbidden.example';
 const tokenFor=configurePrivyFixture(),schema=`paper_production_${randomUUID().replaceAll('-','')}`;
 const admin=new pg.Pool({connectionString});await admin.query(`CREATE SCHEMA ${schema}`);
 const pool=new pg.Pool({connectionString,options:`-c search_path=${schema}`,max:12});
 let app,redis,redisDir;const sockets=[];const controllers=[];const limiters=[];
 const request=async(method,url,subject,payload,key,expected=200)=>{const r=await app.inject({method,url,payload,headers:{...(subject?{authorization:`Bearer ${tokenFor(subject)}`} :{}),...(key?{'idempotency-key':key}:{})}});assert.equal(r.statusCode,expected,`${method} ${url}: ${r.body}`);return r.json();};
 let fund,users;
 const seed=async(price='100',age=0)=>pool.query(`INSERT INTO price_observations(id,instrument_id,source,price_usdc,source_at,received_at) VALUES($1,'SOL','DEV_SEED',$2,now()-($3::int*interval '1 millisecond'),now())`,[randomUUID(),price,age]);
 const submit=(side,body,key=randomUUID(),expected=202)=>request('POST',`/v0/funds/${fund}/orders`,'captain',{side,instrumentId:'SOL',...body},key,expected);
 const cancel=id=>request('POST',`/v0/funds/${fund}/orders/${id}/cancel`,'captain');
 const detail=id=>request('GET',`/v0/funds/${fund}/orders/${id}`,'captain');
 const age=id=>pool.query("UPDATE orders SET submitted_at=now()-interval '4 seconds' WHERE id=$1",[id]);
 try{
  const dir=new URL('../../../packages/db/migrations/',import.meta.url);for(const f of(await readdir(dir)).filter(f=>f.endsWith('.sql')).sort())await pool.query(await readFile(new URL(f,dir),'utf8'));
  app=createApp(pool);app.log.level='silent';
  users={};for(const subject of ['captain','crew','outsider'])users[subject]=(await request('GET','/v0/me',subject)).id;
  await request('POST','/v0/captains','captain',{handle:'production_captain'},undefined,201);
  fund=(await request('POST','/v0/funds','captain',{name:'Production invariants'},randomUUID(),201)).id;
  await request('POST',`/v0/funds/${fund}/joins`,'crew',{amountUsdc:'100'},randomUUID(),201);
  await pool.query('UPDATE fund_policy_versions SET max_order_bps=10000,max_position_bps=10000 WHERE fund_id=$1',[fund]);await seed();
  await t.test('concurrent buys reserve available cash, retries reserve once and exits cannot consume it',async()=>{
   const responses=await Promise.all([1,2].map(()=>app.inject({method:'POST',url:`/v0/funds/${fund}/orders`,headers:{authorization:`Bearer ${tokenFor('captain')}`,'idempotency-key':randomUUID()},payload:{side:'BUY',instrumentId:'SOL',notionalUsdc:'700'}})));
   assert.deepEqual(responses.map(r=>r.statusCode).sort(),[202,422]);
   const order=responses.find(r=>r.statusCode===202).json();
   const context=await request('GET',`/v0/funds/${fund}/trading-context`,'captain');assert.equal(context.availableCashUsdc,'400.000000');assert.equal(context.reservedCashUsdc,'700.000000');
   const preview=await request('POST',`/v0/funds/${fund}/orders/preview`,'captain',{side:'BUY',instrumentId:'SOL',notionalUsdc:'700'});assert.equal(preview.policy.reason,'insufficient_cash');
   assert.equal((await request('POST',`/v0/funds/${fund}/exits`,'crew',{shares:'1'},randomUUID(),409)).error,'orders_pending');
   await cancel(order.orderId);
   const key=randomUUID(),first=await submit('BUY',{notionalUsdc:'100'},key);assert.deepEqual(await submit('BUY',{notionalUsdc:'100'},key),first);
   assert.equal(Number((await pool.query("SELECT sum(reserved_cash_usdc) AS cash FROM orders WHERE fund_id=$1 AND status='PENDING'",[fund])).rows[0].cash),100);
   await age(first.orderId);await seed();assert.equal(await processOrder(pool,first.orderId),true);assert.equal((await detail(first.orderId)).order.execution.stage,'FILLED');
   assert.equal((await reconcileFund(pool,fund)).status,'HEALTHY');
  });
  await t.test('sell reservations protect tokens and preserve a deterministic realized cost basis',async()=>{
   const first=await submit('SELL',{quantity:'0.75'});
   const second=await submit('SELL',{quantity:'0.75'},randomUUID(),422);assert.equal(second.error,'insufficient_position');
   await age(first.orderId);await seed();assert.equal(await processOrder(pool,first.orderId),true);
   const filled=(await detail(first.orderId)).order;assert.equal(filled.status,'FILLED');assert.ok(filled.realized_pnl_usdc!==null);assert.ok(Number(filled.cost_basis_sold_usdc)>0);
   assert.deepEqual(filled.model_parameters,{spreadBps:paperPolicy.spreadBps,feeBps:paperPolicy.feeBps,impactBpsPerThousand:paperPolicy.impactBpsPerThousand,maxImpactBps:paperPolicy.maxImpactBps});
   assert.equal((await reconcileFund(pool,fund)).status,'HEALTHY');
   const pending=await submit('SELL',{notionalUsdc:'10'});await age(pending.orderId);await seed('50');assert.equal(await processOrder(pool,pending.orderId),true);
   assert.equal((await detail(pending.orderId)).order.reject_reason,'reservation_exceeded');await seed();
  });
  await t.test('all order/event reads enforce authentication and membership, raw payload is redacted',async()=>{
   const id=(await pool.query('SELECT id FROM orders WHERE fund_id=$1 LIMIT 1',[fund])).rows[0].id;
   for(const suffix of [`/orders/${id}`,'/orders','/events','/events/stream']){
    await request('GET',`/v0/funds/${fund}${suffix}`,undefined,undefined,undefined,401);
    await request('GET',`/v0/funds/${fund}${suffix}`,'outsider',undefined,undefined,403);
   }
   await request('GET',`/v0/captains/${users.captain}/orders`,undefined,undefined,undefined,401);
   const events=(await request('GET',`/v0/funds/${fund}/events`,'crew')).events;
   assert.ok(events.length>0);assert.ok(events.every(e=>!('userId' in e.payload)&&!('payouts' in e.payload)));
  });
  await t.test('quiet repeated confirmation can fill, unavailable and stale source marks cannot',async()=>{
   delete process.env.DEV_PRICE_SEED_ENABLED;
   const token=supportedTokens.find(t=>t.id==='SOL'),sourceAt=new Date(Date.now()-10000).toISOString();
   const mark={instrumentId:'SOL',mint:token.mint,priceUsd:'100',priceUsdc:'100',source:'JUPITER_PRICE_V3',sourceBlockId:'700',sourceAt,quoteSourceBlockId:'700',quoteSourceAt:sourceAt,receivedAt:sourceAt,observationId:null,status:'CURRENT',reason:null};
   await recordMarketPrice(pool,mark,'1');
   const first=await submit('BUY',{notionalUsdc:'10'});await age(first.orderId);assert.equal(await processOrder(pool,first.orderId),false);
   const before=(await pool.query("SELECT id,received_at FROM price_observations WHERE source='JUPITER_PRICE_V3'")).rows[0];
   await recordMarketPrice(pool,{...mark,receivedAt:new Date().toISOString()},'1');assert.equal(await processOrder(pool,first.orderId),true);
   const after=(await pool.query('SELECT received_at,last_confirmed_at FROM price_observations WHERE id=$1',[before.id])).rows[0];assert.equal(after.received_at.getTime(),before.received_at.getTime());assert.ok(after.last_confirmed_at>after.received_at);
   const second=await submit('BUY',{notionalUsdc:'10'});await age(second.orderId);await recordMarketPrice(pool,unavailable('upstream_down',token));assert.equal(await paperObservation(pool,'SOL'),null);assert.equal(await processOrder(pool,second.orderId),false);
   await pool.query("UPDATE orders SET submitted_at=now()-interval '3 minutes' WHERE id=$1",[second.orderId]);assert.equal(await processOrder(pool,second.orderId),true);assert.equal((await detail(second.orderId)).order.reject_reason,'order_expired');
   const stale={...mark,sourceAt:new Date(Date.now()-paperPolicy.priceMaxAgeMs-1000).toISOString(),sourceBlockId:'701',receivedAt:new Date().toISOString()};
   assert.equal(freshPaperPrice(stale.sourceAt,stale.receivedAt),false);
   await pool.query("UPDATE price_observations SET source_at=now()-interval '1 hour',last_confirmed_at=now() WHERE id=$1",[before.id]);assert.equal(await paperObservation(pool,'SOL'),null);
   process.env.DEV_PRICE_SEED_ENABLED='true';await seed();
  });
  await t.test('both user cash projections reconcile independently without automatic repair',async()=>{
   assert.equal((await reconcilePaperUser(pool,users.captain)).status,'HEALTHY');
   await pool.query('UPDATE users SET paper_cash=paper_cash+1,vault_paper_cash=vault_paper_cash+2 WHERE id=$1',[users.captain]);
   const bad=await reconcilePaperUser(pool,users.captain);assert.deepEqual(bad.findings.sort(),['paper_cash_ledger','vault_paper_cash_ledger']);
   await reconcilePaperUser(pool,users.captain);assert.equal((await pool.query('SELECT 1 FROM paper_user_reconciliation_incidents WHERE user_id=$1 AND resolved_at IS NULL',[users.captain])).rowCount,1);
   await pool.query('UPDATE users SET paper_cash=paper_cash-1,vault_paper_cash=vault_paper_cash-2 WHERE id=$1',[users.captain]);assert.equal((await reconcilePaperUser(pool,users.captain)).status,'HEALTHY');
  });
  await t.test('database lock and statement budgets return explicit retryable errors',async()=>{
   const client=await pool.connect();await client.query('BEGIN');await client.query('SELECT id FROM funds WHERE id=$1 FOR NO KEY UPDATE',[fund]);
   process.env.DB_LOCK_TIMEOUT_MS='30';try{const r=await submit('BUY',{notionalUsdc:'10'},randomUUID(),503);assert.equal(r.error,'lock_timeout');}finally{delete process.env.DB_LOCK_TIMEOUT_MS;await client.query('ROLLBACK');client.release();}
   // A query timeout is mapped without exposing SQL details.
   const fail=async()=>{const e=new Error('query details');e.code='57014';throw e;};const original=pool.query.bind(pool);pool.query=fail;
   try{const r=await request('GET','/v0/me','captain',undefined,undefined,503);assert.equal(r.error,'query_timeout');}finally{pool.query=original;}
  });
  await t.test('Redis leases enforce caps across instances and release admission',async()=>{
   const port=await new Promise(resolve=>{const server=createServer();server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port));});});
   redisDir=await mkdtemp(join(tmpdir(),'paper-admission-'));redis=spawn('redis-server',['--bind','127.0.0.1','--port',String(port),'--save','','--appendonly','no','--dir',redisDir],{stdio:'ignore'});
   process.env.REDIS_URL=`redis://127.0.0.1:${port}`;process.env.PAPER_SSE_MAX_CONNECTIONS='1';
   const one=new ConnectionLeases(()=>pool,'sse'),two=new ConnectionLeases(()=>pool,'sse');limiters.push(one,two);
   const lease=await eventually(async()=>{try{return await one.acquire('127.0.0.1',users.captain);}catch{return null;}});
   await assert.rejects(two.acquire('127.0.0.2',users.crew),e=>e.code==='connection_limit');assert.equal(await lease.renew(),true);await lease.release();
   const next=await two.acquire('127.0.0.2',users.crew);await next.release();
   const redisClient=two.redis;const lost=await two.acquire('127.0.0.2',users.crew);await redisClient.flushdb();assert.equal(await lost.renew(),false);await lost.release();
  });
  await t.test('readiness requires database, Redis and fresh completed service cycles; metrics are protected',async()=>{
   await request('GET','/health',undefined,undefined,undefined,503);
   await serviceHeartbeat(pool,'worker')();await serviceHeartbeat(pool,'ingestor')();
   await eventually(async()=>{const r=await app.inject({url:'/ready'});return r.statusCode===200;});
   await pool.query("UPDATE paper_service_heartbeats SET completed_at=now()-interval '10 minutes' WHERE service='worker'");assert.equal((await request('GET','/health',undefined,undefined,undefined,503)).checks.worker,false);
   await request('GET','/admin/paper-trading/health',undefined,undefined,undefined,401);
   await request('GET','/admin/paper-trading/metrics',undefined,undefined,undefined,401);
   const headers={authorization:`Bearer ${process.env.ADMIN_LOGS_TOKEN}`};
   const health=await app.inject({url:'/admin/paper-trading/health',headers});assert.equal(health.statusCode,200);
   const metrics=health.json().requestMetrics;assert.equal(metrics.bucketSemantics,'NON_CUMULATIVE');assert.equal(metrics.boundsMs.at(-1),null);
   for(const series of Object.values(metrics.series))assert.equal(series.buckets.reduce((a,b)=>a+b,0),series.count);
   assert.equal(health.json().capacity.asset_limit,paperPolicy.trackedAssetLimit);
   const exported=await app.inject({url:'/admin/paper-trading/metrics',headers});assert.equal(exported.statusCode,200);assert.match(exported.body,/# TYPE socially_paper_request_duration_seconds histogram/);assert.match(exported.body,/le="\+Inf"/);
  });
  await t.test('SSE resumes after Last-Event-ID, caps connections and omits membership fields',async()=>{
   await app.listen({host:'127.0.0.1',port:0});const base=`http://127.0.0.1:${app.server.address().port}`;
   const events=(await request('GET',`/v0/funds/${fund}/events`,'captain')).events;const after=events[0].sequence;
   const controller=new AbortController();controllers.push(controller);
   const response=await fetch(`${base}/v0/funds/${fund}/events/stream?after=999999`,{headers:{authorization:`Bearer ${tokenFor('captain')}`,'last-event-id':after},signal:controller.signal});assert.equal(response.status,200);
   const reader=response.body.getReader();let chunk='';await eventually(async()=>{chunk+=new TextDecoder().decode((await reader.read()).value);return chunk.includes('event: fund-event');});
   assert.ok(chunk.includes(`id: ${events[1].sequence}`));assert.ok(!chunk.includes('userId'));assert.ok(!chunk.includes('payouts'));
   const second=await fetch(`${base}/v0/funds/${fund}/events/stream`,{headers:{authorization:`Bearer ${tokenFor('crew')}`}});assert.equal(second.status,429);await second.body.cancel();controller.abort();
  });
  await t.test('websocket origin/auth boundaries, actual errors, failed notifications and independent pings',async()=>{
   const origin=`ws://127.0.0.1:${app.server.address().port}`;
   await request('GET','/v1/vaults/ws',undefined,undefined,undefined,401);
   process.env.WS_ALLOWED_ORIGINS='https://allowed.example';
   const rejected=new WebSocket(`${origin}/v0/ws`,{origin:'https://forbidden.example'});sockets.push(rejected);const status=await new Promise(resolve=>{rejected.on('unexpected-response',(_req,res)=>{res.resume();resolve(res.statusCode);});rejected.on('error',()=>{});});assert.equal(status,403);
   const socket=new WebSocket(`${origin}/v0/ws`,{origin:'https://allowed.example'});sockets.push(socket);socket.on('error',()=>{});const messages=[];let pings=0;socket.on('message',raw=>messages.push(JSON.parse(raw)));socket.on('ping',()=>pings++);await new Promise((resolve,reject)=>{socket.once('open',resolve);socket.once('error',reject);});
   socket.send(JSON.stringify({type:'subscribe',channel:'market.prices',instruments:[]}));await eventually(()=>messages.find(m=>m.code==='invalid_instruments'));
   socket.send(JSON.stringify({type:'authenticate',accessToken:tokenFor('captain')}));await eventually(()=>messages.find(m=>m.type==='authenticated'));
   await pool.query('ALTER TABLE notifications RENAME TO unavailable_notifications');try{
    socket.send(JSON.stringify({type:'subscribe',channel:'account.notifications'}));await eventually(()=>messages.find(m=>m.type==='stream_unavailable'&&m.channel==='account.notifications'));assert.ok(pings>0);
   }finally{await pool.query('ALTER TABLE unavailable_notifications RENAME TO notifications');}
   socket.close();delete process.env.WS_ALLOWED_ORIGINS;
  });
 }finally{
  for(const controller of controllers)controller.abort();for(const socket of sockets)socket.terminate();for(const limiter of limiters)limiter.close();
  if(app)await app.close();else await pool.end();if(redis&&redis.exitCode===null){const exited=new Promise(resolve=>redis.once('exit',resolve));redis.kill('SIGTERM');await exited;}if(redisDir)await rm(redisDir,{recursive:true,force:true});
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();
 }
});
