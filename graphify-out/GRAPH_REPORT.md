# Graph Report - Socially Trade  (2026-10-04)

## Corpus Check
- 142 files · ~81,145 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1561 nodes · 3757 edges · 99 communities (77 shown, 10 thin omitted)
- Extraction: 82% EXTRACTED · 18% INFERRED · 0% AMBIGUOUS · INFERRED: 694 edges (avg confidence: 0.85)
- Token cost: this AST refresh used no LLM; prior semantic extraction usage is unknown.

## Graph Freshness
- Built from commit: `7cc4998e`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- ApiFault
- Trade
- worker/src/orders.ts
- Backend simulation report: recorded checks on October 1, 2026
- api/package.json
- worker/package.json
- db/package.json
- domain/src/index.ts
- market-data/package.json
- package.json
- domain/package.json
- db/src/index.ts
- contracts/package.json
- tasks
- compilerOptions
- 001_paper_core.sql
- contracts/src/index.ts
- Graphify project setup and refresh guide
- v0 UI API integration specification
- compilerOptions
- compilerOptions
- backend-simulation.test.mjs
- api/tsconfig.json
- worker/tsconfig.json
- contracts/tsconfig.json
- domain/tsconfig.json
- market-data/src/index.ts
- Local Docker Compose PostgreSQL service
- seed-price.ts
- pnpm workspace globs
- fee_assessments
- messages
- nav_snapshots
- nav_snapshots
- nav_snapshots
- common/mod.rs
- fund_with_member
- expect_err
- math.rs
- Phased v0 delivery plan and recorded backend checkpoints
- v1-core/src/lib.rs
- warp
- test_vote.rs
- Fund
- Whitepaper v1.0: proposed live socially.trade product
- CreateFund
- Captain flow — v0 developer handoff
- Deposit
- ChargeAnnualFee
- 7. Paper orders and trade history
- Privy backend authentication
- events.rs
- compute
- Published simulated SOL/USDC fill model version 1
- README: implemented backend and local development
- swap
- Jupiter ingestion and WebSocket integration — v0
- v1-core
- 6. Funds and Crew allocation
- test_exit.rs
- ui-api-spec-v0.md
- Q: Which Solana Agent Kit integrations can make Socially Trade more useful?
- build-programs.sh
- mock-venue
- v1-core
- 5. Accounts and Captain onboarding
- 8. Performance, charts and records
- 9. Fund activity, chat and decision log
- 12. Recommended screen flows
- 2. Shared conventions
- setup
- 010_captain_handle_index.sql
- ingestor/package.json
- Captain handle availability and Redis Bloom index
- ix_add_delegate
- funded_user
- market-stream/package.json
- ingestor/src/index.ts
- Captain profile and banner assets
- Env
- market-stream/src/index.ts
- CaptainHandleIndex
- compilerOptions
- WriteLog
- ingestor/tsconfig.json
- 10. Personal inbox
- price_observations

## God Nodes (most connected - your core abstractions)
1. `expect_err()` - 99 edges
2. `Env` - 61 edges
3. `ApiFault` - 53 edges
4. `trading_fund()` - 53 edges
5. `FundHandles` - 51 edges
6. `fund_with_member()` - 46 edges
7. `deposit()` - 43 edges
8. `warp()` - 37 edges
9. `buy_sol()` - 37 edges
10. `funded_user()` - 35 edges

## Surprising Connections (you probably didn't know these)
- `Proposed 10% high-water-mark fee with 80/20 minted shares` --semantically_similar_to--> `Planned 10% performance fee above post-fee high-water mark`  [INFERRED] [semantically similar]
  docs/v0-paper-trading-architecture.md → socially-trade-whitepaper.pdf
- `Proposed NAV-based Crew join and leave` --semantically_similar_to--> `Planned live share issuance and redemption at NAV`  [INFERRED] [semantically similar]
  docs/v0-paper-trading-architecture.md → socially-trade-whitepaper.pdf
- `Proposed fund chat and append-only Captain decision corrections` --semantically_similar_to--> `Planned public Captain decision log linked to trades`  [INFERRED] [semantically similar]
  docs/v0-paper-trading-architecture.md → socially-trade-whitepaper.pdf
- `Proposed one active fixed 30-day Captain trial` --semantically_similar_to--> `Planned Captain qualification: 30-day simulated sea trial`  [INFERRED] [semantically similar]
  docs/v0-paper-trading-architecture.md → socially-trade-whitepaper.pdf
- `Implemented development token and production JWKS JWT adapters` --semantically_similar_to--> `Verified JWT signature, issuer, audience, expiration and private records`  [INFERRED] [semantically similar]
  README.md → docs/backend-simulation-report.md

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Proposed atomic paper execution** — docs_v0_paper_trading_architecture_orders, docs_v0_paper_trading_architecture_ledger, docs_v0_paper_trading_architecture_outbox, docs_v0_paper_trading_architecture_projections [EXTRACTED 1.00]
- **Planned live fund integrity mechanisms** — socially_trade_whitepaper_fund_vault, socially_trade_whitepaper_delegates, socially_trade_whitepaper_policy, socially_trade_whitepaper_profile [EXTRACTED 1.00]

## Communities (99 total, 10 thin omitted)

### Community 0 - "ApiFault"
Cohesion: 0.07
Nodes (77): registerAccountRoutes(), beginIdempotent(), finishIdempotent(), PositionValue, saveNav(), Valuation, valueFund(), createApp() (+69 more)

### Community 1 - "Trade"
Cohesion: 0.06
Nodes (75): add_delegate(), AddDelegate, charge_delegate(), code(), d(), daily_limit_and_reset(), day_volume_overflow_is_math_overflow(), per_trade_limit() (+67 more)

### Community 2 - "worker/src/orders.ts"
Cohesion: 0.12
Nodes (27): runWorkerCycle(), assessDailyFees(), assessFundFee(), eligibleFundBatches(), FundJob, pool, deliverOne(), deliverOutbox() (+19 more)

### Community 3 - "Backend simulation report: recorded checks on October 1, 2026"
Cohesion: 0.27
Nodes (13): Verified per-asset ledger and projection reconciliation, Verified JWT signature, issuer, audience, expiration and private records, Verified 101-fund valuation, fee and expiration sweeps, Verified retries, rollback, mixed mutation races and exactly-once effects, Backend simulation report: recorded checks on October 1, 2026, Verified 10% high-water-mark fees and 80/20 minted shares, Verified localhost-only disposable schemas and synthetic market data, Untested external integrations and long-duration production operation (+5 more)

### Community 4 - "api/package.json"
Cohesion: 0.05
Nodes (40): dependencies, decimal.js, fastify, @fastify/websocket, ioredis, jose, pg, @socially/contracts (+32 more)

### Community 5 - "worker/package.json"
Cohesion: 0.07
Nodes (26): dependencies, @socially/db, @socially/domain, @socially/market-data, devDependencies, tsx, @types/node, typescript (+18 more)

### Community 6 - "db/package.json"
Cohesion: 0.09
Nodes (21): dependencies, pg, devDependencies, tsx, @types/node, @types/pg, typescript, exports (+13 more)

### Community 7 - "domain/src/index.ts"
Cohesion: 0.24
Nodes (17): calculatePerformanceFee(), PERFORMANCE_FEE_MODEL_VERSION, Amount, fixed(), fixedUp(), MAX_PRICE_AGE_MS, MAX_SIMULATED_ORDER_USDC, parsePositiveAmount() (+9 more)

### Community 8 - "market-data/package.json"
Cohesion: 0.12
Nodes (16): dependencies, @socially/domain, devDependencies, @types/node, typescript, exports, @socially/domain, @types/node (+8 more)

### Community 9 - "package.json"
Cohesion: 0.12
Nodes (15): devDependencies, turbo, typescript, engines, node, typescript, name, packageManager (+7 more)

### Community 10 - "domain/package.json"
Cohesion: 0.13
Nodes (14): dependencies, decimal.js, devDependencies, typescript, exports, decimal.js, typescript, name (+6 more)

### Community 11 - "db/src/index.ts"
Cohesion: 0.23
Nodes (9): appendFundEvent(), createPool(), DbClient, DbPool, inTransaction(), ledgerAccountId(), directory, pool (+1 more)

### Community 12 - "contracts/package.json"
Cohesion: 0.17
Nodes (11): devDependencies, typescript, exports, typescript, name, private, scripts, build (+3 more)

### Community 13 - "tasks"
Cohesion: 0.17
Nodes (11): dependsOn, outputs, dependsOn, outputs, cache, persistent, $schema, tasks (+3 more)

### Community 14 - "compilerOptions"
Cohesion: 0.18
Nodes (10): compilerOptions, esModuleInterop, forceConsistentCasingInFileNames, module, moduleResolution, noUncheckedIndexedAccess, resolveJsonModule, skipLibCheck (+2 more)

### Community 15 - "001_paper_core.sql"
Cohesion: 0.20
Nodes (10): outbox_events, captain_profiles, funds, instruments, users, api_idempotency, notifications, market_events (+2 more)

### Community 16 - "contracts/src/index.ts"
Cohesion: 0.20
Nodes (9): ApiError, FundMode, FundStatus, FundSummary, OrderSide, OrderStatus, PAPER_MODE, PaperAmount (+1 more)

### Community 17 - "Graphify project setup and refresh guide"
Cohesion: 0.22
Nodes (9): Repository agent guidance, Graphify knowledge graph navigation and incremental refresh rules, Read installed Turborepo bundled docs before changing commands or config, Semantic extraction token usage is unknown; no API key required, Graphify project setup and refresh guide, Graphify excludes credentials, generated dependencies and unrelated résumé, AST updates are local; changed documents require semantic extraction, Graphify covers backend symbols, SQL migrations, docs and whitepaper (+1 more)

### Community 18 - "v0 UI API integration specification"
Cohesion: 0.20
Nodes (10): 11. Errors and recovery, 13. Current integration gaps, 13. Jupiter market snapshot and WebSocket delivery, 14. Captain profile images and edits, 14. Source map and maintenance, 1. Connection and authentication, 3. Endpoint inventory, 4. Response models (+2 more)

### Community 19 - "compilerOptions"
Cohesion: 0.22
Nodes (8): compilerOptions, declaration, outDir, rootDir, types, extends, include, ../../tsconfig.base.json

### Community 20 - "compilerOptions"
Cohesion: 0.22
Nodes (8): compilerOptions, declaration, outDir, rootDir, types, extends, include, ../../tsconfig.base.json

### Community 21 - "backend-simulation.test.mjs"
Cohesion: 0.24
Nodes (8): ageOrder(), order(), request(), seed(), settled(), all(), get(), configurePrivyFixture()

### Community 22 - "api/tsconfig.json"
Cohesion: 0.25
Nodes (7): compilerOptions, outDir, rootDir, types, extends, include, ../../tsconfig.base.json

### Community 23 - "worker/tsconfig.json"
Cohesion: 0.25
Nodes (7): compilerOptions, outDir, rootDir, types, extends, include, ../../tsconfig.base.json

### Community 24 - "contracts/tsconfig.json"
Cohesion: 0.25
Nodes (7): compilerOptions, declaration, outDir, rootDir, extends, include, ../../tsconfig.base.json

### Community 25 - "domain/tsconfig.json"
Cohesion: 0.25
Nodes (7): compilerOptions, declaration, outDir, rootDir, extends, include, ../../tsconfig.base.json

### Community 26 - "market-data/src/index.ts"
Cohesion: 0.20
Nodes (10): FILL_MODEL_VERSION, PriceObservation, SimulatedFill, SOL_USD_FEED_ID, blockTime(), fetchJupiterPrices(), JupiterHttpError, JupiterPrice (+2 more)

### Community 27 - "Local Docker Compose PostgreSQL service"
Cohesion: 0.83
Nodes (4): Local Docker Compose PostgreSQL service, Configured pg_isready database health check, Configured PostgreSQL 17 Alpine at localhost port 5432, Configured persistent socially-postgres Docker volume

### Community 30 - "pnpm workspace globs"
Cohesion: 0.67
Nodes (3): Workspace apps/* packages, pnpm workspace globs, Workspace packages/* packages

### Community 42 - "common/mod.rs"
Cohesion: 0.13
Nodes (47): InstructionData, LiteSVM, config_pda(), custom_code(), fund_pda(), ix_apply_policy(), ix_apply_venue(), ix_cancel_proposal() (+39 more)

### Community 43 - "fund_with_member"
Cohesion: 0.17
Nodes (37): deposit(), fund_with_member(), inject_holding(), ix_deposit(), listed_sol(), now(), price_account(), read_fund() (+29 more)

### Community 44 - "expect_err"
Cohesion: 0.11
Nodes (68): ata(), expect_err(), ix_swap(), register_token(), set_usd_price(), setup_venue_pool(), Trading, trading_fund() (+60 more)

### Community 45 - "math.rs"
Cohesion: 0.05
Nodes (32): ErrorCode, bps_of(), fee_below_one_share_keeps_hwm(), fee_whitepaper_priya(), fee_with_zero_pps_gives_zero_fee_shares(), FeeOutcome, mul_div_floor(), no_fee_at_hwm() (+24 more)

### Community 46 - "Phased v0 delivery plan and recorded backend checkpoints"
Cohesion: 0.18
Nodes (11): Recorded implemented accounts, shares, execution and social backend checkpoints, Future Phase 6 mobile Captain and Crew flows, Phase-scoped reviewable commits on main, Phased v0 delivery plan and recorded backend checkpoints, Completed foundation: Git, pnpm, Turborepo, TypeScript and health API, Future Phase 9 operational hardening, Recorded implemented performance, fees, trial settlement and retained records, Future risk-adjusted rankings; existing ranking is net return only (+3 more)

### Community 47 - "v1-core/src/lib.rs"
Cohesion: 0.07
Nodes (62): ProgramData, apply_token(), apply_venue(), ApplyToken, ApplyVenue, check_due(), eta(), queue_token() (+54 more)

### Community 48 - "warp"
Cohesion: 0.11
Nodes (37): E, apply_policy(), ApplyPolicy, poke_nav(), PokeNav, Account, Box, Context (+29 more)

### Community 49 - "test_vote.rs"
Cohesion: 0.23
Nodes (32): venue_data(), big_buy(), big_trade_fails_without_majority(), big_trade_passes_with_majority(), cancelled_proposal_cannot_execute(), crew(), double_vote_rejected(), exactly_half_is_not_a_majority() (+24 more)

### Community 50 - "Fund"
Cohesion: 0.17
Nodes (18): charge_fee(), Exit, fresh_pps(), Account, AccountInfo, Box, Context, InterfaceAccount (+10 more)

### Community 51 - "Whitepaper v1.0: proposed live socially.trade product"
Cohesion: 0.07
Nodes (50): Proposed server-derived identity and fund ownership authorization, Proposed fixed virtual allowance and Captain seed, Proposed decimal money arithmetic and explicit rounding, v0 paper trading architecture: implementation proposal, Proposed 10% high-water-mark fee with 80/20 minted shares, Proposed append-only balanced ledger and immutable fund events, Proposed separate live Solana transaction and indexer write path, Proposed future React Native/Expo client (+42 more)

### Community 52 - "CreateFund"
Cohesion: 0.12
Nodes (19): create_fund(), create_share_mint(), CreateFund, Account, AssociatedToken, Box, Context, Interface (+11 more)

### Community 53 - "Captain flow — v0 developer handoff"
Cohesion: 0.11
Nodes (18): 10. Review the completed record, 1. Sign in and initialize the account, 2. Create a Captain profile, 3. Resume an existing trial or create a new one, 4. Open the fund dashboard, 5. Preview a paper order, 6. Submit and follow the order, 7. Publish decisions and communicate with Crew (+10 more)

### Community 54 - "Deposit"
Cohesion: 0.11
Nodes (17): Deposit, Account, AssociatedToken, Box, Context, Interface, InterfaceAccount, Mint (+9 more)

### Community 55 - "ChargeAnnualFee"
Cohesion: 0.13
Nodes (14): charge_annual_fee(), ChargeAnnualFee, Account, Box, Context, InterfaceAccount, Mint, Program (+6 more)

### Community 56 - "7. Paper orders and trade history"
Cohesion: 0.22
Nodes (9): 15. `POST /v0/funds/:fundId/orders/preview`, 16. `POST /v0/funds/:fundId/orders`, 17. `GET /v0/funds/:fundId/orders`, 18. `GET /v0/funds/:fundId/orders/:orderId`, 19. `POST /v0/funds/:fundId/orders/:orderId/cancel`, 20. `GET /v0/captains/:captainId/orders`, 21. `GET /v0/captains/:captainId/trade-statistics`, 22. `GET /v0/me/crew-transactions` (+1 more)

### Community 57 - "Privy backend authentication"
Cohesion: 0.25
Nodes (7): Bootstrap the backend account, Configure the API, Existing authentication and migration, Get your Privy configuration, Privy backend authentication, Use protected endpoints, Verification and errors

### Community 58 - "events.rs"
Cohesion: 0.25
Nodes (13): BreakerChanged, CaptainLog, Deposited, Exited, FeeCharged, FundCreated, PolicyApplied, PolicyQueued (+5 more)

### Community 59 - "compute"
Cohesion: 0.33
Nodes (11): compute(), NavResult, AccountInfo, Option, Pubkey, Result, token_entry(), update_breaker() (+3 more)

### Community 60 - "Published simulated SOL/USDC fill model version 1"
Cohesion: 0.39
Nodes (9): Simulated mark-based fill does not establish live Jupiter liquidity, Published delayed order execution using fresh observations and policy recheck, DEV_SEED observations restricted to local development, Published simulated SOL/USDC fill model version 1, Published observation limits: age 90s, future 5s, confidence 1%, Published spot-only order cap: 10% NAV and 1000 virtual USDC, Published fill costs: 20bps spread, 10bps fee, size impact, Published SOL 9 decimals and USDC 6 decimals with conservative rounding (+1 more)

### Community 61 - "README: implemented backend and local development"
Cohesion: 0.26
Nodes (13): Implemented authenticated accounts and one-time virtual allowance, Implemented development token and production JWKS JWT adapters, Implemented paper backend only; no frontend or Android app, README: implemented backend and local development, Implemented Captain funds and Crew shares, Pending mobile, external push, risk-adjusted rankings and hardening, Implemented SOL paper order endpoints and worker, Implemented performance, NAV history and personal P&L reads (+5 more)

### Community 62 - "swap"
Cohesion: 0.17
Nodes (11): Context, Interface, InterfaceAccount, Mint, Result, Signer, TokenAccount, TokenInterface (+3 more)

### Community 63 - "Jupiter ingestion and WebSocket integration — v0"
Cohesion: 0.15
Nodes (12): Flow, Jupiter ingestion and WebSocket integration — v0, Limits and existing flows, Modules and persistence, Price and paper execution semantics, Private inbox, Provider and rate budget, Public prices (+4 more)

### Community 64 - "v1-core"
Cohesion: 0.22
Nodes (8): Build and test, Client notes, Disclosures and accepted risks, Instructions, Out of scope (Phase 2), Pricing, The six promises and what enforces them, v1-core

### Community 65 - "6. Funds and Crew allocation"
Cohesion: 0.25
Nodes (8): 10. `GET /v0/funds/:fundId`, 11. `GET /v0/funds/:fundId/policy`, 12. `GET /v0/funds/:fundId/holdings`, 13. `POST /v0/funds/:fundId/joins`, 14. `POST /v0/funds/:fundId/exits`, 6. Funds and Crew allocation, 8. `POST /v0/funds`, 9. `GET /v0/funds`

### Community 66 - "test_exit.rs"
Cohesion: 0.16
Nodes (32): exit(), ix_exit_unpriced(), mint_usdc(), usdc_ata(), assert_paid_at_last_pps(), captain_can_exit_fully_when_alone(), captain_cannot_exit_below_5pct_while_crew_holds(), captain_pays_no_fee() (+24 more)

### Community 67 - "ui-api-spec-v0.md"
Cohesion: 0.24
Nodes (6): Captain history and statistics, Cursor convention, Fund order history, Paper history API, Private Crew transaction timeline, Verification

### Community 68 - "Q: Which Solana Agent Kit integrations can make Socially Trade more useful?"
Cohesion: 0.40
Nodes (4): Answer, Outcome, Q: Which Solana Agent Kit integrations can make Socially Trade more useful?, Source Nodes

### Community 76 - "5. Accounts and Captain onboarding"
Cohesion: 0.22
Nodes (9): 1. `GET /health`, 2. `POST /v0/auth/privy`, 37. `GET /v0/captains/handle-availability`, 3. `GET /v0/me`, 4. `GET /v0/me/paper-balance`, 5. Accounts and Captain onboarding, 5. `GET /v0/me/paper-positions`, 6. `POST /v0/captains` (+1 more)

### Community 77 - "8. Performance, charts and records"
Cohesion: 0.29
Nodes (7): 23. `GET /v0/funds/:fundId/performance`, 24. `GET /v0/funds/:fundId/history`, 25. `GET /v0/me/funds/:fundId/performance`, 26. `GET /v0/me/paper-record`, 27. `GET /v0/captains/:captainId/paper-record`, 28. `GET /v0/funds/rankings`, 8. Performance, charts and records

### Community 78 - "9. Fund activity, chat and decision log"
Cohesion: 0.29
Nodes (7): 29. `GET /v0/funds/:fundId/events`, 30. `GET /v0/funds/:fundId/events/stream`, 31. `GET /v0/funds/:fundId/messages`, 32. `GET /v0/funds/:fundId/decisions`, 33. `POST /v0/funds/:fundId/messages`, 34. `POST /v0/funds/:fundId/orders/:orderId/notes`, 9. Fund activity, chat and decision log

### Community 79 - "12. Recommended screen flows"
Cohesion: 0.40
Nodes (5): 12. Recommended screen flows, Captain dashboard and trading, Crew discovery and portfolio, Minimal client request helper, Sign-in and account

### Community 80 - "2. Shared conventions"
Cohesion: 0.50
Nodes (4): 2. Shared conventions, Idempotency, Pagination: three separate contracts, Values and identifiers

### Community 81 - "setup"
Cohesion: 0.15
Nodes (29): create_mint(), ix_apply_token(), ix_initialize_config(), ix_queue_token(), read_config(), setup(), setup_bare(), token_pda() (+21 more)

### Community 82 - "010_captain_handle_index.sql"
Cohesion: 0.67
Nodes (3): advance_captain_handle_revision(), captain_handle_index_state, captain_handle_revision_changed

### Community 83 - "ingestor/package.json"
Cohesion: 0.07
Nodes (27): dependencies, ioredis, @socially/db, @socially/domain, @socially/market-data, @socially/market-stream, devDependencies, tsx (+19 more)

### Community 84 - "Captain handle availability and Redis Bloom index"
Cohesion: 0.25
Nodes (7): Captain handle availability and Redis Bloom index, Configuration and lifecycle, Read flow, Setup, UI contract, Validation recorded, Write flow and recovery

### Community 85 - "ix_add_delegate"
Cohesion: 0.14
Nodes (26): delegate_pda(), ix_add_delegate(), ix_revoke_delegate(), write_fund(), annual_fee_ignores_stale_higher_last_pps(), annual_fee_not_due_before_a_year(), annual_fee_rejects_captain(), annual_fee_requires_fresh_valid_prices() (+18 more)

### Community 86 - "funded_user"
Cohesion: 0.18
Nodes (24): create_fund(), events(), expect_anchor_err(), expect_code(), expect_log(), funded(), funded_user(), ix_create_ata() (+16 more)

### Community 87 - "market-stream/package.json"
Cohesion: 0.10
Nodes (19): dependencies, ioredis, @socially/db, devDependencies, @types/node, typescript, exports, ioredis (+11 more)

### Community 88 - "ingestor/src/index.ts"
Cohesion: 0.18
Nodes (10): bus, keys, pool, scheduler, ingestJupiter(), recordMarketPrice(), sourceTime(), times (+2 more)

### Community 89 - "Captain profile and banner assets"
Cohesion: 0.29
Nodes (7): Captain profile and banner assets, Current setup, Future self-service upload integration, Implemented endpoints, Update a profile, Validation status, Where to save the files

### Community 90 - "Env"
Cohesion: 0.25
Nodes (21): Env, exit_accounts(), FundHandles, ix_execute_proposal(), ix_exit(), ix_poke_nav(), ix_propose(), nav_accounts() (+13 more)

### Community 91 - "market-stream/src/index.ts"
Cohesion: 0.19
Nodes (7): currentPrice(), cursorPattern, MarketBus, MarketEvent, MarketPrice, marketRedis(), StreamEntry

### Community 92 - "CaptainHandleIndex"
Cohesion: 0.30
Nodes (5): CaptainHandleIndex, captainHandleSchema, IndexState, keys(), version()

### Community 94 - "compilerOptions"
Cohesion: 0.22
Nodes (8): compilerOptions, declaration, outDir, rootDir, types, extends, include, ../../tsconfig.base.json

### Community 95 - "WriteLog"
Cohesion: 0.25
Nodes (8): captain_log(), Account, Box, Context, Option, Result, Signer, WriteLog

### Community 96 - "ingestor/tsconfig.json"
Cohesion: 0.25
Nodes (7): compilerOptions, outDir, rootDir, types, extends, include, ../../tsconfig.base.json

### Community 97 - "10. Personal inbox"
Cohesion: 0.67
Nodes (3): 10. Personal inbox, 35. `GET /v0/me/notifications`, 36. `POST /v0/me/notifications/:notificationId/read`

## Knowledge Gaps
- **425 isolated node(s):** `name`, `version`, `private`, `type`, `dev` (+420 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 631 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **10 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `Fund` connect `Fund` to `Trade`, `fund_with_member`, `warp`, `CreateFund`, `ix_add_delegate`, `Deposit`, `ChargeAnnualFee`, `compute`, `WriteLog`?**
  _High betweenness centrality (0.039) - this node is a cross-community bridge._
- **Why does `expect_err()` connect `expect_err` to `test_exit.rs`, `common/mod.rs`, `fund_with_member`, `math.rs`, `warp`, `setup`, `test_vote.rs`, `ix_add_delegate`, `funded_user`?**
  _High betweenness centrality (0.022) - this node is a cross-community bridge._
- **Why does `Trade` connect `Trade` to `warp`, `Fund`, `Env`, `Deposit`?**
  _High betweenness centrality (0.021) - this node is a cross-community bridge._
- **Are the 92 inferred relationships involving `expect_err()` (e.g. with `initialize_config_rejects_frozen_program()` and `initialize_config_rejects_non_upgrade_authority()`) actually correct?**
  _`expect_err()` has 92 INFERRED edges - model-reasoned connections that need verification._
- **Are the 43 inferred relationships involving `trading_fund()` (e.g. with `exit_works_when_paused_frozen_and_stale()` and `half_sol_fund()`) actually correct?**
  _`trading_fund()` has 43 INFERRED edges - model-reasoned connections that need verification._
- **What connects `name`, `version`, `private` to the rest of the system?**
  _425 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `ApiFault` be split into smaller, more focused modules?**
  _Cohesion score 0.0673655600854203 - nodes in this community are weakly interconnected._
## Current contract note

This AST refresh updates code relationships. Semantic document nodes can predate Jupiter streaming and Captain profile images. Consult docs/ui-api-spec-v0.md, docs/jupiter-market-stream-v0.md and docs/captain-profile-assets.md for the implemented contracts.
