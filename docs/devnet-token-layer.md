# Devnet token layer

The product is paper trading. Only money in and out touches Solana devnet, with one SPL
test token that we create and control: **USDG (devnet)**, 6 decimals. One token equals one
paper USDC. Trades, P&L, fees and Captains stay in the paper ledger. No Anchor program is used.

The layer is on when `USDG_MINT` is set. Without it the API behaves as before (10,000
virtual USDC on signup, no chain calls).

## Flows

| Flow | Who signs | Paper effect | Chain effect |
| --- | --- | --- | --- |
| Signup grant | backend (mint authority; treasury pays the fee) | none, paper cash starts at 0 | `MintToChecked` of `SIGNUP_GRANT` to the user's token account (created if missing) |
| Deposit | user wallet (treasury pays the fee) | paper cash + X, optionally a fund join of X | `TransferChecked` of X from the user's token account to the treasury token account |
| Withdraw | backend (treasury) | paper cash - X (or a fund exit, then its payout) | `TransferChecked` of X from the treasury to the user's token account (created if missing) |

### Signup grant
`POST /v0/auth/privy` binds one Solana wallet to the user and mints the grant.

- Wallet source: with `PRIVY_APP_SECRET`, the backend reads the Privy user record
  (`GET https://api.privy.io/v1/users/{did}`) and takes the embedded Solana wallet. A
  `walletAddress` in the body must be one of the user's linked Solana wallets (else 403
  `wallet_not_linked`). Privy access tokens do not carry wallets. Without the secret
  (development only) the body `walletAddress` is accepted after base58 address validation. In
  production without the secret the bootstrap returns 503 `wallet_verification_unconfigured`.
- The binding is permanent: another address returns 409 `wallet_mismatch`. An address bound
  to another user returns 409 `wallet_in_use`.
- Exactly once per user: a partial unique index allows one `SIGNUP_GRANT` row per user.
  Retries and parallel calls drive the same row (see "Send once" below).

### Deposit (spend / join a Captain)
1. `POST /v0/me/deposits/prepare { amountUsdc }` returns a base64 v0 transaction with one
   `TransferChecked`. The treasury is the fee payer and has already signed. The user's wallet
   needs no SOL.
2. The app signs it with the Privy wallet and sends it to devnet.
3. `POST /v0/me/deposits { signature, amountUsdc, fundId? }` claims it. The backend fetches the
   transaction (`getTransaction`, commitment `confirmed`) and requires all of:
   - no transaction error (else `transaction_failed`);
   - a balance change of our mint (else `wrong_mint`);
   - the treasury token account received tokens (else `wrong_destination`);
   - a token account owned by the user's bound wallet paid (else `wrong_owner`);
   - both changes equal X exactly (else `wrong_amount`).
4. Only then the paper ledger is credited. With `fundId`, the fund join runs in the same
   database transaction under a savepoint. If the join is refused (for example
   `captain_seed_fixed` or `fund_not_active`), the credit stays as paper cash and
   `deposit.join.error` names the reason.

States: `PENDING` -> `CONFIRMED` | `FAILED` | `EXPIRED`. `PENDING` (HTTP 202) means devnet does
not return the transaction yet. After `DEPOSIT_EXPIRY_SECONDS` (default 300, well past the
about 60-90 s blockhash lifetime) a still-missing transaction becomes `EXPIRED`. Terminal states
never change.

Idempotency and races: a claim is unique per `(signature, user)`. The verification runs under
that row's lock, so 5 parallel confirms credit once. A second partial unique index allows one
`CONFIRMED` row per signature across all users. A stranger who posts someone else's signature
gets `FAILED wrong_owner` on their own claim and does not block the owner. The same user
reposting the signature with another amount or fund gets 409 `deposit_conflict`.

### Withdraw (exit)
`POST /v0/me/withdrawals` with `Idempotency-Key` and either `{ amountUsdc }` or
`{ fundId, shares }`. The second form runs the normal paper exit and withdraws its payout.
One database transaction debits paper cash, writes the ledger rows and inserts the payout
intent. The key maps every retry to the same withdrawal id.

### Send once (signup grant and withdrawals)
Each payout row is a small state machine, advanced under its row lock:

1. No signature yet: sign the transfer, **save the signature, signed bytes and
   `lastValidBlockHeight`, commit**, then broadcast.
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
minimum deposit 1 token), `insufficient_virtual_cash` (422), `invalid_withdrawal` (400),
`deposit_conflict` (409), `deposit_not_found` / `payout_not_found` (404). The Postman
collection has a "Devnet token layer" folder.

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
| `PRIVY_APP_SECRET` | unset | Required in production to bind wallets from the Privy user record |

At startup the API refuses to run when: the RPC URL names mainnet; the RPC genesis hash is not
devnet (`EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG`); the mint does not exist, does not have
6 decimals or is not controlled by `MINT_AUTHORITY`; the treasury token account does not exist;
or a key is malformed. `createApp` also refuses a chain whose mint differs from `USDG_MINT`.

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
   backend checks it against Privy when `PRIVY_APP_SECRET` is set). Show
   `signupGrant.status`; if `PENDING`, call it again or read the balance later.
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
- `prepare` signs as fee payer for any authenticated user with a wallet. Add a rate limit before
  a public launch.
- A deposit with a wrong amount is `FAILED` and its tokens stay in the treasury (no refund flow).
- Accounts created before the layer was on keep their 10,000 virtual USDC.
