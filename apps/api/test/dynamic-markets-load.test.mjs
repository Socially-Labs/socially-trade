import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID,createHash} from 'node:crypto';
import {readdir,readFile,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';import {tmpdir} from 'node:os';import {spawn} from 'node:child_process';import {setTimeout as delay} from 'node:timers/promises';
import pg from 'pg';import {Redis} from 'ioredis';import {Keypair} from '@solana/web3.js';
import {createApp} from '../dist/app.js';import {configurePrivyFixture} from './privy-fixture.mjs';
test('bounded authenticated workload matrix with independent user and mint counts',{timeout:120000},async()=>{
 const url=process.env.TEST_DATABASE_URL,admin=new pg.Pool({connectionString:url}),schema=`dynamic_load_${randomUUID().replaceAll('-','')}`;
 const dir=await mkdtemp(join(tmpdir(),'dynamic-load-')),socket=join(dir,'redis.sock'),server=spawn('redis-server',['--port','0','--unixsocket',socket,'--save','','--appendonly','no','--dir',dir],{stdio:['ignore','pipe','pipe']});
 let output='';server.stdout.on('data',c=>output+=c);server.stderr.on('data',c=>output+=c);
 let pool,app,redis;const originalFetch=globalThis.fetch,old={...process.env};let queries=0,dbMs=0;
 const results=[];let upstreamCalls=0;
 try{
  for(let i=0;i<100&&!output.toLowerCase().includes('ready to accept connections');i++)await delay(20);assert.match(output,/Ready to accept connections/i);
  redis=new Redis(socket);await new Promise(r=>redis.once('ready',r));
  await admin.query(`CREATE SCHEMA ${schema}`);pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`,max:10});
  const migrations=new URL('../../../packages/db/migrations/',import.meta.url);for(const f of(await readdir(migrations)).filter(f=>f.endsWith('.sql')).sort())await pool.query(await readFile(new URL(f,migrations),'utf8'));
  process.env.PAPER_DYNAMIC_MARKETS_ENABLED='true';process.env.PAPER_PRIVATE_UPDATES_ENABLED='true';process.env.REDIS_URL=socket;delete process.env.USDG_MINT;process.env.NODE_ENV='development';
  globalThis.fetch=async()=>{upstreamCalls++;throw new Error('Unexpected upstream request in cached workload');};
  const tokenFor=configurePrivyFixture();app=createApp(pool);app.log.level='silent';
  // Explicit fixtures: never contact a provider, seed executable fills, or claim live capacity.
  const tokens=Array.from({length:500},(_,i)=>({mint:Keypair.generate().publicKey.toBase58(),symbol:`T${i}`,name:`Fixture ${i}`,decimals:6,icon:null,schemaVersion:2,stats:{},verified:null,suspicious:null,usdPrice:null,liquidityUsd:null,volume24hUsd:null,change1h:null,change24h:null,providerUpdatedAt:null}));
  await pool.query(`INSERT INTO instruments(id,symbol,mint_address,decimals) SELECT 'solana:'||(value->>'mint'),value->>'symbol',value->>'mint',6 FROM jsonb_array_elements($1::jsonb)`,[JSON.stringify(tokens)]);
  await pool.query(`INSERT INTO market_token_metadata(mint,payload) SELECT value->>'mint',value FROM jsonb_array_elements($1::jsonb)`,[JSON.stringify(tokens)]);
  const users=[];for(let i=0;i<100;i++){
   const actor=randomUUID(),fund=randomUUID(),subject=`load${i}`;users.push({actor,fund,subject,token:tokenFor(subject)});
   await pool.query("INSERT INTO users(id,auth_subject,display_name,role,username) VALUES($1,$2,'Fixture','captain',$3)",[actor,`did:privy:${subject}`,`load_${i}`]);
   await pool.query("INSERT INTO funds(id,captain_id,name,cash_usdc,total_shares) VALUES($1,$2,'Load fixture',1000,1000)",[fund,actor]);
   await pool.query("INSERT INTO trials(fund_id,starts_at,ends_at,seed_usdc) VALUES($1,now(),now()+interval '1 day',1000)",[fund]);
   await pool.query("INSERT INTO fund_policy_versions(fund_id,version,max_order_bps,max_position_bps,drawdown_breaker_bps,allowed_instruments,effective_at,universe_mode) VALUES($1,1,1000,2500,3000,ARRAY['SOL'],now(),'DYNAMIC_SPOT')",[fund]);
   await pool.query("INSERT INTO positions(fund_id,instrument_id,quantity,cost_basis_usdc) VALUES($1,$2,1,1)",[fund,`solana:${tokens[i].mint}`]);
   await pool.query("INSERT INTO orders(id,fund_id,captain_id,idempotency_key,side,instrument_id,notional_usdc,policy_version) VALUES($1,$2,$3,$4,'BUY',$5,1,1)",[randomUUID(),fund,actor,randomUUID(),`solana:${tokens[i].mint}`]);
  }
  for(const token of tokens)await redis.set(`socially:market:search:${createHash('sha256').update(token.mint).digest('hex')}`,JSON.stringify([token]),'EX',300);
  await app.inject({method:'GET',url:`/v0/funds/${users[0].fund}/trading-context`,headers:{authorization:`Bearer ${users[0].token}`}});
  await delay(50);
  // Count pool and transaction queries, after pool acquisition.
  const wrap=client=>{const original=client.query.bind(client);client.query=(...args)=>{const start=performance.now();queries++;const done=()=>dbMs+=performance.now()-start;const callback=args.at(-1);if(typeof callback==='function')args[args.length-1]=(...values)=>{done();return callback(...values);};const promise=original(...args);if(promise?.then)return promise.finally(done);return promise;};};
  pool.on('connect',wrap);
  // Existing idle clients need instrumentation once too.
  for(const client of pool._clients)wrap(client);
  for(const n of [5,10,20,50,100])for(const distinct of [10,50,100,500])for(const scenario of ['shared-browsing','token-details','holdings','pending-orders','diverse-searches','cold-charts']){
   const selected=users.slice(0,n),requestCount=scenario==='shared-browsing'?n:Math.max(n,distinct),latencies=[],q0=queries,d0=dbMs,cpu=process.cpuUsage();let peakWaiting=0;
   const timer=setInterval(()=>peakWaiting=Math.max(peakWaiting,pool.waitingCount),1);
   const responses=await Promise.all(Array.from({length:requestCount},async(_,i)=>{const user=selected[i%n];
    const token=tokens[(i*7)%distinct];let path;
    if(scenario==='shared-browsing')path='/v0/market/tokens';
    if(scenario==='token-details')path=`/v0/market/tokens/${token.mint}`;
    if(scenario==='holdings'||scenario==='pending-orders')path=`/v0/funds/${user.fund}/trading-context?instrumentId=${encodeURIComponent(`solana:${token.mint}`)}`;
    if(scenario==='diverse-searches')path=`/v0/market/tokens?query=${token.mint}`;
    if(scenario==='cold-charts')path=`/v1/markets/${token.mint}/history?range=24h&resolution=5m`;
    const start=performance.now(),r=await app.inject({method:'GET',url:path,headers:{authorization:`Bearer ${user.token}`}});latencies.push(performance.now()-start);return r.statusCode;
   }));clearInterval(timer);latencies.sort((a,b)=>a-b);
   const percentile=p=>Number(latencies[Math.min(requestCount-1,Math.ceil(requestCount*p)-1)].toFixed(2));
   const cpuUsed=process.cpuUsage(cpu);
   results.push({users:n,requests:requestCount,requestedUniverse:distinct,distinctRequestedMints:scenario==='shared-browsing'?0:new Set(Array.from({length:requestCount},(_,i)=>tokens[(i*7)%distinct].mint)).size,scenario,p50:percentile(.5),p95:percentile(.95),p99:percentile(.99),queryCount:queries-q0,dbExecutionMs:Number((dbMs-d0).toFixed(2)),peakPoolWaiting:peakWaiting,statusCounts:responses.reduce((a,s)=>(a[s]=(a[s]??0)+1,a),{}),cpuMs:(cpuUsed.user+cpuUsed.system)/1000,rssBytes:process.memoryUsage().rss,extraUpstreamCalls:upstreamCalls});
   assert.ok(responses.every(s=>s===200 || scenario==='cold-charts' && s===503),JSON.stringify({scenario,responses}));
   assert.equal(upstreamCalls,0);
  }
  const sockets=[];let socketEvidence;
  try{
   const connected=await Promise.all(users.map(async user=>{
    const ws=await app.injectWS('/v0/ws'),messages=[];sockets.push(ws);ws.on('message',raw=>messages.push({value:JSON.parse(raw.toString()),at:performance.now()}));
    const wait=async predicate=>{for(let i=0;i<150;i++){const item=messages.find(m=>predicate(m.value));if(item)return item;await delay(20);}assert.fail('Private socket did not converge');};
    ws.send(JSON.stringify({type:'authenticate',accessToken:user.token}));await wait(m=>m.type==='authenticated');
    ws.send(JSON.stringify({type:'subscribe',channel:'vault.context',vaultId:user.fund}));await wait(m=>m.type==='resync_required');ws.send(JSON.stringify({type:'subscribe',channel:'captain.dashboard'}));await wait(m=>m.type==='resync_required'&&m.channel==='captain.dashboard');return {wait,messages};
   }));
   const q0=queries;await delay(2000);const idleQueries=queries-q0;
   const start=performance.now();await pool.query('UPDATE funds SET event_sequence=event_sequence+1 WHERE id=ANY($1::uuid[])',[users.map(u=>u.fund)]);
   await pool.query("INSERT INTO fund_events(id,fund_id,sequence,type,payload) SELECT gen_random_uuid(),id,event_sequence,'load_invalidation','{}'::jsonb FROM funds WHERE id=ANY($1::uuid[])",[users.map(u=>u.fund)]);
   const captainUpdates=await Promise.all(connected.map(c=>c.wait(m=>m.type==='captain.updated'))),captainLags=captainUpdates.map(m=>m.at-start).sort((a,b)=>a-b);
   const updates=await Promise.all(connected.map(c=>c.wait(m=>m.type==='vault.updated'))),lags=updates.map(m=>m.at-start).sort((a,b)=>a-b);
   socketEvidence={users:100,captainUpdateDeliveryP95Ms:Number(captainLags[94].toFixed(2)),idleObservationMs:2000,idleGatewayQueries:idleQueries,updateDeliveryP95Ms:Number(lags[94].toFixed(2)),measurement:'In-process WebSocket gateway, synthetic committed revision invalidations; latency includes SQL update, excludes app rendering and device network. Client 60-second reconciliation implies 300 private resource reads/minute for 100 idle Captains versus 3600 previously; that client estimate is not a sustained device measurement.'};
   assert.ok(idleQueries<20,'Gateway must batch private scans across users');assert.equal(upstreamCalls,0);
  }finally{for(const ws of sockets)ws.terminate();}
  const report={at:new Date().toISOString(),environment:'Single API app.inject process; local Docker PostgreSQL 17, temporary Redis; synthetic metadata and auth; no live provider calls; burst requests, not sustained capacity. Cold chart concurrency is bounded and may return 503. Context cache Redis connection is primed once before the measurement. Both vault and Captain invalidation channels are subscribed in the gateway measurement. Query durations measure execution after pool acquisition; peakPoolWaiting records queue depth.',socketEvidence,priceCapacityModel:[10,50,100,500].map(mints=>({mintsIncludingQuote:mints+1,callsPerMinuteAtFiveSeconds:Math.ceil((mints+1)/50)*12})),results};
  await writeFile(new URL('../../../docs/paper-trading-load-evidence.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
  console.log(`Recorded ${results.length} workload rows; upstream requests attributable to readers=0`);
 }finally{globalThis.fetch=originalFetch;redis?.disconnect();await app?.close();if(!app)await pool?.end();await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();server.kill('SIGTERM');await delay(100);await rm(dir,{recursive:true,force:true});for(const k of Object.keys(process.env))if(!(k in old))delete process.env[k];Object.assign(process.env,old);}
});
