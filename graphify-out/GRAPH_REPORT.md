# Graph Report - Socially Trade  (2026-10-01)

## Corpus Check
- Corpus is ~29,555 words - fits in a single context window. You may not need a graph.

## Summary
- 537 nodes · 859 edges · 42 communities (29 shown, 6 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 12 edges (avg confidence: 0.85)
- Token usage: unknown for agent-assisted semantic extraction (interface does not expose counts); structural AST extraction uses no LLM tokens.

## Community Hubs (Navigation)
- API Accounts and Funds
- Proposed Paper Architecture
- Worker Fund Lifecycle
- Recorded Simulation Coverage
- API Package Dependencies
- Worker Package Dependencies
- Database Package Dependencies
- Financial Domain Rules
- Market Data Package
- Root Workspace Tooling
- Domain Package Dependencies
- Database Transactions and Ledger
- Contracts Package
- Turborepo Task Configuration
- Shared TypeScript Configuration
- Account and Fund Schema
- API Shared Contracts
- Graphify Project Guidance
- Published Fill Model
- Database TypeScript Build
- Market Data TypeScript Build
- Backend Simulation Helpers
- API TypeScript Build
- Worker TypeScript Build
- Contracts TypeScript Build
- Domain TypeScript Build
- Price Observations and Fills
- Local PostgreSQL Infrastructure
- Development Price Seed
- Workspace Package Discovery
- Fee Assessment Schema
- Fund Message Schema
- NAV Snapshot Schema
- Observed NAV Records
- NAV Performance Columns

## God Nodes (most connected - your core abstractions)
1. `ApiFault` - 43 edges
2. `Whitepaper v1.0: proposed live socially.trade product` - 30 edges
3. `v0 paper trading architecture: implementation proposal` - 24 edges
4. `README: implemented backend and local development` - 17 edges
5. `requireActor()` - 14 edges
6. `Backend simulation report: recorded checks on October 1, 2026` - 14 edges
7. `Phased v0 delivery plan and recorded backend checkpoints` - 13 edges
8. `Amount` - 12 edges
9. `registerFundRoutes()` - 11 edges
10. `getFund()` - 11 edges

## Surprising Connections (you probably didn't know these)
- `Proposed NAV-based Crew join and leave` --semantically_similar_to--> `Planned live share issuance and redemption at NAV`  [INFERRED] [semantically similar]
  docs/v0-paper-trading-architecture.md → socially-trade-whitepaper.pdf
- `Proposed one active fixed 30-day Captain trial` --semantically_similar_to--> `Planned Captain qualification: 30-day simulated sea trial`  [INFERRED] [semantically similar]
  docs/v0-paper-trading-architecture.md → socially-trade-whitepaper.pdf
- `Proposed fund chat and append-only Captain decision corrections` --semantically_similar_to--> `Planned public Captain decision log linked to trades`  [INFERRED] [semantically similar]
  docs/v0-paper-trading-architecture.md → socially-trade-whitepaper.pdf
- `Proposed 10% high-water-mark fee with 80/20 minted shares` --semantically_similar_to--> `Planned 10% performance fee above post-fee high-water mark`  [INFERRED] [semantically similar]
  docs/v0-paper-trading-architecture.md → socially-trade-whitepaper.pdf
- `Phased v0 delivery plan and recorded backend checkpoints` --references--> `Whitepaper v1.0: proposed live socially.trade product`  [EXTRACTED]
  docs/v0-implementation-phases.md → socially-trade-whitepaper.pdf

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Proposed atomic paper execution** — docs_v0_paper_trading_architecture_orders, docs_v0_paper_trading_architecture_ledger, docs_v0_paper_trading_architecture_outbox, docs_v0_paper_trading_architecture_projections [EXTRACTED 1.00]
- **Planned live fund integrity mechanisms** — socially_trade_whitepaper_fund_vault, socially_trade_whitepaper_delegates, socially_trade_whitepaper_policy, socially_trade_whitepaper_profile [EXTRACTED 1.00]

## Communities (42 total, 6 thin omitted)

### Community 0 - "API Accounts and Funds"
Cohesion: 0.09
Nodes (61): registerAccountRoutes(), beginIdempotent(), finishIdempotent(), PositionValue, saveNav(), Valuation, valueFund(), createApp() (+53 more)

### Community 1 - "Proposed Paper Architecture"
Cohesion: 0.07
Nodes (50): Proposed server-derived identity and fund ownership authorization, Proposed fixed virtual allowance and Captain seed, Proposed decimal money arithmetic and explicit rounding, v0 paper trading architecture: implementation proposal, Proposed 10% high-water-mark fee with 80/20 minted shares, Proposed append-only balanced ledger and immutable fund events, Proposed separate live Solana transaction and indexer write path, Proposed future React Native/Expo client (+42 more)

### Community 2 - "Worker Fund Lifecycle"
Cohesion: 0.10
Nodes (29): runWorkerCycle(), assessDailyFees(), assessFundFee(), eligibleFundBatches(), FundJob, pool, deliverOne(), deliverOutbox() (+21 more)

### Community 3 - "Recorded Simulation Coverage"
Cohesion: 0.09
Nodes (37): Verified per-asset ledger and projection reconciliation, Verified JWT signature, issuer, audience, expiration and private records, Verified 101-fund valuation, fee and expiration sweeps, Verified retries, rollback, mixed mutation races and exactly-once effects, Backend simulation report: recorded checks on October 1, 2026, Verified 10% high-water-mark fees and 80/20 minted shares, Verified localhost-only disposable schemas and synthetic market data, Untested external integrations and long-duration production operation (+29 more)

### Community 4 - "API Package Dependencies"
Cohesion: 0.06
Nodes (32): dependencies, decimal.js, fastify, jose, pg, @socially/contracts, @socially/db, @socially/domain (+24 more)

### Community 5 - "Worker Package Dependencies"
Cohesion: 0.07
Nodes (27): dependencies, @socially/db, @socially/domain, @socially/market-data, devDependencies, tsx, @types/node, typescript (+19 more)

### Community 6 - "Database Package Dependencies"
Cohesion: 0.09
Nodes (21): dependencies, pg, devDependencies, tsx, @types/node, @types/pg, typescript, exports (+13 more)

### Community 7 - "Financial Domain Rules"
Cohesion: 0.24
Nodes (17): calculatePerformanceFee(), PERFORMANCE_FEE_MODEL_VERSION, Amount, fixed(), fixedUp(), MAX_PRICE_AGE_MS, MAX_SIMULATED_ORDER_USDC, parsePositiveAmount() (+9 more)

### Community 8 - "Market Data Package"
Cohesion: 0.12
Nodes (16): dependencies, @socially/domain, devDependencies, @types/node, typescript, exports, @socially/domain, @types/node (+8 more)

### Community 9 - "Root Workspace Tooling"
Cohesion: 0.12
Nodes (15): devDependencies, turbo, typescript, engines, node, typescript, name, packageManager (+7 more)

### Community 10 - "Domain Package Dependencies"
Cohesion: 0.13
Nodes (14): dependencies, decimal.js, devDependencies, typescript, exports, decimal.js, typescript, name (+6 more)

### Community 11 - "Database Transactions and Ledger"
Cohesion: 0.23
Nodes (9): appendFundEvent(), createPool(), DbClient, DbPool, inTransaction(), ledgerAccountId(), directory, pool (+1 more)

### Community 12 - "Contracts Package"
Cohesion: 0.17
Nodes (11): devDependencies, typescript, exports, typescript, name, private, scripts, build (+3 more)

### Community 13 - "Turborepo Task Configuration"
Cohesion: 0.17
Nodes (11): dependsOn, outputs, dependsOn, outputs, cache, persistent, $schema, tasks (+3 more)

### Community 14 - "Shared TypeScript Configuration"
Cohesion: 0.18
Nodes (10): compilerOptions, esModuleInterop, forceConsistentCasingInFileNames, module, moduleResolution, noUncheckedIndexedAccess, resolveJsonModule, skipLibCheck (+2 more)

### Community 15 - "Account and Fund Schema"
Cohesion: 0.27
Nodes (7): outbox_events, captain_profiles, funds, instruments, users, api_idempotency, notifications

### Community 16 - "API Shared Contracts"
Cohesion: 0.20
Nodes (9): ApiError, FundMode, FundStatus, FundSummary, OrderSide, OrderStatus, PAPER_MODE, PaperAmount (+1 more)

### Community 17 - "Graphify Project Guidance"
Cohesion: 0.22
Nodes (9): Repository agent guidance, Graphify knowledge graph navigation and incremental refresh rules, Read installed Turborepo bundled docs before changing commands or config, Semantic extraction token usage is unknown; no API key required, Graphify project setup and refresh guide, Graphify excludes credentials, generated dependencies and unrelated résumé, AST updates are local; changed documents require semantic extraction, Graphify covers backend symbols, SQL migrations, docs and whitepaper (+1 more)

### Community 18 - "Published Fill Model"
Cohesion: 0.39
Nodes (9): Simulated mark-based fill does not establish live Jupiter liquidity, Published delayed order execution using fresh observations and policy recheck, DEV_SEED observations restricted to local development, Published simulated SOL/USDC fill model version 1, Published observation limits: age 90s, future 5s, confidence 1%, Published spot-only order cap: 10% NAV and 1000 virtual USDC, Published fill costs: 20bps spread, 10bps fee, size impact, Published SOL 9 decimals and USDC 6 decimals with conservative rounding (+1 more)

### Community 19 - "Database TypeScript Build"
Cohesion: 0.22
Nodes (8): compilerOptions, declaration, outDir, rootDir, types, extends, include, ../../tsconfig.base.json

### Community 20 - "Market Data TypeScript Build"
Cohesion: 0.22
Nodes (8): compilerOptions, declaration, outDir, rootDir, types, extends, include, ../../tsconfig.base.json

### Community 21 - "Backend Simulation Helpers"
Cohesion: 0.39
Nodes (5): ageOrder(), order(), request(), seed(), settled()

### Community 22 - "API TypeScript Build"
Cohesion: 0.25
Nodes (7): compilerOptions, outDir, rootDir, types, extends, include, ../../tsconfig.base.json

### Community 23 - "Worker TypeScript Build"
Cohesion: 0.25
Nodes (7): compilerOptions, outDir, rootDir, types, extends, include, ../../tsconfig.base.json

### Community 24 - "Contracts TypeScript Build"
Cohesion: 0.25
Nodes (7): compilerOptions, declaration, outDir, rootDir, extends, include, ../../tsconfig.base.json

### Community 25 - "Domain TypeScript Build"
Cohesion: 0.25
Nodes (7): compilerOptions, declaration, outDir, rootDir, extends, include, ../../tsconfig.base.json

### Community 26 - "Price Observations and Fills"
Cohesion: 0.29
Nodes (4): FILL_MODEL_VERSION, PriceObservation, SimulatedFill, SOL_USD_FEED_ID

### Community 27 - "Local PostgreSQL Infrastructure"
Cohesion: 0.83
Nodes (4): Local Docker Compose PostgreSQL service, Configured pg_isready database health check, Configured PostgreSQL 17 Alpine at localhost port 5432, Configured persistent socially-postgres Docker volume

### Community 30 - "Workspace Package Discovery"
Cohesion: 0.67
Nodes (3): Workspace apps/* packages, pnpm workspace globs, Workspace packages/* packages

## Knowledge Gaps
- **238 isolated node(s):** `name`, `version`, `private`, `type`, `dev` (+233 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 266 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **6 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `fastify` connect `API Accounts and Funds` to `API Package Dependencies`?**
  _High betweenness centrality (0.017) - this node is a cross-community bridge._
- **Why does `README: implemented backend and local development` connect `Recorded Simulation Coverage` to `Proposed Paper Architecture`, `Published Fill Model`?**
  _High betweenness centrality (0.016) - this node is a cross-community bridge._
- **Why does `Whitepaper v1.0: proposed live socially.trade product` connect `Proposed Paper Architecture` to `Recorded Simulation Coverage`?**
  _High betweenness centrality (0.014) - this node is a cross-community bridge._
- **What connects `name`, `version`, `private` to the rest of the system?**
  _238 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `API Accounts and Funds` be split into smaller, more focused modules?**
  _Cohesion score 0.08639240506329114 - nodes in this community are weakly interconnected._
- **Should `Proposed Paper Architecture` be split into smaller, more focused modules?**
  _Cohesion score 0.07428571428571429 - nodes in this community are weakly interconnected._
- **Should `Worker Fund Lifecycle` be split into smaller, more focused modules?**
  _Cohesion score 0.10365853658536585 - nodes in this community are weakly interconnected._
## Extraction integrity limitations

Raw extractor output contained 219 edges with dangling endpoints and 17 edges sharing endpoints in the undirected graph. These are Graphify extraction/build limitations; missing links must not be interpreted as absence of a dependency. No missing endpoint fields or self-loops were reported. Inspect source before relying on graph completeness.
