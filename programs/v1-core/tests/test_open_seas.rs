//! Open Seas funds: T3 caps at cost, the 30-day buy window, first-loss
//! burns of captain shares, and the captain exit floor while T3 is held.

mod common;

use {
    common::*,
    v1_core::{
        events::FirstLossApplied,
        state::{Marks, Member},
    },
};

const USDC: u64 = 1_000_000;
/// One MEME (9 dp). MEME starts at $0.05, so 1 USDC buys 20 MEME.
const MEME: u64 = 1_000_000_000;

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
    // MEME falls to $0.0001: 20,000 MEME are worth 2 USDC.
    s.set_meme_price(SB_ONE / 10_000);
    let a = s.sell(20_000 * MEME, 1, 10_000_000);
    let res = s.t.swap_fresh(&a).unwrap();
    // Loss 998; shares worth 998 at pps 19,002 / 20,000 are 1,050.4: capped at 1,000.
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
fn t3_to_t3_swap_is_a_sale_then_a_buy() {
    let mut s = open_seas(1_000, 19_000);
    let coin = second_token(&mut s, Tier::T3);
    let a = s.buy(400); // 8,000 MEME, basis 400
    s.t.swap_fresh(&a).unwrap();
    // All MEME for 1% less COIN: proceeds 396, loss 4 on the MEME basis.
    let a = SwapArgs::new(s.meme.mint, coin.mint, 8_000 * MEME, 7_920 * MEME, 99, 100);
    let res = s.t.swap_fresh(&a).unwrap();
    let ev = decode_events::<FirstLossApplied>(&res);
    assert_eq!(
        (ev[0].loss_usd, ev[0].captain_shares_burned),
        (4 * USDC, 4 * USDC)
    );
    assert_eq!(s.captain_shares(), 996 * USDC);
    s.assert_supply();
    // MEME left the holdings; COIN took its slot with the buy's basis (input spot value).
    let f = s.fund();
    assert_eq!(f.holdings[..2], [s.t.env.usdc, coin.mint]);
    assert_eq!(f.t3_basis_usd[..3], [0, 400 * USDC, 0]);
    assert_eq!(f.t3_cost_basis_usd, 400 * USDC);
    assert_eq!(f.t3_window_buys_usd, 800 * USDC);
    // Back to MEME: the buy side counts in the window, 800 + 396 > 996.
    let a = SwapArgs::new(coin.mint, s.meme.mint, 7_920 * MEME, 7_920 * MEME, 1, 1);
    expect_err(s.t.swap_fresh(&a), ErrorCode::T3CapExceeded);
    assert_eq!(s.captain_shares(), 996 * USDC);
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
