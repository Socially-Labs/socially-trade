# v1-core

v1-core is the real-money protocol for socially.trade (whitepaper v1.1), written as an Anchor 1.2 program. A captain opens a fund with a USDC stake. Members deposit USDC and get non-transferable Token-2022 shares at NAV. The captain and delegates trade fund tokens through allowlisted venues. The program checks every trade by vault balance, not by trust. Large trades need a crew vote. The v0 hackathon app runs paper trading off-chain and does NOT call this program.

## The six promises and what enforces them

| Promise | Enforced by |
|---|---|
| Only you withdraw | Funds sit in PDA-owned vaults. `exit` pays a member only their pro-rata slice. `swap` reads every vault after the venue CPI: input vault falls by exactly `amount_in`, output vault rises by at least `min_out`, all other vaults are unchanged, and vault data length is unchanged. |
| Rules on every trade | `swap` checks: venue registry (an active `VenueEntry`; v1-core, system, token and ATA programs are always denied), token tier caps (T2 buys only; T3 buys are rejected with `TierCapExceeded` until the open-seas rules exist), delegate per-trade and daily USD limits, drawdown breaker, Pyth price guard. The guard applies to every trade, including sales into USDC (3x slippage band, capped at 1500 bps). Policy loosening waits 48 h. |
| Exits never wait | `exit` has no pause, freeze or price dependency. Fresh NAV accounts are optional. Without them the fee uses `last_price_per_share`. |
| Paid only on new profit | Per-member high-water mark (HWM). The 10% fee is charged on profit above the HWM, in shares, at `exit` and at `charge_annual_fee`. At `exit` the fee price per share is `max(last_price_per_share, fresh upper-bound price)`, so the choice of stale or fresh prices cannot lower the fee much: the residual difference is bounded by the Pyth confidence plus the spot/EMA gap. `charge_annual_fee` uses the fresh upper-bound price only, and moves the breaker before it computes the fee. The HWM rises only when at least one fee share is taken. |
| Slow admin | Token and venue changes queue for 7 days (`ADMIN_TIMELOCK_SECS`), then anyone applies them. `set_paused` is immediate. It blocks `deposit`, `create_fund` and any swap whose output is not USDC. Exits and sales to USDC are never blocked. |
| Big trades need the crew | A captain or delegate trade must fit two limits: `autonomous_bps` of spot NAV per trade, and the same amount as a rolling 24 h budget per fund (`window_start`, `window_volume_usd`), shared by the captain and all delegates. So a large trade split into small ones still needs a vote. A voted trade does not use the budget. `propose_trade` stores `route_hash`, a hash of the venue data and the ordered venue account metas. `execute_proposal` must match it. Vote weight is the share balance at vote time. |

## Pricing

- Each `TokenEntry` stores a `PriceSource`: `Pyth { feed_id }`, `KaminoReserve { reserve, underlying_feed_id, underlying_decimals }` or `Switchboard { feed }`. `nav::price` dispatches on it. `Pyth` and `KaminoReserve` price today; `Switchboard` fails with `PriceSourceUnsupported`.
- Pyth: `PriceUpdateV2` accounts, parsed by hand in `src/pyth.rs`. No Pyth SDK.
- Pyth checks: owner is the Pyth receiver, account discriminator, `Full` verification level, feed id equals the registered feed, price age at most 60 s, confidence at most 200 bps of price, price greater than 0.
- Kamino kTokens (`KaminoReserve`): the klend `Reserve` account, parsed by hand in `src/kamino.rs` (layout of klend `release/v1.25.0`). Checks: the reserve key equals the one in the entry, owner is Kamino Lend (`KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD`), discriminator and length, collateral mint equals the held kToken mint, liquidity decimals equal `underlying_decimals`, not marked stale and refreshed at most 120 slots ago (60 s at klend's own 2 slots/s). klend marks a reserve stale after each deposit or withdraw, so a client sends klend `refresh_reserve` before the v1-core instruction. Value = `floor(kTokens * total_supply / collateral_supply)` underlying base units (klend `total_supply()`: available + borrowed - protocol fees - referrer fees - pending referrer fees; 1:1 while either side is 0), then priced with the underlying's Pyth account (`price_b`) in the same mode as a Pyth token: the underlying EMA for `Ema`, and its conf for `DepositUpperBound`.
- Valuation modes (`nav::ValuationMode`). A caller can pick any price inside the 60 s window, so each use takes the side that cannot help the caller:

| Mode | Value of a non-USDC holding | Used for |
|---|---|---|
| `DepositUpperBound` | `max(price, ema_price) + conf` | Deposit share price, fee price per share (exit: max with `last_price_per_share`; annual fee: alone) |
| `Ema` | `ema_price` | Drawdown breaker, peak NAV, `last_price_per_share` |
| `Spot` | `price` | Swap size, price guard, tier caps |

## Disclosures and accepted risks

- **The admin is the program upgrade authority.** An instant program upgrade bypasses every on-chain timelock (token, venue and policy queues). Before real money, the upgrade authority must be a timelocked multisig, or the program must be made immutable.
- **Frozen fund with only USDC cannot unfreeze.** The breaker moves only on NAV. A fund more than `drawdown_bps` below its peak that holds only USDC has no trade that can raise its NAV, so it stays frozen. Members can still exit. The captain opens a new fund.
- **Holders can burn their own shares.** Holders can burn their own NonTransferable shares; burned shares stay counted in `total_shares`, which locks the burned value in the fund and can leave the captain unable to exit the last dust share unit. No value moves to anyone else.

- **PermanentDelegate on the share mint.** The delegate is the fund PDA. Only the yearly fee burn (`fees.rs`, `charge_annual_fee`) uses it. The swap guard also keeps the share mint out of every venue account list, so no venue sees the burn authority. A bug in this program could burn member shares. Tests assert the extension and the delegate.
- **USDC freeze authority (Circle)** is accepted.
- **Registry mint screening.** `queue_token` rejects any non-USDC mint that has a freeze authority or any Token-2022 extension, for every price source. Exits therefore do not depend on token behaviour. The check runs at queue time only.
- **Proposal data is off-chain.** Only `route_hash` is on-chain. The client must keep the route bytes and the exact account list. Lost bytes mean the proposal cannot execute. The hash covers runtime-merged signer and writable flags, so read `route_hash` from the `ProposalCreated` event and build the matching transaction.
- **A voter who exits keeps their vote weight**. Captain fee shares minted after a proposal opens also count.
- **Closed fund.** When `total_shares == 0` the fund is closed. `deposit` returns `FundClosed`. The captain must create a new fund id.
- **Frozen funds** accept deposits. Freeze stops trading, not exits.
- **Mock venue** (`programs/mock-venue`) is TEST-ONLY and drainable by design. Never deploy it. Never allowlist it on a real network.
- Minor, tracked: a revoked delegate's open proposals stay valid until the captain cancels them. Proposal and vote rent is not reclaimed. A late fee keeper shifts the fee anniversary.

## Instructions

| Instruction | Caller | Checks |
|---|---|---|
| `initialize_config` | Program upgrade authority | Signer equals ProgramData upgrade authority. USDC mint has 6 decimals. Becomes admin. |
| `queue_token` | Admin | `PriceSource`, tier (`T1`, `T2`, `T3`), decimals. Non-USDC mint has no freeze authority and no extension. ETA = now + 7 days. |
| `apply_token` | Anyone | ETA passed. |
| `queue_venue` / `apply_venue` | Admin / anyone | One `VenueEntry` PDA `[b"venue", program]` per venue, no count limit. `queue_venue(active)` sets the pending value, ETA = now + 7 days. Removal (`active = false`) is queued the same way. A new queue overwrites the pending change and restarts the clock. |
| `set_paused` | Admin | Immediate. Blocks `deposit`, `create_fund` and swaps whose output is not USDC. Never blocks `exit` or sales to USDC. |
| `create_fund` | Captain | Deposit at least 250 USDC. Mints 1:1 shares. Creates policy, member, vaults and share mint (NonTransferable, PermanentDelegate). |
| `deposit` | Anyone | Not paused, fund not closed, NAV (upper bound) nonzero. |
| `exit` | Member | Own share balance only. No pause, freeze or price check. Pro-rata of every holding. Fee on profit above HWM. Captain must keep at least 5% of shares while others hold shares. |
| `add_delegate` / `update_delegate` / `revoke_delegate` | Captain | Per-trade and daily USD limits. Revoke returns rent. |
| `swap` | Captain or delegate | Venue, tiers, caps, delegate limits, breaker, price guard, vault balance deltas, vault sizes (`VaultResized`), share mint not in venue accounts. A trade above `autonomous_bps` of spot NAV, or above the fund's rolling 24 h budget of the same size, needs a proposal. |
| `propose_trade` | Captain or delegate | Stores `route_hash` and the trade terms. Opens the vote window from policy. |
| `vote` | Member | One vote per member (VoteRecord `init`). Open proposal, before the deadline. Weight = share balance. |
| `execute_proposal` | Anyone | Proposal open. `now <= deadline` (else `ProposalExpired`). `yes_weight * 2 > total_shares_snapshot` (else `ProposalNotPassed`). `venue_data` and venue accounts match `route_hash`. Then runs the same checks as `swap`, without the size limit. |
| `cancel_proposal` | Captain | Proposal is open. |
| `update_policy` | Captain | Within the protocol floor. Stricter applies now and cancels a pending loosen. Looser queues 48 h. |
| `apply_policy` | Anyone | ETA passed. |
| `poke_nav` | Anyone | Valid NAV accounts. Moves peak NAV and the breaker on EMA prices. |
| `charge_annual_fee` | Anyone | Target is not the captain. One year since last fee. Fresh prices required. Fee price = fresh upper-bound pps; the breaker moves first. |
| `captain_log` | Captain or delegate | Emits a reason hash. No state. |

## Client notes

Remaining-accounts layouts (the order is `fund.holdings`; re-read it after a swap, because a fully sold holding is removed):

| Instruction | Remaining accounts |
|---|---|
| NAV users (`deposit`, `poke_nav`, `charge_annual_fee`) | 4 per holding: `[vault, token_entry, price_a, price_b]`. Pyth: `price_a` = PriceUpdateV2, `price_b` not read (pass any key, for example the v1-core program id). KaminoReserve: `price_a` = reserve, `price_b` = underlying PriceUpdateV2. Switchboard: `price_a` = feed, `price_b` not read. USDC: entry and both price accounts not read, but present. |
| `exit` | 3 per holding: `[vault (w), user_token (w), mint]`, matched by mint in any order, each holding once (`DuplicateHolding`); then the optional NAV layout (in `fund.holdings` order) |
| `swap`, `execute_proposal` | NAV layout (4 per holding), then the output mint's `[price_a, price_b]` (same pair as in the NAV layout) if the output is a new non-USDC holding, then the venue accounts |
| `propose_trade` | The venue accounts only |

`swap`, `propose_trade` and `execute_proposal` take `venue_entry` (the `VenueEntry` PDA of `venue_program`) right after `venue_program`. A missing, inactive or wrong entry gives `VenueNotAllowed`.

Compute budget:
- `swap`: about 48-53k (2 holdings, held output) to 106-128k (7 to 8 holdings, new output); runs vary with the random keys (PDA bump search). `execute_proposal`: about 70k.
- `exit` with 8 holdings plus NAV accounts is near 200k CU. Add a compute-budget instruction.
- Real Jupiter routes do not fit a legacy transaction. Use a v0 transaction with an address lookup table. `venue_data` is limited to 1024 bytes.

## Build and test

```bash
scripts/build-programs.sh   # never bare `cargo build-sbf`
cargo test -p v1-core       # LiteSVM; loads target/deploy/*.so, so build first
```

The script pins platform-tools v1.57 (anchor 1.2 pulls edition2024 crates) and fails on a BPF stack-frame overflow, which `cargo build-sbf` reports with exit 0. Do not use `anchor build`.

| Program | Id |
|---|---|
| v1-core | `HjRBKzvcuSiztYH97iL6RtbwDU9Mw8AF3Av3Q1nJgQsi` |
| mock-venue (test only) | `7wy5kqiVEWLHgmoccpe1DUD5vFA6tm68CM3hWiMcY1ng` |

To regenerate a program id (these steps were not executed as part of this build):

1. Delete `target/deploy/<name>-keypair.json`.
2. Run `solana-keygen new -o target/deploy/<name>-keypair.json --no-bip39-passphrase`.
3. Put the output of `solana address -k target/deploy/<name>-keypair.json` in that program's `declare_id!`. The tests read the mock-venue id from its crate.
4. Run `scripts/build-programs.sh` again.

Mainnet keypairs are not in the repo.

## Out of scope (Phase 2)

- Position adapters in NAV, breaker and exit: perps, prediction markets.
- Memecoin T3 tier: pool TWAP price, capped by a captain first-loss stake.
- Discover fee split. Multisig admin and admin rotation.
