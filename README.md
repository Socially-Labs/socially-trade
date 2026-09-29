# socially.trade

Paper trading is the first implementation of the Captain and Crew experience described in the [whitepaper](./socially-trade-whitepaper.pdf). The planned live product will use separate onchain funds and records.

## Current state

Phases 0-2 establish a pnpm/Turborepo workspace, shared contracts, decimal math, PostgreSQL schema, and authenticated Captain/fund endpoints. Crew accounting, market data, and the mobile app are scheduled in [the implementation phases](./docs/v0-implementation-phases.md). The detailed design is in [the v0 architecture](./docs/v0-paper-trading-architecture.md).

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
| POST | `/v0/captains` | Create a Captain profile |
| GET | `/v0/captains/:captainId` | Public Captain profile |
| POST | `/v0/funds` | Start a Captain's paper fund; requires `Idempotency-Key` |
| GET | `/v0/funds` | Discover paper funds |
| GET | `/v0/funds/:fundId` | Paper fund summary |
| GET | `/v0/funds/:fundId/events?after=0` | Fund activity after an event sequence |

`POST /v0/funds` requires a Captain profile and takes `{ "name": "Fund name", "description": "Optional strategy" }`. The server seeds it with 1,000 virtual USDC and a 30-day trial. Financial amounts are JSON decimal strings.

All v0 financial values are virtual. The current API does not accept orders or hold assets.
