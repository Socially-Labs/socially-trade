# Devnet wallet swaps

These routes orchestrate real SOL ↔ Circle faucet USDC swaps on Solana devnet.
They are independent of USDG treasury deposits and simulated vault orders. No
swap path writes paper cash, fund events, vault positions or ledger entries.
The backend never receives user private keys. Privy signs on the device.

All routes require a Privy access token and return `Cache-Control: no-store`.
Wallet ownership is verified through Privy's linked Solana wallets at quote time;
`PRIVY_APP_SECRET` is required. If a treasury wallet is already bound, it must match.
Amounts are decimal strings of raw unsigned 64-bit token units. SOL has 9 decimals;
Circle devnet USDC (`4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`) has 6.

| Route | Request | Result |
| --- | --- | --- |
| POST `/v1/me/swaps/quotes` | `{wallet,input:"SOL"\|"USDC",amountRaw}` | 201 `{quote}` with ID, amounts, impact, slippage, route fees and expiry |
| POST `/v1/me/swaps` | `{quoteId,clientRequestId}` (UUIDs) | 201 `{swap}`, including unsigned base64 transaction, blockhash, validity height and fee estimate |
| POST `/v1/me/swaps/:id/submit` | `{signedTransaction}` (base64) | 202 while submitted, 200 for a terminal replay |
| GET `/v1/me/swaps/:id` | — | `{swap}` owned by the current user |
| GET `/v1/me/swaps` | `status?`, `after?` (intent UUID), `limit?` (1–50) | `{swaps,nextCursor}` newest first |

Quotes expire after 30 seconds. This is a server TTL, not a timestamp supplied by
Raydium. Preparation must finish within that TTL. The prepared transaction retains
one blockhash and message for its entire life; wallet approval may outlast the quote
TTL. Clients must never refresh the prepared blockhash before signing.

The server validates the exact BaseIn amount and minimum output, route accounts and
pools, signer, supported devnet programs, SOL setup recipients, token initialization
and close recipients, compute budget and fee limits. It simulates the transaction
before returning it. Unsupported layouts and multi-transaction setup fail closed.
A final client simulation and program/signer check provides a second validation layer.

`fees.networkFeeLamports` is the total estimated network fee **including**
`priorityFeeLamports`; do not add priority twice. `accountRentLamports` is a separate
estimate for newly retained token accounts. Venue fees are already included in the
quoted exchange result and may use different hop mints; `venueFees: null` means the
venue did not provide a complete fee breakdown. Slippage is a tolerance, and the
0.01 SOL reserve is a balance buffer. Neither is a charged fee. Price impact is separate.

Preparation is idempotent per `(user, clientRequestId)`. A different quote under the
same key returns 409. Each quote can prepare only one intent. Replays return the same
transaction, including after expiry; they never build a second executable transaction.
The server verifies the Ed25519 signature and exact prepared message at submission,
then commits signed bytes and their globally unique signature before acknowledging.
The API-hosted reconciliation worker broadcasts these bytes, retries the same bytes
and checks finalized transaction metadata. An RPC timeout never alone means failure.

States: `PREPARED → SUBMITTED → CONFIRMED | FAILED | EXPIRED`. Abandoned prepared
transactions expire by finalized block height, not quote time. A landed transaction
remains pending while it finalizes even after its blockhash expires. Final receipts
record actual output and network fee. Submitted signed bytes survive API restarts;
workers share bounded persistent leases and gracefully stop before database closure.
Clients should retain the request ID before prepare and signed bytes before submit,
recover the same intent, and poll GET rather than broadcast or poll RPC themselves.

Configure `SOLANA_RPC_URL` and `SWAP_*` settings from `.env.example`; swaps use the
configured `SOLANA_RPC_URL` (falling back to `DEVNET_RPC_URL`, then public devnet).
`SWAP_RPC_URL` is not used. Startup rejects malformed limits and
non-devnet RPCs. The feature defaults to enabled and can be disabled with
`SWAP_ENABLED=false`. Migrate before startup: `pnpm db:migrate` adds migration 025.
No changes to the APK venue configuration or rebuild are needed to change the backend
venue. This implementation still intentionally supports devnet only.

Checks: `pnpm build`, `pnpm check-types`, and
`TEST_DATABASE_URL=postgres://socially:socially@127.0.0.1:5432/socially_trade pnpm test:backend`.
Tests use disposable schemas and stub venue/RPC operations; they do not execute swaps.
