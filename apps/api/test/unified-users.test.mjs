import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';
import { configurePrivyFixture } from './privy-fixture.mjs';
import { Redis } from 'ioredis';
import { UsernameIndex } from '../dist/username-index.js';
import { createApp } from '../dist/app.js';

const connectionString = process.env.TEST_DATABASE_URL;
test('unified user migration and account endpoints', { timeout: 60_000 }, async t => {
  assert.ok(connectionString, 'TEST_DATABASE_URL is required');
  assert.match(new URL(connectionString).hostname, /^(localhost|127\.0\.0\.1|\[::1\])$/);
  const originalFetch = globalThis.fetch;
  const fixture = configurePrivyFixture();
  const admin = new pg.Pool({ connectionString });
  const schema = `unified_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ connectionString, options: `-c search_path=${schema}` });
  process.env.CORS_ORIGINS = 'http://localhost:8082';
  const app = createApp(pool); app.log.level = 'silent';
  const dir = new URL('../../../packages/db/migrations/', import.meta.url);
  const files = (await readdir(dir)).filter(x => x.endsWith('.sql')).sort();
  let legacyId;
  const call = async (method, url, who, body) => app.inject({ method, url, ...(who ? { headers: { authorization: `Bearer ${await fixture(who)}` } } : {}), ...(body === undefined ? {} : { payload: body }) });
  try {
    for (const file of files.filter(x => !x.startsWith('017'))) await pool.query(await readFile(new URL(file, dir), 'utf8'));
    legacyId = randomUUID();
    await pool.query("INSERT INTO users(id,auth_subject,display_name) VALUES($1,'did:privy:legacy','Legacy')", [legacyId]);
    await pool.query("INSERT INTO captain_profiles(user_id,handle,bio,avatar_url) VALUES($1,'123_legacy','Preserved bio','https://assets.example/avatar.jpg')", [legacyId]);
    const fundId = randomUUID(), uploadId = randomUUID();
    await pool.query("INSERT INTO funds(id,captain_id,name) VALUES($1,$2,'Existing fund')", [fundId, legacyId]);
    await pool.query("INSERT INTO captain_asset_uploads(id,captain_id,kind,content_type,byte_size,staging_key) VALUES($1,$2,'avatar','image/jpeg',100,'existing')", [uploadId,legacyId]);
    await pool.query(await readFile(new URL('017_unified_users.sql',dir), 'utf8'));
    await t.test('migration preserves identity, profile, fund and upload ownership', async () => {
      const row=(await pool.query('SELECT * FROM users WHERE id=$1',[legacyId])).rows[0];
      assert.equal(row.username,'123_legacy'); assert.equal(row.role,'captain'); assert.equal(row.bio,'Preserved bio');
      assert.equal(row.avatar_url,'https://assets.example/avatar.jpg');
      assert.equal((await pool.query('SELECT captain_id FROM funds WHERE id=$1',[fundId])).rows[0].captain_id,legacyId);
      assert.equal((await pool.query('SELECT user_id FROM user_asset_uploads WHERE id=$1',[uploadId])).rows[0].user_id,legacyId);
      assert.equal((await pool.query("SELECT to_regclass('captain_profiles') AS table_name")).rows[0].table_name,null);
    });
    await t.test('bootstrap returns an unfinished server account',async()=>{
      const r=await call('POST','/v0/auth/privy','alice',{}); assert.equal(r.statusCode,200,r.body);
      assert.equal(r.json().user.username,null); assert.equal(r.json().user.role,null);
      assert.equal(r.json().user.bio,''); assert.equal(r.json().user.mode,'PAPER');
    });
    await t.test('Crew and Captain claims share uniqueness under concurrency',async()=>{
      const results=await Promise.all(['alice','bob'].map((who,i)=>call('POST','/v0/me/onboarding',who,{username:'shared_name',role:i?'captain':'crew'})));
      assert.deepEqual(results.map(r=>r.statusCode).sort(),[200,409]);
      assert.equal(results.find(r=>r.statusCode===409).json().error,'username_taken');
      const availability=await call('GET','/v0/users/username-availability?username=shared_name');
      assert.equal(availability.json().available,false);
      const alias=await call('GET','/v0/captains/handle-availability?handle=shared_name');assert.equal(alias.json().available,false);
      const loser=results[0].statusCode===409?'alice':'bob';
      const r=await call('POST','/v0/me/onboarding',loser,{username:`${loser}_name`,role:'crew'});assert.equal(r.statusCode,200,r.body);
    });
    await t.test('onboarding retries are safe and cannot replace an existing signup',async()=>{
      const user=(await call('GET','/v0/me','alice')).json();
      const r=await call('POST','/v0/me/onboarding','alice',{username:user.username,role:user.role});assert.equal(r.statusCode,200,r.body);
      const different=await call('POST','/v0/me/onboarding','alice',{username:'changed_name',role:'captain'});assert.equal(different.statusCode,409);
      const rows=await pool.query("SELECT id FROM fund_events WHERE type='paper_budget_granted'");assert.equal(rows.rowCount,2);
    });
    await t.test('signup and rename validate input and reject identity/balance fields',async()=>{
      for (const body of [{username:'12bad',role:'crew'},{username:'valid_name',role:'admin'},{username:'valid_name'},{username:'valid_name',role:'crew',paperCash:'999999'}]) {
        assert.equal((await call('POST','/v0/me/onboarding','alice',body)).statusCode,400);
      }
      assert.equal((await call('PATCH','/v0/me','alice',{paperCash:'1'})).statusCode,400);
      assert.equal((await call('PATCH','/v0/me','alice',{displayName:'   '})).statusCode,400);
      assert.equal((await call('PATCH','/v0/me',undefined,{username:'new_name'})).statusCode,401);
    });
    await t.test('profiles and renames persist without disturbing money',async()=>{
      const before=(await call('GET','/v0/me','alice')).json();
      const r=await call('PATCH','/v0/me','alice',{username:'alice_renamed',role:'captain',displayName:'Alice',bio:'New profile'});assert.equal(r.statusCode,200,r.body);
      assert.equal(r.json().paperCash.value,before.paperCash.value);
      assert.equal((await call('GET','/v0/me','alice')).json().username,'alice_renamed');
      assert.equal((await call('GET',`/v0/captains/${before.id}`)).json().handle,'alice_renamed');
      assert.equal((await call('PATCH','/v0/me','bob',{username:'alice_renamed'})).statusCode,409);
      assert.equal((await call('PATCH','/v0/me','bob',{avatarUrl:'https://external.example/fake.jpg'})).statusCode,400);
    });
    await t.test('database rejects incomplete pairs and authority remains scoped',async()=>{
      await assert.rejects(pool.query("UPDATE users SET role=NULL WHERE id=$1",[legacyId]),e=>e.code==='23514');
      const id=(await call('GET','/v0/me','alice')).json().id;
      assert.equal((await call('PATCH',`/v0/captains/${id}`,'bob',{bio:'Not mine'})).statusCode,403);
    });
    await t.test('balance and repeated bootstrap do not invalidate username index',async()=>{
      const before=(await pool.query('SELECT revision FROM username_index_state')).rows[0].revision;
      await call('POST','/v0/auth/privy','alice',{});
      await pool.query('UPDATE users SET paper_cash=paper_cash WHERE id=$1',[legacyId]);
      assert.equal((await pool.query('SELECT revision FROM username_index_state')).rows[0].revision,before);
    });
    await t.test('live Redis Bloom checks negatives, false positives, stale filters and rename recovery',async()=>{
      const redisUrl=process.env.TEST_REDIS_URL;
      assert.ok(redisUrl,'TEST_REDIS_URL is required for Bloom validation');
      const redis=new Redis(redisUrl,{connectTimeout:1000,commandTimeout:1000,maxRetriesPerRequest:0});
      redis.on('error',()=>{});
      const seen=[];
      const tracked={query:(sql,...args)=>{seen.push(sql);return pool.query(sql,...args);},connect:()=>pool.connect()};
      const index=new UsernameIndex(tracked,{warn(){}},redisUrl);
      const state=(await pool.query('SELECT instance_id,revision FROM username_index_state')).rows[0];
      const prefix=`socially:{usernames:${state.instance_id}}`;
      const filter=`${prefix}:bloom`,ready=`${prefix}:revision`;
      const wait=()=>new Promise(resolve=>setTimeout(resolve,20));
      try {
        for(let n=0;n<100;n++){
          await index.available('unused_handle');
          if(await redis.exists(ready))break;
          await wait();
        }
        assert.equal(await redis.exists(ready),1,'Lazy rebuild publishes the filter');
        seen.length=0;assert.equal(await index.available('unused_handle'),true);
        assert.ok(!seen.some(sql=>sql.includes('WHERE username =')),'Synchronized negative skips username lookup');
        await redis.call('BF.ADD',filter,'false_positive');
        seen.length=0;assert.equal(await index.available('false_positive'),true);
        assert.ok(seen.some(sql=>sql.includes('WHERE username =')),'Positive is confirmed in PostgreSQL');
        await pool.query("UPDATE users SET username='legacy_renamed' WHERE id=$1",[legacyId]);
        assert.equal(await index.available('legacy_renamed'),false,'Stale filter cannot return a false available result');
        assert.equal(await index.available('123_legacy'),true,'Old names become available after rename');
        await redis.del(filter);
        assert.equal(await index.available('alice_renamed'),false,'Missing filter falls back to SQL');
      } finally {await index.close();await redis.del(filter,ready);redis.disconnect();}
      const unavailable=new UsernameIndex(pool,{warn(){}},'redis://127.0.0.1:1');
      try {assert.equal(await unavailable.available('alice_renamed'),false);assert.equal(await unavailable.available('unused_handle'),true);}
      finally{await unavailable.close();}
    });
    await t.test('browser preflight supports bearer JSON requests only for allowed origins',async()=>{
      const r=await app.inject({method:'OPTIONS',url:'/v0/me',headers:{origin:'http://localhost:8082','access-control-request-method':'PATCH','access-control-request-headers':'authorization,content-type'}});
      assert.equal(r.statusCode,204,r.body);assert.equal(r.headers['access-control-allow-origin'],'http://localhost:8082');
      assert.equal((await app.inject({method:'GET',url:'/health',headers:{origin:'https://untrusted.example'}})).statusCode,403);
    });
  } finally { await app.close(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); globalThis.fetch = originalFetch; }
});
