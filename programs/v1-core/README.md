# v1-core

v1-core is the real-money protocol for socially.trade (whitepaper v1.1), written as an Anchor 1.2 program. A captain opens a fund with a USDC stake. Members deposit USDC and get non-transferable Token-2022 shares at NAV. The captain and delegates trade fund tokens through allowlisted venues. The program checks every trade by vault balance, not by trust. Large trades need a crew vote. The v0 hackathon app runs paper trading off-chain and does NOT call this program.

## The six promises and what enforces them

| Promise | Enforced by |
|---|---|
| Only you withdraw | Funds sit in PDA-owned vaults. `exit` pays a member only their pro-rata slice. `swap` reads every vault after the venue CPI: input vault falls by exactly `amount_in`, output vault rises by at least `min_out`, all other vaults are unchanged, and vault data length is unchanged. |
| Rules on every trade | `swap` checks: venue registry (an active `VenueEntry`; v1-core, system, token and ATA programs are always denied), token tier caps (T2 buys: at most 25% of NAV per token and 50% in total), T3 first-loss rules (T3 buys only in Open Seas funds, see below), delegate per-trade and daily USD limits, drawdown breaker, oracle price guard (every price source). The guard applies to every trade, including sales into USDC (3x slippage band, capped at 1500 bps). Policy loosening waits 48 h. |
| Exits never wait | `exit` has no pause, freeze or price dependency. Fresh NAV accounts are optional. Without them the fee uses `last_price_per_share`. One exception: a captain exit while the fund holds T3 cost basis and others hold shares needs valid fresh prices (the T3 floor below). |
| Paid only on new profit | Per-member high-water mark (HWM). The 10% fee is charged on profit above the HWM, in shares, at `exit` and at `charge_annual_fee`. At `exit` the fee price per share is `max(last_price_per_share, fresh exit-fee upper-bound price)` (a Switchboard holding at its deposit mark + std-dev, so neither a pump nor a dump moves it faster than one step per interval), so the choice of stale or fresh prices cannot lower the fee much: the residual difference is bounded by the price source confidence (Pyth confidence, Switchboard std-dev, or the scaled Pyth confidence for Kamino) plus the spot/EMA gap. `charge_annual_fee` uses the fresh EMA price only (the deposit mark for a Switchboard token), so the keeper's choice of an in-window spot price cannot move the fee, and moves the breaker on the same price before it computes the fee. The HWM rises only when at least one fee share is taken. |
| Slow admin | Token and venue changes queue for 7 days (`ADMIN_TIMELOCK_SECS`), then anyone applies them. `set_paused` is immediate. It blocks `deposit`, `create_fund` and any swap whose output is not USDC. Exits and sales to USDC are never blocked. |
| Big trades need the crew | A captain or delegate trade must fit two limits: `autonomous_bps` of spot NAV per trade, and the same amount as a rolling 24 h budget per fund (`window_start`, `window_volume_usd`), shared by the captain and all delegates. So a large trade split into small ones still needs a vote. A voted trade does not use the budget. `propose_trade` stores `route_hash`, a hash of the venue data and the ordered venue account metas. `execute_proposal` must match it. Vote weight is the share balance at vote time. |

## Pricing

- Each `TokenEntry` stores a `PriceSource`: `Pyth { feed_id }`, `KaminoReserve { reserve, underlying_feed_id, underlying_decimals }` or `Switchboard { feed, feed_hash, queue }`. `nav::price` dispatches on it. All three price today (`PriceSourceUnsupported` is no longer returned).
- Pyth: `PriceUpdateV2` accounts, parsed by hand in `src/pyth.rs`. No Pyth SDK.
- Pyth checks: owner is the Pyth receiver, account discriminator, `Full` verification level, feed id equals the registered feed, price age at most 60 s, confidence at most 200 bps of price, price greater than 0.
- Kamino kTokens (`KaminoReserve`): the klend `Reserve` account, parsed by hand in `src/kamino.rs` (layout of klend `release/v1.25.0`). Checks: the reserve key equals the one in the entry, owner is Kamino Lend (`KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD`), discriminator and length, collateral mint equals the held kToken mint, liquidity decimals equal `underlying_decimals`, not marked stale and refreshed at most 120 slots ago (60 s at klend's own 2 slots/s). klend marks a reserve stale after each deposit or withdraw, so a client sends klend `refresh_reserve` before the v1-core instruction. Value = `floor(kTokens * total_supply / collateral_supply)` underlying base units (klend `total_supply()`: available + borrowed - protocol fees - referrer fees - pending referrer fees; 1:1 while either side is 0), then priced with the underlying's Pyth account (`price_b`) in the same mode as a Pyth token: the underlying EMA for `Ema`, and its conf for `DepositUpperBound`.
- Switchboard On-Demand (`Switchboard`, for long-tail tokens): the `PullFeedAccountData` account, parsed by hand in `src/switchboard.rs` (layout of crate `switchboard-on-demand` 0.13.0). Checks: the feed key equals the one in the entry, owner is Switchboard On-Demand (`SBondMDrcV3K4kxZR1HNVT7osZxAHVHgYXL5Ze1oMUv`), discriminator and length, the feed's job hash (`feed_hash`) and oracle queue equal the ones in the entry (`FeedConfigChanged`), the current result exists (slot not 0), its oldest sample (`min_slot`) is at most `min(150, feed max_staleness)` slots old (60 s at the 400 ms target slot time), at least 3 oracle samples (`FeedTooFewSamples`), value greater than 0, std_dev at least 0 and at most 200 bps of the value. A client sends the Switchboard update (`pull_feed_submit_response`) before the v1-core instruction when the result is old.
- Switchboard mark prices. The feed has no EMA, and a thin pool can be pumped or dumped while every oracle agrees (std_dev near 0). So each Switchboard `TokenEntry` keeps two slow marks (`marks`: 18 decimals like the feed, with their slots), shared by every fund. Every NAV read of the token moves and stores them:
  - The first read seeds both at the feed value and stores the seed slot. `apply_token` resets both to unseeded when the price source changes (a tier change keeps them).
  - The deposit mark (the slow mark) moves at most once per 150 slots (`MARK_INTERVAL_SLOTS`, about 60 s), toward the feed value by at most 10% of the mark (`MARK_MAX_STEP_BPS`), both ways. It is the token's EMA: the deposit upper bound, `High`, the recorded `last_price_per_share` and peak, the annual fee price and the exit fee price all use it. So neither a pump nor a dump moves any fee price or recorded pps faster than one step per interval.
  - The low mark drops to the feed value at once when the value is lower, and rises at most 10% per 150 slots. So it is never above the spot after a read. It is used only for the captain stake (`StakeLowerBound`: T3 caps and the captain exit floor) and the breaker trip check (`BreakerCheck`), so a real crash freezes trading at once.
  - Warmup: for 1500 slots after a seed (`MARK_WARMUP_SLOTS`, about 10 min), the deposit mark equals the low mark (so a pumped seed does not stay in it), a NAV read that includes the token does not record the peak or `last_price_per_share` (the breaker can still trip, but not clear), the holding counts 0 toward the captain stake, and `deposit` and `charge_annual_fee` fail with `MarkWarmup`. Any successful read seeds (for example `poke_nav`, or the swap that buys the token); a failed `deposit` does not.
  - A swap that buys a Switchboard token new to the fund also stores the marks. So the entry account is writable in the NAV layout for a Switchboard token, and so is the swap `output_entry` when that output is a new Switchboard holding (else `ConstraintMut`).
  - A genuine rise takes some minutes to reach the marks (8 intervals for 2x, 25 for 10x); in that time the captain stake and the recorded pps count the lower price. A genuine fall reaches the low mark at once (the breaker trips), and the deposit mark in a few minutes (7 intervals for 50%), so deposits and fees use the higher price meanwhile.
- Switchboard feed authority: the feed authority can repoint a feed to another job or queue at any time, with no timelock. The registry stores the feed key, the job hash and the queue, so a repoint stops pricing of that token until the admin re-queues it through the 7-day timelock. Exits stay in-kind and need no price, so they still work (except the captain T3 floor case above, which needs fresh prices).
- Valuation modes (`nav::ValuationMode`). A caller can pick any price inside the 60 s window, so each use takes the side that cannot help the caller:

| Mode | Value of a non-USDC holding | Used for |
|---|---|---|
| `DepositUpperBound` | `max(price, ema_price) + conf` | Deposit share price |
| `ExitFeeUpperBound` | Pyth and Kamino: as `DepositUpperBound`; Switchboard: `ema_price + conf` | Exit fee price per share (max with `last_price_per_share`) |
| `Ema` | `ema_price` | Peak NAV, `last_price_per_share`, annual fee price per share |
| `BreakerCheck` | `low` | Drawdown breaker trip check |
| `StakeLowerBound` | `min(price, low)`; a warming Switchboard holding counts 0 | Captain stake value: T3 caps and the captain exit floor |
| `High` | `max(price, ema_price)` | Not used yet |
| `Spot` | `price` | Swap size, price guard, tier caps, T3 cost basis, proceeds, first-loss burn price |

For a Switchboard token `ema_price` is the deposit mark, `low` is the low mark and `conf` is the std_dev. For Pyth and Kamino `low` is the EMA. For a kToken each mode values the underlying amount at the underlying Pyth price.

## Open Seas funds and T3 tokens

A fund created with `open_seas = true` may buy T3 tokens. Any other fund gets `NotOpenSeas`. The rules sit in the shared swap core, so captain swaps, delegate swaps and executed proposals all obey them. A T3 trade passes 4 more remaining accounts (see `swap.rs`): the captain's Member PDA, the captain's share ATA, the share mint and the Token-2022 program.

- **Cost basis.** A T3 buy adds the spot USD value of the input to `t3_basis_usd[i]` of the output holding and to `t3_cost_basis_usd` (the sum). A T3 buy is a buy of a T3 token, or any buy into a holding that has a basis, whatever its tier (so a later re-tier cannot move units in or out of the basis). A T3 buy into a holding that has units but no basis is rejected with `T3UnbasedHolding`; sell those units first. An exit scales every basis by the same fraction as the holdings, rounded up while the holding keeps units, so a basis never reaches 0 with units left.
- **Caps at cost.** After a T3 buy, `t3_cost_basis_usd` must be at most the captain's stake value (captain share balance x pre-trade price per share at `StakeLowerBound`, so a pump does not raise it), and so must the T3 buys of the current and the previous 30-day window together (`t3_window_buys_usd` + `t3_prev_window_buys_usd` + the buy). Else `T3CapExceeded`. Windows run back to back from fund creation; when one ends the buckets move on, and after two or more both are empty. Any 30-day span lies inside two adjacent windows, so the buys of a span are bounded by the captain stake value at the time of each buy. The program reads the stake at every buy, so a stake that grows or shrinks moves the bound. The bound equals one stake value only while the stake stays constant. The cost: a full-cap buy can block new T3 buys for up to 60 days.
- **First loss.** A sale of a holding with a basis takes out `basis * amount_in / position`. If the spot value of the output received is less, the loss burns captain shares worth the loss at the pre-trade spot price per share (rounded up, at most the captain's balance), with the captain's high-water mark scaled like a partial exit. Event `FirstLossApplied`. A T3 to T3 trade is a sale, then a buy.
- **Captain floor.** While `t3_cost_basis_usd > 0` and others hold shares, a captain exit must leave a stake (at the fresh `StakeLowerBound` price per share) at least the basis left after the exit, in addition to the 5% rule.
- **Tokens sent directly to a fund vault** join the position with no cost basis. They can only reduce a later recorded loss, by their own value.
- **Not enforced: the linked-wallet block** of the whitepaper. It needs off-chain wallet-graph data.

## Disclosures and accepted risks

- **The admin is the program upgrade authority.** An instant program upgrade bypasses every on-chain timelock (token, venue and policy queues). Before real money, the upgrade authority must be a timelocked multisig, or the program must be made immutable.
- **Frozen fund with only USDC cannot unfreeze.** The breaker moves only on NAV. A fund more than `drawdown_bps` below its peak that holds only USDC has no trade that can raise its NAV, so it stays frozen. Members can still exit. The captain opens a new fund.
- **T3 first loss is measured per sale.** The burn prices the loss at the pre-trade spot pps. When the price fell before the sale, that pps already holds the unrealized loss, so the burn takes more shares than the loss at the pre-buy pps, and the crew can end above its pre-buy value. When the loss comes from the sale itself (slippage), the crew pps is unchanged. A loss above the captain's stake burns the whole stake; the rest falls on the crew.
- **Holders can burn their own shares.** Holders can burn their own NonTransferable shares; burned shares stay counted in `total_shares`, which locks the burned value in the fund and can leave the captain unable to exit the last dust share unit. No value moves to anyone else.

- **PermanentDelegate on the share mint.** The delegate is the fund PDA. Two burns use it: the yearly fee burn (`fees.rs`, `charge_annual_fee`) and the T3 first-loss burn of captain shares (`swap.rs`, `burn_captain_shares`). No other code uses it. The swap guard also keeps the share mint out of every venue account list, so no venue sees the burn authority. A bug in this program could burn member shares. Tests assert the extension and the delegate.
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
| `apply_token` | Anyone | ETA passed. A new price source resets the Switchboard marks. |
| `queue_venue` / `apply_venue` | Admin / anyone | One `VenueEntry` PDA `[b"venue", program]` per venue, no count limit. `queue_venue(active)` sets the pending value, ETA = now + 7 days. Removal (`active = false`) is queued the same way. A new queue overwrites the pending change and restarts the clock. |
| `set_paused` | Admin | Immediate. Blocks `deposit`, `create_fund` and swaps whose output is not USDC. Never blocks `exit` or sales to USDC. |
| `create_fund` | Captain | Deposit at least 250 USDC. Mints 1:1 shares. Creates policy, member, vaults and share mint (NonTransferable, PermanentDelegate). `open_seas` allows T3 buys; fixed at creation. |
| `deposit` | Anyone | Not paused, fund not closed, NAV (upper bound) nonzero, no Switchboard holding in its mark warmup (`MarkWarmup`). `min_shares`: fewer shares fail (`SlippageExceeded`). |
| `exit` | Member | Own share balance only. No pause, freeze or price check. Pro-rata of every holding. Fee on profit above HWM. Captain must keep at least 5% of shares while others hold shares, and a stake worth the T3 basis left while T3 is held (fresh prices needed). |
| `add_delegate` / `update_delegate` / `revoke_delegate` | Captain | Per-trade and daily USD limits. Revoke returns rent. |
| `swap` | Captain or delegate | Venue, tiers, caps, delegate limits, breaker, price guard, vault balance deltas, vault sizes (`VaultResized`), share mint not in venue accounts, T3 rules (Open Seas). A trade above `autonomous_bps` of spot NAV, or above the fund's rolling 24 h budget of the same size, needs a proposal. |
| `propose_trade` | Captain or delegate | Stores `route_hash` and the trade terms. Opens the vote window from policy. |
| `vote` | Member | One vote per member (VoteRecord `init`). Open proposal, before the deadline. Weight = share balance. |
| `execute_proposal` | Anyone | Proposal open. `now <= deadline` (else `ProposalExpired`). `yes_weight * 2 > total_shares_snapshot` (else `ProposalNotPassed`). `venue_data` and venue accounts match `route_hash`. Then runs the same checks as `swap`, without the size limit. |
| `cancel_proposal` | Captain | Proposal is open. |
| `update_policy` | Captain | Within the protocol floor. Stricter applies now and cancels a pending loosen. Looser queues 48 h. |
| `apply_policy` | Anyone | ETA passed. |
| `poke_nav` | Anyone | Valid NAV accounts. Records the EMA pps and peak (not during a mark warmup) and moves the breaker on the trip check. |
| `charge_annual_fee` | Anyone | Target is not the captain. One year since last fee. Fresh prices required, and no mark warmup (`MarkWarmup`). Fee price = fresh EMA pps; the breaker moves first. |
| `captain_log` | Captain or delegate | Emits a reason hash. No state. |

## Client notes

Remaining-accounts layouts (the order is `fund.holdings`; re-read it after a swap, because a fully sold holding is removed):

| Instruction | Remaining accounts |
|---|---|
| NAV users (`deposit`, `poke_nav`, `charge_annual_fee`) | 4 per holding: `[vault, token_entry, price_a, price_b]`. `token_entry` is writable for a Switchboard token (it stores the marks). Pyth: `price_a` = PriceUpdateV2, `price_b` not read (pass any key, for example the v1-core program id). KaminoReserve: `price_a` = reserve, `price_b` = underlying PriceUpdateV2. Switchboard: `price_a` = feed, `price_b` not read. USDC: entry and both price accounts not read, but present. |
| `exit` | 3 per holding: `[vault (w), user_token (w), mint]`, matched by mint in any order, each holding once (`DuplicateHolding`); then the optional NAV layout (in `fund.holdings` order) |
| `swap`, `execute_proposal` | NAV layout (4 per holding), then the output mint's `[price_a, price_b]` (same pair as in the NAV layout) if the output is a new non-USDC holding, then 4 T3 accounts (captain Member, captain share ATA, share mint, Token-2022 program) if the trade is a T3 trade, then the venue accounts |
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

## Out of scope

Phase 2a (this program) covers the venue registry, the three price sources and Open Seas funds. Phase 2b comes later. It adds position adapters in NAV, breaker and exit for perps and prediction markets. Until then, a fund holds only tokens that use one of the three price sources.

Also not built:

- Memecoin T3 tier: pool TWAP price.
- The linked-wallet block for T3 tokens (needs off-chain wallet-graph data).
- Discover fee split. Multisig admin and admin rotation.
