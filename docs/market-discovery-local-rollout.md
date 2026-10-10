# Local discovery rollout and Jupiter load

Verified 10 October 2026 IST (9 October 22:07 UTC). This records local development rollout, not a remote deployment.

## Enabled and checked

- Migration 028 applied using the repository migration runner.
- Local API and ingestor: `MARKET_DISCOVERY_V1_ENABLED=true`; APK: `EXPO_PUBLIC_MARKET_DISCOVERY_V1_ENABLED=true`. Credentials remain server-only; local environment files are not committed.
- API/ingestor watch processes reloaded. Existing Expo restarted on port 8081 with its cache cleared. The generated Android bundle contains the enabled public flag.
- Captain UI now opens Top traded / 24H when enabled. The API's parameterless default remains Supported. Supported, Trending, Saved and Invested remain selectable.
- Live `GET /v1/markets?feed=toptraded&interval=24h&limit=3`: HTTP 200, CURRENT, 100 provider candidates, including cbBTC/PUMP/ZEC in provider rank order at verification time.
- Live Trending / 1H: HTTP 200, CURRENT, 100 candidates. Supported route still identifies SOL/JUP/JTO/BONK as tradable and USDC as reserve-only.
- 100 concurrent warm Top traded reads: all HTTP 200, same snapshot, 77 ms total locally, zero additional tokens-v2 scheduler acquisitions. This is a small local cache check, not a production load benchmark.
- Shared Redis budget recorded 14 attempted requests in the preceding minute, with no organisation cooldown. Snapshots were refreshed by the ingestor.
- Discovery/shared-quota suites: 22 tests passed with disposable local schemas/Redis. APK market/API tests: 19 passed; lint and TypeScript passed. Contracts, market-data, API and ingestor builds passed.
- No Android device was attached. Phone rendering/authenticated trade acceptance remains unverified; reload the development app to receive the new bundle. Graphify CLI was unavailable.

## What the ten keys actually provide

All ten configured keys currently have no explicit organisation IDs and share the scheduler's `default` organisation. We did not invent ten independent organisations. Rotation distributes requests across keys; it does not increase a shared provider quota. Price and token requests share the same Redis organisation window across API and ingestor replicas.

Current local scheduler limits: 48 attempted HTTP requests/minute/organisation, spaced at least 1.25 seconds apart, with a shared in-flight lease. Token/search acquisitions stop when the shared count reaches 28 to reserve capacity for prices. Retries also consume permits. An API credential alone does not establish the subscription or organisation membership; the actual billing account must be checked in Jupiter's dashboard.

## User-count examples for this backend

Assumptions: users keep Discover focused, reuse the same cached feed, and do no searches. Catalog polling runs every 30 seconds. Private vault/context/watchlist reads and WebSocket connections are additional backend work, excluded from the list-read column; they do not each request a Jupiter price. Application capacity at these user counts has not been load-tested.

| Active Discover users | List reads to our backend/min | Expected Jupiter requests/min | Average across 10 keys/min |
| ---: | ---: | ---: | ---: |
| 5 | 10 | ~15 | ~1.5 |
| 10 | 20 | ~15 | ~1.5 |
| 20 | 40 | ~15 | ~1.5 |
| 50 | 100 | ~15 | ~1.5 |
| 100 | 200 | ~15 | ~1.5 |

Expected baseline = ~12 batched Price V3 calls/minute (one batch for the supported registry every 5 seconds), ~1 supported metadata search/minute, and ~2 category refreshes/minute. Jitter, skips, request latency, upstream failures and retries change actual counts. The measured 14/minute is consistent with this estimate. Feed snapshots are shared for 60 seconds; readers do not multiply upstream calls. All eight category/interval combinations actively requested would increase category calls from ~2 to ~8/minute, making baseline ~21/minute. Non-default combinations retain demand for 15 minutes.

Each distinct uncached search adds approximately one token request; identical concurrent/recent searches share the cache. For example, five distinct cold searches/minute produce demand around 20 total requests/minute; ten produce ~25. With ~12 price calls and three baseline token calls, the current conservative token ceiling permits roughly 13 additional searches/minute in steady state. More demand can return cached fallback or temporary unavailability even before the total 48-call ceiling. This is a rough budget, not a guaranteed search throughput. Selecting uncached feed intervals, retries and other consumers also use headroom.

The same table remains approximately constant for users browsing the same feeds. It does not mean every workload with 100 users is free of upstream pressure or that backend database/connection load stays constant.

## Cost estimate

Official references checked during rollout: [Jupiter plans and credit costs](https://developers.jup.ag/docs/portal/plans) and [organisation rate limits](https://developers.jup.ag/docs/portal/rate-limits).

Free is $0, 60 requests/minute/organisation with unlimited credits; Developer is $25/month with 600 requests/minute and 25M included credits. The local scheduler deliberately remains capped at 48/minute even if a key belongs to a paid plan. We have not inspected this owner's subscriptions, so these are conditional plan costs rather than an actual invoice.

Current published credit costs: Price V3 = 1/call; Tokens V2 search = 10/call; category = 5/call. Baseline above is ~32 credits/minute, or ~1.38M credits over a continuously running 30-day month. Keeping all eight category combinations hot is ~62 credits/minute, or ~2.68M/month, before user searches/retries/other services. One additional distinct cold search/minute continuously adds ~432,000 credits/month. Free remains rate-limited without usage billing; paid overages and external consumers require dashboard verification.

Current devnet wallet swaps use Raydium, not these Jupiter keys. Paper orders use ingested marks rather than requesting one Jupiter quote per order. These estimates exclude Solana RPC, database, Redis and hosting costs.
