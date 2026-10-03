//! Open Seas funds: T3 caps at cost, the 30-day buy window, first-loss
//! burns of captain shares, and the captain exit floor while T3 is held.

mod common;

use {
    common::*,
    v1_core::{events::FirstLossApplied, state::Member},
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
        SwapArgs::new(
            self.t.env.usdc,
            self.meme.mint,
            usd * USDC,
            usd * 20 * MEME,
            20_000,
            1,
        )
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
fn t3_window_counts_buys_for_30_days_then_resets() {
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

    // One second before the window ends: still full.
    let wait = start + T3_WINDOW_SECS - 1 - now(&s.t.env);
    warp(&mut s.t.env.svm, wait);
    s.refresh();
    expect_err(s.t.swap_fresh(&a), ErrorCode::T3CapExceeded);
    // At start + 30 days the window resets.
    warp(&mut s.t.env.svm, 1);
    s.refresh();
    s.t.swap_fresh(&a).unwrap();
    let f = s.fund();
    assert_eq!(f.t3_window_start, now(&s.t.env));
    assert_eq!(f.t3_window_buys_usd, 401 * USDC);
    assert_eq!(f.t3_cost_basis_usd, 401 * USDC);
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
