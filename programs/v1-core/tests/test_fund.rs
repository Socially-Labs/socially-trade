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
