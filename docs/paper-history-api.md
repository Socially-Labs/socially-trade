# Paper history API

These endpoints are implemented for the offchain v0 paper backend. They do not
read the v1 Solana program. All monetary values and quantities are decimal strings.

## Cursor convention

History pages are newest first, ordered by database timestamp and UUID as a
stable tie-breaker. Pass `limit=1..100` (default 100). Use the returned `nextCursor`
as `after` for the next page; null means the end. Cursors are UUID anchors scoped
to the requested fund, Captain or authenticated user. Malformed, unknown or
out-of-scope cursors return 400. Do not use the numeric event/chart cursors here.

New submissions appear on a fresh first page; they do not shift older pages.
This is not a frozen snapshot: pending order statuses may change while paging.
Do not modify historical submission timestamps or delete cursor anchor records.

## Fund order history

`GET /v0/funds/:fundId/orders?limit=100&after=<cursor>` (public)

Returns `{ mode: "PAPER", orders: [...], nextCursor }`. The existing `orders` field
is preserved. Every order includes its fund ID, side, notional, status, rejection
reason and timestamps, plus nullable fill quantity, price, fees, observation ID
and model version. All statuses are retained, including rejected/cancelled orders.
This replaces the former latest-100-only behavior.

## Captain history and statistics

`GET /v0/captains/:captainId/orders?limit=100&after=<cursor>` (public)

Same page shape, across all of the Captain's funds, including completed trials.
`captainId` is the user ID, not handle. Unknown Captains return 404.

`GET /v0/captains/:captainId/trade-statistics` (public)

Returns `statistics` with:

- `fund_count`, `submitted_orders`, `completed_trades`.
- `pending`, `filled`, `partially_filled`, `rejected`, `cancelled`.
- `completed_buys`, `completed_sells`.
- `executed_value_usdc`, `trading_fee_usdc`.
- `first_trade_at`, `last_trade_at` (null when no fills exist).

Completed trades count FILLED and PARTIALLY_FILLED orders only. Executed value is
quantity times actual simulated fill price, excluding fees. It measures gross
trading volume, not profit or investment return. Statistics cover all history,
independently of page size. Independent trial returns are not combined.

## Private Crew transaction timeline

`GET /v0/me/crew-transactions?limit=100&after=<cursor>` (bearer authentication)

Returns `{ mode: "PAPER", transactions: [...], nextCursor }`. Each item has:

- `id`: immutable source event UUID.
- `fund_id`, `sequence`, `recorded_at`, `type`.
- `amount_usdc`, `shares`, nullable `exit_cost_usdc`.

Types:

| Type | Meaning of positive amount |
|---|---|
| `crew_joined` | Virtual cash contributed into a fund |
| `crew_left` | Virtual cash redeemed out of a fund |
| `trial_completed` | Caller’s virtual settlement payout |

The API derives identity from the bearer token. It returns only the caller's
transactions and their own settlement fields, never the full multi-user payout
payload. Records remain available after all shares are redeemed. Captain seed
and settlement in their own managed fund are outside this Crew-specific timeline;
Captains who participate as Crew in someone else's fund are included.

This complements `/v0/me/paper-record` and personal performance summaries; it is
not a list of trades individually executed by Crew members.

## Verification

`apps/api/test/history-simulation.test.mjs` uses disposable localhost PostgreSQL
schemas and API requests. It checks more than 100 orders and Crew events,
timestamp ties, page exhaustion, completed fund history, actual fill fields,
Captain totals and partial-fill counts, new insertions while paging, Crew exits,
settlement privacy, authentication, foreign cursors and invalid limits.
