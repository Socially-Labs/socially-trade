# Captain dashboard API and storage

The proposed aggregate performance card uses the additive [Captain portfolio API](captain-portfolio-api.md). The routes below retain their existing contracts.

The authenticated Captain home uses round-v2 vault records. It never falls back to the former sample balances or chart. Legacy v0 trial performance and personal wallet holdings remain separate.

## Storage

Migration `024_captain_dashboard.sql` is additive. It adds:

| Object | Purpose |
| --- | --- |
| `captain_vault_aum_rollups` | Per-vault hourly and daily last recorded AUM, observation timestamp, and valuation status. Primary key: `(fund_id, interval_seconds, bucket_at)`. |
| `captain_vault_metrics` | Live view joining owned rounds, latest NAV, settlement fees, and Captain claims. |
| NAV/phase triggers | Update chart buckets in the same transaction as valuations and lifecycle changes. Terminal rounds record zero managed assets. |
| Owner, contribution, and claim indexes | Support ownership-scoped aggregation and paginated read APIs. |

Existing `funds`, `vault_rounds`, `vault_contributions`, `fund_shares`, `nav_snapshots`, and `vault_claims` remain the authoritative financial records. No second spendable balance or editable dashboard totals are introduced. The migration backfills existing observations and finalized-round zero points.

Apply with `pnpm db:migrate` from `backend/`. Deploy the migration before the API that queries its view/table. It has been applied to the local development database; remote deployment is separate.

## Routes

All routes require a Bearer token and the Captain role. Responses use `mode: "PAPER"`, private ownership scope, `Cache-Control: no-store`, and the existing vault request limiter. Amounts are decimal strings; unavailable valuations are `null`.

| Method and route | Response |
| --- | --- |
| `GET /v1/me/captain/dashboard` | `state: NEW / EXISTING`, vault counts, unique Crew count, current AUM, earnings totals, creation eligibility, server timestamp. |
| `GET /v1/me/captain/performance?range=30D` | Timestamped AUM points, coverage, recorded dollar/percentage change, and methodology. Supports `7D`, `30D`, `90D`, `ALL`. |
| `GET /v1/me/captain/crew?limit=20&after=<uuid>` | Current members, public profile fields, allocated capital, number of owned vaults joined, first accepted join timestamp, next cursor. |
| `GET /v1/me/captain/earnings?limit=20&after=<uuid>` | Finalized rounds with earned, claimed, and claimable Captain fees and settlement/claim timestamps. |
| `GET /v1/me/captain/vaults?limit=20&after=<uuid>` | Existing owner-only vault summaries; now supports the standard vault pagination/filter query. |

Paginated routes accept limits 1–50 and UUID cursors. Crew/earnings use ascending UUID order; the existing vault list uses descending UUID order. Clients must use the returned cursor for that route.

## Definitions

- **New Captain:** no round-v2 vault has been created. Having completed/cancelled rounds still means `EXISTING`; a zero balance never means a new account.
- **Active vaults:** phase `ACTIVE`. Open rounds additionally include `FUNDRAISING`, `SETTLING`, and `REFUNDING`.
- **AUM:** latest available NAV across open rounds, including the Captain seed. Completed/cancelled rounds contribute zero even if proceeds are unclaimed. Missing, stale, settling, and refunding valuations make current AUM unavailable rather than zero.
- **Crew:** distinct accepted contributors across open owned rounds, excluding the Captain. Multiple contributions count one person. Cancelled allocations and terminal rounds are excluded.
- **Earned fees:** finalized `captain_fee_usdc`, including already claimed fees. Investment proceeds are excluded.
- **Claimed fees:** Captain fee amounts in `vault_claims`. Claimable fees equal earned minus claimed. Fee claims continue through the existing vault claim operation; the new endpoints are read-only.

## History semantics

7-day history uses hourly observations. 30-day and 90-day history use daily observations. All-time history uses daily source observations, grouped into wider buckets when needed to keep the response around 400 points.

Each point contains the last recorded value for each existing owned vault at that bucket. Values are carried from recorded observations, not interpolated returns. Missing valuations remain null. A later valid observation can replace an unavailable observation within the same bucket. Historical coverage is reported as `PARTIAL`; it does not imply uninterrupted full-period pricing. The app displays the first returned history date. Recorded change compares first and last returned AUM; it is null if any returned point is unavailable. Percentage change is also null when starting AUM is zero.

Contributions, cancellations, market movements, and round completion change AUM. AUM change is **not investment return**. The existing per-vault performance endpoint continues to provide economic share-price returns.

## Home states and actions

- Loading/error states are separate from the first-vault empty state.
- A new Captain sees the reference-style first-vault card. Its Create action opens `/vaults/create`.
- An existing Captain sees real AUM, graph, Crew, and earnings. Manage shows owned vaults; selecting a vault opens `/vaults/[id]` for the existing lifecycle/trading/claim flows.
- Crew and earnings details fetch lazily and support pagination.
- Private data is cleared on account changes. Reads abort on navigation/data-scope changes. The screen refreshes on focus, foreground, and every 15 seconds while active.
- Balance hiding also hides the chart. No fake pause-deposit control or local creation draft remains in the active Captain home flow.

Creation preserves the existing rules: one open round, 100 paper USDC seed, 1,000 minimum / 30,000 maximum accepted capital, fixed funding deadline, and capital locked until settlement. Paper creation requires `VAULT_PAPER_ENABLED=true`, `VAULT_TERMS_APPROVAL=locked-v1-retain-residue`, and an isolated environment without `USDG_MINT`. The local token-funded environment currently reports creation unavailable; these changes do not enable it or mix paper rounds with token redemption.

## Checks

`apps/api/test/captain-dashboard.test.mjs` tests migrations, authorization, ownership isolation, new/existing state, exact sums, Crew deduplication, cancellation, unknown marks, terminal AUM, and claimed fees in a disposable PostgreSQL schema. The existing `vault-rounds-simulation.test.mjs` covers lifecycle and ledger behavior with the new triggers installed. `apk/tests/captain-dashboard.test.mjs` checks response contracts and authenticated paths.

Browser verification covers the new and populated screens at 320/393/430 pixels, 90-day history, creation eligibility, real route navigation, privacy, roster/earnings details, account switching, and error recovery. Preview API data is mocked; tests do not submit real deposits or deploy vaults.
