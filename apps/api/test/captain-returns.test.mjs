import assert from 'node:assert/strict';
import test from 'node:test';
import {captainTradingReturns} from '../dist/captain-returns.js';
import {parseTradingReturns} from '../../../packages/contracts/dist/index.js';
const inception=new Date('2026-10-01T00:00:00Z'),recorded=new Date('2026-10-02T00:00:00Z');
function storage(index,hasGap=false){return {query:async sql=>{
 if(sql.includes('SELECT inception_at'))return {rows:[{inception_at:inception}]};
 if(sql.includes('SELECT index_value,recorded_at'))return {rows:[]};
 return {rows:[{recorded_at:recorded,index_value:index,has_gap:hasGap}]};
}};}
test('PostgreSQL chained numeric precision serializes within the APK return-point contract',async()=>{
 for(const [stored,expected] of [['100.000000000000000000000000000000000000','100.000000000000000000'],['99.994450600000000000123456789012345678','99.994450600000000000'],['0.000000000000000000000000000000000000','0.000000000000000000']]){
  const response=await captainTradingReturns(storage(stored),'captain','ALL');
  assert.equal(parseTradingReturns(response).points[0].indexValue,expected);
 }
});
test('unavailable NAV remains a gap instead of being formatted as zero',async()=>{
 const response=parseTradingReturns(await captainTradingReturns(storage(null,true),'captain','ALL'));
 assert.equal(response.points[0].indexValue,null);assert.equal(response.points[0].hasGap,true);assert.equal(response.netReturnPercent,null);
});
