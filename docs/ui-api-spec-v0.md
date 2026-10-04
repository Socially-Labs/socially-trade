# v0 UI API integration specification

**Scope:** every route currently registered by the paper API (39 operations).
**Reviewed:** 4 October 2026, against the current workspace source.
**Audience:** web/mobile developers integrating Captain, Crew and public discovery screens.
**Contract:** implemented behavior, including current limitations. Examples are illustrative, not live account data. This document does not claim new runtime test results.

## 1. Connection and authentication

Local default base URL: `http://127.0.0.1:3000`. Configure the deployed API origin in the client; its production URL is not established by this repository. All paths below are relative to that origin.

- Requests/responses use JSON, except the event stream. Send `Content-Type: application/json` for JSON bodies.
- Protected operations require `Authorization: Bearer <Privy access token>`.
- Obtain the current token using the Privy client SDK's `getAccessToken()` before a protected request. Do not send an identity token, app secret, email or wallet address as authentication.
- Privy is the only authentication provider. The backend checks the app audience, issuer, expiry and ES256 signature using Privy's public JWKS derived from `PRIVY_APP_ID`.
- The app ID is client configuration; app secrets belong only on servers. No manually configured verification key is needed in the current workspace implementation.
- Sign-in, email OTP, logout and token refresh belong to the Privy client integration. There are no backend login-by-email, refresh-token or logout routes.
- A first authenticated request provisions the local user and grants **10,000 virtual USDC once**. Any protected request may do this; `/v0/auth/privy` is the explicit bootstrap route.
- `captainId`, `userId`, `authorId` and the account's `id` are local UUIDs. They are **not** the `did:privy:...` identifier. Save the bootstrap response's `user.id` for Captain lookups.
- Public routes listed below require no bearer token and do not create accounts.

### Browser deployment prerequisite

The API currently registers no CORS plugin or allowed-origin configuration. A browser frontend on a different origin cannot assume cross-origin requests work. Use a same-origin reverse proxy or implement API CORS for the chosen frontend origin before browser integration. Native clients do not have browser CORS restrictions.

## 2. Shared conventions

### Values and identifiers

| Value | Wire representation | UI rule |
| --- | --- | --- |
| USDC, quantity, shares, return percentages | Decimal strings | Use a decimal library; do not calculate money using JavaScript floating point. |
| Input USDC | Positive plain decimal string, up to 6 decimal places | Send `"100.000000"`, not `100`, `"1e2"` or a formatted amount. |
| Input shares | Positive plain decimal string, up to 18 decimal places | Preserve backend precision. |
| UUID IDs | String | Use server values; names/handles are not IDs. |
| Times | ISO 8601 strings, UTC | Convert for display; retain timestamps when explaining stale values. |
| Sequence/inbox IDs | Decimal integer strings | Retain as strings; see cursor ranges below. |
| Counts, policy basis points, model versions | JSON numbers | Percent = basis points / 100. |
| Missing financial metrics | `null` | Display unavailable, not zero. |

The API mixes camelCase DTOs and snake_case database rows. Preserve the exact shapes below or normalize them once in a client adapter. Most responses include `mode: "PAPER"`; Captain profile responses do not.

### Idempotency

Operations marked **Key** require `Idempotency-Key`, a string of 8–128 characters. Generate `crypto.randomUUID()` once per user action. Preserve that key and the same request body when retrying after a timeout or authentication refresh. Start a new key for a genuinely new action.

Keys are scoped to the authenticated user across routes. Reusing one for another route/body returns `409 idempotency_conflict`. Replayed responses preserve the original result; they may describe an order as `PENDING` even after it filled. Fetch the order for its current state. Do not assume keys expire; the current API exposes no expiry contract.

Profile creation, cancellation and marking notifications read do not take idempotency keys; their retry behavior is documented individually.

### Pagination: three separate contracts

| Endpoints | `after` | Ordering / default page | Completion |
| --- | --- | --- | --- |
| Fund orders, Captain orders, my Crew transactions | UUID of the previous page's last item | Newest first; `limit` string 1–100, default 100 | `nextCursor: null` |
| Fund NAV history | Event sequence string | Oldest first; `limit` string 1–100, default 100 | `nextCursor: null` |
| Events, messages, decisions, notifications | Sequence or notification ID string, default `"0"` | Oldest first; fixed maximum 100, no configurable limit | Use last returned cursor; an empty page means caught up |

UUID cursors must belong to that exact fund/Captain/account history. A wrong-scope cursor returns `400 invalid_cursor`. History/order `limit` must be sent as a query string, e.g. `?limit=25`; zero, 101 and extra query fields are rejected on routes with strict query schemas.

NAV history accepts nonnegative decimal sequence strings up to PostgreSQL bigint maximum `9223372036854775807`. Events/messages/decisions/notifications use the shared sequence parser and require a nonnegative JavaScript safe integer, at most `9007199254740991`.

Do not share cursor state between lists or between signed-in users. UUID history pagination is not a snapshot: statuses of existing orders can change while paging. To refresh newest rows, reload the first page and merge by ID.

## 3. Endpoint inventory

**Access:** Public = anonymous; User = bearer token; Captain = bearer token plus ownership/profile rules; Member = fund Captain or holder of positive fund shares. **Key** = mandatory idempotency header.

| # | Method and path | Access | Key | UI use | Success |
| --- | --- | --- | --- | --- | --- |
| 1 | `GET /health` | Public | — | Connectivity | 200 |
| 2 | `POST /v0/auth/privy` | User | — | Bootstrap account | 200 |
| 3 | `GET /v0/me` | User | — | Account header | 200 |
| 4 | `GET /v0/me/paper-balance` | User | — | Available virtual funds | 200 |
| 5 | `GET /v0/me/paper-positions` | User | — | Current fund allocations | 200 |
| 6 | `POST /v0/captains` | User | — | Captain onboarding | 201 / 200 replay |
| 7 | `GET /v0/captains/:captainId` | Public | — | Captain profile | 200 |
| 8 | `POST /v0/funds` | Captain | Yes | Start a trial | 201 |
| 9 | `GET /v0/funds` | Public | — | Fund discovery | 200 |
| 10 | `GET /v0/funds/:fundId` | Public | — | Fund summary | 200 |
| 11 | `GET /v0/funds/:fundId/policy` | Public | — | Risk limits | 200 |
| 12 | `GET /v0/funds/:fundId/holdings` | Public | — | Cash and SOL holdings | 200 |
| 13 | `POST /v0/funds/:fundId/joins` | User (non-Captain) | Yes | Allocate virtual USDC | 201 |
| 14 | `POST /v0/funds/:fundId/exits` | User (non-Captain) | Yes | Redeem fund shares | 200 |
| 15 | `POST /v0/funds/:fundId/orders/preview` | Captain owner | — | Trade confirmation | 200 |
| 16 | `POST /v0/funds/:fundId/orders` | Captain owner | Yes | Submit paper order | 202 |
| 17 | `GET /v0/funds/:fundId/orders` | Public | — | Fund trade history | 200 |
| 18 | `GET /v0/funds/:fundId/orders/:orderId` | Public | — | Order state / receipt | 200 |
| 19 | `POST /v0/funds/:fundId/orders/:orderId/cancel` | Captain owner | — | Cancel pending order | 200 |
| 20 | `GET /v0/captains/:captainId/orders` | Public | — | Captain lifetime history | 200 |
| 21 | `GET /v0/captains/:captainId/trade-statistics` | Public | — | Captain trade counts | 200 |
| 22 | `GET /v0/me/crew-transactions` | User | — | Crew activity timeline | 200 |
| 23 | `GET /v0/funds/:fundId/performance` | Public | — | Returns / trial / fees | 200 |
| 24 | `GET /v0/funds/:fundId/history` | Public | — | NAV chart | 200 |
| 25 | `GET /v0/me/funds/:fundId/performance` | User | — | Personal P&L | 200 |
| 26 | `GET /v0/me/paper-record` | User | — | Current and former allocations | 200 |
| 27 | `GET /v0/captains/:captainId/paper-record` | Public | — | Independent trial records | 200 |
| 28 | `GET /v0/funds/rankings` | Public | — | Leaderboard | 200 |
| 29 | `GET /v0/funds/:fundId/events` | Public | — | Activity / catch-up | 200 |
| 30 | `GET /v0/funds/:fundId/events/stream` | Public | — | Live fund updates | 200 SSE |
| 31 | `GET /v0/funds/:fundId/messages` | Public | — | Chat and note feed | 200 |
| 32 | `GET /v0/funds/:fundId/decisions` | Public | — | Captain decision log | 200 |
| 33 | `POST /v0/funds/:fundId/messages` | Member | Yes | Send chat | 201 |
| 34 | `POST /v0/funds/:fundId/orders/:orderId/notes` | Captain owner | Yes | Add/correct trade note | 201 |
| 35 | `GET /v0/me/notifications` | User | — | Inbox | 200 |
| 36 | `POST /v0/me/notifications/:notificationId/read` | User | — | Mark inbox item read | 200 |
| 37 | `GET /v0/captains/handle-availability` | Public | — | Check username while onboarding | 200 |
| 38 | `GET /v0/market/prices` | Public | — | Latest SOL snapshot | 200 |
| 39 | `GET /v0/ws` | Public / Privy for private channel | — | Market prices and personal inbox | 101 WebSocket |

## 4. Response models

These TypeScript declarations describe JSON wire shapes for integration. `Timestamp`, `UUID`, `Decimal` and `Sequence` are strings, not runtime validators. All fields are present unless explicitly optional. Dynamic event payloads and text methodology fields should be retained without assuming a fixed prose value.

```ts
type UUID = string;
type Timestamp = string;
type Decimal = string;
type Sequence = string;
type Mode = 'PAPER';
type FundStatus = 'ACTIVE' | 'FROZEN' | 'COMPLETED';
type OrderStatus = 'PENDING' | 'FILLED' | 'PARTIALLY_FILLED' | 'REJECTED' | 'CANCELLED';
type Valuation = 'CURRENT' | 'UNAVAILABLE';
type PerformanceValuation = Valuation | 'FINAL';
type Money = { value: Decimal; asset: 'USDC' };
type ApiError = { error: string; message: string };

type Account = { id: UUID; displayName: string; mode: Mode; paperCash: Money };
type CaptainProfile = { userId: UUID; handle: string; bio: string };
type FundSummary = {
  id: UUID; mode: Mode; status: FundStatus; name: string; captainId: UUID;
  nav: Money; sharePrice: Money; valuationStatus: Valuation; trialEndsAt: Timestamp;
};
type Allocation = {
  fundId: UUID; name: string; shares: Decimal; estimatedValueUsdc: Decimal | null;
  valuationStatus: Valuation; pricedAt: Timestamp | null;
};
type Policy = {
  version: number; max_order_bps: number; max_position_bps: number;
  drawdown_breaker_bps: number; allowed_instruments: string[]; effective_at: Timestamp;
};
type Holding = { instrument_id: string; symbol: string; quantity: Decimal; cost_basis_usdc: Decimal };
type CrewChange = {
  mode: Mode; fundId: UUID; eventId: UUID; shares: Decimal;
  virtualUsdc: Decimal; sharePrice: Decimal;
};
type FillEstimate = {
  modelVersion: number; quantity: Decimal; marketPriceUsdc: Decimal;
  fillPriceUsdc: Decimal; feeUsdc: Decimal; cashChangeUsdc: Decimal;
};
type Order = {
  id: UUID; side: 'BUY' | 'SELL'; instrument_id: string; notional_usdc: Decimal;
  status: OrderStatus; reject_reason: string | null;
  submitted_at: Timestamp; processed_at: Timestamp | null;
  quantity: Decimal | null; market_price_usdc: Decimal | null;
  fill_price_usdc: Decimal | null; fee_usdc: Decimal | null;
  model_version: number | null; observation_id: UUID | null;
};
type HistoryOrder = Order & { fund_id: UUID }; // list rows only; detail omits fund_id

type TradeStatistics = {
  user_id: UUID; fund_count: number; submitted_orders: number; completed_trades: number;
  pending: number; filled: number; partially_filled: number; rejected: number; cancelled: number;
  completed_buys: number; completed_sells: number;
  executed_value_usdc: Decimal; trading_fee_usdc: Decimal;
  first_trade_at: Timestamp | null; last_trade_at: Timestamp | null;
};
type CrewTransaction = {
  id: UUID; fund_id: UUID; sequence: Sequence; recorded_at: Timestamp;
  type: 'crew_joined' | 'crew_left' | 'trial_completed';
  amount_usdc: Decimal | null; shares: Decimal | null; exit_cost_usdc: Decimal | null;
};
type PerformancePoint = {
  sequence: Sequence; recordedAt: Timestamp; pricedAt: Timestamp;
  navUsdc: Decimal; sharePriceUsdc: Decimal; performanceFeeFactor: Decimal;
};
type PeriodReturn = {
  baselineAt: Timestamp; endAt: Timestamp;
  netReturnPercent: Decimal | null; grossReturnPercent: Decimal | null;
};
type PerformanceMetrics = {
  sinceInception: { netReturnPercent: Decimal | null; grossReturnPercent: Decimal | null };
  period7d: PeriodReturn | null; period30d: PeriodReturn | null;
  maxDrawdownPercent: Decimal; currentDrawdownPercent: Decimal | null;
  sampleCount: number; firstRecordedAt: Timestamp; lastRecordedAt: Timestamp;
};
type FundPerformance = {
  mode: Mode; fundId: UUID; fundName: string; captainId: UUID; status: FundStatus;
  totalShares: Decimal; valuationStatus: PerformanceValuation;
  current: (PerformancePoint & PerformanceMetrics) | null;
  latestHistorical: (PerformancePoint & PerformanceMetrics) | null;
  methodology: {
    version: number; netReturn: string; grossReturn: string; drawdown: string;
    periods: string; chartGaps: string; unavailable: string;
  };
  trial: { startsAt: Timestamp; endsAt: Timestamp; elapsedDays: number;
    remainingDays: number; settlementPending: boolean };
  orders: { pending: number; filled: number; partially_filled: number; rejected: number; cancelled: number };
  fees: {
    simulated: boolean; modelVersion: number; performanceFeePercent: Decimal;
    captainShareOfFeePercent: Decimal; protocolShareOfFeePercent: Decimal;
    assessmentPolicy: string; performanceFeeUsdc: Decimal; captainFeeShares: Decimal;
    protocolFeeShares: Decimal; assessmentCount: number; lastAssessmentAt: Timestamp | null;
    tradingFeeUsdc: Decimal; filledNotionalUsdc: Decimal;
  };
};
type NavHistoryPoint = {
  sequence: Sequence; recordedAt: Timestamp; pricedAt: Timestamp; valuationStatus: Valuation;
  navUsdc: Decimal | null; sharePriceUsdc: Decimal | null;
  performanceFeeFactor: Decimal; grossSharePriceUsdc: Decimal | null;
};
type PersonalPerformance = {
  mode: Mode; fundId: UUID; shares: Decimal; valuationStatus: PerformanceValuation;
  contributionsUsdc: Decimal; withdrawalsUsdc: Decimal;
  currentValueUsdc: Decimal | null; pnlUsdc: Decimal | null;
  pnlPercentOfContributions: Decimal | null; returnMethod: 'SIMPLE_PNL_OVER_CONTRIBUTIONS';
  explanation: string; historicalPositionValueUsdc: Decimal | null; historicalPricedAt: Timestamp | null;
};
type FundEvent = {
  id: UUID; sequence: Sequence; type: string; payload: Record<string, unknown>; recorded_at: Timestamp;
};
type Message = {
  id: UUID; kind: 'CHAT' | 'TRADE_NOTE'; body: string; authorId: UUID;
  linkedOrderId: UUID | null; correctsMessageId: UUID | null;
  sequence: Sequence; createdAt: Timestamp;
};
type Notification = {
  id: Sequence; fundId: UUID; type: string; payload: Record<string, unknown>;
  createdAt: Timestamp; readAt: Timestamp | null;
};
```

## 5. Accounts and Captain onboarding

### 1. `GET /health`

No body/query. Response: `{ "status": "ok", "mode": "PAPER" }`.
This is process liveness; it does not prove database, prices or worker readiness.

### 2. `POST /v0/auth/privy`

Bearer required. No body, or `{}`. Any supplied body fields are rejected. Response has `Cache-Control: no-store`:

```json
{
  "mode": "PAPER",
  "provider": "privy",
  "privyUserId": "did:privy:example",
  "user": {
    "id": "11111111-1111-4111-8111-111111111111",
    "displayName": "Trader",
    "paperCash": { "value": "10000.000000000000000000", "asset": "USDC" }
  }
}
```

Returns the same account on repeat; balance reflects current cash, not necessarily the initial grant. The access token does not populate email, avatar or wallet profile details. No new API token or cookie is issued. Errors: common auth/configuration errors in section 11.

### 3. `GET /v0/me`

Bearer required. No body/query. Response: `Account`. The returned `id` is the Captain identifier if this user creates a Captain profile.

### 4. `GET /v0/me/paper-balance`

Bearer required. No body/query. Response: `{ mode: Mode; available: Money }`. Cash is virtual, available for Captain seed or Crew joins; it excludes funds already allocated.

### 5. `GET /v0/me/paper-positions`

Bearer required. No body/query. Response: `{ mode: Mode; positions: Allocation[] }`. Only allocations with positive current shares; newest fund first. Includes the Captain's own stake. No pagination.

A non-null `estimatedValueUsdc` may still be a historical estimate when `valuationStatus` is `UNAVAILABLE`. Label it accordingly. Use personal performance for contribution/P&L calculations.

### 6. `POST /v0/captains`

Bearer required. Body: `{ handle: string; bio?: string }`.

```json
{ "handle": "jassbawa", "bio": "My SOL paper trial" }
```

`handle`: lowercase letters, digits or `_`, 3–24 characters (`^[a-z0-9_]{3,24}$`). `bio`: at most 500 characters, defaults to empty string. No additional fields.

Response: `CaptainProfile`. First create: 201. Repeat with the same handle: 200 and the **existing** bio; this route does not update profiles. Different handle on an existing profile: `409 captain_profile_exists`. A handle owned by someone else: `409 conflict`.

### 7. `GET /v0/captains/:captainId`

Public. Path uses local user UUID, not a handle. No query/body. Response: `CaptainProfile`. Missing profile: `404 captain_not_found`.

### 37. `GET /v0/captains/handle-availability`

Public. Required query: `?handle=jassbawa`. The handle follows the same lowercase
3–24 character pattern as profile creation; additional query fields are rejected.
Invalid/missing handle: `400 invalid_request`. Response has `Cache-Control: no-store`:

```json
{ "mode": "PAPER", "handle": "jassbawa", "available": true }
```

Debounce typing checks (e.g. 300 ms), cancel obsolete requests and apply a response
only if its `handle` still matches the field. The result is advisory, not a reservation:
another user may claim the name before submission. POST captains still enforces
the database unique constraint and can return `409 conflict`.

Redis Bloom filtering skips an indexed handle lookup for synchronized negative
matches. Possible matches are confirmed in PostgreSQL. Cold/stale/missing Redis
filters and Redis outages fall back to PostgreSQL, preserving the same response shape.
No Redis setup details are exposed in the UI. See [handle index operations](captain-handle-bloom.md).

## 6. Funds and Crew allocation

### 8. `POST /v0/funds`

Bearer + Captain profile + idempotency key. Body: `{ name: string; description?: string }`.

```json
{ "name": "SOL Trial", "description": "A 30-day simulated strategy" }
```

`name`: 3–80 characters before trimming and at least 3 after trimming. `description`: up to 1,000 characters; trimmed; default `""`. No extra fields.

201 response: `FundSummary`. Creates a 30-day trial and deducts a fixed **1,000 virtual USDC** Captain stake. One ACTIVE/FROZEN trial per Captain. Seed amount/duration/policy cannot be supplied by the client. Accepted description is stored but not returned by current fund reads.

Errors: `400 invalid_name`, `403 captain_required`, `409 active_trial_exists`, `409 idempotency_conflict`, `422 insufficient_virtual_cash`.

### 9. `GET /v0/funds`

Public. No supported filters, search or pagination. Response: `{ mode: Mode; funds: FundSummary[] }`, newest **30** funds, including completed ones. This is not a full historical directory.

### 10. `GET /v0/funds/:fundId`

Public. Response: `FundSummary`. Missing fund: `404 fund_not_found`. For stale/unavailable NAV, never render `nav.value` or `sharePrice.value` as a verified current price just because they are populated. Use performance for final settled NAV and timestamps.

### 11. `GET /v0/funds/:fundId/policy`

Public. Response: `{ mode: Mode; policy: Policy }`:

```json
{
  "mode": "PAPER",
  "policy": {
    "version": 1,
    "max_order_bps": 1000,
    "max_position_bps": 2500,
    "drawdown_breaker_bps": 3000,
    "allowed_instruments": ["SOL"],
    "effective_at": "2026-10-04T10:00:00.000Z"
  }
}
```

These mean 10% order/NAV cap, 25% position cap and 30% drawdown breaker. There is no policy-update endpoint. Missing fund: `404 fund_not_found`.

### 12. `GET /v0/funds/:fundId/holdings`

Public. Response: `{ mode: Mode; cashUsdc: Decimal; positions: Holding[] }`. Only positive instrument positions; symbol ascending. This reports quantities and cost basis, not per-position current market values or P&L. Missing fund: `404 fund_not_found`.

### 13. `POST /v0/funds/:fundId/joins`

Bearer + key; the fund's Captain cannot join their own trial. Body: `{ "amountUsdc": "100.000000" }`. Minimum 1 USDC; at most 6 decimal places; no extra fields.

201 response: `CrewChange`. `shares` is the amount **minted by this action**, `virtualUsdc` the amount contributed, and `sharePrice` the resulting fund unit price. Requires ACTIVE fund before trial expiry and a fresh valuation where positions exist.

Errors: `400 invalid_amount`, `400 amount_too_small`, `403 captain_seed_fixed`, `404 fund_not_found`, `409 fund_not_active`, `409 idempotency_conflict`, `422 insufficient_virtual_cash`, `422 shares_too_small`, `503 valuation_unavailable`.

### 14. `POST /v0/funds/:fundId/exits`

Bearer + key. Body: `{ "shares": "100.000000000000000000" }`. Redeems a specified share count, not a USDC amount. Positive, at most 18 decimal places; no extra fields.

200 response: `CrewChange`. Here `shares` is **burned**, `virtualUsdc` is the virtual payout, and `sharePrice` is the remaining fund's unit price. Current v0 performs synchronous pro-rata liquidation of instrument holdings with a 0.2% haircut on the liquidated assets, plus the user's cash portion. It exposes no exit preview, queue or asynchronous exit job. Captain seed is locked. Unlike joins, this route has no explicit ACTIVE-only gate; share ownership and valuation still apply.

Errors: `400 invalid_shares`, `403 captain_stake_locked`, `404 fund_not_found`, `409 fund_seed_required`, `409 idempotency_conflict`, `422 insufficient_shares`, `422 exit_too_small`, `503 valuation_unavailable`.

After join/exit, refresh `/me/paper-balance`, `/me/paper-positions`, personal performance, fund summary/holdings/performance and Crew transactions. Use event ID to correlate, not to infer a sequence cursor.

## 7. Paper orders and trade history

### 15. `POST /v0/funds/:fundId/orders/preview`

Bearer, fund Captain. No idempotency key. Body:

```json
{ "side": "BUY", "instrumentId": "SOL", "notionalUsdc": "50.000000" }
```

`side`: BUY/SELL; `instrumentId`: 1–32 characters, currently only SOL is allowed; `notionalUsdc`: positive decimal string up to 6 places, **1–1,000 USDC inclusive**. No other fields. SELL also uses USDC notional; it does not accept a SOL quantity.

200 response:

```ts
{ mode: Mode; estimate: FillEstimate;
  policy: { allowed: boolean; reason: string | null };
  observationId: UUID; observedAt: Timestamp }
```

Estimate includes simulated quantity, market/fill prices, fee and signed cash change. A risk-policy failure can be **200 with `policy.allowed: false`**; display the reason and disable confirmation. Reasons: `asset_not_allowed`, `order_too_large`, `insufficient_cash`, `insufficient_position`, `position_limit`, `drawdown_breaker`.

Preview is not a locked quote or an order reservation. No balances change. Common route errors: `400 invalid_notional`, `400 order_size_out_of_range`, `403 captain_required`, `404 fund_not_found`, `409 fund_not_tradable`, `422 asset_not_allowed`, `503 price_unavailable`, `503 valuation_unavailable`.

### 16. `POST /v0/funds/:fundId/orders`

Bearer + Captain ownership + key. Same body as preview. 202 response:

```json
{ "mode": "PAPER", "orderId": "22222222-2222-4222-8222-222222222222", "status": "PENDING" }
```

202 means **accepted for simulation**, not filled. Submission validates amount, ownership, fund state and active instrument; the worker checks policy, balance and prices at execution. A submitted order can later reject even after a successful preview.

Fresh price execution starts no earlier than three seconds after submission; both price source and receipt must meet the eligibility boundary. Worker scheduling and price availability add latency. A missing eligible price can keep it pending until the worker rejects it after the configured 120-second wait. These are model timings, not an HTTP completion guarantee.

Errors: `400 invalid_notional`, `400 order_size_out_of_range`, `403 captain_required`, `404 fund_not_found`, `409 fund_not_tradable`, `409 idempotency_conflict`, `422 asset_not_allowed`.

### 17. `GET /v0/funds/:fundId/orders`

Public. UUID pagination: `?limit=25&after=<order-uuid>`. Response: `{ mode: Mode; orders: HistoryOrder[]; nextCursor: UUID | null }`. Includes all statuses and fill details. Newest first by submission time then ID. Missing fund: `404 fund_not_found`; wrong cursor: `400 invalid_cursor`.

### 18. `GET /v0/funds/:fundId/orders/:orderId`

Public. Response: `{ mode: Mode; order: Order }`. Detail omits `fund_id`; retain the fund ID from the request. Missing/wrong-fund order: `404 order_not_found`.

Example pending order:

```json
{
  "mode": "PAPER",
  "order": {
    "id": "22222222-2222-4222-8222-222222222222",
    "side": "BUY", "instrument_id": "SOL", "notional_usdc": "50.000000000000000000",
    "status": "PENDING", "reject_reason": null,
    "submitted_at": "2026-10-04T10:00:00.000Z", "processed_at": null,
    "quantity": null, "market_price_usdc": null, "fill_price_usdc": null,
    "fee_usdc": null, "model_version": null, "observation_id": null
  }
}
```

Render fill values only when present. Recognize PARTIALLY_FILLED in the wire contract even though current SOL execution normally fills or rejects the whole order. Rejected/cancelled orders still belong in history.

### 19. `POST /v0/funds/:fundId/orders/:orderId/cancel`

Bearer, order Captain. No required body or key. Response: `{ mode: Mode; orderId: UUID; status: 'CANCELLED' }`. Only PENDING can cancel. Repeating cancellation returns 200 if already CANCELLED. A race with execution returns `409 order_already_processed`; refetch and display the actual final status. Other errors: `403 captain_required`, `404 order_not_found`.

### 20. `GET /v0/captains/:captainId/orders`

Public. Same UUID pagination as fund history. Response: `{ mode: Mode; captainId: UUID; orders: HistoryOrder[]; nextCursor: UUID | null }`. Spans all Captain funds, including completed trials. Group/link rows using `fund_id`. Errors: `404 captain_not_found`, `400 invalid_cursor`.

### 21. `GET /v0/captains/:captainId/trade-statistics`

Public. No query. Response: `{ mode: Mode; captainId: UUID; statistics: TradeStatistics; methodology: string }`.

`completed_trades` = FILLED + PARTIALLY_FILLED orders; submitted orders include all statuses. `executed_value_usdc` = actual fill quantity × fill price, excluding fees. It is not requested notional, P&L or a combined Captain return. No trades means zero counts/amounts and null first/last trade dates. Missing Captain: `404 captain_not_found`.

### 22. `GET /v0/me/crew-transactions`

Bearer. UUID pagination. Response: `{ mode: Mode; transactions: CrewTransaction[]; nextCursor: UUID | null }`.

`crew_joined`: contribution; `crew_left`: redemption with exit cost; `trial_completed`: this user's settlement payout for a fund they joined as Crew. Captain seed and own-fund settlement are not Crew transactions. `amount_usdc` is positive in each case; interpret direction from `type`, not a negative sign. `exit_cost_usdc` is null outside crew_left. This endpoint supplies IDs, not fund names; resolve names via cached fund summaries or detail reads. Wrong user cursor: `400 invalid_cursor`.

## 8. Performance, charts and records

### 23. `GET /v0/funds/:fundId/performance`

Public. Response: `FundPerformance`. Missing fund: `404 fund_not_found`.

- `CURRENT`: current values available; `FINAL`: terminal settlement values; `UNAVAILABLE`: `current` is null and `latestHistorical` may still be available.
- Net return uses unit share prices after trading costs and performance fees, excluding subscriptions/redemptions. Gross return removes performance fees but retains trading costs.
- Seven/thirty-day returns can be null without adequate history. They are not automatically zero for new funds.
- Drawdown is sampled from recorded share-price points, not every market tick.
- `orders` is per-fund status counts; `fees.filledNotionalUsdc` sums requested notional for orders with fills and differs from Captain statistics' executed value.
- `trial.settlementPending` means the trial expired but has not completed settlement. Disable new joins/orders after expiry even if the fund still says ACTIVE. The worker performs settlement; there is no client settlement endpoint.
- Fund summary/holdings after completion may show emptied balances; use this response's FINAL metrics for preserved trial results.

### 24. `GET /v0/funds/:fundId/history`

Public. Sequence pagination: `?after=0&limit=100`. Response: `{ mode: Mode; fundId: UUID; points: NavHistoryPoint[]; nextCursor: Sequence | null }`. Ascending event sequence; includes explicit UNAVAILABLE gaps. Missing fund: `404 fund_not_found`; oversized cursor: `400 invalid_cursor`.

Render gaps when `valuationStatus` is UNAVAILABLE. Never interpolate return lines across them as if prices were observed. `grossSharePriceUsdc` includes the performance fee adjustment factor, not a fee-free execution price.

### 25. `GET /v0/me/funds/:fundId/performance`

Bearer. Response: `PersonalPerformance`. It reports only the authenticated user's activity. A user without holdings/activity can receive zero contributions/shares; it is not a membership authorization gate. Missing fund: `404 fund_not_found`.

P&L = withdrawals + current value − contributions; percentage = P&L / contributions. This includes earned Captain fee shares but ignores timing of cash flows; it is not IRR or time-weighted return. Stale valuation can return null current value/P&L. Completed-fund current position value is zero after redemption, with payouts in withdrawals.

### 26. `GET /v0/me/paper-record`

Bearer. No pagination. Response:

```ts
{ mode: Mode; records: { fund: FundPerformance; personal: PersonalPerformance }[] }
```

Includes fund share records even after shares become zero, preserving former allocations and settled trials; newest fund first. Includes Captain and Crew allocations. An account with no allocations gets `records: []`.

### 27. `GET /v0/captains/:captainId/paper-record`

Public. Response: `{ mode: Mode; captainId: UUID; records: FundPerformance[]; disclaimer: string }`. All independent funds newest first; no pagination. No combined return. Missing Captain: `404 captain_not_found`.

### 28. `GET /v0/funds/rankings`

Public. No supported filters/pagination. Response:

```ts
{
  mode: Mode; rankingMethod: 'SINCE_INCEPTION_NET_RETURN'; minimumAgeDays: number;
  universe: string; disclaimer: string;
  funds: (FundPerformance & { rank: number })[];
}
```

Considers the newest 100 funds with CURRENT/FINAL valuations and age at least seven days. Descending net return; ties by fund ID. It ranks funds, not aggregated Captains. Display the disclaimer: this is not risk-adjusted and not the full universe. An empty leaderboard is valid.

## 9. Fund activity, chat and decision log

### 29. `GET /v0/funds/:fundId/events`

Public. `?after=0` sequence cursor. Response: `{ mode: Mode; events: FundEvent[] }`. Fixed 100 maximum, ascending sequence, no nextCursor. Request after the last returned `sequence` until caught up. Missing fund: `404 fund_not_found`; invalid sequence: `400 invalid_cursor`.

### 30. `GET /v0/funds/:fundId/events/stream`

Public. Server-sent events; content type `text/event-stream; charset=utf-8`. Initial `?after=<sequence>` or `Last-Event-ID: <sequence>`; query takes precedence if both provided. Native browser EventSource automatically sends Last-Event-ID on reconnect, but a persistent `?after` would override it. For manual reconnects update the query to the last processed ID.

```text
: connected to PAPER fund <fundId>

id: 12
event: fund-event
data: {"mode":"PAPER","id":"<eventUuid>","sequence":"12","type":"order_filled","payload":{"orderId":"<orderUuid>"},"recorded_at":"2026-10-04T10:00:04.000Z"}

: heartbeat
```

The illustrative payload above is shortened; real order_filled events contain execution data. Listen for the named **`fund-event`**, not just EventSource `onmessage`. Event data is `FundEvent & { mode: Mode }`. Server checks for new events about every two seconds; full batches drain immediately. Comment lines are heartbeats, not JSON messages. Stream errors after opening close the connection rather than send JSON errors.

Reconnect with backoff and the last successfully applied sequence. Deduplicate by event UUID/sequence, and reconcile REST reads on reconnect. Close the stream when leaving the fund screen. Public streams need no auth header.

Known event types include `fund_started`, `crew_joined`, `crew_left`, `order_submitted`, `order_filled`, `order_rejected`, `order_cancelled`, `fund_marked`, `drawdown_breaker`, `fee_assessed`, `trial_liquidated`, `trial_completed`, `chat_message_posted`, `trade_note_posted`. Treat types as extensible strings. Public event payloads can contain local user IDs and settlement payout data; do not treat this stream as a private inbox.

Useful invalidation rules:

| Event | Refresh |
| --- | --- |
| order_submitted / order_cancelled / order_rejected | Order detail/history, statistics, performance counts |
| order_filled | Above plus holdings, NAV/performance/history |
| fund_marked / drawdown_breaker / fee_assessed | Summary, policy display state, performance/history, personal valuation |
| crew_joined / crew_left | Fund NAV/holdings; own cash/positions/P&L/transactions when relevant |
| trial_completed | Summary, FINAL performance/records, own cash/positions/transactions |
| chat_message_posted / trade_note_posted | Messages/decisions using their own sequence cursors |

### 31. `GET /v0/funds/:fundId/messages`

Public. Sequence `after`, fixed 100 maximum. Response: `{ mode: Mode; messages: Message[] }`. Includes CHAT and TRADE_NOTE, ascending message event sequence; only VISIBLE messages. Advance after the final message `sequence`. Missing fund: `404 fund_not_found`.

### 32. `GET /v0/funds/:fundId/decisions`

Public. Same sequence paging. Response: `{ mode: Mode; notes: Message[] }`, TRADE_NOTE only. Includes original notes and append-only corrections. Missing fund: `404 fund_not_found`.

### 33. `POST /v0/funds/:fundId/messages`

Bearer + key. Captain or positive-share Crew member. Body: `{ "body": "Following this trade." }`. Trimmed message must contain 1–2,000 characters; no additional fields.

201 response: `{ mode: Mode; message: Message }`. `kind: CHAT`, linked/corrected IDs null. Errors: `400 invalid_message`, `403 crew_required`, `404 fund_not_found`, `409 idempotency_conflict`. There are no edit/delete endpoints or Captain-only read restrictions.

### 34. `POST /v0/funds/:fundId/orders/:orderId/notes`

Bearer + Captain ownership + key. Body: `{ body: string; correctsMessageId?: UUID }`.

```json
{ "body": "Reducing exposure after the price move." }
```

To correct: send another note with `correctsMessageId` referring to a note by the same Captain on this exact order/fund. 201 response: `{ mode: Mode; message: Message }`; kind TRADE_NOTE and linkedOrderId populated. The original remains visible; render the correction chain. Notes can attach to existing orders regardless of status.

Errors: `400 invalid_message`, `403 captain_required`, `404 fund_not_found`, `404 order_not_found`, `404 note_not_found`, `409 idempotency_conflict`.

## 10. Personal inbox

### 35. `GET /v0/me/notifications`

Bearer. `?after=0` inbox ID cursor, fixed 100 maximum. Response: `{ mode: Mode; notifications: Notification[] }`. ID is a decimal string, not a UUID. Ascending ID, no nextCursor. Includes read and unread notifications; filter visually using `readAt`. No unread-count endpoint.

Inbox delivery is asynchronous through the worker, so a fund event can precede its notification. Supported delivery types include order_submitted/filled/rejected/cancelled, drawdown_breaker, fee_assessed, trial_completed and trade_note_posted. The worker also recognizes policy_changed, but the API exposes no policy change operation. Chat messages do not produce inbox notifications in the current delivery list.

Polling with an after cursor only discovers newer notifications; it will not return earlier items when their read state changes on another device. Merge the mark-read response locally and reload from after=0 when full reconciliation is needed.

### 36. `POST /v0/me/notifications/:notificationId/read`

Bearer. No required body/key. Notification ID is a positive safe-integer string. Response: `{ mode: Mode; id: Sequence; readAt: Timestamp }`. Repeating preserves the original read time. Zero: `400 invalid_identifier`; invalid sequence syntax/range: `400 invalid_cursor`; absent or another user's notification: `404 notification_not_found`.

## 11. Errors and recovery

JSON error envelope:

```json
{ "error": "price_unavailable", "message": "Fresh market price unavailable" }
```

All endpoints can fail with common errors; endpoint sections list additional expected domain errors. Fastify schema failures return `400 invalid_request` with a diagnostic message. Do not depend on exact message wording; branch on `error` and status.

| Status / code | UI behavior |
| --- | --- |
| 400 invalid_request / invalid_identifier / invalid_cursor | Fix inputs or reset that list's cursor. Malformed UUID path IDs may return invalid_identifier. |
| 400 idempotency_key_required | Fix client integration: attach 8–128 character key on marked routes. |
| 401 unauthorized | Obtain a refreshed Privy token and retry once. If still rejected, require sign-in. Preserve action key. |
| 403 captain_required / crew_required / captain_seed_fixed / captain_stake_locked | Explain eligibility/ownership restriction and disable that action. |
| 404 resource-specific code | Show unavailable/deleted item or clear stale selection. |
| 409 idempotency_conflict | Do not automatically resubmit under a new key; reconcile original action and user intent. |
| 409 fund_not_active / fund_not_tradable / active_trial_exists / order_already_processed | Refresh authoritative state and explain the changed condition. |
| 409 conflict | Generic database uniqueness conflict, e.g. handle already taken. |
| 422 domain-specific code | Explain insufficient cash/shares, disallowed asset or action size. |
| 503 price_unavailable / valuation_unavailable | Show stale/unavailable market state; disable dependent actions and retry reads with backoff. |
| 503 auth_unconfigured / auth_unavailable | Backend Privy configuration or key-fetch issue; a new user login is not necessarily the fix. |
| 503 database_unconfigured | Backend deployment configuration issue. |
| 500 internal_error | Generic failure; do not assume a timed-out mutation failed. Retry keyed mutations with the original key. |

Some schema checks run before bearer verification; an invalid body can return 400 even if authentication is missing. Do not rely on error-check ordering. There is no application-level 429/rate-limit contract currently; gateways may add deployment-specific responses.

## 12. Recommended screen flows

### Sign-in and account

1. Sign in with Privy client SDK.
2. Get access token → POST auth/privy → cache local `user.id` and current virtual cash.
3. Load GET me, paper-positions and paper-record as needed.
4. GET captains/<user.id> determines whether a Captain profile exists; 404 means offer Captain onboarding, not that the account failed.
5. On logout clear private caches, pending account-specific cursors and inbox state.

### Captain dashboard and trading

1. Check handle-availability while choosing a username, then POST captains if needed; POST funds with a new action key to start trial.
2. Find own funds using Captain paper-record (discovery is capped and cannot be relied on to contain them).
3. Load summary, policy, holdings, performance, orders and decisions for selected fund.
4. Preview BUY/SELL → show estimated fees, timestamps and policy result → submit with a new key.
5. Show PENDING immediately. Follow event stream and/or poll GET order approximately every 2–3 seconds while pending. Stop polling on terminal state or leaving the screen; resume by fetching the order later.
6. Reconcile on terminal status. Keep rejected/cancelled orders in history and show rejection reason.
7. Add note via POST notes; get per-fund performance and Captain statistics/record for dashboards.
8. Hide joins/exits on the Captain's own fund; seed stays locked until worker settlement.

### Crew discovery and portfolio

1. Public funds/rankings → fund summary, Captain profile, policy, holdings/performance/history and decisions.
2. Authenticate before joining; check available paper balance.
3. POST joins → refresh own balance, allocations and P&L.
4. Show personal performance separately from fund return and explain virtual money.
5. For exit, select shares from own allocation; POST exits. Do not promise an exact pre-exit quote because there is no preview endpoint.
6. Use paper-record for exited/completed positions and Crew transactions for contributions/redemptions/settlement timeline.

### Minimal client request helper

```ts
const apiBase = configuredApiOrigin;
async function request<T>(path: string, options: {
  method?: 'GET' | 'POST'; authenticated?: boolean;
  body?: unknown; idempotencyKey?: string;
} = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (options.authenticated) {
    const token = await getAccessToken(); // supplied by the Privy client integration
    if (!token) throw new Error('Sign-in required');
    headers.Authorization = `Bearer ${token}`;
  }
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;
  const response = await fetch(`${apiBase}${path}`, {
    method: options.method ?? 'GET', headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const payload = await response.json();
  if (!response.ok) throw Object.assign(new Error(payload.message ?? 'API request failed'), {
    status: response.status, code: payload.error,
  });
  return payload as T; // add runtime schema validation in the consuming client
}

// Store this action key until the result is reconciled. Do not generate it inside a retry loop.
const actionKey = crypto.randomUUID();
const accepted = await request<{ mode: 'PAPER'; orderId: string; status: 'PENDING' }>(
  `/v0/funds/${fundId}/orders`, {
    method: 'POST', authenticated: true, idempotencyKey: actionKey,
    body: { side: 'BUY', instrumentId: 'SOL', notionalUsdc: '50.000000' },
  },
);
```

This helper is illustrative; add cancellation, timeout, runtime validation and controlled retry handling in the client. Never log bearer tokens. A request timeout cancels waiting, not necessarily the backend action.

## 13. Current integration gaps

The following have no implemented v0 UI endpoint: price ticker/candles or instrument search, Captain directory/search, profile/fund editing, policy mutation, extra Captain deposits, order amendment, limit/stop/leverage trades, exit preview/queue, private chat, unread count, push-device registration, real deposits/withdrawals, wallet signing, or v1 onchain operations.

The trade screen can use the SOL order preview for a current estimate, but there is no standalone live price endpoint. Limits currently permit SOL spot only. Do not wire proposed whitepaper features to invented routes.

Fund descriptions are accepted on creation but absent from read responses. Fund discovery, rankings and records lack pagination as noted above. These limitations should be considered when designing long-lived lists.

## 14. Source map and maintenance

| Contract area | Implementation |
| --- | --- |
| Registration / error envelope / health | `apps/api/src/app.ts` |
| Privy bootstrap / identity | `apps/api/src/auth-routes.ts`, `auth.ts`, `privy.ts` |
| Account / Captain profile | `apps/api/src/account-routes.ts` |
| Handle availability / Redis Bloom index | `apps/api/src/captain-handles.ts`, `packages/db/migrations/010_captain_handle_index.sql` |
| Funds / policy / holdings / allocation | `apps/api/src/fund-routes.ts`, `funds.ts`, `crew.ts` |
| Orders / previews / cancellation | `apps/api/src/order-routes.ts`, `orders.ts` |
| Trade history / statistics / Crew timeline | `apps/api/src/history.ts` |
| Performance / NAV history / rankings | `apps/api/src/performance.ts`, `packages/domain/src/performance.ts` |
| Events / SSE | `apps/api/src/events.ts` |
| Messages / decision log | `apps/api/src/social.ts` |
| Inbox | `apps/api/src/notifications.ts`, `apps/worker/src/notifications.ts` |
| Financial replay / cursor validation | `apps/api/src/accounting.ts`, `request.ts` |
| Fill costs and asynchronous execution | `packages/market-data/src/index.ts`, `apps/worker/src/orders.ts` |

Update this spec alongside any route/schema changes. It describes current workspace behavior; it does not establish that this version is deployed. Related docs: [Captain flow](captain-flow-v0.md), [trade history](paper-history-api.md), [fill model](v0-fill-model.md), [Privy setup](privy-auth.md).

## 13. Jupiter market snapshot and WebSocket delivery

See [the complete market streaming contract](jupiter-market-stream-v0.md#rest-snapshot) for both new endpoints, exact payloads, private authentication, replay cursors, stale values and reconnection behavior. Subscribe to `market.prices` for SOL updates and to `account.notifications` after authenticating with a Privy access-token frame. Keep financial commands on the documented REST endpoints. Fund activity/chat retain the existing SSE/REST flow.
