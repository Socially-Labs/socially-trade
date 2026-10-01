import assert from 'node:assert/strict';
import test from 'node:test';
import { Amount, calculatePerformanceFee } from '../../../packages/domain/dist/index.js';

test('fee model charges 10% of gains and splits minted shares 80/20', () => {
  const fee = calculatePerformanceFee('1200', '1000', '1');
  assert.equal(fee.feeUsdc, '20.000000');
  assert.ok(new Amount(fee.postFeeSharePrice).minus('1.18').abs().lt('0.000000000000000002'));
  assert.ok(new Amount(fee.captainShares).plus(fee.protocolShares).eq(fee.sharesMinted));
  assert.ok(new Amount(fee.captainShares).minus(new Amount(fee.sharesMinted).mul('0.8')).abs().lt('0.000000000000000001'));
});

test('fee thresholds and precision never mint shares for loss or sub-micro gains', () => {
  for (const nav of ['900', '1000', '1000.000009']) {
    assert.equal(calculatePerformanceFee(nav, '1000', '1').sharesMinted, '0.000000000000000000');
  }
  assert.equal(calculatePerformanceFee('1000.000010', '1000', '1').feeUsdc, '0.000001');
  const tiny = calculatePerformanceFee('1000000000000', '1', '999999999999.999990');
  assert.equal(tiny.sharesMinted, '0.000000000000000001');
  assert.equal(tiny.captainShares, '0.000000000000000000');
  assert.ok(new Amount(tiny.captainShares).plus(tiny.protocolShares).eq(tiny.sharesMinted));
});

test('fee model rejects invalid or insolvent valuation inputs', () => {
  for (const values of [['0', '1000', '1'], ['-1', '1000', '1'], ['1000', '0', '1'], ['1000', '1000', '0']]) {
    assert.throws(() => calculatePerformanceFee(...values), /Invalid fee valuation/);
  }
});
