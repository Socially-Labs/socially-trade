//! Open Seas funds: T3 caps at cost, the 30-day buy window, first-loss
//! burns of captain shares, and the captain exit floor while T3 is held.

mod common;

use {
    common::*,
    v1_core::{
        events::{FeeCharged, FirstLossApplied},
        state::{Marks, Member},
    },
};

const USDC: u64 = 1_000_000;
/// One MEME (9 dp). MEME starts at $0.05, so 1 USDC buys 20 MEME.
const MEME: u64 = 1_000_000_000;
/// One SOL (9 dp), $150.
const SOL: u64 = 1_000_000_000;

struct Seas {
    t: Trading,
    crew: Keypair,
    meme: SbToken,
}

/// An Open Seas fund (id 2): the captain stakes `cap_usd`, one crew member
/// deposits `crew_usd`. MEME is listed T3 at $0.05 with deep pools.
fn open_seas(cap_usd: u64, crew_usd: u64) -> Seas {
    let mut t = trading_fund();
    let meme = listed_meme(&mut t.env, Tier::T3);
    let usdc = t.env.usdc;
    setup_venue_pool(
        &mut t.env,
        &usdc,
        &meme.mint,
        1_000_000 * USDC,
        100_000_000 * MEME,
    );
    // MEME already trades: fund 1 holds a little, and a read seeded its
    // (shared) marks one warmup ago, so fund 2 values it at once.
    inject_holding(&mut t.env, &t.f, meme.mint, MEME);
    refresh_meme(&mut t.env, &meme);
    let cap = t.cap.insecure_clone();
    poke(&mut t.env, &t.f, &cap).unwrap();
    warp(&mut t.env.svm, MARK_WARMUP_SLOTS as i64);
    t.refresh_prices();
    refresh_meme(&mut t.env, &meme);
    let ix = ix_create_fund_full(&t.cap.pubkey(), 2, cap_usd * USDC, usdc, true);
    send(&mut t.env.svm, &[ix], &[&t.cap]).unwrap();
    t.f = FundHandles::new(&t.cap.pubkey(), 2, &usdc);
    let crew = funded_user(&mut t.env, crew_usd * USDC);
    deposit(&mut t.env, &t.f, &crew, crew_usd * USDC).unwrap();
    Seas { t, crew, meme }
}

impl Seas {
    /// Buy MEME with `usd` USDC at the oracle price.
    fn buy(&self, usd: u64) -> SwapArgs {
        buy_of(&self.t, &self.meme.mint, usd)
    }
    /// Warp to `at` (unix seconds) and re-publish every price.
    fn warp_to(&mut self, at: i64) {
        let secs = at - now(&self.t.env);
        warp(&mut self.t.env.svm, secs);
        self.refresh();
    }
    /// Sell `meme` base units for `meme * num / den` USDC base units (min_out = that).
    fn sell(&self, meme: u64, num: u64, den: u64) -> SwapArgs {
        let out = (meme as u128 * num as u128 / den as u128) as u64;
        SwapArgs::new(self.meme.mint, self.t.env.usdc, meme, out, num, den)
    }
    fn fund(&self) -> v1_core::state::Fund {
        read_fund(&self.t.env, &self.t.f)
    }
    fn captain_shares(&self) -> u64 {
        token_balance(&self.t.env.svm, &share_ata(&self.t.f, &self.t.cap.pubkey()))
    }
    fn meme_vault(&self) -> u64 {
        token_balance(
            &self.t.env.svm,
            &ata(&self.t.f.fund, &self.meme.mint, &spl_token_interface::ID),
        )
    }
    /// Re-publish every price at the current clock.
    fn refresh(&mut self) {
        self.t.refresh_prices();
        refresh_meme(&mut self.t.env, &self.meme);
    }
    /// Set the MEME feed to `value` (USD, 18 dp) and publish it now.
    fn set_meme_price(&mut self, value: i128) {
        self.meme.fields.value = value;
        refresh_meme(&mut self.t.env, &self.meme);
    }
    /// `total_shares` equals the share mint supply.
    fn assert_supply(&self) {
        let supply = share_mint_state(&self.t.env.svm, &self.t.f.share_mint)
            .base
            .supply;
        assert_eq!(self.fund().total_shares, supply);
    }
}

/// Buy a $0.05 9-dp token with `usd` USDC at the oracle price.
fn buy_of(t: &Trading, mint: &Pubkey, usd: u64) -> SwapArgs {
    SwapArgs::new(t.env.usdc, *mint, usd * USDC, usd * 20 * MEME, 20_000, 1)
}

/// A second $0.05 Switchboard token listed `tier`, with a deep pool.
fn second_token(s: &mut Seas, tier: Tier) -> SbToken {
    let coin = listed_meme(&mut s.t.env, tier);
    let usdc = s.t.env.usdc;
    setup_venue_pool(&mut s.t.env, &usdc, &coin.mint, 0, 100_000_000 * MEME);
    s.refresh();
    refresh_meme(&mut s.t.env, &coin);
    coin
}

/// Re-list `token` as `tier` (7-day timelock), then re-publish every price.
fn retier(s: &mut Seas, token: &SbToken, tier: Tier) {
    register_token_with(&mut s.t.env, token.mint, token.source(), tier);
    s.refresh();
    refresh_meme(&mut s.t.env, token);
}

#[test]
fn t3_cap_at_cost_rejects_one_big_buy() {
    // NAV 20,000; per-trade limit 2,000; captain stake 1,000.
    let mut s = open_seas(1_000, 19_000);
    assert!(s.fund().open_seas);
    let a = s.buy(1_001);
    expect_err(s.t.swap_fresh(&a), ErrorCode::T3CapExceeded);
    let a = s.buy(1_000);
    s.t.swap_fresh(&a).unwrap();
    let f = s.fund();
    assert_eq!(f.t3_cost_basis_usd, 1_000 * USDC);
    assert_eq!(f.t3_basis_usd[1], 1_000 * USDC);
    assert_eq!(f.t3_window_buys_usd, 1_000 * USDC);
    assert_eq!(s.meme_vault(), 20_000 * MEME);
}

#[test]
fn t3_cap_at_cost_adds_up_split_buys() {
    let mut s = open_seas(1_000, 19_000);
    let a = s.buy(600);
    s.t.swap_fresh(&a).unwrap();
    let a = s.buy(401);
    expect_err(s.t.swap_fresh(&a), ErrorCode::T3CapExceeded);
    let a = s.buy(400);
    s.t.swap_fresh(&a).unwrap();
    assert_eq!(s.fund().t3_cost_basis_usd, 1_000 * USDC);
}

#[test]
fn t3_window_counts_the_previous_window_in_full() {
    let mut s = open_seas(1_000, 19_000);
    let start = s.fund().t3_window_start;
    let a = s.buy(600);
    s.t.swap_fresh(&a).unwrap();
    // Sell it all at par: the basis is 0 again, but the window still holds 600.
    let a = s.sell(12_000 * MEME, 1, 20_000);
    let res = s.t.swap_fresh(&a).unwrap();
    assert!(decode_events::<FirstLossApplied>(&res).is_empty());
    assert_eq!(s.fund().t3_cost_basis_usd, 0);
    assert_eq!(s.fund().t3_basis_usd, [0; MAX_HOLDINGS]);
    let a = s.buy(401);
    expect_err(s.t.swap_fresh(&a), ErrorCode::T3CapExceeded);

    // One second before the window ends, and when the next window starts:
    // the 600 still counts in full.
    s.warp_to(start + T3_WINDOW_SECS - 1);
    expect_err(s.t.swap_fresh(&a), ErrorCode::T3CapExceeded);
    s.warp_to(start + T3_WINDOW_SECS);
    expect_err(s.t.swap_fresh(&a), ErrorCode::T3CapExceeded);
    // Half way into the next window the 600 still counts in full (a decay
    // would count 300 and let 401 through).
    s.warp_to(start + T3_WINDOW_SECS * 3 / 2);
    expect_err(s.t.swap_fresh(&a), ErrorCode::T3CapExceeded);
    // 400 fits: 600 + 400 = 1,000.
    let a = s.buy(400);
    s.t.swap_fresh(&a).unwrap();
    let f = s.fund();
    assert_eq!(f.t3_window_start, start + T3_WINDOW_SECS);
    assert_eq!(f.t3_prev_window_buys_usd, 600 * USDC);
    assert_eq!(f.t3_window_buys_usd, 400 * USDC);
    // At start + 60 d the 600 is out; the 400 is the previous window now.
    let a = s.sell(8_000 * MEME, 1, 20_000);
    s.t.swap_fresh(&a).unwrap();
    s.warp_to(start + 2 * T3_WINDOW_SECS);
    let a = s.buy(601);
    expect_err(s.t.swap_fresh(&a), ErrorCode::T3CapExceeded);
    let a = s.buy(600);
    s.t.swap_fresh(&a).unwrap();
    let f = s.fund();
    assert_eq!(f.t3_prev_window_buys_usd, 400 * USDC);
    assert_eq!(f.t3_window_buys_usd, 600 * USDC);
}

#[test]
fn t3_window_blocks_a_second_cap_across_the_boundary() {
    let mut s = open_seas(1_000, 19_000);
    let start = s.fund().t3_window_start;
    // A full-cap buy 60 s before the window ends, sold at once.
    s.warp_to(start + T3_WINDOW_SECS - 60);
    let a = s.buy(1_000);
    s.t.swap_fresh(&a).unwrap();
    let a = s.sell(20_000 * MEME, 1, 20_000);
    s.t.swap_fresh(&a).unwrap();
    // 60 s later a new window starts, but the last 30 days already hold the cap.
    s.warp_to(start + T3_WINDOW_SECS);
    let a = s.buy(1);
    expect_err(s.t.swap_fresh(&a), ErrorCode::T3CapExceeded);
    // 60 days after the start, that buy is out of both windows.
    s.warp_to(start + 2 * T3_WINDOW_SECS);
    let a = s.buy(1_000);
    s.t.swap_fresh(&a).unwrap();
    let f = s.fund();
    assert_eq!(f.t3_window_start, start + 2 * T3_WINDOW_SECS);
    assert_eq!(f.t3_prev_window_buys_usd, 0);
    assert_eq!(f.t3_window_buys_usd, 1_000 * USDC);
}

#[test]
fn t3_realized_loss_burns_captain_shares_and_crew_pps_holds() {
    let mut s = open_seas(1_000, 19_000);
    let a = s.buy(1_000);
    s.t.swap_fresh(&a).unwrap();
    // Pre-sale spot NAV: 19,000 USDC + 20,000 MEME at $0.05 = 20,000. pps 1.0.
    let crew_shares = token_balance(&s.t.env.svm, &share_ata(&s.t.f, &s.crew.pubkey()));
    assert_eq!(crew_shares, 19_000 * USDC);

    // The venue pays 990 USDC for 1,000 USDC of basis: a realized loss of 10.
    let a = s.sell(20_000 * MEME, 99, 2_000_000);
    let res = s.t.swap_fresh(&a).unwrap();
    let ev = decode_events::<FirstLossApplied>(&res);
    assert_eq!(ev.len(), 1);
    assert_eq!(
        (ev[0].fund, ev[0].loss_usd, ev[0].captain_shares_burned),
        (s.t.f.fund, 10 * USDC, 10 * USDC)
    );

    // Captain shares worth the loss at the pre-trade pps (10 shares) are gone.
    assert_eq!(s.captain_shares(), 990 * USDC);
    let f = s.fund();
    assert_eq!(f.total_shares, 19_990 * USDC);
    s.assert_supply();
    assert_eq!(f.t3_cost_basis_usd, 0);
    let member: Member = read_account(&s.t.env.svm, &member_pda(&s.t.f.fund, &s.t.cap.pubkey()));
    assert_eq!(member.hwm, 990 * USDC);
    // NAV is 19,990 USDC for 19,990 shares: the crew pps is still exactly 1.0
    // (without the burn it would be 19,990 / 20,000).
    assert_eq!(
        token_balance(&s.t.env.svm, &s.t.f.usdc_vault),
        19_990 * USDC
    );
    assert_eq!(f.last_price_per_share, 1_000_000);
    assert_eq!(
        token_balance(&s.t.env.svm, &share_ata(&s.t.f, &s.crew.pubkey())),
        crew_shares
    );
}

#[test]
fn t3_loss_above_the_stake_burns_at_most_the_captain_balance() {
    let mut s = open_seas(1_000, 19_000);
    let a = s.buy(1_000);
    s.t.swap_fresh(&a).unwrap();
    // MEME falls to $0.0001: 20,000 MEME are worth 2 USDC. The recorded pps
    // is 0.9 (say other holdings fell, and the record follows them).
    s.set_meme_price(SB_ONE / 10_000);
    let mut f = s.fund();
    f.last_price_per_share = 900_000;
    write_fund(&mut s.t.env, &s.t.f, &f);
    let a = s.sell(20_000 * MEME, 1, 10_000_000);
    let res = s.t.swap_fresh(&a).unwrap();
    // Loss 998; shares worth 998 at the recorded pps 0.9 are 1,108.9: capped at 1,000.
    let ev = decode_events::<FirstLossApplied>(&res);
    assert_eq!(
        (ev[0].loss_usd, ev[0].captain_shares_burned),
        (998 * USDC, 1_000 * USDC)
    );
    assert_eq!(s.captain_shares(), 0);
    assert_eq!(s.fund().total_shares, 19_000 * USDC);
    s.assert_supply();
    let member: Member = read_account(&s.t.env.svm, &member_pda(&s.t.f.fund, &s.t.cap.pubkey()));
    assert_eq!(member.hwm, 0);
    // The crew keeps at least its 19,000 USDC deposit.
    assert!(token_balance(&s.t.env.svm, &s.t.f.usdc_vault) >= 19_000 * USDC);
}

#[test]
fn t3_realized_gain_burns_nothing() {
    let mut s = open_seas(1_000, 19_000);
    let a = s.buy(1_000);
    s.t.swap_fresh(&a).unwrap();
    s.set_meme_price(SB_ONE * 6 / 100);
    let a = s.sell(20_000 * MEME, 6, 100_000); // 1,200 USDC
    let res = s.t.swap_fresh(&a).unwrap();
    assert!(decode_events::<FirstLossApplied>(&res).is_empty());
    assert_eq!(s.captain_shares(), 1_000 * USDC);
    assert_eq!(s.fund().total_shares, 20_000 * USDC);
    assert_eq!(s.fund().t3_cost_basis_usd, 0);
}

#[test]
fn t3_partial_sale_takes_out_pro_rata_basis() {
    let mut s = open_seas(1_000, 19_000);
    let a = s.buy(1_000);
    s.t.swap_fresh(&a).unwrap();
    // Sell a quarter at par: a quarter of the basis leaves, no loss.
    let a = s.sell(5_000 * MEME, 1, 20_000);
    let res = s.t.swap_fresh(&a).unwrap();
    assert!(decode_events::<FirstLossApplied>(&res).is_empty());
    assert_eq!(s.fund().t3_cost_basis_usd, 750 * USDC);
    assert_eq!(s.fund().t3_basis_usd[1], 750 * USDC);
}

#[test]
fn captain_exit_floor_covers_t3_basis_while_t3_is_held() {
    // Captain 10% (2,000 of 20,000 shares): the 5% rule alone allows an exit of 200.
    let mut s = open_seas(2_000, 18_000);
    let a = s.buy(1_900);
    s.t.swap_fresh(&a).unwrap();
    let cap = s.t.cap.insecure_clone();
    let ix = ix_create_ata(
        &cap.pubkey(),
        &cap.pubkey(),
        &s.meme.mint,
        &spl_token_interface::ID,
    );
    send(&mut s.t.env.svm, &[ix], &[&cap]).unwrap();

    // 1,800 left < basis left 1,881.
    expect_err(
        exit(&mut s.t.env, &s.t.f, &cap, 200 * USDC),
        ErrorCode::CaptainStakeFloor,
    );
    // Without fresh prices the captain cannot exit at all while T3 is held.
    let ix = ix_exit_unpriced(&s.t.env, &s.t.f, &cap.pubkey(), 100 * USDC);
    expect_err(
        send(&mut s.t.env.svm, &[ix], &[&cap]),
        ErrorCode::PriceAccountMissing,
    );
    // 1,900 left >= basis left 1,890.5. The exit scales the basis like the holdings.
    exit(&mut s.t.env, &s.t.f, &cap, 100 * USDC).unwrap();
    assert_eq!(s.fund().t3_cost_basis_usd, 1_890_500_000);
    assert_eq!(s.meme_vault(), 37_810 * MEME);

    // Sold out of T3 at par (no loss): the 5% rule alone applies again.
    let a = s.sell(37_810 * MEME, 1, 20_000);
    s.t.swap_fresh(&a).unwrap();
    assert_eq!(s.fund().t3_cost_basis_usd, 0);
    let ix = ix_exit_unpriced(&s.t.env, &s.t.f, &cap.pubkey(), 200 * USDC);
    send(&mut s.t.env.svm, &[ix], &[&cap]).unwrap();
}

#[test]
fn a_new_switchboard_output_stores_its_mark() {
    let mut s = open_seas(1_000, 19_000);
    let coin = second_token(&mut s, Tier::T3);
    assert_eq!(read_entry(&s.t.env, &coin.mint).marks, Marks::default());
    let a = buy_of(&s.t, &coin.mint, 100);
    s.t.swap_fresh(&a).unwrap();
    assert_eq!(read_entry(&s.t.env, &coin.mint).marks.low, SB_ONE / 20);
    // A new Switchboard output needs a writable output entry.
    let other = second_token(&mut s, Tier::T3);
    refresh_meme(&mut s.t.env, &coin);
    let a = buy_of(&s.t, &other.mint, 100);
    let mut ix = ix_swap(&s.t.env, &s.t.f, &s.t.cap.pubkey(), None, &a);
    let entry = token_pda(&other.mint);
    for m in ix.accounts.iter_mut().filter(|m| m.pubkey == entry) {
        m.is_writable = false;
    }
    s.t.reset_budget();
    let cap = s.t.cap.insecure_clone();
    expect_anchor_err(
        send(&mut s.t.env.svm, &[ix], &[&cap]),
        anchor_lang::error::ErrorCode::ConstraintMut,
    );
}

/// After a real fall the low mark drops to the spot at once, so a pump back
/// up cannot raise the captain stake (T3 caps and the exit floor). A mark
/// that only moves 10% per interval would still read near the old price.
#[test]
fn captain_stake_after_a_fall_and_a_pump_uses_the_low_mark() {
    let mut s = open_seas(2_000, 18_000);
    let coin = second_token(&mut s, Tier::T3);
    let cap = s.t.cap.insecure_clone();
    // A 50% drawdown limit, so the fall below does not freeze trading.
    let mut policy = read_policy(&s.t.env, &s.t.f);
    policy.params.drawdown_bps = MAX_DRAWDOWN_BPS;
    write_policy(&mut s.t.env, &s.t.f, &policy);
    // 400,000 MEME sent to the fund (no basis): $20,000 at $0.05.
    inject_holding(&mut s.t.env, &s.t.f, s.meme.mint, 400_000 * MEME);
    poke(&mut s.t.env, &s.t.f, &cap).unwrap();
    warp(&mut s.t.env.svm, MARK_INTERVAL_SLOTS as i64);
    s.refresh();
    refresh_meme(&mut s.t.env, &coin);
    // MEME falls 90% to $0.005. One read: the low mark drops to $0.005, the
    // deposit mark moves one step, to $0.045.
    s.set_meme_price(SB_ONE / 200);
    poke(&mut s.t.env, &s.t.f, &cap).unwrap();
    // The captain pumps MEME back to $0.045. At min(spot, deposit mark):
    // NAV 20,000 + 18,000 = 38,000, stake 3,800. At the low mark (one step
    // up, $0.0055): NAV 20,000 + 2,200 = 22,200, stake 2,220.
    s.set_meme_price(SB_ONE * 45 / 1_000);
    let a = buy_of(&s.t, &coin.mint, 2_300);
    expect_err(s.t.swap_fresh(&a), ErrorCode::T3CapExceeded);
    let a = buy_of(&s.t, &coin.mint, 2_200);
    s.t.swap_fresh(&a).unwrap();
    // Floor: the coin's marks are warming (seeded by the buy), so it counts
    // 0. Stake NAV 17,800 + 2,200 = 20,000, pps 1.0. 1,900 left < basis
    // left 2,200 x 19,900 / 20,000 = 2,189.
    for mint in [s.meme.mint, coin.mint] {
        let ix = ix_create_ata(
            &cap.pubkey(),
            &cap.pubkey(),
            &mint,
            &spl_token_interface::ID,
        );
        send(&mut s.t.env.svm, &[ix], &[&cap]).unwrap();
    }
    expect_err(
        exit(&mut s.t.env, &s.t.f, &cap, 100 * USDC),
        ErrorCode::CaptainStakeFloor,
    );
}

/// A holding whose marks are still warming up counts 0 toward the captain
/// stake, so a just-seeded (maybe pumped) price cannot raise the T3 caps.
#[test]
fn t3_buy_during_warmup_counts_the_warming_holding_at_zero() {
    let mut s = open_seas(1_000, 19_000);
    let coin = second_token(&mut s, Tier::T3);
    let fresh = second_token(&mut s, Tier::T2);
    refresh_meme(&mut s.t.env, &coin);
    let cap = s.t.cap.insecure_clone();
    // 400,000 FRESH sent to the fund: $20,000. The poke seeds its marks now.
    inject_holding(&mut s.t.env, &s.t.f, fresh.mint, 400_000 * MEME);
    poke(&mut s.t.env, &s.t.f, &cap).unwrap();
    // Stake with FRESH: 1,000 / 20,000 x 40,000 = 2,000. Without: 1,000.
    let a = buy_of(&s.t, &coin.mint, 1_500);
    expect_err(s.t.swap_fresh(&a), ErrorCode::T3CapExceeded);
    let a = buy_of(&s.t, &coin.mint, 1_000);
    s.t.swap_fresh(&a).unwrap();
    // Warm: NAV 19,000 + 20,000 + 1,000 = 40,000, stake 2,000; 500 more fits.
    warp(&mut s.t.env.svm, MARK_WARMUP_SLOTS as i64);
    s.refresh();
    refresh_meme(&mut s.t.env, &coin);
    refresh_meme(&mut s.t.env, &fresh);
    let a = buy_of(&s.t, &coin.mint, 500);
    s.t.swap_fresh(&a).unwrap();
    assert_eq!(s.fund().t3_cost_basis_usd, 1_500 * USDC);
}

/// The captain pumps a new token's feed to $0.50 and makes its first buy at
/// the true $0.06: the buy seeds the marks at $0.50. The crew exit fee, the
/// record and the peak follow the true price.
#[test]
fn pumped_first_buy_seed_does_not_raise_the_record_or_the_crew_fee() {
    let mut s = open_seas(1_000, 19_000);
    let mut coin = second_token(&mut s, Tier::T3);
    coin.fields.value = SB_ONE / 2;
    refresh_meme(&mut s.t.env, &coin);
    // 1,000 USDC buys 16,666.666666666 COIN at $0.06 (the feed says $0.50).
    let usdc = s.t.env.usdc;
    let a = SwapArgs::new(usdc, coin.mint, 1_000 * USDC, 16_666_666_666_666, 50_000, 3);
    s.t.swap_fresh(&a).unwrap();
    assert!(read_entry(&s.t.env, &coin.mint).marks.deposit > 0);
    // True price from now on. NAV 19,000 + 999.999999 at $0.06, pps 0.999999.
    coin.fields.value = SB_ONE * 6 / 100;
    refresh_meme(&mut s.t.env, &coin);
    let crew = s.crew.insecure_clone();
    let token = spl_token_interface::ID;
    let ix = ix_create_ata(&crew.pubkey(), &crew.pubkey(), &coin.mint, &token);
    send(&mut s.t.env.svm, &[ix], &[&crew]).unwrap();
    // In the warmup: at the $0.50 mark the fee pps would be 1.3667. No profit.
    let res = exit(&mut s.t.env, &s.t.f, &crew, 1_000 * USDC).unwrap();
    assert!(decode_events::<FeeCharged>(&res).is_empty());
    // Through the warmup and 10 intervals after it the record stays at 1.0.
    let cap = s.t.cap.insecure_clone();
    for _ in 0..20 {
        warp(&mut s.t.env.svm, MARK_INTERVAL_SLOTS as i64);
        s.refresh();
        refresh_meme(&mut s.t.env, &coin);
        poke(&mut s.t.env, &s.t.f, &cap).unwrap();
        let f = s.fund();
        assert!(!f.frozen);
        assert!(f.last_price_per_share <= USDC);
        assert!(f.peak_price_per_share <= USDC);
    }
    let res = exit(&mut s.t.env, &s.t.f, &crew, 1_000 * USDC).unwrap();
    assert!(decode_events::<FeeCharged>(&res).is_empty());
}

/// A 50% pump does not let the captain leave early: the floor values the
/// stake at min(spot, mark), and the mark follows 10% per interval.
#[test]
fn captain_floor_after_a_pump_uses_the_lower_of_spot_and_mark() {
    let mut s = open_seas(2_000, 18_000);
    let a = s.buy(1_900);
    s.t.swap_fresh(&a).unwrap();
    let cap = s.t.cap.insecure_clone();
    let ix = ix_create_ata(
        &cap.pubkey(),
        &cap.pubkey(),
        &s.meme.mint,
        &spl_token_interface::ID,
    );
    send(&mut s.t.env.svm, &[ix], &[&cap]).unwrap();
    // MEME pumps 50% to $0.075. At spot: NAV 18,100 + 38,000 x 0.075 = 20,950,
    // pps 1.0475, and 1,800 left would be worth 1,885.5 >= basis left 1,881.
    s.set_meme_price(SB_ONE * 3 / 40);
    expect_err(
        exit(&mut s.t.env, &s.t.f, &cap, 200 * USDC),
        ErrorCode::CaptainStakeFloor,
    );
    // Four intervals: mark 0.055, 0.0605, 0.06655, 0.073205. pps 1.044089,
    // 1,800 x 1.044089 = 1,879.36 < 1,881.
    for _ in 0..4 {
        warp(&mut s.t.env.svm, MARK_INTERVAL_SLOTS as i64);
        s.refresh();
        poke(&mut s.t.env, &s.t.f, &cap).unwrap();
    }
    expect_err(
        exit(&mut s.t.env, &s.t.f, &cap, 200 * USDC),
        ErrorCode::CaptainStakeFloor,
    );
    // The fifth step reaches the spot: 1,885.5 >= 1,881.
    warp(&mut s.t.env.svm, MARK_INTERVAL_SLOTS as i64);
    s.refresh();
    exit(&mut s.t.env, &s.t.f, &cap, 200 * USDC).unwrap();
}

/// A 10x pump does not raise the captain stake that caps T3 buys.
#[test]
fn t3_cap_stake_ignores_a_pump() {
    let mut s = open_seas(1_000, 19_000);
    let a = s.buy(500);
    s.t.swap_fresh(&a).unwrap();
    // MEME pumps 10x to $0.50. At spot: NAV 19,500 + 10,000 x 0.5 = 24,500,
    // pps 1.225, captain stake 1,225. At the mark ($0.05) the stake is 1,000.
    s.set_meme_price(SB_ONE / 2);
    let usdc = s.t.env.usdc;
    // 700 more (1,400 MEME at $0.50): basis 1,200 fits 1,225, not 1,000.
    let a = SwapArgs::new(usdc, s.meme.mint, 700 * USDC, 1_400 * MEME, 2_000, 1);
    expect_err(s.t.swap_fresh(&a), ErrorCode::T3CapExceeded);
    let a = SwapArgs::new(usdc, s.meme.mint, 500 * USDC, 1_000 * MEME, 2_000, 1);
    s.t.swap_fresh(&a).unwrap();
    assert_eq!(s.fund().t3_cost_basis_usd, 1_000 * USDC);
}

#[test]
fn member_exit_scales_the_t3_basis() {
    let mut s = open_seas(1_000, 19_000);
    let a = s.buy(1_000);
    s.t.swap_fresh(&a).unwrap();
    let crew = s.crew.insecure_clone();
    let ix = ix_create_ata(
        &crew.pubkey(),
        &crew.pubkey(),
        &s.meme.mint,
        &spl_token_interface::ID,
    );
    send(&mut s.t.env.svm, &[ix], &[&crew]).unwrap();
    // Half the shares leave with half of every holding, and half the basis.
    exit(&mut s.t.env, &s.t.f, &crew, 10_000 * USDC).unwrap();
    assert_eq!(s.meme_vault(), 10_000 * MEME);
    assert_eq!(s.fund().t3_cost_basis_usd, 500 * USDC);
    // So a full sale at par is not a loss.
    let a = s.sell(10_000 * MEME, 1, 20_000);
    let res = s.t.swap_fresh(&a).unwrap();
    assert!(decode_events::<FirstLossApplied>(&res).is_empty());
    assert_eq!(s.captain_shares(), 1_000 * USDC);
}

#[test]
fn voted_t3_buy_obeys_the_cap() {
    let mut s = open_seas(1_000, 19_000);
    let cap = s.t.cap.insecure_clone();
    let crew = s.crew.insecure_clone();
    // A vote needs a deposit older than the proposal.
    warp(&mut s.t.env.svm, 1);
    s.refresh();
    for (id, usd) in [(0, 1_500), (1, 1_000)] {
        let a = s.buy(usd);
        let ix = ix_propose(&s.t.env, &s.t.f, &cap.pubkey(), None, &a, venue_data(&a));
        send(&mut s.t.env.svm, &[ix], &[&cap]).unwrap();
        send(
            &mut s.t.env.svm,
            &[ix_vote(&s.t.f, &crew.pubkey(), id, true)],
            &[&crew],
        )
        .unwrap();
        let ix = ix_execute_proposal(&s.t.env, &s.t.f, &crew.pubkey(), id, &a, venue_data(&a));
        let res = send(&mut s.t.env.svm, &[ix], &[&crew]);
        if usd > 1_000 {
            expect_err(res, ErrorCode::T3CapExceeded);
        } else {
            res.unwrap();
        }
    }
    assert_eq!(s.fund().t3_cost_basis_usd, 1_000 * USDC);
}

#[test]
fn t3_trade_rejects_a_captain_share_account_that_is_not_the_ata() {
    let mut s = open_seas(1_000, 19_000);
    let a = s.buy(1_000);
    s.t.swap_fresh(&a).unwrap();
    // A sale at a loss with the crew's share account in the captain slot.
    let a = s.sell(20_000 * MEME, 99, 2_000_000);
    let mut ix = ix_swap(&s.t.env, &s.t.f, &s.t.cap.pubkey(), None, &a);
    let slot = ix
        .accounts
        .iter()
        .position(|m| m.pubkey == share_ata(&s.t.f, &s.t.cap.pubkey()))
        .unwrap();
    ix.accounts[slot].pubkey = share_ata(&s.t.f, &s.crew.pubkey());
    s.t.reset_budget();
    let cap = s.t.cap.insecure_clone();
    expect_anchor_err(
        send(&mut s.t.env.svm, &[ix], &[&cap]),
        anchor_lang::error::ErrorCode::ConstraintAddress,
    );
}

#[test]
fn t3_trade_rejects_a_member_account_that_is_not_the_captain() {
    let mut s = open_seas(1_000, 19_000);
    let a = s.buy(1_000);
    let mut ix = ix_swap(&s.t.env, &s.t.f, &s.t.cap.pubkey(), None, &a);
    let slot = ix
        .accounts
        .iter()
        .position(|m| m.pubkey == member_pda(&s.t.f.fund, &s.t.cap.pubkey()))
        .unwrap();
    ix.accounts[slot].pubkey = member_pda(&s.t.f.fund, &s.crew.pubkey());
    s.t.reset_budget();
    let cap = s.t.cap.insecure_clone();
    expect_anchor_err(
        send(&mut s.t.env.svm, &[ix], &[&cap]),
        anchor_lang::error::ErrorCode::ConstraintSeeds,
    );
}

#[test]
fn buy_into_a_based_holding_takes_basis_and_caps_after_a_retier() {
    let mut s = open_seas(1_000, 19_000);
    let a = s.buy(500);
    s.t.swap_fresh(&a).unwrap();
    let meme = s.meme;
    retier(&mut s, &meme, Tier::T2);
    // MEME is T2 now, but the holding has a basis: the buy joins it.
    let a = s.buy(300);
    s.t.swap_fresh(&a).unwrap();
    let f = s.fund();
    assert_eq!(f.t3_basis_usd[1], 800 * USDC);
    assert_eq!(f.t3_cost_basis_usd, 800 * USDC);
    assert_eq!(f.t3_window_buys_usd, 800 * USDC);
    let a = s.buy(201);
    expect_err(s.t.swap_fresh(&a), ErrorCode::T3CapExceeded);
}

#[test]
fn t3_buy_into_units_without_basis_is_rejected() {
    let mut s = open_seas(1_000, 19_000);
    let coin = second_token(&mut s, Tier::T2);
    let a = buy_of(&s.t, &coin.mint, 500);
    s.t.swap_fresh(&a).unwrap();
    assert_eq!(s.fund().t3_cost_basis_usd, 0);
    retier(&mut s, &coin, Tier::T3);
    let a = buy_of(&s.t, &coin.mint, 100);
    expect_err(s.t.swap_fresh(&a), ErrorCode::T3UnbasedHolding);
    // Sold out (no basis, so no T3 accounts), the next T3 buy starts a basis.
    let usdc = s.t.env.usdc;
    let sell = SwapArgs::new(coin.mint, usdc, 10_000 * MEME, 500 * USDC, 1, 20_000);
    s.t.swap_fresh(&sell).unwrap();
    s.t.swap_fresh(&a).unwrap();
    assert_eq!(s.fund().t3_cost_basis_usd, 100 * USDC);
}

#[test]
fn t3_to_t3_rotation_takes_a_sale_into_usdc_then_a_buy() {
    let mut s = open_seas(1_000, 19_000);
    let coin = second_token(&mut s, Tier::T3);
    let a = s.buy(400); // 8,000 MEME, basis 400
    s.t.swap_fresh(&a).unwrap();
    // A sale into a token the captain can price from its own pool could hide
    // the loss: MEME into COIN in one trade is rejected.
    let rotate = SwapArgs::new(s.meme.mint, coin.mint, 8_000 * MEME, 7_920 * MEME, 99, 100);
    expect_err(s.t.swap_fresh(&rotate), ErrorCode::T3ExitRouteNotAllowed);
    // Sale first: all MEME for 1% less USDC, a loss of 4 on the MEME basis.
    let a = s.sell(8_000 * MEME, 99, 2_000_000);
    let res = s.t.swap_fresh(&a).unwrap();
    let ev = decode_events::<FirstLossApplied>(&res);
    assert_eq!(
        (ev[0].loss_usd, ev[0].captain_shares_burned),
        (4 * USDC, 4 * USDC)
    );
    assert_eq!(s.captain_shares(), 996 * USDC);
    s.assert_supply();
    // Then the buy: COIN takes MEME's slot with its own basis.
    let a = buy_of(&s.t, &coin.mint, 396);
    s.t.swap_fresh(&a).unwrap();
    let f = s.fund();
    assert_eq!(f.holdings[..2], [s.t.env.usdc, coin.mint]);
    assert_eq!(f.t3_basis_usd[..3], [0, 396 * USDC, 0]);
    assert_eq!(f.t3_cost_basis_usd, 396 * USDC);
    assert_eq!(f.t3_window_buys_usd, 796 * USDC);
}

#[test]
fn t3_sale_exits_only_to_usdc_or_a_pyth_or_kamino_token() {
    for tier in [Tier::T2, Tier::T3] {
        let mut s = open_seas(1_000, 19_000);
        let coin = second_token(&mut s, tier);
        let a = s.buy(400);
        s.t.swap_fresh(&a).unwrap();
        // COIN's feed reads 2.5x: 3,200 COIN would show proceeds of 400 for a
        // sale worth 160 at the pool. Any Switchboard output is rejected.
        s.t.swap_fresh(&buy_of(&s.t, &coin.mint, 10)).unwrap();
        let mut pumped = coin;
        pumped.fields.value = SB_ONE / 8;
        refresh_meme(&mut s.t.env, &pumped);
        let rotate = SwapArgs::new(s.meme.mint, coin.mint, 8_000 * MEME, 3_200 * MEME, 2, 5);
        expect_err(s.t.swap_fresh(&rotate), ErrorCode::T3ExitRouteNotAllowed);
        // COIN bought as T3 has a basis of 10; as T2 it has none.
        let coin_basis = if tier == Tier::T3 { 10 * USDC } else { 0 };
        assert_eq!(s.fund().t3_cost_basis_usd, 400 * USDC + coin_basis);
        // A Pyth output (SOL at $150) is allowed: 8,000 MEME ($400) for 2.67 SOL.
        let sol = s.t.sol;
        let a = SwapArgs::new(s.meme.mint, sol, 8_000 * MEME, 2_640_000_000, 1, 3_000);
        s.t.swap_fresh(&a).unwrap();
        let f = s.fund();
        assert_eq!(f.t3_cost_basis_usd, coin_basis);
        assert!(!f.holdings.contains(&s.meme.mint));
    }
}

#[test]
fn delegate_t3_buy_obeys_the_cap() {
    let mut s = open_seas(1_000, 19_000);
    let key = funded(&mut s.t.env.svm);
    let cap = s.t.cap.insecure_clone();
    let ix = ix_add_delegate(
        &cap.pubkey(),
        &s.t.f,
        &key.pubkey(),
        10_000 * USDC,
        10_000 * USDC,
    );
    send(&mut s.t.env.svm, &[ix], &[&cap]).unwrap();
    let d = Some(delegate_pda(&s.t.f.fund, &key.pubkey()));
    for (usd, ok) in [(1_001, false), (1_000, true)] {
        let a = s.buy(usd);
        let ix = ix_swap(&s.t.env, &s.t.f, &key.pubkey(), d, &a);
        let res = send(&mut s.t.env.svm, &[ix], &[&key]);
        if ok {
            res.unwrap();
        } else {
            expect_err(res, ErrorCode::T3CapExceeded);
        }
    }
    assert_eq!(s.fund().t3_cost_basis_usd, 1_000 * USDC);
}

#[test]
fn exit_rounds_a_tiny_basis_up_while_units_remain() {
    let mut s = open_seas(1_000, 19_000);
    // 1 USDC base unit buys 20,000 MEME base units: basis 1.
    let usdc = s.t.env.usdc;
    let a = SwapArgs::new(usdc, s.meme.mint, 1, 20_000, 20_000, 1);
    s.t.swap_fresh(&a).unwrap();
    assert_eq!(s.fund().t3_cost_basis_usd, 1);
    let crew = s.crew.insecure_clone();
    let ix = ix_create_ata(
        &crew.pubkey(),
        &crew.pubkey(),
        &s.meme.mint,
        &spl_token_interface::ID,
    );
    send(&mut s.t.env.svm, &[ix], &[&crew]).unwrap();
    // 95% of the shares leave: 1 x 5% floors to 0, but 1,000 MEME units remain.
    exit(&mut s.t.env, &s.t.f, &crew, 19_000 * USDC).unwrap();
    assert_eq!(s.meme_vault(), 1_000);
    let f = s.fund();
    assert_eq!((f.t3_basis_usd[1], f.t3_cost_basis_usd), (1, 1));
    // So the holding is still based, and a T3 buy into it passes.
    let a = s.buy(10);
    s.t.swap_fresh(&a).unwrap();
    assert_eq!(s.fund().t3_cost_basis_usd, 10 * USDC + 1);
}

/// Buy SOL ($150) with `usd` USDC: 1 USDC unit = 20/3 SOL units.
fn buy_sol(s: &Seas, usd: u64) -> SwapArgs {
    let out = usd * USDC * 20 / 3;
    SwapArgs::new(s.t.env.usdc, s.t.sol, usd * USDC, out * 99 / 100, 20, 3)
}

/// Sell 1 SOL into USDC at $150.
fn sell_one_sol(s: &Seas) -> SwapArgs {
    SwapArgs::new(s.t.sol, s.t.env.usdc, SOL, 150 * USDC, 3, 20)
}

/// Break the MEME feed: `stale` leaves it unpublished (the caller warps),
/// `repointed` publishes a result for another job.
fn break_meme(s: &mut Seas, how: &str) -> ErrorCode {
    if how == "stale" {
        return ErrorCode::PriceStale;
    }
    let mut other = s.meme;
    other.fields.feed_hash = [9; 32];
    refresh_meme(&mut s.t.env, &other);
    ErrorCode::FeedConfigChanged
}

#[test]
fn sell_to_usdc_survives_a_broken_feed_on_another_holding() {
    for how in ["stale", "repointed"] {
        let mut s = open_seas(1_000, 19_000);
        let a = s.buy(400);
        s.t.swap_fresh(&a).unwrap();
        let a = buy_sol(&s, 300);
        s.t.swap_fresh(&a).unwrap();
        // Past the record interval and the 60 s age cap; MEME is not re-published.
        warp(&mut s.t.env.svm, 300);
        s.t.refresh_prices();
        let code = break_meme(&mut s, how);
        // The broken feed still blocks a buy, and a sale of MEME itself.
        let a = buy_sol(&s, 10);
        expect_err(s.t.swap_fresh(&a), code);
        let a = s.sell(1_000 * MEME, 1, 20_000);
        expect_err(s.t.swap_fresh(&a), code);

        let before = s.fund();
        let usdc = token_balance(&s.t.env.svm, &s.t.f.usdc_vault);
        let marks = read_entry(&s.t.env, &s.meme.mint).marks;
        let a = sell_one_sol(&s);
        s.t.swap_fresh(&a).unwrap();
        let f = s.fund();
        assert_eq!(
            token_balance(&s.t.env.svm, &s.t.f.usdc_vault),
            usdc + 150 * USDC
        );
        // MEME counted 0: nothing of the breaker, the record or the marks moved.
        assert_eq!(
            (
                f.last_price_per_share,
                f.last_pps_slot,
                f.peak_price_per_share,
                f.frozen
            ),
            (
                before.last_price_per_share,
                before.last_pps_slot,
                before.peak_price_per_share,
                before.frozen
            )
        );
        assert_eq!(read_entry(&s.t.env, &s.meme.mint).marks, marks);
        // Control: with MEME priced again, the same sale records.
        refresh_meme(&mut s.t.env, &s.meme);
        let a = sell_one_sol(&s);
        s.t.swap_fresh(&a).unwrap();
        assert_ne!(s.fund().last_pps_slot, before.last_pps_slot);
    }
}

#[test]
fn sell_to_usdc_with_an_unpriced_holding_stores_no_mark() {
    let mut s = open_seas(1_000, 19_000);
    let coin = second_token(&mut s, Tier::T2);
    let a = buy_of(&s.t, &coin.mint, 500);
    s.t.swap_fresh(&a).unwrap();
    let a = s.buy(400);
    s.t.swap_fresh(&a).unwrap();
    warp(&mut s.t.env.svm, MARK_WARMUP_SLOTS as i64);
    s.t.refresh_prices();
    refresh_meme(&mut s.t.env, &coin);
    // MEME is stale; COIN, the input, prices.
    let marks = read_entry(&s.t.env, &coin.mint).marks;
    let usdc = s.t.env.usdc;
    let sell = SwapArgs::new(coin.mint, usdc, 1_000 * MEME, 50 * USDC, 1, 20_000);
    s.t.swap_fresh(&sell).unwrap();
    assert_eq!(read_entry(&s.t.env, &coin.mint).marks, marks);
    // Control: with every feed fresh, the same sale moves COIN's marks.
    refresh_meme(&mut s.t.env, &s.meme);
    s.t.swap_fresh(&sell).unwrap();
    assert_ne!(read_entry(&s.t.env, &coin.mint).marks, marks);
}

/// The burn reads the recorded pps, not a fresh one, so a T3 loss sale into
/// USDC passes while another holding's feed is broken, and burns exactly.
#[test]
fn t3_loss_sale_passes_while_another_feed_is_broken() {
    let mut s = open_seas(1_000, 19_000);
    let coin = second_token(&mut s, Tier::T3);
    let a = s.buy(400);
    s.t.swap_fresh(&a).unwrap();
    let a = buy_of(&s.t, &coin.mint, 400);
    s.t.swap_fresh(&a).unwrap();
    warp(&mut s.t.env.svm, 300);
    s.refresh();
    // COIN is stale: a buy is blocked.
    let a = buy_of(&s.t, &s.meme.mint, 10);
    expect_err(s.t.swap_fresh(&a), ErrorCode::PriceStale);
    // All MEME for 396 USDC: a loss of 4, 4 shares at the recorded pps 1.0.
    let before = s.fund();
    let loss = s.sell(8_000 * MEME, 99, 2_000_000);
    let res = s.t.swap_fresh(&loss).unwrap();
    let ev = decode_events::<FirstLossApplied>(&res);
    assert_eq!(
        (ev[0].loss_usd, ev[0].captain_shares_burned),
        (4 * USDC, 4 * USDC)
    );
    assert_eq!(s.captain_shares(), 996 * USDC);
    let f = s.fund();
    assert_eq!(f.total_shares, 19_996 * USDC);
    assert_eq!(f.t3_cost_basis_usd, 400 * USDC);
    s.assert_supply();
    // COIN counted 0: the record did not move.
    assert_eq!(
        (f.last_price_per_share, f.last_pps_slot),
        (before.last_price_per_share, before.last_pps_slot)
    );
}

/// WIF: a 6-dp token listed T3 with a Pyth price of $1, with a deep pool.
fn listed_wif(s: &mut Seas) -> Pubkey {
    const WIF_FEED: [u8; 32] = [40; 32];
    let wif = create_mint(&mut s.t.env, 6);
    register_token(&mut s.t.env, wif, WIF_FEED, Tier::T3);
    let usdc = s.t.env.usdc;
    setup_venue_pool(&mut s.t.env, &usdc, &wif, 0, 1_000_000 * USDC);
    s.refresh();
    set_usd_price(&mut s.t.env, &wif, &WIF_FEED, 100_000_000);
    wif
}

#[test]
fn t3_sale_into_a_t3_pyth_token_is_rejected() {
    let mut s = open_seas(1_000, 19_000);
    let wif = listed_wif(&mut s);
    let a = s.buy(400); // 8,000 MEME, basis 400
    s.t.swap_fresh(&a).unwrap();
    // MEME into WIF in one trade: WIF's basis would take MEME's (movable)
    // spot value, not its cost.
    let rotate = SwapArgs::new(s.meme.mint, wif, 8_000 * MEME, 396 * USDC, 1, 20_000);
    expect_err(s.t.swap_fresh(&rotate), ErrorCode::T3ExitRouteNotAllowed);
    // Into a based Pyth holding: also rejected.
    let a = SwapArgs::new(s.t.env.usdc, wif, 100 * USDC, 99 * USDC, 1, 1);
    s.t.swap_fresh(&a).unwrap();
    expect_err(s.t.swap_fresh(&rotate), ErrorCode::T3ExitRouteNotAllowed);
    // Two trades work: MEME into USDC at cost, then USDC into WIF at cost.
    let a = s.sell(8_000 * MEME, 1, 20_000);
    s.t.swap_fresh(&a).unwrap();
    let a = SwapArgs::new(s.t.env.usdc, wif, 400 * USDC, 396 * USDC, 1, 1);
    s.t.swap_fresh(&a).unwrap();
    let f = s.fund();
    assert!(!f.holdings.contains(&s.meme.mint));
    let i = f.holdings.iter().position(|m| *m == wif).unwrap();
    assert_eq!(f.t3_basis_usd[i], 500 * USDC);
    assert_eq!(f.t3_cost_basis_usd, 500 * USDC);
}

#[test]
fn t3_buy_spends_only_usdc_or_an_unbased_pyth_or_kamino_holding() {
    let mut s = open_seas(1_000, 19_000);
    // Listing waits out a timelock: re-publish COIN after WIF is listed.
    let coin = second_token(&mut s, Tier::T2);
    let wif = listed_wif(&mut s);
    refresh_meme(&mut s.t.env, &coin);
    let a = buy_of(&s.t, &coin.mint, 500);
    s.t.swap_fresh(&a).unwrap();
    // A Switchboard input (unbased T2 COIN) cannot start a basis.
    let into_meme = SwapArgs::new(coin.mint, s.meme.mint, 1_000 * MEME, 990 * MEME, 1, 1);
    expect_err(
        s.t.swap_fresh(&into_meme),
        ErrorCode::T3EntryRouteNotAllowed,
    );
    let into_wif = SwapArgs::new(coin.mint, wif, 1_000 * MEME, 49 * USDC, 1, 20_000);
    expect_err(s.t.swap_fresh(&into_wif), ErrorCode::T3EntryRouteNotAllowed);
    // SOL (Pyth, unbased) into MEME: 1 SOL ($150) for 3,000 MEME, basis 150.
    let a = buy_sol(&s, 300);
    s.t.swap_fresh(&a).unwrap();
    let a = SwapArgs::new(s.t.sol, s.meme.mint, SOL, 2_970 * MEME, 3_000, 1);
    s.t.swap_fresh(&a).unwrap();
    assert_eq!(s.fund().t3_cost_basis_usd, 150 * USDC);
    // USDC into WIF: basis 100 more.
    let a = SwapArgs::new(s.t.env.usdc, wif, 100 * USDC, 99 * USDC, 1, 1);
    s.t.swap_fresh(&a).unwrap();
    assert_eq!(s.fund().t3_cost_basis_usd, 250 * USDC);
}

/// Captain 10,000, crew A and B 45,000 each. The fund buys 200,000 MEME
/// ($10,000 of basis), then MEME falls 80% to $0.01 and stays there until
/// the slow price follows it (16 intervals). The record stays at 1.0 (T3 at
/// cost). Returns A, with a MEME account.
fn crashed_fund() -> (Seas, Keypair) {
    let mut s = open_seas(10_000, 45_000);
    let b = funded_user(&mut s.t.env, 45_000 * USDC);
    deposit(&mut s.t.env, &s.t.f, &b, 45_000 * USDC).unwrap();
    let a = s.buy(10_000);
    s.t.swap_fresh(&a).unwrap();
    assert_eq!(s.meme_vault(), 200_000 * MEME);
    crash_meme(&mut s);
    let crew = s.crew.insecure_clone();
    meme_account(&mut s, &crew);
    (s, crew)
}

/// MEME falls to $0.01; poke once per interval until the slow price is
/// there (16 intervals). The record stays at 1.0 (T3 at cost).
fn crash_meme(s: &mut Seas) {
    s.set_meme_price(SB_ONE / 100);
    let cap = s.t.cap.insecure_clone();
    for _ in 0..16 {
        warp(&mut s.t.env.svm, MARK_INTERVAL_SLOTS as i64);
        s.refresh();
        poke(&mut s.t.env, &s.t.f, &cap).unwrap();
    }
    assert_eq!(
        read_entry(&s.t.env, &s.meme.mint).marks.deposit,
        SB_ONE / 100
    );
    assert_eq!(s.fund().last_price_per_share, 1_000_000);
}

/// Create `user`'s MEME account.
fn meme_account(s: &mut Seas, user: &Keypair) {
    let ix = ix_create_ata(
        &user.pubkey(),
        &user.pubkey(),
        &s.meme.mint,
        &spl_token_interface::ID,
    );
    send(&mut s.t.env.svm, &[ix], &[user]).unwrap();
}

/// USD value of `user`'s USDC and MEME (at $0.01), USDC base units.
fn value_at_one_cent(s: &Seas, user: &Pubkey) -> u64 {
    let meme = token_balance(
        &s.t.env.svm,
        &ata(user, &s.meme.mint, &spl_token_interface::ID),
    );
    token_balance(&s.t.env.svm, &usdc_ata(&s.t.env, user)) + meme / 100_000
}

/// A crew exit with prices redeems captain shares worth its part of the
/// unrealized T3 loss at the true pps (the record, T3 at cost, less the
/// loss): the exiter leaves with exactly what it paid. The later sale burns
/// exactly the loss left, and the captain loses exactly the 8,000.
#[test]
fn crew_exit_with_prices_takes_its_part_of_the_t3_loss_from_the_captain() {
    let (mut s, a) = crashed_fund();
    // A's part: 8,000 x 45% = 3,600. True pps (100,000 - 8,000) / 100,000:
    // 3,600 / 0.92 = 3,913.043479 shares (rounded up).
    let burned = 3_913_043_479;
    let res = exit(&mut s.t.env, &s.t.f, &a, 45_000 * USDC).unwrap();
    let ev = decode_events::<FirstLossApplied>(&res);
    assert_eq!(
        (ev[0].loss_usd, ev[0].captain_shares_burned),
        (3_600 * USDC, burned)
    );
    // 44,021.739131 USDC + 97,826.086958 MEME ($978.260869). Without the burn: 41,400.
    assert_eq!(value_at_one_cent(&s, &a.pubkey()), 45_000 * USDC);
    assert_eq!(s.captain_shares(), 10_000 * USDC - burned);
    let f = s.fund();
    assert_eq!(f.total_shares, 55_000 * USDC - burned);
    s.assert_supply();
    // The basis scales by the shares left (rounded up).
    assert_eq!(f.t3_cost_basis_usd, 5_108_695_653);
    assert_eq!(f.last_price_per_share, 1_000_000);
    let member: Member = read_account(&s.t.env.svm, &member_pda(&s.t.f.fund, &s.t.cap.pubkey()));
    assert_eq!(member.hwm, 10_000 * USDC - burned);

    // The sale realizes the loss left, 5,108.695653 - 1,021.739130, and
    // burns it at the recorded pps 1.0.
    let sale = s.sell(s.meme_vault(), 1, 100_000);
    let res = s.t.swap_fresh(&sale).unwrap();
    let ev = decode_events::<FirstLossApplied>(&res);
    assert_eq!(
        (ev[0].loss_usd, ev[0].captain_shares_burned),
        (4_086_956_523, 4_086_956_523)
    );
    s.assert_supply();
    // Captain 1,999.999998 shares of 46,999.999998, NAV 46,999.999999: the
    // captain lost the 8,000, B keeps its 45,000.
    assert_eq!(s.captain_shares(), 1_999_999_998);
    assert_eq!(s.fund().total_shares, 46_999_999_998);
    assert_eq!(
        token_balance(&s.t.env.svm, &s.t.f.usdc_vault),
        46_999_999_999
    );
}

/// A sale after a real crash (spot and slow price already down) burns
/// exactly the loss: shares at the recorded pps, T3 at cost.
#[test]
fn sale_after_a_real_crash_burns_exactly_the_loss() {
    let (mut s, _) = crashed_fund();
    let sale = s.sell(200_000 * MEME, 1, 100_000);
    let res = s.t.swap_fresh(&sale).unwrap();
    let ev = decode_events::<FirstLossApplied>(&res);
    assert_eq!(
        (ev[0].loss_usd, ev[0].captain_shares_burned),
        (8_000 * USDC, 8_000 * USDC)
    );
    // NAV 92,000 for 92,000 shares: the crew keeps 90,000, the captain 2,000.
    assert_eq!(s.captain_shares(), 2_000 * USDC);
    assert_eq!(s.fund().total_shares, 92_000 * USDC);
    assert_eq!(
        token_balance(&s.t.env.svm, &s.t.f.usdc_vault),
        92_000 * USDC
    );
    s.assert_supply();
}

/// The captain's own exit pays no compensation.
#[test]
fn captain_exit_gets_no_compensation() {
    let mut s = open_seas(10_000, 10_000);
    let a = s.buy(1_000);
    s.t.swap_fresh(&a).unwrap();
    crash_meme(&mut s);
    let cap = s.t.cap.insecure_clone();
    meme_account(&mut s, &cap);
    let res = exit(&mut s.t.env, &s.t.f, &cap, 100 * USDC).unwrap();
    assert!(decode_events::<FirstLossApplied>(&res).is_empty());
    assert_eq!(s.captain_shares(), 9_900 * USDC);
    assert_eq!(s.fund().total_shares, 19_900 * USDC);
    // 100 / 20,000 of 20,000 MEME left.
    assert_eq!(s.meme_vault(), 19_900 * MEME);
}

/// A T3 holding in its mark warmup pays no exit compensation, though its
/// slow price is already below cost.
#[test]
fn warming_holding_gives_no_exit_compensation() {
    let mut s = open_seas(1_000, 19_000);
    let mut coin = second_token(&mut s, Tier::T3);
    // The buy seeds COIN's marks at $0.05.
    let a = buy_of(&s.t, &coin.mint, 1_000);
    s.t.swap_fresh(&a).unwrap();
    coin.fields.value = SB_ONE / 100;
    let cap = s.t.cap.insecure_clone();
    for _ in 0..5 {
        warp(&mut s.t.env.svm, MARK_INTERVAL_SLOTS as i64);
        s.refresh();
        refresh_meme(&mut s.t.env, &coin);
        poke(&mut s.t.env, &s.t.f, &cap).unwrap();
    }
    // Slow price $0.05 x 0.9^5 = $0.0295245: 590 for a basis of 1,000. Still warming.
    let marks = read_entry(&s.t.env, &coin.mint).marks;
    assert_eq!(marks.deposit, SB_ONE * 295_245 / 10_000_000);
    assert!(marks.warming(s.t.env.svm.get_sysvar::<Clock>().slot));
    let crew = s.crew.insecure_clone();
    let ix = ix_create_ata(
        &crew.pubkey(),
        &crew.pubkey(),
        &coin.mint,
        &spl_token_interface::ID,
    );
    send(&mut s.t.env.svm, &[ix], &[&crew]).unwrap();
    let res = exit(&mut s.t.env, &s.t.f, &crew, 10_000 * USDC).unwrap();
    assert!(decode_events::<FirstLossApplied>(&res).is_empty());
    assert_eq!(s.captain_shares(), 1_000 * USDC);
}

/// An exit with no price accounts still works: in kind, no compensation.
#[test]
fn price_free_crew_exit_works_without_compensation() {
    let (mut s, a) = crashed_fund();
    let ix = ix_exit_unpriced(&s.t.env, &s.t.f, &a.pubkey(), 45_000 * USDC);
    let res = send(&mut s.t.env.svm, &[ix], &[&a]).unwrap();
    assert!(decode_events::<FirstLossApplied>(&res).is_empty());
    // 40,500 USDC + 90,000 MEME ($900).
    assert_eq!(value_at_one_cent(&s, &a.pubkey()), 41_400 * USDC);
    assert_eq!(s.captain_shares(), 10_000 * USDC);
    assert_eq!(s.fund().total_shares, 55_000 * USDC);
    assert_eq!(s.fund().t3_cost_basis_usd, 5_500 * USDC);
    s.assert_supply();
}

/// A spot dumped below the slow price does not raise the compensation.
#[test]
fn dumped_spot_does_not_raise_exit_compensation() {
    let (mut s, a) = crashed_fund();
    s.set_meme_price(SB_ONE / 1_000);
    let res = exit(&mut s.t.env, &s.t.f, &a, 45_000 * USDC).unwrap();
    let ev = decode_events::<FirstLossApplied>(&res);
    assert_eq!(
        (ev[0].loss_usd, ev[0].captain_shares_burned),
        (3_600 * USDC, 3_913_043_479)
    );

    // Right after a crash the slow price is still at cost: no loss yet.
    let mut s = open_seas(1_000, 19_000);
    let a = s.buy(1_000);
    s.t.swap_fresh(&a).unwrap();
    s.set_meme_price(SB_ONE / 1_000);
    let crew = s.crew.insecure_clone();
    let ix = ix_create_ata(
        &crew.pubkey(),
        &crew.pubkey(),
        &s.meme.mint,
        &spl_token_interface::ID,
    );
    send(&mut s.t.env.svm, &[ix], &[&crew]).unwrap();
    let res = exit(&mut s.t.env, &s.t.f, &crew, 10_000 * USDC).unwrap();
    assert!(decode_events::<FirstLossApplied>(&res).is_empty());
    assert_eq!(s.captain_shares(), 1_000 * USDC);
}

/// With valid prices and a loss to pay, the captain's Member account is
/// required: a priced exit does not silently drop the compensation.
#[test]
fn priced_crew_exit_with_a_loss_needs_the_captain_member() {
    let (mut s, a) = crashed_fund();
    let mut ix = ix_exit_unpriced(&s.t.env, &s.t.f, &a.pubkey(), 45_000 * USDC);
    ix.accounts.extend(nav_accounts(&s.t.env, &s.t.f));
    expect_err(
        send(&mut s.t.env.svm, &[ix.clone()], &[&a]),
        ErrorCode::CaptainMemberMissing,
    );
    // Another member's account is rejected too.
    ix.accounts.push(AccountMeta::new(
        member_pda(&s.t.f.fund, &a.pubkey()),
        false,
    ));
    assert!(send(&mut s.t.env.svm, &[ix], &[&a]).is_err());
}

/// The captain pumps MEME's spot back to cost for A's exit read. The
/// compensation uses the slow price only, so the pump does not cancel it:
/// with no interval passed A gets exactly 45,000; with one interval passed
/// the read moves the slow price one 10% step ($0.011), and A is short at
/// most its part of that step.
#[test]
fn pumped_spot_at_exit_does_not_cancel_compensation() {
    for wait in [false, true] {
        let (mut s, a) = crashed_fund();
        if wait {
            warp(&mut s.t.env.svm, MARK_INTERVAL_SLOTS as i64);
            s.refresh();
        }
        s.set_meme_price(SB_ONE / 20);
        let res = exit(&mut s.t.env, &s.t.f, &a, 45_000 * USDC).unwrap();
        let ev = decode_events::<FirstLossApplied>(&res);
        let got = value_at_one_cent(&s, &a.pubkey());
        if wait {
            // Loss 10,000 - 2,200 = 7,800, A's part 3,510.
            assert_eq!(ev[0].loss_usd, 3_510 * USDC);
            // One step is $200 on the 200,000 MEME; A's 45% of it is $90.
            assert!((44_900 * USDC..45_000 * USDC).contains(&got), "{got}");
        } else {
            assert_eq!(ev[0].loss_usd, 3_600 * USDC);
            assert_eq!(got, 45_000 * USDC);
        }
    }
}

/// A member waits one interval, then dumps MEME's spot for its exit read.
/// The read moves the slow price only one 10% step down ($0.009), so A
/// gains at most its part of that step.
#[test]
fn dump_after_one_interval_gains_at_most_one_step() {
    let (mut s, a) = crashed_fund();
    warp(&mut s.t.env.svm, MARK_INTERVAL_SLOTS as i64);
    s.refresh();
    s.set_meme_price(SB_ONE / 1_000);
    let res = exit(&mut s.t.env, &s.t.f, &a, 45_000 * USDC).unwrap();
    let ev = decode_events::<FirstLossApplied>(&res);
    // Loss 10,000 - 1,800 = 8,200, A's part 3,690.
    assert_eq!(ev[0].loss_usd, 3_690 * USDC);
    assert_eq!(
        read_entry(&s.t.env, &s.meme.mint).marks.deposit,
        SB_ONE * 9 / 1_000
    );
    // At the true $0.01: one step is $200 on the 200,000 MEME; A's 45% is $90.
    let got = value_at_one_cent(&s, &a.pubkey());
    assert!((45_000 * USDC + 1..=45_100 * USDC).contains(&got), "{got}");
}
