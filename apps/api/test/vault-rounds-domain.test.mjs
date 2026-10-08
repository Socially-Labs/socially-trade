import assert from 'node:assert/strict';
import test from 'node:test';
import { contributionReason, dueRoundPhase, microUsdc, roundEntitlement, roundSettlement, roundTradeAllowed, usdcFromMicro } from '../../../packages/domain/dist/index.js';
test('exact minima, capacity, deadline and Captain role', () => {
  for (const raw of ['50.0000001','1e3','-1',' 50','01',50]) assert.throws(() => microUsdc(raw));
  const input = { phase: 'FUNDRAISING',now: 9,fundingClosesAt: 10,acceptedCapitalUsdc: '100',amountUsdc: '50',isCaptain: false };
  assert.equal(contributionReason(input),null);
  for (const [changes,reason] of [[{ amountUsdc:'49.999999' },'amount_too_small'],[{ now:10 },'funding_closed'],[{ acceptedCapitalUsdc:'29950.000001' },'capacity_exceeded'],[{ isCaptain:true },'captain_seed_fixed']]) assert.equal(contributionReason({ ...input,...changes }),reason);
  for (const phase of ['ACTIVE','SETTLING','COMPLETED','CANCELLED','REFUNDING']) assert.equal(contributionReason({ ...input,phase }),'funding_closed');
});
test('late workers and trading allowlists', () => {
  assert.equal(dueRoundPhase('FUNDRAISING',10,10,20,'999.999999'),'REFUNDING');
  assert.equal(dueRoundPhase('FUNDRAISING',10,10,20,'1000'),'ACTIVE');
  assert.equal(dueRoundPhase('FUNDRAISING',21,10,20,'1000'),'SETTLING');
  assert.equal(roundTradeAllowed('ACTIVE','NORMAL',20,20,'BUY'),false);
  assert.equal(roundTradeAllowed('FUNDRAISING','NORMAL',0,20,'SELL'),false);
  assert.equal(roundTradeAllowed('ACTIVE','FROZEN',10,20,'BUY'),false);
  assert.equal(roundTradeAllowed('ACTIVE','FROZEN',10,20,'SELL'),true);
});
test('exact whole-round fee examples', () => {
  const result = roundSettlement('1000','1200');
  assert.deepEqual(result,{ captainFeeUsdc:'20.000000',distributionPoolUsdc:'1180.000000' });
  assert.equal(roundEntitlement(result.distributionPoolUsdc,'100','1000'),'118.000000');
  assert.equal(roundEntitlement(result.distributionPoolUsdc,'900','1000'),'1062.000000');
  for (const assets of ['0','800','1000']) assert.equal(roundSettlement('1000',assets).captainFeeUsdc,'0.000000');
});
test('1000 randomized settlement conservation vectors and deterministic replay', () => {
  let state = 12345n;
  const next = () => { state=(state*1103515245n+12345n)%2147483648n; return state; };
  for (let i=0;i<1000;i++) {
    const shares=Array.from({ length:1+Number(next()%25n) },()=>1n+next());
    const supply=shares.reduce((a,b)=>a+b,0n),assets=next()*100n;
    const result=roundSettlement(usdcFromMicro(supply),usdcFromMicro(assets));
    const paid=shares.reduce((sum,s)=>sum+microUsdc(roundEntitlement(result.distributionPoolUsdc,usdcFromMicro(s),usdcFromMicro(supply))),0n);
    const residue=microUsdc(result.distributionPoolUsdc)-paid;
    assert.ok(residue>=0n && residue<BigInt(shares.length));
    assert.equal(paid+residue+microUsdc(result.captainFeeUsdc),assets);
    assert.deepEqual(roundSettlement(usdcFromMicro(supply),usdcFromMicro(assets)),result);
  }
});
