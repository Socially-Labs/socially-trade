# Graph Report - backend  (2026-10-07)

## Corpus Check
- 201 files · ~154,210 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 2315 nodes · 5984 edges · 145 communities (114 shown, 14 thin omitted)
- Extraction: 80% EXTRACTED · 20% INFERRED · 0% AMBIGUOUS · INFERRED: 1168 edges (avg confidence: 0.85)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `9f01a763`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- test_fund.rs
- expect_err
- test_open_seas.rs
- Backend simulation report: recorded checks on October 1, 2026
- math.rs
- switchboard.rs
- token-flows.ts
- NavResult
- ingestor/src/index.ts
- setup
- Option
- Trade
- worker/src/orders.ts
- Exit
- ApiFault
- social.ts
- token-chain.ts
- Graphify project setup and refresh guide
- ingestor/package.json
- users
- worker/package.json
- funded_user
- exit
- account-routes.ts
- v1-core/src/lib.rs
- test_vote.rs
- qr-deposits.ts
- Local Docker Compose PostgreSQL service
- common/mod.rs
- FakeChain
- pnpm workspace globs
- Fund
- fund_with_member
- db/package.json
- api/package.json
- domain/src/index.ts
- market-stream/package.json
- CreateFund
- dependencies
- ChargeAnnualFee
- logging/package.json
- market-catalog-routes.ts
- Captain flow — v0 developer handoff
- package.json
- market-data/package.json
- market-data/src/client.ts
- MarketBus
- Deposit
- domain/package.json
- logging/src/index.ts
- events.rs
- Whitepaper v1.0: proposed live socially.trade product
- db/src/index.ts
- warp
- Captain profile image uploads
- nav.rs
- UsernameIndex
- privy-fixture.mjs
- Jupiter ingestion and WebSocket integration — v0
- contracts/package.json
- Published simulated SOL/USDC fill model version 1
- README: implemented backend and local development
- swap
- test_policy.rs
- tasks
- Devnet token layer
- v0 UI API integration specification
- compilerOptions
- devnet-setup.mjs
- contracts/src/index.ts
- v1-core
- Config
- 7. Paper orders and trade history
- 5. Accounts and Captain onboarding
- compilerOptions
- compilerOptions
- compilerOptions
- compilerOptions
- ix_queue_venue
- app.ts
- fund_with_kusdc
- ix_add_delegate
- backend-simulation.test.mjs
- api/tsconfig.json
- ingestor/tsconfig.json
- worker/tsconfig.json
- Shared username availability and Redis Bloom index
- 6. Funds and Crew allocation
- contracts/tsconfig.json
- domain/tsconfig.json
- asset-storage.ts
- Captain image storage and CDN costs
- Privy backend authentication
- 8. Performance, charts and records
- 9. Fund activity, chat and decision log
- 017_unified_users.sql
- scripts
- provision-aws.mjs
- Backend service logs
- Paper history API
- Unified user accounts and mobile integration
- devDependencies
- client.test.mjs
- Jupiter account client
- 12. Recommended screen flows
- 2. Shared conventions
- 010_captain_handle_index.sql
- scheduler.test.mjs
- seed-price.ts
- socially.trade v0: Paper Trading Architecture
- 10. Personal inbox
- orders
- build-programs.sh
- v0 paper trading architecture: implementation proposal
- fee_assessments
- messages
- nav_snapshots
- nav_snapshots
- v0 implementation phases
- nav_snapshots
- mock-venue
- v1-core
- price_observations
- nav_snapshots
- Backend simulation report
- socially.trade
- README.md
- Phased v0 delivery plan and recorded backend checkpoints

## God Nodes (most connected - your core abstractions)
1. `expect_err()` - 141 edges
2. `ApiFault` - 102 edges
3. `Env` - 81 edges
4. `warp()` - 79 edges
5. `deposit()` - 72 edges
6. `trading_fund()` - 61 edges
7. `FundHandles` - 60 edges
8. `fund_with_member()` - 52 edges
9. `open_seas()` - 50 edges
10. `funded_user()` - 46 edges

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

## Communities (145 total, 14 thin omitted)

### Community 0 - "test_fund.rs"
Cohesion: 0.14
Nodes (45): deposit(), ix_create_ata(), listed_meme(), refresh_meme(), register_token_with(), SbToken, write_feed(), breaker_trips_on_a_crash_through_the_low_mark() (+37 more)

### Community 1 - "expect_err"
Cohesion: 0.12
Nodes (61): expect_err(), ix_swap(), register_token(), set_usd_price(), Trading, trading_fund(), venue_pool_authority(), buy_bonk() (+53 more)

### Community 2 - "test_open_seas.rs"
Cohesion: 0.11
Nodes (60): read_entry(), token_balance(), a_new_switchboard_output_stores_its_mark(), an_active_mark_is_not_reseeded(), break_meme(), buy_into_a_based_holding_takes_basis_and_caps_after_a_retier(), buy_of(), buy_sol() (+52 more)

### Community 3 - "Backend simulation report: recorded checks on October 1, 2026"
Cohesion: 0.27
Nodes (13): Verified per-asset ledger and projection reconciliation, Verified JWT signature, issuer, audience, expiration and private records, Verified 101-fund valuation, fee and expiration sweeps, Verified retries, rollback, mixed mutation races and exactly-once effects, Backend simulation report: recorded checks on October 1, 2026, Verified 10% high-water-mark fees and 80/20 minted shares, Verified localhost-only disposable schemas and synthetic market data, Untested external integrations and long-duration production operation (+5 more)

### Community 4 - "math.rs"
Cohesion: 0.06
Nodes (37): ErrorCode, empty_reserve_is_one_to_one(), encode_reserve(), fields(), fractional_borrow_keeps_precision(), KaminoRate, parse(), parse_reserve() (+29 more)

### Community 5 - "switchboard.rs"
Cohesion: 0.06
Nodes (50): enc(), encode_price_update(), encode_price_update_ema(), parse(), parse_price_update(), pyth_ok(), pyth_reads_ema(), pyth_short_data() (+42 more)

### Community 6 - "token-flows.ts"
Cohesion: 0.08
Nodes (46): AppOptions, registerAuthRoutes(), CrewChange, privySolanaWallets(), fromRaw(), isWalletAddress(), TokenChain, toRaw() (+38 more)

### Community 7 - "NavResult"
Cohesion: 0.28
Nodes (9): NavResult, price(), price_and_store_mark(), price_with_marks(), Marks, Option, Result, TokenPrice (+1 more)

### Community 8 - "ingestor/src/index.ts"
Cohesion: 0.13
Nodes (15): accounts, bus, jupiter, logs, metadataClient, pool, scheduler, shutdown (+7 more)

### Community 9 - "setup"
Cohesion: 0.10
Nodes (51): LiteSVM, create_mint(), funded(), ix_apply_token(), ix_initialize_config(), ix_queue_token(), price_account(), program_data_address() (+43 more)

### Community 10 - "Option"
Cohesion: 0.33
Nodes (6): custom_code(), Mint, Option, share_mint_state(), ShareMintState, create_fund_mints_one_to_one_and_records_captain()

### Community 11 - "Trade"
Cohesion: 0.06
Nodes (82): add_delegate(), AddDelegate, charge_delegate(), code(), d(), daily_limit_and_reset(), day_volume_overflow_is_math_overflow(), per_trade_limit() (+74 more)

### Community 12 - "worker/src/orders.ts"
Cohesion: 0.12
Nodes (28): runWorkerCycle(), assessDailyFees(), assessFundFee(), eligibleFundBatches(), FundJob, logs, pool, deliverOne() (+20 more)

### Community 13 - "Exit"
Cohesion: 0.19
Nodes (17): charge_fee(), Exit, fresh_pps(), FreshPps, Account, AccountInfo, Box, Context (+9 more)

### Community 14 - "ApiFault"
Cohesion: 0.12
Nodes (25): beginIdempotent(), PositionValue, saveNav(), Valuation, valueFund(), AssetStorage, joinFundInTransaction(), leaveFundInTransaction() (+17 more)

### Community 15 - "social.ts"
Cohesion: 0.17
Nodes (22): finishIdempotent(), joinFund(), leaveFund(), FundEvent, readEvents(), registerFundEventRoutes(), registerFundRoutes(), createFund() (+14 more)

### Community 16 - "token-chain.ts"
Cohesion: 0.10
Nodes (27): app, logs, port, assertDevnetGenesis(), assertNotMainnetUrl(), assertOwnedMint(), BalanceChange, COMPUTE_BUDGET_PROGRAM (+19 more)

### Community 17 - "Graphify project setup and refresh guide"
Cohesion: 0.12
Nodes (14): Repository agent guidance, graphify, This is NOT the Turborepo you know, Read installed Turborepo bundled docs before changing commands or config, Semantic extraction token usage is unknown; no API key required, Graphify project setup and refresh guide, Graphify excludes credentials, generated dependencies and unrelated résumé, Explore (+6 more)

### Community 18 - "ingestor/package.json"
Cohesion: 0.06
Nodes (30): dependencies, ioredis, @socially/db, @socially/domain, @socially/logging, @socially/market-data, @socially/market-stream, devDependencies (+22 more)

### Community 19 - "users"
Cohesion: 0.08
Nodes (26): outbox_events, captain_profiles, funds, instruments, users, api_idempotency, notifications, market_events (+18 more)

### Community 20 - "worker/package.json"
Cohesion: 0.07
Nodes (28): dependencies, @socially/db, @socially/domain, @socially/logging, @socially/market-data, devDependencies, tsx, @types/node (+20 more)

### Community 21 - "funded_user"
Cohesion: 0.13
Nodes (31): E, ata(), create_fund(), decode_events(), events(), expect_anchor_err(), expect_code(), expect_log() (+23 more)

### Community 22 - "exit"
Cohesion: 0.14
Nodes (32): Fn, exit(), mint_usdc(), settle_pps(), assert_paid_at_last_pps(), captain_can_exit_fully_when_alone(), captain_cannot_exit_below_5pct_while_crew_holds(), captain_pays_no_fee() (+24 more)

### Community 23 - "account-routes.ts"
Cohesion: 0.21
Nodes (19): registerAccountRoutes(), Actor, captainProfile(), paramsSchema, registerCaptainProfileRoutes(), myPositions(), accountView(), imageSchema (+11 more)

### Community 24 - "v1-core/src/lib.rs"
Cohesion: 0.05
Nodes (75): ProgramData, apply_token(), apply_venue(), ApplyToken, ApplyVenue, check_due(), eta(), queue_token() (+67 more)

### Community 25 - "test_vote.rs"
Cohesion: 0.23
Nodes (33): venue_data(), big_buy(), big_trade_fails_without_majority(), big_trade_passes_with_majority(), cancelled_proposal_cannot_execute(), crew(), double_vote_rejected(), exactly_half_is_not_a_majority() (+25 more)

### Community 26 - "qr-deposits.ts"
Cohesion: 0.28
Nodes (14): registerQrDepositRoutes(), createQrDeposit(), fundingSummary(), qrEnabled(), qrPaymentFailure(), readQrDeposit(), reconcileQrDeposit(), Row (+6 more)

### Community 27 - "Local Docker Compose PostgreSQL service"
Cohesion: 0.83
Nodes (4): Local Docker Compose PostgreSQL service, Configured pg_isready database health check, Configured PostgreSQL 17 Alpine at localhost port 5432, Configured persistent socially-postgres Docker volume

### Community 28 - "common/mod.rs"
Cohesion: 0.14
Nodes (62): InstructionData, config_pda(), entry_meta(), Env, exit_accounts(), fund_pda(), FundHandles, ix_annual_fee() (+54 more)

### Community 29 - "FakeChain"
Cohesion: 0.12
Nodes (9): FakeChain, fakeSignature(), LIVE, newAddress(), observeRecorded(), requests, rpcReturning(), SIG (+1 more)

### Community 30 - "pnpm workspace globs"
Cohesion: 0.67
Nodes (3): Workspace apps/* packages, pnpm workspace globs, Workspace packages/* packages

### Community 31 - "Fund"
Cohesion: 0.26
Nodes (13): apply_policy(), ApplyPolicy, poke_nav(), PokeNav, Account, Box, Context, Result (+5 more)

### Community 32 - "fund_with_member"
Cohesion: 0.17
Nodes (28): fund_with_member(), inject_holding(), listed_sol(), now(), read_fund(), sol_price(), breaker_freezes_on_ema_drawdown_and_thaws_on_recovery(), breaker_ignores_spot_crash_with_steady_ema() (+20 more)

### Community 33 - "db/package.json"
Cohesion: 0.09
Nodes (21): dependencies, pg, devDependencies, tsx, @types/node, @types/pg, typescript, exports (+13 more)

### Community 34 - "api/package.json"
Cohesion: 0.10
Nodes (19): decimal.js, ioredis, pg, @socially/db, @socially/domain, @socially/logging, @socially/market-data, @socially/market-stream (+11 more)

### Community 35 - "domain/src/index.ts"
Cohesion: 0.24
Nodes (17): calculatePerformanceFee(), PERFORMANCE_FEE_MODEL_VERSION, Amount, fixed(), fixedUp(), MAX_PRICE_AGE_MS, MAX_SIMULATED_ORDER_USDC, parsePositiveAmount() (+9 more)

### Community 36 - "market-stream/package.json"
Cohesion: 0.10
Nodes (19): dependencies, ioredis, @socially/db, devDependencies, @types/node, typescript, exports, ioredis (+11 more)

### Community 37 - "CreateFund"
Cohesion: 0.12
Nodes (19): create_fund(), create_share_mint(), CreateFund, Account, AssociatedToken, Box, Context, Interface (+11 more)

### Community 38 - "dependencies"
Cohesion: 0.11
Nodes (19): dependencies, @aws-sdk/client-s3, @aws-sdk/s3-request-presigner, decimal.js, fastify, @fastify/websocket, ioredis, jose (+11 more)

### Community 39 - "ChargeAnnualFee"
Cohesion: 0.13
Nodes (14): charge_annual_fee(), ChargeAnnualFee, Account, Box, Context, InterfaceAccount, Mint, Program (+6 more)

### Community 40 - "logging/package.json"
Cohesion: 0.11
Nodes (18): dependencies, ioredis, devDependencies, @types/node, typescript, exports, ioredis, @types/node (+10 more)

### Community 41 - "market-catalog-routes.ts"
Cohesion: 0.27
Nodes (5): HistoryRange, historyRanges, MarketCatalog, readHistory(), registerMarketCatalogRoutes()

### Community 42 - "Captain flow — v0 developer handoff"
Cohesion: 0.11
Nodes (18): 10. Review the completed record, 1. Sign in and initialize the account, 2. Create a Captain profile, 3. Resume an existing trial or create a new one, 4. Open the fund dashboard, 5. Preview a paper order, 6. Submit and follow the order, 7. Publish decisions and communicate with Crew (+10 more)

### Community 43 - "package.json"
Cohesion: 0.11
Nodes (17): devDependencies, turbo, typescript, engines, node, typescript, name, packageManager (+9 more)

### Community 44 - "market-data/package.json"
Cohesion: 0.06
Nodes (33): default, types, default, types, default, types, dependencies, ioredis (+25 more)

### Community 45 - "market-data/src/client.ts"
Cohesion: 0.06
Nodes (32): MarketCategory, mintPattern, supportedById, supportedByMint, SupportedToken, supportedTokens, tradableInstrumentIds, ClientOptions (+24 more)

### Community 46 - "MarketBus"
Cohesion: 0.18
Nodes (7): currentPrice(), cursorPattern, MarketBus, MarketEvent, MarketPrice, marketRedis(), StreamEntry

### Community 47 - "Deposit"
Cohesion: 0.12
Nodes (15): Deposit, Account, AssociatedToken, Box, Context, Interface, InterfaceAccount, Mint (+7 more)

### Community 48 - "domain/package.json"
Cohesion: 0.13
Nodes (14): dependencies, decimal.js, devDependencies, typescript, exports, decimal.js, typescript, name (+6 more)

### Community 49 - "logging/src/index.ts"
Cohesion: 0.18
Nodes (9): captureConsole(), Level, levels, LogCollector, LogEntry, LogFilter, redact(), Service (+1 more)

### Community 50 - "events.rs"
Cohesion: 0.24
Nodes (14): BreakerChanged, CaptainLog, Deposited, Exited, FeeCharged, FirstLossApplied, FundCreated, PolicyApplied (+6 more)

### Community 51 - "Whitepaper v1.0: proposed live socially.trade product"
Cohesion: 0.13
Nodes (27): Planned React Native mobile app, Planned protocol revenue: 20% of performance fees, on-ramp share and later Captain Pro, Planned live Captain: approved trader with delegate authority, Planned live Crew: fund investors with proportional shares, Planned public Captain decision log linked to trades, Planned delegate keys with per-key limits, Whitepaper v1.0: proposed live socially.trade product, Planned 30% drawdown safety breaker (+19 more)

### Community 52 - "db/src/index.ts"
Cohesion: 0.23
Nodes (9): appendFundEvent(), createPool(), DbClient, DbPool, inTransaction(), ledgerAccountId(), directory, pool (+1 more)

### Community 53 - "warp"
Cohesion: 0.21
Nodes (20): warp(), annual_fee_not_due_before_a_year(), annual_fee_rejects_captain(), annual_fee_requires_fresh_valid_prices(), annual_fee_uses_the_ema_price(), annual_fee_uses_the_recorded_pps_after_one_step(), annual_fee_whitepaper_example(), annual_fee_zero_below_hwm() (+12 more)

### Community 54 - "Captain profile image uploads"
Cohesion: 0.15
Nodes (13): 1. Reserve an upload, 2. Complete and attach, Authentication and environment, AWS storage setup, Captain profile image uploads, Client flow, Errors, Profile reads and edits (+5 more)

### Community 55 - "nav.rs"
Cohesion: 0.27
Nodes (10): BreakerPps, each_mode_takes_its_side_of_spot_and_ema(), kamino_stake_lower_bound_is_the_lower_of_spot_and_ema_value(), rate_limited(), stake_lower_bound_rejects_a_non_positive_ema(), switchboard_modes_use_the_deposit_mark_and_the_low_mark(), t3_loss_uses_the_high_price_and_skips_a_warming_holding(), token() (+2 more)

### Community 56 - "UsernameIndex"
Cohesion: 0.39
Nodes (3): keys(), UsernameIndex, version()

### Community 57 - "privy-fixture.mjs"
Cohesion: 0.22
Nodes (4): all(), get(), configurePrivyFixture(), @solana/kit

### Community 58 - "Jupiter ingestion and WebSocket integration — v0"
Cohesion: 0.17
Nodes (12): Flow, Jupiter ingestion and WebSocket integration — v0, Limits and existing flows, Modules and persistence, Price and paper execution semantics, Private inbox, Provider and rate budget, Public prices (+4 more)

### Community 59 - "contracts/package.json"
Cohesion: 0.17
Nodes (11): devDependencies, typescript, exports, typescript, name, private, scripts, build (+3 more)

### Community 60 - "Published simulated SOL/USDC fill model version 1"
Cohesion: 0.39
Nodes (9): Simulated mark-based fill does not establish live Jupiter liquidity, Published delayed order execution using fresh observations and policy recheck, DEV_SEED observations restricted to local development, Published simulated SOL/USDC fill model version 1, Published observation limits: age 90s, future 5s, confidence 1%, Published spot-only order cap: 10% NAV and 1000 virtual USDC, Published fill costs: 20bps spread, 10bps fee, size impact, Published SOL 9 decimals and USDC 6 decimals with conservative rounding (+1 more)

### Community 61 - "README: implemented backend and local development"
Cohesion: 0.26
Nodes (13): Implemented authenticated accounts and one-time virtual allowance, Implemented development token and production JWKS JWT adapters, Implemented paper backend only; no frontend or Android app, README: implemented backend and local development, Implemented Captain funds and Crew shares, Pending mobile, external push, risk-adjusted rankings and hardening, Implemented SOL paper order endpoints and worker, Implemented performance, NAV history and personal P&L reads (+5 more)

### Community 62 - "swap"
Cohesion: 0.17
Nodes (11): Context, Interface, InterfaceAccount, Mint, Result, Signer, TokenAccount, TokenInterface (+3 more)

### Community 63 - "test_policy.rs"
Cohesion: 0.15
Nodes (22): Policy, PolicyParams, Pubkey, read_policy(), apply(), apply_rechecks_floor(), below_floor_rejected(), breaker_clears_on_recovery() (+14 more)

### Community 64 - "tasks"
Cohesion: 0.15
Nodes (12): dependsOn, outputs, dependsOn, outputs, cache, passThroughEnv, persistent, $schema (+4 more)

### Community 65 - "Devnet token layer"
Cohesion: 0.17
Nodes (12): Configuration, Deposit (spend / join a Captain), Devnet token layer, Endpoints, External-wallet QR funding, Flows, Limits, Send once (signup grant and withdrawals) (+4 more)

### Community 66 - "v0 UI API integration specification"
Cohesion: 0.18
Nodes (11): 11. Errors and recovery, 13. Current integration gaps, 13. Jupiter market snapshot and WebSocket delivery, 14. Captain profile images and edits, 14. Source map and maintenance, 1. Connection and authentication, 3. Endpoint inventory, 41–42. Captain image upload workflow (+3 more)

### Community 67 - "compilerOptions"
Cohesion: 0.18
Nodes (10): compilerOptions, esModuleInterop, forceConsistentCasingInFileNames, module, moduleResolution, noUncheckedIndexedAccess, resolveJsonModule, skipLibCheck (+2 more)

### Community 68 - "devnet-setup.mjs"
Cohesion: 0.22
Nodes (6): rpc, sleep(), treasuryFloat, waitFor(), @solana-program/system, @solana-program/token

### Community 69 - "contracts/src/index.ts"
Cohesion: 0.20
Nodes (9): ApiError, FundMode, FundStatus, FundSummary, OrderSide, OrderStatus, PAPER_MODE, PaperAmount (+1 more)

### Community 70 - "v1-core"
Cohesion: 0.20
Nodes (9): Build and test, Client notes, Disclosures and accepted risks, Instructions, Open Seas funds and T3 tokens, Out of scope, Pricing, The six promises and what enforces them (+1 more)

### Community 71 - "Config"
Cohesion: 0.36
Nodes (9): compute(), compute_for_usdc_sale(), read_nav(), AccountInfo, Pubkey, token_entry(), vault_amount(), Config (+1 more)

### Community 72 - "7. Paper orders and trade history"
Cohesion: 0.22
Nodes (9): 15. `POST /v0/funds/:fundId/orders/preview`, 16. `POST /v0/funds/:fundId/orders`, 17. `GET /v0/funds/:fundId/orders`, 18. `GET /v0/funds/:fundId/orders/:orderId`, 19. `POST /v0/funds/:fundId/orders/:orderId/cancel`, 20. `GET /v0/captains/:captainId/orders`, 21. `GET /v0/captains/:captainId/trade-statistics`, 22. `GET /v0/me/crew-transactions` (+1 more)

### Community 73 - "5. Accounts and Captain onboarding"
Cohesion: 0.22
Nodes (9): 1. `GET /health`, 2. `POST /v0/auth/privy`, 37. `GET /v0/captains/handle-availability`, 3. `GET /v0/me`, 4. `GET /v0/me/paper-balance`, 5. Accounts and Captain onboarding, 5. `GET /v0/me/paper-positions`, 6. `POST /v0/captains` (+1 more)

### Community 74 - "compilerOptions"
Cohesion: 0.22
Nodes (8): compilerOptions, declaration, outDir, rootDir, types, extends, include, ../../tsconfig.base.json

### Community 75 - "compilerOptions"
Cohesion: 0.22
Nodes (8): compilerOptions, declaration, outDir, rootDir, types, extends, include, ../../tsconfig.base.json

### Community 76 - "compilerOptions"
Cohesion: 0.22
Nodes (8): compilerOptions, declaration, outDir, rootDir, types, extends, include, ../../tsconfig.base.json

### Community 77 - "compilerOptions"
Cohesion: 0.22
Nodes (8): compilerOptions, declaration, outDir, rootDir, types, extends, include, ../../tsconfig.base.json

### Community 78 - "ix_queue_venue"
Cohesion: 0.38
Nodes (11): ix_apply_venue(), ix_queue_venue(), read_venue(), register_venue(), set_venue(), venue_pda(), more_than_four_venues_active_at_once(), venue_apply_waits_7_days_and_activates() (+3 more)

### Community 79 - "app.ts"
Cohesion: 0.11
Nodes (30): authorize(), css, logsCsp, logsHtml, script, registerAdminLogs(), createApp(), registerAuthClientEvents() (+22 more)

### Community 80 - "fund_with_kusdc"
Cohesion: 0.38
Nodes (10): KToken, listed_kusdc(), refresh_kusdc(), write_reserve(), fund_with_kusdc(), nav_rejects_reserve_not_in_registry(), nav_rejects_reserve_of_other_collateral_mint(), nav_rejects_stale_reserve() (+2 more)

### Community 81 - "ix_add_delegate"
Cohesion: 0.39
Nodes (9): delegate_pda(), ix_add_delegate(), captain_log_accepts_delegate_of_this_fund(), captain_log_rejects_delegate_of_other_fund(), captain_log_rejects_stranger(), add_delegate_captain_only(), delegate(), revoke_closes_account() (+1 more)

### Community 82 - "backend-simulation.test.mjs"
Cohesion: 0.39
Nodes (5): ageOrder(), order(), request(), seed(), settled()

### Community 83 - "api/tsconfig.json"
Cohesion: 0.25
Nodes (7): compilerOptions, outDir, rootDir, types, extends, include, ../../tsconfig.base.json

### Community 84 - "ingestor/tsconfig.json"
Cohesion: 0.25
Nodes (7): compilerOptions, outDir, rootDir, types, extends, include, ../../tsconfig.base.json

### Community 85 - "worker/tsconfig.json"
Cohesion: 0.25
Nodes (7): compilerOptions, outDir, rootDir, types, extends, include, ../../tsconfig.base.json

### Community 86 - "Shared username availability and Redis Bloom index"
Cohesion: 0.25
Nodes (7): Configuration and lifecycle, Read flow, Setup, Shared username availability and Redis Bloom index, UI contract, Validation recorded, Write flow and recovery

### Community 87 - "6. Funds and Crew allocation"
Cohesion: 0.25
Nodes (8): 10. `GET /v0/funds/:fundId`, 11. `GET /v0/funds/:fundId/policy`, 12. `GET /v0/funds/:fundId/holdings`, 13. `POST /v0/funds/:fundId/joins`, 14. `POST /v0/funds/:fundId/exits`, 6. Funds and Crew allocation, 8. `POST /v0/funds`, 9. `GET /v0/funds`

### Community 88 - "contracts/tsconfig.json"
Cohesion: 0.25
Nodes (7): compilerOptions, declaration, outDir, rootDir, extends, include, ../../tsconfig.base.json

### Community 89 - "domain/tsconfig.json"
Cohesion: 0.25
Nodes (7): compilerOptions, declaration, outDir, rootDir, extends, include, ../../tsconfig.base.json

### Community 90 - "asset-storage.ts"
Cohesion: 0.29
Nodes (7): AssetKind, MAX_IMAGE_BYTES, UploadFile, Upload, @aws-sdk/client-s3, @aws-sdk/s3-request-presigner, sharp

### Community 91 - "Captain image storage and CDN costs"
Cohesion: 0.29
Nodes (6): Captain image storage and CDN costs, How our flow is billed, Illustrative monthly budgets, Other costs to account for, Rates, Region and billing model

### Community 92 - "Privy backend authentication"
Cohesion: 0.29
Nodes (7): Bootstrap the backend account, Configure the API, Existing authentication and migration, Get your Privy configuration, Privy backend authentication, Use protected endpoints, Verification and errors

### Community 93 - "8. Performance, charts and records"
Cohesion: 0.29
Nodes (7): 23. `GET /v0/funds/:fundId/performance`, 24. `GET /v0/funds/:fundId/history`, 25. `GET /v0/me/funds/:fundId/performance`, 26. `GET /v0/me/paper-record`, 27. `GET /v0/captains/:captainId/paper-record`, 28. `GET /v0/funds/rankings`, 8. Performance, charts and records

### Community 94 - "9. Fund activity, chat and decision log"
Cohesion: 0.29
Nodes (7): 29. `GET /v0/funds/:fundId/events`, 30. `GET /v0/funds/:fundId/events/stream`, 31. `GET /v0/funds/:fundId/messages`, 32. `GET /v0/funds/:fundId/decisions`, 33. `POST /v0/funds/:fundId/messages`, 34. `POST /v0/funds/:fundId/orders/:orderId/notes`, 9. Fund activity, chat and decision log

### Community 95 - "017_unified_users.sql"
Cohesion: 0.48
Nodes (6): advance_username_revision(), username_changed, username_deleted, username_index_state, username_inserted, usernames_truncated

### Community 96 - "scripts"
Cohesion: 0.33
Nodes (6): scripts, assets:setup, build, check-types, dev, start

### Community 97 - "provision-aws.mjs"
Cohesion: 0.33
Nodes (4): envPath, origins, parameters, root

### Community 98 - "Backend service logs"
Cohesion: 0.33
Nodes (5): Access, Backend service logs, Collect all three services, Retention and availability, Verification

### Community 99 - "Paper history API"
Cohesion: 0.33
Nodes (6): Captain history and statistics, Cursor convention, Fund order history, Paper history API, Private Crew transaction timeline, Verification

### Community 100 - "Unified user accounts and mobile integration"
Cohesion: 0.33
Nodes (6): API, Bloom availability, Local development, Schema, Unified user accounts and mobile integration, Validation

### Community 101 - "devDependencies"
Cohesion: 0.40
Nodes (5): devDependencies, tsx, @types/node, @types/ws, typescript

### Community 103 - "Jupiter account client"
Cohesion: 0.33
Nodes (5): Configuration, Jupiter account client, Modules, Request flow, Verification

### Community 104 - "12. Recommended screen flows"
Cohesion: 0.40
Nodes (5): 12. Recommended screen flows, Captain dashboard and trading, Crew discovery and portfolio, Minimal client request helper, Sign-in and account

### Community 105 - "2. Shared conventions"
Cohesion: 0.50
Nodes (4): 2. Shared conventions, Idempotency, Pagination: three separate contracts, Values and identifiers

### Community 106 - "010_captain_handle_index.sql"
Cohesion: 0.67
Nodes (3): advance_captain_handle_revision(), captain_handle_index_state, captain_handle_revision_changed

### Community 110 - "socially.trade v0: Paper Trading Architecture"
Cohesion: 0.08
Nodes (26): 10. Delivery sequence, 11. Path to the whitepaper's live product, 12. Open decisions before implementation, 1. Goal and product contract, 2. Decisions for v0, 3. User flows that the architecture must support, 4. System view, 5. Authoritative data and accounting (+18 more)

### Community 111 - "10. Personal inbox"
Cohesion: 0.67
Nodes (3): 10. Personal inbox, 35. `GET /v0/me/notifications`, 36. `POST /v0/me/notifications/:notificationId/read`

### Community 115 - "v0 paper trading architecture: implementation proposal"
Cohesion: 0.15
Nodes (23): Proposed server-derived identity and fund ownership authorization, Proposed fixed virtual allowance and Captain seed, Proposed decimal money arithmetic and explicit rounding, v0 paper trading architecture: implementation proposal, Proposed 10% high-water-mark fee with 80/20 minted shares, Proposed append-only balanced ledger and immutable fund events, Proposed separate live Solana transaction and indexer write path, Proposed future React Native/Expo client (+15 more)

### Community 128 - "v0 implementation phases"
Cohesion: 0.12
Nodes (17): Backend checkpoints prepared for Phases 6-7, Decisions to settle before their phases, Delivery rules, Implemented backend checkpoint, Jupiter ingestion checkpoints — 4 October 2026, Phase 0 — Repository foundation (complete), Phase 1 — Contracts and database foundation, Phase 2 — Identity, Captain profiles, and trial creation (+9 more)

### Community 154 - "Backend simulation report"
Cohesion: 0.22
Nodes (9): Authentication provider change — October 4, 2026, Backend simulation report, Backend support for user-facing results, Environment and repeatability, History extension — October 4, 2026, Implemented fee and settlement conventions, Problems found and corrected, Scenario coverage (+1 more)

### Community 164 - "socially.trade"
Cohesion: 0.25
Nodes (8): Current state, Devnet token layer, Knowledge graph, Local development, Performance reads, Programs, socially.trade, Trade and Crew history

### Community 187 - "README.md"
Cohesion: 0.28
Nodes (3): Execution assumptions, model version 1, Price source, v0 paper fill model

### Community 230 - "Phased v0 delivery plan and recorded backend checkpoints"
Cohesion: 0.18
Nodes (11): Recorded implemented accounts, shares, execution and social backend checkpoints, Future Phase 6 mobile Captain and Crew flows, Phase-scoped reviewable commits on main, Phased v0 delivery plan and recorded backend checkpoints, Completed foundation: Git, pnpm, Turborepo, TypeScript and health API, Future Phase 9 operational hardening, Recorded implemented performance, fees, trial settlement and retained records, Future risk-adjusted rankings; existing ranking is net return only (+3 more)

## Knowledge Gaps
- **607 isolated node(s):** `name`, `version`, `private`, `type`, `dev` (+602 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 867 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **14 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `Fund` connect `Fund` to `fund_with_member`, `test_open_seas.rs`, `CreateFund`, `ChargeAnnualFee`, `Config`, `Trade`, `Exit`, `Deposit`, `nav.rs`, `v1-core/src/lib.rs`, `common/mod.rs`?**
  _High betweenness centrality (0.042) - this node is a cross-community bridge._
- **Why does `expect_err()` connect `expect_err` to `test_fund.rs`, `fund_with_member`, `test_open_seas.rs`, `math.rs`, `setup`, `ix_queue_venue`, `fund_with_kusdc`, `ix_add_delegate`, `funded_user`, `exit`, `warp`, `test_vote.rs`, `common/mod.rs`, `test_policy.rs`?**
  _High betweenness centrality (0.021) - this node is a cross-community bridge._
- **Why does `read_fund()` connect `fund_with_member` to `test_fund.rs`, `expect_err`, `test_open_seas.rs`, `warp`, `funded_user`, `exit`, `common/mod.rs`, `test_policy.rs`, `Fund`?**
  _High betweenness centrality (0.016) - this node is a cross-community bridge._
- **Are the 134 inferred relationships involving `expect_err()` (e.g. with `initialize_config_rejects_frozen_program()` and `initialize_config_rejects_non_upgrade_authority()`) actually correct?**
  _`expect_err()` has 134 INFERRED edges - model-reasoned connections that need verification._
- **Are the 74 inferred relationships involving `warp()` (e.g. with `harness_warp_advances_clock()` and `more_than_four_venues_active_at_once()`) actually correct?**
  _`warp()` has 74 INFERRED edges - model-reasoned connections that need verification._
- **What connects `name`, `version`, `private` to the rest of the system?**
  _607 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `test_fund.rs` be split into smaller, more focused modules?**
  _Cohesion score 0.14061054579093432 - nodes in this community are weakly interconnected._