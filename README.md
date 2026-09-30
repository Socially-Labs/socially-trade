# socially.trade

Paper trading is the first implementation of the Captain and Crew experience described in the [whitepaper](./socially-trade-whitepaper.pdf). The planned live product will use separate onchain funds and records.

## Current state

Phases 0-5 establish the paper backend: accounts, Captain funds, Crew shares, SOL/USD price observations, order endpoints, and an order-processing worker. The mobile app and social record are scheduled in [the implementation phases](./docs/v0-implementation-phases.md). The detailed design is in [the v0 architecture](./docs/v0-paper-trading-architecture.md).

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

`POST /v0/funds` requires a Captain profile and takes `{ "name": "Fund name", "description": "Optional strategy" }`. The server seeds it with 1,000 virtual USDC and a 30-day trial. Financial amounts are JSON decimal strings.

The market-data worker requires a Pyth API key: set `PYTH_API_KEY` and run `pnpm --filter @socially/worker price:once` or `pnpm --filter @socially/worker start` after building. For a local-only observation, set `DEV_PRICE_SEED_ENABLED=true` and run `pnpm --filter @socially/worker price:seed -- 150.00`. The published assumptions are in [the v0 fill model](./docs/v0-fill-model.md).

To process orders with local seeded prices, keep `DEV_PRICE_SEED_ENABLED=true`, start the worker with `pnpm --filter @socially/worker start`, submit a Captain order, then seed a fresh price after submission. The worker waits at least three seconds and uses the first eligible price observation. `pnpm --filter @socially/worker orders:once` processes eligible work once.

All v0 financial values are virtual. The current API does not accept orders or hold assets.
