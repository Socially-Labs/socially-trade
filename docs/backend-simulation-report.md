# Backend simulation report

Date: October 1, 2026.

The expanded run passed 49 market/accounting integration scenario groups, 7 production JWT scenario groups, 11 performance calculation/response tests, and 3 fee calculation tests (72 Node test results including the two enclosing integration suites), with no failures, skips, or cancellations. The suite also exercises 40 deterministic market/order scenarios, 12 repeated concurrent join/exit/fill races, 100 static-price round trips, and a 101-fund valuation/fee/settlement sweep. Type checking and builds pass.

This delivery contains backend endpoints and tests only. No frontend or Android application is included.

## Environment and repeatability

Run from the repository root with local PostgreSQL available:

```sh
TEST_DATABASE_URL=postgres://socially:socially@127.0.0.1:5432/socially_trade pnpm test:backend
```

The script accepts only a localhost database connection. Every run creates a randomly named schema, applies all migrations in that schema, and drops the schema in cleanup. Existing application tables and balances are not changed. SQL fixture edits intentionally accelerate order/trial timestamps and inject price observations or failures into this isolated schema.

The market suite removes `PYTH_API_KEY` from its process, uses `DEV_SEED` prices, and guards `fetch` so external HTTP requests fail. The production JWT suite signs local RSA tokens and serves a real JWKS response from localhost; it permits requests only to that local JWKS server. No Pyth key, external provider request, or live trading venue is used. HTTP routes run through Fastify injection; the resumable stream also runs through real localhost HTTP connections.

## Scenario coverage

| Area | Checks |
| --- | --- |
| HTTP validation | Health, missing authentication, malformed JSON, invalid/missing IDs, required idempotency keys, unsupported assets, extra fields, numeric financial values, invalid decimals and precision |
| Identity and trials | Concurrent first sign-in grants one allowance; Captain required; fixed seed; duplicate fund retries; concurrent distinct fund keys produce one active trial; expired trials reject joins and orders |
| Production JWT verification | Localhost JWKS signature verification, concurrent account grant deduplication, expiration, issuer, audience, signature, future not-before, missing subject, malformed/missing bearer token, production rejection of development credentials and forged subject headers |
| Crew shares | Concurrent retry deduplication, insufficient allowance/shares, locked Captain stake, shared allowance across funds, entry/exit after price changes, modeled liquidation cost and share-price rounding |
| Prices | Missing, stale, future and pre-submission observations; order delay; stale holdings block price-dependent mutations; source timestamps preserved; production ignores development price seeds |
| Execution | Buy, sell, oversized orders, oversells, position cap, disabled instrument at fill time, drawdown freeze, permitted sell while frozen, timeout, authorized cancellation, cancellation racing a fill |
| Transactions | Eight workers racing one order create one fill; an injected fill-insert failure rolls back holdings and leaves the order retryable; retry fills once |
| Concurrent balances | Twelve rounds of simultaneous Crew join, Crew exit and trade execution; ledger and projection reconciliation after each round |
| Market simulation | Forty deterministic price/order cases, deterministic fill replay, 100 static-price round trips that cannot create cash, insufficient-cash policy and exact drawdown threshold checks |
| Activity and social | Gap-free numeric event order, pagination beyond 100 events, SSE cursor/Last-Event-ID recovery, one outbox intent per event, chat membership, duplicate posting, Captain-only notes, preserved original notes and corrections, hidden message filtering |
| Notifications | Concurrent delivery deduplication, numeric inbox ordering, owner-only read acknowledgement, idempotent acknowledgement, injected inbox failure with retry, outage-independent delivery |
| Accounting | Each ledger event balances by asset; user/fund cash, SOL holdings, member shares and total fund share supply reconcile exactly with stored ledger entries |
| Performance | Deposits do not inflate returns; gross versus net fee returns; drawdown and recovery; complete loss; missing period history; large/tiny decimals; stale/future current valuations withheld; history gaps, bigint cursor bounds and pagination; final NAV preserved |
| Performance API accuracy | Actual 7/30-day endpoint returns match persisted unit prices; aggregate fees/shares and order counts match SQL records; every history page recovers numeric sequences and exact gross prices; malformed cursor/limit/identifiers reject; ranking order and minimum age match the declared method |
| Fees | Exact 10% above high-water mark, 80/20 minted-share split; no charge for deposits, losses or recovery below the high-water mark; sub-micro fee threshold; eight simultaneous assessments yield one charge; fee/deposit race reconciles |
| Trial completion | Early settlement blocked; stale exposed positions defer completion; cash-only settlement needs no price; six workers settle once; liquidation clears positions; shares burn and cash pays out exactly; pending orders reject after completion; Captain can start another trial while prior records remain |
| Settlement failures | Injected completion-event failure rolls back liquidation, fee and payouts; retry settles once; Crew receive completion inbox alerts after their shares are zeroed; personal realized P&L reconciles with contributions and payouts |
| Private records | Authenticated paper-record reads retain former allocations and completed P&L; per-fund and aggregate personal results agree; anonymous reads reject; unrelated accounts receive their own results only |
| Worker scan limits | 101 independently created/traded funds all receive the newest valuation, eligible fee assessment and expiration settlement; repeating settlement pays nothing again; full ledger/projection reconciliation follows each sweep |

## Problems found and corrected

1. **Request schemas accepted values outside the declared contract.** Fastify's default coercion converted numeric amounts to strings and removed extra fields. Validation now rejects both, including client-supplied prices.
2. **Execution did not recheck instrument activation.** Pending orders could fill after SOL was disabled. The worker now rechecks the instrument before settlement.
3. **Cursor queries sorted numeric values as text.** Event 10 could appear before event 2, causing a client to skip history when resuming. Event, message and notification queries now order by their underlying numeric columns.
4. **Concurrent balance mutations could deadlock.** Foreign-key references acquire key-share locks; `FOR UPDATE` then upgraded locks unnecessarily when balances changed but primary keys did not. Balance and order writers now use `FOR NO KEY UPDATE` to serialize mutations while permitting those references. Repeated mixed mutations and concurrent trial creation pass.
5. **Price ingestion failures stopped unrelated worker jobs.** A failed price fetch previously skipped order timeout processing and inbox delivery. A shared cycle now isolates ingestion, valuation, order processing and notification delivery failures; a simulated ingestion outage still rejects timed-out orders and delivers committed alerts.
6. **New settlement paths need consistent lock ordering.** Crew changes now lock the fund before the user, matching trial settlement; settlements lock multiple users in ID order. This prevents opposing fund/user lock orders.
7. **Terminal Crew alerts cannot rely on active shares.** Completion delivery includes user IDs from recorded payouts, because settlement has already zeroed their shares.
8. **Fee-share rounding can produce a zero Captain allocation.** Zero entries are omitted from the fee ledger; minted shares still reconcile between Captain and protocol. A zero NAV skips fee assessment so settlement can retain a complete-loss record.
9. **Worker sweeps stopped after the first 100 funds.** The regression initially recorded only 100 of 101 valuations. Shared cursor-based candidate scanning now visits the eligible fund range in pages of 100, with a fixed upper ID bounding each sweep. Valuation, fee and expiration jobs use it; all 101 funds reconcile after settlement.

## Backend support for user-facing results

`GET /v0/me/paper-record` includes funds where the caller has a share record even when its remaining shares are zero. Each item contains the fund's public performance and the caller's contribution/redemption/P&L result from recorded events. This keeps a completed or fully redeemed allocation accessible without any frontend. It is authenticated and does not accept a client-supplied user ID.

## Implemented fee and settlement conventions

The first eligible positive gain assessed in each UTC calendar day can incur a fee; no-gain checks do not consume that day. This is not an end-of-day pricing convention. Fees mint shares worth 10% of gains above the post-fee high-water mark, with 80% of minted shares going to the Captain and the remainder to the protocol. Fund NAV does not change during fee minting. Gross returns reverse performance-fee dilution while retaining trading costs.

Expired trials liquidate recorded spot positions with the published 0.2% redemption haircut, assess any eligible fee, redeem all user and protocol shares, and preserve final NAV/share price. User payouts round down to six decimals; protocol redemption includes remaining sub-micro payout dust. All amounts remain virtual and offchain.

Rankings currently order net returns among the most recent 100 funds with current/final valuations and at least seven days of trial age. They expose drawdown and age and explicitly state that they are not risk-adjusted.

## Scope of the result

This validates the implemented paper backend, including performance fees, automatic trial settlement and JWT verification against a localhost JWKS server, under synthetic prices, localhost HTTP and PostgreSQL. It does not validate managed identity-provider account setup or its live sign-in flow, Pyth response parsing against a live provider, external push delivery, deployment/network infrastructure, long-duration load, or a risk-adjusted ranking model. Frontend and Android implementation are outside the requested delivery.

Order/trial clocks are accelerated in test fixtures. Failure tests inject database exceptions and retry transactions; they do not kill an operating-system worker process mid-commit. The results provide regression coverage for these cases, rather than a guarantee against all possible failures.

## History extension — October 4, 2026

The full backend suite passes 80 test results with zero failures, skips or cancellations. Seven new scenario groups plus their enclosing suite check full order and Crew event pagination beyond 100 entries, tied timestamps, stable pages during new submissions, cross-fund Captain history and statistics, partial-fill counts, fill amounts, private settlement fields, Crew exits, authentication and invalid/foreign cursors. Each run uses a disposable local PostgreSQL schema; no Pyth or external market requests are made.
