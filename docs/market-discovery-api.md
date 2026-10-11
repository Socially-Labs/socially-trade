# Market discovery v1

These public, read-only PAPER endpoints are enabled by `MARKET_DISCOVERY_V1_ENABLED=true`. They contain no account balances or credentials and never authorize or submit trades. Shared DTOs and the runtime parser live in `packages/contracts/src/markets.ts`; run `node scripts/sync-market-contracts.mjs` after editing them, or add `--check` to detect APK drift.

| Route | Response |
| --- | --- |
| `GET /v1/markets` | `MarketList`, default Supported / 24h volume |
| `GET /v1/markets/search?query=JUP` | Bounded `MarketList`, `feed=search`, `sort=relevance`, `interval=null`; row metrics identify their interval |
| `GET /v1/markets/:mint` | Same envelope with exactly one matching item; 404 when unresolved |

Examples:

```text
/v1/markets?feed=supported&interval=1h&sort=volume&limit=20
/v1/markets?feed=toptraded&interval=24h&limit=20
/v1/markets?feed=trending&interval=6h&category=memecoin&minLiquidityUsd=25000000
/v1/markets?feed=supported&sort=gainers&interval=7d
/v1/markets/search?query=JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN&interval=1h
```

`feed` supports `supported`, `toptraded`, `trending`. Supported sort supports `volume`, `gainers`, `losers`. Provider categories use `rank` and reject local re-sorting. Short intervals are `5m`, `1h`, `6h`, `24h`. Only supported gain/loss sorting allows `7d` and `30d`. Search accepts short metric intervals, with default `24h`. Query identities preserve case, including base58 mints.

`limit` is an integer 1–50, default 20. `category` accepts `major`, `token`, `memecoin`, `unknown`. `minLiquidityUsd` is a nonnegative decimal string up to 1,000,000,000,000 with at most 18 fractional places. `tradableOnly=true|false` checks global support/activation, never vault authorization. Search requires a trimmed query of 1–100 characters and does not paginate.

Category filters apply before pagination to at most 100 provider candidates. `scope=PROVIDER_CANDIDATES` and `candidateCount` describe that bounded universe. Cursors bind the snapshot and all query options, including limit; reuse the same parameters with `cursor=<URL-encoded nextCursor>`. Immutable pagination is retained for ten minutes; data older than the five-minute discovery fallback is refused even when its pagination key remains. Missing/expired snapshots return 409 `feed_snapshot_expired`; restart page one. Invalid/foreign cursors and combinations return 400 `invalid_market_query`.

The response includes real provider `fetchedAt`, snapshot `asOf`, `refreshAfter`, explicit freshness, candidate/unranked counts, ranking availability and nullable values. All financial metrics are decimal strings. Valid returns rank before unavailable rows; unavailable rows have null rank and a stable mint tie-breaker. A missing return never becomes zero. Historical rollups share the chart baseline/end/gap rules, retain exact coverage endpoints, and age out after two minutes without computation.

Tracked prices come only from Jupiter Price V3 observations. Untracked metadata prices are marked `JUPITER_TOKENS_V2`, preserve source/receipt timestamps and always have `usableForExecution=false`. Quality flags may be null; unknown tokens have category `unknown`. Catalog eligibility is descriptive. Only authenticated vault context/preview/order routes enforce ownership, lifecycle, policy, balance and execution freshness.

Snapshots use a 60-second cache, per-process coalescing, Redis leases and PostgreSQL fallback for at most five minutes. Failures never replace snapshots with an empty success or reset their retrieval time. Cold requests are bounded and share the existing organisation quota, with 20 of 48 slots reserved from token/search consumption for prices. Redis outages prevent unbudgeted fetching. 429 `market_rate_limited` and 503 `market_feed_unavailable` include a five-second `Retry-After`; other account/financial routes retain their existing behavior.

The ingestor refreshes top-traded/24h and trending/1h every 60 seconds plus jitter under its existing leader lock. Other category combinations are demanded for 15 minutes after access. It precomputes supported 7D/30D returns and prunes expired search rows. No user request scans raw history for rankings. Existing uppercase history ranges remain compatible; additive `5M` and `6H` ranges support the new UI controls. The APK coalesces chart reads for 30 seconds across rows and detail views, while each caller can cancel independently.

See [rollout and verification](paper-trading-discovery-implementation.md) and [the original accepted scope](paper-trading-discovery-handoff.md).

Token logos use the public [cached image endpoint](token-icons.md):
`GET /v1/markets/:mint/icon`. The APK resolves image URLs through its configured
API origin; the JSON catalog retains the provider's metadata URL.

Current mobile charts use 24 hours only. Historical backfill requires explicit `backfill=true`; list reads never enqueue provider work. See [chart flow and free-tier limits](market-charts.md).

## Invested markets and portfolio history

The APK's Invested list derives its mint set from the selected vault's authenticated
trading context, rather than filtering Supported or a page of Top traded.
`GET /v0/market/tokens?mints=<comma-separated mints>` resolves up to ten distinct
identities from the stored registry, metadata and latest prices. It rejects mixing
`mints` with `query`, makes no provider requests, and retains registered tokens when
optional metadata is missing. The APK loads all holdings in bounded batches and
coalesces matching token batches for 15 seconds. Search and filters apply locally
to those holdings; account and vault changes discard the previous selection.

The ingestor independently prioritizes pending orders, then positive positions
in non-completed funds, then visible/default tokens. Each distinct held instrument
is monitored once across all captains, with a five-second refresh target subject
to quotas and upstream backoff. It does not depend on an open screen.
New prices enqueue affected fund valuations. Recorded NAV snapshots feed hourly
and daily vault/AUM rollups and chained Captain return rollups.
`GET /v1/me/captain/performance?range=7D` reads hourly AUM history; `30D` and `90D`
read daily history. `GET /v1/me/captain/returns?range=7D` reports trading returns
excluding contributions. Missing prices/history stay unavailable; no graph points
are invented. A new vault may have only one daily point despite many valuations.
