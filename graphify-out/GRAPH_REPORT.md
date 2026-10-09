# Graph Report - backend  (2026-10-10)

## Corpus Check
- 236 files · ~172,786 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 2588 nodes · 6651 edges · 165 communities (127 shown, 20 thin omitted)
- Extraction: 82% EXTRACTED · 18% INFERRED · 0% AMBIGUOUS · INFERRED: 1176 edges (avg confidence: 0.85)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `14334005`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- Env
- expect_err
- warp
- Backend simulation report: recorded checks on October 1, 2026
- math.rs
- switchboard.rs
- token-flows.ts
- Fund
- ingestor/src/index.ts
- setup
- vault-uploads.ts
- Trade
- worker/src/orders.ts
- Exit
- api/src/orders.ts
- errors.ts
- token-chain.ts
- Graphify project setup and refresh guide
- ingestor/package.json
- vault_rounds
- worker/package.json
- ix_deposit
- read_fund
- requireActor
- admin.rs
- vault-routes.ts
- create_fund
- Local Docker Compose PostgreSQL service
- common/mod.rs
- FakeChain
- pnpm workspace globs
- instructions/delegate.rs
- fund_with_member
- db/package.json
- api/package.json
- domain/src/index.ts
- market-stream/package.json
- swap-chain.ts
- dependencies
- pyth.rs
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
- kamino.rs
- Captain profile image uploads
- Captain dashboard API and storage
- CreateFund
- privy-fixture.mjs
- Jupiter ingestion and WebSocket integration — v0
- contracts/package.json
- Published simulated SOL/USDC fill model version 1
- README: implemented backend and local development
- swap
- Round-v2 paper implementation
- tasks
- Devnet token layer
- v0 UI API integration specification
- compilerOptions
- devnet-setup.mjs
- contracts/src/vaults.ts
- v1-core
- sync-vault-contracts.mjs
- 7. Paper orders and trade history
- 5. Accounts and Captain onboarding
- compilerOptions
- compilerOptions
- compilerOptions
- compilerOptions
- ProposeTrade
- app.ts
- ApiFault
- backend-simulation.test.mjs
- api/tsconfig.json
- ingestor/tsconfig.json
- worker/tsconfig.json
- Shared username availability and Redis Bloom index
- 6. Funds and Crew allocation
- contracts/tsconfig.json
- domain/tsconfig.json
- v1-core/src/lib.rs
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
- wallet-swaps.test.mjs
- Policy
- UsernameIndex
- users
- InitializeConfig
- v0 paper fill model
- instruments
- devnet-token.test.mjs
- WriteLog
- TokenEntry
- funds
- Backend simulation report
- Wallet-funded vaults
- live-vaults.test.mjs
- @solana/kit
- vault-rounds-simulation.test.mjs
- token_deposits
- 018_qr_deposits.sql
- 024_captain_dashboard.sql
- 023_vault_performance_rollups.sql
- socially.trade
- jose
- README.md
- Phased v0 delivery plan and recorded backend checkpoints

## God Nodes (most connected - your core abstractions)
1. `ApiFault` - 149 edges
2. `expect_err()` - 141 edges
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

## Communities (165 total, 20 thin omitted)

### Community 0 - "Env"
Cohesion: 0.20
Nodes (24): custom_code(), entry_meta(), Env, exit_accounts(), FundHandles, ix_execute_proposal(), ix_propose(), listed_source() (+16 more)

### Community 1 - "expect_err"
Cohesion: 0.08
Nodes (97): expect_err(), ix_swap(), register_token(), set_usd_price(), Trading, trading_fund(), venue_data(), buy_bonk() (+89 more)

### Community 2 - "warp"
Cohesion: 0.05
Nodes (151): E, Fn, PolicyParams, Tier, decode_events(), deposit(), exit(), inject_holding() (+143 more)

### Community 3 - "Backend simulation report: recorded checks on October 1, 2026"
Cohesion: 0.27
Nodes (13): Verified per-asset ledger and projection reconciliation, Verified JWT signature, issuer, audience, expiration and private records, Verified 101-fund valuation, fee and expiration sweeps, Verified retries, rollback, mixed mutation races and exactly-once effects, Backend simulation report: recorded checks on October 1, 2026, Verified 10% high-water-mark fees and 80/20 minted shares, Verified localhost-only disposable schemas and synthetic market data, Untested external integrations and long-duration production operation (+5 more)

### Community 4 - "math.rs"
Cohesion: 0.08
Nodes (18): ErrorCode, bps_of(), fee_below_one_share_keeps_hwm(), fee_whitepaper_priya(), fee_with_zero_pps_gives_zero_fee_shares(), FeeOutcome, mul_div_floor(), no_fee_at_hwm() (+10 more)

### Community 5 - "switchboard.rs"
Cohesion: 0.11
Nodes (36): age_counts_from_the_oldest_sample(), an_idle_mark_reseeds_at_the_value_and_warms_again(), at_value(), deposit_mark_is_the_ema_and_the_cut_fits_the_highest_value(), deposit_mark_moves_once_per_interval(), deposit_mark_stays_two_way_during_the_warmup(), deposit_mark_step_is_at_most_ten_percent_both_ways(), encode_feed() (+28 more)

### Community 6 - "token-flows.ts"
Cohesion: 0.07
Nodes (51): CrewChange, myPositions(), registerQrDepositRoutes(), createQrDeposit(), fundingSummary(), qrEnabled(), qrPaymentFailure(), readQrDeposit() (+43 more)

### Community 7 - "Fund"
Cohesion: 0.14
Nodes (28): BreakerPps, compute(), compute_for_usdc_sale(), each_mode_takes_its_side_of_spot_and_ema(), kamino_stake_lower_bound_is_the_lower_of_spot_and_ema_value(), NavResult, price(), price_and_store_mark() (+20 more)

### Community 8 - "ingestor/src/index.ts"
Cohesion: 0.13
Nodes (15): accounts, bus, jupiter, logs, metadataClient, pool, scheduler, shutdown (+7 more)

### Community 9 - "setup"
Cohesion: 0.11
Nodes (50): LiteSVM, create_mint(), funded(), ix_apply_token(), ix_apply_venue(), ix_initialize_config(), ix_queue_token(), ix_queue_venue() (+42 more)

### Community 10 - "vault-uploads.ts"
Cohesion: 0.18
Nodes (10): AssetKind, AssetStorage, MAX_IMAGE_BYTES, UploadFile, Upload, completeVaultUpload(), registerVaultUploadRoutes(), reserveVaultUpload() (+2 more)

### Community 11 - "Trade"
Cohesion: 0.14
Nodes (38): apply_t3(), burn_nav(), call_venue(), captain_stake(), CaptainStake, CaptainStake<'_, 'info>, clean_vault_amount(), execute_swap() (+30 more)

### Community 12 - "worker/src/orders.ts"
Cohesion: 0.10
Nodes (32): runWorkerCycle(), assessDailyFees(), assessFundFee(), eligibleFundBatches(), FundJob, logs, pool, deliverOne() (+24 more)

### Community 13 - "Exit"
Cohesion: 0.08
Nodes (33): charge_fee(), Exit, fresh_pps(), FreshPps, Account, AccountInfo, Box, Context (+25 more)

### Community 14 - "api/src/orders.ts"
Cohesion: 0.23
Nodes (16): HistoryQuery, historySchema, orderHistory(), page(), registerHistoryRoutes(), registerOrderRoutes(), amount(), authorize() (+8 more)

### Community 15 - "errors.ts"
Cohesion: 0.12
Nodes (33): beginIdempotent(), finishIdempotent(), PositionValue, saveNav(), Valuation, valueFund(), joinFund(), joinFundInTransaction() (+25 more)

### Community 16 - "token-chain.ts"
Cohesion: 0.12
Nodes (24): assertDevnetGenesis(), assertNotMainnetUrl(), assertOwnedMint(), BalanceChange, COMPUTE_BUDGET_PROGRAM, createDevnetChain(), sign(), DEVNET_GENESIS_HASH (+16 more)

### Community 17 - "Graphify project setup and refresh guide"
Cohesion: 0.12
Nodes (14): Repository agent guidance, graphify, This is NOT the Turborepo you know, Read installed Turborepo bundled docs before changing commands or config, Semantic extraction token usage is unknown; no API key required, Graphify project setup and refresh guide, Graphify excludes credentials, generated dependencies and unrelated résumé, Explore (+6 more)

### Community 18 - "ingestor/package.json"
Cohesion: 0.06
Nodes (30): dependencies, ioredis, @socially/db, @socially/domain, @socially/logging, @socially/market-data, @socially/market-stream, devDependencies (+22 more)

### Community 19 - "vault_rounds"
Cohesion: 0.24
Nodes (13): protect_vault_terms(), fund_events, vault_claims, vault_contributions, vault_operations, vault_rounds, vault_terms_immutable, vault_asset_uploads (+5 more)

### Community 20 - "worker/package.json"
Cohesion: 0.07
Nodes (28): dependencies, @socially/db, @socially/domain, @socially/logging, @socially/market-data, devDependencies, tsx, @types/node (+20 more)

### Community 21 - "ix_deposit"
Cohesion: 0.18
Nodes (20): ix_deposit(), ix_poke_nav(), KToken, listed_kusdc(), now(), price_account(), refresh_kusdc(), set_price() (+12 more)

### Community 22 - "read_fund"
Cohesion: 0.12
Nodes (37): expect_anchor_err(), ix_exit(), ix_exit_unpriced(), mint_usdc(), read_fund(), write_fund(), assert_paid_at_last_pps(), captain_cannot_exit_below_5pct_while_crew_holds() (+29 more)

### Community 23 - "requireActor"
Cohesion: 0.15
Nodes (27): registerAccountRoutes(), Actor, identity(), requireActor(), registerAuthRoutes(), tokenLayerOn(), captainProfile(), paramsSchema (+19 more)

### Community 24 - "admin.rs"
Cohesion: 0.16
Nodes (23): apply_token(), apply_venue(), ApplyToken, ApplyVenue, check_due(), eta(), queue_token(), queue_venue() (+15 more)

### Community 25 - "vault-routes.ts"
Cohesion: 0.20
Nodes (25): vaultPerformance(), empty, page, params, registerVaultRoutes(), uuid, cancelContribution(), claimVault() (+17 more)

### Community 26 - "create_fund"
Cohesion: 0.23
Nodes (16): create_fund(), events(), expect_code(), expect_log(), poke(), FailedTransactionMetadata, Keypair, Result (+8 more)

### Community 27 - "Local Docker Compose PostgreSQL service"
Cohesion: 0.83
Nodes (4): Local Docker Compose PostgreSQL service, Configured pg_isready database health check, Configured PostgreSQL 17 Alpine at localhost port 5432, Configured persistent socially-postgres Docker volume

### Community 28 - "common/mod.rs"
Cohesion: 0.14
Nodes (46): InstructionData, ata(), config_pda(), fund_pda(), ix_annual_fee(), ix_apply_policy(), ix_cancel_proposal(), ix_compute_limit() (+38 more)

### Community 29 - "FakeChain"
Cohesion: 0.18
Nodes (3): FakeChain, fakeSignature(), sleep()

### Community 30 - "pnpm workspace globs"
Cohesion: 0.67
Nodes (3): Workspace apps/* packages, pnpm workspace globs, Workspace packages/* packages

### Community 31 - "instructions/delegate.rs"
Cohesion: 0.15
Nodes (24): add_delegate(), AddDelegate, charge_delegate(), code(), d(), daily_limit_and_reset(), day_volume_overflow_is_math_overflow(), per_trade_limit() (+16 more)

### Community 32 - "fund_with_member"
Cohesion: 0.12
Nodes (39): delegate_pda(), fund_with_member(), funded_user(), ix_add_delegate(), ix_revoke_delegate(), read_account(), captain_can_exit_fully_when_alone(), annual_fee_not_due_before_a_year() (+31 more)

### Community 33 - "db/package.json"
Cohesion: 0.09
Nodes (21): dependencies, pg, devDependencies, tsx, @types/node, @types/pg, typescript, exports (+13 more)

### Community 34 - "api/package.json"
Cohesion: 0.09
Nodes (21): decimal.js, ioredis, pg, @socially/db, @socially/domain, @socially/logging, @socially/market-data, @socially/market-stream (+13 more)

### Community 35 - "domain/src/index.ts"
Cohesion: 0.13
Nodes (27): calculatePerformanceFee(), PERFORMANCE_FEE_MODEL_VERSION, Amount, fixed(), fixedUp(), MAX_PRICE_AGE_MS, MAX_SIMULATED_ORDER_USDC, parsePositiveAmount() (+19 more)

### Community 36 - "market-stream/package.json"
Cohesion: 0.10
Nodes (19): dependencies, ioredis, @socially/db, devDependencies, @types/node, typescript, exports, ioredis (+11 more)

### Community 37 - "swap-chain.ts"
Cohesion: 0.05
Nodes (52): connection, instruction, programData, signer, tx, connection, deployer, program (+44 more)

### Community 38 - "dependencies"
Cohesion: 0.10
Nodes (20): dependencies, @aws-sdk/client-s3, @aws-sdk/s3-request-presigner, decimal.js, fastify, @fastify/websocket, ioredis, jose (+12 more)

### Community 39 - "pyth.rs"
Cohesion: 0.13
Nodes (14): enc(), encode_price_update(), encode_price_update_ema(), parse(), parse_price_update(), pyth_ok(), pyth_reads_ema(), pyth_short_data() (+6 more)

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
Cohesion: 0.10
Nodes (20): devDependencies, turbo, typescript, engines, node, typescript, name, @types/ws (+12 more)

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

### Community 53 - "kamino.rs"
Cohesion: 0.21
Nodes (19): empty_reserve_is_one_to_one(), encode_reserve(), fields(), fractional_borrow_keeps_precision(), KaminoRate, parse(), parse_reserve(), parses_live_kusdc_reserve() (+11 more)

### Community 54 - "Captain profile image uploads"
Cohesion: 0.15
Nodes (13): 1. Reserve an upload, 2. Complete and attach, Authentication and environment, AWS storage setup, Captain profile image uploads, Client flow, Errors, Profile reads and edits (+5 more)

### Community 55 - "Captain dashboard API and storage"
Cohesion: 0.25
Nodes (7): Captain dashboard API and storage, Checks, Definitions, History semantics, Home states and actions, Routes, Storage

### Community 56 - "CreateFund"
Cohesion: 0.12
Nodes (19): create_fund(), create_share_mint(), CreateFund, Account, AssociatedToken, Box, Context, Interface (+11 more)

### Community 57 - "privy-fixture.mjs"
Cohesion: 0.31
Nodes (3): all(), get(), configurePrivyFixture()

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

### Community 63 - "Round-v2 paper implementation"
Cohesion: 0.25
Nodes (7): Implementation and authority, Local enablement and rollback, Recorded product decisions, Round-v2 paper implementation, Vault artwork, Verification and outstanding release work, WS protocol

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

### Community 69 - "contracts/src/vaults.ts"
Cohesion: 0.10
Nodes (18): ApiError, FundMode, FundStatus, FundSummary, OrderSide, OrderStatus, PAPER_MODE, PaperAmount (+10 more)

### Community 70 - "v1-core"
Cohesion: 0.20
Nodes (9): Build and test, Client notes, Disclosures and accepted risks, Instructions, Open Seas funds and T3 tokens, Out of scope, Pricing, The six promises and what enforces them (+1 more)

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

### Community 78 - "ProposeTrade"
Cohesion: 0.19
Nodes (22): cancel_proposal(), CancelProposal, CastVote, execute_proposal(), ExecuteProposal, propose_trade(), ProposeTrade, Account (+14 more)

### Community 79 - "app.ts"
Cohesion: 0.08
Nodes (32): authorize(), css, logsCsp, logsHtml, script, registerAdminLogs(), AppOptions, createApp() (+24 more)

### Community 81 - "ApiFault"
Cohesion: 0.11
Nodes (30): ApiFault, params, raw, registerLiveVaultRoutes(), Row, startLiveVaultWorker(), uuid, view() (+22 more)

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

### Community 90 - "v1-core/src/lib.rs"
Cohesion: 0.27
Nodes (18): add_delegate(), apply_policy(), apply_venue(), cancel_proposal(), charge_annual_fee(), create_fund(), deposit(), execute_proposal() (+10 more)

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

### Community 141 - "wallet-swaps.test.mjs"
Cohesion: 0.18
Nodes (11): config, instruction(), meta(), native, poolId, quote(), response(), str (+3 more)

### Community 142 - "Policy"
Cohesion: 0.21
Nodes (13): apply_policy(), ApplyPolicy, poke_nav(), PokeNav, Account, Box, Context, Result (+5 more)

### Community 143 - "UsernameIndex"
Cohesion: 0.39
Nodes (3): keys(), UsernameIndex, version()

### Community 144 - "users"
Cohesion: 0.18
Nodes (10): users, api_idempotency, deposit_prepares, support_requests, wallet_swap_quotes, wallet_swap_requests, wallet_swaps, live_vault_transactions (+2 more)

### Community 145 - "InitializeConfig"
Cohesion: 0.15
Nodes (13): ProgramData, handler(), InitializeConfig, Account, Context, InterfaceAccount, Mint, Program (+5 more)

### Community 146 - "v0 paper fill model"
Cohesion: 0.67
Nodes (3): Execution assumptions, model version 1, Price source, v0 paper fill model

### Community 147 - "instruments"
Cohesion: 0.27
Nodes (8): instruments, market_events, market_feed_state, market_latest, market_samples, market_token_metadata, market_watchlist, price_observations

### Community 148 - "devnet-token.test.mjs"
Cohesion: 0.25
Nodes (6): LIVE, newAddress(), observeRecorded(), requests, rpcReturning(), SIG

### Community 149 - "WriteLog"
Cohesion: 0.22
Nodes (9): captain_log(), Account, Box, Context, Option, Result, Signer, WriteLog (+1 more)

### Community 150 - "TokenEntry"
Cohesion: 0.27
Nodes (9): QueueToken, InterfaceAccount, Mint, queue_token(), Marks, PriceSource, Marks, Pubkey (+1 more)

### Community 152 - "funds"
Cohesion: 0.29
Nodes (5): outbox_events, captain_profiles, funds, notifications, captain_asset_uploads

### Community 154 - "Backend simulation report"
Cohesion: 0.22
Nodes (9): Authentication provider change — October 4, 2026, Backend simulation report, Backend support for user-facing results, Environment and repeatability, History extension — October 4, 2026, Implemented fee and settlement conventions, Problems found and corrected, Scenario coverage (+1 more)

### Community 156 - "Wallet-funded vaults"
Cohesion: 0.33
Nodes (5): Contract terms and current scope, Deployment handoff, Funding, Routes, Wallet-funded vaults

### Community 160 - "token_deposits"
Cohesion: 0.50
Nodes (4): fund_events, token_deposits, token_payouts, user_wallets

### Community 161 - "018_qr_deposits.sql"
Cohesion: 0.50
Nodes (4): qr_deposit_attempts, qr_deposits, fund_events, token_deposit_receipts

### Community 162 - "024_captain_dashboard.sql"
Cohesion: 0.60
Nodes (4): captain_aum_phase, captain_aum_snapshot, captain_vault_aum_rollups, record_captain_vault_aum()

### Community 163 - "023_vault_performance_rollups.sql"
Cohesion: 0.67
Nodes (3): record_vault_performance(), vault_performance_rollups, vault_performance_snapshot

### Community 164 - "socially.trade"
Cohesion: 0.25
Nodes (8): Current state, Devnet token layer, Knowledge graph, Local development, Performance reads, Programs, socially.trade, Trade and Crew history

### Community 230 - "Phased v0 delivery plan and recorded backend checkpoints"
Cohesion: 0.18
Nodes (11): Recorded implemented accounts, shares, execution and social backend checkpoints, Future Phase 6 mobile Captain and Crew flows, Phase-scoped reviewable commits on main, Phased v0 delivery plan and recorded backend checkpoints, Completed foundation: Git, pnpm, Turborepo, TypeScript and health API, Future Phase 9 operational hardening, Recorded implemented performance, fees, trial settlement and retained records, Future risk-adjusted rankings; existing ranking is net return only (+3 more)

## Knowledge Gaps
- **679 isolated node(s):** `name`, `version`, `private`, `type`, `dev` (+674 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 960 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **20 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `Fund` connect `Fund` to `warp`, `Trade`, `Exit`, `Policy`, `Deposit`, `ProposeTrade`, `WriteLog`, `read_fund`, `CreateFund`, `instructions/delegate.rs`?**
  _High betweenness centrality (0.026) - this node is a cross-community bridge._
- **Why does `ApiFault` connect `ApiFault` to `swap-chain.ts`, `token-flows.ts`, `market-catalog-routes.ts`, `vault-uploads.ts`, `api/src/orders.ts`, `errors.ts`, `app.ts`, `requireActor`, `vault-routes.ts`?**
  _High betweenness centrality (0.019) - this node is a cross-community bridge._
- **Why does `expect_err()` connect `expect_err` to `fund_with_member`, `Env`, `warp`, `math.rs`, `setup`, `ix_deposit`, `read_fund`, `create_fund`, `common/mod.rs`?**
  _High betweenness centrality (0.014) - this node is a cross-community bridge._
- **Are the 134 inferred relationships involving `expect_err()` (e.g. with `initialize_config_rejects_frozen_program()` and `initialize_config_rejects_non_upgrade_authority()`) actually correct?**
  _`expect_err()` has 134 INFERRED edges - model-reasoned connections that need verification._
- **Are the 74 inferred relationships involving `warp()` (e.g. with `harness_warp_advances_clock()` and `more_than_four_venues_active_at_once()`) actually correct?**
  _`warp()` has 74 INFERRED edges - model-reasoned connections that need verification._
- **What connects `name`, `version`, `private` to the rest of the system?**
  _679 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `expect_err` be split into smaller, more focused modules?**
  _Cohesion score 0.08080808080808081 - nodes in this community are weakly interconnected._