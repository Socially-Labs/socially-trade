# Backend simulation report

Date: October 1, 2026.

The expanded run passed 44 integration scenario groups, 11 performance calculation/response tests, and 3 fee calculation tests (59 Node test results including the enclosing integration suite), with no failures, skips, or cancellations. The suite also exercises 40 deterministic market/order scenarios, 12 repeated concurrent join/exit/fill races, and 100 static-price round trips. Type checking and builds pass.

## Environment and repeatability

Run from the repository root with local PostgreSQL available:

```sh
TEST_DATABASE_URL=postgres://socially:socially@127.0.0.1:5432/socially_trade pnpm test:backend
```

The script accepts only a localhost database connection. Every run creates a randomly named schema, applies all migrations in that schema, and drops the schema in cleanup. Existing application tables and balances are not changed. SQL fixture edits intentionally accelerate order/trial timestamps and inject price observations or failures into this isolated schema.

The suite removes `PYTH_API_KEY` from its process, uses `DEV_SEED` prices, and guards `fetch` so external HTTP requests fail. No Pyth key, provider request, or live trading venue is used. HTTP routes run through Fastify injection; the resumable stream also runs through real localhost HTTP connections.

## Scenario coverage

| Area | Checks |
| --- | --- |
| HTTP validation | Health, missing authentication, malformed JSON, invalid/missing IDs, required idempotency keys, unsupported assets, extra fields, numeric financial values, invalid decimals and precision |
| Identity and trials | Concurrent first sign-in grants one allowance; Captain required; fixed seed; duplicate fund retries; concurrent distinct fund keys produce one active trial; expired trials reject joins and orders |
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
| Fees | Exact 10% above high-water mark, 80/20 minted-share split; no charge for deposits, losses or recovery below the high-water mark; sub-micro fee threshold; eight simultaneous assessments yield one charge; fee/deposit race reconciles |
| Trial completion | Early settlement blocked; stale exposed positions defer completion; cash-only settlement needs no price; six workers settle once; liquidation clears positions; shares burn and cash pays out exactly; pending orders reject after completion; Captain can start another trial while prior records remain |
| Settlement failures | Injected completion-event failure rolls back liquidation, fee and payouts; retry settles once; Crew receive completion inbox alerts after their shares are zeroed; personal realized P&L reconciles with contributions and payouts |

## Problems found and corrected

1. **Request schemas accepted values outside the declared contract.** Fastify's default coercion converted numeric amounts to strings and removed extra fields. Validation now rejects both, including client-supplied prices.
2. **Execution did not recheck instrument activation.** Pending orders could fill after SOL was disabled. The worker now rechecks the instrument before settlement.
3. **Cursor queries sorted numeric values as text.** Event 10 could appear before event 2, causing a client to skip history when resuming. Event, message and notification queries now order by their underlying numeric columns.
4. **Concurrent balance mutations could deadlock.** Foreign-key references acquire key-share locks; `FOR UPDATE` then upgraded locks unnecessarily when balances changed but primary keys did not. Balance and order writers now use `FOR NO KEY UPDATE` to serialize mutations while permitting those references. Repeated mixed mutations and concurrent trial creation pass.
5. **Price ingestion failures stopped unrelated worker jobs.** A failed price fetch previously skipped order timeout processing and inbox delivery. A shared cycle now isolates ingestion, valuation, order processing and notification delivery failures; a simulated ingestion outage still rejects timed-out orders and delivers committed alerts.
6. **New settlement paths need consistent lock ordering.** Crew changes now lock the fund before the user, matching trial settlement; settlements lock multiple users in ID order. This prevents opposing fund/user lock orders.
7. **Terminal Crew alerts cannot rely on active shares.** Completion delivery includes user IDs from recorded payouts, because settlement has already zeroed their shares.
8. **Fee-share rounding can produce a zero Captain allocation.** Zero entries are omitted from the fee ledger; minted shares still reconcile between Captain and protocol. A zero NAV skips fee assessment so settlement can retain a complete-loss record.

## Implemented fee and settlement conventions

The first eligible positive gain assessed in each UTC calendar day can incur a fee; no-gain checks do not consume that day. This is not an end-of-day pricing convention. Fees mint shares worth 10% of gains above the post-fee high-water mark, with 80% of minted shares going to the Captain and the remainder to the protocol. Fund NAV does not change during fee minting. Gross returns reverse performance-fee dilution while retaining trading costs.

Expired trials liquidate recorded spot positions with the published 0.2% redemption haircut, assess any eligible fee, redeem all user and protocol shares, and preserve final NAV/share price. User payouts round down to six decimals; protocol redemption includes remaining sub-micro payout dust. All amounts remain virtual and offchain.

Rankings currently order net returns among the most recent 100 funds with current/final valuations and at least seven days of trial age. They expose drawdown and age and explicitly state that they are not risk-adjusted.

## Scope of the result

This validates the implemented paper backend, including performance fees and automatic trial settlement, under synthetic prices, localhost HTTP and PostgreSQL. It does not validate real JWKS-provider tokens, Pyth response parsing against a live provider, mobile screens, external push delivery, deployment/network infrastructure, long-duration load, or a risk-adjusted ranking model.

Order/trial clocks are accelerated in test fixtures. Failure tests inject database exceptions and retry transactions; they do not kill an operating-system worker process mid-commit. The results provide regression coverage for these cases, rather than a guarantee against all possible failures.
