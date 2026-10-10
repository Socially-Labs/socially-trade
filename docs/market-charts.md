# Real 24-hour market charts

The mobile Discover screen and trade sheet display the past 24 hours only. Charts
contain actual provider candles or recorded Jupiter observations, never synthetic
price paths. Birdeye history is display data and never enters executable price
observations or paper fills.

## Request flow

- List: `GET /v0/market/tokens/:mint/history?range=24H`. Reads stored Birdeye
  candles when available, otherwise recorded Jupiter samples. Never queues backfill.
- Trade sheet: the same route with `&backfill=true`. May queue missing historical
  data, returns available history immediately, and polls while work is pending.
- Equivalent v1: `/v1/markets/:mint/history?range=24h&resolution=5m&backfill=true`.
  Provider backfill accepts only 24h at five-minute resolution (288 candles).
  Legacy read-only history ranges remain supported for other consumers.
- Dynamic tokens must first register through the existing authenticated tracking
  flow. A private vault-context failure does not block a successful registration.

The ingestor calls Birdeye `/defi/v3/ohlcv`, validates candles, and stores them in
`market_chart_candles`. Redis and process caches coalesce chart reads; a shared
lease prevents overlapping admissions for the same chart. Existing pending work
is reused across rolling windows. Completed work has a 15-minute cooldown;
unavailable coverage has a six-hour cooldown. No history is fetched for the entire
catalog. Empty or partial results stay explicit.

Fresh Jupiter Price V3 updates continue to drive the current price. The chart can
show a distinct live Jupiter marker beside Birdeye history; it does not silently
stitch the two sources into a continuous historical series. Backgrounded/closed
sheets stop polling. List charts arrive in read-only batches; visible rows subscribe to live prices without individual history polls.

## Configuration and limits

Backend `.env` only:

```dotenv
BIRDEYE_API_KEY=...
MARKET_HISTORY_PROVIDER_ENABLED=true
BIRDEYE_HISTORY_MONTHLY_CU_BUDGET=25000
```

Restart backend development services after changing their environment. An API key
is never included in mobile config or responses. No new migration is required;
the existing history jobs, candles, and admission tables are used.

Redis admission enforces at least 1.1 seconds between requests across ingestors and
reserves a conservative **100 CU per attempted fetch**. The default 25,000-CU
monthly reserve permits at most 250 fetches; this is an internal safety estimate,
not a claim that every request costs 100 CU. The configured ceiling cannot exceed
30,000. It resets by UTC calendar month and is scoped to a fingerprint of the key.
Other uses of the same key and manual verification calls are not metered here;
check Birdeye's dashboard and lower this allowance when sharing the key. Redis
must be available for provider fetch admission. On budget exhaustion, stored charts
and Jupiter-collected history remain readable, and pending jobs wait.

## Verification

`node --env-file=.env scripts/verify-birdeye-history.mjs` tests one provider request.
`node --env-file=.env scripts/verify-birdeye-history.mjs --api` verifies the running
API/ingestor/storage path without displaying the credential. These are real API
calls and consume the provider allowance. Automated tests use mocked provider data
and isolated database/Redis fixtures.

## Discover batches

`GET /v1/markets?feed=toptraded&interval=24h&limit=10` returns a snapshot cursor.
Pass that cursor with the same filters and limit for the next ten. Search supports
the same cursor behavior, tied to the exact query. Cursor expiry returns 409; the
client retains loaded rows and can restart via Refresh markets.

`GET /v1/markets/history/batch?range=24h&mints=<comma-separated mints>` accepts
1–10 distinct valid mints and returns one result for every mint. Stored history
reads run with concurrency three and reuse the existing Redis/process caches.
Unknown/unregistered tokens return `UNAVAILABLE` with null history. Transient
server errors fail the batch, so the client retries rather than publishing a
partly hydrated batch. This endpoint never registers tokens or queues Birdeye
work and rejects the backfill query parameter.

The app commits a page only when its metadata and chart batch have resolved. A
cold page needs two public data requests instead of per-row token/tracking/history
polls; icons, account context and live-price transport are separate. Opening a
trade sheet remains the explicit provider-backfill path.
