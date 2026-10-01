import { Amount, fixed, SHARE_DECIMALS, USDC_DECIMALS } from "./index.js";

export const PERFORMANCE_FEE_MODEL_VERSION = 1;

/** Mint shares worth 10% of gains above the post-fee high-water mark. */
export function calculatePerformanceFee(navUsdc: string, totalShares: string, highWaterMark: string) {
  const nav = new Amount(navUsdc);
  const supply = new Amount(totalShares);
  const hwm = new Amount(highWaterMark);
  if (nav.lte(0) || supply.lte(0) || hwm.lte(0)) throw new Error("Invalid fee valuation");
  const price = nav.div(supply);
  const gain = Amount.max(0, nav.minus(supply.mul(hwm)));
  const targetFee = new Amount(fixed(gain.mul("0.10"), USDC_DECIMALS));
  const minted = targetFee.gt(0)
    ? new Amount(fixed(targetFee.mul(supply).div(nav.minus(targetFee)), SHARE_DECIMALS))
    : new Amount(0);
  const postFeePrice = nav.div(supply.plus(minted));
  const captain = new Amount(fixed(minted.mul("0.80"), SHARE_DECIMALS));
  return {
    modelVersion: PERFORMANCE_FEE_MODEL_VERSION,
    feeUsdc: fixed(targetFee, USDC_DECIMALS),
    sharesMinted: fixed(minted, SHARE_DECIMALS),
    captainShares: fixed(captain, SHARE_DECIMALS),
    protocolShares: fixed(minted.minus(captain), SHARE_DECIMALS),
    preFeeSharePrice: fixed(price, SHARE_DECIMALS),
    postFeeSharePrice: fixed(postFeePrice, SHARE_DECIMALS),
    highWaterMarkAfter: fixed(Amount.max(hwm, postFeePrice), SHARE_DECIMALS),
    dilutionFactor: fixed(price.div(postFeePrice), SHARE_DECIMALS),
  };
}
