mod common;

use {
    anchor_spl::token_2022::spl_token_2022,
    common::*,
    v1_core::{
        constants::YEAR_SECS,
        events::FeeCharged,
        state::{Fund, Marks, Member, Policy, PolicyParams},
    },
};

#[test]
fn create_fund_mints_one_to_one_and_records_captain() {
    let mut env = setup();
    let cap = funded_user(&mut env, 1_000_000_000);
    let f = create_fund(&mut env, &cap, 1, 300_000_000).unwrap();
    assert_eq!(token_balance(&env.svm, &f.usdc_vault), 300_000_000);
    assert_eq!(
        token_balance(&env.svm, &share_ata(&f, &cap.pubkey())),
        300_000_000
    );
    assert_eq!(
        token_balance(&env.svm, &usdc_ata(&env, &cap.pubkey())),
        700_000_000
    );

    let m: Member = read_account(&env.svm, &member_pda(&f.fund, &cap.pubkey()));
    assert!(m.is_captain);
    assert_eq!(m.hwm, 300_000_000);
    assert_eq!((m.fund, m.owner), (f.fund, cap.pubkey()));
    let now = env.svm.get_sysvar::<Clock>().unix_timestamp;
    assert_eq!(
        (m.joined_at, m.last_fee_at, m.last_deposit_ts),
        (now, now, now)
    );

    let fund: Fund = read_account(&env.svm, &f.fund);
    assert_eq!(fund.captain, cap.pubkey());
    assert_eq!(fund.fund_id, 1);
    assert_eq!(fund.share_mint, f.share_mint);
    assert_eq!(fund.holdings[0], env.usdc);
    assert_eq!(fund.holdings_len, 1);
    assert!(fund.holdings[1..].iter().all(|h| *h == Pubkey::default()));
    assert_eq!(fund.total_shares, 300_000_000);
    assert_eq!(fund.last_price_per_share, 1_000_000);
    assert_eq!(fund.peak_price_per_share, 1_000_000);
    assert!(!fund.frozen);
    assert_eq!(fund.proposal_count, 0);
    assert_eq!(fund.created_at, now);

    let p: Policy = read_account(&env.svm, &f.policy);
    let defaults = PolicyParams {
        autonomous_bps: 1000,
        drawdown_bps: 3000,
        max_slippage_bps: 100,
        vote_window_secs: 1800,
    };
    assert_eq!(p.fund, f.fund);
    assert_eq!(p.params, defaults);
    assert_eq!(p.pending, defaults);
    assert_eq!(p.pending_eta, 0);

    // Share mint: Token-2022, 6 dp, fund is mint authority, no freeze
    // authority, supply = deposit, NonTransferable extension set.
    let mint = share_mint_state(&env.svm, &f.share_mint);
    assert_eq!(mint.base.decimals, 6);
    assert_eq!(mint.base.supply, 300_000_000);
    assert_eq!(mint.base.mint_authority, Some(f.fund).into());
    assert_eq!(mint.base.freeze_authority, None.into());
    assert!(mint.non_transferable);
    // PermanentDelegate = fund PDA: used only by the yearly fee burn.
    assert_eq!(mint.permanent_delegate, Some(f.fund));
}

#[test]
fn create_fund_accepts_exact_minimum() {
    assert_eq!(CAPTAIN_MIN_DEPOSIT, 100_000_000);
    let mut env = setup();
    let cap = funded_user(&mut env, CAPTAIN_MIN_DEPOSIT);
    let f = create_fund(&mut env, &cap, 7, CAPTAIN_MIN_DEPOSIT).unwrap();
    assert_eq!(token_balance(&env.svm, &f.usdc_vault), CAPTAIN_MIN_DEPOSIT);
}

#[test]
fn create_fund_rejects_small_stake() {
    let mut env = setup();
    let cap = funded_user(&mut env, 1_000_000_000);
    expect_err(
        create_fund(&mut env, &cap, 1, 99_999_999),
        ErrorCode::CaptainDepositTooSmall,
    );
}

#[test]
fn shares_are_non_transferable() {
    let mut env = setup();
    let cap = funded_user(&mut env, 1_000_000_000);
    let f = create_fund(&mut env, &cap, 1, 300_000_000).unwrap();
    let other = funded(&mut env.svm);
    let dest = share_ata(&f, &other.pubkey());
    let create = ix_create_ata(
        &cap.pubkey(),
        &other.pubkey(),
        &f.share_mint,
        &spl_token_2022::ID,
    );
    send(&mut env.svm, &[create], &[&cap]).expect("create dest ATA");

    let ix = spl_token_2022::instruction::transfer_checked(
        &spl_token_2022::ID,
        &share_ata(&f, &cap.pubkey()),
        &f.share_mint,
        &dest,
        &cap.pubkey(),
        &[],
        1,
        SHARE_DECIMALS,
    )
    .unwrap();
    // Token-2022 TokenError::NonTransferable = 37.
    expect_code(send(&mut env.svm, &[ix], &[&cap]), 37);
    assert_eq!(token_balance(&env.svm, &dest), 0);
}

#[test]
fn create_fund_blocked_when_paused() {
    let mut env = setup();
    let cap = funded_user(&mut env, 1_000_000_000);
    let ix = ix_set_paused(&env.admin.pubkey(), true);
    send(&mut env.svm, &[ix], &[&env.admin]).unwrap();
    expect_err(
        create_fund(&mut env, &cap, 1, 300_000_000),
        ErrorCode::Paused,
    );
}

#[test]
fn create_fund_rejects_wrong_usdc_mint() {
    let mut env = setup();
    let cap = funded_user(&mut env, 1_000_000_000);
    let fake = create_mint(&mut env, 6);
    // Give the captain a funded account of the fake mint, so the only check
    // that can fail is `usdc_mint == config.usdc_mint`.
    let token = anchor_spl::token::ID;
    let fake_ata = ata(&cap.pubkey(), &fake, &token);
    let create = ix_create_ata(&cap.pubkey(), &cap.pubkey(), &fake, &token);
    let mint = anchor_spl::token::spl_token::instruction::mint_to(
        &token,
        &fake,
        &fake_ata,
        &env.admin.pubkey(),
        &[],
        1_000_000_000,
    )
    .unwrap();
    send(&mut env.svm, &[create, mint], &[&cap, &env.admin]).unwrap();
    let ix = ix_create_fund_with(&cap.pubkey(), 1, 300_000_000, fake);
    expect_anchor_err(
        send(&mut env.svm, &[ix], &[&cap]),
        anchor_lang::error::ErrorCode::ConstraintAddress,
    );
}

#[test]
fn create_fund_same_id_twice_fails_other_id_ok() {
    let mut env = setup();
    let cap = funded_user(&mut env, 1_000_000_000);
    create_fund(&mut env, &cap, 1, 300_000_000).unwrap();
    expect_log(
        create_fund(&mut env, &cap, 1, 300_000_000),
        "already in use",
    );
    create_fund(&mut env, &cap, 2, 300_000_000).unwrap();
}

#[test]
fn create_fund_survives_prefunded_share_mint_pda() {
    // Anyone can send lamports to the share-mint PDA before the fund exists.
    // That must not block the fund.
    let mut env = setup();
    let cap = funded_user(&mut env, 1_000_000_000);
    let attacker = funded(&mut env.svm);
    let mint = share_mint_pda(&fund_pda(&cap.pubkey(), 1));
    let ix = anchor_lang::solana_program::system_instruction::transfer(
        &attacker.pubkey(),
        &mint,
        1_000_000,
    );
    send(&mut env.svm, &[ix], &[&attacker]).unwrap();
    let f = create_fund(&mut env, &cap, 1, 300_000_000).unwrap();
    assert!(share_mint_state(&env.svm, &f.share_mint).non_transferable);
}

// ---------------------------------------------------------------------------
// deposit + NAV
// ---------------------------------------------------------------------------

#[test]
fn second_member_gets_shares_at_nav() {
    let (mut env, _cap, m, f) = fund_with_member();
    deposit(&mut env, &f, &m, 150_000_000).unwrap(); // NAV 300 USDC, 300 shares -> 150 shares
    assert_eq!(
        token_balance(&env.svm, &share_ata(&f, &m.pubkey())),
        150_000_000
    );
    assert_eq!(token_balance(&env.svm, &f.usdc_vault), 450_000_000);
    assert_eq!(
        token_balance(&env.svm, &usdc_ata(&env, &m.pubkey())),
        850_000_000
    );
    let fund = read_fund(&env, &f);
    assert_eq!(fund.total_shares, 450_000_000);
    assert_eq!(
        share_mint_state(&env.svm, &f.share_mint).base.supply,
        450_000_000
    );
    assert_eq!(fund.last_price_per_share, 1_000_000);

    let mem: Member = read_account(&env.svm, &member_pda(&f.fund, &m.pubkey()));
    let t = now(&env);
    assert_eq!((mem.fund, mem.owner), (f.fund, m.pubkey()));
    assert!(!mem.is_captain);
    assert_eq!(mem.hwm, 150_000_000);
    assert_eq!(
        (mem.joined_at, mem.last_fee_at, mem.last_deposit_ts),
        (t, t, t)
    );
}

#[test]
fn donation_raises_share_price_for_everyone() {
    let (mut env, _cap, m, f) = fund_with_member();
    mint_usdc(&mut env, &f.usdc_vault, 300_000_000); // NAV 600, pps 2.0
    settle_pps(&mut env, &f, &m, |_| {}); // recorded one step per interval
    deposit(&mut env, &f, &m, 300_000_000).unwrap();
    assert_eq!(
        token_balance(&env.svm, &share_ata(&f, &m.pubkey())),
        150_000_000
    );
    let fund = read_fund(&env, &f);
    assert_eq!(fund.last_price_per_share, 2_000_000);
    assert_eq!(fund.peak_price_per_share, 2_000_000);
    assert_eq!(fund.total_shares, 450_000_000);
}

#[test]
fn deposit_rejects_zero_shares() {
    let (mut env, _cap, m, f) = fund_with_member();
    mint_usdc(&mut env, &f.usdc_vault, 1_000_000_000_000);
    expect_err(deposit(&mut env, &f, &m, 1), ErrorCode::ZeroShares);
}

#[test]
fn deposit_rejects_zero_amount() {
    let (mut env, _cap, m, f) = fund_with_member();
    expect_err(deposit(&mut env, &f, &m, 0), ErrorCode::ZeroAmount);
}

#[test]
fn deposit_blocked_when_paused() {
    let (mut env, _cap, m, f) = fund_with_member();
    let ix = ix_set_paused(&env.admin.pubkey(), true);
    send(&mut env.svm, &[ix], &[&env.admin]).unwrap();
    expect_err(deposit(&mut env, &f, &m, 100_000_000), ErrorCode::Paused);
}

#[test]
fn deposit_updates_hwm_and_last_deposit_ts() {
    let (mut env, _cap, m, f) = fund_with_member();
    deposit(&mut env, &f, &m, 100_000_000).unwrap();
    let joined = now(&env);
    warp(&mut env.svm, 100);
    deposit(&mut env, &f, &m, 100_000_000).unwrap();
    let mem: Member = read_account(&env.svm, &member_pda(&f.fund, &m.pubkey()));
    assert_eq!(mem.hwm, 200_000_000);
    assert_eq!(mem.last_deposit_ts, now(&env));
    assert_eq!((mem.joined_at, mem.last_fee_at), (joined, joined));
}

#[test]
fn captain_top_up_keeps_captain_flag() {
    let (mut env, cap, _m, f) = fund_with_member();
    deposit(&mut env, &f, &cap, 50_000_000).unwrap();
    let mem: Member = read_account(&env.svm, &member_pda(&f.fund, &cap.pubkey()));
    assert!(mem.is_captain);
    assert_eq!(mem.hwm, 350_000_000);
    assert_eq!(
        token_balance(&env.svm, &share_ata(&f, &cap.pubkey())),
        350_000_000
    );
}

#[test]
fn deposit_rejects_missing_nav_accounts() {
    let (mut env, _cap, m, f) = fund_with_member();
    let mut ix = ix_deposit_bare(&env, &f, &m.pubkey(), 100_000_000);
    let nav = nav_accounts(&env, &f);
    ix.accounts.extend_from_slice(&nav[..2]); // one short
    expect_err(
        send(&mut env.svm, &[ix], &[&m]),
        ErrorCode::PriceAccountMissing,
    );
}

#[test]
fn deposit_rejects_wrong_vault_in_nav() {
    let (mut env, _cap, m, f) = fund_with_member();
    // A real USDC account with more money in it than the vault.
    let whale = funded_user(&mut env, 1_000_000_000_000);
    let mut ix = ix_deposit(&env, &f, &m.pubkey(), 100_000_000);
    let n = ix.accounts.len();
    ix.accounts[n - 4].pubkey = usdc_ata(&env, &whale.pubkey());
    expect_err(send(&mut env.svm, &[ix], &[&m]), ErrorCode::HoldingNotFound);
}

#[test]
fn deposit_rejects_other_funds_share_mint() {
    let (mut env, cap, m, f) = fund_with_member();
    let other = create_fund(&mut env, &cap, 2, 300_000_000).unwrap();
    let mut ix = ix_deposit(&env, &f, &m.pubkey(), 100_000_000);
    for meta in ix.accounts.iter_mut() {
        if meta.pubkey == f.share_mint {
            meta.pubkey = other.share_mint;
        } else if meta.pubkey == share_ata(&f, &m.pubkey()) {
            meta.pubkey = share_ata(&other, &m.pubkey());
        }
    }
    expect_anchor_err(
        send(&mut env.svm, &[ix], &[&m]),
        anchor_lang::error::ErrorCode::ConstraintAddress,
    );
}

#[test]
fn nav_values_pyth_priced_holding() {
    let (mut env, _cap, m, f) = fund_with_member();
    let sol = listed_sol(&mut env, 150);
    inject_holding(&mut env, &f, sol, 2_000_000_000); // 2 SOL = $300 -> NAV 600, pps 2.0
    settle_pps(&mut env, &f, &m, |env| sol_price(env, &sol, 150, 0, 150));
    deposit(&mut env, &f, &m, 300_000_000).unwrap();
    assert_eq!(
        token_balance(&env.svm, &share_ata(&f, &m.pubkey())),
        150_000_000
    );
    assert_eq!(read_fund(&env, &f).last_price_per_share, 2_000_000);
}

#[test]
fn nav_rejects_stale_price() {
    let (mut env, _cap, m, f) = fund_with_member();
    let sol = listed_sol(&mut env, 150);
    inject_holding(&mut env, &f, sol, 2_000_000_000);
    warp(&mut env.svm, 61);
    expect_err(
        deposit(&mut env, &f, &m, 100_000_000),
        ErrorCode::PriceStale,
    );
}

#[test]
fn nav_rejects_wrong_feed_price_account() {
    let (mut env, _cap, m, f) = fund_with_member();
    let sol = listed_sol(&mut env, 150);
    inject_holding(&mut env, &f, sol, 2_000_000_000);
    let t = now(&env);
    set_price(&mut env.svm, price_account(&sol), &BONK_FEED, 1, 0, -8, t);
    expect_err(
        deposit(&mut env, &f, &m, 100_000_000),
        ErrorCode::PriceFeedMismatch,
    );
}

#[test]
fn nav_rejects_inactive_token() {
    let (mut env, _cap, m, f) = fund_with_member();
    let sol = create_mint(&mut env, 9);
    let ix = ix_queue_token(&env.admin.pubkey(), sol, pyth(SOL_FEED), Tier::T1, 9);
    send(&mut env.svm, &[ix], &[&env.admin]).unwrap(); // queued, never applied
    let t = now(&env);
    set_price(
        &mut env.svm,
        price_account(&sol),
        &SOL_FEED,
        150_00000000,
        0,
        -8,
        t,
    );
    inject_holding(&mut env, &f, sol, 2_000_000_000);
    expect_err(
        deposit(&mut env, &f, &m, 100_000_000),
        ErrorCode::TokenInactive,
    );
}

#[test]
fn nav_rejects_wrong_token_entry() {
    let (mut env, _cap, m, f) = fund_with_member();
    let sol = listed_sol(&mut env, 150);
    let bonk = create_mint(&mut env, 5);
    register_token(&mut env, bonk, BONK_FEED, Tier::T2);
    inject_holding(&mut env, &f, sol, 2_000_000_000);
    let t = now(&env);
    set_price(
        &mut env.svm,
        price_account(&sol),
        &SOL_FEED,
        150_00000000,
        0,
        -8,
        t,
    );
    let mut ix = ix_deposit(&env, &f, &m.pubkey(), 100_000_000);
    let n = ix.accounts.len();
    ix.accounts[n - 3].pubkey = token_pda(&bonk); // a real, active entry for another mint
    expect_err(send(&mut env.svm, &[ix], &[&m]), ErrorCode::TokenNotListed);
}

/// Fund at pps 2.0 = peak: 600 USDC + 2 SOL @ $150 over 450 shares.
fn fund_at_peak_with_sol() -> (Env, Keypair, FundHandles, Pubkey) {
    let (mut env, _cap, m, f) = fund_with_member();
    let sol = listed_sol(&mut env, 150);
    inject_holding(&mut env, &f, sol, 2_000_000_000); // NAV 600 / 300 shares
    settle_pps(&mut env, &f, &m, |env| sol_price(env, &sol, 150, 0, 150));
    deposit(&mut env, &f, &m, 300_000_000).unwrap(); // pps 2.0; NAV 900 / 450
    let fund = read_fund(&env, &f);
    assert_eq!((fund.peak_price_per_share, fund.frozen), (2_000_000, false));
    (env, m, f, sol)
}

#[test]
fn breaker_freezes_on_ema_drawdown_and_thaws_on_recovery() {
    let (mut env, m, f, sol) = fund_at_peak_with_sol();

    // EMA to $1 (spot steady): EMA NAV 602 / 450 = 1.337777 < line 1.4.
    sol_price(&mut env, &sol, 150, 0, 1);
    let res = deposit(&mut env, &f, &m, 10_000_000).unwrap();
    assert_eq!(events(&res), 2, "Deposited + BreakerChanged");
    // The trip check reads the fresh pps; the recorded pps already moved in
    // this interval (the fixture), so it stays.
    let fund = read_fund(&env, &f);
    assert_eq!(fund.last_price_per_share, 2_000_000);
    assert_eq!(fund.peak_price_per_share, 2_000_000);
    assert!(fund.frozen);

    // EMA back to $150: 910 / 455 = 2.0, above the line again.
    sol_price(&mut env, &sol, 150, 0, 150);
    let res = deposit(&mut env, &f, &m, 10_000_000).unwrap();
    assert_eq!(events(&res), 2, "Deposited + BreakerChanged");
    assert!(!read_fund(&env, &f).frozen);
    // No flip, no BreakerChanged.
    let res = deposit(&mut env, &f, &m, 10_000_000).unwrap();
    assert_eq!(events(&res), 1);
    let fund = read_fund(&env, &f);
    assert!(!fund.frozen);
    assert_eq!(fund.peak_price_per_share, 2_000_000);
}

#[test]
fn breaker_ignores_spot_crash_with_steady_ema() {
    let (mut env, m, f, sol) = fund_at_peak_with_sol();
    sol_price(&mut env, &sol, 1, 0, 150);
    let res = deposit(&mut env, &f, &m, 10_000_000).unwrap();
    assert_eq!(events(&res), 1, "no BreakerChanged");
    let fund = read_fund(&env, &f);
    assert!(!fund.frozen);
    assert_eq!(fund.last_price_per_share, 2_000_000);
}

#[test]
fn deposit_values_at_upper_bound_with_conf() {
    let (mut env, _cap, m, f) = fund_with_member();
    let sol = listed_sol(&mut env, 150);
    inject_holding(&mut env, &f, sol, 2_000_000_000);
    settle_pps(&mut env, &f, &m, |env| sol_price(env, &sol, 150, 0, 150));
    // $150 +- $1.50 (1%): 2 SOL valued at $151.50 = $303 -> NAV 603 / 300 shares.
    sol_price(&mut env, &sol, 150, 150, 150);
    deposit(&mut env, &f, &m, 300_000_000).unwrap();
    // floor(300e6 * 300e6 / 603e6)
    assert_eq!(
        token_balance(&env.svm, &share_ata(&f, &m.pubkey())),
        149_253_731
    );
    // Breaker records the EMA price: 600 / 300 = 2.0.
    assert_eq!(read_fund(&env, &f).last_price_per_share, 2_000_000);
}

#[test]
fn deposit_cannot_cherry_pick_low_spot() {
    let (mut env, _cap, m, f) = fund_with_member();
    let sol = listed_sol(&mut env, 150);
    inject_holding(&mut env, &f, sol, 2_000_000_000);
    // Low in-window spot ($100), EMA $150: valued at max = $150 -> NAV 600.
    // Spot NAV (500) would give 180 shares.
    sol_price(&mut env, &sol, 100, 0, 150);
    deposit(&mut env, &f, &m, 300_000_000).unwrap();
    assert_eq!(
        token_balance(&env.svm, &share_ata(&f, &m.pubkey())),
        150_000_000
    );
}

#[test]
fn deposit_rejects_non_positive_ema() {
    let (mut env, _cap, m, f) = fund_with_member();
    let sol = listed_sol(&mut env, 150);
    inject_holding(&mut env, &f, sol, 2_000_000_000);
    sol_price(&mut env, &sol, 150, 0, 0);
    expect_err(
        deposit(&mut env, &f, &m, 100_000_000),
        ErrorCode::PriceNonPositive,
    );
}

#[test]
fn nav_rejects_wrong_price_account_type() {
    let (mut env, _cap, m, f) = fund_with_member();
    let sol = listed_sol(&mut env, 150);
    inject_holding(&mut env, &f, sol, 2_000_000_000);
    let mut acc = env.svm.get_account(&price_account(&sol)).unwrap();
    acc.data[0] ^= 1;
    env.svm.set_account(price_account(&sol), acc).unwrap();
    expect_err(
        deposit(&mut env, &f, &m, 100_000_000),
        ErrorCode::PriceWrongAccountType,
    );
}

#[test]
fn deposit_rejects_closed_fund() {
    let (mut env, _cap, m, f) = fund_with_member();
    let mut fund = read_fund(&env, &f);
    fund.total_shares = 0;
    write_fund(&mut env, &f, &fund);
    expect_err(
        deposit(&mut env, &f, &m, 100_000_000),
        ErrorCode::FundClosed,
    );
}

#[test]
fn deposit_rejects_zero_nav_with_shares() {
    let (mut env, _cap, m, f) = fund_with_member();
    let mut vault = env.svm.get_account(&f.usdc_vault).unwrap();
    vault.data[64..72].fill(0); // empty vault, 300 shares outstanding
    env.svm.set_account(f.usdc_vault, vault).unwrap();
    expect_err(deposit(&mut env, &f, &m, 100_000_000), ErrorCode::NavZero);
}

/// Fund with 300 USDC (300 shares) + 6,000 MEME at $0.05 (= 300 USDC).
/// MEME's marks are seeded at $0.05 and warmed up.
fn fund_with_meme() -> (Env, Keypair, FundHandles, SbToken) {
    let (mut env, _cap, m, f) = fund_with_member();
    let t = listed_meme(&mut env, Tier::T2);
    inject_holding(&mut env, &f, t.mint, 6_000_000_000_000);
    poke(&mut env, &f, &m).unwrap();
    // A read halfway keeps the marks active (an idle mark reseeds).
    for _ in 0..2 {
        warp(&mut env.svm, MARK_WARMUP_SLOTS as i64 / 2);
        refresh_meme(&mut env, &t);
        poke(&mut env, &f, &m).unwrap();
    }
    settle_pps(&mut env, &f, &m, |env| refresh_meme(env, &t));
    assert_eq!(read_fund(&env, &f).last_price_per_share, 2_000_000);
    (env, m, f, t)
}

/// A dump at the last slot of a warmup, then a restore, cannot drag the
/// recorded pps down more than one step: the exit fee stays, and a deposit
/// after a second dump is not diluted.
#[test]
fn dump_at_the_end_of_a_warmup_cannot_skip_the_fee_or_dilute() {
    let (mut env, m, f, mut t) = fund_with_meme();
    // Member 200 USDC at pps 2.0: 100 shares, HWM 200. NAV 800, 400 shares.
    deposit(&mut env, &f, &m, 200_000_000).unwrap();
    let token = spl_token_interface::ID;
    let ix = ix_create_ata(&m.pubkey(), &m.pubkey(), &t.mint, &token);
    send(&mut env.svm, &[ix], &[&m]).unwrap();
    // True price $0.06: NAV 500 + 360 = 860, pps 2.15.
    t.fields.value = SB_ONE * 6 / 100;
    settle_pps(&mut env, &f, &m, |env| refresh_meme(env, &t));
    assert_eq!(read_fund(&env, &f).last_price_per_share, 2_150_000);
    // Re-listed to a new feed: unseeded marks; a poke seeds them at $0.06.
    t.feed = Pubkey::new_unique();
    register_token_with(&mut env, t.mint, t.source(), Tier::T2);
    refresh_meme(&mut env, &t);
    poke(&mut env, &f, &m).unwrap();
    // Dump to $0.0005 at the last warmup slot, poke.
    warp(&mut env.svm, MARK_WARMUP_SLOTS as i64 - 1);
    t.fields.value = SB_ONE / 2_000;
    refresh_meme(&mut env, &t);
    poke(&mut env, &f, &m).unwrap();
    // Warmup over: restore $0.06, poke, exit. The deposit mark took one step
    // down ($0.054): pps (500 + 324) / 400 = 2.06, one step from 2.15 at most.
    warp(&mut env.svm, 1);
    t.fields.value = SB_ONE * 6 / 100;
    refresh_meme(&mut env, &t);
    poke(&mut env, &f, &m).unwrap();
    assert_eq!(read_fund(&env, &f).last_price_per_share, 2_060_000);
    // Fee on 206 - 200 = 6: 0.6 USDC.
    let res = exit(&mut env, &f, &m, 100_000_000).unwrap();
    let ev = decode_events::<FeeCharged>(&res);
    assert_eq!(
        (ev[0].fee_usdc, ev[0].price_per_share),
        (600_000, 2_060_000)
    );
    // A second dump, then a deposit: priced at no less than the recorded pps.
    t.fields.value = SB_ONE / 2_000;
    refresh_meme(&mut env, &t);
    let d = funded_user(&mut env, 1_000_000_000);
    deposit(&mut env, &f, &d, 206_000_000).unwrap();
    // 206 USDC at pps 2.06 (NAV rounding floors one base unit).
    assert_eq!(
        token_balance(&env.svm, &share_ata(&f, &d.pubkey())),
        99_999_999
    );
}

/// SOL (Pyth) held 2 SOL at $150 next to 300 USDC: NAV 600, pps 2.0, settled.
fn fund_with_sol() -> (Env, Keypair, FundHandles, Pubkey) {
    let (mut env, _cap, m, f) = fund_with_member();
    let sol = listed_sol(&mut env, 150);
    inject_holding(&mut env, &f, sol, 2_000_000_000);
    settle_pps(&mut env, &f, &m, |env| sol_price(env, &sol, 150, 0, 150));
    assert_eq!(read_fund(&env, &f).last_price_per_share, 2_000_000);
    (env, m, f, sol)
}

/// A pump of a Pyth token (spot and EMA) raises the recorded pps and the
/// peak one step per interval at most.
#[test]
fn pyth_pump_raises_the_recorded_pps_one_step_per_interval() {
    let (mut env, m, f, sol) = fund_with_sol();
    // SOL 10x: pps would be (300 + 3,000) / 300 = 11.
    warp(&mut env.svm, MARK_INTERVAL_SLOTS as i64);
    sol_price(&mut env, &sol, 1_500, 0, 1_500);
    poke(&mut env, &f, &m).unwrap();
    let fund = read_fund(&env, &f);
    assert_eq!(
        (fund.last_price_per_share, fund.peak_price_per_share),
        (2_200_000, 2_200_000)
    );
    // Again in the same interval: no move.
    env.svm.expire_blockhash();
    poke(&mut env, &f, &m).unwrap();
    assert_eq!(read_fund(&env, &f).last_price_per_share, 2_200_000);
    // Next interval: one more step, 2.42.
    warp(&mut env.svm, MARK_INTERVAL_SLOTS as i64);
    sol_price(&mut env, &sol, 1_500, 0, 1_500);
    poke(&mut env, &f, &m).unwrap();
    assert_eq!(read_fund(&env, &f).last_price_per_share, 2_420_000);
}

/// A genuine crash lowers the recorded pps one step per interval, while the
/// breaker trips at once on the fresh price.
#[test]
fn crash_lowers_the_recorded_pps_one_step_and_trips_the_breaker() {
    let (mut env, m, f, sol) = fund_with_sol();
    // SOL -90%: fresh pps (300 + 30) / 300 = 1.1 < 70% of 2.0.
    warp(&mut env.svm, MARK_INTERVAL_SLOTS as i64);
    sol_price(&mut env, &sol, 15, 0, 15);
    poke(&mut env, &f, &m).unwrap();
    let fund = read_fund(&env, &f);
    assert!(fund.frozen);
    assert_eq!(
        (fund.last_price_per_share, fund.peak_price_per_share),
        (1_800_000, 2_000_000)
    );
    warp(&mut env.svm, MARK_INTERVAL_SLOTS as i64);
    sol_price(&mut env, &sol, 15, 0, 15);
    poke(&mut env, &f, &m).unwrap();
    assert_eq!(read_fund(&env, &f).last_price_per_share, 1_620_000);
}

/// A pump does not raise the crew exit fee: a Switchboard holding is priced
/// at its low mark + std_dev for the fee, not at max(spot, mark).
#[test]
fn crew_exit_fee_is_not_raised_by_a_pump() {
    let (mut env, m, f, mut t) = fund_with_meme();
    // NAV 600, pps 2.0: 200 USDC buys 100 shares, HWM 200.
    deposit(&mut env, &f, &m, 200_000_000).unwrap();
    let token = spl_token_interface::ID;
    let ix = ix_create_ata(&m.pubkey(), &m.pubkey(), &t.mint, &token);
    send(&mut env.svm, &[ix], &[&m]).unwrap();
    // MEME pumps 10x. At max(spot, mark): NAV 500 + 3,000 = 3,500, pps 8.75,
    // value 875, fee 67.5. At the low mark ($0.05): pps 2.0, no profit.
    t.fields.value = SB_ONE / 2;
    refresh_meme(&mut env, &t);
    let res = exit(&mut env, &f, &m, 100_000_000).unwrap();
    assert!(decode_events::<FeeCharged>(&res).is_empty());
    // 100 of 400 shares: a quarter of 500 USDC and of 6,000 MEME.
    assert_eq!(
        token_balance(&env.svm, &usdc_ata(&env, &m.pubkey())),
        925_000_000
    );
    let meme = ata(&m.pubkey(), &t.mint, &token);
    assert_eq!(token_balance(&env.svm, &meme), 1_500_000_000_000);
}

/// Member 200 USDC in at pps 2.0, then 200 USDC donated: NAV 1,000 for 400
/// shares, pps 2.5, recorded by a poke. The member's profit is 50, fee 5.
fn fund_with_meme_profit() -> (Env, Keypair, FundHandles, SbToken) {
    let (mut env, m, f, t) = fund_with_meme();
    deposit(&mut env, &f, &m, 200_000_000).unwrap();
    mint_usdc(&mut env, &f.usdc_vault, 200_000_000);
    settle_pps(&mut env, &f, &m, |env| refresh_meme(env, &t));
    assert_eq!(read_fund(&env, &f).last_price_per_share, 2_500_000);
    let token = spl_token_interface::ID;
    let ix = ix_create_ata(&m.pubkey(), &m.pubkey(), &t.mint, &token);
    send(&mut env.svm, &[ix], &[&m]).unwrap();
    (env, m, f, t)
}

/// Dump the pool, poke, exit: the recorded pps and the exit fee price move
/// at most one mark step per interval, so the fee stays.
#[test]
fn dump_then_poke_then_exit_does_not_lower_the_exit_fee() {
    let (mut env, m, f, mut t) = fund_with_meme_profit();
    // MEME dumped 99% to $0.0005: at that price NAV 703, pps 1.7575, no profit.
    t.fields.value = SB_ONE / 2_000;
    refresh_meme(&mut env, &t);
    env.svm.expire_blockhash();
    poke(&mut env, &f, &m).unwrap();
    assert_eq!(read_fund(&env, &f).last_price_per_share, 2_500_000);
    let res = exit(&mut env, &f, &m, 100_000_000).unwrap();
    let ev = decode_events::<FeeCharged>(&res);
    assert_eq!(
        (ev[0].fee_usdc, ev[0].price_per_share),
        (5_000_000, 2_500_000)
    );
}

/// The same dump does not lower the annual fee.
#[test]
fn dump_does_not_lower_the_annual_fee() {
    let (mut env, m, f, mut t) = fund_with_meme_profit();
    warp(&mut env.svm, YEAR_SECS);
    refresh_meme(&mut env, &t);
    poke(&mut env, &f, &m).unwrap();
    t.fields.value = SB_ONE / 2_000;
    refresh_meme(&mut env, &t);
    let ix = ix_annual_fee(&env, &f, &m.pubkey(), &m.pubkey());
    let res = send(&mut env.svm, &[ix], &[&m]).unwrap();
    let ev = decode_events::<FeeCharged>(&res);
    assert_eq!(
        (ev[0].fee_usdc, ev[0].price_per_share),
        (5_000_000, 2_500_000)
    );
}

/// A real crash trips the breaker at once through the low mark; the recorded
/// pps moves only by the slow mark.
#[test]
fn breaker_trips_on_a_crash_through_the_low_mark() {
    let (mut env, m, f, mut t) = fund_with_meme();
    poke(&mut env, &f, &m).unwrap();
    assert!(!read_fund(&env, &f).frozen);
    // MEME crashes to $0.0005: low-mark pps (300 + 3) / 300 = 1.01 < 70% of 2.0.
    t.fields.value = SB_ONE / 2_000;
    refresh_meme(&mut env, &t);
    env.svm.expire_blockhash();
    poke(&mut env, &f, &m).unwrap();
    let fund = read_fund(&env, &f);
    assert!(fund.frozen);
    assert_eq!(
        (fund.last_price_per_share, fund.peak_price_per_share),
        (2_000_000, 2_000_000)
    );
}

/// A re-listing to a Switchboard feed that the attacker pumps cannot raise
/// the peak: NAV reads do not record the peak or the last pps until the
/// marks have warmed up.
#[test]
fn relisted_switchboard_token_warms_up_before_it_moves_the_peak() {
    let (mut env, _cap, m, f) = fund_with_member();
    let mint = create_mint(&mut env, 9);
    register_token(&mut env, mint, BONK_FEED, Tier::T2);
    set_usd_price(&mut env, &mint, &BONK_FEED, 5_000_000); // $0.05
    inject_holding(&mut env, &f, mint, 6_000_000_000_000);
    settle_pps(&mut env, &f, &m, |env| {
        set_usd_price(env, &mint, &BONK_FEED, 5_000_000)
    });
    let fund = read_fund(&env, &f);
    assert_eq!(
        (fund.peak_price_per_share, fund.last_price_per_share),
        (2_000_000, 2_000_000)
    );
    // Re-listed to a Switchboard feed pumped 10x ($0.50).
    let mut t = SbToken {
        mint,
        feed: Pubkey::new_unique(),
        fields: FeedFields {
            value: SB_ONE / 2,
            std_dev: 0,
            slot: 0,
            min_slot: 0,
            num_samples: v1_core::switchboard::MIN_SAMPLES,
            max_staleness: 250,
            feed_hash: [9; 32],
            queue: Pubkey::new_unique(),
        },
    };
    register_token_with(&mut env, mint, t.source(), Tier::T2);
    refresh_meme(&mut env, &t);
    // At $0.50 the pps would be 11.0.
    poke(&mut env, &f, &m).unwrap();
    let fund = read_fund(&env, &f);
    assert_eq!(
        (fund.peak_price_per_share, fund.last_price_per_share),
        (2_000_000, 2_000_000)
    );
    // The pump ends at $0.06. One slot before the warmup ends: still not recorded.
    t.fields.value = SB_ONE * 6 / 100;
    warp(&mut env.svm, MARK_WARMUP_SLOTS as i64 - 1);
    refresh_meme(&mut env, &t);
    poke(&mut env, &f, &m).unwrap();
    assert_eq!(read_fund(&env, &f).last_price_per_share, 2_000_000);
    // Warm: NAV 300 + 360 = 660, pps 2.2.
    warp(&mut env.svm, 1);
    refresh_meme(&mut env, &t);
    poke(&mut env, &f, &m).unwrap();
    let fund = read_fund(&env, &f);
    assert_eq!(
        (fund.peak_price_per_share, fund.last_price_per_share),
        (2_200_000, 2_200_000)
    );
}

/// A re-listing seeded at a 10x pump ($0.50), with the true price $0.06 from
/// then on: the record and the peak follow the true pps, the fund does not
/// freeze, and the crew exit fee is not charged on the pump.
#[test]
fn pumped_relist_seed_does_not_raise_the_record_or_the_exit_fee() {
    let (mut env, m, f, mut t) = fund_with_meme();
    // Member 200 USDC at pps 2.0: 100 shares, HWM 200. NAV 800, 400 shares.
    deposit(&mut env, &f, &m, 200_000_000).unwrap();
    let token = spl_token_interface::ID;
    let ix = ix_create_ata(&m.pubkey(), &m.pubkey(), &t.mint, &token);
    send(&mut env.svm, &[ix], &[&m]).unwrap();
    // Re-listed to a new feed at $0.50: a poke seeds both marks there.
    t.feed = Pubkey::new_unique();
    t.fields.value = SB_ONE / 2;
    register_token_with(&mut env, t.mint, t.source(), Tier::T2);
    refresh_meme(&mut env, &t);
    poke(&mut env, &f, &m).unwrap();
    // True price $0.06: NAV 500 + 360 = 860, pps 2.15. Through the warmup
    // and 10 intervals after it, the record never passes 2.15.
    t.fields.value = SB_ONE * 6 / 100;
    for _ in 0..20 {
        warp(&mut env.svm, MARK_INTERVAL_SLOTS as i64);
        refresh_meme(&mut env, &t);
        poke(&mut env, &f, &m).unwrap();
        let fund = read_fund(&env, &f);
        assert!(!fund.frozen);
        assert!(fund.last_price_per_share <= 2_150_000);
    }
    let fund = read_fund(&env, &f);
    assert_eq!(
        (fund.last_price_per_share, fund.peak_price_per_share),
        (2_150_000, 2_150_000)
    );
    // Fee on 215 - 200 = 15: 1.5 USDC at pps 2.15.
    let res = exit(&mut env, &f, &m, 100_000_000).unwrap();
    let ev = decode_events::<FeeCharged>(&res);
    assert_eq!(
        (ev[0].fee_usdc, ev[0].price_per_share),
        (1_500_000, 2_150_000)
    );
}

/// A genuine rally raises the fee price one mark step per interval: the
/// record and the exit fee lag the spot.
#[test]
fn genuine_rally_raises_the_fee_price_one_mark_step_per_interval() {
    let (mut env, m, f, mut t) = fund_with_meme();
    // Member 200 USDC at pps 2.0: 100 shares, HWM 200. NAV 800, 400 shares.
    deposit(&mut env, &f, &m, 200_000_000).unwrap();
    let token = spl_token_interface::ID;
    let ix = ix_create_ata(&m.pubkey(), &m.pubkey(), &t.mint, &token);
    send(&mut env.svm, &[ix], &[&m]).unwrap();
    // MEME doubles to $0.10 and stays: at spot NAV 1,100, pps 2.75.
    t.fields.value = SB_ONE / 10;
    // One interval: the deposit mark is $0.055, NAV 500 + 330 = 830, pps 2.075.
    warp(&mut env.svm, MARK_INTERVAL_SLOTS as i64);
    refresh_meme(&mut env, &t);
    poke(&mut env, &f, &m).unwrap();
    assert_eq!(read_fund(&env, &f).last_price_per_share, 2_075_000);
    // Fee on 207.5 - 200 = 7.5 (not on 75 at spot): 0.75 USDC.
    let res = exit(&mut env, &f, &m, 100_000_000).unwrap();
    let ev = decode_events::<FeeCharged>(&res);
    assert_eq!(
        (ev[0].fee_usdc, ev[0].price_per_share),
        (750_000, 2_075_000)
    );
}

/// `fund_with_meme`, a member's 200 USDC at pps 2.0 (100 shares, HWM 200),
/// then the true price $0.06: 500 USDC + 6,000 MEME, 400 shares, pps 2.15
/// recorded. The 6,000 MEME carry a T3 cost basis of 360 (bought at $0.06).
fn fund_with_based_meme() -> (Env, Keypair, FundHandles, SbToken) {
    let (mut env, m, f, mut t) = fund_with_meme();
    deposit(&mut env, &f, &m, 200_000_000).unwrap();
    let token = spl_token_interface::ID;
    let ix = ix_create_ata(&m.pubkey(), &m.pubkey(), &t.mint, &token);
    send(&mut env.svm, &[ix], &[&m]).unwrap();
    let mut fund = read_fund(&env, &f);
    assert_eq!(fund.holdings[1], t.mint);
    fund.open_seas = true;
    fund.t3_basis_usd[1] = 360_000_000;
    fund.t3_cost_basis_usd = 360_000_000;
    write_fund(&mut env, &f, &fund);
    t.fields.value = SB_ONE * 6 / 100;
    settle_pps(&mut env, &f, &m, |env| refresh_meme(env, &t));
    assert_eq!(read_fund(&env, &f).last_price_per_share, 2_150_000);
    (env, m, f, t)
}

/// 200 USDC at the fair pps 2.15: 200 x 400 / 860 shares, floor.
const FAIR_SHARES: u64 = 93_023_255;

/// A re-listing seeded at a dump ($0.0005), with the true price $0.06 from
/// then on: the slow mark stays low for many intervals, but a T3 holding is
/// valued at no less than its cost for the record, the exit fee and the
/// deposit price.
#[test]
fn dumped_relist_seed_does_not_lower_the_record_the_fee_or_the_deposit_price() {
    let (mut env, m, f, mut t) = fund_with_based_meme();
    t.feed = Pubkey::new_unique();
    t.fields.value = SB_ONE / 2_000;
    register_token_with(&mut env, t.mint, t.source(), Tier::T2);
    refresh_meme(&mut env, &t);
    poke(&mut env, &f, &m).unwrap();
    // Through the warmup and 6 intervals after it the deposit mark stays far
    // under $0.06; the record stays at 2.15.
    t.fields.value = SB_ONE * 6 / 100;
    for _ in 0..16 {
        warp(&mut env.svm, MARK_INTERVAL_SLOTS as i64);
        refresh_meme(&mut env, &t);
        poke(&mut env, &f, &m).unwrap();
    }
    assert!(read_entry(&env, &t.mint).marks.deposit < SB_ONE * 6 / 1_000);
    assert_eq!(read_fund(&env, &f).last_price_per_share, 2_150_000);
    // Interval 17: fee on 215 - 200 = 15, 1.5 USDC at pps 2.15.
    warp(&mut env.svm, MARK_INTERVAL_SLOTS as i64);
    refresh_meme(&mut env, &t);
    let res = exit(&mut env, &f, &m, 50_000_000).unwrap();
    let ev = decode_events::<FeeCharged>(&res);
    assert_eq!(
        (ev[0].fee_usdc, ev[0].price_per_share),
        (1_500_000, 2_150_000)
    );
    // A second dump, then a new user deposits 200 USDC at the fair pps 2.15.
    t.fields.value = SB_ONE / 2_000;
    refresh_meme(&mut env, &t);
    let d = funded_user(&mut env, 1_000_000_000);
    deposit(&mut env, &f, &d, 200_000_000).unwrap();
    let shares = token_balance(&env.svm, &share_ata(&f, &d.pubkey()));
    assert!(shares.abs_diff(FAIR_SHARES) <= 1, "{shares}");
}

/// A dump at every poke for seven intervals: the record and the deposit
/// price do not follow it down for a T3 holding.
#[test]
fn repeated_dumps_do_not_drag_the_record_or_dilute_a_deposit() {
    let (mut env, m, f, mut t) = fund_with_based_meme();
    for _ in 0..7 {
        warp(&mut env.svm, MARK_INTERVAL_SLOTS as i64);
        t.fields.value = SB_ONE / 2_000;
        refresh_meme(&mut env, &t);
        poke(&mut env, &f, &m).unwrap();
    }
    // The deposit mark followed: 0.06 x 0.9^7 = $0.0287.
    assert!(read_entry(&env, &t.mint).marks.deposit < SB_ONE * 29 / 1_000);
    assert_eq!(read_fund(&env, &f).last_price_per_share, 2_150_000);
    // A deposit at a dump: fair shares.
    let d = funded_user(&mut env, 1_000_000_000);
    deposit(&mut env, &f, &d, 200_000_000).unwrap();
    let shares = token_balance(&env.svm, &share_ata(&f, &d.pubkey()));
    assert!(shares.abs_diff(FAIR_SHARES) <= 1, "{shares}");
    // The member's fee at a dump: 1.5 USDC at 2.15.
    let res = exit(&mut env, &f, &m, 50_000_000).unwrap();
    let ev = decode_events::<FeeCharged>(&res);
    assert_eq!(
        (ev[0].fee_usdc, ev[0].price_per_share),
        (1_500_000, 2_150_000)
    );
}

/// A genuine crash under cost: the breaker trips at once through the low
/// mark, while the record and the deposit price stay at cost (the captain's
/// first loss backs a T3 holding at cost until it is sold).
#[test]
fn crash_under_cost_trips_the_breaker_and_deposits_pay_cost() {
    let (mut env, m, f, mut t) = fund_with_based_meme();
    // MEME crashes to $0.0005 and stays: low-mark pps (500 + 3) / 400 =
    // 1.2575 < 70% of 2.15.
    t.fields.value = SB_ONE / 2_000;
    for _ in 0..10 {
        warp(&mut env.svm, MARK_INTERVAL_SLOTS as i64);
        refresh_meme(&mut env, &t);
        poke(&mut env, &f, &m).unwrap();
        let fund = read_fund(&env, &f);
        assert!(fund.frozen);
        assert_eq!(fund.last_price_per_share, 2_150_000);
    }
    let d = funded_user(&mut env, 1_000_000_000);
    deposit(&mut env, &f, &d, 200_000_000).unwrap();
    let shares = token_balance(&env.svm, &share_ata(&f, &d.pubkey()));
    assert!(shares.abs_diff(FAIR_SHARES) <= 1, "{shares}");
}

#[test]
fn nav_values_switchboard_token_at_feed_value() {
    let (mut env, m, f, t) = fund_with_meme();
    let mut ix = ix_deposit(&env, &f, &m.pubkey(), 200_000_000);
    // Last holding (MEME): [vault, entry, feed, price_b (not read)].
    let n = ix.accounts.len();
    assert_eq!(ix.accounts[n - 2].pubkey, t.feed);
    ix.accounts[n - 1].pubkey = Pubkey::new_unique();
    // NAV = 300 + 6,000 * 0.05 = 600 -> pps 2.0; 200 USDC buys 100 shares.
    send(&mut env.svm, &[ix], &[&m]).unwrap();
    assert_eq!(
        token_balance(&env.svm, &share_ata(&f, &m.pubkey())),
        100_000_000
    );
    assert_eq!(read_fund(&env, &f).last_price_per_share, 2_000_000);
}

#[test]
fn nav_values_switchboard_token_with_std_dev_upper_bound() {
    let (mut env, m, f, mut t) = fund_with_meme();
    t.fields.std_dev = SB_ONE / 2_000; // $0.0005 = 100 bps
    refresh_meme(&mut env, &t);
    // Ema (no EMA: the feed value): 300 + 300 = 600 -> pps 2.0.
    let ix = ix_poke_nav(&env, &f);
    send(&mut env.svm, &[ix], &[&m]).unwrap();
    assert_eq!(read_fund(&env, &f).last_price_per_share, 2_000_000);
    // Upper bound: 6,000 * (0.05 + 0.0005) = 303 -> NAV 603;
    // 201 USDC buys exactly 100 shares.
    deposit(&mut env, &f, &m, 201_000_000).unwrap();
    assert_eq!(
        token_balance(&env.svm, &share_ata(&f, &m.pubkey())),
        100_000_000
    );
}

#[test]
fn deposit_rejects_fewer_shares_than_min_shares() {
    let (mut env, _cap, m, f) = fund_with_member();
    // pps 1.0: 100 USDC buys 100 shares.
    let mut ix = ix_deposit_min(&env, &f, &m.pubkey(), 100_000_000, 100_000_001);
    ix.accounts.extend(nav_accounts(&env, &f));
    expect_err(
        send(&mut env.svm, &[ix], &[&m]),
        ErrorCode::SlippageExceeded,
    );
    let mut ix = ix_deposit_min(&env, &f, &m.pubkey(), 100_000_000, 100_000_000);
    ix.accounts.extend(nav_accounts(&env, &f));
    send(&mut env.svm, &[ix], &[&m]).unwrap();
    assert_eq!(
        token_balance(&env.svm, &share_ata(&f, &m.pubkey())),
        100_000_000
    );
}

#[test]
fn switchboard_marks_are_stored_the_low_mark_drops_at_once() {
    let (mut env, m, f, mut t) = fund_with_meme();
    let marks = |env: &Env| read_entry(env, &t.mint).marks;
    // Seeded at $0.05 by the first read, 1,500 slots ago.
    let seeded = marks(&env);
    let now = env.svm.get_sysvar::<Clock>().slot;
    assert_eq!((seeded.deposit, seeded.low), (SB_ONE / 20, SB_ONE / 20));
    assert!(seeded.seed_slot + MARK_WARMUP_SLOTS <= now, "warm");
    // MEME doubles: both marks move one 10% step, to $0.055.
    t.fields.value = SB_ONE / 10;
    warp(&mut env.svm, MARK_INTERVAL_SLOTS as i64);
    refresh_meme(&mut env, &t);
    poke(&mut env, &f, &m).unwrap();
    let s0 = env.svm.get_sysvar::<Clock>().slot;
    let m0 = marks(&env);
    assert_eq!((m0.deposit, m0.deposit_slot), (SB_ONE * 55 / 1_000, s0));
    assert_eq!((m0.low, m0.low_slot), (SB_ONE * 55 / 1_000, s0));
    // One slot before the interval ends: no move.
    warp(&mut env.svm, MARK_INTERVAL_SLOTS as i64 - 1);
    refresh_meme(&mut env, &t);
    poke(&mut env, &f, &m).unwrap();
    assert_eq!(marks(&env), m0);
    // MEME falls to $0.02 in the same interval: the low mark drops at once,
    // the deposit mark waits.
    t.fields.value = SB_ONE / 50;
    refresh_meme(&mut env, &t);
    env.svm.expire_blockhash();
    poke(&mut env, &f, &m).unwrap();
    let m1 = marks(&env);
    assert_eq!(
        (m1.deposit, m1.low, m1.low_slot),
        (m0.deposit, SB_ONE / 50, s0)
    );
    // Back to $0.10 at the interval: the deposit mark steps up from $0.055,
    // the low mark one step up from $0.02, not to $0.10.
    t.fields.value = SB_ONE / 10;
    warp(&mut env.svm, 1);
    refresh_meme(&mut env, &t);
    poke(&mut env, &f, &m).unwrap();
    let m2 = marks(&env);
    assert_eq!(
        (m2.deposit, m2.low),
        (SB_ONE * 605 / 10_000, SB_ONE * 22 / 1_000)
    );
    assert_eq!(m2.seed_slot, seeded.seed_slot);
}

#[test]
fn relisting_resets_the_marks_only_for_a_new_price_source() {
    let (mut env, _m, _f, mut t) = fund_with_meme();
    let seeded = read_entry(&env, &t.mint).marks;
    assert_ne!(seeded, Marks::default());
    // A tier change keeps the marks.
    register_token_with(&mut env, t.mint, t.source(), Tier::T3);
    assert_eq!(read_entry(&env, &t.mint).marks, seeded);
    // A new feed is a new price source: unseeded marks.
    t.feed = Pubkey::new_unique();
    register_token_with(&mut env, t.mint, t.source(), Tier::T3);
    assert_eq!(read_entry(&env, &t.mint).marks, Marks::default());
}

#[test]
fn nav_rejects_a_read_only_switchboard_entry() {
    let (mut env, m, f, t) = fund_with_meme();
    let mut ix = ix_deposit(&env, &f, &m.pubkey(), 100_000_000);
    let entry = token_pda(&t.mint);
    let meta = ix.accounts.iter_mut().find(|a| a.pubkey == entry).unwrap();
    assert!(meta.is_writable);
    meta.is_writable = false;
    expect_anchor_err(
        send(&mut env.svm, &[ix], &[&m]),
        anchor_lang::error::ErrorCode::ConstraintMut,
    );
}

/// A dumped thin pool (every oracle agrees) does not dilute the crew: the
/// deposit pays max(spot, mark), and the mark falls one step per interval.
#[test]
fn deposit_after_a_dump_pays_the_mark() {
    let (mut env, m, f, mut t) = fund_with_meme();
    // The first NAV read sets the mark to the spot, $0.05.
    poke(&mut env, &f, &m).unwrap();
    // MEME is dumped 50% to $0.025.
    t.fields.value = SB_ONE / 40;
    refresh_meme(&mut env, &t);
    // At the dump: NAV 300 + 150 = 450, pps 1.5, 200 USDC would buy 133.33 shares.
    // At the mark: NAV 600, pps 2.0, 100 shares.
    deposit(&mut env, &f, &m, 200_000_000).unwrap();
    let shares = share_ata(&f, &m.pubkey());
    assert_eq!(token_balance(&env.svm, &shares), 100_000_000);
    // One interval later the mark is 10% lower, $0.045: NAV 500 + 270 = 770
    // for 400 shares, pps 1.925. The deposit pays the recorded pps 2.0
    // (higher): 192.5 USDC buys 96.25 shares.
    warp(&mut env.svm, MARK_INTERVAL_SLOTS as i64);
    refresh_meme(&mut env, &t);
    deposit(&mut env, &f, &m, 192_500_000).unwrap();
    assert_eq!(token_balance(&env.svm, &shares), 196_250_000);
}

/// A 10x pump and pokes move the peak by at most one mark step per interval.
#[test]
fn poke_after_a_pump_moves_the_peak_one_mark_step() {
    let (mut env, m, f, mut t) = fund_with_meme();
    poke(&mut env, &f, &m).unwrap();
    assert_eq!(read_fund(&env, &f).peak_price_per_share, 2_000_000);
    // MEME pumps 10x to $0.50: at spot the pps would be (300 + 3,000) / 300 = 11.
    t.fields.value = SB_ONE / 2;
    refresh_meme(&mut env, &t);
    env.svm.expire_blockhash();
    poke(&mut env, &f, &m).unwrap();
    let fund = read_fund(&env, &f);
    assert_eq!(
        (fund.peak_price_per_share, fund.last_price_per_share),
        (2_000_000, 2_000_000)
    );
    // One interval later: one step, $0.055, NAV 300 + 330 = 630, pps 2.1.
    warp(&mut env.svm, MARK_INTERVAL_SLOTS as i64);
    refresh_meme(&mut env, &t);
    poke(&mut env, &f, &m).unwrap();
    assert_eq!(read_fund(&env, &f).peak_price_per_share, 2_100_000);
    // A second poke in the same interval does not move it again.
    env.svm.expire_blockhash();
    poke(&mut env, &f, &m).unwrap();
    assert_eq!(read_fund(&env, &f).peak_price_per_share, 2_100_000);
}

#[test]
fn nav_rejects_switchboard_feed_not_in_registry() {
    let (mut env, m, f, t) = fund_with_meme();
    // A valid, fresh feed, but not the one listed for this token.
    let other = Pubkey::new_unique();
    let slot = env.svm.get_sysvar::<Clock>().slot;
    let fields = FeedFields {
        slot,
        min_slot: slot,
        ..t.fields
    };
    write_feed(&mut env.svm, other, &fields);
    let mut ix = ix_deposit(&env, &f, &m.pubkey(), 100_000_000);
    let n = ix.accounts.len();
    ix.accounts[n - 2].pubkey = other;
    expect_err(send(&mut env.svm, &[ix], &[&m]), ErrorCode::FeedMismatch);
}

#[test]
fn nav_rejects_switchboard_feed_repointed_by_its_authority() {
    let (mut env, m, f, mut t) = fund_with_meme();
    // NAV 600 -> pps 2.0; 100 USDC buys 50 shares.
    deposit(&mut env, &f, &m, 100_000_000).unwrap();
    // The feed authority moves the feed to another job: pricing stops.
    t.fields.feed_hash[0] ^= 1;
    refresh_meme(&mut env, &t);
    env.svm.expire_blockhash();
    expect_err(
        deposit(&mut env, &f, &m, 100_000_000),
        ErrorCode::FeedConfigChanged,
    );
    // The same for a move to another oracle queue.
    t.fields.feed_hash[0] ^= 1;
    t.fields.queue = Pubkey::new_unique();
    refresh_meme(&mut env, &t);
    env.svm.expire_blockhash();
    expect_err(
        deposit(&mut env, &f, &m, 100_000_000),
        ErrorCode::FeedConfigChanged,
    );
    // Exits stay in-kind and need no price.
    let token = spl_token_interface::ID;
    let ix = ix_create_ata(&m.pubkey(), &m.pubkey(), &t.mint, &token);
    send(&mut env.svm, &[ix], &[&m]).unwrap();
    let shares = token_balance(&env.svm, &share_ata(&f, &m.pubkey()));
    assert_eq!(shares, 50_000_000);
    let ix = ix_exit_unpriced(&env, &f, &m.pubkey(), shares);
    send(&mut env.svm, &[ix], &[&m]).unwrap();
    assert_eq!(token_balance(&env.svm, &share_ata(&f, &m.pubkey())), 0);
    // 50 of 350 shares: 1/7 of 6,000 MEME, floor.
    let meme = ata(&m.pubkey(), &t.mint, &token);
    assert_eq!(token_balance(&env.svm, &meme), 857_142_857_142);
}

#[test]
fn nav_rejects_switchboard_feed_not_owned_by_switchboard() {
    let (mut env, m, f, t) = fund_with_meme();
    let mut acc = env.svm.get_account(&t.feed).unwrap();
    acc.owner = Pubkey::new_unique();
    env.svm.set_account(t.feed, acc).unwrap();
    expect_err(
        deposit(&mut env, &f, &m, 100_000_000),
        ErrorCode::FeedInvalid,
    );
}

#[test]
fn nav_rejects_stale_switchboard_feed() {
    let (mut env, m, f, _t) = fund_with_meme();
    // 60 s at 400 ms/slot = 150 slots.
    let mut clock: Clock = env.svm.get_sysvar();
    clock.slot += MAX_RESULT_AGE_SLOTS + 1;
    env.svm.set_sysvar(&clock);
    expect_err(
        deposit(&mut env, &f, &m, 100_000_000),
        ErrorCode::PriceStale,
    );
    // At exactly the limit it is still fresh.
    clock.slot -= 1;
    env.svm.set_sysvar(&clock);
    env.svm.expire_blockhash();
    deposit(&mut env, &f, &m, 100_000_000).unwrap();
}

#[test]
fn nav_rejects_switchboard_result_with_an_old_sample() {
    let (mut env, m, f, t) = fund_with_meme();
    // Result slot is now, but its oldest sample is 151 slots old.
    let slot = env.svm.get_sysvar::<Clock>().slot;
    let fields = FeedFields {
        slot,
        min_slot: slot - MAX_RESULT_AGE_SLOTS - 1,
        ..t.fields
    };
    write_feed(&mut env.svm, t.feed, &fields);
    expect_err(
        deposit(&mut env, &f, &m, 100_000_000),
        ErrorCode::PriceStale,
    );
}

#[test]
fn nav_rejects_switchboard_result_with_two_samples() {
    let (mut env, m, f, mut t) = fund_with_meme();
    t.fields.num_samples = 2;
    refresh_meme(&mut env, &t);
    expect_err(
        deposit(&mut env, &f, &m, 100_000_000),
        ErrorCode::FeedTooFewSamples,
    );
    t.fields.num_samples = 3;
    refresh_meme(&mut env, &t);
    env.svm.expire_blockhash();
    deposit(&mut env, &f, &m, 100_000_000).unwrap();
}

#[test]
fn deposit_values_switchboard_price_near_i64_limit() {
    let (mut env, m, f, mut t) = fund_with_meme();
    // $9.10 +- $0.15 (165 bps): 9.10e18 fits i64, 9.25e18 does not.
    t.fields.value = SB_ONE * 91 / 10;
    t.fields.std_dev = SB_ONE * 15 / 100;
    refresh_meme(&mut env, &t);
    // Upper bound NAV = 300 + 6,000 * 9.25 = 55,800; floor(100 * 300 / 55,800) shares.
    deposit(&mut env, &f, &m, 100_000_000).unwrap();
    assert_eq!(
        token_balance(&env.svm, &share_ata(&f, &m.pubkey())),
        537_634
    );
}

#[test]
fn nav_rejects_wide_or_non_positive_switchboard_result() {
    let (mut env, m, f, mut t) = fund_with_meme();
    // std_dev 201 bps of $0.05.
    t.fields.std_dev = SB_ONE / 20 * 201 / 10_000;
    refresh_meme(&mut env, &t);
    expect_err(
        deposit(&mut env, &f, &m, 100_000_000),
        ErrorCode::PriceConfTooWide,
    );
    t.fields.std_dev = 0;
    t.fields.value = -SB_ONE;
    refresh_meme(&mut env, &t);
    env.svm.expire_blockhash();
    expect_err(
        deposit(&mut env, &f, &m, 100_000_000),
        ErrorCode::PriceNonPositive,
    );
}

/// Fund with 300 USDC (300 shares) + 300 kUSDC at rate 1.05 (= 315 USDC).
fn fund_with_kusdc() -> (Env, Keypair, FundHandles, KToken) {
    let (mut env, _cap, m, f) = fund_with_member();
    let k = listed_kusdc(&mut env);
    inject_holding(&mut env, &f, k.mint, 300_000_000);
    settle_pps(&mut env, &f, &m, |env| refresh_kusdc(env, &k));
    (env, m, f, k)
}

#[test]
fn nav_values_ktoken_at_reserve_rate() {
    let (mut env, m, f, k) = fund_with_kusdc();
    let ix = ix_deposit(&env, &f, &m.pubkey(), 205_000_000);
    // Last holding (kUSDC): [vault, entry, reserve, underlying Pyth].
    let n = ix.accounts.len();
    assert_eq!(ix.accounts[n - 2].pubkey, k.reserve);
    assert_eq!(ix.accounts[n - 1].pubkey, price_account(&k.reserve));
    // NAV = 300 + 300 * 1.05 = 615 -> pps 2.05; 205 USDC buys 100 shares.
    send(&mut env.svm, &[ix], &[&m]).unwrap();
    assert_eq!(
        token_balance(&env.svm, &share_ata(&f, &m.pubkey())),
        100_000_000
    );
    assert_eq!(read_fund(&env, &f).last_price_per_share, 2_050_000);
}

#[test]
fn nav_values_ktoken_with_underlying_ema_and_conf() {
    let (mut env, m, f, k) = fund_with_kusdc();
    // Next interval (the recorded pps moves once per interval).
    warp(&mut env.svm, MARK_INTERVAL_SLOTS as i64);
    refresh_kusdc(&mut env, &k);
    // USDC spot 1.00, conf 0.01, ema 0.98.
    let t = now(&env);
    set_price_ema(
        &mut env.svm,
        price_account(&k.reserve),
        &USDC_FEED,
        100_000_000,
        1_000_000,
        -8,
        t,
        98_000_000,
        1_000_000,
    );
    // Ema: 300 + 315 * 0.98 = 608.7 -> pps 2.029.
    let ix = ix_poke_nav(&env, &f);
    send(&mut env.svm, &[ix], &[&m]).unwrap();
    assert_eq!(read_fund(&env, &f).last_price_per_share, 2_029_000);
    // Upper bound: 315 * (max(1.00, 0.98) + 0.01) = 318.15 -> NAV 618.15;
    // 206.05 USDC buys exactly 100 shares.
    deposit(&mut env, &f, &m, 206_050_000).unwrap();
    assert_eq!(
        token_balance(&env.svm, &share_ata(&f, &m.pubkey())),
        100_000_000
    );
}

#[test]
fn nav_rejects_reserve_not_in_registry() {
    let (mut env, m, f, k) = fund_with_kusdc();
    // A valid, fresh reserve for the same kToken, but not the listed one.
    let other = Pubkey::new_unique();
    let slot = env.svm.get_sysvar::<Clock>().slot;
    write_reserve(&mut env.svm, other, &ReserveFields { slot, ..k.fields });
    let mut ix = ix_deposit(&env, &f, &m.pubkey(), 100_000_000);
    let n = ix.accounts.len();
    ix.accounts[n - 2].pubkey = other;
    expect_err(send(&mut env.svm, &[ix], &[&m]), ErrorCode::ReserveMismatch);
}

#[test]
fn nav_rejects_reserve_of_other_collateral_mint() {
    let (mut env, m, f, k) = fund_with_kusdc();
    let slot = env.svm.get_sysvar::<Clock>().slot;
    let fields = ReserveFields {
        slot,
        collateral_mint: Pubkey::new_unique(),
        ..k.fields
    };
    write_reserve(&mut env.svm, k.reserve, &fields);
    expect_err(
        deposit(&mut env, &f, &m, 100_000_000),
        ErrorCode::ReserveMismatch,
    );
}

#[test]
fn nav_rejects_reserve_not_owned_by_kamino() {
    let (mut env, m, f, k) = fund_with_kusdc();
    let mut acc = env.svm.get_account(&k.reserve).unwrap();
    acc.owner = Pubkey::new_unique();
    env.svm.set_account(k.reserve, acc).unwrap();
    expect_err(
        deposit(&mut env, &f, &m, 100_000_000),
        ErrorCode::ReserveInvalid,
    );
}

#[test]
fn nav_rejects_stale_reserve() {
    let (mut env, m, f, k) = fund_with_kusdc();
    // Marked stale by klend (any deposit/withdraw since the last refresh).
    let slot = env.svm.get_sysvar::<Clock>().slot;
    let fields = ReserveFields {
        slot,
        stale: true,
        ..k.fields
    };
    write_reserve(&mut env.svm, k.reserve, &fields);
    expect_err(
        deposit(&mut env, &f, &m, 100_000_000),
        ErrorCode::PriceStale,
    );
    // Not refreshed for more than 60 s of slots (klend: 2 slots/s), USDC price fresh.
    refresh_kusdc(&mut env, &k);
    let mut clock: Clock = env.svm.get_sysvar();
    clock.slot += MAX_RESERVE_AGE_SLOTS + 1;
    env.svm.set_sysvar(&clock);
    expect_err(
        deposit(&mut env, &f, &m, 100_000_000),
        ErrorCode::PriceStale,
    );
    // At exactly the limit it is still fresh.
    clock.slot -= 1;
    env.svm.set_sysvar(&clock);
    env.svm.expire_blockhash();
    deposit(&mut env, &f, &m, 100_000_000).unwrap();
}

#[test]
fn nav_rejects_wrong_underlying_feed() {
    let (mut env, m, f, k) = fund_with_kusdc();
    let t = now(&env);
    set_price(
        &mut env.svm,
        price_account(&k.reserve),
        &SOL_FEED,
        100_000_000,
        0,
        -8,
        t,
    );
    expect_err(
        deposit(&mut env, &f, &m, 100_000_000),
        ErrorCode::PriceFeedMismatch,
    );
}

#[test]
fn nav_layout_is_four_accounts_and_pyth_ignores_price_b() {
    let (mut env, _cap, m, f) = fund_with_member();
    let sol = listed_sol(&mut env, 150);
    inject_holding(&mut env, &f, sol, 2_000_000_000);
    let mut ix = ix_deposit(&env, &f, &m.pubkey(), 100_000_000);
    let n = ix.accounts.len();
    // Last holding (SOL): [vault, entry, price_a, price_b].
    assert_eq!(ix.accounts[n - 3].pubkey, token_pda(&sol));
    assert_eq!(ix.accounts[n - 2].pubkey, price_account(&sol));
    ix.accounts[n - 1].pubkey = Pubkey::new_unique(); // any key: not read for Pyth
    send(&mut env.svm, &[ix], &[&m]).unwrap();
    // Without price_b the layout is short.
    let mut ix = ix_deposit(&env, &f, &m.pubkey(), 100_000_000);
    ix.accounts.pop();
    expect_err(
        send(&mut env.svm, &[ix], &[&m]),
        ErrorCode::PriceAccountMissing,
    );
}
