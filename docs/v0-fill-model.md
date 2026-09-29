# v0 paper fill model

This model is used only for simulated SOL/USDC trades. A Pyth SOL/USD observation supplies a mark price, not an executable swap quote. The API records the source observation and model version for every filled order. No trade is sent to Solana.

## Price source

- Source: [Pyth Hermes SOL/USD](https://docs.pyth.network/price-feeds/core/fetch-price-updates), using its current `/v2/updates/price/latest` endpoint and an API key.
- Accept an observation only when its publish time is no more than 90 seconds old, no more than 5 seconds in the future, and its confidence interval is at most 1% of the price.
- The 90-second limit accommodates the [SOL/USD feed's published 55-second heartbeat](https://docs.pyth.network/price-feeds/core/push-feeds/solana). A provider outage or stale feed pauses pricing-dependent actions.
- Local development can insert an explicitly marked `DEV_SEED` observation with the worker CLI. These observations must never be used for a public performance record.

## Execution assumptions, model version 1

- Spot SOL only, virtual USDC base currency, no borrowing or shorting.
- Order notional at most 10% of fund NAV and at most 1,000 virtual USDC.
- Base spread: 20 basis points against the Captain.
- Size impact: 1 basis point per commenced 1,000 virtual USDC, capped at 50 basis points.
- Simulated fee: 10 basis points of order notional, rounded up to six USDC decimal places.
- SOL quantity is rounded down to nine decimal places. USDC receipts are rounded down to six places.
- A submitted order stays pending for a short delay; the worker uses the next fresh observation after that delay. It rechecks the fund's policy at fill time.

The fixed impact schedule and hard order cap are conservative placeholders while the product has no route-depth feed. This model cannot establish that a live Jupiter swap would fill at the same price. Every public paper record must show that distinction.
