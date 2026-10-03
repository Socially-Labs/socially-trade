mod common;

use {common::*, v1_core::state::Delegate};

fn delegate(env: &Env, f: &FundHandles, key: &Pubkey) -> Delegate {
    read_account(&env.svm, &delegate_pda(&f.fund, key))
}

#[test]
fn add_delegate_captain_only() {
    let (mut env, cap, m, f) = fund_with_member();
    let key = Keypair::new().pubkey();
    // A member (not the captain) cannot add.
    let ix = ix_add_delegate(&m.pubkey(), &f, &key, 100, 1000);
    expect_err(send(&mut env.svm, &[ix], &[&m]), ErrorCode::Unauthorized);
    assert!(env.svm.get_account(&delegate_pda(&f.fund, &key)).is_none());

    let ix = ix_add_delegate(&cap.pubkey(), &f, &key, 100, 1000);
    send(&mut env.svm, &[ix], &[&cap]).unwrap();
    let d = delegate(&env, &f, &key);
    assert_eq!((d.fund, d.key), (f.fund, key));
    assert_eq!((d.max_trade_usd, d.daily_volume_usd), (100, 1000));
    assert_eq!((d.day_start, d.day_volume), (0, 0));

    // Same key twice fails.
    let ix = ix_add_delegate(&cap.pubkey(), &f, &key, 1, 1);
    expect_log(send(&mut env.svm, &[ix], &[&cap]), "already in use");
}

#[test]
fn update_delegate_captain_only() {
    let (mut env, cap, m, f) = fund_with_member();
    let key = Keypair::new().pubkey();
    send(
        &mut env.svm,
        &[ix_add_delegate(&cap.pubkey(), &f, &key, 100, 1000)],
        &[&cap],
    )
    .unwrap();
    let ix = ix_update_delegate(&m.pubkey(), &f, &key, 5, 5);
    expect_err(send(&mut env.svm, &[ix], &[&m]), ErrorCode::Unauthorized);
    let ix = ix_update_delegate(&cap.pubkey(), &f, &key, 7, 70);
    send(&mut env.svm, &[ix], &[&cap]).unwrap();
    let d = delegate(&env, &f, &key);
    assert_eq!((d.max_trade_usd, d.daily_volume_usd), (7, 70));
}

#[test]
fn revoke_closes_account() {
    let (mut env, cap, m, f) = fund_with_member();
    let key = Keypair::new().pubkey();
    let addr = delegate_pda(&f.fund, &key);
    send(
        &mut env.svm,
        &[ix_add_delegate(&cap.pubkey(), &f, &key, 100, 1000)],
        &[&cap],
    )
    .unwrap();
    let rent = env.svm.get_account(&addr).unwrap().lamports;

    let ix = ix_revoke_delegate(&m.pubkey(), &f, &key);
    expect_err(send(&mut env.svm, &[ix], &[&m]), ErrorCode::Unauthorized);
    assert!(env.svm.get_account(&addr).is_some());

    let before = env.svm.get_balance(&cap.pubkey()).unwrap();
    let ix = ix_revoke_delegate(&cap.pubkey(), &f, &key);
    let res = send(&mut env.svm, &[ix], &[&cap]).unwrap();
    assert!(env.svm.get_account(&addr).is_none_or(|a| a.lamports == 0));
    // Rent comes back to the captain (minus the 5000 lamport fee).
    let after = env.svm.get_balance(&cap.pubkey()).unwrap();
    assert_eq!(after, before + rent - 5000, "{:?}", res.logs);
}

#[test]
fn mock_venue_honest_swap_with_keypair_authority() {
    let mut env = setup();
    let user = funded_user(&mut env, 1_000_000_000);
    let sol = create_mint(&mut env, 9);
    let usdc = env.usdc;
    let pool = setup_venue_pool(&mut env, &usdc, &sol, 0, 50_000_000_000);
    let user_sol = ata(&user.pubkey(), &sol, &spl_token_interface::ID);
    let create = ix_create_ata(
        &user.pubkey(),
        &user.pubkey(),
        &sol,
        &spl_token_interface::ID,
    );
    // 100 USDC (1e8 base units) at 5 out per 1 in = 0.5 SOL (5e8 base units).
    let swap = ix_venue_swap(
        &env.svm,
        &user.pubkey(),
        &usdc_ata(&env, &user.pubkey()),
        &user_sol,
        &pool,
        &env.usdc,
        &sol,
        100_000_000,
        5,
        1,
        0,
    );
    send(&mut env.svm, &[create, swap], &[&user]).unwrap();
    assert_eq!(usdc_of_user(&env, &user), 900_000_000);
    assert_eq!(token_balance(&env.svm, &pool.pool_in), 100_000_000);
    assert_eq!(token_balance(&env.svm, &user_sol), 500_000_000);
    assert_eq!(token_balance(&env.svm, &pool.pool_out), 49_500_000_000);
}

fn usdc_of_user(env: &Env, user: &Keypair) -> u64 {
    token_balance(&env.svm, &usdc_ata(env, &user.pubkey()))
}
