# v0 implementation phases

**Goal:** ship a private beta where Captains run simulated funds and Crew join with virtual USDC. The [architecture](./v0-paper-trading-architecture.md) defines the accounting, execution, and product rules. The [whitepaper](../socially-trade-whitepaper.pdf) defines the eventual live product.

Each phase below is a reviewable Git commit on `main`. A phase is complete when its deliverables and exit criteria are met. If a phase needs several commits during development, squash or group them into the named phase commit before moving to the next phase. Keep the whitepaper and architecture in the repository history.

## Phase 0 — Repository foundation (complete)

**Commit:** `chore(phase-0): initialize turborepo and v0 roadmap`

- Initialize Git on `main` with repository-local author `jassBawa <jasspreetsbawa@gmail.com>`.
- Create the pnpm/Turborepo workspace, TypeScript baseline, ignore rules, README, and phase plan.
- Add a runnable API process with `GET /health` reporting `PAPER` mode.
- Pin installed dependency versions and commit the lockfile.

**Exit:** `pnpm install`, `pnpm check-types`, and `pnpm build` complete; the API starts and `/health` responds. This phase provides infrastructure only.

## Phase 1 — Contracts and database foundation

**Commit:** `feat(phase-1): add paper domain contracts and database schema`

- Add `packages/contracts` for public request, response, error, and event schemas; every financial response carries `mode: PAPER`.
- Add `packages/domain` for money, asset quantity, order state, fund state, policy version, and share types. Use decimal or integer arithmetic with documented rounding.
- Add `packages/db` with PostgreSQL migrations for users, Captain profiles, instruments, funds, policies, trials, virtual accounts, ledger entries, events, orders, fills, price observations, share balances, NAV snapshots, messages, and outbox.
- Define unique keys for idempotency and one fill per order; preserve immutable history.
- Add local database configuration and migration scripts, with sample environment variables and no committed secrets.

**Exit:** a fresh database can be created from migrations; generated contracts compile; core uniqueness and accounting constraints are represented in schema. No trading endpoints yet.

## Phase 2 — Identity, Captain profiles, and trial creation

**Commit:** `feat(phase-2): add accounts captains and paper trials`

- Add sign-in/session integration and server-side authorization.
- Give each new account a fixed, nontransferable virtual USDC allowance exactly once.
- Add Captain profile creation and one active 30-day trial per Captain.
- Create a paper fund with fixed policy version, fixed seed amount, initial share price of 1 virtual USDC, and permanent trial timestamps.
- Add fund discovery and detail reads with explicit simulated labels.

**Exit:** a signed-in user can create and view one paper trial; repeated creation or budget grants cannot mint additional virtual funds. Trial start terms cannot be edited after start.

## Phase 3 — Ledger, valuation, and Crew shares

**Commit:** `feat(phase-3): add virtual ledger nav and crew shares`

- Post balanced virtual USDC and share entries for Captain seed, Crew join, and Crew exit.
- Calculate NAV and share price from fund cash and positions using fresh stored prices.
- Lock the fund during joins and exits; use idempotency keys on mutations.
- Keep positions and share balances as rebuildable projections from ledger events.
- Show a stale or unavailable valuation and pause price-dependent mutations when required prices are missing.

**Exit:** joining or leaving preserves share price apart from documented costs and rounding; balances reconcile from ledger entries; retries do not duplicate shares or virtual USDC.

## Phase 4 — Market data and simulation rules

**Commit:** `feat(phase-4): add market observations and fill policy`

- Connect one market-data provider through an adapter, normalize instruments, and store source/receipt timestamps and source references.
- Add a small allowlist of liquid spot assets against virtual USDC.
- Version the fill model: order delay, spread, fee, size-based slippage, liquidity cap, precision, and rejection reasons.
- Add policy evaluation for asset allowlist, position cap, order size, no negative cash or spot positions, and drawdown breaker.
- Document the published fill assumptions shown to users.

**Exit:** given a recorded observation and order, the engine produces the same fill or rejection; stale observations cannot settle an order. No client-provided price is authoritative.

## Phase 5 — Captain order execution and worker

**Commit:** `feat(phase-5): process paper orders through the ledger`

- Add order preview, submit, status, and history endpoints for a fund's Captain.
- Add `apps/worker` to process pending orders after the configured delay.
- Lock fund state while executing; recheck policy at fill time.
- Persist the fill, virtual asset/USDC ledger entries, fund event, position projection, and outbox record atomically.
- Handle worker retries and crashes without duplicate fills; record rejected and cancelled orders.

**Exit:** a Captain can submit a simulated trade and all Crew see the same resulting fund state. Every fill points to a price observation and fill-model version; ledger entries balance per asset.

## Phase 6 — Mobile Captain and Crew experience

**Commit:** `feat(phase-6): add mobile paper fund flows`

- Add `apps/mobile` as a React Native application in the same workspace.
- Build sign-in, discover, fund detail, Captain dashboard, order preview/status, Crew join/leave, and My Money screens.
- Show `Simulated` near balances, returns, trade history, rankings, and alerts.
- Use HTTP snapshots for authoritative reads and a reconnectable real-time feed for new fund events.
- Display stale valuation, pending orders, rejected orders, and partial fills as distinct states.

**Exit:** a user can complete the Captain and Crew core flows on a phone; app refresh or reconnect recovers authoritative state without relying on a push notification.

### Backend checkpoints prepared for Phases 6-7

- `refactor(backend): centralize fund events and ledger accounts` keeps fund event, outbox, and ledger-account writes behind shared transaction-scoped modules.
- `feat(backend): add resumable fund event stream` adds server-sent events with an event-sequence cursor for reconnecting clients.
- `feat(backend): add fund chat and captain decision notes` adds visible chat, order-linked Captain notes, and append-only corrections.
- `feat(backend): deliver fund alerts to an in-app inbox` materializes selected outbox events into durable in-app alerts for current fund participants.
- `refactor(backend): separate app startup and route modules` keeps process setup apart from route registration and domain writes.

These are backend checkpoints, not completion of Phase 6 or 7. The mobile client, moderation actions, external push delivery, and social abuse limits remain to be built.

## Phase 7 — Social record and notifications

**Commit:** `feat(phase-7): add captain decision log and crew activity`

- Add fund chat, Captain trade explanations linked to orders, moderation state, and a chronological public activity feed.
- Deliver trade, fee, policy, and trial alerts from the transactional outbox; retry failed deliveries.
- Preserve the original explanation when a Captain adds a correction.
- Add cursor pagination and event-sequence recovery for chat and activity.

**Exit:** Crew can see what the Captain did and why in order; a failed notification does not change fund state or lose the recorded event.

## Phase 8 — Performance, fees, and trial completion

**Commit:** `feat(phase-8): add verified paper performance and fees`

- Calculate fund share-price returns, max drawdown, Crew net results, trade counts, and trial age from recorded state.
- Assess the simulated 10% high-water-mark fee at most once per UTC day and mint virtual fee shares in the 80/20 Captain/protocol split.
- Publish separate gross and net performance, with the fee-model version and valuation status.
- Close a trial after 30 days without deleting its losing or inactive history; expose permanent Captain paper records.
- Add rankings that account for risk and trial age. Do not merge paper history with any future live history.

**Exit:** displayed performance can be recomputed from stored observations, events, and ledger entries; deposits do not inflate return; fee retries do not duplicate fees.

## Phase 9 — Private beta hardening

**Commit:** `chore(phase-9): harden paper beta operations`

- Add rate limits, account abuse controls, admin audit events, and moderation tools.
- Add projection rebuild and periodic reconciliation commands.
- Add monitoring for market-data lag, pending-order age, stale NAV, outbox backlog, and ledger imbalance.
- Document backup/restore, provider outage, worker restart, and release procedures.
- Review every financial screen and alert for `Simulated` labels and separated paper/live terminology.

**Exit:** a price outage pauses affected actions without fabricating fills; worker restart resumes pending work once; a new deployment can rebuild projections and recover from backup. Invite a small group of Captains and Crew only after this review.

## Delivery rules

- Commit only completed phases. Use the commit messages above so the history follows the product milestones.
- Keep phase changes scoped: infrastructure in 0-1, accounts in 2, accounting in 3, pricing in 4, execution in 5, app in 6, social in 7, records in 8, operations in 9.
- Add focused verification for accounting, order idempotency, pricing freshness, and fees when those phases are implemented. A passing build alone is not evidence that financial calculations are correct.
- Keep all v0 values offchain. The later live product gets its own plan and onchain security review.
- Do not publish paper performance as live performance or treat a simulated fill as evidence of executable market liquidity.

## Decisions to settle before their phases

| Decision | Needed by | Working default |
| --- | --- | --- |
| Virtual allowance and Captain seed | Phase 2 | Fixed per account and trial; choose exact values before UI copy |
| Crew allocation across funds | Phase 3 | One shared virtual USDC allowance; no top-ups |
| Price provider and liquid asset list | Phase 4 | One provider and a small curated allowlist |
| Fill delay, spread, slippage, fee schedule | Phase 4 | Versioned, published parameters; conservative estimates |
| Auth provider | Phase 2 | Managed identity with server-side sessions |
| Mobile visual design and notification provider | Phase 6-7 | Decide when the core flow is ready |
| Captain qualification after trial | Phase 8 | Separate approval from the paper record; no automatic live access |

## References

- [Turborepo repository structure](https://turborepo.dev/docs/crafting-your-repository/structuring-a-repository)
- [Turborepo package management](https://turborepo.dev/docs/crafting-your-repository/managing-dependencies)
- [Turborepo adoption guide](https://turborepo.dev/docs/getting-started/add-to-existing-repository)
