# socially.trade

Paper trading is the first implementation of the Captain and Crew experience described in the [whitepaper](./socially-trade-whitepaper.pdf). The planned live product will use separate onchain funds and records.

## Current state

Phases 0-5 establish the paper backend: accounts, Captain funds, Crew shares, SOL/USD price observations, order endpoints, and an order-processing worker. Backend checkpoints add a resumable event stream, fund chat, Captain order notes, an in-app inbox, performance records, simulated fees, and trial settlement. The mobile app, external push delivery, risk-adjusted rankings, and operational hardening remain in [the implementation phases](./docs/v0-implementation-phases.md). The detailed design is in [the v0 architecture](./docs/v0-paper-trading-architecture.md).

Captain Markets is connected to the sibling Expo mobile client: canonical token discovery, shared Jupiter ingestion, recorded token charts, owned-fund context, watchlists and multi-asset paper orders. See the [market API, architecture and operations handoff](../docs/market-integration.md) and [delivery checklist](../docs/plan.md). Onchain fund swaps remain a separate implementation.

UI developers: see the [complete v0 API integration specification](docs/ui-api-spec-v0.md) for all 42 operations, request/response contracts, authentication, pagination, errors and screen flows.

Shared Crew/Captain usernames use `GET /v0/users/username-availability?username=jassbawa`, with an optional Redis Bloom index and PostgreSQL fallback. Identity and profiles now live in one `users` table. See [account schema, endpoints and local setup](docs/unified-user-accounts.md).

Captain profile images: owners can use `PATCH /v0/captains/:captainId` to update bio, `avatarUrl` and `bannerUrl`. The upload reservation and completion endpoints validate/process images through private AWS S3 staging/processed buckets, with CloudFront delivery and save their URLs in PostgreSQL. Run the documented AWS setup with your account credentials. See [API and asset setup](docs/captain-profile-assets.md).

### Trade and Crew history

- `GET /v0/funds/:fundId/orders`: full cursor-paginated order history with fill details.
- `GET /v0/captains/:captainId/orders`: cursor-paginated orders across Captain funds.
- `GET /v0/captains/:captainId/trade-statistics`: lifetime order counts and executed volume.
- `GET /v0/me/crew-transactions`: private contributions, exits and settlement payouts.

See [history API contracts](docs/paper-history-api.md) for cursor and accounting semantics.

### Performance reads

- `GET /v0/funds/:fundId/performance`: current/historical NAV, unit returns, drawdown, fees and trial status.
- `GET /v0/funds/:fundId/history?after=0&limit=100`: cursor-paginated valuation history.
- `GET /v0/me/funds/:fundId/performance`: authenticated contributions, redemptions and personal P&L.
- `GET /v0/me/paper-record`: authenticated active and former allocations, including completed-fund results after all shares are redeemed.
- `GET /v0/captains/:captainId/paper-record`: preserved independent trial records.
- `GET /v0/funds/rankings`: net-return ranking with minimum age and disclosed limitations.

All results are simulated. The worker assesses fees and settles expired trials through atomic ledger transactions. See the [simulation report](./docs/backend-simulation-report.md) for checks, conventions and limits.

## Programs

`programs/v1-core` is the real-money Anchor program from whitepaper v1.1: funds, shares, trade checks, crew votes and fees on Solana. The v0 paper app above does not call it. See [programs/v1-core/README.md](./programs/v1-core/README.md).

```sh
scripts/build-programs.sh   # never bare cargo build-sbf
cargo test -p v1-core
```

## Local development

Privy authentication is available through `POST /v0/auth/privy`. Configure
`PRIVY_APP_ID` to use Privy tokens; public verification keys are fetched automatically
across protected endpoints. See [Privy setup and API flow](docs/privy-auth.md).

Requires Node.js 22+ and pnpm 10.

```sh
pnpm install
pnpm dev
```

The API defaults to `http://localhost:3000`. `GET /health` returns `{ "status": "ok", "mode": "PAPER" }`. Set `PORT` to use another port.

Open **http://localhost:3000/admin/logs** for live API, worker, and ingestor logs with service/severity/time filters, search, structured details, and JSON export. Set the same `REDIS_URL` for all three services. Remote/production access requires `ADMIN_LOGS_TOKEN`. See [service log setup and access controls](docs/admin-logs.md).

```sh
pnpm check-types
pnpm build
```

To run the backend simulations without a Pyth key, start local PostgreSQL and run:

```sh
TEST_DATABASE_URL=postgres://socially:socially@127.0.0.1:5432/socially_trade pnpm test:backend
```

Each run creates and removes its own database schema, uses synthetic SOL prices, and blocks external HTTP requests. The scenarios and findings are documented in [the simulation report](./docs/backend-simulation-report.md).

For local backend development, start PostgreSQL with `docker compose up -d postgres`, set `DATABASE_URL` from `.env.example`, and run `pnpm --filter @socially/db migrate`. Privy is the only authentication provider in every environment. Set `PRIVY_APP_ID`, and send the Privy access token in the Authorization bearer header. Public verification keys are fetched automatically. See [Privy setup](docs/privy-auth.md).

Available endpoints:

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` | Process health and paper mode |
| GET | `/v0/me` | Create/read the authenticated paper account and its one-time virtual allowance |
| GET | `/v0/me/paper-balance` | Available virtual USDC |
| GET | `/v0/me/paper-positions` | Crew fund shares and estimated value |
| POST | `/v0/captains` | Create a Captain profile |
| GET | `/v0/captains/:captainId` | Public Captain profile |
| POST | `/v0/funds` | Start a Captain's paper fund; requires `Idempotency-Key` |
| GET | `/v0/funds` | Discover paper funds |
| GET | `/v0/funds/:fundId` | Paper fund summary |
| GET | `/v0/funds/:fundId/policy` | Current fund limits |
| GET | `/v0/funds/:fundId/holdings` | Virtual cash and positions |
| POST | `/v0/funds/:fundId/joins` | Join with `{ "amountUsdc": "100.000000" }`; requires `Idempotency-Key` |
| POST | `/v0/funds/:fundId/exits` | Leave by burning `{ "shares": "10" }`; requires `Idempotency-Key` |
| POST | `/v0/funds/:fundId/orders/preview` | Captain's estimated paper fill and policy result |
| POST | `/v0/funds/:fundId/orders` | Submit a pending paper order; requires `Idempotency-Key` |
| GET | `/v0/funds/:fundId/orders` | Public order history |
| GET | `/v0/funds/:fundId/orders/:orderId` | Order status, fill, or rejection |
| POST | `/v0/funds/:fundId/orders/:orderId/cancel` | Captain cancels an unprocessed order |
| GET | `/v0/funds/:fundId/events?after=0` | Fund activity after an event sequence |
| GET | `/v0/funds/:fundId/events/stream?after=0` | Live server-sent fund events; resume with `after` or `Last-Event-ID` |
| GET | `/v0/funds/:fundId/messages?after=0` | Visible fund chat and Captain notes in sequence order |
| POST | `/v0/funds/:fundId/messages` | Captain or current Crew member posts chat; requires `Idempotency-Key` |
| GET | `/v0/funds/:fundId/decisions?after=0` | Captain order notes and corrections |
| POST | `/v0/funds/:fundId/orders/:orderId/notes` | Captain posts an order note or append-only correction; requires `Idempotency-Key` |
| GET | `/v0/me/notifications?after=0` | Durable in-app alerts for the signed-in user |
| POST | `/v0/me/notifications/:notificationId/read` | Mark an in-app alert read |

`POST /v0/funds` requires a Captain profile and takes `{ "name": "Fund name", "description": "Optional strategy" }`. The server seeds it with 1,000 virtual USDC and a 30-day trial. Financial amounts are JSON decimal strings.

The separate Jupiter ingestor polls SOL and USDC every five seconds, records observations in PostgreSQL, and publishes snapshots/replay events through Redis to `GET /v0/ws`. Configure the Jupiter keys, organisation ID, Redis and Solana RPC, migrate through 011, and run the ingestor alongside the API and paper worker. See [setup, architecture and WebSocket contracts](docs/jupiter-market-stream-v0.md). For a local-only observation, set `DEV_PRICE_SEED_ENABLED=true` and run `pnpm --filter @socially/worker price:seed -- 150.00`. The published assumptions are in [the v0 fill model](./docs/v0-fill-model.md).

The worker also delivers fund outbox records to each current Captain and Crew member's in-app inbox. Run `pnpm --filter @socially/worker notifications:once` to deliver one batch. External push delivery is not configured yet.

To process orders with local seeded prices, keep `DEV_PRICE_SEED_ENABLED=true`, start the worker with `pnpm --filter @socially/worker start`, submit a Captain order, then seed a fresh price after submission. The worker waits at least three seconds and uses the latest eligible price observation. `pnpm --filter @socially/worker orders:once` processes eligible work once.

All v0 financial values are virtual. The current API does not accept orders or hold assets.

### Devnet token layer

With `USDG_MINT` set, money in and out uses one SPL test token on Solana devnet, "USDG (devnet)" (6 decimals, we hold the mint authority). Signup mints the grant to the user's wallet, deposits are user-signed transfers to the treasury that the backend verifies before it credits paper cash or joins a fund, and withdrawals send tokens from the treasury. Trading stays paper. Create the mint and treasury with `node apps/api/scripts/devnet-setup.mjs`. See [the devnet token layer](docs/devnet-token-layer.md) for flows, endpoints, env vars and the app integration.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/v0/me/token-balance` | On-chain USDG (devnet) balance plus paper balances |
| POST | `/v0/me/deposits/prepare` | Fee-paid transfer transaction for the wallet to sign |
| POST | `/v0/me/deposits` | Claim a deposit by signature; optional `fundId` joins a fund |
| GET | `/v0/me/deposits/:signature` | Deposit state (`PENDING`, `CONFIRMED`, `FAILED`, `EXPIRED`) |
| POST | `/v0/me/withdrawals` | Withdraw paper cash or a fund exit payout; requires `Idempotency-Key` |
| GET | `/v0/me/withdrawals/:withdrawalId` | Withdrawal state and signature |
## Knowledge graph

See [Graphify setup and refresh instructions](docs/graphify.md) for the backend,
database, architecture and whitepaper knowledge graph in `graphify-out/`.
