import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { readdir,readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { createRequire } from 'node:module';
import pg from 'pg';
import { PublicKey } from '@solana/web3.js';
import { createApp } from '../dist/app.js';
import { incomingWalletTransfers,scanWalletNotifications,startWalletNotificationScanner } from '../dist/wallet-notifications.js';
import { deliverOutbox } from '../../worker/dist/notifications.js';
import { deliverNotificationPush } from '../../worker/dist/notification-push.js';
import { configurePrivyFixture } from './privy-fixture.mjs';
const require=createRequire(import.meta.url);
const WebSocket=createRequire(require.resolve('@fastify/websocket'))('ws'),genesis='EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',wallet='11111111111111111111111111111112';
const tx=(signer=false)=>({slot:123,meta:{err:null,preTokenBalances:[],postTokenBalances:[],innerInstructions:[]},transaction:{message:{accountKeys:[{pubkey:new PublicKey(wallet),signer}],instructions:[{program:'system',programId:new PublicKey('11111111111111111111111111111111'),parsed:{type:'transfer',info:{source:'external',destination:wallet,lamports:123456789}}}]}}});
test('receipt parser excludes failed transactions, signed swaps and arbitrary programs',()=>{
 assert.deepEqual(incomingWalletTransfers(tx(),wallet),[{index:'0',token:'SOL',amountAtomic:'123456789',decimals:9,slot:123}]);assert.deepEqual(incomingWalletTransfers(tx(true),wallet),[]);
 const failed=tx();failed.meta.err={InstructionError:[0,'failure']};assert.deepEqual(incomingWalletTransfers(failed,wallet),[]);
 const fake=tx();fake.transaction.message.instructions[0].programId=new PublicKey(wallet);assert.deepEqual(incomingWalletTransfers(fake,wallet),[]);
});
test('USDC transfers match token-account ownership when wallet is absent from account keys',()=>{
 const transfer=tx(),destination='11111111111111111111111111111113';
 transfer.transaction.message.accountKeys=[{pubkey:new PublicKey(destination),signer:false}];
 transfer.meta.postTokenBalances=[{accountIndex:0,owner:wallet,mint:'4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'}];
 transfer.transaction.message.instructions=[{program:'spl-token',programId:new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),parsed:{type:'transfer',info:{source:'external-token-account',destination,authority:'external',amount:'1'}}}];
 assert.equal(incomingWalletTransfers(transfer,wallet)[0].amountAtomic,'1');assert.equal(incomingWalletTransfers(transfer,wallet)[0].token,'USDC');
 transfer.meta.postTokenBalances[0].owner='somebody-else';assert.deepEqual(incomingWalletTransfers(transfer,wallet),[]);
});
test('durable account notifications, replay, WebSocket wakeups, push recovery and finalized receipts',{timeout:60000},async t=>{
 const connectionString=process.env.TEST_DATABASE_URL;assert.ok(connectionString);assert.match(new URL(connectionString).hostname,/^(localhost|127\.0\.0\.1|\[::1\])$/);
 process.env.NODE_ENV='development';delete process.env.REDIS_URL;process.env.WALLET_NOTIFICATIONS_ENABLED='false';process.env.NOTIFICATION_PUSH_ENABLED='true';
 const tokenFor=configurePrivyFixture(),schema=`notification_test_${randomUUID().replaceAll('-','')}`,admin=new pg.Pool({connectionString});await admin.query(`CREATE SCHEMA ${schema}`);
 const pool=new pg.Pool({connectionString,options:`-c search_path=${schema}`,max:10}),app=createApp(pool);app.log.level='silent';let socket;
 const call=async(method,url,subject,body,status=200)=>{const r=await app.inject({method,url,payload:body,headers:{authorization:`Bearer ${tokenFor(subject)}`}});assert.equal(r.statusCode,status,r.body);return r.json();};
 async function outbox(user){const event=randomUUID(),id=randomUUID(),body={userId:user,token:'SOL',amountAtomic:'123456789',decimals:9,network:'devnet'};
 await pool.query("INSERT INTO fund_events(id,type,payload) VALUES($1,'wallet_received',$2)",[event,body]);await pool.query("INSERT INTO outbox_events(id,fund_event_id,type,payload) VALUES($1,$2,'wallet_received',$3)",[id,event,body]);return {id,body};}
 try{
  const dir=new URL('../../../packages/db/migrations/',import.meta.url);for(const f of(await readdir(dir)).filter(f=>f.endsWith('.sql')).sort())await pool.query(await readFile(new URL(f,dir),'utf8'));
  const user=(await call('GET','/v0/me','recipient')).id;await call('GET','/v0/me','other');const device=randomUUID(),token='ExpoPushToken[notification_fixture_12345]';
  await t.test('account scoping, fanout retries and push device registration',async()=>{
   assert.deepEqual(await call('GET','/v0/me/wallet-notifications','recipient'),{enabled:false,watching:false,network:'devnet',address:null,lastScanAt:null});
   await call('PUT','/v0/me/wallet-notifications','recipient',{address:wallet},503);
   await call('PUT','/v0/me/notification-device','recipient',{installationId:device,token,platform:'android'});await outbox(user);await Promise.all([deliverOutbox(pool),deliverOutbox(pool)]);
   const inbox=await call('GET','/v0/me/notifications?cursorVersion=2','recipient');assert.equal(inbox.notifications.length,1);assert.equal(inbox.notifications[0].fundId,null);assert.equal(inbox.notifications[0].cursor,'1');
   assert.equal((await call('GET','/v0/me/notifications','other')).notifications.length,0);await call('GET',`/v0/me/notifications/${inbox.notifications[0].id}`,'other',undefined,404);
   assert.equal((await pool.query('SELECT * FROM notification_push_deliveries')).rows.length,1);
  });
  await t.test('identity IDs can run backwards without incremental cursor loss',async()=>{
   const reserved=(await pool.query("SELECT nextval(pg_get_serial_sequence('notifications','id'))::text AS id")).rows[0].id;
   await outbox(user);await deliverOutbox(pool);const cursor=(await call('GET','/v0/me/notifications?cursorVersion=2','recipient')).notifications[0].cursor;
   const earlier=await outbox(user);await pool.query(`INSERT INTO notifications(id,outbox_event_id,user_id,type,payload) OVERRIDING SYSTEM VALUE VALUES($1,$2,$3,'wallet_received',$4)`,[reserved,earlier.id,user,earlier.body]);await pool.query('UPDATE outbox_events SET delivered_at=now() WHERE id=$1',[earlier.id]);
   const replay=await call('GET',`/v0/me/notifications?afterCursor=${cursor}`,'recipient');assert.equal(replay.notifications.length,1);assert.equal(replay.notifications[0].id,reserved);assert.ok(BigInt(replay.notifications[0].cursor)>BigInt(cursor));
   assert.equal((await call('GET',`/v0/me/notifications?beforeCursor=${replay.notifications[0].cursor}`,'recipient')).notifications[0].cursor,cursor);
  });
  await t.test('authenticated WebSocket wakeups replay committed events',async()=>{
   await app.listen({host:'127.0.0.1',port:0});const messages=[];socket=new WebSocket(`ws://127.0.0.1:${app.server.address().port}/v0/ws`);socket.on('message',raw=>messages.push(JSON.parse(raw.toString())));
   await new Promise((resolve,reject)=>{socket.once('open',resolve);socket.once('error',reject);});
   const wait=async predicate=>{for(let i=0;i<100;i++){const r=messages.find(predicate);if(r)return r;await delay(20);}throw new Error(`Missing frame: ${JSON.stringify(messages)}`);};
   socket.send(JSON.stringify({type:'subscribe',channel:'account.notifications',cursorVersion:2}));await wait(m=>m.type==='error'&&m.code==='authentication_required');
   socket.send(JSON.stringify({type:'authenticate',accessToken:tokenFor('recipient')}));await wait(m=>m.type==='authenticated');
   const baseline=(await call('GET','/v0/me/notifications?cursorVersion=2','recipient')).notifications[0].cursor;
   socket.send(JSON.stringify({type:'subscribe',channel:'account.notifications',cursorVersion:2,after:baseline}));await wait(m=>m.type==='subscribed');await delay(550);messages.length=0;
   await outbox(user);await deliverOutbox(pool);await wait(m=>m.type==='resync_required');assert.equal((await call('GET',`/v0/me/notifications?afterCursor=${baseline}`,'recipient')).notifications.length,1);messages.length=0;
   const other=(await call('GET','/v0/me','other')).id;
   await pool.query("SELECT pg_notify('wallet_balance_changed',$1)",[other]);await delay(100);assert.equal(messages.some(m=>m.type==='wallet.updated'),false);
   await pool.query("SELECT pg_notify('wallet_balance_changed',$1)",[user]);await wait(m=>m.type==='wallet.updated');
   assert.deepEqual(messages.find(m=>m.type==='wallet.updated'),{type:'wallet.updated',channel:'account.notifications'});
   socket.terminate();socket=undefined;
  });
  await t.test('push ticket receipts, retry backoff and logout revocation',async()=>{
   const original=globalThis.fetch;let failure=false,sent=0;globalThis.fetch=async(input,options)=>{
    if(!String(input).startsWith('https://exp.host/'))return original(input,options);const body=JSON.parse(options.body);if(failure)return new Response('',{status:503});
    if(String(input).endsWith('getReceipts'))return Response.json({data:Object.fromEntries(body.ids.map(id=>[id,{status:'ok'}]))});
    sent++;assert.equal(body[0].body,'You have a new account update.');assert.equal(body[0].data.accountId,user);assert.equal(JSON.stringify(body).includes('123456789'),false);return Response.json({data:[{status:'ok',id:`ticket-${sent}`}]});
   };
   try{
    await deliverNotificationPush(pool);assert.ok(sent>0);assert.ok((await pool.query('SELECT ticket_id FROM notification_push_deliveries')).rows.every(r=>r.ticket_id));
    await pool.query('UPDATE notification_push_deliveries SET next_attempt_at=now()');assert.ok(await deliverNotificationPush(pool)>0);
    await outbox(user);await deliverOutbox(pool);failure=true;await deliverNotificationPush(pool);const retry=(await pool.query('SELECT attempts,last_error,next_attempt_at>now() AS deferred FROM notification_push_deliveries WHERE ticket_id IS NULL')).rows[0];assert.equal(retry.attempts,1);assert.equal(retry.last_error,'expo_http_503');assert.equal(retry.deferred,true);
    await call('DELETE','/v0/me/notification-device','other',{installationId:device});assert.equal((await pool.query('SELECT revoked_at FROM notification_devices')).rows[0].revoked_at,null);
    await call('DELETE','/v0/me/notification-device','recipient',{installationId:device});await deliverNotificationPush(pool);assert.ok((await pool.query('SELECT failed_at FROM notification_push_deliveries WHERE ticket_id IS NULL')).rows[0].failed_at);
   }finally{globalThis.fetch=original;}
  });
  await t.test('finalized observer deduplicates signature and instruction; wrong cluster rejected',async()=>{
   await pool.query("INSERT INTO wallet_notification_watches(user_id,address,network,last_signature,initialized) VALUES($1,$2,'devnet','baseline',true)",[user,wallet]);await pool.query("INSERT INTO wallet_notification_addresses(user_id,address,last_signature) VALUES($1,$2,'baseline')",[user,wallet]);let observed=false;
   const connection={getGenesisHash:async()=>genesis,getSignaturesForAddress:async(_key,options,commitment)=>{assert.equal(commitment,'finalized');return options.until==='receipt'?[]:[{signature:'receipt'}];},getParsedTransactions:async(signatures,options)=>{assert.equal(options.commitment,'finalized');observed=true;return signatures.map(()=>tx());}};
   await scanWalletNotifications(pool,connection);await scanWalletNotifications(pool,connection);assert.equal(observed,true);assert.equal((await pool.query('SELECT * FROM wallet_notification_receipts')).rows.length,1);
   await deliverOutbox(pool);assert.equal((await pool.query("SELECT * FROM notifications WHERE payload->>'signature'='receipt'")).rows.length,1);await assert.rejects(scanWalletNotifications(pool,{...connection,getGenesisHash:async()=> 'mainnet'}),/genesis/);
  });
  await t.test('one RPC leader emits confirmed balance hints and scans finalized changes immediately',async()=>{
   const callbacks=new Map(),removed=[],errors=[];let available=false,scans=0;
   const rpc={getGenesisHash:async()=>genesis,
    onAccountChange:(address,callback,commitment)=>{assert.equal(address.toBase58(),wallet);const id=callbacks.size+1;callbacks.set(commitment,{id,callback});return id;},
    removeAccountChangeListener:async id=>{removed.push(id);},
    getSignaturesForAddress:async(_address,options)=>{scans++;return available&&options.until!=='ws-receipt'?[{signature:'ws-receipt'}]:[];},
    getParsedTransactions:async signatures=>signatures.map(()=>tx())};
   const listener=await pool.connect(),hints=[];
   listener.on('notification',message=>hints.push(message));await listener.query('LISTEN wallet_balance_changed');
   const stop=startWalletNotificationScanner(pool,error=>errors.push(error),rpc);
   let stopOther;
   const wait=async predicate=>{for(let i=0;i<150;i++){if(await predicate())return;await delay(20);}throw new Error('Subscription/scan did not wake immediately');};
   try{
    await wait(()=>callbacks.size===2 && scans>0);
    stopOther=startWalletNotificationScanner(pool,error=>errors.push(error),rpc);await delay(100);assert.equal(callbacks.size,2,'Replicas share one RPC leader');
    const count=(await pool.query('SELECT count(*)::int AS n FROM wallet_notification_receipts')).rows[0].n;
    callbacks.get('confirmed').callback();await wait(()=>hints.length>0);assert.equal(hints[0].payload,user);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM wallet_notification_receipts')).rows[0].n,count,'Balance changes cannot invent receipts');
    available=true;callbacks.get('finalized').callback();
    await wait(async()=>!!(await pool.query("SELECT 1 FROM wallet_notification_receipts WHERE signature='ws-receipt'")).rowCount);
    callbacks.get('finalized').callback();await delay(100);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM wallet_notification_receipts WHERE signature='ws-receipt'")).rows[0].n,1);
    assert.deepEqual(errors,[]);
   }finally{await stopOther?.();await stop();await listener.query('UNLISTEN *');listener.release();}
   assert.deepEqual(removed.sort(),[1,2]);
  });
  await t.test('bounded persisted backfill resumes an outage and then catches later arrivals',async()=>{
    await pool.query("UPDATE wallet_notification_addresses SET last_signature='baseline',backfill_before=NULL,head_signature=NULL");
    let first=true,afterBackfill=false;
    const connection={getGenesisHash:async()=>genesis,getSignaturesForAddress:async(_key,options)=>{
      if(first){first=false;assert.equal(options.until,'baseline');return Array.from({length:50},(_,i)=>({signature:`bulk-${50-i}`}));}
      if(options.before==='bulk-1')return [{signature:'oldest'}];
      if(options.until==='bulk-50'&&!afterBackfill){afterBackfill=true;return [{signature:'arrived-during-backfill'}];}
      return [];
    },getParsedTransactions:async signatures=>signatures.map(()=>tx())};
    await scanWalletNotifications(pool,connection);
    let state=(await pool.query('SELECT * FROM wallet_notification_addresses')).rows[0];assert.equal(state.last_signature,'baseline');assert.equal(state.backfill_before,'bulk-1');assert.equal(state.head_signature,'bulk-50');
    await scanWalletNotifications(pool,connection);state=(await pool.query('SELECT * FROM wallet_notification_addresses')).rows[0];assert.equal(state.last_signature,'bulk-50');assert.equal(state.backfill_before,null);
    await scanWalletNotifications(pool,connection);assert.equal((await pool.query('SELECT last_signature FROM wallet_notification_addresses')).rows[0].last_signature,'arrived-during-backfill');
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM wallet_notification_receipts WHERE signature LIKE 'bulk-%'")).rows[0].n,50);
  });

  await t.test('token reassignment revokes the prior installation and preserves delivery audit records',async()=>{
    const before=(await pool.query('SELECT count(*)::int AS n FROM notification_push_deliveries')).rows[0].n;
    await call('PUT','/v0/me/notification-device','other',{installationId:randomUUID(),token,platform:'android'});
    const old=(await pool.query('SELECT token,revoked_at FROM notification_devices WHERE id=$1',[device])).rows[0];
    assert.ok(old.revoked_at);assert.equal(old.token,`revoked:${device}`);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM notification_push_deliveries')).rows[0].n,before);
  });

 }finally{socket?.terminate();await app.close();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();process.env.NOTIFICATION_PUSH_ENABLED='false';}
});
