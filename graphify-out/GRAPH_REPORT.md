# Graph Report - Socially Trade  (2026-10-04)

## Corpus Check
- 120 files · ~65,132 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1301 nodes · 3407 edges · 72 communities (51 shown, 10 thin omitted)
- Extraction: 80% EXTRACTED · 20% INFERRED · 0% AMBIGUOUS · INFERRED: 693 edges (avg confidence: 0.85)
- Token usage: this AST refresh uses no LLM tokens. Prior agent-assisted semantic extraction usage is unknown.

## Graph Freshness
- Built from commit: `2b6ec73d`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- ApiFault
- Whitepaper v1.0: proposed live socially.trade product
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
- Published simulated SOL/USDC fill model version 1
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
- ProposeTrade
- v1-core/src/lib.rs
- warp
- test_vote.rs
- Fund
- v0 paper trading architecture: implementation proposal
- CreateFund
- Captain flow — v0 developer handoff
- Deposit
- swap.rs
- Trade
- WriteLog
- events.rs
- pyth.rs
- README: implemented backend and local development
- swap
- Phased v0 delivery plan and recorded backend checkpoints
- v1-core
- history-simulation.test.mjs
- build-programs.sh
- mock-venue
- v1-core

## God Nodes (most connected - your core abstractions)
1. `expect_err()` - 99 edges
2. `Env` - 61 edges
3. `trading_fund()` - 53 edges
4. `FundHandles` - 51 edges
5. `ApiFault` - 46 edges
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

## Communities (72 total, 10 thin omitted)

### Community 0 - "ApiFault"
Cohesion: 0.08
Nodes (65): registerAccountRoutes(), beginIdempotent(), finishIdempotent(), PositionValue, saveNav(), Valuation, valueFund(), createApp() (+57 more)

### Community 1 - "Whitepaper v1.0: proposed live socially.trade product"
Cohesion: 0.15
Nodes (24): Planned React Native mobile app, Planned protocol revenue: 20% of performance fees, on-ramp share and later Captain Pro, Planned live Captain: approved trader with delegate authority, Planned live Crew: fund investors with proportional shares, Planned delegate keys with per-key limits, Whitepaper v1.0: proposed live socially.trade product, Planned 30% drawdown safety breaker, Planned partial instant exit and queued token liquidation (+16 more)

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

### Community 18 - "Published simulated SOL/USDC fill model version 1"
Cohesion: 0.39
Nodes (9): Simulated mark-based fill does not establish live Jupiter liquidity, Published delayed order execution using fresh observations and policy recheck, DEV_SEED observations restricted to local development, Published simulated SOL/USDC fill model version 1, Published observation limits: age 90s, future 5s, confidence 1%, Published spot-only order cap: 10% NAV and 1000 virtual USDC, Published fill costs: 20bps spread, 10bps fee, size impact, Published SOL 9 decimals and USDC 6 decimals with conservative rounding (+1 more)

### Community 19 - "compilerOptions"
Cohesion: 0.22
Nodes (8): compilerOptions, declaration, outDir, rootDir, types, extends, include, ../../tsconfig.base.json

### Community 20 - "compilerOptions"
Cohesion: 0.22
Nodes (8): compilerOptions, declaration, outDir, rootDir, types, extends, include, ../../tsconfig.base.json

### Community 21 - "backend-simulation.test.mjs"
Cohesion: 0.39
Nodes (5): ageOrder(), order(), request(), seed(), settled()

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
Cohesion: 0.07
Nodes (110): InstructionData, LiteSVM, config_pda(), custom_code(), Env, exit_accounts(), fund_pda(), funded() (+102 more)

### Community 43 - "fund_with_member"
Cohesion: 0.06
Nodes (105): create_fund(), delegate_pda(), deposit(), events(), exit(), expect_anchor_err(), expect_code(), expect_log() (+97 more)

### Community 44 - "expect_err"
Cohesion: 0.10
Nodes (69): ata(), create_mint(), expect_err(), ix_create_ata(), register_token(), set_usd_price(), setup_venue_pool(), Trading (+61 more)

### Community 45 - "math.rs"
Cohesion: 0.08
Nodes (18): ErrorCode, bps_of(), fee_below_one_share_keeps_hwm(), fee_whitepaper_priya(), fee_with_zero_pps_gives_zero_fee_shares(), FeeOutcome, mul_div_floor(), no_fee_at_hwm() (+10 more)

### Community 46 - "ProposeTrade"
Cohesion: 0.19
Nodes (22): cancel_proposal(), CancelProposal, CastVote, execute_proposal(), ExecuteProposal, propose_trade(), ProposeTrade, Account (+14 more)

### Community 47 - "v1-core/src/lib.rs"
Cohesion: 0.06
Nodes (64): ProgramData, apply_token(), apply_venue(), ApplyToken, ApplyVenue, check_due(), eta(), queue_token() (+56 more)

### Community 48 - "warp"
Cohesion: 0.11
Nodes (37): E, apply_policy(), ApplyPolicy, poke_nav(), PokeNav, Account, Box, Context (+29 more)

### Community 49 - "test_vote.rs"
Cohesion: 0.23
Nodes (32): venue_data(), big_buy(), big_trade_fails_without_majority(), big_trade_passes_with_majority(), cancelled_proposal_cannot_execute(), crew(), double_vote_rejected(), exactly_half_is_not_a_majority() (+24 more)

### Community 50 - "Fund"
Cohesion: 0.15
Nodes (24): add_delegate(), AddDelegate, charge_delegate(), code(), d(), daily_limit_and_reset(), day_volume_overflow_is_math_overflow(), per_trade_limit() (+16 more)

### Community 51 - "v0 paper trading architecture: implementation proposal"
Cohesion: 0.13
Nodes (26): Proposed server-derived identity and fund ownership authorization, Proposed fixed virtual allowance and Captain seed, Proposed decimal money arithmetic and explicit rounding, v0 paper trading architecture: implementation proposal, Proposed 10% high-water-mark fee with 80/20 minted shares, Proposed append-only balanced ledger and immutable fund events, Proposed separate live Solana transaction and indexer write path, Proposed future React Native/Expo client (+18 more)

### Community 52 - "CreateFund"
Cohesion: 0.12
Nodes (19): create_fund(), create_share_mint(), CreateFund, Account, AssociatedToken, Box, Context, Interface (+11 more)

### Community 53 - "Captain flow — v0 developer handoff"
Cohesion: 0.12
Nodes (16): 10. Review the completed record, 1. Sign in and initialize the account, 2. Create a Captain profile, 3. Resume an existing trial or create a new one, 4. Open the fund dashboard, 5. Preview a paper order, 6. Submit and follow the order, 7. Publish decisions and communicate with Crew (+8 more)

### Community 54 - "Deposit"
Cohesion: 0.05
Nodes (45): Deposit, Account, AssociatedToken, Box, Context, Interface, InterfaceAccount, Mint (+37 more)

### Community 55 - "swap.rs"
Cohesion: 0.38
Nodes (16): call_venue(), clean_vault_amount(), execute_swap(), listed(), output_vault_before(), Plan, prepare(), route_hash() (+8 more)

### Community 56 - "Trade"
Cohesion: 0.15
Nodes (15): Account, AssociatedToken, Box, Context, Interface, InterfaceAccount, Mint, Program (+7 more)

### Community 57 - "WriteLog"
Cohesion: 0.25
Nodes (8): captain_log(), Account, Box, Context, Option, Result, Signer, WriteLog

### Community 58 - "events.rs"
Cohesion: 0.25
Nodes (13): BreakerChanged, CaptainLog, Deposited, Exited, FeeCharged, FundCreated, PolicyApplied, PolicyQueued (+5 more)

### Community 59 - "pyth.rs"
Cohesion: 0.10
Nodes (25): compute(), NavResult, AccountInfo, Option, Pubkey, Result, token_entry(), update_breaker() (+17 more)

### Community 61 - "README: implemented backend and local development"
Cohesion: 0.26
Nodes (13): Implemented authenticated accounts and one-time virtual allowance, Implemented development token and production JWKS JWT adapters, Implemented paper backend only; no frontend or Android app, README: implemented backend and local development, Implemented Captain funds and Crew shares, Pending mobile, external push, risk-adjusted rankings and hardening, Implemented SOL paper order endpoints and worker, Implemented performance, NAV history and personal P&L reads (+5 more)

### Community 62 - "swap"
Cohesion: 0.17
Nodes (11): Context, Interface, InterfaceAccount, Mint, Result, Signer, TokenAccount, TokenInterface (+3 more)

### Community 63 - "Phased v0 delivery plan and recorded backend checkpoints"
Cohesion: 0.11
Nodes (17): Captain history and statistics, Cursor convention, Fund order history, Paper history API, Private Crew transaction timeline, Verification, Recorded implemented accounts, shares, execution and social backend checkpoints, Future Phase 6 mobile Captain and Crew flows (+9 more)

### Community 64 - "v1-core"
Cohesion: 0.22
Nodes (8): Build and test, Client notes, Disclosures and accepted risks, Instructions, Out of scope (Phase 2), Pricing, The six promises and what enforces them, v1-core

## Knowledge Gaps
- **270 isolated node(s):** `name`, `version`, `private`, `type`, `dev` (+265 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 467 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **10 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `Fund` connect `Fund` to `common/mod.rs`, `fund_with_member`, `ProposeTrade`, `warp`, `CreateFund`, `Deposit`, `Trade`, `WriteLog`, `pyth.rs`?**
  _High betweenness centrality (0.076) - this node is a cross-community bridge._
- **Why does `Config` connect `v1-core/src/lib.rs` to `common/mod.rs`, `ProposeTrade`, `warp`, `CreateFund`, `Deposit`, `swap.rs`, `Trade`, `pyth.rs`?**
  _High betweenness centrality (0.057) - this node is a cross-community bridge._
- **Why does `expect_err()` connect `expect_err` to `common/mod.rs`, `fund_with_member`, `math.rs`, `warp`, `test_vote.rs`?**
  _High betweenness centrality (0.040) - this node is a cross-community bridge._
- **Are the 92 inferred relationships involving `expect_err()` (e.g. with `initialize_config_rejects_frozen_program()` and `initialize_config_rejects_non_upgrade_authority()`) actually correct?**
  _`expect_err()` has 92 INFERRED edges - model-reasoned connections that need verification._
- **Are the 43 inferred relationships involving `trading_fund()` (e.g. with `exit_works_when_paused_frozen_and_stale()` and `half_sol_fund()`) actually correct?**
  _`trading_fund()` has 43 INFERRED edges - model-reasoned connections that need verification._
- **What connects `name`, `version`, `private` to the rest of the system?**
  _270 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `ApiFault` be split into smaller, more focused modules?**
  _Cohesion score 0.08235294117647059 - nodes in this community are weakly interconnected._
## Refresh scope

Code graph refreshed for the v0 history endpoints and pulled v1 Rust programs. Semantic documentation links retain the previous extraction and need an agent-assisted refresh. Root Cargo.toml produced no nodes in the AST extractor; verify its workspace relationships in source. Previously recorded unresolved endpoint and collapsed-edge limitations remain relevant to graph completeness.
