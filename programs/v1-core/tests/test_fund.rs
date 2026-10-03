mod common;

use {
    anchor_spl::token_2022::spl_token_2022,
    common::*,
    v1_core::state::{Fund, Member, Policy, PolicyParams},
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
        create_fund(&mut env, &cap, 1, 249_999_999),
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
    let fund = read_fund(&env, &f);
    assert_eq!(fund.last_price_per_share, 1_337_777);
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

#[test]
fn nav_rejects_switchboard_until_supported() {
    let (mut env, _cap, m, f) = fund_with_member();
    let mint = create_mint(&mut env, 9);
    let source = PriceSource::Switchboard {
        feed: Pubkey::new_unique(),
    };
    register_token_with(&mut env, mint, source, Tier::T1);
    inject_holding(&mut env, &f, mint, 2_000_000_000);
    expect_err(
        deposit(&mut env, &f, &m, 100_000_000),
        ErrorCode::PriceSourceUnsupported,
    );
}

/// Fund with 300 USDC (300 shares) + 300 kUSDC at rate 1.05 (= 315 USDC).
fn fund_with_kusdc() -> (Env, Keypair, FundHandles, KToken) {
    let (mut env, _cap, m, f) = fund_with_member();
    let k = listed_kusdc(&mut env);
    inject_holding(&mut env, &f, k.mint, 300_000_000);
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
