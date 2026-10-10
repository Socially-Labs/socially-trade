# v0 paper fill model

This model is used for simulated spot SOL, JUP, JTO and BONK trades against virtual USDC, subject to registry activation and each round’s immutable policy. A Jupiter asset/USD observation converted using USDC/USD supplies a mark price, not an executable swap quote. The API records the source observation and model version for every filled order. No trade is sent to Solana.

## Price source

- Source: [Jupiter Price V3](https://developers.jup.ag/docs/price), fetching the supported assets and USDC together with server-side API keys. Each asset/USDC mark is asset/USD divided by USDC/USD. Discovery metadata prices never supply execution observations.
- Resolve both source block times via Solana RPC; freshness uses the older time. Accept source age at most 90 seconds and future skew at most five seconds. No Pyth confidence interval is applied.
- Display freshness is 15 seconds. The 90-second execution window is the current v0 policy, independent of provider update guarantees. Unavailable upstream data never creates a fabricated fresh observation.
- See [ingestion and streaming architecture](jupiter-market-stream-v0.md) for polling, rate budgets, provenance and the retained three-second order delay.
- Local development can insert an explicitly marked `DEV_SEED` observation with the worker CLI. These observations must never be used for a public performance record.

## Execution assumptions, model version 1

- Spot SOL, JUP, JTO and BONK under the recorded policy, virtual USDC base currency, no borrowing or shorting.
- Order notional at most 10% of fund NAV and at most 1,000 virtual USDC.
- Base spread: 20 basis points against the Captain.
- Size impact: 1 basis point per commenced 1,000 virtual USDC, capped at 50 basis points.
- Simulated fee: 10 basis points of order notional, rounded up to six USDC decimal places.
- Token quantity is rounded down to the registry’s mint precision (SOL 9, JUP 6, JTO 9, BONK 5). USDC receipts are rounded down to six places.
- A submitted order stays pending for a short delay; the worker uses the next fresh observation after that delay. It rechecks the fund's policy at fill time.

The fixed impact schedule and hard order cap are conservative placeholders while the product has no route-depth feed. This model cannot establish that a live Jupiter swap would fill at the same price. Every public paper record must show that distinction.
