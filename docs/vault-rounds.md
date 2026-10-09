# Round-v2 paper implementation

Implementation status: paper funding, trading gates, bounded unwind, immutable settlement, claims, mobile recovery, and WS invalidations implemented. This is a paper pilot implementation, not completion of the entire workspace `docs/plan.md` or a live-custody release.

## Recorded product decisions

On 8 October 2026 the user authorized WS where useful and delegated the pending economic choices ("your call bro"). The implementation selects:

- Exactly 100 paper USDC invested by the Captain; no top-ups or ownership-ratio admission rule.
- Crew minimum 50; total accepted principal minimum 1,000 and cap 30,000, including Captain capital.
- Funding windows 12/24/72 hours; trading durations 3/7/14/21/28/30/60/90/180/365 days. Default 24 hours/14 days.
- Captain and Crew capital locked during trading. Crew can cancel their whole accepted contribution before funding closes. Captain cancellation is permitted only before any historical Crew commitment, including subsequently cancelled commitments.
- One fee at final settlement: 10% of positive net whole-round profit, paid wholly to Captain. Captain also redeems their own investment. No daily dilution or protocol split for v2.
- Each individual entitlement floors to micro-USDC using the immutable final pool/supply. The exact final residue is computed and stored at finalization and retained as a liability. It is never counted as revenue or performance fee. Redistribution requires a separately specified future policy.
- No emergency exit, venue adapter for perps/RWA, or live custody is enabled.

## Implementation and authority

Migrations `021_vault_rounds.sql` `022_vault_media.sql` and `023_vault_performance_rollups.sql` add a model discriminator and tables for immutable round terms, contributions, successful operations, claims, and settlement. Existing funds, cash/share projections, ledger accounts, event sequences and outbox are reused. New rounds have no legacy trial row and cannot enter legacy joins/exits. Legacy orders and trading contexts remain separate adapters; v1 orders use the same checked execution core. Legacy fee and trial completion functions reject v2, including direct invocation.

Lock order for new financial mutations is idempotency row → fund → user. Creation locks the Captain before inserting a new fund. Workers that execute orders retain order → fund; lifecycle/unwind workers never acquire pending-order locks while holding a fund. Read round state and sample `clock_timestamp()` in separate statements after financial locks have been acquired. A joined locking SELECT alone is insufficient: a waiting PostgreSQL query can retain stale joined round fields.

Contributions debit paper cash and issue six-decimal economic shares 1:1 under the same transaction as ledger entries, contribution history, outbox and operation result. Quotes reserve nothing. Failed mutations roll back completely. Successful operation IDs can be recovered using the owner-scoped persisted request key. Definitive transactional rejections are persisted with the owner/key and request hash using a savepoint; retrying the same key replays the same error, and changing its body conflicts. Request-key recovery also returns that rejection. Both use the `vault_request_rejected` error code; an authentication/authorization error alone cannot prove that an earlier request did not commit. Authentication, server, rate and transport failures remain retryable with the original intent.

Each worker pass performs a transition, one asset unwind, or finalization per round. It commits its checkpoint with the corresponding financial changes. Expired execution is rejected even before the keeper runs. A delayed activation retains advertised dates. Missing, future or stale prices delay settlement; they do not zero holdings. The due queue rotates attempts so a blocked round does not starve later rounds. An invariant failure surfaces through the worker's failure reporting and marks the round as requiring reconciliation.

Claims consume the immutable final pool/supply and authenticated member's shares. Investment payout and Captain fee are recorded separately. Claims burn the economic shares and credit paper cash atomically, including zero-value investment claims. Final NAV and investment price remain historical records after payouts. Unclaimed funds and rounding residue remain in the fund, never revenue.

The APK uses generated contracts from `packages/contracts/src/vaults.ts`; run `node scripts/sync-vault-contracts.mjs` after editing them and `--check` in CI. Signed-in Home and Crew Discover use backend round data. Captain creation routes to `/vaults/create`, including the Markets entrypoint. Existing legacy trials remain available for trading. Development-only preview retains the original sample dashboards.

Hourly/daily performance rollups update atomically with persisted NAV snapshots, including contribution marks and final net-of-fee prices. The performance API reads capped indexed bucket ranges. Coverage remains explicitly partial and no returns are annualized.

## Vault artwork

Optional images and banners are attached after creation through owner-only `/v1/vaults/:id/assets/uploads` and `/:uploadId/complete`. They never update Captain profile assets. Storage signing and byte/dimension validation, resizing and publication happen outside financial transactions. A short renewable processing lease serializes completion; expired leases can be recovered after a process restart. Completed upload retries return the same asset without reattaching an older image. User upload budgets and the gateway budget bound requests. Staging bucket lifecycle must remove abandoned uploads; processed objects left after a crash or superseded artwork require a later orphan-cleanup job that excludes attached assets. Real S3 and physical-device media acceptance remain deployment checks; local concurrency tests use a fake storage adapter.

## WS protocol

Connect to `/v1/vaults/ws`, then send:

```json
{"type":"subscribe","vaultIds":["<uuid>"]}
```

Every subscription receives a `resync` invalidation per requested vault. Subsequent `vault.updated` messages contain only `vaultId` and `eventSequence`. Fetch REST detail/position again; a push message never settles or authorizes a financial action. Unknown or missed cursors are harmless because reconnection always refetches a snapshot. The server never forwards raw ledger events, user IDs, balances or payout arrays through this channel.

One bounded database scan per second per gateway serves all subscribers. No SQL loop is created per connection. Limits: 200 gateway connections, 10 per IP, 20 IDs per subscription, 10 client messages per 10 seconds, 8 KiB maximum message payload inherited from Fastify, 64 KiB outbound buffering, and ping/pong liveness. Browser origins follow `WS_ALLOWED_ORIGINS`. A gateway scan failure closes streams to trigger REST fallback. No Redis dependency is added for this first vault transport.

Mobile connections stop on blur/background and resume with REST resync; reconnect uses exponential backoff/jitter. REST refreshes every 15 seconds while disconnected and every 60 seconds while connected. Financial intents are persisted before transport, with exact body/key and subject/mode/vault scope. Unknown outcomes retain that intent. Logout/account changes abort requests and prevent old responses from updating the next account.

## Local enablement and rollback

1. For wallet-valued simulation, apply migration `027_paper_wallet_portfolios.sql` and set `PAPER_WALLET_SNAPSHOT_ENABLED=true`. This mode can coexist with the devnet treasury layer: it uses `users.vault_paper_cash`, with separate USDC ledger accounts `USER / paper-vault:<userId>`. Existing legacy rounds still require an isolated environment without `USDG_MINT`; startup rejects that unsafe combination.
2. Run the standard migration runner, build, then start API and worker. Do not run tests against production; the simulation suites create disposable local schemas.
3. Set `VAULT_PAPER_ENABLED=true`, `VAULT_TERMS_APPROVAL=locked-v1-retain-residue`, and `LIVE_VAULTS_ENABLED=false` for the paper experience. Configure a devnet RPC, server-only `PRIVY_APP_SECRET`, live SOL/USDC market ingestion, allowed HTTP/WS origins and APK API origin normally.
4. To stop new rounds, set `VAULT_PAPER_ENABLED=false`. To pause new contributions too, set `VAULT_CONTRIBUTIONS_PAUSED=true`. Keep the migrated schema, v2 worker, cancellation and claim routes available. Never roll back the schema after funded v2 rounds exist.

The local development database and configuration have been updated for wallet-snapshot paper vaults. No mainnet deployment is involved.

### One-time wallet portfolio

`GET /v1/me/paper-portfolio` reads the authenticated user's initialized state and available virtual USDC. `POST /v1/me/paper-portfolio/initialize` accepts only `{wallet}`. The server verifies Privy wallet ownership, the devnet genesis hash, finalized native SOL and Circle USDC balances, and fresh SOL/USDC USD prices from the market feed. Each nonzero asset needs a current mark no older than 90 seconds; missing marks fail the whole snapshot. Decimal arithmetic floors the combined value to six decimals.

The initialization button copies that USD value into a simulated portfolio exactly once per account and wallet. It builds no transaction, deposits no tokens and never updates redeemable `paper_cash`. Parallel requests serialize the credit; retries return the saved snapshot without another RPC read. The indexed snapshot stores raw amounts, prices, slot and issuance event for audit. This is a demo balance, not proof of ongoing collateral: subsequent wallet transfers and price changes do not replenish or revalue paper cash. Moving tokens between different wallets can seed different demo accounts; paper funds are deliberately non-redeemable.

Each new round persists an immutable `balance_source=WALLET_SNAPSHOT`. Creation, contributions, cancellations and claims use that round's source, including after mode flags change. The $100 seed, $50 Crew minimum and $1,000 total fundraising minimum remain unchanged. Trading, NAV, performance and settlement reuse the paper engine. Wallet send, swap and token withdrawal routes continue using their existing onchain/redeemable balances.

The active APK Create route uses the original harbor layout, banner/image pickers, frosted fields and receipt review. Captain and Crew initialization is explicit; opening a screen never creates a snapshot automatically. Existing onchain recovery and exit routes remain available for previously submitted transactions.

## Verification and outstanding release work

Verified: backend build and typechecks; 162 backend tests, including ledger/supply conservation, idempotent recovery, final-capacity race, post-lock deadline, legacy isolation, real paper execution, stale-price unwind recovery, claims and WS sanitization. APK typecheck and lint pass (one pre-existing native-auth dependency warning); 33 targeted unit tests pass; existing real-HTTP mobile account integration passes. A dedicated real-HTTP vault client test also covers a response lost after commit. Browser creation/review/detail checks pass at 320/390/768 widths; screenshots are in `apk/design-previews/vault-rounds/`.

The complete plan still requires: asynchronous pending/failed operation IDs for future chain mode; full discovery search/sorting; broader mobile account-switch/process-death/device acceptance; production load measurements, dashboards, backup/restore rehearsal and pilot observation. Public v1 activity is sanitized; legacy v0 raw-event privacy remediation remains separate work.

Round-v2 Solana accounts/instructions, IDL/client generation, transaction-intent verification, Privy signing, canonical finalized indexing, reorg/reconciliation tests and independent security review are not implemented or enabled here. No Android device was attached during verification. These remain explicit gates before stages 6–8 and cannot be inferred from paper/browser test success.
