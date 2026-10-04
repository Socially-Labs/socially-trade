mod common;

use {
    common::*,
    v1_core::{
        constants::YEAR_SECS,
        errors::ErrorCode,
        events::{CaptainLog, FeeCharged},
        state::Member,
    },
};

fn ix_fee(env: &Env, f: &FundHandles, member_owner: &Pubkey, payer: &Pubkey) -> Instruction {
    let fund = read_fund(env, f);
    let mut ix = v1_ix(
        v1_core::accounts::ChargeAnnualFee {
            payer: *payer,
            config: config_pda(),
            fund: f.fund,
            policy: f.policy,
            member: member_pda(&f.fund, member_owner),
            share_mint: f.share_mint,
            member_shares: share_ata(f, member_owner),
            captain_shares: share_ata(f, &fund.captain),
            share_token_program: anchor_spl::token_2022::spl_token_2022::ID,
        },
        v1_core::instruction::ChargeAnnualFee {},
    );
    ix.accounts.extend(nav_accounts(env, f));
    ix
}

#[allow(clippy::result_large_err)] // LiteSVM's own error type.
fn charge(
    env: &mut Env,
    f: &FundHandles,
    member_owner: &Pubkey,
    payer: &Keypair,
) -> Result<TransactionMetadata, FailedTransactionMetadata> {
    let ix = ix_fee(env, f, member_owner, &payer.pubkey());
    send(&mut env.svm, &[ix], &[payer])
}

fn ix_log(
    f: &FundHandles,
    signer: &Pubkey,
    delegate: Option<Pubkey>,
    hash: [u8; 32],
) -> Instruction {
    v1_ix(
        v1_core::accounts::WriteLog {
            signer: *signer,
            fund: f.fund,
            delegate,
        },
        v1_core::instruction::CaptainLog { reason_hash: hash },
    )
}

fn member(env: &Env, f: &FundHandles, owner: &Pubkey) -> Member {
    read_account(&env.svm, &member_pda(&f.fund, owner))
}

/// Captain 300, member 1000 USDC in. Donate 195 so pps = 1.15 (member value 1150).
fn whitepaper() -> (Env, Keypair, Keypair, FundHandles) {
    let (mut env, cap, m, f) = fund_with_member();
    deposit(&mut env, &f, &m, 1_000_000_000).unwrap();
    mint_usdc(&mut env, &f.usdc_vault, 195_000_000);
    (env, cap, m, f)
}

#[test]
fn annual_fee_not_due_before_a_year() {
    let (mut env, _cap, m, f) = whitepaper();
    let keeper = funded_user(&mut env, 0);
    warp(&mut env.svm, YEAR_SECS - 10);
    expect_err(
        charge(&mut env, &f, &m.pubkey(), &keeper),
        ErrorCode::FeeNotDue,
    );
    warp(&mut env.svm, 10);
    charge(&mut env, &f, &m.pubkey(), &keeper).unwrap();
}

#[test]
fn annual_fee_whitepaper_example() {
    let (mut env, cap, m, f) = whitepaper();
    let keeper = funded_user(&mut env, 0);
    warp(&mut env.svm, YEAR_SECS);
    let t = now(&env);
    let res = charge(&mut env, &f, &m.pubkey(), &keeper).unwrap();
    let ev = decode_events::<FeeCharged>(&res);
    assert_eq!(ev.len(), 1);
    assert_eq!(ev[0].fee_usdc, 15_000_000);
    assert_eq!(ev[0].fee_shares, 13_043_478);
    // 15 USDC at 1.15 = 13.043478 shares: burned from the member, minted to the captain.
    assert_eq!(
        token_balance(&env.svm, &share_ata(&f, &m.pubkey())),
        1_000_000_000 - 13_043_478
    );
    assert_eq!(
        token_balance(&env.svm, &share_ata(&f, &cap.pubkey())),
        300_000_000 + 13_043_478
    );
    let mb = member(&env, &f, &m.pubkey());
    assert_eq!(mb.hwm, 1_135_000_000);
    assert_eq!(mb.last_fee_at, t);
    let fund = read_fund(&env, &f);
    assert_eq!(fund.total_shares, 1_300_000_000, "mint and burn cancel");
    assert_eq!(
        share_mint_state(&env.svm, &f.share_mint).base.supply,
        1_300_000_000
    );
    assert_eq!(
        fund.last_price_per_share, 1_150_000,
        "breaker saw fresh pps"
    );
    // Not due again for another year.
    expect_err(
        charge(&mut env, &f, &m.pubkey(), &keeper),
        ErrorCode::FeeNotDue,
    );
}

#[test]
fn annual_fee_zero_below_hwm() {
    let (mut env, _cap, m, f) = fund_with_member();
    deposit(&mut env, &f, &m, 1_000_000_000).unwrap();
    let keeper = funded_user(&mut env, 0);
    warp(&mut env.svm, YEAR_SECS);
    let t = now(&env);
    let res = charge(&mut env, &f, &m.pubkey(), &keeper).unwrap();
    assert_eq!(events(&res), 0);
    let mb = member(&env, &f, &m.pubkey());
    assert_eq!(mb.hwm, 1_000_000_000);
    assert_eq!(mb.last_fee_at, t, "anniversary still moves");
    assert_eq!(
        token_balance(&env.svm, &share_ata(&f, &m.pubkey())),
        1_000_000_000
    );
}

#[test]
fn annual_fee_ignores_stale_higher_last_pps() {
    // The annual fee uses the fresh upper-bound pps only.
    let (mut env, cap, m, f) = whitepaper();
    let keeper = funded_user(&mut env, 0);
    let mut fund = read_fund(&env, &f);
    fund.last_price_per_share = 1_300_000;
    write_fund(&mut env, &f, &fund);
    warp(&mut env.svm, YEAR_SECS);
    // Fresh pps 1.15: the whitepaper fee (15 USDC = 13.043478 shares), not the 1.30 fee.
    charge(&mut env, &f, &m.pubkey(), &keeper).unwrap();
    assert_eq!(
        token_balance(&env.svm, &share_ata(&f, &cap.pubkey())),
        300_000_000 + 13_043_478
    );
    assert_eq!(member(&env, &f, &m.pubkey()).hwm, 1_135_000_000);
    assert_eq!(read_fund(&env, &f).last_price_per_share, 1_150_000);
}

/// The annual fee uses the slow (EMA) pps, so the keeper's choice of an
/// in-window spot price cannot raise it.
#[test]
fn annual_fee_uses_the_ema_price() {
    let (mut env, cap, m, f) = whitepaper();
    let sol = listed_sol(&mut env, 150);
    inject_holding(&mut env, &f, sol, 1_000_000_000);
    let keeper = funded_user(&mut env, 0);
    warp(&mut env.svm, YEAR_SECS);
    // SOL spot $160 +- $1, EMA $150. EMA NAV 1,495 + 150 = 1,645 for 1,300
    // shares: pps 1.265384, fee 10% of 265.384 = 26.5384. The upper bound
    // (NAV 1,656, pps 1.273846) would charge 27.3846.
    sol_price(&mut env, &sol, 160, 100, 150);
    let res = charge(&mut env, &f, &m.pubkey(), &keeper).unwrap();
    let ev = decode_events::<FeeCharged>(&res);
    assert_eq!(
        (ev[0].fee_usdc, ev[0].price_per_share),
        (26_538_400, 1_265_384)
    );
    // 26.5384 USDC at 1.265384 = 20.972605 shares.
    assert_eq!(
        token_balance(&env.svm, &share_ata(&f, &cap.pubkey())),
        300_000_000 + 20_972_605
    );
    assert_eq!(read_fund(&env, &f).last_price_per_share, 1_265_384);
}

#[test]
fn annual_fee_rejects_captain() {
    let (mut env, cap, _m, f) = whitepaper();
    let keeper = funded_user(&mut env, 0);
    warp(&mut env.svm, YEAR_SECS);
    expect_err(
        charge(&mut env, &f, &cap.pubkey(), &keeper),
        ErrorCode::Unauthorized,
    );
}

#[test]
fn annual_fee_requires_fresh_valid_prices() {
    let (mut env, _cap, m, f) = whitepaper();
    let keeper = funded_user(&mut env, 0);
    // Add a SOL holding, then leave its price account unwritten at a stale time.
    let sol = listed_sol(&mut env, 150);
    inject_holding(&mut env, &f, sol, 1_000_000_000);
    warp(&mut env.svm, YEAR_SECS);
    let ix = ix_fee(&env, &f, &m.pubkey(), &keeper.pubkey());
    assert!(
        send(&mut env.svm, &[ix], &[&keeper]).is_err(),
        "stale price"
    );
    // No NAV accounts at all.
    let mut ix = ix_fee(&env, &f, &m.pubkey(), &keeper.pubkey());
    ix.accounts.truncate(9);
    assert!(send(&mut env.svm, &[ix], &[&keeper]).is_err());
    assert_eq!(
        member(&env, &f, &m.pubkey()).hwm,
        1_000_000_000,
        "nothing charged"
    );
}

#[test]
fn captain_log_emits_hash() {
    let (mut env, cap, _m, f) = fund_with_member();
    let hash = [7u8; 32];
    let ix = ix_log(&f, &cap.pubkey(), None, hash);
    let res = send(&mut env.svm, &[ix], &[&cap]).unwrap();
    let ev = decode_events::<CaptainLog>(&res);
    assert_eq!(ev.len(), 1, "one CaptainLog event in the logs");
    assert_eq!(ev[0].reason_hash, hash);
    assert_eq!(ev[0].fund, f.fund);
    assert_eq!(ev[0].signer, cap.pubkey());
    assert_eq!(ev[0].slot, env.svm.get_sysvar::<Clock>().slot);
}

#[test]
fn captain_log_accepts_delegate_of_this_fund() {
    let (mut env, cap, _m, f) = fund_with_member();
    let d = funded_user(&mut env, 0);
    let add = ix_add_delegate(&cap.pubkey(), &f, &d.pubkey(), 1, 1);
    send(&mut env.svm, &[add], &[&cap]).unwrap();
    let ix = ix_log(
        &f,
        &d.pubkey(),
        Some(delegate_pda(&f.fund, &d.pubkey())),
        [9u8; 32],
    );
    let res = send(&mut env.svm, &[ix], &[&d]).unwrap();
    assert_eq!(decode_events::<CaptainLog>(&res)[0].reason_hash, [9u8; 32]);
}

#[test]
fn captain_log_rejects_stranger() {
    let (mut env, cap, _m, f) = fund_with_member();
    let s = funded_user(&mut env, 0);
    let d = funded_user(&mut env, 0);
    let add = ix_add_delegate(&cap.pubkey(), &f, &d.pubkey(), 1, 1);
    send(&mut env.svm, &[add], &[&cap]).unwrap();
    // No delegate account.
    let ix = ix_log(&f, &s.pubkey(), None, [1u8; 32]);
    expect_err(send(&mut env.svm, &[ix], &[&s]), ErrorCode::Unauthorized);
    // Someone else's delegate account.
    let ix = ix_log(
        &f,
        &s.pubkey(),
        Some(delegate_pda(&f.fund, &d.pubkey())),
        [1u8; 32],
    );
    expect_err(send(&mut env.svm, &[ix], &[&s]), ErrorCode::Unauthorized);
}

#[test]
fn captain_log_rejects_delegate_of_other_fund() {
    let (mut env, cap, _m, f) = fund_with_member();
    let cap2 = funded_user(&mut env, 1_000_000_000);
    let f2 = create_fund(&mut env, &cap2, 2, 300_000_000).unwrap();
    let d = funded_user(&mut env, 0);
    let add = ix_add_delegate(&cap2.pubkey(), &f2, &d.pubkey(), 1, 1);
    send(&mut env.svm, &[add], &[&cap2]).unwrap();
    let _ = cap;
    let ix = ix_log(
        &f,
        &d.pubkey(),
        Some(delegate_pda(&f2.fund, &d.pubkey())),
        [1u8; 32],
    );
    assert!(send(&mut env.svm, &[ix], &[&d]).is_err());
}
