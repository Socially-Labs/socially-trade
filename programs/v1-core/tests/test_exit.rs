mod common;

use {anchor_spl::token_2022::spl_token_2022, common::*, v1_core::state::Member};

fn shares_of(env: &Env, f: &FundHandles, owner: &Pubkey) -> u64 {
    token_balance(&env.svm, &share_ata(f, owner))
}
fn usdc_of(env: &Env, owner: &Pubkey) -> u64 {
    token_balance(&env.svm, &usdc_ata(env, owner))
}
fn member(env: &Env, f: &FundHandles, owner: &Pubkey) -> Member {
    read_account(&env.svm, &member_pda(&f.fund, owner))
}

/// Captain 300 USDC, member deposits 100 USDC (100 shares).
fn fund_300_100() -> (Env, Keypair, Keypair, FundHandles) {
    let (mut env, cap, m, f) = fund_with_member();
    deposit(&mut env, &f, &m, 100_000_000).unwrap();
    (env, cap, m, f)
}

#[test]
fn exit_pays_exact_pro_rata_usdc() {
    let (mut env, cap, m, f) = fund_300_100();
    let res = exit(&mut env, &f, &m, 100_000_000).unwrap();
    assert_eq!(events(&res), 1, "Exited only, no fee");
    assert_eq!(usdc_of(&env, &m.pubkey()), 1_000_000_000);
    assert_eq!(shares_of(&env, &f, &m.pubkey()), 0);
    assert_eq!(shares_of(&env, &f, &cap.pubkey()), 300_000_000);
    assert_eq!(token_balance(&env.svm, &f.usdc_vault), 300_000_000);
    assert_eq!(read_fund(&env, &f).total_shares, 300_000_000);
    assert_eq!(
        share_mint_state(&env.svm, &f.share_mint).base.supply,
        300_000_000
    );
    assert_eq!(member(&env, &f, &m.pubkey()).hwm, 0);
}

#[test]
fn exit_charges_fee_on_new_profit_only() {
    let (mut env, cap, m, f) = fund_300_100();
    // NAV 800 / 400 shares = pps 2.0; member value 200, hwm 100 -> fee 10 USDC = 5 shares.
    mint_usdc(&mut env, &f.usdc_vault, 400_000_000);
    let res = exit(&mut env, &f, &m, 100_000_000).unwrap();
    assert_eq!(events(&res), 2, "FeeCharged + Exited");
    assert_eq!(shares_of(&env, &f, &cap.pubkey()), 305_000_000);
    assert_eq!(shares_of(&env, &f, &m.pubkey()), 0);
    // Exit is capped at the 95 shares left: floor(800 * 95 / 400) = 190.
    assert_eq!(usdc_of(&env, &m.pubkey()), 900_000_000 + 190_000_000);
    assert_eq!(token_balance(&env.svm, &f.usdc_vault), 610_000_000);
    let fund = read_fund(&env, &f);
    assert_eq!(fund.total_shares, 305_000_000);
    assert_eq!(
        fund.last_price_per_share, 2_000_000,
        "breaker saw fresh EMA pps"
    );
    assert_eq!(
        share_mint_state(&env.svm, &f.share_mint).base.supply,
        305_000_000
    );
    assert_eq!(member(&env, &f, &m.pubkey()).hwm, 0);
}

#[test]
fn exit_fee_is_charged_once_per_profit() {
    let (mut env, cap, m, f) = fund_300_100();
    mint_usdc(&mut env, &f.usdc_vault, 400_000_000);
    // Exit 45 of 100: fee 5 shares first, then hwm 190 * (95-45)/95 = 100.
    exit(&mut env, &f, &m, 45_000_000).unwrap();
    assert_eq!(shares_of(&env, &f, &cap.pubkey()), 305_000_000);
    assert_eq!(shares_of(&env, &f, &m.pubkey()), 50_000_000);
    assert_eq!(member(&env, &f, &m.pubkey()).hwm, 100_000_000);
    // Same pps, value 100 = hwm: no second fee.
    let res = exit(&mut env, &f, &m, 50_000_000).unwrap();
    assert_eq!(events(&res), 1);
    assert_eq!(shares_of(&env, &f, &cap.pubkey()), 305_000_000);
}

#[test]
fn exit_works_when_paused() {
    let (mut env, _cap, m, f) = fund_300_100();
    let ix = ix_set_paused(&env.admin.pubkey(), true);
    send(&mut env.svm, &[ix], &[&env.admin]).unwrap();
    exit(&mut env, &f, &m, 100_000_000).unwrap();
    assert_eq!(usdc_of(&env, &m.pubkey()), 1_000_000_000);
}

#[test]
fn exit_works_when_frozen() {
    let (mut env, _cap, m, f) = fund_300_100();
    let mut fund = read_fund(&env, &f);
    fund.frozen = true;
    write_fund(&mut env, &f, &fund);
    exit(&mut env, &f, &m, 100_000_000).unwrap();
    assert_eq!(usdc_of(&env, &m.pubkey()), 1_000_000_000);
}

#[test]
fn partial_exit_scales_hwm() {
    let (mut env, _cap, m, f) = fund_300_100();
    exit(&mut env, &f, &m, 50_000_000).unwrap();
    assert_eq!(member(&env, &f, &m.pubkey()).hwm, 50_000_000);
    assert_eq!(usdc_of(&env, &m.pubkey()), 950_000_000);
    assert_eq!(shares_of(&env, &f, &m.pubkey()), 50_000_000);
    assert_eq!(read_fund(&env, &f).total_shares, 350_000_000);
}

#[test]
fn captain_cannot_exit_below_5pct_while_crew_holds() {
    let (mut env, cap, _m, f) = fund_300_100();
    // Floor: (300 - s) * 10000 >= (400 - s) * 500  <=>  s <= 294.736842.
    expect_err(
        exit(&mut env, &f, &cap, 294_736_843),
        ErrorCode::CaptainStakeFloor,
    );
    expect_err(
        exit(&mut env, &f, &cap, 300_000_000),
        ErrorCode::CaptainStakeFloor,
    );
    exit(&mut env, &f, &cap, 294_736_842).unwrap();
    assert_eq!(shares_of(&env, &f, &cap.pubkey()), 5_263_158);
    assert_eq!(read_fund(&env, &f).total_shares, 105_263_158);
}

#[test]
fn captain_pays_no_fee() {
    let (mut env, cap, _m, f) = fund_300_100();
    mint_usdc(&mut env, &f.usdc_vault, 400_000_000); // pps 2.0, captain value 600 > hwm 300
    let res = exit(&mut env, &f, &cap, 100_000_000).unwrap();
    assert_eq!(events(&res), 1, "Exited only");
    // floor(800 * 100 / 400) = 200
    assert_eq!(usdc_of(&env, &cap.pubkey()), 700_000_000 + 200_000_000);
    assert_eq!(shares_of(&env, &f, &cap.pubkey()), 200_000_000);
}

#[test]
fn captain_can_exit_fully_when_alone() {
    let (mut env, cap, m, f) = fund_with_member();
    exit(&mut env, &f, &cap, 300_000_000).unwrap();
    assert_eq!(usdc_of(&env, &cap.pubkey()), 1_000_000_000);
    assert_eq!(token_balance(&env.svm, &f.usdc_vault), 0);
    assert_eq!(read_fund(&env, &f).total_shares, 0);
    // A fund with no shares is closed.
    expect_err(
        deposit(&mut env, &f, &m, 100_000_000),
        ErrorCode::FundClosed,
    );
}

#[test]
fn exit_more_than_balance_rejected() {
    let (mut env, _cap, m, f) = fund_300_100();
    expect_err(exit(&mut env, &f, &m, 100_000_001), ErrorCode::ExitTooLarge);
    expect_err(exit(&mut env, &f, &m, 0), ErrorCode::ExitTooLarge);
}

#[test]
fn exit_rejects_other_funds_share_mint() {
    let (mut env, _cap, m, f) = fund_300_100();
    let cap2 = funded_user(&mut env, 1_000_000_000);
    let f2 = create_fund(&mut env, &cap2, 9, 300_000_000).unwrap();
    let mut ix = ix_exit(&env, &f, &m.pubkey(), 1_000_000);
    ix.accounts[5].pubkey = f2.share_mint;
    expect_anchor_err(
        send(&mut env.svm, &[ix], &[&m]),
        anchor_lang::error::ErrorCode::ConstraintAddress,
    );
}

// ---------------------------------------------------------------------------
// Pricing of the fee: fresh NAV vs fallback to the last pps
// ---------------------------------------------------------------------------

/// Captain 300 USDC + 2 SOL @ $150 (pps 2.0); member deposits 200 USDC = 100
/// shares (hwm 200, last pps 2.0). Then SOL moves to $300 with $3 conf.
/// The member gets a SOL ATA.
fn sol_fund_after_rally() -> (Env, Keypair, Keypair, FundHandles, Pubkey) {
    let (mut env, cap, m, f) = fund_with_member();
    let sol = listed_sol(&mut env, 150);
    inject_holding(&mut env, &f, sol, 2_000_000_000);
    deposit(&mut env, &f, &m, 200_000_000).unwrap();
    assert_eq!(shares_of(&env, &f, &m.pubkey()), 100_000_000);
    let token = spl_token_interface::ID;
    let ix = ix_create_ata(&m.pubkey(), &m.pubkey(), &sol, &token);
    send(&mut env.svm, &[ix], &[&m]).unwrap();
    sol_price(&mut env, &sol, 300, 300, 300);
    (env, cap, m, f, sol)
}

/// No fee at last pps 2.0 (value 200 = hwm): the member gets exactly 1/4.
#[track_caller]
fn assert_paid_at_last_pps(env: &Env, cap: &Keypair, m: &Keypair, f: &FundHandles, sol: &Pubkey) {
    assert_eq!(shares_of(env, f, &cap.pubkey()), 300_000_000, "no fee");
    assert_eq!(usdc_of(env, &m.pubkey()), 800_000_000 + 125_000_000);
    let m_sol = ata(&m.pubkey(), sol, &spl_token_interface::ID);
    assert_eq!(token_balance(&env.svm, &m_sol), 500_000_000);
    let fund = read_fund(env, f);
    assert_eq!(fund.last_price_per_share, 2_000_000, "breaker not moved");
    assert_eq!(fund.total_shares, 300_000_000);
}

#[test]
fn exit_fee_uses_upper_bound_pps_and_breaker_uses_ema() {
    let (mut env, cap, m, f, sol) = sol_fund_after_rally();
    let res = exit(&mut env, &f, &m, 100_000_000).unwrap();
    assert_eq!(events(&res), 2, "FeeCharged + Exited");
    // Upper NAV 500 + 2 * 303 = 1106 / 400 -> pps 2.765. Value 276.5, fee 7.65 USDC
    // = floor(7.65 / 2.765) = 2.766726 shares.
    assert_eq!(shares_of(&env, &f, &cap.pubkey()), 302_766_726);
    // 97.233274 shares out of 400: floor(500 * q / 400) USDC, floor(2 * q / 400) SOL.
    assert_eq!(usdc_of(&env, &m.pubkey()), 800_000_000 + 121_541_592);
    let m_sol = ata(&m.pubkey(), &sol, &spl_token_interface::ID);
    assert_eq!(token_balance(&env.svm, &m_sol), 486_166_370);
    let fund = read_fund(&env, &f);
    assert_eq!(fund.last_price_per_share, 2_750_000, "EMA NAV 1100 / 400");
    assert_eq!(fund.total_shares, 302_766_726);
}

#[test]
fn exit_fee_after_price_drop_uses_last_pps() {
    let (mut env, cap, m, f, sol) = sol_fund_after_rally();
    // Rally recorded: SOL $300, conf 0. The captain's deposit records the EMA
    // pps 1100 / 400 = 2.75 (and buys floor(11 * 400 / 1100) = 4 shares).
    sol_price(&mut env, &sol, 300, 0, 300);
    deposit(&mut env, &f, &cap, 11_000_000).unwrap();
    assert_eq!(read_fund(&env, &f).last_price_per_share, 2_750_000);
    assert_eq!(shares_of(&env, &f, &cap.pubkey()), 304_000_000);
    // Drop: SOL back to $150. Fresh upper pps (511 + 300) / 404 = 2.007 < 2.75.
    sol_price(&mut env, &sol, 150, 0, 150);
    let res = exit(&mut env, &f, &m, 100_000_000).unwrap();
    assert_eq!(events(&res), 2, "FeeCharged + Exited");
    // Fee at 2.75: value 275, hwm 200 -> 7.5 USDC = floor(7.5 / 2.75) = 2.727272 shares.
    assert_eq!(shares_of(&env, &f, &cap.pubkey()), 306_727_272);
    // The breaker still moves on the fresh EMA pps: 811 / 404 = 2.007425.
    assert_eq!(read_fund(&env, &f).last_price_per_share, 2_007_425);
}

#[test]
fn exit_without_nav_accounts_uses_last_pps() {
    let (mut env, cap, m, f, sol) = sol_fund_after_rally();
    let ix = ix_exit_unpriced(&env, &f, &m.pubkey(), 100_000_000);
    send(&mut env.svm, &[ix], &[&m]).unwrap();
    assert_paid_at_last_pps(&env, &cap, &m, &f, &sol);
}

#[test]
fn exit_with_stale_price_uses_last_pps() {
    let (mut env, cap, m, f, sol) = sol_fund_after_rally();
    warp(&mut env.svm, MAX_PRICE_AGE_SECS as i64 + 1);
    exit(&mut env, &f, &m, 100_000_000).unwrap();
    assert_paid_at_last_pps(&env, &cap, &m, &f, &sol);
}

#[test]
fn exit_with_invalid_nav_account_uses_last_pps() {
    let (mut env, cap, m, f, sol) = sol_fund_after_rally();
    let mut ix = ix_exit(&env, &f, &m.pubkey(), 100_000_000);
    // NAV block starts after 2 holdings * 3 exit accounts; SOL's price_a is its 7th account.
    let nav = 10 + 2 * 3;
    assert_eq!(ix.accounts[nav + 6].pubkey, price_account(&sol));
    ix.accounts[nav + 6].pubkey = f.usdc_vault; // not a Pyth account
    send(&mut env.svm, &[ix], &[&m]).unwrap();
    assert_paid_at_last_pps(&env, &cap, &m, &f, &sol);
}

// ---------------------------------------------------------------------------
// Exit accounts
// ---------------------------------------------------------------------------

#[test]
fn exit_skips_holding_with_empty_vault() {
    let (mut env, _cap, m, f) = fund_300_100();
    let dust = create_mint(&mut env, 9);
    inject_holding(&mut env, &f, dust, 0);
    // The member has no account for `dust`; nothing is owed, so none is needed.
    let m_dust = ata(&m.pubkey(), &dust, &spl_token_interface::ID);
    assert!(env.svm.get_account(&m_dust).is_none());
    let ix = ix_exit_unpriced(&env, &f, &m.pubkey(), 100_000_000);
    send(&mut env.svm, &[ix], &[&m]).unwrap();
    assert_eq!(usdc_of(&env, &m.pubkey()), 1_000_000_000);
}

#[test]
fn exit_pays_token_2022_holding() {
    let (mut env, _cap, m, f) = fund_300_100();
    let t22 = spl_token_2022::ID;
    let mint = write_mint(&mut env.svm, &env.admin.pubkey(), 9, &t22);
    inject_holding(&mut env, &f, mint, 4_000_000_000);
    let ix = ix_create_ata(&m.pubkey(), &m.pubkey(), &mint, &t22);
    send(&mut env.svm, &[ix], &[&m]).unwrap();
    let ix = ix_exit_unpriced(&env, &f, &m.pubkey(), 100_000_000);
    send(&mut env.svm, &[ix], &[&m]).unwrap();
    assert_eq!(
        token_balance(&env.svm, &ata(&m.pubkey(), &mint, &t22)),
        1_000_000_000
    );
    assert_eq!(
        token_balance(&env.svm, &ata(&f.fund, &mint, &t22)),
        3_000_000_000
    );
    assert_eq!(usdc_of(&env, &m.pubkey()), 1_000_000_000);
}

#[test]
fn exit_rejects_wrong_user_token_account() {
    let (mut env, cap, m, f) = fund_300_100();
    let mut ix = ix_exit_unpriced(&env, &f, &m.pubkey(), 100_000_000);
    ix.accounts[10 + 1].pubkey = usdc_ata(&env, &cap.pubkey()); // captain's USDC
    expect_anchor_err(
        send(&mut env.svm, &[ix], &[&m]),
        anchor_lang::error::ErrorCode::ConstraintTokenOwner,
    );
}

#[test]
fn exit_rejects_user_token_account_of_other_mint() {
    let (mut env, _cap, m, f) = fund_300_100();
    let other = create_mint(&mut env, 6);
    let token = spl_token_interface::ID;
    let ix = ix_create_ata(&m.pubkey(), &m.pubkey(), &other, &token);
    send(&mut env.svm, &[ix], &[&m]).unwrap();
    let mut ix = ix_exit_unpriced(&env, &f, &m.pubkey(), 100_000_000);
    ix.accounts[10 + 1].pubkey = ata(&m.pubkey(), &other, &token);
    expect_anchor_err(
        send(&mut env.svm, &[ix], &[&m]),
        anchor_lang::error::ErrorCode::ConstraintTokenMint,
    );
}

#[test]
fn exit_rejects_wrong_vault() {
    let (mut env, cap, m, f) = fund_300_100();
    let mut ix = ix_exit_unpriced(&env, &f, &m.pubkey(), 100_000_000);
    ix.accounts[10].pubkey = usdc_ata(&env, &cap.pubkey());
    expect_err(send(&mut env.svm, &[ix], &[&m]), ErrorCode::HoldingNotFound);
}

#[test]
fn exit_rejects_wrong_mint_account() {
    let (mut env, _cap, m, f) = fund_300_100();
    let other = create_mint(&mut env, 6);
    let mut ix = ix_exit_unpriced(&env, &f, &m.pubkey(), 100_000_000);
    ix.accounts[10 + 2].pubkey = other;
    expect_err(send(&mut env.svm, &[ix], &[&m]), ErrorCode::HoldingNotFound);
}

#[test]
fn exit_rejects_missing_exit_accounts() {
    let (mut env, _cap, m, f) = fund_300_100();
    let ix = ix_exit_bare(&env, &f, &m.pubkey(), 100_000_000);
    expect_err(send(&mut env.svm, &[ix], &[&m]), ErrorCode::HoldingNotFound);
}
