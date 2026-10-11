import assert from 'node:assert/strict';
import test from 'node:test';
import { simulateQuantitySell } from '../../../packages/market-data/dist/index.js';
import { evaluateSpotOrder } from '../../../packages/domain/dist/index.js';

test('only the complete holding can use the sub-dollar sell exception', () => {
  assert.throws(() => simulateQuantitySell('0.1','2',6));
  assert.throws(() => simulateQuantitySell('0.1','2',6,'0.2'));
  assert.throws(() => simulateQuantitySell('0.1000001','2',6,'0.1000001'));
  const fill = simulateQuantitySell('0.1','2',6,'0.100000');
  assert.equal(fill.quantity,'0.100000');
  assert.ok(Number(fill.cashChangeUsdc)>0);
  assert.throws(() => simulateQuantitySell('0.000001','0.1',6,'0.000001'));
  assert.throws(() => simulateQuantitySell('1001','1',6,'1001'));
});

test('closing dust can reduce risk even when larger than the percentage order cap', () => {
  const input={side:'SELL',instrumentId:'SOL',allowedInstruments:['SOL'],notionalUsdc:'0.2',quantity:'0.1',marketPriceUsdc:'2',cashUsdc:'0',positionQuantity:'0.1',navUsdc:'0.2',sharePriceUsdc:'0.2',peakSharePriceUsdc:'1',maxOrderBps:1000,maxPositionBps:2500,drawdownBreakerBps:3000};
  assert.equal(evaluateSpotOrder(input),null);
  assert.equal(evaluateSpotOrder({...input,quantity:'0.05'}),'order_too_large');
  assert.equal(evaluateSpotOrder({...input,side:'BUY'}),'order_too_large');
});
