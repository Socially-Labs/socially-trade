import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';
import { createApp } from '../dist/app.js';

test('paper history pagination and privacy', async t => {
  const connectionString = process.env.TEST_DATABASE_URL;
  assert.ok(connectionString);
  assert.match(new URL(connectionString).hostname, /^(localhost|127\.0\.0\.1|\[::1\])$/);
  process.env.NODE_ENV='development'; process.env.DEV_AUTH_TOKEN=randomUUID();
  const schema=`history_${randomUUID().replaceAll('-','')}`;
  const admin=new pg.Pool({connectionString});
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool=new pg.Pool({connectionString,options:`-c search_path=${schema}`});
  const app=createApp(pool); app.log.level='silent';
  const headers=subject=>({authorization:`Bearer ${process.env.DEV_AUTH_TOKEN}`,'x-dev-subject':`dev:${subject}`});
  async function get(url,subject,status=200){const r=await app.inject({url,headers:subject?headers(subject):{}});assert.equal(r.statusCode,status,r.body);return r.json();}
  async function all(url,key,subject){const rows=[];let cursor;do {const r=await get(`${url}?limit=17${cursor?'&after='+cursor:''}`,subject);rows.push(...r[key]);cursor=r.nextCursor;}while(cursor);return rows;}
  try {
    const dir=new URL('../../../packages/db/migrations/',import.meta.url);
    for(const f of (await readdir(dir)).filter(f=>f.endsWith('.sql')).sort())await pool.query(await readFile(new URL(f,dir),'utf8'));
    const captain=(await get('/v0/me','captain')).id;
    const other=(await get('/v0/me','other')).id;
    const crew=(await get('/v0/me','crew')).id;
    await pool.query("INSERT INTO captain_profiles(user_id,handle) VALUES($1,'history_captain'),($2,'history_other')",[captain,other]);
    const f1=randomUUID(),f2=randomUUID(),foreign=randomUUID();
    await pool.query("INSERT INTO funds(id,captain_id,name,status) VALUES($1,$4,'prior','COMPLETED'),($2,$4,'active','ACTIVE'),($3,$5,'foreign','ACTIVE')",[f1,f2,foreign,captain,other]);
    await pool.query("INSERT INTO trials(fund_id,starts_at,ends_at,seed_usdc)SELECT unnest($1::uuid[]),now(),now()+interval '30 days',1000",[[f1,f2,foreign]]);
    await pool.query("INSERT INTO orders(id,fund_id,captain_id,idempotency_key,side,instrument_id,notional_usdc,status,submitted_at) SELECT gen_random_uuid(),$1,$2,'history-'||n,'BUY','SOL',10,'CANCELLED','2026-01-01 00:00:00.000001+00' FROM generate_series(1,105)n",[f1,captain]);
    const fill=randomUUID();
    await pool.query("INSERT INTO orders(id,fund_id,captain_id,idempotency_key,side,instrument_id,notional_usdc,status,submitted_at,processed_at) VALUES($1,$2,$3,'filled','SELL','SOL',12,'FILLED',now(),now())",[fill,f2,captain]);
    const observation=randomUUID();
    await pool.query("INSERT INTO price_observations(id,instrument_id,source,price_usdc,source_at)VALUES($1,'SOL','DEV_SEED',150,now())",[observation]);
    await pool.query("INSERT INTO fills(id,order_id,observation_id,quantity,market_price_usdc,fill_price_usdc,fee_usdc,model_version)VALUES($1,$2,$3,0.08,150,149,0.012,1)",[randomUUID(),fill,observation]);
    const foreignOrder=randomUUID();
    await pool.query("INSERT INTO orders(id,fund_id,captain_id,idempotency_key,side,instrument_id,notional_usdc)VALUES($1,$2,$3,'foreign','BUY','SOL',10)",[foreignOrder,foreign,other]);
    await t.test('full fund history preserves timestamp ties beyond 100',async()=>{
      const rows=await all(`/v0/funds/${f1}/orders`,'orders');
      const expected=await pool.query('SELECT id FROM orders WHERE fund_id=$1 ORDER BY submitted_at DESC,id DESC',[f1]);
      assert.deepEqual(rows.map(x=>x.id),expected.rows.map(x=>x.id));assert.equal(new Set(rows.map(x=>x.id)).size,105);
      const empty=await get(`/v0/funds/${f1}/orders?after=${rows.at(-1).id}`);assert.deepEqual(empty.orders,[]);assert.equal(empty.nextCursor,null);
    });
    await t.test('captain timeline includes completed funds and fill details',async()=>{
      const rows=await all(`/v0/captains/${captain}/orders`,'orders');assert.equal(rows.length,106);
      assert.equal(rows[0].id,fill);assert.equal(rows[0].quantity,'0.080000000000000000');assert.equal(rows.some(x=>x.id===foreignOrder),false);
    });
    await t.test('statistics count all orders but only executed trades',async()=>{
      const s=(await get(`/v0/captains/${captain}/trade-statistics`)).statistics;
      assert.equal(s.submitted_orders,106);assert.equal(s.completed_trades,1);assert.equal(s.cancelled,105);assert.equal(s.fund_count,2);assert.equal(s.completed_sells,1);
      assert.equal(Number(s.executed_value_usdc),11.92);assert.equal(Number(s.trading_fee_usdc),0.012);
      const z=(await get(`/v0/captains/${other}/trade-statistics`)).statistics;assert.equal(z.completed_trades,0);assert.equal(z.pending,1);
    });
    await t.test('partially filled statuses count as completed trades',async()=>{
      await pool.query("UPDATE orders SET status='PARTIALLY_FILLED' WHERE id=$1",[fill]);
      const s=(await get(`/v0/captains/${captain}/trade-statistics`)).statistics;
      assert.equal(s.completed_trades,1);assert.equal(s.partially_filled,1);assert.equal(s.filled,0);
      await pool.query("UPDATE orders SET status='FILLED' WHERE id=$1",[fill]);
    });
    const joinIds=[];
    for(let n=0;n<105;n++) {const id=randomUUID();joinIds.push(id);await pool.query("INSERT INTO fund_events(id,fund_id,sequence,type,payload,recorded_at)VALUES($1,$2,$3,'crew_joined',$4,'2026-01-01 00:00:00.000001+00')",[id,f1,n+1,{userId:crew,amountUsdc:'10.000000',shares:'10'}]);}
    const payout=randomUUID();
    await pool.query("INSERT INTO fund_events(id,fund_id,sequence,type,payload)VALUES($1,$2,106,'trial_completed',$3)",[payout,f1,{payouts:[{userId:crew,payoutUsdc:'1051.000000',shares:'1050'},{userId:other,payoutUsdc:'999',shares:'999'}]}]);
    await pool.query("INSERT INTO fund_events(id,fund_id,sequence,type,payload)VALUES($1,$2,107,'crew_left',$3)",[randomUUID(),f1,{userId:other,payoutUsdc:'99',shares:'99'}]);
    await t.test('crew history includes own settlements without other payouts',async()=>{
      const rows=await all('/v0/me/crew-transactions','transactions','crew');assert.equal(rows.length,106);assert.equal(rows[0].id,payout);assert.equal(rows[0].amount_usdc,'1051.000000');assert.equal(rows[0].shares,'1050');assert.equal('payload' in rows[0],false);
      const expected=await pool.query("SELECT id FROM fund_events WHERE id=ANY($1::uuid[]) ORDER BY recorded_at DESC,id DESC",[[...joinIds,payout]]);assert.deepEqual(rows.map(x=>x.id),expected.rows.map(x=>x.id));
      assert.deepEqual((await get('/v0/me/crew-transactions','captain')).transactions,[]);
      await get('/v0/me/crew-transactions',null,401);
    });
    await t.test('own exit appears and new orders do not shift older pages',async()=>{
      const exit=randomUUID();
      await pool.query("INSERT INTO fund_events(id,fund_id,sequence,type,payload)VALUES($1,$2,108,'crew_left',$3)",[exit,f1,{userId:crew,payoutUsdc:'9.980000',shares:'10',exitCostUsdc:'0.020000'}]);
      const events=(await get('/v0/me/crew-transactions','crew')).transactions;
      assert.equal(events[0].id,exit);assert.equal(events[0].exit_cost_usdc,'0.020000');
      const first=await get(`/v0/funds/${f1}/orders?limit=17`);
      await pool.query("INSERT INTO orders(id,fund_id,captain_id,idempotency_key,side,instrument_id,notional_usdc)VALUES($1,$2,$3,'newer','BUY','SOL',10)",[randomUUID(),f1,captain]);
      const rows=[...first.orders];let cursor=first.nextCursor;
      while(cursor){const r=await get(`/v0/funds/${f1}/orders?limit=17&after=${cursor}`);rows.push(...r.orders);cursor=r.nextCursor;}
      assert.equal(rows.length,105);assert.equal(new Set(rows.map(x=>x.id)).size,105);
    });
    await t.test('invalid and foreign cursors and limits reject',async()=>{
      for(const suffix of ['?limit=0','?limit=101','?after=nope','?extra=1']) await get(`/v0/funds/${f1}/orders${suffix}`,null,400);
      await get(`/v0/funds/${f1}/orders?after=${foreignOrder}`,null,400);
      await get(`/v0/captains/${captain}/orders?after=${foreignOrder}`,null,400);
      await get(`/v0/me/crew-transactions?after=${joinIds[0]}`,'other',400);
      await get(`/v0/captains/${randomUUID()}/trade-statistics`,null,404);
    });
  } finally {await app.close();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
});
