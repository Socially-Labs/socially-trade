# Captain portfolio performance

Migration `035_captain_portfolio.sql` and the portfolio routes support the Captain performance card. The APK reads the summary/chart from `/portfolio` and loads `/portfolio/vaults` only when View vault performance opens the existing dashboard sheet. The existing dashboard, AUM history, and `CHAINED_ECONOMIC_UNIT_PRICE` response stay compatible.

## Routes

Both routes require a Captain Bearer token, restrict queries to the authenticated owner, use the existing vault rate limiter, and send `Cache-Control: no-store`.

| Route | Purpose |
| --- | --- |
| `GET /v1/me/captain/portfolio?range=30D` | Current AUM, selected-period dollar P&L, net external flows, aggregate return, counts, valuation status, and chart from one repeatable-read transaction. |
| `GET /v1/me/captain/portfolio/vaults?range=30D&limit=20&after=<uuid>` | Per-vault AUM, selected-period P&L and return, lifetime P&L, valuation/baseline timestamps, and ascending UUID pagination. |

Ranges are `7D`, `30D`, `90D`, and `ALL`; default is `30D`. Limits are 1–50. Financial values and revisions are decimal strings. Unknown values are `null`, never manufactured zeros. A new Captain gets zero AUM/P&L/flows, no chart history, and no percentage return.

Summary and chart share `revision` and database snapshot. Drilldown requests return their own revision: refetch the summary if a strictly matching revision is needed. A revision changes on every captured NAV, including standalone valuations without a new fund event. `asOf` is projection observation time; `valuationAsOf` is the oldest open-vault mark. `serverTime` describes the response snapshot, not price freshness. Terminal vaults have no current price requirement.

## Accounting

- Open cumulative investment P&L is current NAV minus net accepted principal.
- Finalized cumulative investment P&L is immutable net distribution minus accepted principal. This remains in history after the vault exits AUM and after users claim their proceeds.
- Period P&L is the difference between cumulative P&L at the end and at the historical boundary. Each vault contributes its dollar P&L directly to the aggregate.
- `netFlowsUsdc` is deposits less cancellations and final distributions during the period. Final distributions leave once, at finalization; claims do not leave again. Where valuations are available, AUM movement reconciles to investment P&L plus net flows.
- Trading costs already affect NAV; final Captain fees already affect distribution. Neither is subtracted twice. Unassessed future Captain fees are not accrued by this projection. Captain fee **income** remains in the earnings API.
- `settledVaultPnlUsdc` and `openVaultPnlUsdc` classify selected-period P&L by each vault's current lifecycle. These are **not** trade-level realized/unrealized P&L. Historical settlement unwinds lack complete fill-level cost evidence for those labels.

At each observed NAV, the aggregate index links the factor `(new open NAV - net external flow) / previous open NAV`. New capital into an empty portfolio leaves the index unchanged. Final distribution is an external outflow, so its net investment result is included before the assets leave. Unequal simultaneous vaults are therefore weighted by their actual managed value, not by averaging their percentages or multiplying concurrent vault returns.

This is a recorded-mark estimate: peer marks with exposure must be within 90 seconds of the observation, but are not guaranteed to be simultaneous with a cash flow. True time-weighted calculations require valuations at cash-flow boundaries; see the [GIPS calculation guidance](https://www.gipsstandards.org/standards/gips-standards-for-firms/gips-standards-handbook-for-firms/). This implementation does not claim GIPS compliance.

Single-vault return uses its economic unit-price ratio. Existing round-v2 rules issue/cancel principal at $1 during fundraising and prohibit contributions during trading. Do not reuse this formula if future rounds allow subscription/redemption at other prices without recording economic units explicitly.

## History, boundaries, and gaps

Exact observation records supply period boundaries, independently of chart downsampling. For `ALL`, principal/P&L baseline is zero and return index starts at 100. Other ranges use the last recorded observation at or before the requested start. `requestedFrom` is the desired date; `baselineAt` identifies the actual observed boundary. Each drilldown row exposes its own baseline because sparse vault histories can have different observation times. No claim is made that a stale historical mark represents an exact price at the requested instant.

7D uses hourly chart buckets; 30D/90D use daily buckets; ALL uses wider buckets when needed. Responses are bounded to 401 points. There is no interpolation or invented prehistory. A chart point includes selected-period dollar P&L, selected-period return, raw index, segment ID, and `hasGap`.

Unavailable/stale peer observations break the aggregate return chain. Recovery starts a new segment; a percentage spanning different segments is unavailable. Dollar P&L can recover if its endpoints are known. A gap flag persists within its display bucket, even after recovery, and that bucket's plotted return stays null. Clients must break paths at gaps and segment changes. A total loss remains recorded as -100%; fresh capital after a zero index starts a new segment rather than using a zero denominator.

Current valuation status is `CURRENT`, `STALE`, `PARTIAL`, or `UNAVAILABLE`. A partially priced aggregate never exposes the sum of known vaults as the full AUM. History coverage is separate: `COMPLETE` requires comparable return endpoints, at least two recorded chart buckets, and no gap bucket in the returned range. Missing baselines, sparse history, or gaps report `PARTIAL`; no projection reports `UNAVAILABLE`.

## Projection and rollout

Source financial records remain authoritative. The NAV trigger captures analytics in the same transaction, serializing the Captain projection without taking peer fund financial locks. Event-sequence checks make duplicate/older capture calls harmless. Original contribution and cancellation event references reconstruct historical capital even when contribution state has since changed.

The migration creates Captain/vault current projections, an indexed observation history for exact boundary lookup and attribution, and hourly/daily display rollups. It replays existing round-v2 NAV snapshots deterministically. Historical snapshots did not record exposure, so replay conservatively applies peer freshness checks; previously shown sequential history can become unavailable when there is insufficient evidence. Records are analytics, not spendable balances.

Apply migration 035 before serving the new routes. Use the normal migration runner after all preceding migrations are applied. For a large snapshot history, budget a maintenance window for the transactional replay and keep observation retention aligned with supported historical ranges; deleting exact boundary evidence can make older periods unavailable. The projection supports concurrent vaults without removing the current one-open-vault product restriction.

## Validation

`apps/api/test/captain-portfolio.test.mjs` applies all migrations in an isolated localhost-only PostgreSQL schema and checks authorization, account isolation, decimal precision, deposit/cancellation invariance, unequal concurrent weighting, fees and finalization, retained history after claims, range boundaries, replay, unavailable/stale marks, gap recovery, total loss, pagination, idempotency, and concurrent captures. Existing dashboard/returns and vault lifecycle tests exercise compatibility and financial writes with the new trigger installed.

## Crew discovery read model

Migration `036_captain_discovery.sql` adds a disposable projection keyed by Captain and range. The worker uses the same `@socially/db` portfolio reader as Captain home in a repeatable-read transaction. It rebuilds all four ranges when the accounting revision changes, and reconciles every 30 seconds to update moving boundaries, crew counts, and valuation age. Each cycle processes at most ten Captains; advisory locks prevent competing workers from overwriting one another. New eligible profiles appear immediately with unavailable performance until their first refresh. Existing observations and accounting records are unchanged.

`GET /v1/discover/captains` includes `performance` (the portfolio contract with at most 32 graph points) and `computedAt`. Scalar AUM/return remain compatible. Summary, graph, counts, and revision come from the same projection. Graph reduction retains gaps and segment changes; exceptionally fragmented histories use the most recent 32 observations rather than drawing through missing data. Sorting uses the cached numeric summary. A projection older than 60 seconds has null current AUM/P&L/return and `STALE` status; historical graph points retain their timestamps. The list performs one database query with no per-card requests. Public detail continues to read current source data.

The APK refreshes every 30 seconds only while Discover is focused and the app is active, and when it resumes. It reloads the loaded page chain atomically, retains it on failure, and cancels work on blur/background/scope changes. Pull refresh starts at page one. Graphs display recorded history rather than invented curves.

For a local development database, after building run `node scripts/refresh-captain-discovery.mjs --migrate`. This applies only migration 036 (requires 035) and backfills projections. Deployed environments use their normal migration runner followed by the worker; this helper refuses production and nonlocal databases.
