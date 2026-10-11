# Paper trading production changes

Postgres owns financial state, price evidence, reservations, ledger reconciliation and completed worker/ingestor cycles. Redis owns replaceable market delivery, revision caches and expiring stream-admission leases. A Redis value never authorizes a financial mutation or supplies a fill price. Financial reads remain uncached except the existing one-second, permission- and revision-aware trading context.

## Orders and accounting

Order submission and preview use authoritative prices and available resources under the fund lock. BUY reserves the full cash notional, including its simulated fee; SELL reserves token quantity. Reservations leave settled balances, NAV and the ledger unchanged. Only PENDING orders reserve resources, so fill, rejection and cancellation release them atomically. Submission validates cash, tokens and policy immediately. Pending buys also consume instrument exposure headroom.

A quantity SELL preserves its quantity. A notional SELL reserves the quantity estimated on submission. If the fill price later requires more tokens than that reservation, execution rejects with `reservation_exceeded`; it never consumes another order's allocation. The captain can submit a newly priced intent. Worker execution still rechecks policy and available resources. Expired intents reject with `order_expired` even when a fresh mark is present.

Lock order is fund → order. Crew exits return `409 orders_pending` while resources are reserved. Trial and round settlement cancel pending intents with audit events before liquidation and payout. Cancellation races with execution have one committed terminal result.

Cash remains exact PostgreSQL numeric with six-decimal write constraints; shares, marks and cost basis keep their separate precision. Historical fractional cash is not silently rounded. Wallet bind refuses excess cash precision with `409 balance_precision`, and mints exactly the cash it debits. Account and portfolio cash responses use six-decimal strings.

Fills persist average cost basis sold, realized PnL and the actual simulation parameters. Realized PnL is sell proceeds after fees minus basis sold. Trading context calculates current unrealized PnL from marked holdings and cost basis. Unrealized PnL is not frozen into historical fills.

Portfolio initialization requires `Idempotency-Key`. External ownership and finalized wallet reads happen before financial locks; price selection and validation happen after the user and wallet locks. The APK uses a stable account-scoped key derived from the submitted wallet. Replaying a key returns the original response; changed input returns `409 idempotency_conflict`.

Both user cash projections reconcile against separate USER ledger owners (`<user UUID>` and `paper-vault:<user UUID>`). Fund audits additionally check reservation backing. Durable state and deduplicated incidents report mismatches. No job repairs balances automatically.

## Price policy and halts

`PAPER_PRICE_MAX_AGE_MS` defaults to 15 seconds for display, previews, valuation, fills, wallet pricing and vault unwinds. Both source time and successful receipt/confirmation must pass the same rule. Current Postgres feed status and observation identity are required for Jupiter execution; a subsequent unavailable feed status blocks the previous mark. DEV_SEED is permitted only through the explicit nonproduction development switch.

Original `received_at` and source evidence stay immutable. Repeat successful fetches update `last_confirmed_at` and the latest delivery receipt. Confirmation after the order delay qualifies an unchanged price only while its original source remains fresh. Receiving an old source repeatedly cannot make it executable.

Synthetic bid/ask, spread, impact and fees are explicit simulation assumptions. Fills record their parameter snapshot. The unused liquidity column is removed. Actual executable route depth or upstream bid/ask is not supplied by this price provider; the simulator does not claim it. Order size and impact limits are configurable independently, so the impact cap can apply when a deployment intentionally permits larger orders.

The existing registry `DISABLED` state halts both sides. A provider decimals mismatch persists `DISABLED`, `active=false`, and `decimals_changed`; later normal polling does not clear it. Recovery requires verifying canonical mint metadata, stopping trading, reconciling all positions and ledger quantities, recording a separately reviewed migration if precision truly changed, and explicitly reactivating the instrument. Never automatically rescale economic balances from provider metadata.

## Access and streaming

v0 fund order lists/details and fund event pages/SSE require a verified identity and captain or current positive-share membership. v1 order details use the same permission check. Captain order history requires authentication. Events include allowlisted trading details and omit member identifiers, chat content and payout arrays. Vault activity includes unwinds and safe price-source metadata.

Use the existing `/v0/ws` `vault.context` channel for new private invalidations. `/v1/vaults/ws` is retained for existing clients, with bearer authentication at upgrade, token expiry and membership rechecks. Both websocket transports enforce origin rules. Browser callers must satisfy both `CORS_ORIGINS` and `WS_ALLOWED_ORIGINS`; native clients do not send an Origin header. Websocket errors preserve known client error codes without disclosing internal exceptions. A notification-query failure emits `stream_unavailable` for that channel. Heartbeat timers run independently of database scans.

Redis sorted-set leases atomically cap global, IP and authenticated-user connections across API instances. All keys use the database deployment identity and one Redis Cluster hash tag. Redis server time controls expiration; renewal failure closes the stream, and disconnect releases its leases. Production fails admission closed when Redis is unavailable. Development without Redis has bounded process-local admission. IPs come from the direct peer; deployments behind proxies must deliberately configure trusted peer handling before tuning IP caps.

SSE resumes from `Last-Event-ID` when present, ahead of the query cursor. It rechecks membership while polling, applies backpressure, closes at token expiry, renews admission and emits `stream_unavailable` on polling failure. Shutdown closes active SSE connections.

## Health and metrics

`GET /live` reports process liveness. `GET /health` and `/ready` return 503 unless Postgres, Redis and fresh worker/ingestor completed-cycle heartbeats are available. The worker records completed cycles; only the ingestor holding the scheduling advisory lock records ingestion-loop completion. An empty queue or quiet market is not used as a guessed process heartbeat.

Use `/live` for container restart probes and `/ready` for traffic readiness. Readiness can fail during startup until background services finish a cycle. Feed-specific market availability still appears on the market status and admin health surfaces.

Database connection, statement, transaction-idle and lock budgets are configurable. Query cancellation maps to `503 query_timeout`; lock timeout maps to `503 lock_timeout`, both with Retry-After. Unknown server failures remain documented `500 internal_error`.

Protected `/admin/paper-trading/health` includes user reconciliation and service heartbeats. Its request buckets are NON_CUMULATIVE, with a final `null` upper bound representing infinity. `/admin/paper-trading/metrics` exports standard cumulative Prometheus histograms in seconds. Scrape each API replica with an external Prometheus/OpenTelemetry collector to retain and aggregate metrics outside the process. API counters reset on restart; an external collector is required for retention. Do not sum histogram quantiles across replicas; aggregate buckets before calculating quantiles. No user, mint or fund IDs appear in request metric labels.

## Rollout

1. Back up the database and pause API financial writes, workers and ingestors. Deploy migration 034 before starting the new binaries. It cancels old unreserved pending orders and records cancellation events/outbox intents; clients must refetch them. Do not run old workers against the migrated schema or mix old/new execution binaries during rollout.
2. Configure the shared policy identically on API, worker and ingestor. `.env.example` lists the validated defaults and capacity/budget settings. Changing economic model parameters requires coordinated rollout; persisted fill parameters retain the assumptions actually used.
3. Start ingestor and worker, then API. Check `/ready`, protected admin health, pending reservations, and user/fund reconciliation coverage. Configure an external collector to scrape every replica's metrics endpoint with `ADMIN_LOGS_TOKEN`.
4. Review any historical cash-precision mismatch before validating the NOT VALID constraints. New writes are already constrained; do not round or overwrite ledger evidence as part of startup. Resolve discrepancies through an audited repair, then `VALIDATE CONSTRAINT` in a separate maintenance operation.

This change does not deploy services, mutate the existing application database, install a production metrics collector, or fabricate a live executable quote source. Integration tests use isolated schemas and temporary Redis servers.
