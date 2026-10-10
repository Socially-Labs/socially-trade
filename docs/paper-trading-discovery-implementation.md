# Discovery implementation and rollout evidence

Implemented 10 October 2026 (IST), as working-tree changes on backend `ec4e038` and APK `f7221f9`. No commits, deployment, production migrations or environment enablement were performed. C01–C08 are accepted and implemented; all optional P-items remain deferred. Device/pilot release acceptance remains open.

**Local rollout completed subsequently on 10 October 2026:** migration 028 applied, API/ingestor and APK flags enabled in local `.env` files, API/ingestor reloaded, and Expo restarted on port 8081 with a cleared cache. Live Jupiter Top traded and Trending each returned 100 candidates with CURRENT snapshots. The owner requested visible broader discovery, so the enabled Captain screen now defaults to Top traded / 24H; the disabled screen and parameterless API retain Supported. See [local rollout and quota measurements](market-discovery-local-rollout.md). Original implementation-only evidence below is retained as historical context. Remote deployment and physical-device acceptance are not implied.

The implementation adds shared generated contracts, versioned market list/search/detail routes, Jupiter categories and four metadata windows, durable/distributed caching, immutable pagination, supported historical return rollups and Captain UI integration. It preserves pooled-vault accounting, automatic one-time balance initialization, immutable economics and the existing preview/submission/recovery engine. Unsupported discovery results remain browse-only. See [API details and examples](market-discovery-api.md).

## Rollout

1. Apply additive migration `028_market_discovery.sql` with the existing migration runner. It adds discovery snapshots/return rollups and corrects legacy unknown audit flags. It changes no money columns, grants, policies, round dates, shares or claims.
2. Set stable Jupiter organisation IDs in the server environment. `JUPITER_ORGANISATION_ID` supplies a shared default; `JUP_ACC_<n>_ORGANISATION_ID` overrides a verified membership. Unspecified numbered keys now share `default`, preventing accidental per-key multiplication. This can lower effective throughput if existing operators previously assumed independent organisations without recording them. Account for external/swap traffic using the same credentials.
3. Enable `MARKET_DISCOVERY_V1_ENABLED=true` on the API and ingestor. Leave the APK gate off while verifying durable snapshots and rollups, quotas, actual provider responses and history coverage. Both services need the migration and shared PostgreSQL/Redis access. Execution ingestion continues independently of this flag.
4. Enable `EXPO_PUBLIC_MARKET_DISCOVERY_V1_ENABLED=true` in the internal APK build and rebuild/restart Expo so the public flag enters the bundle. Exercise actual authenticated Captain/ Crew accounts and selected-vault trade recovery on Android before pilot expansion.
5. Roll back by disabling the APK gate and backend gate. Legacy supported reads, preview/order recovery, execution workers, settlement and claims remain available. Retain the additive tables and historical records; do not reverse financial state.

The defaults in both `.env.example` files are false. Existing local `.env` files were not changed. The migration was exercised in disposable schemas, not applied to the existing app database.

## Verification

All financial integration suites use random local PostgreSQL schemas. Discovery and quota tests launch isolated Redis Unix sockets without shared-cache flushes. Discovery HTTP testing runs a real loopback Fastify listener with fixture Jupiter transport; it is separate from the UI fixtures.

| Check | Result |
| --- | --- |
| API `markets-simulation`, `vault-rounds-simulation`, `paper-portfolio`, `shutdown`, `swap-config` | 33 tests passed |
| API `market-discovery` plus ingestor `scheduler` | 22 tests passed |
| Ingestor `client`, `ingest` | 22 tests passed |
| APK `markets-api`, `vaults-api`, `backend-account`, `captain-markets`, `market-discovery` | 43 tests passed |
| APK lint and TypeScript | Passed |
| Contracts, market-data, API and ingestor builds/type checks | Passed |
| Generated market-contract drift check | Passed |
| Chromium mobile-width UI smoke | Passed at 320, 393, 430 px |

Discovery coverage includes query combinations, mint case, duplicate symbols, nullable prices/flags, four statistics windows, negative/missing/incomplete ranking, interval-dependent volume ranking, global inactive assets, browse-only execution provenance, provider-order pagination, foreign/expired cursors, ten concurrent readers sharing one provider request, leases across two cache instances, provider timeouts, Redis outage fallback, API restart using durable PostgreSQL data, rate-limit/reset parsing and disabled-feature behavior. Existing financial suites cover concurrent submissions/funding, exact sells, balanced ledgers, private ownership, lifecycle gates, stale valuations, worker restarts and exactly-once cash initialization/claims.

The UI smoke uses public market fixtures and checks Supported default, the feed picker, disabled browse-only trade review, automatic switch to unranked Supported for 7D, mixed-case mint search, horizontal overflow after responsive layout settles and browser runtime errors. Screenshots are in `/private/tmp/socially-discovery-preview/`. This smoke does not establish live authenticated device integration. Existing unrelated dependency warnings appear during Expo web bundling; lint has no errors or warnings.

Measured cached HTTP p95: **0.86 ms**, 30 sequential loopback requests, one local API process, three fixture candidates, disposable PostgreSQL/Redis on this Mac; zero additional provider calls. Ten concurrent cold readers produced one fixture provider call. These conditions are small and local; no pilot/production load or latency claim is made.

Reproduce from backend:

```sh
pnpm --filter @socially/contracts build
pnpm --filter @socially/market-data build
pnpm --filter @socially/api build
pnpm --filter @socially/ingestor build
node scripts/sync-market-contracts.mjs --check
TEST_DATABASE_URL=postgres://socially:socially@127.0.0.1:5432/socially_trade node --test apps/api/test/market-discovery.test.mjs apps/ingestor/test/scheduler.test.mjs
TEST_DATABASE_URL=postgres://socially:socially@127.0.0.1:5432/socially_trade node --test apps/api/test/markets-simulation.test.mjs apps/api/test/vault-rounds-simulation.test.mjs apps/api/test/paper-portfolio.test.mjs apps/api/test/shutdown.test.mjs apps/api/test/swap-config.test.mjs
node --test apps/ingestor/test/client.test.mjs apps/ingestor/test/ingest.test.mjs
```

From APK, run `pnpm lint`, `pnpm typecheck`, and `node --test tests/markets-api.test.mjs tests/vaults-api.test.mjs tests/backend-account.test.mjs tests/captain-markets.test.mjs tests/market-discovery.test.mjs`.

## Existing history measurement

Read-only measurement against the existing local Compose database, 9 October 2026 at 21:53:11 UTC (10 October IST), using `scripts/inspect-market-history.mjs`:

| Instrument | First recorded sample (UTC) | Sample count | 7D / 30D coverage |
| --- | --- | --- | --- |
| SOL | 6 October 18:51:03 | 10,963 | Partial / Partial |
| JUP | 6 October 19:48:56 | 8,405 | Partial / Partial |
| JTO | 6 October 19:51:22 | 2,228 | Partial / Partial |
| BONK | 6 October 19:48:47 | 3,262 | Partial / Partial |
| USDC | 6 October 19:48:57 | 10,706 | Partial / Partial |

The available period is about three days. No 7D/30D return was invented or backfilled. Rollups use the existing `(instrument_id, source_at)` sample primary key and bounded downsampling, run in the ingestor, and are never computed by list callers. Operational query-plan/load inspection should be repeated on the target environment as retention grows.

## Remaining release gates and limits

- No Android device was connected (`adb devices` empty). Actual authenticated phone fills, account/vault switches, suspended-phone reconnect and physical-device layouts remain rollout gates. Existing automated API/trade/recovery tests passed.
- Live Jupiter category responses and organisation memberships were checked against current official documentation, not exercised with paid/live credentials. Validate actual provider quotas and external credential consumers before enablement.
- No staging infrastructure was created (P21 deferred), and no pilot has been enabled. Production freshness, pool usage, query plans, load and upstream traffic remain operational validation.
- Supported trades remain SOL/JUP/JTO/BONK under the existing policy; USDC is reserve only. Discovery does not extend the registry or activate fundraising rounds.
- The UI exposes all short feed intervals and complete recorded long returns. Selecting 7D/30D or gain/loss sorting opens Supported; category ranks are never relabeled as global gainers. Long-range volume is rejected by the API and the UI switches to a valid return sort or 24h volume.
- Saved uses the existing account watchlist; private context remains independent of market-feed errors. Existing saved-token DTOs remain compatible, so browse-only saved tokens can have unavailable prices until rediscovered.
- Prepared normalized responses are coalesced in bounded gateway memory for 15 seconds. Provider snapshots, leases, demand, quota and pagination are shared; successful provider fallback is durable in PostgreSQL. Redis is disposable for accounting purposes.
- Graphify was unavailable on this machine, so reconnaissance and validation used source inspection. Its graph update could not be run.
