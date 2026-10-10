import assert from 'node:assert/strict';
import test from 'node:test';
import {RevisionCache} from '../dist/revision-cache.js';
import {setTimeout as delay} from 'node:timers/promises';
test('private read cache coalesces readers, separates identities, expires and does not cache failures',async()=>{
 const previous=process.env.REDIS_URL;delete process.env.REDIS_URL;const cache=new RevisionCache();let builds=0;
 const work=async()=>{builds++;await delay(10);return {value:{revision:builds},validUntil:Date.now()+50};};
 try{
  const readers=await Promise.all(Array.from({length:100},()=>cache.read(['captain-a','fund',1],work)));assert.equal(builds,1);assert.ok(readers.every(r=>r.revision===1));
  await cache.read(['captain-b','fund',1],work);assert.equal(builds,2);await cache.read(['captain-a','fund',2],work);assert.equal(builds,3);
  await delay(60);await cache.read(['captain-a','fund',1],work);assert.equal(builds,4);
  for(let i=0;i<2;i++)await assert.rejects(cache.read(['failed'],async()=>{throw Error('unavailable');}),/unavailable/);
  assert.equal(cache.metrics.builds,6);assert.equal(cache.metrics.coalesced,99);
 }finally{cache.close();if(previous===undefined)delete process.env.REDIS_URL;else process.env.REDIS_URL=previous;}
});
test('Redis-free fallback bounds distinct concurrent builders',async()=>{
 const previous=process.env.REDIS_URL;delete process.env.REDIS_URL;const cache=new RevisionCache();let active=0,peak=0;
 try{
  const result=await Promise.allSettled(Array.from({length:40},(_,i)=>cache.read(i,async()=>{active++;peak=Math.max(peak,active);await delay(20);active--;return{value:i,validUntil:Date.now()+100};})));
  assert.equal(peak,8);assert.equal(result.filter(r=>r.status==='fulfilled').length,8);
  assert.ok(result.filter(r=>r.status==='rejected').every(r=>r.reason.code==='private_read_busy'));
 }finally{cache.close();if(previous===undefined)delete process.env.REDIS_URL;else process.env.REDIS_URL=previous;}
});
