import { Amount, fixed, fixedUp, MAX_PRICE_AGE_MS, MAX_SIMULATED_ORDER_USDC, USDC_DECIMALS } from "@socially/domain";

export const SOL_USD_FEED_ID = "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";
export const FILL_MODEL_VERSION = 1;

export interface PriceObservation {
  instrumentId: "SOL";
  source: "PYTH_HERMES";
  sourceRef: string;
  priceUsdc: string;
  sourceAt: Date;
}

export async function fetchSolPrice(apiKey: string): Promise<PriceObservation> {
  if (!apiKey) throw new Error("PYTH_API_KEY is required");
  const url = new URL("https://pyth.dourolabs.app/hermes/v2/updates/price/latest");
  url.searchParams.append("ids[]", SOL_USD_FEED_ID);
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Pyth price request failed: ${response.status}`);
  const data: unknown = await response.json();
  if (typeof data !== "object" || data === null || !("parsed" in data) || !Array.isArray(data.parsed)) {
    throw new Error("Pyth response has no parsed prices");
  }
  const entry = data.parsed.find((item: unknown) =>
    typeof item === "object" && item !== null && "id" in item &&
    String(item.id).toLowerCase().replace(/^0x/, "") === SOL_USD_FEED_ID.slice(2));
  if (!entry || typeof entry.price !== "object" || entry.price === null) {
    throw new Error("Pyth response has no SOL/USD feed");
  }
  const raw = entry.price as Record<string, unknown>;
  if (typeof raw.price !== "string" || typeof raw.expo !== "number" ||
      typeof raw.publish_time !== "number" || typeof raw.conf !== "string") {
    throw new Error("Pyth price fields are invalid");
  }
  const price = new Amount(raw.price).mul(new Amount(10).pow(raw.expo));
  const confidence = new Amount(raw.conf).mul(new Amount(10).pow(raw.expo));
  const sourceAt = new Date(raw.publish_time * 1000);
  if (price.lte(0) || confidence.div(price).gt("0.01") ||
      Date.now() - sourceAt.getTime() > MAX_PRICE_AGE_MS || sourceAt.getTime() - Date.now() > 5_000) {
    throw new Error("Pyth SOL/USD price is stale or low quality");
  }
  return {
    instrumentId: "SOL", source: "PYTH_HERMES",
    sourceRef: `${SOL_USD_FEED_ID}:${raw.publish_time}`,
    priceUsdc: fixed(price, 18), sourceAt,
  };
}

export interface SimulatedFill {
  modelVersion: number;
  quantity: string;
  marketPriceUsdc: string;
  fillPriceUsdc: string;
  feeUsdc: string;
  cashChangeUsdc: string;
}

/** Published v0 assumptions: 20 bps spread, 10 bps fee, 1 bp impact per $1k, capped at 50 bps. */
export function simulateFill(
  side: "BUY" | "SELL",
  notionalUsdc: string,
  marketPriceUsdc: string,
  assetDecimals: number,
): SimulatedFill {
  const notional = new Amount(notionalUsdc);
  const marketPrice = new Amount(marketPriceUsdc);
  if (notional.lte(0) || marketPrice.lte(0)) throw new Error("Notional and market price must be positive");
  if (notional.gt(MAX_SIMULATED_ORDER_USDC)) throw new Error("Order exceeds the v0 simulated fill cap");
  const impactBps = Amount.min(50, notional.div(1000).ceil());
  const totalBps = new Amount(20).plus(impactBps);
  const priceFactor = side === "BUY"
    ? new Amount(1).plus(totalBps.div(10_000))
    : new Amount(1).minus(totalBps.div(10_000));
  const fillPrice = marketPrice.mul(priceFactor);
  const fee = new Amount(fixedUp(notional.mul(10).div(10_000), USDC_DECIMALS));
  const quantity = side === "BUY"
    ? new Amount(fixed(notional.minus(fee).div(fillPrice), assetDecimals))
    : new Amount(fixed(notional.div(marketPrice), assetDecimals));
  if (quantity.lte(0)) throw new Error("Order is too small for asset precision");
  const cashChange = side === "BUY"
    ? notional.neg()
    : new Amount(fixed(quantity.mul(fillPrice).minus(fee), USDC_DECIMALS));
  if (side === "SELL" && cashChange.lte(0)) throw new Error("Sell proceeds are zero after fees");
  return {
    modelVersion: FILL_MODEL_VERSION,
    quantity: fixed(quantity, assetDecimals),
    marketPriceUsdc: fixed(marketPrice, 18),
    fillPriceUsdc: fixed(fillPrice, 18),
    feeUsdc: fixed(fee, USDC_DECIMALS),
    cashChangeUsdc: fixed(cashChange, USDC_DECIMALS),
  };
}
