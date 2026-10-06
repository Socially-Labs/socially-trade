# Devnet token layer

The product is paper trading. Only money in and out touches Solana devnet, with one SPL
test token that we create and control: **Test USDC (devnet)** (previously labeled USDG; `USDG_MINT` remains the configuration key), 6 decimals. One token equals one
paper USDC. Trades, P&L, fees and Captains stay in the paper ledger. No Anchor program is used.

The layer is on when `USDG_MINT` is set. Without it the API behaves as before (10,000
virtual USDC on signup, no chain calls).

## Flows

| Flow | Who signs | Paper effect | Chain effect |
| --- | --- | --- | --- |
| Signup grant | backend (mint authority; treasury pays the fee) | none, paper cash starts at 0 (a legacy account converts its cash, see below) | `MintToChecked` of `SIGNUP_GRANT` to the user's token account (created if missing) |
| Deposit | user wallet (treasury pays the fee) | paper cash + X, optionally a fund join of X | `TransferChecked` of X from the user's token account to the treasury token account |
| Withdraw | backend (treasury) | paper cash - X (or a fund exit, then its payout) | `TransferChecked` of X from the treasury to the user's token account (created if missing) |

### External-wallet QR funding

The mobile Deposit and Receive actions create Solana Pay SPL transfer requests. Funds go to
our treasury owner; the transfer lands in its associated token account. The backend credits
`users.paper_cash`, the same ledger projection Captain joins/exits already use. This is one
available trading balance, with Captain allocations shown separately. The token is our controlled
6-decimal devnet test mint, not Circle-issued mainnet USDC. The trading engine remains simulated.

Endpoints (Privy bearer authentication; `Cache-Control: no-store`):

| Endpoint | Behavior |
| --- | --- |
| `GET /v0/me/wallet` | Enabled flag, devnet token, available USDC, Captain positions and latest 50 QR requests; one repeatable-read snapshot. |
| `POST /v0/me/qr-deposits` | Body `{ "amount": "12.345678" }`, required `Idempotency-Key`; creates/replays one owned payment request. |
| `GET /v0/me/qr-deposits/:id` | Owned request status; another account receives 404. Does not wait on RPC. |

Requests accept 1–1,000,000 tokens, at most six fractional digits, with at most 20 requests
per user/hour. Decimal strings stay exact. Each request has a new random public-key reference,
pinned mint/treasury and a 30-minute display lifetime. `canPay` disables an expired request or
one from another token configuration. Scan the QR with a Solana Pay compatible wallet set to
devnet. A plain address transfer without the reference cannot be attributed safely.

The API process starts a background reconciler. It discovers confirmed signatures by reference,
pages through results in batches of 100, then checks each finalized transaction using both
`jsonParsed` and compiled `json` account data. The reference must be read-only, non-signing and
attached to the token transfer instruction, not just present elsewhere in the transaction.
It checks success, configured token/program/destination, exactly one token transfer, exact
amount and matching source/treasury balance deltas. Sender ownership of a Privy wallet is not
required. Arbitrary instructions, multi-reference transfers and mismatched amounts are rejected.

`WAITING → CONFIRMING → CONFIRMED` describes a matching payment. An invalid attempt does not
consume the request: a later valid payment can succeed. Failed or wrong-amount payments are
recorded without credit; retain their signatures for support, as there is no automatic refund
flow. Each distinct valid payment is credited, including two actual payments to one request;
reprocessing the same signature never credits again. `creditedAmount` reports the total received.

`token_deposit_receipts` prevents duplicate credit across QR and existing deposit APIs. Legacy
claims cannot redirect a referenced QR payment to the sender's own account, even before the
background worker runs. Linking a personal wallet after a verified deposit preserves the trading
balance and does not convert it into another mint grant.

Requests, cursors, attempts and credits persist in Postgres. Multiple workers claim bounded work
with database leases and `SKIP LOCKED`; a crash is retried after five minutes. Chain reads hold
no database transaction open. Successful credit, receipt and balanced ledger event commit
atomically. RPC failures retain pending work and retry after 15 seconds. Active requests scan
about every five seconds; expired requests remain monitored hourly so late finalized payments
can still credit. Lease/queue load can increase those timings. Pending confirmations rotate to
prevent an old unresolved signature blocking later payments.

Local setup: apply migrations with `pnpm db:migrate`, run `node apps/api/scripts/devnet-setup.mjs`,
load its `DEVNET_RPC_URL`, `USDG_MINT`, `MINT_AUTHORITY` and `TREASURY` into the server environment,
and restart `pnpm dev:api`. Generated secrets stay in ignored `.env.devnet.local`; never put them
in Expo public variables. The sender needs this exact test mint and devnet SOL for fees. Android
uses the configured local API origin (`adb reverse tcp:3000 tcp:3000` for USB localhost).
Rebuild the development client after adding the native `expo-clipboard` module.

Verification: QR integration tests cover amount/network validation, ownership, replay, concurrent
credits, rejected attempts, pagination, late finalization, outages, wallet linking and cross-API
credit protection. Recorded transactions test reference account decoding. A real devnet transfer
of 12.345678 test tokens was detected/finalized/credited once, and browser UI checks at 320/393/430
pixels covered QR rendering, invalid amounts, reload recovery and balance updates. Physical
Android scanning and real Privy login remain separate device acceptance checks.

Protocol reference: [Solana Pay specification](https://docs.solanapay.com/spec).

### Signup grant
`POST /v0/auth/privy` binds one Solana wallet to the user and mints the grant.

- Wallet source: with `PRIVY_APP_SECRET`, the backend reads the Privy user record
  (`GET https://api.privy.io/v1/users/{did}`) and takes the embedded Solana wallet. A
  `walletAddress` in the body must be one of the user's linked Solana wallets (else 403
  `wallet_not_linked`). Privy access tokens do not carry wallets.
- Without the secret the bind fails closed in every `NODE_ENV`: 503
  `wallet_verification_unconfigured`. For local testing only, `DEV_ALLOW_UNVERIFIED_WALLET=1`
  accepts the body `walletAddress` after base58 validation. The server refuses to start with it
  unless `DEVNET_RPC_URL` is localhost or a devnet host, and it logs a warning at startup.
- The binding is permanent: another address returns 409 `wallet_mismatch`. An address bound
  to another user returns 409 `wallet_in_use`.
- The grant is decided in the same database transaction as the bind, under the user row lock:
  - paper cash above 0 (an account from before the layer was on): the grant equals the current
    paper cash (truncated to 6 places) and paper cash becomes 0. A `devnet_paper_converted`
    ledger event moves the cash to the treasury account, so the value moves to the chain once and
    does not double;
  - no paper cash and no ledger history: `SIGNUP_GRANT`;
  - no paper cash but ledger history (for example all cash in a fund): no grant. A later fund
    exit gives paper cash that the user can withdraw as usual.
- At most one grant or conversion per user, ever: a partial unique index allows one
  `SIGNUP_GRANT` row per user, and the bind happens once. Switching the layer off and on cannot
  grant again. Retries and parallel calls drive the same row (see "Send once" below).

### Deposit (spend / join a Captain)
1. `POST /v0/me/deposits/prepare { amountUsdc }` returns a base64 v0 transaction with one
   `TransferChecked`. The treasury is the fee payer and has already signed. The user's wallet
   needs no SOL. Each user can prepare `PREPARE_RATE_PER_HOUR` (default 20) transactions per
   hour, else 429 `rate_limited`.
2. The app signs it with the Privy wallet and sends it to devnet.
3. `POST /v0/me/deposits { signature, amountUsdc, fundId? }` claims it. The backend fetches the
   transaction (`getTransaction`, commitment `finalized`, `jsonParsed`) and requires all of:
   - no transaction error (else `transaction_failed`);
   - exactly one top-level instruction, an SPL Token `transferChecked` (compute budget
     instructions aside), and no inner instructions (else `unexpected_instruction`);
   - the transfer is of our mint (else `wrong_mint`);
   - the destination is the treasury token account (else `wrong_destination`);
   - the transfer authority is the user's bound wallet and the source token account is owned by
     it (else `wrong_owner`);
   - the instruction amount and both token balance changes equal X exactly (else `wrong_amount`).
4. Only then the paper ledger is credited. With `fundId`, the fund join runs in the same
   database transaction under a savepoint. If the join is refused (for example
   `captain_seed_fixed` or `fund_not_active`), the credit stays as paper cash and
   `deposit.join.error` names the reason.

States: `PENDING` -> `CONFIRMED` | `FAILED` | `EXPIRED`. `PENDING` (HTTP 202) means devnet has
not finalized the transaction yet (about 13 s after it lands). A claim becomes `EXPIRED` only when
all of these are true: no finalized transaction; `getSignatureStatuses` does not know the
signature (a processed or confirmed transaction stays `PENDING`); the finalized block height
passed the claim's expiry height; and `DEPOSIT_EXPIRY_SECONDS` (default 300) passed. The expiry
height is set the first time the signature is missing: the processed tip then, plus 300 blocks
(150 for the blockhash lifetime, 150 for an RPC node behind the tip). `EXPIRED` is not final: a
later `GET` that finds the transaction finalized credits it once (or marks it `FAILED`).
`CONFIRMED` and `FAILED` never change.

Idempotency and races: a claim is unique per `(signature, user)`. The chain read runs with no
database transaction open. The credit runs in a short transaction under the claim row lock and
only while the row still has the status the call read (`PENDING` or `EXPIRED`), so 5 parallel
confirms credit once. A second partial unique index allows one
`CONFIRMED` row per signature across all users. A stranger who posts someone else's signature
gets `FAILED wrong_owner` on their own claim and does not block the owner. The same user
reposting the signature with another amount or fund gets 409 `deposit_conflict`.

### Withdraw (exit)
`POST /v0/me/withdrawals` with `Idempotency-Key` and either `{ amountUsdc }` or
`{ fundId, shares }`. The second form runs the normal paper exit and withdraws its payout.
One database transaction debits paper cash, writes the ledger rows and inserts the payout
intent. The key maps every retry to the same withdrawal id. Limits, checked after the key, so a
retry of an accepted request still returns its first result:

- minimum `WITHDRAW_MIN` (default 1 token), also for the payout of a fund exit: else 400
  `amount_too_small`;
- at most `WITHDRAW_RATE_PER_HOUR` (default 10) withdrawals per user per rolling hour: else 429
  `rate_limited`;
- the treasury pays the rent of a user's token account at most 3 times, ever (the grant counts).
  The count is `user_wallets.ata_creations`. After that, a wallet without its token account gets
  409 `token_account_required`: the user creates the associated token account, then retries.

### Send once (signup grant and withdrawals)
Each payout row is a small state machine. No RPC call runs while a database transaction or row
lock is open, and every RPC request is aborted after 10 s (a timeout on the transport). Each
write is a compare-and-set on the signature that the step read (`... WHERE signature IS NOT
DISTINCT FROM <read value>`). Before it signs, a caller takes a 30 s signing claim
(`signing_until`), so parallel callers sign once; a signature that loses the compare-and-set is
never sent.

1. No signature yet: sign the transfer, **save the signature, signed bytes and
   `lastValidBlockHeight`, commit**, then broadcast. The transaction creates the user's token
   account only when it does not exist, and that save also counts one treasury-paid creation.
   With 3 creations spent and no account, the payout stays `PENDING` with `lastError`
   `token_account_required` until the user creates the account.
2. Signature saved: read the finalized block height, then the signature status.
   - confirmed: mark `CONFIRMED`.
   - processing: wait.
   - missing and height <= `lastValidBlockHeight`: rebroadcast the same signed bytes. The
     cluster runs one signature once, so this cannot double-send.
   - failed, or missing after the blockhash expired: the old transaction can never land, so
     sign a new one (`attempts + 1`, `last_error` records why).

`POST` waits up to `PAYOUT_CONFIRM_WAIT_MS` (default 20000) for confirmation and returns 201
`CONFIRMED` or 202 `PENDING`. `GET /v0/me/withdrawals/:id`, `GET /v0/me/token-balance` and a
repeat bootstrap reconcile pending payouts. A crash after the commit and before the broadcast
leaves a saved signature that the next reconcile rebroadcasts or replaces after expiry.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/v0/auth/privy` | Bootstrap; body `{ "walletAddress"?: string }`; response adds `token`, `wallet`, `signupGrant` |
| GET | `/v0/me/token-balance` | On-chain USDG balance of the wallet, paper cash and fund positions |
| POST | `/v0/me/deposits/prepare` | `{ amountUsdc }` -> `{ transaction (base64), lastValidBlockHeight, treasuryTokenAccount, ... }` |
| POST | `/v0/me/deposits` | `{ signature, amountUsdc, fundId? }` -> `{ deposit }`; 200 or 202 when `PENDING` |
| GET | `/v0/me/deposits/:signature` | Deposit state; re-verifies when `PENDING` |
| POST | `/v0/me/withdrawals` | `Idempotency-Key`; `{ amountUsdc }` or `{ fundId, shares }` -> `{ withdrawal, exit }`; 201 or 202 |
| GET | `/v0/me/withdrawals/:withdrawalId` | Withdrawal state; reconciles with devnet |

Errors: `wallet_required` (409, no bound wallet), `invalid_amount` / `amount_too_small` (400,
minimum deposit 1 token, minimum withdrawal `WITHDRAW_MIN`), `insufficient_virtual_cash` (422),
`invalid_withdrawal` (400), `deposit_conflict` (409), `token_account_required` (409),
`rate_limited` (429), `wallet_verification_unconfigured` (503), `deposit_not_found` /
`payout_not_found` (404). The Postman collection has a "Devnet token layer" folder.

## Configuration

| Variable | Default | Notes |
| --- | --- | --- |
| `USDG_MINT` | unset (layer off) | The only mint the layer uses |
| `MINT_AUTHORITY` | required | 64-byte secret key, JSON array or base58. Never logged |
| `TREASURY` | required | Same format. Owns the treasury token account and pays all fees |
| `DEVNET_RPC_URL` | `https://api.devnet.solana.com` | Separate from `SOLANA_RPC_URL`, which the ingestor uses for mainnet block times |
| `SIGNUP_GRANT` | `10000` | Tokens per new user |
| `PAYOUT_CONFIRM_WAIT_MS` | `20000` | How long a POST waits for a payout to confirm |
| `DEPOSIT_EXPIRY_SECONDS` | `300` | When a missing deposit signature becomes `EXPIRED` |
| `WITHDRAW_MIN` | `1` | Minimum withdrawal in tokens |
| `WITHDRAW_RATE_PER_HOUR` | `10` | Withdrawals per user per rolling hour |
| `PREPARE_RATE_PER_HOUR` | `20` | Deposit prepares per user per rolling hour |
| `PRIVY_APP_SECRET` | unset | Required to bind wallets from the Privy user record |
| `DEV_ALLOW_UNVERIFIED_WALLET` | unset | `1` binds the client-supplied wallet without Privy. Local testing only; refused unless the RPC is localhost or devnet |

At startup the API refuses to run when: the RPC URL names mainnet; the RPC genesis hash is not
devnet (`EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG`); the mint does not exist, does not have
6 decimals or is not controlled by `MINT_AUTHORITY`; the treasury token account does not exist;
a key is malformed; a limit variable is invalid; or `DEV_ALLOW_UNVERIFIED_WALLET=1` is set with
an RPC that is not localhost or devnet. `createApp` also refuses a chain whose mint differs from
`USDG_MINT`.

## Setup

```sh
pnpm --filter @socially/api build
node apps/api/scripts/devnet-setup.mjs            # secrets -> .env.devnet.local (gitignored, 0600)
```

The script generates the mint, mint authority and treasury key pairs, writes them only to the
secrets file, airdrops 1 devnet SOL to the treasury (or waits for you to fund it from
https://faucet.solana.com when the faucet is rate limited), then in one transaction creates the
mint, the treasury token account and a treasury float (`TREASURY_FLOAT`, default 1,000,000).
It prints only public values. A rerun resumes with the saved keys. Load the secrets file into
the API environment. Paper profits are paid from the float; the mint authority can mint more
to the treasury if it runs low.

## What the app (Expo + Privy) does

1. Sign in with Privy, with an embedded Solana wallet on devnet.
2. `POST /v0/auth/privy` (body `{ walletAddress }` with the embedded wallet address; the
   backend checks it against Privy with `PRIVY_APP_SECRET`). Show `signupGrant.status` and
   `signupGrant.amount` (for a converted legacy account it is the old paper cash); if `PENDING`,
   call it again or read the balance later.
3. Deposit or join: `POST /v0/me/deposits/prepare` -> decode the base64 transaction -> sign
   with the Privy Solana wallet (the fee payer signature is already present; the wallet adds
   its own) -> send to devnet -> `POST /v0/me/deposits { signature, amountUsdc, fundId? }` ->
   on 202 poll `GET /v0/me/deposits/:signature` until it is not `PENDING`. Always post the
   signature, also when the app thinks the send failed.
4. Withdraw: `POST /v0/me/withdrawals` with a new `Idempotency-Key` per user action, reused on
   retries. On 202 poll `GET /v0/me/withdrawals/:id`.
5. Wallet screen: `GET /v0/me/token-balance`.

## Limits

- No background sweeper: a pending payout advances when the user calls bootstrap, balance or
  withdrawal status. A worker job can call the same reconcile function.
- Every RPC request times out after 10 s. A request that times out returns 500; the payout or
  deposit row stays as it was and the next call retries.
- `prepare` signs as fee payer: at most `PREPARE_RATE_PER_HOUR` per user. A user with many
  accounts can still spend treasury fees; add a global or IP limit before a public launch.
- Withdrawals: minimum `WITHDRAW_MIN`, at most `WITHDRAW_RATE_PER_HOUR` per user. The treasury
  pays token account rent at most 3 times per user. A treasury-paid creation is counted when the
  transaction is signed, so a creation that expires unsent also counts.
- Deposits credit only at `finalized`. An `EXPIRED` claim is re-checked on each `GET`. A deposit with a wrong amount is `FAILED` and its tokens
  stay in the treasury (no refund flow).
- Accounts created before the layer was on convert their paper cash once, at wallet bind. Value
  in their fund positions stays paper until they exit; the exit payout is withdrawable as usual.
- `DEV_ALLOW_UNVERIFIED_WALLET=1` lets any signed-in user bind any address. Never set it where
  real users sign in.
