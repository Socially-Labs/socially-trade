# Wallet-funded vaults

Migration `026_live_vaults.sql` creates `live_vaults` (metadata, owner, PDA, share mint, initial seed) and `live_vault_transactions` (durable CREATE/EXIT attempts). Neither table participates in paper_cash, the funds ledger, the round worker, or treasury redemption. A displayed wallet valuation is never treated as a transferable DB balance.

The app's `/vaults/create` now opens wallet funding. `/vaults/live` lists confirmed onchain vaults and `/vaults/live/:id` shows shares and offers withdrawal. Existing paper rounds retain their separate routes.

## Funding

- USDC: transfer the requested amount into the fund through `create_fund`, minting non-transferable shares. A non-associated USDC account can fund directly. Split USDC balances are consolidated in the same transaction when size permits.
- SOL: the existing guarded Raydium devnet adapter prepares SOL -> Circle USDC. The backend appends `create_fund` and simulates the combined transaction. All conversion and funding instructions must fit one v0 transaction. Multi-transaction routes are rejected. No standalone conversion is broadcast as a fallback.
- The guaranteed minimum USDC output funds the vault; quote surplus stays in the user's wallet. At least 100 USDC must be deposited. The contract floor is now 100,000,000 raw USDC units. No SOL/USD display price can bypass this floor.
- The user's wallet signs. The API verifies the exact prepared message and signature, persists the signed wire transaction, and only then lets its reconciliation worker broadcast. Finalized confirmation of the same message is required before showing the vault as funded.
- Every prepare rechecks chain state and simulates. Keep 0.01 SOL after input, rent and fees. Network fees are bounded at 0.001 SOL, account rent at 0.05 SOL. SOL conversion retains existing slippage, price-impact and priority-fee validation; the known devnet Raydium priority-fee mismatch can still reject a route.

## Routes

| Route | Purpose |
|---|---|
| GET /v1/live-vaults/config | Readiness, supported funding assets and contract terms |
| POST /v1/live-vaults | Prepare and persist CREATE; no broadcast |
| GET /v1/me/live-vaults | Up to 50 confirmed owned vaults |
| GET /v1/live-vaults/:id | Owned vault metadata and current onchain shares/holdings |
| POST /v1/live-vaults/:id/exits | Prepare redemption of owned shares; no broadcast |
| GET /v1/me/live-vault-operations?clientRequestId=... | Recover a durable attempt |
| GET /v1/me/live-vault-pending | Discover pending attempts if local storage was lost |
| POST /v1/live-vault-operations/:id/submit | Verify and persist the wallet's signed transaction |

Requests require Privy authentication. Funding additionally requires Captain role and server-verified linked wallet ownership. Raw amounts are integer strings. Unique `(user_id, client_request_id)` with a request hash prevents conflicting retries. A pending creation is serialized per owner, and a pending exit is unique per vault. Only the owner reads these records.

Read paths use indexed ownership queries and batched RPC account reads, not multiple DB balance totals. Readiness is cached for ten seconds. A bounded background worker leases 20 indexed pending records at a time and resends the same signed transaction after ambiguous RPC failures. Financial idempotency records never expire with rate-limit counters. Redis is not an accounting source of truth.

## Contract terms and current scope

This is the existing v1-core share vault, **not** the round-v2 paper product. Withdrawals are in kind, without a paper funding window or settlement lock. Crew performance fees use a high-water mark, on exit/yearly. The client states these terms in its review. Onchain Crew deposit, trading, performance graph, earnings aggregation and media uploads are not connected by this change. No paper order can trade a funded live vault. The withdrawal adapter currently supports classic SPL holdings; unsupported holdings or oracle-dependent exits fail simulation rather than falling back to a treasury payout.

The deployed program/config must match the local contract before funding is enabled. The source address matches the ignored local build keypair: `8GaCjFv4QCtCzMQaBxGzpEbQZxfML2gMzNXZEigaPcUb`. Keep the deployment keypair secure and backed up; do not commit it.

## Deployment handoff

1. `bash scripts/build-programs.sh` builds the SBF program with the pinned toolchain and rejects stack overflow.
2. `node --env-file=.env apps/api/scripts/live-vault-preflight.mjs` checks program ID/keypair agreement, binary hash, configured devnet, deployer balance and config state without sending anything.
3. After deployment approval, deploy `target/deploy/v1_core.so` using the matching ignored `target/deploy/v1_core-keypair.json` and the intended upgrade-authority wallet. Run `node --env-file=.env apps/api/scripts/initialize-live-vault-config.mjs` to simulate initialization, then add `--send` only after approval. It uses the same upgrade authority and Circle devnet USDC, never the treasury's test-token mint. The app's readiness endpoint remains closed until this succeeds.
4. Run a separately authorized small end-to-end funding/withdrawal test with a wallet that has the required USDC/SOL. Deployment does not validate a user funding/withdrawal transaction; that still requires a separately authorized wallet signature.

Mainnet requires a separate environment and deployment decision. This adapter enforces devnet; it must not be pointed at mainnet.

## Devnet deployment — October 10, 2026

- Program: `8GaCjFv4QCtCzMQaBxGzpEbQZxfML2gMzNXZEigaPcUb`.
- Config: `12CFeomZJ9FJhFbBvPUihagzcbWRvhADuEsSY7MTDupf`, Circle devnet USDC, unpaused.
- Deployment transaction: `21yFzdL9vFFJzj26euTGUKH9VbyiX65wzf5RZqnLF9xU5wLqa9Y6d2uYLGY7idWnB4CgLCtkk5ZrRiiXWKCXFtXU`.
- Initialization transaction: `3pTbDnSM1mcs5pcWUPWGKGiEJiP6xWFfyfuSNfgKTnc8KbL9qkxb6TxrwzD2uSGPx5GbCZJ3ESevCL38NC1yWwEp`.
- Both transactions finalized. Onchain bytecode matches the tested 778,840-byte binary, SHA-256 `4bfecd124422610174d866215999fab52cf82a9800a3f9d413e09b5f74517cce`.
- Upload buffer closed; approximately 1.03659968 SOL remained from the 5 SOL deployment funding. No app-wallet funds were used.
- The running backend returned `enabled: true`, `reason: null` for `/v1/live-vaults/config`. Funding still requires the normal wallet signature, $100 minimum, simulation and fee/liquidity checks.
- Used the configured devnet RPC with paced, resumable writes after CLI bursts were throttled. Initialization confirmation uses HTTP status polling so an unsupported WebSocket subscription cannot stall the script.
