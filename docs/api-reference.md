# Socially Backend — HTTP & WebSocket API Reference

Generated from `apps/api/src` (Fastify) at commit-time. Every route below is registered in `app.ts` or a `register*Routes` module.

---

## 0. Conventions

### Base URL
```
http://{HOST}:{PORT}          # default HOST=127.0.0.1 (non-prod), PORT=3000
```

### Transport / headers

| Header | Direction | Notes |
|---|---|---|
| `Authorization: Bearer <token>` | request | Privy access token. Required by every route marked **AUTH**. Verified by `requireActor()` → `privyIdentity()`. |
| `Idempotency-Key` | request | Required (8–128 chars) on financial POSTs. Reuse with a different body → `409 idempotency_conflict`. |
| `Content-Type: application/json` | request | Required when a body is present. |
| `Origin` | request | Browser only. Must be in `CORS_ORIGINS` (HTTP) or `WS_ALLOWED_ORIGINS` (WS). Native clients omit it. |
| `Last-Event-ID` | request | SSE resume cursor for `/v0/funds/:fundId/events/stream`. |

### CORS
Registered globally (`cors.ts`). Allowed methods: `GET, POST, PATCH, PUT, DELETE`. Allowed headers: `Authorization, Content-Type, Idempotency-Key`. Preflight max-age 600s. Unknown browser origin → `403 origin_forbidden`.

### Response envelope
Most payloads carry a discriminator. Common discriminators:

| Field | Values | Meaning |
|---|---|---|
| `mode` | `"PAPER"` | Simulated paper ledger (funds, orders, vaults, activity). |
| `mode` | `"ONCHAIN"` | Real devnet Solana (live vaults). |
| `status` | `CURRENT` / `STALE` / `UNAVAILABLE` | Market price freshness. |
| `valuationStatus` | `CURRENT` / `UNAVAILABLE` / `FINAL` | NAV freshness. |
| `coverage` | `COMPLETE` / `PARTIAL` / `UNAVAILABLE` | Chart/return series completeness. |

### Error format
All errors return this shape (from `app.setErrorHandler`):

```json
{ "error": "<machine_code>", "message": "<human message>" }
```

| Status | Meaning | Typical codes |
|---|---|---|
| 400 | Bad input | `invalid_request`, `invalid_cursor`, `invalid_order`, `unsupported_instrument`, `idempotency_key_required`, `invalid_market_query` |
| 401 | Missing/invalid bearer | `unauthorized`, `admin_logs_unauthorized` |
| 403 | Authz / origin | `captain_required`, `crew_required`, `origin_forbidden`, `wallet_not_linked`, `captain_profile_forbidden` |
| 404 | Not found | `fund_not_found`, `vault_not_found`, `token_not_found`, `order_not_found`, `operation_not_found`, `market_discovery_disabled` |
| 409 | State conflict | `idempotency_conflict`, `conflict`, `terms_changed`, `fund_not_tradable`, `funding_closed`, `already_claimed`, `signature_conflict` |
| 410 | Gone | `asset_upload_expired` |
| 422 | Semantically invalid | `invalid_username`, `username_taken`, `insufficient_virtual_cash`, `watchlist_full`, `mint_metadata_conflict` |
| 429 | Rate limit | `vault_rate_limited`, `diagnostic_rate_limited`, `support_rate_limited`, `upload_rate_limited`, `rate_limited`, `tracking_capacity` |
| 503 | Unavailable | `internal_error`, `database_unconfigured`, `market_unavailable`, `history_busy`, `gateway_busy`, `contributions_paused` |

Postgres errors are mapped: `23505` → `409 conflict`, `22P02` → `400 invalid_identifier`.

### Amounts & decimals
- Money is a **decimal string**, never a JS number. USDC amounts have exactly 6 decimals (`"100.000000"`).
- Token quantities use the mint's decimals, up to 18 (`"1.234567890123456789"`).
- Raw SPL amounts are base-unit integers as strings (`amountRaw`).
- Cursors: UUID strings (keyset pagination) or non-negative integer sequences (event streams).

### Pagination
| Pattern | Params | Response |
|---|---|---|
| Keyset (UUID) | `after=<uuid>`, `limit=<1..100>` | `{ items, nextCursor }` — `nextCursor` is `null` on last page |
| Vault page | `after=<uuid>`, `limit=<1..50>` | `{ vaults, nextCursor }` |
| Sequence | `after=<int>` | `{ events, ... }`, ascending |

### Rate limiting
| Scope | Limit | Window | Header |
|---|---|---|---|
| Vault routes (`vault-rate-limit.ts`) | 240 req / IP | 60 s | `retry-after` on 429 |
| Vault WS | 10 conns / IP, 200 global | — | — |
| Market WS | 1000 conns global, 20 msgs / 10 s, 5 pending | — | — |
| Admin logs | none (auth-gated) | — | — |
| Auth client events | 10 reports / IP | 60 s | — |
| Support requests | 5 / user | 1 h | — |
| Image uploads | 20 / user | 1 h | — |

### Shared response types

<details>
<summary><code>VaultOperation</code> — returned by every vault mutation</summary>

```json
{
  "id": "uuid", "vaultId": "uuid",
  "kind": "CREATE | CONTRIBUTE | CANCEL | CLAIM",
  "status": "SUCCEEDED", "mode": "PAPER",
  "eventId": "uuid", "amountUsdc": "100.000000"
}
```
</details>

<details>
<summary><code>VaultSummary</code> — vault list/detail object</summary>

```json
{
  "schemaVersion": 1, "roundModelVersion": 2, "mode": "PAPER",
  "id": "uuid", "captainId": "uuid",
  "name": "string", "description": "string",
  "avatarUrl": "https://…|null", "bannerUrl": "https://…|null",
  "phase": "FUNDRAISING|ACTIVE|SETTLING|COMPLETED|REFUNDING|CANCELLED",
  "riskState": "NORMAL|FROZEN",
  "termsVersion": 1, "termsHash": "64-hex",
  "durationDays": 30, "fundingWindowHours": 24,
  "universeMode": "LEGACY_ALLOWLIST|DYNAMIC_SPOT",
  "acceptedCapitalUsdc": "1000.000000",
  "remainingCapacityUsdc": "29000.000000",
  "economicShares": "1000.000000", "participants": 3,
  "fundingClosesAt": "ISO", "tradingStartsAt": "ISO",
  "actualActivatedAt": "ISO|null", "tradingEndsAt": "ISO",
  "navUsdc": "1012.500000|null",
  "valuationStatus": "CURRENT|UNAVAILABLE", "valuedAt": "ISO|null",
  "eventSequence": "42", "serverTime": "ISO", "blockedReason": null,
  "settlement": {
    "assetsUsdc": "…", "distributionPoolUsdc": "…", "captainFeeUsdc": "…",
    "finalEconomicShares": "…", "residueLiabilityUsdc": "…|null"
  }
}
```
</details>

<details>
<summary><code>VaultPosition</code> — <code>GET /v1/vaults/:id/position</code></summary>

```json
{
  "vaultId": "uuid", "availableUsdc": "500.000000",
  "contributedUsdc": "500.000000", "shares": "494.320988",
  "claimableUsdc": "…|null", "claimPaid": false, "isCaptain": false,
  "investmentValueUsdc": "…|null", "personalPnlUsdc": "…|null",
  "captainFeeUsdc": "0.000000"
}
```
</details>

<details>
<summary><code>ExecutionProgress</code> — order execution state machine</summary>

```json
{
  "stage": "WAITING_DELAY|WAITING_PRICE|WAITING_VALUATION|READY|FILLED|PARTIALLY_FILLED|REJECTED|CANCELLED",
  "eligibleAt": "ISO", "expiresAt": "ISO",
  "lastAttemptedAt": "ISO|null", "attempts": 2,
  "observationSourceAt": "ISO|null", "observationAgeMs": 340,
  "reason": "execution_delay|fresh_observation_required|held_asset_price_required|null",
  "retryAfterMs": 1500
}
```
Orders become eligible 3 s after submission and expire at 120 s. Poll `GET …/orders/:orderId` for `execution.stage`.
</details>

<details>
<summary><code>MarketPrice</code> — stream/REST price object</summary>

```json
{
  "instrumentId": "SOL", "mint": "So1111…",
  "priceUsd": "123.45|null", "priceUsdc": "123.45|null",
  "source": "JUPITER_PRICE_V3", "sourceBlockId": "…|null",
  "sourceAt": "ISO|null", "quoteSourceBlockId": null, "quoteSourceAt": null,
  "receivedAt": "ISO", "observationId": "uuid|null",
  "status": "CURRENT|STALE|UNAVAILABLE", "reason": null
}
```
Freshness: `sourceAt`/`receivedAt` must be ≤ 5 s in the future and ≤ 15 s old, else `STALE` with `reason: "observation_stale"`.
</details>

---

## 1. System & Admin

### `GET /health`
Public. Liveness probe.

**Response `200`**
```json
{ "status": "ok", "mode": "PAPER" }
```

### `OPTIONS /*`
CORS preflight. Returns `204`. See [Conventions](#0-conventions).

### `GET /admin/logs` — ADMIN
HTML log viewer. Served unless `ADMIN_LOGS_ENABLED=false`. Sets CSP, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`.

**Response `200`** → `text/html`

### `GET /admin/logs/data` — ADMIN
Structured log query.

**Authorization** — `onRequest` hook calls `authorize()`:
1. If `ADMIN_LOGS_TOKEN` is set → `Authorization: Bearer <token>`, compared with `timingSafeEqual` over SHA-256 digests.
2. Else only if `NODE_ENV !== production` → socket remote address must be loopback (`127.0.0.1`, `::1`, `::ffff:127.0.0.1`), `Host` header must resolve to `localhost`/`127.0.0.1`/`[::1]`, and `Origin` must be absent or equal to `protocol://host`.
3. Otherwise `401 admin_logs_unauthorized`.

**Query params**

| Param | Type | Constraint | Default |
|---|---|---|---|
| `service` | enum | `api` \| `worker` \| `ingestor` | all |
| `level` | enum | `trace` \| `debug` \| `info` \| `warn` \| `error` \| `fatal` | all |
| `q` | string | maxLength 200 — case-insensitive substring over the whole JSON entry | — |
| `requestId` | string | maxLength 200 — exact match | — |
| `since` | string | maxLength 35 — ISO timestamp → `400` if unparseable | — |
| `limit` | string | `^[1-9][0-9]{0,3}$`, max 2000 | `250` |

**Response `200`**
```json
{
  "entries": [{ "id":"…", "service":"api", "level":"info",
                "message":"…", "time":"ISO", "instance":"…",
                "requestId":"…|null", "context":{} }],
  "total": 128, "retained": 5000,
  "transport": "redis|local|unavailable",
  "retention": { "maxEntries": 5000, "hours": 24 },
  "services": [{ "name":"api", "count":40, "lastSeen":"ISO" }],
  "errors": 2, "warnings": 9
}
```

### `GET /admin/paper-trading/health` — ADMIN
Same `authorize()` gate. Operational health for the paper engine plus this process's latency metrics.

**Response `200`**
```json
{
  "mode": "PAPER", "asOf": "ISO",
  "orders": [{ "status":"PENDING", "progress_state":"WAITING_PRICE",
               "count":3, "max_attempts":2,
               "oldest_pending_ms":4200, "completion_p95_ms":8100 }],
  "valuation": { "queued":0, "leased":0, "oldest_due_ms":0 },
  "reconciliation": [{ "status":"UNCHECKED", "funds":5, "oldest_check_at":null }],
  "settlement": [{ "phase":"SETTLING", "blocked_reason":null,
                   "count":1, "oldest_attempt_at":"ISO" }],
  "capacity": { "tracked_assets":12, "asset_limit":100 },
  "history": [{ "status":"COMPLETE", "count":12, "oldest_due_at":"ISO" }],
  "orderSampleLimit": 10000, "orderWindowHours": 24,
  "requestMetrics": {
    "scope": "THIS_API_PROCESS",
    "boundsMs": [25,50,100,250,500,1000,2500,5000],
    "series": { "GET /v1/vaults/:id/trading-context 2xx":
                { "count":40, "totalMs":3100, "buckets":[12,20,8,0,0,0,0,0] } }
  }
}
```
`capacity` and `history` are omitted on the captain-scoped variant.

---

## 2. Authentication & Account

### `POST /v0/auth/privy` — AUTH
Verifies the bearer token, bootstrapping the user row on first call (with a `10000.000000` USDC paper grant and matching ledger entries when the devnet token layer is **off**; grants `0` when `USDG_MINT` is set).

Body is optional — a request with no body validates as `{}`. When the token layer is enabled, `walletAddress` is accepted and bound/verified against Privy's linked wallets.

**Body** (all optional, `additionalProperties: false`)
```jsonc
{
  "walletAddress": "string"   // maxLength 44, base58 Solana address
}
```
> When the token layer is **off**, the body schema has **no** properties at all — sending `walletAddress` returns `400`.

**Response `200`**
```jsonc
{
  "mode": "PAPER", "provider": "privy",
  "privyUserId": "privy|…",
  "user": { /* AccountView — see GET /v0/me */ },
  // present only when the devnet token layer is enabled:
  "token": { "label":"Test USDC (devnet)", "mint":"…", "decimals":6, "cluster":"devnet" },
  "wallet": "9xY…|null",
  "signupGrant": { "id":"uuid","kind":"SIGNUP_GRANT","status":"PENDING|CONFIRMED",
                   "signature":null,"amount":"10000.000000","wallet":"9xY…",
                   "attempts":0,"lastError":null } | null
}
```

### `POST /v0/auth/client-events` — PUBLIC
Pre-login SDK telemetry. **Body is treated as unverified** — it is only logged, never trusted. No bearer token permitted or needed. `bodyLimit: 1024`.

**Body**
| Field | Type | Required | Constraint |
|---|---|---|---|
| `operation` | enum | yes | `send` \| `verify` \| `oauth` \| `logout` |
| `platform` | enum | yes | `android` \| `ios` \| `web` |
| `code` | string | yes | `^[a-zA-Z][a-zA-Z0-9_]{0,79}$` |
| `status` | integer | no | 400–599 |

**Response `204`** (no body). Exceeds 10/minute/IP → `429 diagnostic_rate_limited`.

### `GET /v0/me` — AUTH
**Response `200`**
```json
{
  "id": "uuid", "displayName": "Vikas", "username": "vikas", "role": "captain",
  "bio": "…", "avatarUrl": "https://…|null", "bannerUrl": null,
  "hideBalances": false, "avatarKind": "captain",
  "mode": "PAPER", "paperCash": { "value": "7400.000000", "asset": "USDC" }
}
```

### `POST /v0/me/onboarding` — AUTH
One-time setup. Requires `username` **and** `role` together.

**Body** (`additionalProperties: false`)
| Field | Type | Required | Constraint |
|---|---|---|---|
| `username` | string | yes | `^[a-z][a-z0-9_]{2,23}$` |
| `role` | enum | yes | `crew` \| `captain` |
| `displayName` | string | no | 1–40 chars |

**Response `200`** → same `AccountView` as `GET /v0/me`.
Errors: `400 signup_required`, `409 already_onboarded`, `409 username_taken`.

### `PATCH /v0/me` — AUTH
Partial profile edit. `minProperties: 1`. Requires an existing username (`409 signup_required`).

**Body** (any subset, `additionalProperties: false`)
| Field | Type | Constraint |
|---|---|---|
| `username` | string | `^[a-z][a-z0-9_]{2,23}$` |
| `role` | enum | `crew` \| `captain` |
| `displayName` | string | 1–40 |
| `bio` | string | ≤500 |
| `avatarUrl` | string\|null | 1–2048 chars; must be a **completed** upload of your own (`400 asset_not_verified`) |
| `bannerUrl` | string\|null | same |
| `hideBalances` | boolean | — |
| `avatarKind` | enum | `captain` \| `initials` |

**Response `200`** → `AccountView`.

### `GET /v0/me/paper-balance` — AUTH
```json
{ "mode":"PAPER", "available": { "value":"7400.000000", "asset":"USDC" } }
```

### `GET /v0/me/paper-positions` — AUTH
Legacy (round-model v1) holdings only.

```json
{
  "mode": "PAPER",
  "positions": [{
    "fundId":"uuid","name":"Alpha","shares":"500.000000",
    "estimatedValueUsdc":"512.340000|null",
    "valuationStatus":"CURRENT|UNAVAILABLE","pricedAt":"ISO|null"
  }]
}
```

### `GET /v0/users/username-availability` — PUBLIC
**Query** `username` (required, `^[a-z][a-z0-9_]{2,23}$`)
```json
{ "mode":"PAPER", "username":"vikas", "available": true }
```
Backed by a Redis Bloom filter; the filter is only trusted when its generation matches PostgreSQL (`username_index_state`). Unavailable filter ⇒ falls back to a database check, never a false "available".

### `GET /v0/captains/handle-availability` — PUBLIC
Compatibility alias; **same global namespace** as usernames.
**Query** `handle` (required, `^[a-z0-9_]{3,24}$`) → `{ "mode":"PAPER","handle":"vikas","available":true }`

### `POST /v0/captains` — AUTH
Create/claim the captain profile for the authenticated account. **201** on create, **200** when renaming an existing handle.

**Body**
| Field | Type | Required | Constraint |
|---|---|---|---|
| `handle` | string | yes | `^[a-z0-9_]{3,24}$` |
| `bio` | string | no | ≤500 |

**Response `200`/`201`**
```json
{ "userId":"uuid","handle":"vikas","bio":"…",
  "avatarUrl":null,"bannerUrl":null }
```
`409 captain_profile_exists` if the account already has a different username.

### `GET /v0/captains/:captainId` — PUBLIC
**URL params** `captainId` (uuid)

**Response `200`** → `CaptainProfile` (same shape as above). **404 `captain_not_found`**.

### `PATCH /v0/captains/:captainId` — AUTH
Owner-only (`403 captain_profile_forbidden` on mismatch).

**URL params** `captainId` (uuid)
**Body** (≥1 property; only media fields allowed)
| Field | Type | Constraint |
|---|---|---|
| `bio` | string | ≤500 |
| `avatarUrl` | string\|null | 1–2048, completed own upload |
| `bannerUrl` | string\|null | 1–2048, completed own upload |

**Response `200`** → `CaptainProfile`.

### `POST /v0/me/support-requests` — AUTH
**Body**
| Field | Type | Required | Constraint |
|---|---|---|---|
| `message` | string | yes | 10–2000 chars (trimmed; `<10` after trim → `400 invalid_support_message`) |
| `appVersion` | string | yes | 1–40 |
| `platform` | enum | yes | `android` \| `ios` \| `web` |

**Response `201`** `{ "id":"uuid", "status":"OPEN" }`
5/hour/user → `429 support_rate_limited`.

---

## 3. Image Uploads (3-step: reserve → PUT to S3 → complete)

Shared body shape:
| Field | Type | Required | Constraint |
|---|---|---|---|
| `kind` | enum | yes | `avatar` \| `banner` |
| `contentType` | enum | yes | `image/jpeg` \| `image/png` \| `image/webp` |
| `byteSize` | integer | yes | 1 … 5 242 880 (5 MiB) |

Reserve response (both families):
```json
{
  "uploadId": "uuid", "kind": "avatar", "method": "PUT",
  "uploadUrl": "https://s3…signed…",
  "headers": { "Content-Type": "image/png" },
  "byteSize": 123456,
  "uploadUrlExpiresAt": "ISO (+5 min)",
  "completeBefore": "ISO (row expiry)"
}
```

### `POST /v0/me/assets/uploads` — AUTH → **201**
### `POST /v0/captains/:captainId/assets/uploads` — AUTH → **201**
**URL params** `captainId` (uuid, captain-scoped variant only; must equal `actor.id`)
Requires `username IS NOT NULL` else `404 captain_not_found`. 20/hour → `429 upload_rate_limited`.

### `POST /v0/me/assets/uploads/:uploadId/complete` — AUTH
### `POST /v0/captains/:captainId/assets/uploads/:uploadId/complete` — AUTH
**URL params** `captainId` (uuid, scoped), `uploadId` (uuid)

Completes the upload: S3 read → byte validation → Sharp normalization → publish. On the captain-scoped path the user's `avatar_url`/`banner_url` are updated in the same transaction.

**Response `200`**
```json
{
  "profile": { /* AccountView (me) or CaptainProfile (captain) */ },
  "asset": { "id":"uuid", "kind":"avatar", "url":"https://cdn…" }
}
```
Errors: `404 asset_upload_not_found`, `410 asset_upload_expired`, `409 asset_processing`.

### `POST /v1/vaults/:id/assets/uploads` — AUTH → **201**
**URL params** `id` (uuid) — vault must be **owned** by the actor (`404 vault_not_found`). 20/hour.

### `POST /v1/vaults/:id/assets/uploads/:uploadId/complete` — AUTH
**URL params** `id` (uuid), `uploadId` (uuid)

Completes the vault image and appends a `vault_art_updated` fund event. Uses a 2-minute lease; concurrent completion → `409 image_processing`, lease loss → `409 upload_lease_changed`.

**Response `200`**
```json
{ "asset": { "id":"uuid", "kind":"banner", "url":"https://cdn…" } }
```

---

## 4. Paper Funds (legacy round-model v1)

### `GET /v0/funds` — PUBLIC
```json
{
  "mode":"PAPER",
  "funds": [{
    "id":"uuid","mode":"PAPER","status":"ACTIVE|FROZEN|COMPLETED",
    "name":"Alpha","captainId":"uuid",
    "nav":{ "value":"1012.500000","asset":"USDC" },
    "sharePrice":{ "value":"1.012500","asset":"USDC" },
    "valuationStatus":"CURRENT|UNAVAILABLE",
    "trialEndsAt":"ISO"
  }]
}
```
Latest 30 funds by `created_at DESC`.

### `GET /v0/funds/:fundId` — PUBLIC
**URL params** `fundId` (uuid) → single `FundSummary` (no envelope). `404 fund_not_found`.

### `POST /v0/funds` — AUTH → **201**
**Headers** `Idempotency-Key` (required)
**Body**
| Field | Type | Required | Constraint |
|---|---|---|---|
| `name` | string | yes | 3–80 (trimmed; `<3` → `400 invalid_name`) |
| `description` | string | no | ≤1000, defaults `""` |

**Response `201`** → `FundSummary`. Seeds `1000.000000` USDC, 30-day trial, policy v1 (`max_order_bps` 1000, `max_position_bps` 2500, `drawdown_breaker_bps` 3000).
Errors: `403 captain_required`, `409 active_trial_exists`, `422 insufficient_virtual_cash`.

### `GET /v0/funds/:fundId/policy` — PUBLIC
```json
{
  "mode":"PAPER",
  "policy": { "version":1, "max_order_bps":1000, "max_position_bps":2500,
              "drawdown_breaker_bps":3000,
              "allowed_instruments":["SOL","USDC","…"],
              "effective_at":"ISO" }
}
```

### `GET /v0/funds/:fundId/holdings` — PUBLIC
```json
{
  "mode":"PAPER", "cashUsdc":"120.000000",
  "positions": [{ "instrument_id":"SOL","symbol":"SOL",
                  "quantity":"0.51230000","cost_basis_usdc":"98.000000" }]
}
```
Only `quantity > 0`, ordered by symbol.

### `POST /v0/funds/:fundId/joins` — AUTH → **201**
**Headers** `Idempotency-Key` (required)
**Body** `{ "amountUsdc": "decimal string, ≤6 dp, ≥1 USDC" }`

**Response `201`**
```json
{ "mode":"PAPER","fundId":"uuid","eventId":"uuid",
  "shares":"494.320988","virtualUsdc":"500.000000","sharePrice":"1.011500" }
```
Errors: `409 fund_not_active`, `403 captain_seed_fixed`, `422 insufficient_virtual_cash` / `shares_too_small`.

### `POST /v0/funds/:fundId/exits` — AUTH
**Headers** `Idempotency-Key` (required)
**Body** `{ "shares": "decimal string, ≤18 dp, > 0" }`

**Response `200`** → same `CrewChange` shape as joins (`virtualUsdc` is the payout). Exits liquidate pro-rata positions at a 0.2 % exit spread.
Errors: `403 captain_stake_locked`, `422 insufficient_shares` / `exit_too_small`, `409 fund_seed_required`.

### Orders — see [§5 Paper Orders](#5-paper-orders-legacy-fund-orders)

---

## 5. Paper Orders (legacy fund orders)

Shared body (`oneOf` enforces notional-vs-quantity exclusivity):

| Field | Type | Required | Constraint |
|---|---|---|---|
| `side` | enum | yes | `BUY` \| `SELL` |
| `instrumentId` | string | yes | 1–64 chars |
| `notionalUsdc` | string | conditional | ≤40 chars, **exactly one** of this/`quantity` |
| `quantity` | string | conditional | ≤40 chars; `SELL` only; mutually exclusive with `notionalUsdc` |

Fill model (v1): 20 bps spread + impact of `min(50, ceil(notional/1000))` bps + 10 bps fee, capped at 1000 USDC notional.

### `POST /v0/funds/:fundId/orders/preview` — AUTH
**URL params** `fundId` (uuid). No idempotency key (read-only simulation, but opens a transaction).

**Response `200`**
```json
{
  "mode":"PAPER",
  "estimate": { "modelVersion":1, "quantity":"…", "marketPriceUsdc":"…",
                "fillPriceUsdc":"…", "feeUsdc":"0.500000","cashChangeUsdc":"-499.500000" },
  "policy": { "allowed": true, "reason": null },
  "observationId": "uuid", "observedAt": "ISO"
}
```
Requires a price observation fresher than `MAX_PRICE_AGE_MS`, else `503 price_unavailable`.

### `POST /v0/funds/:fundId/orders` — AUTH → **202**
**Headers** `Idempotency-Key` (required)
**Response `202`** `{ "mode":"PAPER","orderId":"uuid","status":"PENDING" }`

Errors: `403 captain_required`, `409 fund_not_tradable`, `400 order_size_out_of_range`, `503 market_capacity` (global 100 tracked-asset limit reached for a new BUY).

### `GET /v0/funds/:fundId/orders` — PUBLIC
**Query** `after` (uuid), `limit` (`^[1-9]$|^[1-9][0-9]$|^100$`, default 100)
Cursor must belong to the same fund else `400 invalid_cursor`.

**Response `200`**
```json
{
  "mode":"PAPER",
  "orders": [{
    "id":"uuid","fund_id":"uuid","side":"BUY","instrument_id":"SOL",
    "notional_usdc":"500.000000","status":"FILLED","reject_reason":null,
    "submitted_at":"ISO","processed_at":"ISO",
    "quantity":"3.10000000","market_price_usdc":"161.29","fill_price_usdc":"161.32",
    "fee_usdc":"0.500000","model_version":1,"observation_id":"uuid"
  }],
  "nextCursor": "uuid|null"
}
```

### `GET /v0/funds/:fundId/orders/:orderId` — PUBLIC
**Response `200`** `{ "mode":"PAPER", "order": { /* order row + */ "execution": { …ExecutionProgress } } }`
`404 order_not_found`.

### `POST /v0/funds/:fundId/orders/:orderId/cancel` — AUTH
**Response `200`** `{ "mode":"PAPER","orderId":"uuid","status":"CANCELLED" }`
Idempotent when already cancelled. `409 order_already_processed` for non-pending. `403 captain_required`.

---

## 6. Social & Crew

### `GET /v0/funds/:fundId/messages` — PUBLIC
**Query** `after` (non-negative integer, default `0`)
**Response `200`**
```json
{
  "mode":"PAPER",
  "messages": [{ "id":"uuid","kind":"CHAT|TRADE_NOTE","body":"…",
                 "authorId":"uuid","linkedOrderId":"uuid|null",
                 "correctsMessageId":"uuid|null",
                 "sequence":"12","createdAt":"ISO" }]
}
```
Ascending by event sequence, limit 100, `moderation_status = 'VISIBLE'` only.

### `GET /v0/funds/:fundId/decisions` — PUBLIC
Same as messages but filtered to `kind = "TRADE_NOTE"`. Response key is `notes`.

### `POST /v0/funds/:fundId/messages` — AUTH → **201**
**Headers** `Idempotency-Key` (required)
**Body** `{ "body": "1–2000 chars" }` (trimmed; empty after trim → `400 invalid_message`)
Requires captain **or** a positive `fund_shares` balance, else `403 crew_required`.
**Response `201`** `{ "mode":"PAPER", "message": { …Message } }`

### `POST /v0/funds/:fundId/orders/:orderId/notes` — AUTH → **201**
**URL params** `fundId`, `orderId` (uuid)
**Body**
| Field | Type | Required | Constraint |
|---|---|---|---|
| `body` | string | yes | 1–2000 |
| `correctsMessageId` | uuid | no | must be the actor's own note on the same order |

Captain-only (`403 captain_required`); `404 order_not_found`; `404 note_not_found`.
**Response `201`** → `{ "mode":"PAPER", "message": { …Message } }`

### `GET /v0/funds/:fundId/events` — PUBLIC
**Query** `after` (non-negative integer, default `0`)
**Response `200`**
```json
{ "mode":"PAPER",
  "events": [{ "id":"uuid","sequence":"7","type":"order_filled",
               "payload":{},"recorded_at":"ISO" }] }
```
Ascending, limit 100. `type` includes `fund_started`, `crew_joined`, `crew_left`, `chat_message_posted`, `trade_note_posted`, `order_submitted`, `order_cancelled`, `trial_completed`.

### `GET /v0/funds/:fundId/events/stream` — PUBLIC (SSE)
Server-Sent Events fallback for clients that cannot hold a WebSocket. Hijacks the raw response.

**Headers**: `text/event-stream; charset=utf-8`, `cache-control: no-cache, no-transform`, `connection: keep-alive`, `x-accel-buffering: no`.
**Resume**: `Last-Event-ID` header or `?after=` query (header wins; both parsed via `sequenceCursor`).

**Frames**
```
: connected to PAPER fund <fundId>

id: 12
event: fund-event
data: {"mode":"PAPER","id":"…","sequence":"12","type":"…","payload":{},"recorded_at":"ISO"}

: heartbeat
```
Polls every 2 s; immediately re-polls (0 ms) when a full 100-event page was returned. `: heartbeat` comment frames are emitted when a poll returns nothing. Socket close → the response ends.

### `GET /v0/me/crew-transactions` — AUTH
**Query** `after` (uuid), `limit` (≤100)
**Response `200`** `{ "mode":"PAPER","transactions":[…],"nextCursor":"uuid|null" }`
Cursor must belong to your own history else `400 invalid_cursor`.

### `GET /v1/me/paper-activity` — AUTH
Unified captain timeline: orders **and** vault operations, keyed by `(created_at, id)` so the timestamp stays in PostgreSQL precision.

**Query** `after` (uuid), `limit` (≤100, default **20**)
**Response `200`**
```json
{
  "mode":"PAPER",
  "items": [{ "id":"uuid","fund_id":"uuid","vault_name":"…",
              "kind":"BUY|SELL|CREATE|CONTRIBUTE|CANCEL|CLAIM",
              "status":"PENDING|FILLED|SUCCEEDED|…","reason":null,
              "instrument_id":"SOL|null","symbol":"SOL|null",
              "amount_usdc":"500.000000","at":"ISO",
              "quantity":"…|null","fee_usdc":"…|null","fill_price_usdc":"…|null" }],
  "nextCursor": "uuid|null"
}
```

### `GET /v0/me/notifications` — AUTH
**Query** `after` (non-negative integer, default `0`)
**Response `200`**
```json
{ "mode":"PAPER",
  "notifications": [{ "id":"42","fundId":"uuid|null","type":"…",
                      "payload":{},"createdAt":"ISO","readAt":"ISO|null" }] }
```
Ascending by id, limit 100.

### `POST /v0/me/notifications/:notificationId/read` — AUTH
**URL params** `notificationId` (non-negative integer)
**Response `200`** `{ "mode":"PAPER","id":"42","readAt":"ISO" }`
Idempotent (`COALESCE(read_at, now())`). `404 notification_not_found`.

---

## 7. Performance, Rankings & Captain Records

### `GET /v0/funds/:fundId/performance` — PUBLIC
Runs in a `REPEATABLE READ READ ONLY` transaction.

**Response `200`**
```json
{
  "mode":"PAPER","fundId":"uuid","fundName":"Alpha","captainId":"uuid","status":"ACTIVE",
  "totalShares":"1000.000000","valuationStatus":"CURRENT|UNAVAILABLE|FINAL",
  "current": {
    "sequence":"42","recordedAt":"ISO","pricedAt":"ISO",
    "navUsdc":"1012.500000","sharePriceUsdc":"1.012500","performanceFeeFactor":"1.000000",
    "sinceInception": { "netReturnPercent":"1.250000","grossReturnPercent":"1.500000", "…":"…" }
  },
  "latestHistorical": { /* same shape */ },
  "methodology": { "version":1,"netReturn":"…","grossReturn":"…",
                   "drawdown":"…","periods":"…","chartGaps":"…","unavailable":"…" },
  "trial": { "startsAt":"ISO","endsAt":"ISO","elapsedDays":12.4,
             "remainingDays":17.6,"settlementPending":false },
  "orders": { "pending":0,"filled":8,"partially_filled":0,
              "rejected":1,"cancelled":2 },
  "fees": { "simulated":true,"modelVersion":1,
            "performanceFeePercent":"10","captainShareOfFeePercent":"80",
            "protocolShareOfFeePercent":"20","assessmentPolicy":"…",
            "performanceFeeUsdc":"0.000000","captainFeeShares":"0.000000",
            "protocolFeeShares":"0.000000","assessmentCount":0,
            "lastAssessmentAt":null,"tradingFeeUsdc":"4.000000",
            "filledNotionalUsdc":"4000.000000" }
}
```

### `GET /v0/funds/:fundId/history` — PUBLIC
NAV snapshot series.
**Query** `after` (`^(0|[1-9][0-9]{0,18})$`, default `0`), `limit` (1–100, default 100)
Cursor > `2^63-1` → `400 invalid_cursor`.

**Response `200`**
```json
{
  "mode":"PAPER","fundId":"uuid",
  "points": [{
    "sequence":"42","recordedAt":"ISO","pricedAt":"ISO",
    "valuationStatus":"CURRENT","navUsdc":"1012.500000",
    "sharePriceUsdc":"1.012500","performanceFeeFactor":"1.000000",
    "grossSharePriceUsdc":"1.012500000000000000"
  }],
  "nextCursor": "42|null"
}
```
`navUsdc`/`sharePriceUsdc` are `null` when `valuationStatus !== "CURRENT"`.

### `GET /v0/me/funds/:fundId/performance` — AUTH
Personal P&L for one fund. `{ …personalPerformance }` adds `contributionsUsdc`, `withdrawalsUsdc`, `currentValueUsdc`, `netPnlUsdc`, `returnPercent`, plus `historicalPositionValueUsdc` and `historicalPricedAt`.

### `GET /v0/me/paper-record` — AUTH
All funds the caller holds shares in, newest first.
```json
{ "mode":"PAPER",
  "records": [{ "fund": { /* full performance object */ },
                "personal": { /* personal performance object */ } }] }
```

### `GET /v0/captains/:captainId/paper-record` — PUBLIC
Captain's funds (performance only).
```json
{ "mode":"PAPER","captainId":"uuid","records":[{ /* performance */ }],
  "disclaimer":"Simulated results include recorded fees and costs. …" }
```

### `GET /v0/funds/rankings` — PUBLIC
Universe: most recent 100 funds with `elapsedDays ≥ 7` and a current/final valuation. Sorted by `sinceInception.netReturnPercent` desc.
```json
{ "mode":"PAPER","rankingMethod":"SINCE_INCEPTION_NET_RETURN",
  "minimumAgeDays":7,"universe":"…","disclaimer":"…",
  "funds":[{ "rank":1, /* performance object */ }] }
```

### `GET /v0/captains/:captainId/orders` — PUBLIC
Same schema/response as `GET /v0/funds/:fundId/orders` but scoped to `captain_id`. `404 captain_not_found`.

### `GET /v0/captains/:captainId/trade-statistics` — PUBLIC
```json
{
  "mode":"PAPER","captainId":"uuid",
  "statistics": {
    "user_id":"uuid","fund_count":3,"submitted_orders":42,
    "completed_trades":38,"pending":1,"filled":30,"partially_filled":8,
    "rejected":2,"cancelled":1,"completed_buys":22,"completed_sells":16,
    "executed_value_usdc":"41230.550000","trading_fee_usdc":"41.230550",
    "first_trade_at":"ISO|null","last_trade_at":"ISO|null"
  },
  "methodology":"…"
}
```

---

## 8. Vaults — Round Model v2 (`/v1`)

Terms (`VAULT_RULES`): seed `100.000000`, min capital `1000.000000`, max `30000.000000`, min crew deposit `50.000000`, funding windows `[12,24,72]` h, durations `[3,7,14,21,28,30,60,90,180,365]` d, performance fee 1000 bps on total net round profit at final settlement.

### `GET /v1/vault-config` — PUBLIC
```json
{
  "schemaVersion":1,"mode":"PAPER",
  "roundModelVersion":2,"termsVersion":1,
  "captainSeedUsdc":"100.000000","minimumCapitalUsdc":"1000.000000",
  "maximumCapitalUsdc":"30000.000000","minimumCrewDepositUsdc":"50.000000",
  "fundingWindowHours":[12,24,72],
  "durationDays":[3,7,14,21,28,30,60,90,180,365],
  "performanceFeeBps":1000,"feeBasis":"TOTAL_NET_ROUND_PROFIT",
  "feeTiming":"FINAL_SETTLEMENT","exitPolicy":"LOCKED_UNTIL_SETTLEMENT",
  "enabled":true,"liveEnabled":false,"walletSnapshotEnabled":false,
  "residuePolicy":"RETAIN_AS_LIABILITY","emergencyUnwindEnabled":false,
  "serverTime":"ISO"
}
```
`enabled` is the conjunction: `VAULT_PAPER_ENABLED === 'true'` **and** `VAULT_TERMS_APPROVAL === 'locked-v1-retain-residue'` **and** (no `USDG_MINT` **or** wallet-snapshot mode). Server-owned — never a client body field.

### `POST /v1/vaults/preview` — AUTH
Dry-run a vault creation.
**Body** → same as `POST /v1/vaults`.
**Response `200`**
```json
{
  /* …VaultConfig… */,
  "input": { "name":"…","description":"…",
             "fundingWindowHours":24,"durationDays":30,"termsVersion":1 },
  "availableUsdc":"7400.000000",
  "captainEligible": true,
  "seedUsdc":"100.000000",
  "networkCostUsdc":"0.000000"
}
```

### `POST /v1/vaults` — AUTH → **201**
**Headers** `Idempotency-Key` (required)

**Body**
| Field | Type | Required | Constraint |
|---|---|---|---|
| `name` | string | yes | 3–80 (trimmed) |
| `description` | string | yes | ≤1000 |
| `fundingWindowHours` | integer | yes | `12` \| `24` \| `72` |
| `durationDays` | integer | yes | 3,7,14,21,28,30,60,90,180,365 |
| `termsVersion` | const | yes | `1` |

**Response `201`** → `VaultOperation` (seed contribution is automatic).
Errors: `503 vault_creation_disabled`, `403 captain_required`, `409 active_round_exists`, `422 insufficient_virtual_cash`, `409 vault_request_rejected`.

### `GET /v1/vaults` — PUBLIC
**Query** `after` (uuid), `limit` (1–50, default 20), `phase` (VaultPhase), `durationGroup` (`short` = <30 d, `long` = ≥30 d)
```json
{ "vaults": [ /* VaultSummary */ ], "nextCursor": "uuid|null" }
```

### `GET /v1/me/vaults` — AUTH
Same query/response, filtered to vaults where the actor is captain **or** has an accepted contribution.

### `GET /v1/me/captain/vaults` — AUTH
Same query/response, captain-owned only.

### `GET /v1/vaults/:id` — PUBLIC → `VaultSummary`. `404 vault_not_found`.

### `GET /v1/vaults/:id/position` — AUTH → `VaultPosition`. `404 vault_not_found`.

### `POST /v1/vaults/:id/contribution-quotes` — AUTH
Non-binding pre-check.
**Body**
| Field | Type | Required | Constraint |
|---|---|---|---|
| `amountUsdc` | string | yes | `^(0\|[1-9][0-9]{0,23})(\.[0-9]{1,6})?$` |
| `termsHash` | string | yes | 64 lowercase hex — compared against the vault's current hash |

**Response `200`**
```json
{ "vaultId":"uuid","amountUsdc":"500.000000","shares":"500.000000",
  "termsHash":"…","allowed":true,"reason":null,
  "remainingCapacityUsdc":"29000.000000","reserved":false,"serverTime":"ISO" }
```
`reason`: `null` \| `terms_changed` \| `phase_*` \| `amount_too_small` \| `capacity_exceeded` \| `funding_closed`.

### `POST /v1/vaults/:id/contributions` — AUTH → **201**
**Headers** `Idempotency-Key` (required). Same body as the quote.
**Response `201`** → `VaultOperation` with `kind: "CONTRIBUTE"`.
`VAULT_CONTRIBUTIONS_PAUSED=true` → `503 contributions_paused` (cancellations and claims keep working).

### `POST /v1/vaults/:id/contribution-cancellations` — AUTH
**Headers** `Idempotency-Key` (required). **Body**: `{}` (empty object, `maxProperties: 0`).
**Response `200`** → `VaultOperation` `kind: "CANCEL"`.
Crew cancellation during `FUNDRAISING` before the close deadline; captain cancellation moves the round to `REFUNDING` but is blocked once any crew commitment exists (`409 captain_stake_locked`).

### `POST /v1/vaults/:id/claims` — AUTH
**Headers** `Idempotency-Key` (required). **Body**: `{}`.
**Response `200`** → `VaultOperation` `kind: "CLAIM"`; `amountUsdc` = investment + captain fee. Requires finalized settlement (`409 claim_unavailable`); `409 already_claimed`, `409 no_entitlement`.

### `GET /v1/vaults/:id/performance` — PUBLIC
**Query** `range`: `7D` \| `30D` \| `ALL` (default `30D`)
```json
{
  "mode":"PAPER","vaultId":"uuid","range":"30D","intervalSeconds":86400,
  "points": [{ "at":"ISO","navUsdc":"1012.500000",
               "sharePriceUsdc":"1.012500","netReturnPercent":"1.250000" }],
  "coverage":"PARTIAL|UNAVAILABLE",
  "valuationStatus":"CURRENT|UNAVAILABLE",
  "captainFeeUsdc":"0.000000",
  "methodology":"…"
}
```
Return excludes contributions; the final point is net of the round performance fee. Max 401 points.

### `GET /v1/vaults/:id/activity` — PUBLIC
**Query** `after` (`^(0|[1-9][0-9]{0,17})$`, default `0`)
```json
{ "events": [{ "id":"uuid","sequence":"12","type":"vault_created","recordedAt":"ISO" }],
  "nextCursor": "12|null" }
```
**Payloads are deliberately never selected** — historical payloads contain private membership/payout data. Types: `vault_created`, `vault_active`, `vault_settling`, `vault_refunding`, `vault_finalized`, `order_filled`.

### `GET /v1/operations/:id` — AUTH → `VaultOperation`. `404 operation_not_found`.
### `GET /v1/me/operations` — AUTH
**Query** `clientRequestId` (required, 8–128 chars) — idempotency-key lookup. Returns the recorded `VaultOperation`, or replays the original rejection.

### `POST /v1/vaults/:id/orders/preview` — AUTH
`POST /v1/vaults/:id/orders` — AUTH → **202**
Both take the shared [order body](#shared-order-body) below and mirror the legacy fund-order semantics.

**Shared order body** (`additionalProperties: false`)
| Field | Type | Required | Constraint |
|---|---|---|---|
| `side` | enum | yes | `BUY` \| `SELL` |
| `instrumentId` | string | yes | 1–64 |
| `notionalUsdc` | string | oneOf | ≤40 chars |
| `quantity` | string | oneOf | ≤40 chars, `SELL` only |

Preview `200` → `{ "mode":"PAPER", "estimate":{…}, "policy":{…}, "observationId":"…", "observedAt":"ISO" }`
Submit `202` → `{ "mode":"PAPER", "orderId":"uuid", "status":"PENDING" }`

`GET /v1/vaults/:id/orders/:orderId` — AUTH → `{ "mode":"PAPER","order":{ …order + execution } }`
`POST /v1/vaults/:id/orders/:orderId/cancel` — AUTH → `{ "mode":"PAPER","orderId":"…","status":"CANCELLED" }`

### `POST /v1/vaults/:id/test-activation` — AUTH
Development-only. Active only when `NODE_ENV === 'development'` **and** `PAPER_TEST_SKIP_FUNDRAISING === 'true'`; otherwise `404 test_activation_disabled`. Captain-owned vault in `FUNDRAISING`/`ACTIVE` with a positive seed.

**Response `200`** `{ "mode":"PAPER","vaultId":"uuid","phase":"ACTIVE","testOnly":true }`

---

## 9. Captain Dashboard (`/v1/me/captain/*`)

All require `role === "captain"` on the actor (`403 captain_required`).

### `GET /v1/me/captain/dashboard`
```json
{
  "schemaVersion":1,"mode":"PAPER",
  "state":"NEW|EXISTING",
  "vaultCount":3,"activeVaults":1,"openVaults":2,"crewMembers":8,
  "aumUsdc":"12400.000000|null",
  "valuationStatus":"CURRENT|UNAVAILABLE",
  "earnings": { "earnedUsdc":"120.000000","claimedUsdc":"80.000000",
                "claimableUsdc":"40.000000" },
  "creation": { "allowed":true, "reason":null,
                "seedUsdc":"100.000000","availableUsdc":"7400.000000" },
  "dashboardRevision":"17",
  "serverTime":"ISO"
}
```
`creation.reason`: `funding_unavailable` \| `open_round_exists` \| `insufficient_seed` \| `null`.

### `GET /v1/me/captain/crew`
**Query** `after` (uuid), `limit` (1–50, default 20)
```json
{ "mode":"PAPER",
  "members": [{ "id":"uuid","displayName":"…","username":"…","avatarUrl":null,
                "vaultCount":2,"allocatedUsdc":"150.000000","joinedAt":"ISO" }],
  "nextCursor": "uuid|null" }
```

### `GET /v1/me/captain/earnings`
**Query** `after` (uuid), `limit` (1–50, default 20). Finalized vaults only.
```json
{ "mode":"PAPER",
  "earnings": [{ "vaultId":"uuid","name":"…","earnedUsdc":"12.000000",
                 "claimedUsdc":"0.000000","claimableUsdc":"12.000000",
                 "finalizedAt":"ISO","claimedAt":null }],
  "nextCursor": "uuid|null" }
```

### `GET /v1/me/captain/performance`
**Query** `range`: `7D` \| `30D` \| `90D` \| `ALL` (default `30D`)
```json
{
  "mode":"PAPER","range":"30D","intervalSeconds":86400,
  "points": [{ "at":"ISO","aumUsdc":"12400.000000|null" }],
  "coverage":"PARTIAL|UNAVAILABLE",
  "tradingReturn": { /* TradingReturns — see /v1/me/captain/returns */ },
  "changeUsdc":"240.000000|null","changePercent":"1.969000|null",
  "methodology":"…"
}
```
Buckets hold the **last recorded** value per vault; missing marks stay `null`. No interpolation. `ALL` steps the bucket size up so the series never exceeds 400 points. **AUM change is not investment return.**

### `GET /v1/me/captain/returns`
**Query** `range`: `7D` \| `30D` \| `90D` \| `ALL` (default `30D`)
```json
{
  "mode":"PAPER","range":"30D",
  "method":"CHAINED_ECONOMIC_UNIT_PRICE",
  "intervalSeconds":86400,"baselineAt":"ISO|null","asOf":"ISO|null",
  "coverage":"PARTIAL|UNAVAILABLE",
  "netReturnPercent":"12.500000|null",
  "points": [{ "at":"ISO","indexValue":"112.500000|null","hasGap":false }],
  "methodology":"…"
}
```
`netReturnPercent` is `null` when the baseline is missing/zero or **any** point has a gap.

### `GET /v1/me/captain/paper-health` — AUTH + captain
Personal operational health (no `requestMetrics`, no global `capacity`/`history`).

---

## 10. Trading Context

### `GET /v0/me/captain/funds` — AUTH
```json
{ "mode":"PAPER",
  "funds": [{ "id":"uuid","name":"Alpha","status":"ACTIVE","trialEnd":"ISO" }] }
```
Max 100, newest first. Legacy funds (`/v0/funds/:id/trading-context`).

### `GET /v0/funds/:fundId/trading-context` — AUTH
### `GET /v1/vaults/:fundId/trading-context` — AUTH
Identical shape; the `/v0` variant reads round-model v1, the `/v1` variant round-model v2. **URL params** `fundId` (uuid). **Query** `instrumentId` (optional, ≤64 chars).

Cached ≤1 s and invalidated by any dependency change (fund revision, policy, instrument price/registry).

**Response `200`**
```json
{
  "mode":"PAPER",
  "fund": { "id":"uuid","name":"Alpha","status":"ACTIVE",
            "trialEnd":"ISO", "phase":"ACTIVE" },
  "cashUsdc":"120.000000",
  "navUsdc":"1012.500000|null",
  "holdings": [{ "instrumentId":"SOL","mint":"So1111…","symbol":"SOL",
                 "quantity":"0.51230000","costBasisUsdc":"98.000000",
                 "valueUsdc":"82.540000|null" }],
  "policy": { "maxOrderBps":1000,"maxPositionBps":2500,
              "allowedInstruments":["SOL","USDC","…"],
              "universeMode":"DYNAMIC_SPOT","version":1 },
  "testActivationAllowed": false,
  "accountingRevision": "42",
  "limits": [{
    "instrumentId":"SOL","canBuy":true,"canSell":false,
    "reason":null,
    "maxBuyNotionalUsdc":"100.000000",
    "maxSellNotionalUsdc":"0.000000",
    "maxSellQuantity":"0.00000000"
  }],
  "pending": [{ "id":"uuid","side":"BUY","instrumentId":"SOL","notionalUsdc":"100.000000" }],
  "capacityIsEstimate": true,
  "asOf": "ISO"
}
```
`reason` values: `fund_not_tradable` \| `valuation_unavailable` \| `price_unavailable` \| `asset_disabled` \| `quote_asset` \| `not_allowed` \| `unsupported_instrument` \| `buys_frozen` \| `registration_required` \| `dynamic_buys_paused`.
`maxBuyNotionalUsdc` is capped by `min(1000, nav·maxOrderBps/10000, cash, position headroom)`.

---

## 11. Markets

### `GET /v0/market/prices` — PUBLIC
**Query** `instruments` (comma-separated ids, 1–50, unique, each ≤64 chars)

**Response `200`**
```json
{
  "mode":"PAPER","transport":"redis|database",
  "cursor":"1042-0", "firstCursor":"0-0",
  "prices": [ /* MarketPrice[] */ ]
}
```
Falls back to a `market_latest` table read (`transport: "database"`, `cursor: null`) when Redis is unavailable. Omitting `instruments` returns the full registered subset. `400 unsupported_instrument` for unknown ids.

### `GET /v0/market/tokens` — PUBLIC
**Query** `query` (≤100 chars, free-text search) or `mints` (≤10 distinct, comma-separated, ≤449 chars total). Supplying both → `400 invalid_token_batch`.

```json
{
  "mode":"PAPER","asOf":"ISO",
  "tokens": [{
    "mint":"So1111…","instrumentId":"SOL","symbol":"SOL","name":"Solana",
    "decimals":9,"icon":"https://…|null","category":"major",
    "tracked":true,"tradable":true,"tradeReason":null,
    "verified":true,"suspicious":false,
    "price": { /* MarketPrice|null */ },
    "metrics": { "denomination":"USD","source":"JUPITER_TOKENS_V2","at":"ISO|null",
                 "status":"CURRENT|UNAVAILABLE",
                 "liquidity":"…|null","volume24h":"…|null",
                 "change1h":"…|null","change24h":"…|null" }
  }]
}
```
Explicit `mints` batches use **stored** registry/metadata/prices only and never spend a provider budget. `tradeReason` is forced to `quote_asset` for USDC.

### `GET /v0/market/tokens/:mint` — PUBLIC
`404 token_not_found`. Response `{ "mode":"PAPER","token":{…} }`. `400 invalid_mint` for a non-base58 address.

### `GET /v0/market/tokens/:mint/history` — PUBLIC
**Query** `range`: `5M` \| `1H` \| `6H` \| `24H` \| `7D` \| `30D` (default `24H`); `backfill`: `"true"` (only valid for `24H`).
Cache: `public, max-age=5`.

**Response `200`**
```json
{
  "mode":"PAPER","mint":"…","instrumentId":"solana:…","range":"24H",
  "denomination":"USD","source":"BIRDEYE_TOKEN_USD",
  "seriesId":"solana:<mint>:usd","intervalSeconds":300,
  "from":"ISO","to":"ISO",
  "coverage": { "start":"ISO","end":"ISO","hasGaps":false,"status":"COMPLETE|PARTIAL" },
  "coverageStart":"ISO","coverageEnd":"ISO","hasGaps":false,"status":"COMPLETE|PARTIAL",
  "changePercent":"1.250000|null",
  "points": [{ "at":"ISO","price":"123.45" }],
  "backfillStatus":"COMPLETE|PENDING|CACHED|CACHED_ONLY|QUEUE_FULL|CREDENTIAL_MISSING|DISABLED|UNAVAILABLE|RUNNING",
  "nextRefreshAt":"ISO",
  "cacheStatus":"STALE",        // only on a stale-while-revalidate response
  "nextRefreshAt": "ISO"       // added on the STALE path (≈ now + 5 s)
}
```
Fresh window 5 s, stale window 300 s. Resolution must yield ≤720 points, else `400 invalid_history_resolution`. Unregistered mint → `422 history_unsupported`. Max 16 concurrent builds per process, else `503 history_busy`.

### `GET /v1/markets/:mint/history` — PUBLIC
**Query** `range` (lowercase enum, default `24h`), `resolution`: `1m` \| `5m` \| `15m` \| `1h`, `backfill`.
Same response body as above. `1m`=60 s, `5m`=300 s, `15m`=900 s, `1h`=3600 s.

### `GET /v1/markets/history/batch` — PUBLIC
**Query** `mints` (required, ≤10 distinct, ≤449 chars), `range` (only `24h` accepted).
Cache: `public, max-age=15`. Loads in chunks of 3 concurrently.

**Response `200`**
```json
{ "mode":"PAPER","range":"24H",
  "items": [{ "mint":"…","history":{ /* history object */ },"status":"READY" },
            { "mint":"…","history":null,"status":"UNAVAILABLE" }] }
```
Never spends the provider budget — cached/stored reads only. `400 invalid_history_batch`.

### `GET /v1/markets` — PUBLIC
**Query** (all strings; unknown keys or non-string values → `400 invalid_market_query`)
| Param | Values | Default |
|---|---|---|
| `feed` | `supported` \| `toptraded` \| `trending` | `supported` |
| `sort` | `supported`: `volume`\|`gainers`\|`losers`; others: `rank` | `volume` / `rank` |
| `interval` | `5m` \| `1h` \| `6h` \| `24h` \| `7d` \| `30d` | `24h` |
| `limit` | 1–50 | `20` |
| `category` | `major`\|`token`\|`memecoin`\|`unknown` | — |
| `minLiquidityUsd` | `^\d{1,13}(\.\d{1,18})?$`, ≤1e12 | — |
| `tradableOnly` | `"true"` \| `"false"` | `false` |
| `cursor` | base64url, ≤1024 chars | — |

Constraints: `7d`/`30d` only with `feed=supported` and `sort ≠ volume`. `query` is rejected here (use `/search`).

**Response `200`** (`MarketList`)
```json
{
  "schemaVersion":1,"mode":"PAPER",
  "feed":"supported","interval":"24h","sort":"volume",
  "scope":"SUPPORTED|PROVIDER_CANDIDATES|SEARCH_RESULTS",
  "snapshotId":"uuid","asOf":"ISO","fetchedAt":"ISO","refreshAfter":"ISO",
  "status":"CURRENT|STALE",
  "rankingStatus":"AVAILABLE|PARTIAL|UNAVAILABLE",
  "candidateCount":120,"unrankedCount":0,
  "nextCursor":"base64url|null",
  "items": [ /* MarketToken[] — see below */ ]
}
```
`MarketToken`:
```json
{ "mint":"…","instrumentId":"solana:…|null","symbol":"SOL","name":"Solana",
  "decimals":9,"icon":null,"category":"major",
  "tracked":true,"tradable":true,"tradeReason":null,
  "verified":true,"suspicious":null,"rank":1|null,
  "price": { "usd":"123.45|null","source":"JUPITER_PRICE_V3","sourceAt":"ISO|null",
             "receivedAt":"ISO","status":"CURRENT|STALE|UNAVAILABLE",
             "usableForExecution":true },
  "metrics": { "interval":"24h","volumeUsd":"…|null","liquidityUsd":"…|null",
               "changePercent":"…|null","source":"JUPITER_TOKENS_V2|RECORDED_SAMPLES",
               "asOf":"ISO|null","status":"CURRENT|STALE|UNAVAILABLE",
               "coverage":"COMPLETE|PARTIAL|UNAVAILABLE" } }
```
`usableForExecution` requires `tracked` **and** `JUPITER_PRICE_V3` **and** `CURRENT`. Expired prices are downgraded to `STALE` with `usableForExecution: false`.

Cursor paging: the snapshot is cached 10 min; expired → `409 feed_snapshot_expired`. Errors `429 market_rate_limited` / `503 market_feed_unavailable` both set `retry-after: 5`. Whole group returns `404 market_discovery_disabled` unless `MARKET_DISCOVERY_V1_ENABLED === 'true'`.

### `GET /v1/markets/search` — PUBLIC
Same response as `/v1/markets`, but `feed` is forced to `search`, `sort` to `relevance`, `interval` is `null`, and **`query` is required** (1–100 chars after trim).

### `GET /v1/markets/:mint` — PUBLIC
Same wrapper with `items` narrowed to the single matching token. `404 token_not_found`.

### `POST /v1/markets/:mint/tracking` — AUTH
Register a mint for streaming and acquire a 30-second lease.
**URL params** `mint` (base58, must round-trip through `PublicKey`)

**Response `200`**
```json
{ "mode":"PAPER","instrumentId":"solana:…","mint":"…",
  "state":"READY|WARMING|STALE|UNAVAILABLE",
  "reason":null,"retryAfterMs":1500,"leaseExpiresAt":"ISO" }
```
Admission bounds (Redis Lua, checked before any RPC): ≤10 active leases/user, ≤200 global, ≤30 requests/user/minute → `429 tracking_capacity`. Redis required → `503 tracking_unavailable`. If the mint is unregistered and `PAPER_DYNAMIC_MARKETS_ENABLED` is off → `422 dynamic_buys_paused`. Mainnet mint-account verification mismatch → `422 mint_metadata_conflict`; decimals >18 → `422 unsupported_precision`.

### `GET /v1/markets/:mint/icon` — PUBLIC
**URL params** `mint`
**Response `200`** → `image/webp` bytes.
Cache: `public, max-age=86400, stale-while-revalidate=604800` + strong `ETag` (SHA-256). `304` on `If-None-Match`. `503 token_icons_busy` sets `retry-after: 3` and `cache-control: no-store`.

---

## 12. Devnet Treasury Token Layer (`USDG_MINT` set)

All routes in this group are registered **only** when the token layer is configured, and the server refuses to start if `USDG_MINT` is set without a matching mint.

### `GET /v0/me/token-balance` — AUTH
```json
{
  "mode":"PAPER",
  "token": { "label":"Test USDC (devnet)","mint":"…","decimals":6,"cluster":"devnet" },
  "wallet": "9xY…|null",
  "onchain": { "amount":"100.000000","raw":"100000000" } | null,
  "paper": { "cash": { "value":"7400.000000","asset":"USDC" },
             "positions": [ /* myPositions */ ] }
}
```
Reconciles pending payouts before reading.

### `POST /v0/me/deposits/prepare` — AUTH
**Body** `{ "amountUsdc": "decimal ≤6 dp, ≥1 token" }`
Rate limited to `PREPARE_RATE_PER_HOUR` (default 20) per user under an advisory lock.

**Response `200`**
```json
{ "mode":"PAPER","token":{…},"wallet":"9xY…","treasuryTokenAccount":"…",
  "amountUsdc":"100.000000","transaction":"base64","encoding":"base64",
  "lastValidBlockHeight":"123456" }
```

### `POST /v0/me/deposits` — AUTH
**Body**
| Field | Type | Required | Constraint |
|---|---|---|---|
| `signature` | string | yes | `^[1-9A-HJ-NP-Za-km-z]{64,88}$` |
| `amountUsdc` | string | yes | ≤40 chars, ≥1 token |
| `fundId` | uuid | no | optional auto-join target |

**Response `202`** (still `PENDING`) or **`200`** (settled)
```json
{ "mode":"PAPER",
  "deposit": { "signature":"…","status":"PENDING|CONFIRMED|FAILED|EXPIRED",
               "amount":"100.000000","fundId":"uuid|null",
               "failure":null,"eventId":"uuid|null",
               "join": { "eventId":"uuid|null","error":null } | null } }
```
`409 deposit_conflict` when the signature was already submitted with a different amount or fund.

### `GET /v0/me/deposits/:signature` — AUTH
`200` / `202` → same `DepositView`. Verification never trusts a client success flag, signature, or sender address.

### `POST /v0/me/withdrawals` — AUTH
**Headers** `Idempotency-Key` (required)
**Body** (all optional, at least one in practice)
| Field | Type | Constraint |
|---|---|---|
| `amountUsdc` | string | ≤40 chars |
| `fundId` | uuid | — |
| `shares` | string | ≤40 chars (redeem a fund position) |

**Response `201`** (confirmed) or **`202`** (pending)
```json
{ "mode":"PAPER",
  "withdrawal": { "id":"uuid","kind":"WITHDRAWAL|SIGNUP_GRANT",
                  "status":"PENDING|CONFIRMED","signature":null,
                  "amount":"100.000000","wallet":"9xY…",
                  "attempts":0,"lastError":null },
  "exit": { "mode":"PAPER","fundId":"uuid","eventId":"uuid",
            "shares":"…","virtualUsdc":"…","sharePrice":"…" } | null }
```

### `GET /v0/me/withdrawals/:withdrawalId` — AUTH
`{ "mode":"PAPER","withdrawal":{ …PayoutView } }`

### `GET /v0/me/wallet` — AUTH
Funding summary.
```json
{
  "mode":"PAPER",
  "enabled": true,
  "token": { "label":"Test USDC (devnet)","mint":"…","decimals":6,"cluster":"devnet" } | null,
  "available": { "amount":"7400.000000","asset":"USDC" },
  "positions": [ /* myPositions */ ],
  "deposits": [ /* QR deposit views, newest 50 */ ]
}
```

### `POST /v0/me/qr-deposits` — AUTH → **201**
**Headers** `Idempotency-Key` (required)
**Body** `{ "amount": "decimal ≤6 dp, 1 – 1 000 000 test USDC" }`

**Response `201`**
```json
{ "deposit": {
  "canPay": true,
  "id":"uuid","reference":"pubkey",
  "amount":"100.000000","creditedAmount":"0.000000",
  "status":"WAITING|CONFIRMING|CONFIRMED|EXPIRED",
  "signature":null,"lastError":null,
  "expiresAt":"ISO","createdAt":"ISO",
  "token": { "label":"Test USDC (devnet)","mint":"…","decimals":6,"cluster":"devnet" },
  "paymentUrl": "solana:<owner>?amount=…&spl-token=…&reference=…&label=Socially&message=…"
} }
```
`canPay` is `false` when the request has expired, the mint/recipient/ATA no longer match the live configuration, or the status left `WAITING`/`CONFIRMING`. 20 requests/hour → `429 rate_limited`. The Solana Pay recipient is the treasury **owner**, not its token account.

### `GET /v0/me/qr-deposits/:id` — AUTH
`{ "deposit": { …QR deposit view } }`. `404 deposit_not_found`.
A payment is credited only when a finalized transaction has exactly one transfer, exactly one matching reference, an allowed instruction set, the expected destination and mint, and matching balance deltas. Rejections recorded: `transaction_failed`, `unexpected_transfers`, `wrong_reference`, `unexpected_instruction`, `wrong_destination`, `wrong_mint`, `wrong_amount`, `already_credited`.

---

## 13. Wallet Swaps (Raydium, devnet)

Registered only when `SWAP_ENABLED` and the venue config load; otherwise every route returns `503 swaps_unavailable`. Requires `PRIVY_APP_SECRET` — the quoted wallet must be linked to the authenticated Privy user (`403 wallet_not_linked`), and `409 wallet_mismatch` if the account is already bound to a different wallet.

### `POST /v1/me/swaps/quotes` — AUTH → **201**
**Body**
| Field | Type | Required | Constraint |
|---|---|---|---|
| `wallet` | string | yes | 32–44 chars, base58 |
| `input` | enum | yes | `SOL` \| `USDC` |
| `amountRaw` | string | yes | `^[1-9][0-9]{0,19}$`, ≤ `2^64-1` |

**Response `201`**
```json
{ "quote": { "id":"uuid","wallet":"9xY…","cluster":"devnet",
             "input":"SOL","output":"USDC",
             "amount":"0.1","outputAmount":"15.2","minimumOutput":"15.05",
             "priceImpact":0.01,"slippageBps":100,"hops":1,
             "venueFees":[{ "mint":"…","amountRaw":"…":"1" }] | null,
             "expiresAt":"ISO" } }
```
Expiry is a **server** TTL (`SWAP_QUOTE_LIFETIME_MS`), since Raydium does not promise one. Rate limited by `SWAP_QUOTES_PER_HOUR` (default 1800).

### `POST /v1/me/swaps` — AUTH → **201**
**Body**
| Field | Type | Required |
|---|---|---|
| `quoteId` | uuid | yes |
| `clientRequestId` | uuid | yes |

**Response `201`** → `{ "swap": { …SwapView, status: "PREPARED" } }`
`clientRequestId` is the idempotency key: a repeat with the same quote returns the same swap (`409 idempotency_conflict` if the quote differs, `409 quote_already_prepared`). `409 quote_expired`. Rate limited to `SWAP_PREPARES_PER_HOUR` (default 30).

### `POST /v1/me/swaps/:id/submit` — AUTH
**URL params** `id` (uuid)
**Body** `{ "signedTransaction": "base64, 1–1644 chars" }`

**Response `202`** (submitted) or **`200`** (already confirmed)
```json
{ "swap": { …SwapView, status: "SUBMITTED|CONFIRMED|FAILED|EXPIRED", signature: "…" } }
```
The server verifies the signed bytes against the prepared unsigned transaction and the wallet. Signed bytes are persisted **before** any broadcast, so the reconciler survives a crash. `409 signature_conflict` if a different signature is already recorded. 120/hour.

### `GET /v1/me/swaps/:id` — AUTH
`{ "swap": { …SwapView } }`. `404 swap_not_found`. Read budget 2400/hour.

**`SwapView`**
```json
{
  "id":"uuid","quoteId":"uuid","clientRequestId":"uuid",
  "wallet":"9xY…","cluster":"devnet",
  "status":"PREPARED|SUBMITTED|CONFIRMED|FAILED|EXPIRED",
  "quote": { /* public quote */ },
  "transaction":"base64|null",     // only while PREPARED
  "signature":null,"blockhash":"…",
  "lastValidBlockHeight": 123456,
  "fees": { "networkFeeLamports":"5000","priorityFeeLamports":"10000",
            "accountRentLamports":"2039280" },
  "filledOutputRaw":"…|null","actualNetworkFeeLamports":"…|null",
  "failure":null,"createdAt":"ISO","updatedAt":"ISO"
}
```
`fees.networkFeeLamports` is the **total including priority** — never add priority again.

### `GET /v1/me/swaps` — AUTH
**Query** `status` (enum above), `after` (uuid keyset on `(created_at, id)`), `limit` (1–50, default 20)
```json
{ "swaps":[ /* SwapView[] */ ], "nextCursor":"uuid|null" }
```

---

## 14. Live On-Chain Vaults (devnet `v1-core`)

Requires `LIVE_VAULTS_ENABLED !== 'false'` **and** a ready program/config; otherwise `503 live_vaults_unconfigured`. Wallet ownership is verified against Privy linked wallets on every write (`403 wallet_not_linked`, `409 wallet_mismatch`, `400 invalid_wallet`).

### `GET /v1/live-vaults/config` — PUBLIC
```json
{
  "mode":"ONCHAIN","cluster":"devnet",
  "enabled":true,"reason":null,
  "minimumSeedUsdcRaw":"100000000",
  "assets":["SOL","USDC"],
  "settlementAsset":"USDC",
  "exitPolicy":"IN_KIND_ON_DEMAND",
  "performanceFeeBps":1000
}
```
`reason` is a non-null string when not enabled (e.g. `live_vaults_unconfigured`).

### `POST /v1/live-vaults` — AUTH → **201**
**Body**
| Field | Type | Required | Constraint |
|---|---|---|---|
| `clientRequestId` | uuid | yes | idempotency key |
| `wallet` | string | yes | 32–44 chars |
| `asset` | enum | yes | `SOL` \| `USDC` |
| `amountRaw` | string | yes | `^[1-9][0-9]{0,19}$`, ≤ `2^64-1` |
| `name` | string | yes | 3–80 after trim |
| `description` | string | yes | ≤1000 |

Captain-only (`403 captain_required`). `name`/`description` are trimmed before hashing.

**Response `201`** `{ "operation": { …LiveOperation, status: "PREPARED", transaction: "<base64>" } }`
`409 idempotency_conflict` when `clientRequestId` is reused with a different body; `429 rate_limited` past 30 preparations/hour; `409 pending_creation` when another CREATE is `PREPARED`/`SUBMITTED`.

**`LiveOperation`**
```json
{ "id":"uuid","clientRequestId":"uuid","vaultId":"uuid",
  "fundAddress":"pubkey","seedUsdcRaw":"100000000","wallet":"9xY…",
  "kind":"CREATE|EXIT","mode":"ONCHAIN","cluster":"devnet",
  "asset":"SOL","amountRaw":"100000000",
  "status":"PREPARED|SUBMITTED|CONFIRMED|FAILED|EXPIRED",
  "transaction":"base64|null",   // unsigned tx only while PREPARED
  "signature":null,"lastValidBlockHeight":123456,
  "fees":{},"failure":null }
```

### `GET /v1/me/live-vaults` — AUTH
Newest 50, confirmed CREATEs only.
```json
{ "vaults": [{ "id":"uuid","name":"…","description":"…",
               "fundAddress":"pubkey","seedUsdcRaw":"…","createdAt":"ISO" }] }
```

### `GET /v1/me/live-vault-operations?clientRequestId=<uuid>` — AUTH
**Query** `clientRequestId` (required, uuid) → `{ "operation": { …LiveOperation } }`. `404 operation_missing`.

### `GET /v1/me/live-vault-pending` — AUTH
Newest 10 `PREPARED`/`SUBMITTED` operations → `{ "operations": [ …LiveOperation ] }`.

### `GET /v1/live-vaults/:id` — AUTH
**URL params** `id` (uuid) → `404 vault_missing`
```json
{ "vault": { "id":"uuid","name":"…","description":"…","fundAddress":"pubkey",
             "wallet":"9xY…","seedUsdcRaw":"…","status":"CONFIRMED",
             "mode":"ONCHAIN","cluster":"devnet" },
  "position": { /* on-chain holdings, only when CONFIRMED */ } | null }
```

### `POST /v1/live-vaults/:id/exits` — AUTH → **201**
**URL params** `id` (uuid). **Body** `{ "clientRequestId": "uuid" }` (required)
`409 pending_exit` if an EXIT is already in flight. Response `{ "operation": { …LiveOperation, kind: "EXIT", asset: "SHARES" } }`.

### `POST /v1/live-vault-operations/:id/submit` — AUTH → **202**
**URL params** `id` (uuid). **Body** `{ "signedTransaction": "base64, ≤1644" }`
`409 signature_conflict`, `409 transaction_expired`, `404 operation_missing`.
Re-submitting a non-`PREPARED` operation returns it unchanged.

---

## 15. Paper Portfolio (wallet snapshot)

Gated by `PAPER_WALLET_SNAPSHOT_ENABLED=true`. When on, vaults use the isolated `vault_paper_cash` balance instead of `paper_cash` — a wallet snapshot cannot be redeemed as treasury token.

### `GET /v1/me/paper-portfolio` — AUTH
```json
{ "mode":"PAPER","enabled":true,"initialized":true,
  "availableUsdc":"2400.000000",
  "initialUsdc":"2400.000000|null",
  "wallet":"9xY…|null","initializedAt":"ISO|null" }
```

### `POST /v1/me/paper-portfolio/initialize` — AUTH
**Body** `{ "wallet": "base58, ^[1-9A-HJ-NP-Za-km-z]{32,44}$" }`

**Response `200`** → `PaperPortfolio` as above.
Reads finalized devnet SOL + USDC balances, prices them with **fresh** marks, and mints the equivalent paper USDC. One-shot per account and per wallet.
Errors: `503 paper_portfolio_disabled`, `503 auth_unconfigured`, `403 wallet_not_owned`, `409 wallet_already_snapshotted`, `422 empty_wallet`, `503 prices_unavailable`, `422 balance_out_of_range`, `503 wrong_cluster`.

---

## 16. WebSocket 1 — Market & Private Gateway (`GET /v0/ws`)

Registered by `market-routes.ts`. Public channel plus optional private channels.

### Handshake (upgrade)

| Check | Failure |
|---|---|
| `Origin` ∈ `WS_ALLOWED_ORIGINS` (if set); if unset, only rejected when `NODE_ENV=production` | `403 origin_forbidden` |
| Global connections < 1000 | `503 gateway_busy` |
| `REDIS_URL` configured | `503 market_unavailable` |

Frame limit `maxPayload: 8192` bytes. Binary frames are rejected outright.

### Server → client

Sent immediately on connect:
```json
{ "type":"hello", "mode":"PAPER",
  "channels":["market.prices","account.notifications","vault.context","captain.dashboard"] }
```
`vault.context` and `captain.dashboard` appear only when `PAPER_PRIVATE_UPDATES_ENABLED === 'true'`.

| Message | Trigger | Shape |
|---|---|---|
| `authenticated` | after `authenticate` | `{ type, expiresAt }` |
| `authentication_required` | token expiry detected by the tick | `{ type }` — clears all identity |
| `subscribed` | `subscribe` with an in-window cursor | `{ type, channel, cursor }` |
| `resync_required` | cursor out of window, channel change, or private subscribe | `{ type, channel, vaultId?, accountingRevision?, revision?, cursor }` |
| `snapshot` | subscribe / resync | `{ type, channel:"market.prices", cursor, prices:[MarketPrice] }` |
| `price_update` | Redis stream event | `{ type, channel, cursor, eventId, price }` |
| `market_status` | per-instrument status changed, or a full cursor catch-up with different freshness | `{ type, channel, cursor, prices:[MarketPrice] }` |
| `cursor` | event for a non-subscribed instrument | `{ type, channel, cursor }` |
| `vault.updated` | vault accounting revision advanced (permission rechecked each scan) | `{ type, channel:"vault.context", eventId, vaultId, accountingRevision, cursor }` |
| `captain.updated` | captain dashboard revision advanced | `{ type, channel:"captain.dashboard", revision, cursor, eventId }` |
| `notification` | new notification row | `{ type, channel:"account.notifications", cursor, notification:{ id, fundId, type, payload, createdAt, readAt } }` |
| `stream_unavailable` | Redis/DB failure on that channel | `{ type, channel }` |
| `error` | any rejected message | `{ type:"error", code:"request_rejected", message }` — **plus** channel-scoped errors `{ type:"error", channel, code }` with `vault_forbidden` / `captain_forbidden` |

### Client → server

Messages are processed strictly sequentially per connection. Non-JSON, arrays, or primitives → generic error.

```jsonc
// 1. authenticate — clears any prior identity first, even on failure
{ "type": "authenticate", "accessToken": "privy-access-token" }
// → 400-equivalent errors surfaced as `error` with code request_rejected

// 2. subscribe: market.prices (public)
{ "type":"subscribe", "channel":"market.prices",
  "instruments":["SOL","USDC"],   // optional, ≤50 unique, each ≤64 chars
  "after":"1042-0" }               // optional, matches /^(0|[1-9][0-9]{0,18})-0$/

// 3. subscribe: account.notifications (AUTH)
{ "type":"subscribe", "channel":"account.notifications", "after":"0" }

// 4. subscribe: vault.context (AUTH, requires PAPER_PRIVATE_UPDATES_ENABLED)
{ "type":"subscribe", "channel":"vault.context", "vaultId":"uuid" }

// 5. subscribe: captain.dashboard (AUTH, requires PAPER_PRIVATE_UPDATES_ENABLED)
{ "type":"subscribe", "channel":"captain.dashboard" }

// 6. unsubscribe
{ "type":"unsubscribe", "channel":"market.prices" }
```

Rejection codes (all delivered as a generic `error` frame): `invalid_message`, `invalid_token`, `bootstrap_required`, `unsupported_instrument`, `unknown_instrument`, `invalid_cursor`, `authentication_required`, `invalid_vault`, `vault_forbidden`, `captain_forbidden`, `captain_required`, `unsupported_channel`, `unsupported_message`.

### Lifecycle
- **Heartbeat**: server pings every 20 s; a client that misses a pong is terminated.
- **Rate limit**: 20 messages / 10 s window, ≤5 in flight; exceeding either closes with `1008 "Message limit exceeded"`.
- **Backpressure**: `bufferedAmount > 256 KiB` → close `1013 "Reconnect and resync"`.
- **Fan-out tick**: 500 ms, single in-flight loop; market events fan out to every local subscriber.
- **Identity expiry**: cleared on the tick and an `authentication_required` frame is sent.
- **Resync rule**: any cursor older than `firstCursor` or newer than `cursor` forces `resync_required` + `snapshot`.

---

## 17. WebSocket 2 — Vault Event Stream (`GET /v1/vaults/ws`)

Registered by `vault-stream.ts`. Unauthenticated invalidation-only stream: notifications never carry payloads, so **every reconnect requires a REST snapshot**.

### Handshake

| Check | Failure |
|---|---|
| `Origin` ∈ `WS_ALLOWED_ORIGINS` (same rule as above) | `403 origin_forbidden` |
| < 10 connections from this IP | `429 connection_limit` |
| < 200 connections globally | `503 gateway_busy` |

Frame limit `maxPayload: 8192`.

### Client → server
```jsonc
{ "type": "subscribe", "vaultIds": ["uuid", "uuid"] }   // ≤20 uuids
```
Anything else (including a missing/oversized/non-uuid `vaultIds` array, a binary frame, or invalid JSON) closes the socket with `1008`. Rate limit 10 messages / 10 s → `1008 "Message limit exceeded"`.

Replies, one per vaultId, **always** — including when the cursor is unchanged:
```json
{ "type":"resync", "vaultId":"uuid", "eventSequence":"42" }
```

### Server → client
```json
{ "type":"vault.updated", "vaultId":"uuid", "eventSequence":"43" }
```
One bounded database scan per gateway tick (1 s), shared across all local subscribers — no per-client SQL loops and no Redis dependency.

### Lifecycle
- Heartbeat ping every 25 s; missed pong → `terminate()`.
- `bufferedAmount > 64 KiB` → close `1013 "Reconnect and resync"`.
- A failed scan is **not** a successful delivery: all clients get `1013 "Resync required"`.
- The interval stops when the last client disconnects and all cached sequences are cleared.

---

## 18. Background Workers (no HTTP surface)

Started by `index.ts`; stopped via `preClose` hooks.

| Worker | Cadence | Scope |
|---|---|---|
| Live vault sweeper | 5 s | Leases ≤20 `PREPARED`/`SUBMITTED` ops (`FOR UPDATE SKIP LOCKED`), broadcasts, observes, sets `CONFIRMED`/`FAILED`/`EXPIRED`. Pending rows re-check in 3 s. |
| Wallet swap reconciler | 2 s | Leases ≤8 swaps, observes the chain, retries a broadcast of already-signed bytes, persists `CONFIRMED`/`EXPIRED`/`FAILED`. Errors back off 15 s. Prunes `wallet_swap_requests` older than 1 day. |
| QR deposit worker | 2 s | Leases ≤4 deposits, discovers signatures by reference, verifies finalization, credits exactly once via `token_deposit_receipts`. |
| Market stream fan-out | 500 ms | Poll loop inside the WS gateway. |

---

## 19. Route Index

### Public — no auth
```
GET    /health
GET    /v0/funds
GET    /v0/funds/:fundId
GET    /v0/funds/:fundId/policy
GET    /v0/funds/:fundId/holdings
GET    /v0/funds/:fundId/orders
GET    /v0/funds/:fundId/orders/:orderId
GET    /v0/funds/:fundId/messages
GET    /v0/funds/:fundId/decisions
GET    /v0/funds/:fundId/events
GET    /v0/funds/:fundId/events/stream          (SSE)
GET    /v0/funds/:fundId/performance
GET    /v0/funds/:fundId/history
GET    /v0/funds/rankings
GET    /v0/captains/:captainId
GET    /v0/captains/:captainId/orders
GET    /v0/captains/:captainId/trade-statistics
GET    /v0/captains/:captainId/paper-record
GET    /v0/captains/handle-availability
GET    /v0/users/username-availability
GET    /v0/market/prices
GET    /v0/market/tokens
GET    /v0/market/tokens/:mint
GET    /v0/market/tokens/:mint/history
GET    /v1/markets
GET    /v1/markets/search
GET    /v1/markets/:mint
GET    /v1/markets/:mint/history
GET    /v1/markets/:mint/icon
GET    /v1/markets/history/batch
GET    /v1/vaults
GET    /v1/vaults/:id
GET    /v1/vaults/:id/performance
GET    /v1/vaults/:id/activity
GET    /v1/vault-config
GET    /v1/live-vaults/config
POST   /v0/auth/client-events
```

### Authenticated
```
GET    /v0/me
PATCH  /v0/me
POST   /v0/me/onboarding
GET    /v0/me/paper-balance
GET    /v0/me/paper-positions
GET    /v0/me/paper-record
GET    /v0/me/funds/:fundId/performance
GET    /v0/me/crew-transactions
GET    /v0/me/notifications
POST   /v0/me/notifications/:notificationId/read
GET    /v0/me/watchlist
PUT    /v0/me/watchlist/:mint
DELETE /v0/me/watchlist/:mint
POST   /v0/captains
PATCH  /v0/captains/:captainId
POST   /v0/me/support-requests
POST   /v0/auth/privy
GET    /v0/me/wallet
POST   /v0/me/qr-deposits
GET    /v0/me/qr-deposits/:id
GET    /v0/me/token-balance                (token layer)
POST   /v0/me/deposits/prepare             (token layer)
POST   /v0/me/deposits                     (token layer)
GET    /v0/me/deposits/:signature          (token layer)
POST   /v0/me/withdrawals                  (token layer)
GET    /v0/me/withdrawals/:withdrawalId     (token layer)
POST   /v0/me/assets/uploads
POST   /v0/me/assets/uploads/:uploadId/complete
POST   /v0/captains/:captainId/assets/uploads
POST   /v0/captains/:captainId/assets/uploads/:uploadId/complete
```

### Captain-only
```
GET    /v0/me/captain/funds
GET    /v0/funds/:fundId/trading-context
POST   /v0/funds
POST   /v0/funds/:fundId/joins
POST   /v0/funds/:fundId/exits
POST   /v0/funds/:fundId/orders
POST   /v0/funds/:fundId/orders/:orderId/cancel
POST   /v0/funds/:fundId/orders/:orderId/notes
GET    /v1/me/captain/vaults
GET    /v1/me/captain/dashboard
GET    /v1/me/captain/crew
GET    /v1/me/captain/earnings
GET    /v1/me/captain/performance
GET    /v1/me/captain/returns
GET    /v1/me/captain/paper-health
GET    /v1/vaults/:fundId/trading-context
POST   /v1/vaults
POST   /v1/vaults/preview
POST   /v1/vaults/:id/test-activation
POST   /v1/vaults/:id/assets/uploads
POST   /v1/vaults/:id/assets/uploads/:uploadId/complete
POST   /v1/me/swaps/quotes
POST   /v1/me/swaps
POST   /v1/me/swaps/:id/submit
GET    /v1/me/swaps
GET    /v1/me/swaps/:id
GET    /v1/me/paper-portfolio
POST   /v1/me/paper-portfolio/initialize
GET    /v1/me/live-vaults
GET    /v1/me/live-vault-pending
GET    /v1/me/live-vault-operations
POST   /v1/live-vaults
POST   /v1/live-vaults/:id/exits
POST   /v1/live-vault-operations/:id/submit
```

### Vault member (any contributing member)
```
GET    /v1/me/vaults
GET    /v1/vaults/:id/position
GET    /v1/vaults/:id/orders/:orderId
POST   /v1/vaults/:id/orders/:orderId/cancel
POST   /v1/vaults/:id/contribution-quotes
POST   /v1/vaults/:id/contributions
POST   /v1/vaults/:id/contribution-cancellations
POST   /v1/vaults/:id/claims
GET    /v1/vaults/:id/orders/preview
POST   /v1/vaults/:id/orders
POST   /v1/vaults/:id/orders/preview
GET    /v1/operations/:id
GET    /v1/me/operations
POST   /v1/markets/:mint/tracking
GET    /v1/me/paper-activity
```

### Admin
```
GET    /admin/logs
GET    /admin/logs/data
GET    /admin/paper-trading/health
```

### WebSocket / SSE
```
WS     /v0/ws                       market + private gateway
WS     /v1/vaults/ws                vault invalidation stream
SSE    /v0/funds/:fundId/events/stream
```

### Idempotency-Key required
```
POST /v0/funds
POST /v0/funds/:fundId/joins
POST /v0/funds/:fundId/exits
POST /v0/funds/:fundId/orders
POST /v0/funds/:fundId/messages
POST /v0/funds/:fundId/orders/:orderId/notes
POST /v0/me/qr-deposits
POST /v0/me/withdrawals
POST /v1/vaults
POST /v1/vaults/:id/contributions
POST /v1/vaults/:id/contribution-cancellations
POST /v1/vaults/:id/claims
POST /v1/vaults/:id/orders
```
> Live vaults and swaps use an explicit `clientRequestId` **body** field (uuid) instead of the header, so the operation can be recovered by ID after a client-side timeout.

---

## 20. Feature Flags

| Env var | Default | Effect when off / on |
|---|---|---|
| `VAULT_PAPER_ENABLED` | `false` | Must be `true` **and** terms approved for `/v1` vault creation |
| `VAULT_TERMS_APPROVAL` | — | Must equal `locked-v1-retain-residue` |
| `VAULT_CONTRIBUTIONS_PAUSED` | `false` | `true` pauses new contributions; cancellations/refunds/claims continue |
| `PAPER_WALLET_SNAPSHOT_ENABLED` | `false` | `true` switches vaults to isolated `vault_paper_cash` |
| `PAPER_TEST_SKIP_FUNDRAISING` | `false` | `true` (dev only) enables `/test-activation` |
| `PAPER_DYNAMIC_MARKETS_ENABLED` | `false` | `false` blocks registering new mints on buys |
| `PAPER_PRIVATE_UPDATES_ENABLED` | `false` | Enables the private WS channels `vault.context` / `captain.dashboard` |
| `MARKET_DISCOVERY_V1_ENABLED` | `false` | `false` → `404 market_discovery_disabled` on `/v1/markets*` |
| `MARKET_HISTORY_PROVIDER_ENABLED` | `false` | `false` → `backfillStatus: "DISABLED"`, stored charts still served |
| `LIVE_VAULTS_ENABLED` | `true` | `false` → `503 live_vaults_unconfigured` |
| `SWAP_ENABLED` | `true` | `false` → `503 swaps_unavailable` |
| `ADMIN_LOGS_ENABLED` | `true` | `false` removes `/admin/logs*` |
| `USDG_MINT` | unset | Set → treasury token layer on; paper signup grant becomes 0 |

---

## 21. Source Map

| Area | File |
|---|---|
| App composition, error handler, `/health` | `apps/api/src/app.ts` |
| CORS / preflight | `apps/api/src/cors.ts` |
| Auth (`requireActor`, Actor) | `apps/api/src/auth.ts` |
| Privy token verification | `apps/api/src/privy.ts` |
| Idempotency + cursors | `apps/api/src/request.ts` |
| Error type | `apps/api/src/errors.ts` |
| **WS 1** market gateway | `apps/api/src/market-routes.ts` |
| **WS 2** vault stream | `apps/api/src/vault-stream.ts` |
| SSE fund events | `apps/api/src/events.ts` |
| Admin logs | `apps/api/src/admin-logs.ts` |
| Health / paper health | `apps/api/src/paper-trading-health.ts` |
| Account + usernames | `apps/api/src/account-routes.ts`, `username-index.ts`, `user-profiles.ts` |
| Captain profiles / uploads | `apps/api/src/captain-profiles.ts`, `user-uploads.ts`, `asset-storage.ts` |
| Auth routes | `apps/api/src/auth-routes.ts`, `auth-client-events.ts` |
| Funds (v1) | `apps/api/src/fund-routes.ts`, `funds.ts`, `crew.ts` |
| Orders | `apps/api/src/order-routes.ts`, `orders.ts` |
| Vaults (v2) | `apps/api/src/vault-routes.ts`, `vaults.ts`, `vault-performance.ts` |
| Vault uploads | `apps/api/src/vault-uploads.ts` |
| Vault config gating | `apps/api/src/vault-rate-limit.ts`, `test-vault-activation.ts` |
| Live vaults | `apps/api/src/live-vault-routes.ts`, `live-vault-chain.ts` |
| Captain dashboard | `apps/api/src/captain-dashboard.ts`, `captain-returns.ts` |
| Trading context | `apps/api/src/trading-context.ts`, `revision-cache.ts` |
| Markets (catalog/history/discovery/tracking/icons) | `apps/api/src/market-catalog-routes.ts`, `market-catalog.ts`, `market-history.ts`, `market-discovery-routes.ts`, `market-discovery.ts`, `market-tracking.ts`, `token-icons.ts` |
| Performance & rankings | `apps/api/src/performance.ts` |
| Order / crew history | `apps/api/src/history.ts`, `paper-activity.ts` |
| Social | `apps/api/src/social.ts` |
| Notifications | `apps/api/src/notifications.ts` |
| Treasury token layer | `apps/api/src/token-routes.ts`, `token-flows.ts`, `token-chain.ts` |
| QR deposits | `apps/api/src/qr-deposit-routes.ts`, `qr-deposits.ts` |
| Wallet swaps | `apps/api/src/swap-routes.ts`, `swap-flows.ts`, `swap-chain.ts`, `swap-types.ts`, `swap-config.ts` |
| Paper portfolio | `apps/api/src/paper-portfolio.ts` |
| Ledger accounting | `apps/api/src/accounting.ts` |
| Market bus | `packages/market-stream/src/index.ts` |
| Fill model | `packages/market-data/src/index.ts` |
| Shared contract types | `packages/contracts/src/{vaults,markets,paper-trading}.ts` |
| Vault rules / Amount | `packages/domain/src/vault-rounds.ts` |
