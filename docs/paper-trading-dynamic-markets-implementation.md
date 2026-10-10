# Dynamic paper markets implementation

Local rollout: 11 October 2026 IST. Implemented in the separate backend and APK working trees, preserving the existing discovery and UI changes. No remote deployment, purchase, signed APK build or physical-device verification was performed.

## Schema and policy

Applied `029_dynamic_markets.sql` and `030_vault_universe_amendments.sql` to the actual local app database after disposable-database tests. Migration 028 was already present. The runtime evidence records the exact migration list.

029 extends instrument identity/eligibility, versioned policy universe and accepted order policy evidence. It adds indexed durable tracking, provider-specific candle storage and leased/idempotent history jobs. Existing instrument IDs and financial records remain intact. Chart candles are isolated from execution observations; existing chart sample retention remains unchanged. No partitioning was added without evidence that it is needed.

030 permits one narrow, audited legacy-to-dynamic universe amendment on open rounds. The amendment stores both terms documents and hashes, links the new policy version, and leaves numeric economics, dates and closed rounds protected by the existing trigger. `node scripts/enable-dynamic-paper-markets.mjs <explicit-fund-id> ...` opts in selected open paper vaults. It is tested against disposable storage. The actual local database had no open paper vaults requiring this transition. New vaults use dynamic policies while enabled; their terms hash includes the universe mode, and APK round terms disclose it. The v1 Captain seed remains 100 USDC; the legacy trial seed remains unchanged.

## Backend and APK integration

- Authenticated `POST /v1/markets/:mint/tracking` validates canonical Solana mint identity, initialized mint owner and precision against mainnet RPC before first registration. Unique mint identity and serialized registration retain legacy IDs and administrative disablement. It returns READY/WARMING/STALE/UNAVAILABLE and a renewable 30-second lease. Admission is limited to 10 active mints/account, 200 shared screen mints and 30 tracking requests/minute/account.
- Stable new IDs are `solana:<mint>` with 64-character request limits. One eligibility function serves context, preview, submission and execution. Accepted orders persist the policy version; old pending orders with no saved version follow the existing latest-policy compatibility path. Emergency DISABLED blocks all execution; paused buys and SELL_ONLY retain held-asset sells with valid prices.
- The existing ingestor owns one PostgreSQL advisory leadership lock, rebuilds position/order demand and plans batches of at most 49 selected assets plus USDC. Pending orders precede holdings, then temporary screen demand. Durable due/backoff state survives restart. Failed batches do not invalidate unrelated assets. New mandatory assets have a global admission limit of 100. Price and token request classes share organisation pacing and the 48-attempt window, borrowing idle capacity while reserving service for active classes. Retries acquire permits.
- Both legacy and v1 trade routes retain idempotency, delayed fresh observations, precision, fee/slippage model and financial limits. Context reads use a consistent database snapshot, selected instrument IDs and an accounting revision. No onchain token transfer is performed for paper orders.
- Dynamic charts are available through `GET /v1/markets/:mint/history` and the compatible v0 chart route. Bounded Redis caches, shared locks, 16 concurrent local chart builds and durable jobs prevent provider work per reader. Missing coverage stays partial; overload returns retryable 503. Provider series are separate from sampled Jupiter history and never become fill evidence. Negative provider coverage can retry after five minutes.
- Authenticated `vault.context` subscriptions extend the existing gateway. One scan covers distinct subscribed vaults; permissions and expiry are rechecked. Events contain committed revision invalidations rather than balances. Subscription requires snapshot resync, closing the REST/subscription race. This single invalidation channel covers order and accounting changes together, without adding a second redundant orders socket channel.
- APK renews demand only while its trade detail is visible and foregrounded, resolves the selected dynamic token/context, subscribes to its prices, and releases local demand references on close. Shared contracts validate tracking responses. Private changes trigger one consistent context read; duplicate/older revisions are ignored. Healthy private reconciliation is 60 seconds, with bounded 15–20-second disconnected fallback and immediate focus/reconnect reconciliation. Existing uncertain-order persistence and status recovery remain intact. Offscreen rows no longer initiate chart HTTP requests, and provider candles are not overwritten by Jupiter samples.
- Cached token detail/search reads do not require provider initialization. Default catalog rows and discovery candidates resolve DB identity and eligibility. Public list reads do not register instruments.

## Local capabilities and runtime

Repository examples default new capabilities off. Actual local configuration enables `PAPER_DYNAMIC_MARKETS_ENABLED=true`, `PAPER_PRIVATE_UPDATES_ENABLED=true`, `EXPO_PUBLIC_PAPER_DYNAMIC_MARKETS_ENABLED=true` and `EXPO_PUBLIC_PAPER_PRIVATE_UPDATES_ENABLED=true`. Existing discovery remains enabled. `MARKET_HISTORY_PROVIDER_ENABLED=false`; `BIRDEYE_API_KEY` is absent. Secrets are not included in evidence.

API, ingestor and worker watchers were refreshed; API port 3000 and Expo port 8081 returned HTTP 200. One ingestor advisory leader was observed. The organisation window contained approximately 12 price requests/minute during the small live workload. Ten configured credentials are grouped into one configured organisation; key count does not establish billing capacity. Source observations naturally age, and stale provider responses remain non-executable.

The Android production export succeeded with both public capability flags included. Hermes bundle and assets are at `/private/tmp/socially-dynamic-android-export`. This is an Android JavaScript export, not a signed installable APK. `adb devices` returned no connected device. Existing Expo was healthy after the changes.

## Live execution evidence

[Sanitized live trade evidence](dynamic-markets-live-evidence.json) records newly registered WIF, mint `EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm`, validated using actual mainnet mint metadata and the shared live Jupiter ingestor.

The probe used disposable financial storage and unchanged legacy 1,000-USDC initialization, preserving real observation timestamps. Preview/submission and the actual order worker bought 45.735027 WIF for 10 USDC: cash 1,000 → 990. Selling all units produced cash 999.944506 and zero position. BUY fee: 0.010000 USDC; SELL fee: 0.009976 USDC; fill model version 1. Every ledger event balanced. It made zero incremental price requests per order, reading shared observations. This was real provider/API-module/worker evidence; it was not a physical app session or a trade in an existing user's vault.

Separate integration coverage exercises the actual v1 APK routes with the unchanged 100-USDC seed, legacy-policy opt-in script, preserved original terms hash, Crew funding, funding lock, keeper activation, dynamic preview/buy/sell, accepted policy version 2 and balanced ledger.

## Historical provider gate

A provisional mint-level USD adapter targets [Birdeye token OHLCV v3](https://docs.birdeye.so/reference/get-defi-v3-ohlcv), with 1m/5m/15m/1h intervals, bounded ranges, explicit source identity, OHLC validation and nullable USD volume. Durable jobs are leased/fenced, retry with backoff and acquire a shared provider budget of at most six attempts/minute. Recorded Jupiter history works independently.

There is no configured Birdeye credential or selected/approved paid plan. Live historical coverage, young/unpriced mint coverage, interval availability, provider correction behavior, licensed retention/redistribution rights and actual cost remain unverified. Do not enable provider backfill until those are checked for the chosen account. No claim of complete instant 24H/7D history is made. Fixture adapter/job tests do not close this gate.

The scheduler retains conservative local budgets; the provider's actual account limits and costs must be checked against [Jupiter organisation limits](https://developers.jup.ag/docs/portal/rate-limits) and [plans](https://developers.jup.ag/docs/portal/plans) before broader rollout.

## Load evidence and limits

[Machine-readable workload evidence](dynamic-markets-load-evidence.json) contains 120 rows: 5/10/20/50/100 authenticated users × 10/50/100/500 distinct-mint universes × six scenarios. Non-list scenarios issue at least one request per distinct mint, assigning requests across the configured users, so the 500-mint cases really request 500 mints. Public browsing uses the existing shared legacy list and does not claim a 500-token list. The environment is one in-process API, Docker PostgreSQL 17, temporary Redis, synthetic auth/metadata and burst requests. No live provider capacity is claimed by these fixtures.

| Scenario | Largest measured row p95 | Status totals |
| --- | --- | --- |
| shared-browsing | 45.99 ms | 200: 740 |
| token-details | 152.35 ms | 200: 3490 |
| holdings | 491.58 ms | 200: 3490 |
| pending-orders | 636.64 ms | 200: 3490 |
| diverse-searches | 154.99 ms | 200: 3490 |
| cold-charts | 14.08 ms | 200: 446, 503: 3044 |

Zero upstream requests occurred across cached workload readers, enforced by a fetch trap. The 500-request bursts intentionally expose admission/pool limits. Shared public browsing met 150 ms; worst token details and diverse searches marginally exceeded it. Worst private contexts exceeded the proposed 250 ms target. Cold chart 503s are explicit admission responses, not successful charts; clients retry. There is no claim that every proposed latency target passed.

With 100 authenticated private subscribers, the gateway made 4 batched queries over 2000 ms of idle observation. Revision update delivery p95 was 208.56 ms, including the synthetic SQL update and excluding device network/rendering. This meets the gateway-only one-second target in that fixture. The 60-second client schedule implies about 300 private resource reads/minute for 100 healthy idle Captains, down from 3,600; this is a schedule calculation, not a sustained physical-client measurement.

The evidence includes query counts, execution durations after connection acquisition, peak pool queue depth, process CPU/RSS, status codes and actual zero added upstream counts. At the largest bursts, the pool queued up to 490 requests. Redis latency, physical-client socket lag, healthy order-ack latency under sustained trade load, production cache-hit ratios and long-running recovery/backlog metrics remain unmeasured. No broad 100-user trading-capacity guarantee is made.

The five-second price model needs 12/24/36/132 calls/minute for 10/50/100/500 assets plus quote, respectively. Five hundred assets at that cadence exceed the configured organisation budget. The demand/admission rules bound new mandatory exposure; watches may warm more slowly when durable demand is high. Read-only EXPLAIN ANALYZE plans for registry, due work, held demand, latest observations, charts, pending orders, private context and event reads are saved in the runtime evidence. The actual local financial tables are small/empty, so those plans do not establish large-database performance.

## Verification and review

- Backend build and type checks passed across all packages.
- Default isolated regression runner passed 103 checks across financial simulation, dynamic markets, discovery, market/socket simulation, v1 round lifecycle and shared quotas.
- Final targeted dynamic integration and workload suites passed 9 checks, including 100-reader history coalescing, audited policy opt-in and private socket measurement.
- APK typecheck, Expo lint and 20 market/API/discovery checks passed. Final Android Hermes export passed.
- Both repository diffs pass whitespace validation. Graphify query/update could not run because the executable is absent. Existing unrelated working-tree edits were retained.

Review groups: migrations and registry/policy eligibility; API tracking/context/history/private routes; scheduler and ingestor demand/backfill; worker accepted policy evidence; shared contracts and APK active-market/private/chart hooks; verification scripts and evidence.

## Rollback

Set backend dynamic flag false to pause new dynamic buys/registrations. Keep registry rows and the demand ingestor running so held assets remain priced, sellable, valued and settleable. Never delete positions or fill observations. Turn private updates off on backend/client to use bounded polling recovery. Leave history provider access disabled to serve stored partial samples/candles honestly. Retain additive migrations, amendment evidence and completed financial records; do not revert to static-only held-asset tracking.
