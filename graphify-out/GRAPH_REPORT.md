# Graph Report - Socially Trade  (2026-10-04)

## Corpus Check
- 124 files · ~66,044 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1315 nodes · 3435 edges · 76 communities (55 shown, 10 thin omitted)
- Extraction: 80% EXTRACTED · 20% INFERRED · 0% AMBIGUOUS · INFERRED: 693 edges (avg confidence: 0.85)
- Token usage: this AST refresh uses no LLM tokens; prior semantic extraction usage is unknown.

## Graph Freshness
- Built from commit: `7384ff9c`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- ApiFault
- funded_user
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
- Env
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
- Trade
- v1-core/src/lib.rs
- warp
- test_vote.rs
- Exit
- Whitepaper v1.0: proposed live socially.trade product
- CreateFund
- Captain flow — v0 developer handoff
- Deposit
- ChargeAnnualFee
- test_fees.rs
- Privy backend authentication
- events.rs
- pyth.rs
- send
- README: implemented backend and local development
- swap
- Phased v0 delivery plan and recorded backend checkpoints
- v1-core
- LiteSVM
- WriteLog
- Paper history API
- Fund
- build-programs.sh
- mock-venue
- v1-core

## God Nodes (most connected - your core abstractions)
1. `expect_err()` - 99 edges
2. `Env` - 61 edges
3. `trading_fund()` - 53 edges
4. `FundHandles` - 51 edges
5. `ApiFault` - 48 edges
6. `fund_with_member()` - 46 edges
7. `deposit()` - 43 edges
8. `warp()` - 37 edges
9. `buy_sol()` - 37 edges
10. `funded_user()` - 35 edges

## Surprising Connections (you probably didn't know these)
- `Proposed NAV-based Crew join and leave` --semantically_similar_to--> `Planned live share issuance and redemption at NAV`  [INFERRED] [semantically similar]
  docs/v0-paper-trading-architecture.md → socially-trade-whitepaper.pdf
- `Proposed 10% high-water-mark fee with 80/20 minted shares` --semantically_similar_to--> `Planned 10% performance fee above post-fee high-water mark`  [INFERRED] [semantically similar]
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

## Communities (76 total, 10 thin omitted)

### Community 0 - "ApiFault"
Cohesion: 0.08
Nodes (66): registerAccountRoutes(), beginIdempotent(), finishIdempotent(), PositionValue, saveNav(), Valuation, valueFund(), createApp() (+58 more)

### Community 1 - "funded_user"
Cohesion: 0.11
Nodes (45): create_fund(), create_mint(), funded(), funded_user(), ix_apply_token(), ix_create_ata(), ix_initialize_config(), ix_queue_token() (+37 more)

### Community 2 - "worker/src/orders.ts"
Cohesion: 0.10
Nodes (29): runWorkerCycle(), assessDailyFees(), assessFundFee(), eligibleFundBatches(), FundJob, pool, deliverOne(), deliverOutbox() (+21 more)

### Community 3 - "Backend simulation report: recorded checks on October 1, 2026"
Cohesion: 0.27
Nodes (13): Verified per-asset ledger and projection reconciliation, Verified JWT signature, issuer, audience, expiration and private records, Verified 101-fund valuation, fee and expiration sweeps, Verified retries, rollback, mixed mutation races and exactly-once effects, Backend simulation report: recorded checks on October 1, 2026, Verified 10% high-water-mark fees and 80/20 minted shares, Verified localhost-only disposable schemas and synthetic market data, Untested external integrations and long-duration production operation (+5 more)

### Community 4 - "api/package.json"
Cohesion: 0.06
Nodes (32): dependencies, decimal.js, fastify, jose, pg, @socially/contracts, @socially/db, @socially/domain (+24 more)

### Community 5 - "worker/package.json"
Cohesion: 0.07
Nodes (27): dependencies, @socially/db, @socially/domain, @socially/market-data, devDependencies, tsx, @types/node, typescript (+19 more)

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
Cohesion: 0.27
Nodes (7): outbox_events, captain_profiles, funds, instruments, users, api_idempotency, notifications

### Community 16 - "contracts/src/index.ts"
Cohesion: 0.20
Nodes (9): ApiError, FundMode, FundStatus, FundSummary, OrderSide, OrderStatus, PAPER_MODE, PaperAmount (+1 more)

### Community 17 - "Graphify project setup and refresh guide"
Cohesion: 0.22
Nodes (9): Repository agent guidance, Graphify knowledge graph navigation and incremental refresh rules, Read installed Turborepo bundled docs before changing commands or config, Semantic extraction token usage is unknown; no API key required, Graphify project setup and refresh guide, Graphify excludes credentials, generated dependencies and unrelated résumé, AST updates are local; changed documents require semantic extraction, Graphify covers backend symbols, SQL migrations, docs and whitepaper (+1 more)

### Community 18 - "Env"
Cohesion: 0.14
Nodes (38): Env, exit(), ix_exit_unpriced(), mint_usdc(), token_balance(), usdc_ata(), assert_paid_at_last_pps(), captain_can_exit_fully_when_alone() (+30 more)

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
Cohesion: 0.29
Nodes (4): FILL_MODEL_VERSION, PriceObservation, SimulatedFill, SOL_USD_FEED_ID

### Community 27 - "Local Docker Compose PostgreSQL service"
Cohesion: 0.83
Nodes (4): Local Docker Compose PostgreSQL service, Configured pg_isready database health check, Configured PostgreSQL 17 Alpine at localhost port 5432, Configured persistent socially-postgres Docker volume

### Community 30 - "pnpm workspace globs"
Cohesion: 0.67
Nodes (3): Workspace apps/* packages, pnpm workspace globs, Workspace packages/* packages

### Community 42 - "common/mod.rs"
Cohesion: 0.15
Nodes (47): InstructionData, config_pda(), exit_accounts(), fund_pda(), FundHandles, ix_apply_policy(), ix_apply_venue(), ix_cancel_proposal() (+39 more)

### Community 43 - "fund_with_member"
Cohesion: 0.15
Nodes (39): deposit(), fund_with_member(), inject_holding(), listed_sol(), now(), price_account(), read_fund(), set_price() (+31 more)

### Community 44 - "expect_err"
Cohesion: 0.11
Nodes (68): ata(), delegate_pda(), expect_err(), ix_add_delegate(), ix_swap(), register_token(), set_usd_price(), setup_venue_pool() (+60 more)

### Community 45 - "math.rs"
Cohesion: 0.08
Nodes (18): ErrorCode, bps_of(), fee_below_one_share_keeps_hwm(), fee_whitepaper_priya(), fee_with_zero_pps_gives_zero_fee_shares(), FeeOutcome, mul_div_floor(), no_fee_at_hwm() (+10 more)

### Community 46 - "Trade"
Cohesion: 0.06
Nodes (75): add_delegate(), AddDelegate, charge_delegate(), code(), d(), daily_limit_and_reset(), day_volume_overflow_is_math_overflow(), per_trade_limit() (+67 more)

### Community 47 - "v1-core/src/lib.rs"
Cohesion: 0.06
Nodes (64): ProgramData, apply_token(), apply_venue(), ApplyToken, ApplyVenue, check_due(), eta(), queue_token() (+56 more)

### Community 48 - "warp"
Cohesion: 0.12
Nodes (35): E, apply_policy(), ApplyPolicy, poke_nav(), PokeNav, Account, Box, Context (+27 more)

### Community 49 - "test_vote.rs"
Cohesion: 0.18
Nodes (39): ix_execute_proposal(), AccountMeta, Vec, SwapArgs, trade_events(), trade_remaining(), venue_accounts(), venue_data() (+31 more)

### Community 50 - "Exit"
Cohesion: 0.20
Nodes (16): charge_fee(), Exit, fresh_pps(), Account, AccountInfo, Box, Context, InterfaceAccount (+8 more)

### Community 51 - "Whitepaper v1.0: proposed live socially.trade product"
Cohesion: 0.06
Nodes (59): Simulated mark-based fill does not establish live Jupiter liquidity, Published delayed order execution using fresh observations and policy recheck, DEV_SEED observations restricted to local development, Published simulated SOL/USDC fill model version 1, Published observation limits: age 90s, future 5s, confidence 1%, Published spot-only order cap: 10% NAV and 1000 virtual USDC, Published fill costs: 20bps spread, 10bps fee, size impact, Published SOL 9 decimals and USDC 6 decimals with conservative rounding (+51 more)

### Community 52 - "CreateFund"
Cohesion: 0.12
Nodes (19): create_fund(), create_share_mint(), CreateFund, Account, AssociatedToken, Box, Context, Interface (+11 more)

### Community 53 - "Captain flow — v0 developer handoff"
Cohesion: 0.12
Nodes (17): 10. Review the completed record, 1. Sign in and initialize the account, 2. Create a Captain profile, 3. Resume an existing trial or create a new one, 4. Open the fund dashboard, 5. Preview a paper order, 6. Submit and follow the order, 7. Publish decisions and communicate with Crew (+9 more)

### Community 54 - "Deposit"
Cohesion: 0.12
Nodes (15): Deposit, Account, AssociatedToken, Box, Context, Interface, InterfaceAccount, Mint (+7 more)

### Community 55 - "ChargeAnnualFee"
Cohesion: 0.13
Nodes (14): charge_annual_fee(), ChargeAnnualFee, Account, Box, Context, InterfaceAccount, Mint, Program (+6 more)

### Community 56 - "test_fees.rs"
Cohesion: 0.18
Nodes (22): annual_fee_ignores_stale_higher_last_pps(), annual_fee_not_due_before_a_year(), annual_fee_rejects_captain(), annual_fee_requires_fresh_valid_prices(), annual_fee_whitepaper_example(), annual_fee_zero_below_hwm(), captain_log_accepts_delegate_of_this_fund(), captain_log_emits_hash() (+14 more)

### Community 57 - "Privy backend authentication"
Cohesion: 0.25
Nodes (7): Bootstrap the backend account, Configure the API, Existing authentication and migration, Get your Privy configuration, Privy backend authentication, Use protected endpoints, Verification and errors

### Community 58 - "events.rs"
Cohesion: 0.25
Nodes (13): BreakerChanged, CaptainLog, Deposited, Exited, FeeCharged, FundCreated, PolicyApplied, PolicyQueued (+5 more)

### Community 59 - "pyth.rs"
Cohesion: 0.10
Nodes (25): compute(), NavResult, AccountInfo, Option, Pubkey, Result, token_entry(), update_breaker() (+17 more)

### Community 60 - "send"
Cohesion: 0.35
Nodes (10): events(), expect_anchor_err(), expect_code(), expect_log(), FailedTransactionMetadata, Result, TransactionMetadata, send() (+2 more)

### Community 61 - "README: implemented backend and local development"
Cohesion: 0.26
Nodes (13): Implemented authenticated accounts and one-time virtual allowance, Implemented development token and production JWKS JWT adapters, Implemented paper backend only; no frontend or Android app, README: implemented backend and local development, Implemented Captain funds and Crew shares, Pending mobile, external push, risk-adjusted rankings and hardening, Implemented SOL paper order endpoints and worker, Implemented performance, NAV history and personal P&L reads (+5 more)

### Community 62 - "swap"
Cohesion: 0.17
Nodes (11): Context, Interface, InterfaceAccount, Mint, Result, Signer, TokenAccount, TokenInterface (+3 more)

### Community 63 - "Phased v0 delivery plan and recorded backend checkpoints"
Cohesion: 0.18
Nodes (11): Recorded implemented accounts, shares, execution and social backend checkpoints, Future Phase 6 mobile Captain and Crew flows, Phase-scoped reviewable commits on main, Phased v0 delivery plan and recorded backend checkpoints, Completed foundation: Git, pnpm, Turborepo, TypeScript and health API, Future Phase 9 operational hardening, Recorded implemented performance, fees, trial settlement and retained records, Future risk-adjusted rankings; existing ranking is net return only (+3 more)

### Community 64 - "v1-core"
Cohesion: 0.22
Nodes (8): Build and test, Client notes, Disclosures and accepted risks, Instructions, Out of scope (Phase 2), Pricing, The six promises and what enforces them, v1-core

### Community 65 - "LiteSVM"
Cohesion: 0.29
Nodes (10): LiteSVM, custom_code(), Mint, Option, share_mint_state(), ShareMintState, write_mint(), write_mint_with_freeze() (+2 more)

### Community 66 - "WriteLog"
Cohesion: 0.25
Nodes (8): captain_log(), Account, Box, Context, Option, Result, Signer, WriteLog

### Community 67 - "Paper history API"
Cohesion: 0.25
Nodes (6): Captain history and statistics, Cursor convention, Fund order history, Paper history API, Private Crew transaction timeline, Verification

## Knowledge Gaps
- **277 isolated node(s):** `name`, `version`, `private`, `type`, `dev` (+272 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 473 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **10 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `Fund` connect `Fund` to `WriteLog`, `fund_with_member`, `Trade`, `warp`, `Exit`, `CreateFund`, `Deposit`, `ChargeAnnualFee`, `pyth.rs`?**
  _High betweenness centrality (0.069) - this node is a cross-community bridge._
- **Why does `Config` connect `v1-core/src/lib.rs` to `common/mod.rs`, `Trade`, `warp`, `Exit`, `CreateFund`, `Deposit`, `ChargeAnnualFee`, `pyth.rs`?**
  _High betweenness centrality (0.048) - this node is a cross-community bridge._
- **Why does `expect_err()` connect `expect_err` to `funded_user`, `common/mod.rs`, `fund_with_member`, `math.rs`, `warp`, `test_vote.rs`, `Env`, `test_fees.rs`, `send`?**
  _High betweenness centrality (0.046) - this node is a cross-community bridge._
- **Are the 92 inferred relationships involving `expect_err()` (e.g. with `initialize_config_rejects_frozen_program()` and `initialize_config_rejects_non_upgrade_authority()`) actually correct?**
  _`expect_err()` has 92 INFERRED edges - model-reasoned connections that need verification._
- **Are the 43 inferred relationships involving `trading_fund()` (e.g. with `exit_works_when_paused_frozen_and_stale()` and `half_sol_fund()`) actually correct?**
  _`trading_fund()` has 43 INFERRED edges - model-reasoned connections that need verification._
- **What connects `name`, `version`, `private` to the rest of the system?**
  _277 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `ApiFault` be split into smaller, more focused modules?**
  _Cohesion score 0.08019853709508883 - nodes in this community are weakly interconnected._
## Authentication freshness

Runtime authentication is now Privy only. Older semantic nodes may describe historical generic JWT/development adapters; those adapters no longer exist in source. This refresh updates AST relationships, not semantic documentation extraction.
