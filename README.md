# socially.trade

Paper trading is the first implementation of the Captain and Crew experience described in the [whitepaper](./socially-trade-whitepaper.pdf). The planned live product will use separate onchain funds and records.

## Current state

Phases 0-5 establish the paper backend: accounts, Captain funds, Crew shares, SOL/USD price observations, order endpoints, and an order-processing worker. Backend checkpoints add a resumable event stream, fund chat, Captain order notes, an in-app inbox, performance records, simulated fees, and trial settlement. The mobile app, external push delivery, risk-adjusted rankings, and operational hardening remain in [the implementation phases](./docs/v0-implementation-phases.md). The detailed design is in [the v0 architecture](./docs/v0-paper-trading-architecture.md).

The current delivery is backend only, as requested. Verification uses API calls, PostgreSQL simulations and test cases; no frontend or Android application is included.

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

Requires Node.js 22+ and pnpm 10.

```sh
pnpm install
pnpm dev
```

The API defaults to `http://localhost:3000`. `GET /health` returns `{ "status": "ok", "mode": "PAPER" }`. Set `PORT` to use another port.

```sh
pnpm check-types
pnpm build
```

To run the backend simulations without a Pyth key, start local PostgreSQL and run:

```sh
TEST_DATABASE_URL=postgres://socially:socially@127.0.0.1:5432/socially_trade pnpm test:backend
```

Each run creates and removes its own database schema, uses synthetic SOL prices, and blocks external HTTP requests. The scenarios and findings are documented in [the simulation report](./docs/backend-simulation-report.md).

For local backend development, start PostgreSQL with `docker compose up -d postgres`, set `DATABASE_URL` from `.env.example`, and run `pnpm --filter @socially/db migrate`. Set a long random `DEV_AUTH_TOKEN`; development requests use `Authorization: Bearer <token>` and `X-Dev-Subject: dev:alice`. This development identity is disabled when `NODE_ENV=production`. Production requests require `AUTH_JWKS_URL`, `AUTH_ISSUER`, and `AUTH_AUDIENCE` for JWT verification.

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

The market-data worker requires a Pyth API key: set `PYTH_API_KEY` and run `pnpm --filter @socially/worker price:once` or `pnpm --filter @socially/worker start` after building. For a local-only observation, set `DEV_PRICE_SEED_ENABLED=true` and run `pnpm --filter @socially/worker price:seed -- 150.00`. The published assumptions are in [the v0 fill model](./docs/v0-fill-model.md).

The worker also delivers fund outbox records to each current Captain and Crew member's in-app inbox. Run `pnpm --filter @socially/worker notifications:once` to deliver one batch. External push delivery is not configured yet.

To process orders with local seeded prices, keep `DEV_PRICE_SEED_ENABLED=true`, start the worker with `pnpm --filter @socially/worker start`, submit a Captain order, then seed a fresh price after submission. The worker waits at least three seconds and uses the latest eligible price observation. `pnpm --filter @socially/worker orders:once` processes eligible work once.

All v0 financial values are virtual. The current API does not accept orders or hold assets.
## Knowledge graph

See [Graphify setup and refresh instructions](docs/graphify.md) for the backend,
database, architecture and whitepaper knowledge graph in `graphify-out/`.
