# socially.trade

Paper trading is the first implementation of the Captain and Crew experience described in the [whitepaper](./socially-trade-whitepaper.pdf). The planned live product will use separate onchain funds and records.

## Current state

Phases 0 and 1 establish a pnpm/Turborepo workspace, a small TypeScript API with `GET /health`, shared contracts, decimal math, and a PostgreSQL schema. Product flows, market data, and the mobile app are scheduled in [the implementation phases](./docs/v0-implementation-phases.md). The detailed design is in [the v0 architecture](./docs/v0-paper-trading-architecture.md).

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

Set `DATABASE_URL` and run `pnpm --filter @socially/db migrate` to apply the schema. PostgreSQL is required for the upcoming fund and trading endpoints.

All v0 financial values are virtual. The current API does not accept orders or hold assets.
