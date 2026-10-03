mod common;
use common::*;

#[test]
fn config_initialized() {
    let env = setup();
    let cfg = read_config(&env);
    assert_eq!(cfg.admin, env.admin.pubkey());
    assert_eq!(cfg.usdc_mint, env.usdc);
    assert!(!cfg.paused);
    assert_eq!(
        cfg.bump,
        Pubkey::find_program_address(&[CONFIG_SEED], &v1_core::ID).1
    );
}

#[test]
fn config_cannot_init_twice() {
    let mut env = setup();
    let ix = ix_initialize_config(&env.admin.pubkey(), env.usdc);
    expect_log(send(&mut env.svm, &[ix], &[&env.admin]), "already in use");
}

#[test]
fn harness_warp_advances_clock() {
    let mut env = setup();
    let before: Clock = env.svm.get_sysvar();
    warp(&mut env.svm, 3_600);
    let after: Clock = env.svm.get_sysvar();
    assert_eq!(after.unix_timestamp, before.unix_timestamp + 3_600);
    assert!(after.slot > before.slot);
}

#[test]
fn initialize_config_rejects_non_upgrade_authority() {
    let mut env = setup_bare();
    let other = funded(&mut env.svm);
    let ix = ix_initialize_config(&other.pubkey(), env.usdc);
    expect_err(
        send(&mut env.svm, &[ix], &[&other]),
        ErrorCode::Unauthorized,
    );
    // The real upgrade authority still can.
    let ix = ix_initialize_config(&env.admin.pubkey(), env.usdc);
    send(&mut env.svm, &[ix], &[&env.admin]).unwrap();
}

#[test]
fn initialize_config_rejects_frozen_program() {
    let mut env = setup_bare();
    set_upgrade_authority(&mut env.svm, &v1_core::ID, None);
    let ix = ix_initialize_config(&env.admin.pubkey(), env.usdc);
    expect_err(
        send(&mut env.svm, &[ix], &[&env.admin]),
        ErrorCode::Unauthorized,
    );
}

#[test]
fn initialize_config_rejects_foreign_program_data() {
    // An attacker owns another program and passes its ProgramData.
    let mut env = setup_bare();
    let other = funded(&mut env.svm);
    set_upgrade_authority(&mut env.svm, &mock_venue::ID, Some(other.pubkey()));
    let ix = ix_initialize_config_with(
        &other.pubkey(),
        env.usdc,
        program_data_address(&mock_venue::ID),
    );
    expect_anchor_err(
        send(&mut env.svm, &[ix], &[&other]),
        anchor_lang::error::ErrorCode::ConstraintRaw,
    );
}

#[test]
fn initialize_config_rejects_non_6dp_usdc() {
    let mut env = setup_bare();
    let bad = create_mint(&mut env, 9);
    let ix = ix_initialize_config(&env.admin.pubkey(), bad);
    expect_anchor_err(
        send(&mut env.svm, &[ix], &[&env.admin]),
        anchor_lang::error::ErrorCode::ConstraintRaw,
    );
}

#[test]
fn token_apply_waits_7_days() {
    let mut env = setup();
    let sol = create_mint(&mut env, 9);
    send(
        &mut env.svm,
        &[ix_queue_token(
            &env.admin.pubkey(),
            sol,
            SOL_FEED,
            Tier::T1,
            9,
        )],
        &[&env.admin],
    )
    .unwrap();
    let e: TokenEntry = read_account(&env.svm, &token_pda(&sol));
    assert!(!e.active);
    assert_eq!(e.mint, sol);
    assert_eq!(e.decimals, 9);
    expect_err(
        send(&mut env.svm, &[ix_apply_token(sol)], &[&env.admin]),
        ErrorCode::TimelockNotElapsed,
    );
    warp(&mut env.svm, ADMIN_TIMELOCK_SECS - 1);
    expect_err(
        send(&mut env.svm, &[ix_apply_token(sol)], &[&env.admin]),
        ErrorCode::TimelockNotElapsed,
    );
    warp(&mut env.svm, 1);
    // Anyone can apply.
    let anyone = funded(&mut env.svm);
    send(&mut env.svm, &[ix_apply_token(sol)], &[&anyone]).unwrap();
    let e: TokenEntry = read_account(&env.svm, &token_pda(&sol));
    assert!(e.active);
    assert_eq!(e.feed_id, SOL_FEED);
    assert_eq!(e.tier, Tier::T1);
    assert_eq!(e.pending_eta, 0);
    expect_err(
        send(&mut env.svm, &[ix_apply_token(sol)], &[&env.admin]),
        ErrorCode::NothingPending,
    );
}

#[test]
fn token_requeue_keeps_live_entry_until_apply() {
    let mut env = setup();
    let bonk = create_mint(&mut env, 5);
    register_token(&mut env, bonk, BONK_FEED, Tier::T2);
    send(
        &mut env.svm,
        &[ix_queue_token(
            &env.admin.pubkey(),
            bonk,
            USDC_FEED,
            Tier::T1,
            5,
        )],
        &[&env.admin],
    )
    .unwrap();
    let e: TokenEntry = read_account(&env.svm, &token_pda(&bonk));
    assert!(e.active);
    assert_eq!(e.feed_id, BONK_FEED);
    assert_eq!(e.tier, Tier::T2);
    warp(&mut env.svm, ADMIN_TIMELOCK_SECS);
    send(&mut env.svm, &[ix_apply_token(bonk)], &[&env.admin]).unwrap();
    let e: TokenEntry = read_account(&env.svm, &token_pda(&bonk));
    assert_eq!(e.feed_id, USDC_FEED);
    assert_eq!(e.tier, Tier::T1);
}

#[test]
fn token_queue_rejects_non_admin() {
    let mut env = setup();
    let sol = create_mint(&mut env, 9);
    let other = funded(&mut env.svm);
    let ix = ix_queue_token(&other.pubkey(), sol, SOL_FEED, Tier::T1, 9);
    expect_err(
        send(&mut env.svm, &[ix], &[&other]),
        ErrorCode::Unauthorized,
    );
}

#[test]
fn token_queue_rejects_wrong_decimals() {
    let mut env = setup();
    let sol = create_mint(&mut env, 9);
    expect_anchor_err(
        send(
            &mut env.svm,
            &[ix_queue_token(
                &env.admin.pubkey(),
                sol,
                SOL_FEED,
                Tier::T1,
                6,
            )],
            &[&env.admin],
        ),
        anchor_lang::error::ErrorCode::ConstraintRaw,
    );
}

#[test]
fn venue_apply_waits_7_days_and_activates() {
    let mut env = setup();
    let id = mock_venue::ID;
    // Nothing is queued yet: no entry account.
    assert!(env.svm.get_account(&venue_pda(&id)).is_none());
    let start = now(&env);
    send(
        &mut env.svm,
        &[ix_queue_venue(&env.admin.pubkey(), id, true)],
        &[&env.admin],
    )
    .unwrap();
    let e = read_venue(&env, &id);
    assert_eq!(e.program, id);
    assert!(!e.active);
    assert!(e.pending_active);
    assert_eq!(e.pending_eta, start + ADMIN_TIMELOCK_SECS);
    assert_eq!(
        e.bump,
        Pubkey::find_program_address(&[VENUE_SEED, id.as_ref()], &v1_core::ID).1
    );
    // One second before the ETA: too early.
    warp(&mut env.svm, ADMIN_TIMELOCK_SECS - 1);
    expect_err(
        send(&mut env.svm, &[ix_apply_venue(id)], &[&env.admin]),
        ErrorCode::TimelockNotElapsed,
    );
    // At the ETA: anyone applies.
    warp(&mut env.svm, 1);
    let anyone = funded(&mut env.svm);
    send(&mut env.svm, &[ix_apply_venue(id)], &[&anyone]).unwrap();
    let e = read_venue(&env, &id);
    assert!(e.active);
    assert_eq!(e.pending_eta, 0);
    expect_err(
        send(&mut env.svm, &[ix_apply_venue(id)], &[&env.admin]),
        ErrorCode::NothingPending,
    );
}

#[test]
fn venue_requeue_overwrites_and_restarts_clock() {
    let mut env = setup();
    let id = Pubkey::new_unique();
    send(
        &mut env.svm,
        &[ix_queue_venue(&env.admin.pubkey(), id, true)],
        &[&env.admin],
    )
    .unwrap();
    warp(&mut env.svm, ADMIN_TIMELOCK_SECS - 10);
    send(
        &mut env.svm,
        &[ix_queue_venue(&env.admin.pubkey(), id, false)],
        &[&env.admin],
    )
    .unwrap();
    warp(&mut env.svm, 10);
    expect_err(
        send(&mut env.svm, &[ix_apply_venue(id)], &[&env.admin]),
        ErrorCode::TimelockNotElapsed,
    );
    warp(&mut env.svm, ADMIN_TIMELOCK_SECS);
    send(&mut env.svm, &[ix_apply_venue(id)], &[&env.admin]).unwrap();
    // The second queue (a removal) won.
    assert!(!read_venue(&env, &id).active);
}

#[test]
fn venue_removal_is_timelocked_and_admin_only() {
    let mut env = setup();
    let id = mock_venue::ID;
    register_venue(&mut env, id);
    // Non-admin.
    let other = funded(&mut env.svm);
    expect_err(
        send(
            &mut env.svm,
            &[ix_queue_venue(&other.pubkey(), id, false)],
            &[&other],
        ),
        ErrorCode::Unauthorized,
    );
    send(
        &mut env.svm,
        &[ix_queue_venue(&env.admin.pubkey(), id, false)],
        &[&env.admin],
    )
    .unwrap();
    // The venue stays active until the removal is applied.
    let e = read_venue(&env, &id);
    assert!(e.active && !e.pending_active);
    warp(&mut env.svm, ADMIN_TIMELOCK_SECS - 1);
    expect_err(
        send(&mut env.svm, &[ix_apply_venue(id)], &[&env.admin]),
        ErrorCode::TimelockNotElapsed,
    );
    assert!(read_venue(&env, &id).active);
    warp(&mut env.svm, 1);
    send(&mut env.svm, &[ix_apply_venue(id)], &[&env.admin]).unwrap();
    assert!(!read_venue(&env, &id).active);
}

#[test]
fn more_than_four_venues_active_at_once() {
    let mut env = setup();
    let ids: Vec<Pubkey> = (0..6).map(|_| Pubkey::new_unique()).collect();
    for id in &ids {
        send(
            &mut env.svm,
            &[ix_queue_venue(&env.admin.pubkey(), *id, true)],
            &[&env.admin],
        )
        .unwrap();
    }
    warp(&mut env.svm, ADMIN_TIMELOCK_SECS);
    for id in &ids {
        send(&mut env.svm, &[ix_apply_venue(*id)], &[&env.admin]).unwrap();
    }
    for id in &ids {
        let e = read_venue(&env, id);
        assert!(e.active && e.program == *id);
    }
}

#[test]
fn pause_is_immediate_and_admin_only() {
    let mut env = setup();
    send(
        &mut env.svm,
        &[ix_set_paused(&env.admin.pubkey(), true)],
        &[&env.admin],
    )
    .unwrap();
    assert!(read_config(&env).paused);
    let other = funded(&mut env.svm);
    expect_err(
        send(
            &mut env.svm,
            &[ix_set_paused(&other.pubkey(), false)],
            &[&other],
        ),
        ErrorCode::Unauthorized,
    );
    assert!(read_config(&env).paused);
    send(
        &mut env.svm,
        &[ix_set_paused(&env.admin.pubkey(), false)],
        &[&env.admin],
    )
    .unwrap();
    assert!(!read_config(&env).paused);
}

#[allow(clippy::result_large_err)] // LiteSVM's own error type.
fn queue(
    env: &mut Env,
    mint: Pubkey,
    decimals: u8,
) -> Result<TransactionMetadata, FailedTransactionMetadata> {
    let ix = ix_queue_token(&env.admin.pubkey(), mint, SOL_FEED, Tier::T1, decimals);
    send(&mut env.svm, &[ix], &[&env.admin])
}

#[test]
fn token_queue_rejects_freeze_authority() {
    let mut env = setup();
    let admin = env.admin.pubkey();
    let spl = spl_token_interface::ID;
    let mint = write_mint_with_freeze(&mut env.svm, &admin, 9, &spl, Some(admin));
    expect_err(queue(&mut env, mint, 9), ErrorCode::UnsafeMint);
}

#[test]
fn token_queue_rejects_token_2022_extension() {
    let mut env = setup();
    let admin = env.admin.pubkey();
    let mint = write_t22_mint_with_extension(&mut env.svm, &admin, 9);
    expect_err(queue(&mut env, mint, 9), ErrorCode::UnsafeMint);
}

#[test]
fn token_queue_accepts_plain_mints() {
    let mut env = setup();
    let admin = env.admin.pubkey();
    let spl = create_mint(&mut env, 9);
    queue(&mut env, spl, 9).unwrap();
    let t22 = anchor_spl::token_2022::ID;
    let plain_t22 = write_mint(&mut env.svm, &admin, 6, &t22);
    queue(&mut env, plain_t22, 6).unwrap();
}
