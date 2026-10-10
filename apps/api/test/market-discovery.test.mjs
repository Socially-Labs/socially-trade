import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readdir, readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { Redis } from 'ioredis';
import { createApp } from '../dist/app.js';
import { parseMarketQuery, rankMarkets } from '../dist/market-discovery.js';
import { parseTokenMetadata, fetchJupiterCategory } from '../../../packages/market-data/dist/tokens.js';
import { DiscoveryCache } from '../../../packages/market-data/dist/discovery.js';
import { supportedTokens } from '../../../packages/market-data/dist/catalog.js';
import { parseMarketList } from '../../../packages/contracts/dist/markets.js';

const at = () => new Date().toISOString();
const providerRow = (mint, symbol = 'SAME') => ({id:mint,symbol,name:'Token',decimals:6,usdPrice:2,updatedAt:at(),
  stats1h:{buyVolume:3,sellVolume:4,priceChange:5},stats24h:{buyVolume:30,sellVolume:40,priceChange:-5}});
test('query semantics preserve mint case and reject invalid combinations', () => {
  assert.equal(parseMarketQuery({}).feed,'supported');
  assert.equal(parseMarketQuery({query:supportedTokens[1].mint},true).query,supportedTokens[1].mint);
  for (const q of [{feed:'bad'},{feed:'trending',sort:'gainers'},{feed:'toptraded',interval:'7d'},{interval:'7d'},
    {limit:'2.1'},{limit:'51'},{tradableOnly:'1'},{minLiquidityUsd:'-1'},{minLiquidityUsd:'1000000000001'},{unknown:'x'}])
    assert.throws(()=>parseMarketQuery(q),e=>e.code==='invalid_market_query');
  assert.throws(()=>parseMarketQuery({query:' '.repeat(2)},true));
  assert.throws(()=>parseMarketQuery({query:'a'.repeat(101)},true));
});
test('normalization retains four windows, unknown quality flags and missing prices', () => {
  const t = parseTokenMetadata([providerRow(supportedTokens[1].mint)])[0];
  assert.equal(Number(t.stats['1h'].volumeUsd),7); assert.equal(Number(t.stats['24h'].volumeUsd),70);
  assert.equal(t.suspicious,null); assert.equal(t.verified,null);
  assert.equal(parseTokenMetadata([{...providerRow(t.mint),usdPrice:Infinity}])[0].usdPrice,null);
  assert.throws(()=>parseTokenMetadata([{foo:'bad'}]));
});
test('ranking appends missing and incomplete history after valid negative returns', () => {
  const row=(mint,change,coverage='COMPLETE')=>({mint,metrics:{status:'CURRENT',coverage,changePercent:change,volumeUsd:null}});
  const ranked=rankMarkets([row('c',null),row('b','-2'),row('a','-1'),row('d','99','PARTIAL')],'gainers');
  assert.deepEqual(ranked.map(t=>[t.mint,t.rank]),[['a',1],['b',2],['c',null],['d',null]]);
});
test('discovery HTTP, cache, restart, failure and cursor integration uses disposable SQL/Redis', {timeout:45000}, async t => {
  const url=process.env.TEST_DATABASE_URL; assert.ok(url); assert.match(new URL(url).hostname,/^(localhost|127\.0\.0\.1)$/);
  const schema=`discovery_${randomUUID().replaceAll('-','')}`, admin=new pg.Pool({connectionString:url});
  const directory=await mkdtemp(join(tmpdir(),'socially-discovery-')), socket=join(directory,'redis.sock');
  const server=spawn('redis-server',['--port','0','--unixsocket',socket,'--save','','--appendonly','no','--dir',directory],{stdio:['ignore','pipe','pipe']});
  let output='';server.stdout.on('data',chunk=>output+=chunk);server.stderr.on('data',chunk=>output+=chunk);
  let pool, redis, app; const originalFetch=globalThis.fetch;
  const previousEnv={...process.env};
  try {
    for(let i=0;i<100&&!output.toLowerCase().includes('ready to accept connections');i++)await delay(20);
    assert.match(output.toLowerCase(),/ready to accept connections/);
    redis=new Redis(socket);await new Promise(resolve=>redis.once('ready',resolve));
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`});
    const migrations=new URL('../../../packages/db/migrations/',import.meta.url);
    for(const file of (await readdir(migrations)).filter(f=>f.endsWith('.sql')).sort())await pool.query(await readFile(new URL(file,migrations),'utf8'));
    process.env.MARKET_DISCOVERY_V1_ENABLED='true';process.env.REDIS_URL=socket;process.env.JUP_ACC_1='fixture';delete process.env.USDG_MINT;
    for(let i=2;i<=10;i++)delete process.env[`JUP_ACC_${i}`];delete process.env.JUPITER_API_KEYS;
    const mints=['11111111111111111111111111111111','22222222222222222222222222222222','33333333333333333333333333333333'];
    let upstreamCalls=0;
    globalThis.fetch=async (input,options)=> {
      if(String(input).startsWith('https://api.jup.ag/')) {
        upstreamCalls++;assert.equal(options.headers['x-api-key'],'fixture');
        return Response.json(mints.map(m=>providerRow(m)));
      }
      return originalFetch(input,options);
    };
    app=createApp(pool);app.log.level='silent';await app.listen({host:'127.0.0.1',port:0});
    let origin=`http://127.0.0.1:${app.server.address().port}`;
    const get=async(path,status=200)=>{const res=await originalFetch(origin+path);assert.equal(res.status,status,await res.clone().text());return res.json();};
    await t.test('public supported identity, disabled flags and unavailable historical ranks',async()=>{
      const list=parseMarketList(await get('/v1/markets?limit=50'));assert.deepEqual(new Set(list.items.map(t=>t.mint)),new Set(supportedTokens.map(t=>t.mint)));
      assert.equal(list.items.find(t=>t.symbol==='USDC').tradable,false);
      const history=parseMarketList(await get('/v1/markets?sort=gainers&interval=7d'));
      assert.equal(history.rankingStatus,'UNAVAILABLE');assert.ok(history.items.every(t=>t.rank===null&&t.metrics.changePercent===null));
      await pool.query("UPDATE instruments SET active=false WHERE id='JUP'");
      const disabled=await get('/v1/markets?tradableOnly=true');assert.ok(!disabled.items.some(t=>t.symbol==='JUP'));
      await get('/v1/markets?feed=trending&sort=gainers',400);await get('/v1/markets?interval=30d&sort=volume',400);
    });
    await t.test('supported rankings change with the selected volume interval', async()=>{
      const metadata=supportedTokens.map((t,i)=>({...providerRow(t.mint),decimals:t.decimals,
        stats1h:{buyVolume:i+1,sellVolume:0,priceChange:-i},stats24h:{buyVolume:10-i,sellVolume:0,priceChange:i}}));
      for(const item of parseTokenMetadata(metadata))await pool.query('UPDATE market_token_metadata SET payload=$2,fetched_at=now() WHERE mint=$1',[item.mint,item]);
      const hour=await get('/v1/markets?interval=1h&limit=50'),day=await get('/v1/markets?interval=24h');
      assert.equal(hour.items[0].symbol,'USDC');assert.equal(day.items[0].symbol,'SOL');
      assert.equal(Number(hour.items[0].metrics.volumeUsd),5);assert.equal(Number(day.items[0].metrics.volumeUsd),10);
    });
    await t.test('many readers share one provider call and provider order survives pagination',async()=>{
      const responses=await Promise.all(Array.from({length:10},()=>get('/v1/markets?feed=toptraded&limit=2')));
      assert.equal(upstreamCalls,1);const first=parseMarketList(responses[0]);
      assert.deepEqual(first.items.map(t=>t.mint),mints.slice(0,2));assert.ok(first.items.every(t=>!t.tradable&&!t.price.usableForExecution&&t.category==='unknown'));
      const second=await get(`/v1/markets?feed=toptraded&limit=2&cursor=${encodeURIComponent(first.nextCursor)}`);
      assert.deepEqual(second.items.map(t=>[t.mint,t.rank]),[[mints[2],3]]);
      await get(`/v1/markets?feed=trending&limit=2&cursor=${encodeURIComponent(first.nextCursor)}`,400);
      const decoded=JSON.parse(Buffer.from(first.nextCursor,'base64url').toString());
      const pageKey=`socially:discovery:page:${decoded.id}:${decoded.key}`;
      const cached=JSON.parse(await redis.get(pageKey));
      cached.items[2].price.sourceAt=new Date(Date.now()-400_000).toISOString();
      await redis.set(pageKey,JSON.stringify(cached),'EX',60);
      const aged=await get(`/v1/markets?feed=toptraded&limit=2&cursor=${encodeURIComponent(first.nextCursor)}`);
      assert.equal(aged.items[0].price.status,'STALE');assert.equal(aged.items[0].price.usableForExecution,false);
      await redis.del(pageKey);
      await get(`/v1/markets?feed=toptraded&limit=2&cursor=${encodeURIComponent(first.nextCursor)}`,409);
    });
    await t.test('stored chart batches are bounded, complete and never enqueue provider work',async()=>{
      const before=(await pool.query('SELECT count(*)::int AS n FROM market_history_jobs')).rows[0].n;
      const addresses=[supportedTokens[0].mint,mints[0]];
      const path=`/v1/markets/history/batch?range=24h&mints=${addresses.join(',')}`;
      const result=await get(path);assert.equal(result.items.length,2);assert.equal(result.range,'24H');
      assert.equal(result.items[0].history.mint,addresses[0]);assert.equal(result.items[1].history,null);
      assert.equal(result.items[1].status,'UNAVAILABLE');
      await Promise.all(Array.from({length:10},()=>get(path)));
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM market_history_jobs')).rows[0].n,before);
      await get(`/v1/markets/history/batch?mints=${addresses[0]},${addresses[0]}`,400);
      await get('/v1/markets/history/batch?mints=bad',400);
      await get(`/v1/markets/history/batch?mints=${addresses[0]}&backfill=true`,400);
      await get(`/v1/markets/history/batch?range=7d&mints=${addresses[0]}`,400);
    });
    await t.test('cached HTTP latency records its local fixture conditions', async()=>{
      const times=[];const callsBefore=upstreamCalls;
      for(let i=0;i<30;i++){const start=performance.now();await get('/v1/markets?feed=toptraded');times.push(performance.now()-start);}
      times.sort((a,b)=>a-b);t.diagnostic(`Cached HTTP p95=${times[Math.ceil(times.length*.95)-1].toFixed(2)}ms; 30 sequential loopback reads, 3 candidates, one API process, disposable local SQL/Redis, fixture Jupiter; added provider requests=${upstreamCalls-callsBefore}`);
      assert.equal(upstreamCalls,callsBefore);
    });
    await t.test('API restart reads durable snapshots without fetching again',async()=>{
      await redis.del('socially:discovery:hot:toptraded:24h');
      await app.close();pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`});app=createApp(pool);app.log.level='silent';await app.listen({host:'127.0.0.1',port:0});origin=`http://127.0.0.1:${app.server.address().port}`;
      const list=await get('/v1/markets?feed=toptraded');assert.equal(list.items.length,3);assert.equal(upstreamCalls,1);
    });
    await t.test('search pagination reuses the same snapshot and rejects a different query',async()=>{
      const first=await get('/v1/markets/search?query=search-fixture&limit=2');assert.ok(first.nextCursor);
      const before=upstreamCalls;
      const next=await get(`/v1/markets/search?query=search-fixture&limit=2&cursor=${encodeURIComponent(first.nextCursor)}`);
      assert.equal(next.items.length,1);assert.equal(next.items[0].mint,mints[2]);assert.equal(upstreamCalls,before);
      await get(`/v1/markets/search?query=other-query&limit=2&cursor=${encodeURIComponent(first.nextCursor)}`,400);
    });
    await t.test('distributed leases, stale fallback, timeouts and Redis failure never manufacture freshness',async()=>{
      const cache=new DiscoveryCache(pool,redis,{}), other=new DiscoveryCache(pool,redis,{});let calls=0;
      const fetcher=async()=>{calls++;await delay(50);return parseTokenMetadata([providerRow(mints[0])]);};
      const snapshots=await Promise.all([cache.get('fixture:1h',fetcher),other.get('fixture:1h',fetcher),cache.get('fixture:1h',fetcher)]);
      assert.equal(calls,1);assert.equal(new Set(snapshots.map(s=>s.id)).size,1);
      await redis.del('socially:discovery:hot:fixture:1h');
      await pool.query("UPDATE market_discovery_feeds SET fetched_at=now()-interval '2 minutes' WHERE cache_key='fixture:1h'");
      const stale=await cache.get('fixture:1h',async()=>{throw new Error('timeout');});assert.ok(Date.now()-Date.parse(stale.fetchedAt)>60_000);
      const broken={get:async()=>{throw new Error('Redis down');},set:async()=>{throw new Error('Redis down');}};
      const fallback=await new DiscoveryCache(pool,broken,{}).get('fixture:1h',fetcher);assert.equal(fallback.fetchedAt,stale.fetchedAt);assert.equal(calls,1);
      await pool.query("UPDATE market_discovery_feeds SET fetched_at=now()-interval '6 minutes' WHERE cache_key='fixture:1h'");
      await assert.rejects(()=>cache.get('fixture:1h',async()=>{throw new Error('429');}));
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM users")).rows[0].n,0);
    });
    await t.test('provider category transport uses category paths and parses rate limit reset',async()=>{
      globalThis.fetch=async(input)=>{assert.match(String(input),/toptrending\/6h\?limit=100/);return new Response('',{status:429,headers:{'x-ratelimit-reset':'1800000000'}});};
      await assert.rejects(()=>fetchJupiterCategory('fixture','trending','6h'),e=>e.status===429&&e.resetAt===1800000000000);
      delete process.env.MARKET_DISCOVERY_V1_ENABLED;await get('/v1/markets',404);
    });
  } finally {
    globalThis.fetch=originalFetch;for(const key of Object.keys(process.env))if(!(key in previousEnv))delete process.env[key];Object.assign(process.env,previousEnv);
    await app?.close();redis?.disconnect();await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();
    if(server.exitCode===null){const stopped=new Promise(resolve=>server.once('exit',resolve));server.kill('SIGTERM');await stopped;}await rm(directory,{recursive:true,force:true});
  }
});
