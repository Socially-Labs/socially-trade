# Paper trading discovery and Captain experience — implementation handoff

Prepared: 10 October 2026  
Status: implementation proposal for owner review; product decisions are pending  
Repositories: `backend/` and `apk/` under `/Users/vikas/dev/socially`  
Reviewed baseline: backend `ba85a62`, APK `f7221f9`

## 1. How to use this handoff

This document specifies the proposed Markets integration and a separate paper-trading product backlog. It does not claim that the proposed endpoints or optional features already exist.

1. Change each desired decision from `PENDING` to `ACCEPT` or `REJECT` in sections 3 and 10. `DEFER` is also allowed.
2. Give the implementing agent the accepted IDs, this document, and both repositories.
3. Implement accepted items and their stated dependencies. A recommendation is not an approval. If a dependency is rejected, report the conflict rather than silently adding it.
4. Preserve the existing behavior in section 2 unless an accepted decision explicitly changes it.
5. Deliver working API/client integration, relevant tests, a migration/rollout note, and a list of remaining limitations. Do not treat a mock screenshot as integration evidence.

Suggested first delivery: **C01–C08**. Suggested product additions after that: **P01, P02, P03, P04, P05, P08, P11, P14 and P21**. The owner still chooses which to accept.

## 2. Current product and implementation baseline

### What the product does

A Captain starts a paper vault, Crew contribute virtual capital, and the Captain trades its pooled reserve using real market observations. The backend simulates execution, updates positions and NAV, and settles the round under its recorded terms. Crew track their share of the result.

### Existing behavior to preserve

| Area | Current behavior |
| --- | --- |
| Paper balance | A one-time, server-verified snapshot of the linked devnet wallet's native SOL and Circle USDC USD value initializes isolated virtual cash. |
| Initialization UX | Automatic when relevant Captain/Crew screens open; the former “Start your paper portfolio” card and button have been removed. |
| Accounting | `users.vault_paper_cash` and `USER / paper-vault:<userId>` ledger accounts are isolated from redeemable cash. Each round retains its immutable balance source. |
| Wallet changes | Later deposits, transfers, and SOL price changes do not refill or revalue already-issued paper cash. |
| Token movement | Paper funding and trades do not transfer tokens or request wallet signatures. Wallet send/swap remains a separate onchain flow. |
| Captain seed | Exactly 100 paper USDC. |
| Crew contribution | Minimum 50 paper USDC. |
| Round funding | Minimum total 1,000; maximum 30,000 paper USDC, including Captain capital. |
| Funding window | 12, 24 or 72 hours; trading starts only after successful fundraising and worker activation. Reaching the minimum alone does not authorize early trading. |
| Trading duration | Existing supported durations and immutable round dates remain authoritative. |
| Fee | Captain receives 10% of positive net whole-round profit at final settlement, separately from redemption of their own shares. |
| Trading eligibility | Only the owning Captain can trade an active round; frozen vaults allow eligible sells; lifecycle and policy are rechecked by the backend. |
| Supported assets | SOL, JUP, JTO and BONK are configured trading instruments; USDC is the reserve asset. Runtime instrument/policy flags can further restrict trading. |
| Execution | Existing paper fill model, delayed observation-based execution, decimal precision, fees, limits, idempotency and order recovery remain in force. A market mark is not a guaranteed executable swap quote. |
| UI | Preserve the existing frosted/coastal theme, Markets vault selector and trade sheet, harbor creation screen and receipt review. |
| Connectivity | WebSockets terminate during API shutdown; shutdown has a deadline; Helius RPC query authentication is accepted; account bootstrap/read retries a transient connection failure once. |

The current “Top traded” view ranks a fixed supported catalog by 24-hour volume. It does not consume Jupiter's category rankings. Search can find more tokens, but that does not make them tradeable. The current 7D/30D gainer/loser sorter receives no historical returns. Approximately three days of local samples existed at the last audit; remeasure coverage before implementation.

**Documentation precedence:** some older documents describe explicit initialization, SOL-only execution, or legacy trial behavior. Verify code and migrations against this baseline. In particular, initialization-button language in `vault-rounds.md` and SOL-only language in `v0-fill-model.md` are historical and need correction during the handoff's documentation pass.

## 3. Core delivery decisions — one line each

| ID | Decision | Recommendation | One-line proposal |
| --- | --- | --- | --- |
| C01 | PENDING | Accept | Add backend market-list/search contracts that distinguish supported markets, top traded and trending. |
| C02 | PENDING | Accept | Fetch Jupiter discovery feeds centrally with shared caching, bounded requests and organisation-aware quotas. |
| C03 | PENDING | Accept | Make every token's discovery status, price freshness and paper-trading eligibility explicit in the API. |
| C04 | PENDING | Accept | Make volume and gain/loss sorting match the selected interval and report missing historical coverage honestly. |
| C05 | PENDING | Accept | Connect the existing Captain Markets UI to the new feeds while preserving its design and selected-vault context. |
| C06 | PENDING | Accept | Keep all simulated order execution on the existing authenticated vault routes with safe submission recovery. |
| C07 | PENDING | Accept | Add cache, freshness, quota and API-restart regression coverage plus a controlled feature-flag rollout. |
| C08 | PENDING | Accept | Update API documentation and older product docs so the next agent sees one consistent paper-trading flow. |

Dependencies: C02–C04 underpin C01 responses; C05 requires C01–C04; C06 is mandatory whenever C05 exposes trading; C07–C08 close the accepted release. Optional product work is listed in section 10.

## 4. User journey and expected screen behavior

### Open Captain Discover

- Default to **Supported** so a new Captain sees assets available to our engine.
- Add **Top traded**, **Trending**, **Invested** and **Saved** as feed choices using the existing sheet/chip system; avoid crowding the narrow-screen header with five equal tabs if it overflows.
- USDC remains visible as the selected vault's reserve, not as a token with a buy action.
- Preserve the chosen vault across feed/search/filter changes within the account. Opening Markets from a vault detail page selects that exact vault.
- With no vault, allow browsing and show the existing Create Vault action. With a fundraising vault, explain when trading opens and link to its funding detail.
- Opening a new feed keeps its own loading/error state. A market-data failure must not be presented as an account authentication failure.

### Discover or search a token

- A result shows price, selected-interval change, explicitly labeled volume interval, liquidity, and whether paper trading is available.
- A discovery token outside the supported catalog is browse-only. Its metadata price, if supplied, is labeled with its source/freshness and cannot become an execution observation.
- Search is debounced, cancellable and keyed by mint identity; identical symbols never merge assets.
- Preserve case for mint queries and use URL encoding. Do not lowercase a base58 address for cache identity.
- Stale cached discovery may remain visible with “Updated … ago”; missing values render as unavailable, not zero.

### Place and follow a paper trade

- Open the existing trade sheet with the selected vault's reserve, holdings, limits and pending orders.
- BUY enters paper USDC spend; SELL enters token quantity, with Max based on backend limits.
- Review shows estimated receive, simulated fee and price, plus the paper execution label.
- Submit once using the persisted intent and idempotency key; pending/uncertain outcomes retain recovery controls.
- A later observed market price determines the actual simulated fill. Show actual results after the worker completes.
- Refresh reserve, holdings and activity after terminal events. A failed trade retains the entered amount and displays an actionable reason.
- Account/vault switches clear old financial context immediately; stale asynchronous responses cannot restore it.

## 5. API contract to implement

### New discovery endpoints

All routes below are **proposed**. Public market responses must contain no personal balances or credentials.

| Method and endpoint | Query example | One-line purpose |
| --- | --- | --- |
| `GET /v1/markets` | `feed=supported&sort=volume&interval=24h&limit=20` | Lists engine-supported assets ranked by the specified metric. |
| `GET /v1/markets` | `feed=toptraded&interval=24h&limit=20` | Returns a cached Jupiter top-traded ranking. |
| `GET /v1/markets` | `feed=trending&interval=1h&limit=20` | Returns a cached Jupiter trending ranking. |
| `GET /v1/markets` | `feed=supported&sort=gainers&interval=7d&limit=20` | Ranks supported assets using complete recorded seven-day returns. |
| `GET /v1/markets` | `feed=supported&sort=losers&interval=24h&limit=20` | Ranks supported assets by the largest observed declines. |
| `GET /v1/markets/search` | `query=SOL&limit=20` | Searches names, symbols or a full mint through a shared backend cache. |
| `GET /v1/markets/:mint` | none | Resolves a token's normalized metadata, pricing and eligibility for detail/deep links. |

### Query validation and semantics

| Parameter | Contract |
| --- | --- |
| `feed` | `supported`, `toptraded`, `trending`; default `supported`. |
| `sort` | `volume`, `gainers`, `losers` for supported; provider `rank` for category feeds. Default supported sort is `volume`; category default is `rank`. Reject category re-sorting in v1 rather than claiming a global gainer ranking from a small top-traded sample. |
| `interval` | Category feeds: `5m`, `1h`, `6h`, `24h`. Supported volume: the same four metadata windows. Supported gain/loss: those windows plus `7d`, `30d` from recorded history. Default `24h`. Reject unsupported combinations, including 7D volume, with HTTP 400. |
| `limit` | Integer 1–50; default 20. This bounds API output, not a separate upstream request per user. |
| `cursor` | Optional opaque cursor for a retained feed snapshot; bound to snapshot ID, filters, interval and sort. Expired cursor returns 409 `feed_snapshot_expired`; client restarts from page one. |
| `query` | Required for search, trimmed, 1–100 characters; preserve mint case. Empty input loads the chosen feed. Search v1 returns a bounded result set with no implied exhaustive pagination. |
| `category` | Optional `major`, `token`, `memecoin`; use curated classifications where known and `unknown` for unclassified discovery tokens. Do not infer category from a symbol. |
| `minLiquidityUsd` | Optional nonnegative decimal string with a documented upper bound; apply before pagination. |
| `tradableOnly` | Optional boolean; checks global paper support, not a specific vault's policy or available funds. |

Category-feed filters operate on the cached candidate set (initial target: 100 entries per feed/interval). Return `scope: "PROVIDER_CANDIDATES"` and the candidate count; do not describe that filtered set as an exhaustive Solana-wide scan.

### Response contract

Create shared, versioned contracts in `packages/contracts` and generate the APK copy rather than independently maintaining two DTOs. Proposed structure:

```ts
type MarketList = {
  schemaVersion: 1;
  mode: 'PAPER';
  feed: 'supported' | 'toptraded' | 'trending' | 'search';
  interval: '5m' | '1h' | '6h' | '24h' | '7d' | '30d' | null;
  sort: 'rank' | 'volume' | 'gainers' | 'losers' | 'relevance';
  scope: 'SUPPORTED' | 'PROVIDER_CANDIDATES' | 'SEARCH_RESULTS';
  snapshotId: string;
  asOf: string;                 // When this snapshot was built; UTC ISO.
  fetchedAt: string;            // Actual provider retrieval time; never a cache-hit time.
  refreshAfter: string;
  status: 'CURRENT' | 'STALE';
  rankingStatus: 'AVAILABLE' | 'PARTIAL' | 'UNAVAILABLE';
  candidateCount: number;
  unrankedCount: number;
  nextCursor: string | null;
  items: MarketToken[];
};

type MarketToken = {
  mint: string;
  instrumentId: string | null;
  symbol: string;
  name: string;
  decimals: number;
  icon: string | null;
  category: 'major' | 'token' | 'memecoin' | 'unknown';
  tracked: boolean;
  tradable: boolean;            // Global eligibility only; context/preview authorizes trades.
  tradeReason: string | null;
  verified: boolean | null;
  suspicious: boolean | null;  // Unknown is not an affirmative safety assessment.
  rank: number | null;         // Provider rank or valid metric rank; null for unranked rows.
  price: {
    usd: string | null;
    source: 'JUPITER_PRICE_V3' | 'JUPITER_TOKENS_V2';
    sourceAt: string | null;
    receivedAt: string;
    status: 'CURRENT' | 'STALE' | 'UNAVAILABLE';
    usableForExecution: boolean;
  } | null;
  metrics: {
    interval: string;
    volumeUsd: string | null;
    liquidityUsd: string | null;
    changePercent: string | null;
    source: 'JUPITER_TOKENS_V2' | 'RECORDED_SAMPLES';
    asOf: string | null;
    status: 'CURRENT' | 'STALE' | 'UNAVAILABLE';
    coverage: 'COMPLETE' | 'PARTIAL' | 'UNAVAILABLE';
  };
};
```

All money, token quantities and percentages use decimal strings; validate finite values and precision at the boundary. Verification and provider flags are descriptive inputs, not an authorization mechanism. Keep execution observations separate from discovery metadata.

Rank only rows with a valid metric for the requested interval. Append unavailable rows with `rank: null` and a stable identity tie-breaker. If no valid returns exist, use `rankingStatus: UNAVAILABLE`; the client presents an unranked supported list and “History is still building,” rather than a gainer/loser claim.

Use the existing error envelope `{ error: string, message: string }`. Expected codes: `invalid_market_query` (400), `feed_snapshot_expired` (409), `market_rate_limited` (429), `market_feed_unavailable` (503). Include `Retry-After` for bounded retries. An unavailable provider response is not an empty successful ranking.

### Existing endpoints to reuse

| Endpoint | Responsibility |
| --- | --- |
| `GET /v0/market/prices` and WS `/v0/ws`, channel `market.prices` | Shared execution-grade marks for the tracked supported set. |
| `GET /v0/market/tokens/:mint/history?range=1H\|24H\|7D\|30D` | Recorded chart samples and explicit coverage; existing uppercase range contract stays compatible. |
| `GET /v0/me/watchlist`; `PUT` / `DELETE /v0/me/watchlist/:mint` | Account-scoped saved markets. |
| `GET /v1/me/captain/vaults` | Selectable owned vaults and lifecycle state. |
| `GET /v1/vaults/:id/trading-context` | Authenticated reserve, holdings, limits and pending orders. |
| `POST /v1/vaults/:id/orders/preview` | Server-authorized estimate for the selected vault. |
| `POST /v1/vaults/:id/orders` | Idempotent paper order submission; keep the existing BUY notional and SELL quantity bodies. |
| `GET /v1/vaults/:id/orders/:orderId` | Recover and follow actual simulated execution status. |
| `POST /v1/vaults/:id/orders/:orderId/cancel` | Cancel an eligible pending order. |
| `GET /v1/me/paper-portfolio`; `POST /v1/me/paper-portfolio/initialize` | Existing automatic one-time paper balance setup. |

Do not duplicate these financial routes under `/v1/markets`. Discovery reads must never change balances, create a vault, or submit an order.

## 6. Provider integration, caching and database design

### Jupiter requests owned by the backend

| Provider request | When to use it |
| --- | --- |
| `GET https://api.jup.ag/tokens/v2/toptraded/{interval}?limit=100` | Build a shared top-traded candidate snapshot. |
| `GET https://api.jup.ag/tokens/v2/toptrending/{interval}?limit=100` | Build a shared trending candidate snapshot. |
| `GET https://api.jup.ag/tokens/v2/search?query=<encoded query or mint batch>` | Search or refresh known token metadata. |
| `GET https://api.jup.ag/price/v3?ids=<comma-separated mints>` | Refresh the execution-tracked set in batches of at most 50. |

Jupiter category intervals are `5m`, `1h`, `6h`, `24h`; category results exclude generic majors such as SOL/USDC. Keep majors in Supported and the reserve UI. Search can batch known mints. Confirm the response schema at implementation time. [Jupiter token documentation](https://developers.jup.ag/docs/tokens/token-information)

Jupiter Price V3 can omit tokens without reliable pricing. Preserve missing prices and provenance; metadata prices are not a fallback execution source. [Jupiter Price documentation](https://developers.jup.ag/docs/price)

### Refresh and failure policy

| Data | Proposed policy |
| --- | --- |
| Execution marks | Retain the existing shared five-second ingestion target and WebSocket delivery; volume of app users does not multiply Jupiter calls. |
| Default discovery feeds | Refresh top-traded/24h and trending/1h every 60 seconds with jitter and leader/lease ownership. |
| Other discovery intervals | Refresh only recently requested combinations; coalesce cold requests, bound upstream work and expire inactive scheduling demand after 15 minutes. |
| Metadata | Parse all relevant provider statistics windows from each response; keep source timestamps and fetch timestamps separately. |
| Search | Shared exact-query cache for 60 seconds, per-process coalescing plus distributed lease; briefly cache confirmed no-results responses, never cache failures as empty lists. |
| Discovery fallback | Retain the last successful snapshot for up to five minutes as visibly STALE; older/missing snapshots return 503 with retry guidance. Keep metadata identity available independently where useful. |
| Feed pagination | Retain immutable snapshot IDs for ten minutes; cursors refer to that snapshot so refreshed rankings do not create page duplicates/skips. |
| Private vault context | Refresh after trade/lifecycle events and on focus; use a bounded REST fallback. Keep a context freshness gate if reducing the current polling frequency. |
| Charts | Reuse existing bounded history reads initially; coalesce equal mint/range requests and avoid fetching a row chart again when its detail sheet can share the same cached result. |

Cache freshness is not trading authorization. A discovery snapshot may be useful for browsing after its execution marks have expired. Preserve the current 15-second displayed-price freshness and existing execution-model thresholds unless a separate change is accepted; document the distinction in technical tests, not as noisy implementation text in the UI.

Extend the existing `JupiterClient` and Redis scheduler for category requests. Do not introduce a second unbudgeted HTTP client. All provider retries must acquire permits. Preserve bounded attempts, deadlines, queue capacity and cancellation. Search/discovery must leave capacity for price ingestion.

Verify actual organisation membership for configured keys. Add explicit organisation IDs if the current slot-to-organisation assumption cannot be demonstrated; keys from one organisation must share the same budget. Rotation must not reset its identity. Account for existing swap traffic or other services using those credentials. Jupiter quotas apply per organisation and most endpoints share a bucket. [Jupiter rate-limit documentation](https://developers.jup.ag/docs/portal/rate-limits)

### Minimal storage changes

Reuse `instruments`, `market_token_metadata`, `market_latest`, `market_samples`, `price_observations` and `market_watchlist`.

1. Extend normalized metadata with `stats5m`, `stats1h`, `stats6h`, `stats24h`, selected quality flags and source timestamps. JSON payload additions can be backward-compatible; validate old rows and increment the payload schema version.
2. If durable discovery fallback is accepted as part of C02, add `market_discovery_feeds` with `(feed, interval)` primary key, `snapshot_id`, `fetched_at`, `source_as_of` (nullable), `candidate_count`, and a bounded normalized `payload`. Persist only successful snapshots; Redis retains pagination versions and serves hot reads. Provider failures must not overwrite good rows with emptiness.
3. Compute 7D/30D returns in a bounded background job for supported instruments. Start with the existing sample indexes; verify query plans. If needed, add `market_return_rollups` keyed by `(instrument_id, interval)` with baseline/end timestamps and prices, return, coverage and computation time. Do not scan raw samples once per user/row.
4. If P06 expands support dynamically, make `instruments` the authoritative registry and add needed catalog fields through a separate migration. The current hardcoded maps occur in ingestion, routes, pricing, WebSocket validation and trading policy; changing only the discovery response is insufficient.

No core discovery migration changes user money columns, vault terms, shares, balances, claims or fee rules. Redis remains disposable for accounting purposes; PostgreSQL remains the financial source of truth. Cache outage must not issue virtual cash or submit financial operations.

Use bounded batch upserts for discovered metadata. Avoid one SQL round trip per token. List endpoints should read shared prepared snapshots rather than synchronously making provider calls for every request. Test pool usage and indexes before increasing catalog size.

### Historical return rules

- Preserve the existing recorded-history coverage checks and gap detection; decide and test boundary tolerances once for charts and sorting.
- For 7D/30D, compute `(endPrice / startPrice - 1) * 100` only when the required baseline, current end and coverage exist.
- Store the exact baseline/end observation times. Do not call a three-day change a seven-day return.
- Use fresh provider-window statistics for 5m/1h/6h/24h; make their source visible in the contract.
- The API must return the same return and coverage to the chart summary and sorter. Row-local history hooks cannot be the ranking authority.
- Historical backfill from another provider is a separate P20 decision with provenance, cost and candle semantics to define.

## 7. Paper execution requirements

The existing execution engine is reused. Discovery integration is complete only when these remain true:

1. A browse result cannot add an instrument to a vault's allowed list. Eligibility requires registry support, runtime activation, fund policy, lifecycle, ownership and valid prices.
2. Preview checks the authenticated Captain and selected vault. Recheck balance, exposure, position quantity, lifecycle and prices when submitting/filling under the existing transaction locks.
3. A preview neither reserves cash nor locks a fill price. The fill uses the existing model and appropriate later observation, with an auditable observation/model version.
4. BUY uses exact paper USDC notional; SELL uses exact token quantity. Fees, rounding, slippage assumptions and sell limits remain server-owned.
5. Persist the client intent before transport. A lost response retries/reconciles the same idempotency key and body; account changes must not replay another account's intent.
6. Pending orders, duplicate taps, worker restarts and concurrent orders cannot spend the same reserve twice. Only actual filled quantity affects positions.
7. The current round minimum, funding deadline and activation worker remain effective. A polished Markets page must not bypass fundraising to make a first trade appear successful.
8. Stale/absent prices do not zero holdings or manufacture NAV. Settlement may wait for valid marks, and the UI explains that state.
9. Paper trade proceeds remain inside the selected vault until its lifecycle allows distribution. They never become sendable wallet SOL/USDC.
10. Existing frozen-state eligible sells and post-deadline rejection must work even when the UI has old context.

If P06 is accepted, stage new instruments through identity validation, decimals, price coverage, history collection, execution limits and policy-version inclusion. Do not silently extend immutable/current vault policies. Removing a held instrument requires a separately defined sell/unwind policy so positions are not stranded.

## 8. Implementation sequence and file ownership

| Phase | Main work | Likely files / areas | Exit condition |
| --- | --- | --- | --- |
| 0. Reconfirm baseline | Read accepted decisions, current branches, latest migrations and exact UI routes; measure history and provider budgets. | This document, both AGENTS.md files, existing integration tests. | Accepted scope and dependencies recorded; no assumed product changes. |
| 1. Contracts | Specify feed/filter/interval validation, DTOs, errors, identity and eligibility semantics. | `packages/contracts/src/`, new APK generated contract, API/client parsers. | Contract fixtures cover current, stale, unavailable and browse-only tokens. |
| 2. Provider and cache | Add category transport, explicit quota grouping, shared refresh, leases and fallback snapshots. | `packages/market-data/src/{client,tokens,config,scheduler}.ts`, `apps/ingestor/src/`, new migration if needed. | Many readers share a bounded upstream fetch; 429/failure tests pass. |
| 3. Ranking and routes | Add list/search/detail endpoints, selected-interval metrics, return aggregation and stable pagination. | `apps/api/src/market-catalog.ts`, `market-catalog-routes.ts`, new v1 market module and worker rollups. | API reports valid ranks/coverage without per-user raw-history scans. |
| 4. APK integration | Add feed choices, honest interval controls and loading/stale/error states; preserve selected-vault behavior. | `apk/src/api/markets.ts`, `use-markets.ts`, `use-market-history.ts`, `components/markets/*`. | Existing theme works at 320/393/430 widths and on a physical Android device. |
| 5. Trade verification | Exercise supported vs unsupported assets and actual paper order completion. | Existing `orders.ts`, worker execution, trade sheet and order recovery hook. | Buy/sell affects only the selected vault and survives uncertain outcomes. |
| 6. Product additions | Implement only accepted P-items in dependency order, each as an independently reviewable change. | Depends on section 10. | Each accepted item has its stated user outcome and regression coverage. |
| 7. Rollout/docs | Enable progressively, observe cache/price/API health, update contracts/docs and write handoff evidence. | Flags, operational dashboards/logging and project documentation. | Feature can be disabled without disabling claims, settlement or existing order recovery. |

Useful existing entrypoints:

- Backend discovery: [`market-catalog.ts`](../apps/api/src/market-catalog.ts), [`market-catalog-routes.ts`](../apps/api/src/market-catalog-routes.ts).
- Provider integration: [`packages/market-data/src`](../packages/market-data/src), [`ingestor`](../apps/ingestor/src).
- Trading: [`trading-context.ts`](../apps/api/src/trading-context.ts), [`orders.ts`](../apps/api/src/orders.ts), [`vault-routes.ts`](../apps/api/src/vault-routes.ts), [`worker orders`](../apps/worker/src/orders.ts).
- APK: [`markets.ts`](../../apk/src/api/markets.ts), [`use-markets.ts`](../../apk/src/hooks/use-markets.ts), [`market-data.ts`](../../apk/src/components/markets/market-data.ts), [`Captain Markets`](../../apk/src/components/markets/captain-markets-screen.tsx).
- Accounting baseline: [`paper-portfolio.ts`](../apps/api/src/paper-portfolio.ts), [`vault-rounds.md`](vault-rounds.md).
- Connectivity fixes: [`local-api-connectivity.md`](local-api-connectivity.md).

Backend AGENTS asks for Graphify before reconnaissance and after code changes. The CLI was unavailable when preparing this document; the handoff agent should check availability and use the source map above if it remains unavailable. APK AGENTS requires matching Expo-version documentation before RN/Expo API changes, plus lint/typecheck before completion.

## 9. Acceptance tests and release gates

### Data and APIs

- [ ] Default supported feed contains only the expected registry identities; duplicate symbols remain distinct mints.
- [ ] Top-traded/trending use provider category responses and preserve provider ranking, including after snapshot pagination.
- [ ] 1h volume uses 1h statistics; changing to 24h changes both label and ranking inputs.
- [ ] 7D/30D gainers use complete matching returns; missing history is unranked and never sorted as a zero return.
- [ ] Invalid feed/sort/interval combinations and malformed/foreign/expired cursors have explicit error responses.
- [ ] Search preserves mint case, is debounced/cancellable and rejects oversized input.
- [ ] Missing prices, missing metadata fields, unknown verification and suspicious flags remain distinct states.
- [ ] Concurrent cold reads coalesce; repeated reads within TTL do not multiply Jupiter calls.
- [ ] 429/reset headers, exhausted quotas, Redis outage, provider timeout and API restart do not fabricate current data.
- [ ] Price ingestion retains its reserved capacity while discovery/search is under load.

### Paper money and order lifecycle

- [ ] Captain A cannot view private context or trade Captain B's vault.
- [ ] Crew browsing cannot become Captain trading through route parameters or a cached role.
- [ ] Fundraising, expired, completed and frozen states enforce the existing buy/sell rules server-side.
- [ ] A discovered unsupported token cannot be traded by modifying a request body.
- [ ] Preview, buy, partial/complete fill where supported, sell and cancellation reconcile reserve, positions, fees and balanced ledger entries.
- [ ] Concurrent submissions, double taps, response lost after commit and app relaunch do not double-submit or double-spend.
- [ ] Stale held-asset marks correctly affect NAV/policy availability; they are not replaced by zero or metadata quotes.
- [ ] Paper P&L never credits redeemable wallet cash. Discovery does not reinitialize an existing paper portfolio.
- [ ] Settlement/claims still work with discovery feature disabled or provider unavailable, subject to existing valid-price requirements for unwind.

### Client and operations

- [ ] Switching account/vault clears old context before the next trade can be reviewed.
- [ ] The selected vault survives feed/filter/search changes and deep linking selects the intended vault.
- [ ] Empty, loading, stale, partial history, offline, no-vault and funding states have usable copy/actions.
- [ ] A pending trade can be reopened and recovered; UI errors preserve meaningful input.
- [ ] Balance visibility settings apply to reserve/positions in every new surface.
- [ ] Background/foreground and focus transitions release/reconnect subscriptions without duplicate polling loops.
- [ ] Real watch restart with a nonresponsive WebSocket client recovers and account-loading retry remains cancellable.
- [ ] APK lint/typecheck, targeted API/parser tests, real HTTP integration and physical-device flows pass.

Proposed measurement targets, to validate on a named test environment: cached market-read p95 under 300 ms; no cold provider request per user during a cache hit; no new API process stuck with established sockets but no listener; no positive balances created by retries. Record baseline and load conditions rather than declaring these achieved from unit tests.

Run existing relevant suites rather than replacing them with mocks: backend `markets-simulation`, `vault-rounds-simulation`, `paper-portfolio`, `shutdown`, `swap-config`; APK `markets-api`, `vaults-api`, `backend-account`, plus new feed/ranking tests. Database tests must use disposable local schemas. Never change production round dates or mint paper cash merely to make a UI acceptance test pass.

## 10. Product backlog — owner Accept/Reject list

Every proposal below is **optional**. Each row is a one-line product decision; implementation begins only after its decision becomes `ACCEPT`. Priority is my recommendation, not approval. Effort is relative: S = localized, M = multiple layers, L = a new product/engine capability.

| ID | Decision | Suggested timing | Effort | One-line proposal and user benefit |
| --- | --- | --- | --- | --- |
| P01 | PENDING | Next | L | Add an instant private solo practice portfolio with a fixed virtual grant so users can trade before recruiting Crew or obtaining devnet tokens. |
| P02 | PENDING | Next | M | Show cash, invested value, realized/unrealized P&L and total return together so Captains understand where performance comes from. |
| P03 | PENDING | Next | M | Add one paginated paper activity timeline for funding, trades, cancellations, fees and claims so every balance movement is explainable. |
| P04 | PENDING | Next | M | Add an order receipt with requested amount, actual fill, fees, observation time and rejection reason so execution is transparent. |
| P05 | PENDING | Next | M | Add position detail with quantity, average cost, exposure, unrealized P&L and sell action so managing a trade takes fewer steps. |
| P06 | PENDING | After core | L | Expand supported assets through a reviewed registry and price-coverage checks so discovery gradually becomes tradeable. |
| P07 | PENDING | After core | M | Add “Tradeable only” and quality/liquidity filters so Captains quickly find usable markets. |
| P08 | PENDING | Next | S | Show a short first-trade checklist that disappears after completion so new users know how to start without another setup screen. |
| P09 | PENDING | After core | M | Add reusable personal watchlists with custom names so Captains organize strategies beyond a single Saved list. |
| P10 | PENDING | Later | M | Add configurable price alerts with cooldowns so users can return when a tracked market reaches a chosen price. |
| P11 | PENDING | Next | M | Compare portfolio returns against SOL buy-and-hold and cash over the same dates so performance has a useful baseline. |
| P12 | PENDING | After core | M | Show concentration and drawdown indicators with plain explanations so Captains see risk before placing another trade. |
| P13 | PENDING | After core | M | Add Crew round progress, funding target and shareable vault links so the $1,000 activation requirement becomes understandable and actionable. |
| P14 | PENDING | Next | M | Let Captains attach private trade notes and review them later so paper trading teaches repeatable decisions. |
| P15 | PENDING | Later | M | Add weekly portfolio recaps covering return, drawdown, fees and decisions so users have a reason to review their progress. |
| P16 | PENDING | Later | L | Add opt-in leaderboards grouped by start period and portfolio rules so performance comparisons are fair. |
| P17 | PENDING | Later | M | Allow reset/archive for private practice sessions while retaining their history so users can experiment without rewriting public records. |
| P18 | PENDING | Later | L | Add paper limit orders with expiry and observation-based triggers so Captains can practice planned entries. |
| P19 | PENDING | Later | L | Add stop-loss/take-profit paper orders with explicit gap and partial-fill rules so exits can be rehearsed realistically. |
| P20 | PENDING | After core | L | Backfill historical candles from a licensed/source-verified provider so 7D/30D analysis is usable before enough local samples accumulate. |
| P21 | PENDING | Next | M | Run the API on a stable HTTPS staging host with readiness monitoring so phone testing no longer depends on a laptop's Wi-Fi address. |
| P22 | PENDING | After core | M | Add user-visible service status and automatic recovery for safe reads so temporary outages preserve the user's work. |
| P23 | PENDING | Later | M | Add a paper trading challenge with fixed dates and equal starting grants so newcomers can practice within comparable rules. |
| P24 | PENDING | Later | M | Add read-only public round performance pages with clear paper labels so Captains can share an auditable track record. |
| P25 | PENDING | After core | M | Add Captain strategy updates on vault pages so Crew understand decisions without gaining trading authority. |
| P26 | PENDING | Later | M | Export order and portfolio history as CSV so users can analyze results outside the app. |
| P27 | PENDING | Later | L | Version selectable execution realism presets for private practice so users can compare optimistic and conservative simulated fills. |
| P28 | PENDING | Defer | L | Add strategy replay/backtesting with recorded historical inputs so users can evaluate ideas before starting a new practice session. |
| P29 | PENDING | Defer | L | Add shorting or leverage only as a separately specified engine so spot accounting and liquidation assumptions remain coherent. |
| P30 | PENDING | Defer | L | Add automated strategy execution only after defining user controls, order budgets and reproducible decision logs. |

### Dependency and product-policy notes

- **P01 is the largest activation improvement:** today's $100 seed, $1,000 fundraising minimum, funding window and devnet-wallet requirement create several steps before a first trade. A private practice account should be a distinct mode/entity with its own grant ledger, not fake Crew contributions to a real shared round. It must not alter active pooled vault economics.
- **P02/P05/P11 require agreed performance definitions:** specify realized cost basis, fee inclusion, treatment of external contributions and withdrawals, benchmark dates, stale valuation and incomplete coverage. Never compare raw account-value growth with return when deposits changed the capital base.
- **P03/P04 must protect privacy:** return only the caller's personal movements and authorized vault data. Existing v0 history endpoints do not constitute a complete v1 paper/onchain combined timeline. A future combined timeline needs separate source/mode/type fields and no double-counting of one logical event.
- **P06 is an engine change:** ingestion, registry lookup, decimals, price provenance, WS subscriptions, histories, position valuation, policy versions and retirement/unwind behavior must all support the added asset.
- **P07 quality filters are browse filters:** verification or organic score does not itself grant execution authority or guarantee asset safety.
- **P10/P15/P23 use notifications only after opt-in**, with frequency controls and deduplication; do not introduce outbound messaging simply because the feature is accepted.
- **P16/P17/P23/P24 need comparable records:** record starting rules, dates, seed/grants, model versions and resets; exclude test-seeded or reset histories from public rankings unless transparently classified. Require a minimum observation period before ranking.
- **P17 cannot reset pooled vaults or Crew claims:** archive/create a new private session; preserve old event/ledger history and never recycle pending-order keys.
- **P18/P19 need engine specifications first:** trigger source, event ordering, gaps, expiry, insufficient reserve, concurrency, cancellation, precision and idempotent fills. A stop trigger cannot promise a specific execution price.
- **P20 needs a provider decision:** validate licensing, quota, historical mint identity, OHLC aggregation, USD/USDC denomination and source labeling. Keep historical analysis data out of current execution observations.
- **P21 requires deployment details:** hosting owner, environment, TLS/domain, secret management, database/Redis access and migration/rollback procedures. Do not silently create billable infrastructure.
- **P27/P28 require model/version isolation:** performance from different fill assumptions or historical backtests must not share an unqualified public leaderboard.

### Optional endpoint sketches — only if the corresponding feature is accepted

These names are proposals, not existing routes. Reuse existing equivalents where they already satisfy the exact scope and privacy contract.

| Decision | Proposed endpoint | One-line purpose |
| --- | --- | --- |
| P01/P17 | `POST /v1/me/practice-sessions`; `POST /v1/me/practice-sessions/:id/archive` | Creates an isolated practice run or closes it without erasing history. |
| P02 | `GET /v1/vaults/:id/portfolio?range=7D` | Returns authorized cash, positions and performance with coverage. |
| P03 | `GET /v1/me/paper-activity?type=trade&limit=20&after=<cursor>` | Returns a private paginated timeline of paper balance events. |
| P04 | `GET /v1/vaults/:id/orders/:orderId/receipt` | Explains one order's requested and executed outcome. |
| P05 | `GET /v1/vaults/:id/positions/:instrumentId` | Returns cost basis, P&L and eligible sell capacity for one position. |
| P10 | `POST /v1/me/price-alerts`; `GET /v1/me/price-alerts` | Manages owned alert rules and their state. |
| P11 | `GET /v1/vaults/:id/benchmark?instrument=SOL&range=30D` | Compares matched-period returns using an agreed cash-flow method. |
| P14 | `PUT /v1/me/trade-notes/:orderId` | Saves an owned private note linked to an order. |
| P16 | `GET /v1/paper-leaderboards?cohort=<id>&limit=20&after=<cursor>` | Ranks comparable, eligible completed/observed records. |
| P18/P19 | `POST /v1/vaults/:id/conditional-orders` | Persists a paper trigger order under a separately approved execution specification. |
| P26 | `POST /v1/me/paper-exports` | Creates an authorized bounded/asynchronous history export. |

Private session trading routes must be specified if P01 is accepted; the v1 pooled-vault lifecycle cannot simply be bypassed. New mutation routes require authorization, validation, rate limits and idempotent semantics appropriate to their operation.

## 11. Product success measures

Instrument events without tokens, keys, raw auth data or private financial payloads in analytics.

| Measure | Definition / use |
| --- | --- |
| Time to first successful paper trade | From ready account to first simulated fill; segment pooled vault users and any accepted solo-practice mode. |
| Discovery-to-review conversion | Unique users opening a token detail who reach trade review; separate unsupported-token browsing from eligible trading. |
| Review-to-fill conversion | Reviewed intents that become fills; bucket rejection, cancellation, stale-price and abandoned outcomes. |
| Funding activation | Created rounds that become ACTIVE, time to target, and minimum-failure/refund rate. |
| Data availability | Share of tracked marks usable for display/execution, feed freshness, and valid historical coverage by interval. |
| Retention | D1/D7 return to a meaningful action such as a trade, journal review or portfolio review, rather than app-open counts alone. |
| Reliability | Safe-read failure rate, API restart recovery duration, stale snapshots served, provider 429s and unresolved financial intents. |

Do not optimize trade count alone; a paper product should help users understand decisions and outcomes. For the first release, collect baselines before setting business conversion targets.

## 12. Rollout and handoff completion

1. Keep existing v0 reads compatible while introducing versioned discovery contracts behind a proposed `MARKET_DISCOVERY_V1_ENABLED` flag and matching client capability gate.
2. Deploy additive schema/contracts and background refresh first. Inspect snapshots, quota consumption and query plans without changing the user feed.
3. Enable for internal Captain accounts. Validate account switching, actual paper order fills and suspended-phone restart recovery on Android.
4. Expand to a small pilot, watch freshness/latency/rejections and compare upstream request counts before/after.
5. Roll back by disabling new discovery reads/UI, preserving old supported-market access, order recovery, worker execution, settlement and claims. Do not reverse financial migrations or erase historical evidence.
6. Update this document with accepted IDs, completed IDs, commit hashes, migration names, test results, measured conditions and outstanding items.

Handoff acceptance requires actual backend/API/client behavior, not just implemented components. No market search result may debit money. No read retry may replay an unprotected financial mutation. No public UI may imply that paper profits are withdrawable SOL/USDC.

### Copy/paste instruction for the next agent

```text
Implement the ACCEPT items in backend/docs/paper-trading-discovery-handoff.md.
Accepted core IDs: <fill in>
Accepted product IDs: <fill in>
Rejected/deferred IDs: <fill in>

Read both repositories' AGENTS.md files and inspect current code before editing.
Preserve existing paper accounting, automatic balance setup, vault economics,
the frosted/coastal UI, account isolation, idempotency and restart fixes.
Implement backend contracts/provider/cache first, then connect the existing APK UI.
Keep discovery eligibility distinct from vault-specific trading authorization.
Resolve dependency conflicts before implementing affected optional features.
Run relevant integration/financial regressions and APK lint/typecheck.
Report commits, migrations, endpoint examples, test evidence and remaining gaps.
```

## 13. Sources and evidence

- Code paths and behavior were reviewed in the two local repositories at the baseline commits above.
- [Jupiter token information](https://developers.jup.ag/docs/tokens/token-information): discovery categories, provider intervals, search and metadata; checked 10 October 2026.
- [Jupiter Price V3](https://developers.jup.ag/docs/price): batched marks and omitted unreliable/unavailable prices; checked 10 October 2026.
- [Jupiter rate limits](https://developers.jup.ag/docs/portal/rate-limits): organisation-based quotas and shared request buckets; checked 10 October 2026.
- Existing regression evidence includes paper trade lifecycle/ledger checks, client intent recovery and a real watch restart with a suspended WebSocket client. Re-run relevant suites after implementation; historical passing results are not release approval for new code.
