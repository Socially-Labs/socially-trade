# Paper trading: seven backend improvements and APK integration

Implemented locally on 11 October 2026 IST. The detailed architecture, schemas, sequence diagrams, resource bounds and recovery procedure are in [paper-trading-system-design.md](paper-trading-system-design.md).

## Delivered behavior

1. Price/position changes create durable, coalesced affected-fund valuation work. Four leased consumers, generation fencing, a persisted safety cursor and bounded lock waits replace the normal full valuation scan.
2. Authorized private context reads use revision/dependency keys, memory/Redis coalescing and freshness/deadline-bounded expiry. Existing-account authentication now needs one indexed live database read instead of a transaction/insert on each request. Financial write checks remain authoritative.
3. Captain Home receives authenticated `captain.dashboard` invalidations through the existing gateway. It debounces activity, resyncs on reconnect/focus, reconciles every 60 seconds while connected, and closes private streams/active reads on background or account cleanup.
4. Periodic reconciliation compares ledger cash/assets, economic supply, event balance and fill evidence in one committed snapshot. Durable incidents deduplicate discrepancies and retain resolution history. No automatic financial repair occurs.
5. Stored chart cache entries serve fresh or explicit stale coverage while refresh runs in the background. A shared SQL admission lock enforces the 200-active-job limit; quota waits do not exhaust provider retries. Redis outages use bounded stored reads without direct provider calls.
6. Order detail reports delay, price/holding valuation waits, attempt count, evidence age and expiry. The app explains these stages. Oldest-attempt pending selection prevents an unpriced first batch from starving later orders. Captain-scoped health and protected admin aggregates expose operations and process latency histograms.
7. A separate net trading return chain excludes capital flows and includes execution costs and final round fees. It carries across sequential v2 rounds, preserves gaps, and does not replace AUM. Captain Home shows this value for the selected period and respects hidden balances.

## Verification

- Backend build passed across all nine packages. Shared APK execution/return contracts pass drift checking.
- Backend regression suite: **113 checks passed**, with disposable schemas and Redis. Tests cover normal financial lifecycle, idempotency and worker races as well as the new behavior.
- APK: **28 targeted tests passed**, plus TypeScript and Expo lint. Android Hermes export produced `/private/tmp/socially-paper-system-android-final`; this is a JS/assets bundle, not a newly signed installable APK.
- Migrations `031_paper_trading_operations.sql` and `032_captain_trading_returns.sql` applied to local development storage.
- [Runtime evidence](paper-trading-runtime-evidence.json): API health and protected admin health 200, Expo 200, one ingestor leader, one locally audited fund HEALTHY, no queued valuations, return state populated. No production deployment was performed.

Targeted new scenarios include an updated generation arriving behind a locked fund, parallel claims and expired lease recovery; injected cash drift with one retained incident; eligibility invalidation; 21 unpriced orders advancing across 20-order batches; rolled-back versus committed Captain updates; 240 parallel history admission requests admitting exactly 200; six quota waits preserving zero attempts; 100 stale chart readers; Redis connection failure; flat return under contributions, negative execution cost, profitable final fees, sequential-round continuity and explicit unavailable NAV.

## Local load comparison

The same fixture workload covers five user counts (5/10/20/50/100), four requested mint universes (10/50/100/500) and six scenarios: 120 rows. Synthetic auth/metadata, one API injection process, local PostgreSQL, disposable Redis; burst requests, no live provider work. The new run primes the context-cache Redis connection once. Results cannot establish production throughput or device rendering latency.

| Scenario at 100 users | Requests / requested universe | Previous p95 | New p95 | Previous SQL queries | New SQL queries |
| --- | --- | --- | --- | --- | --- |
| Holdings context | 100 / 100 | 100.95 ms | 53.30 ms | 1,400 | 700 |
| Repeated pending/context reads | 100 / 100 | 109.52 ms | 21.29 ms | 1,400 | 200 |
| Diverse holdings context | 500 / 500 | 487.00 ms | 340.05 ms | 7,000 | 4,950 |
| Repeated diverse pending/context reads | 500 / 500 | 505.45 ms | 126.62 ms | 7,000 | 1,130 |

All private workload requests in the final matrix returned 200; upstream requests attributable to readers were zero. Chart overload remains explicit: in the 500-universe/500-request chart row, 148 returned stored results and 352 returned 503. Cache temperature differs across repeated scenarios, so this is not a claim that 148 cold charts are always admitted at once.

For 100 connections subscribed to both vault and Captain channels, the gateway used eight batched queries in two idle seconds. Captain invalidation delivery p95 was 309.54 ms, including a synthetic committed SQL update; the older vault-only run used four queries and delivered at 208.56 ms. The extra channel adds one batched scan rather than 100 per-connection queries. These measurements exclude network/device rendering.

Raw evidence: [previous workload](dynamic-markets-load-evidence.json), [new workload](paper-trading-load-evidence.json).

## Practical limits

Historical provider backfill remains disabled locally because no provider credential is configured. Missing/stale executable prices still block trading; this work does not fabricate fresh market data. Quiet reconciliation is eventual and its cursor can defer a partially processed batch after a crash. Request metrics are per process, not a production metrics aggregation service. Return migration duration grows with recorded historical snapshots, and manually overlapping rounds retain gaps rather than manufacturing a portfolio return.

Physical Android foreground/background and device-network behavior still need release-device validation. Existing unrelated working-tree edits were retained. Graphify query/update could not run because the repository-referenced `graphify` executable is unavailable.
