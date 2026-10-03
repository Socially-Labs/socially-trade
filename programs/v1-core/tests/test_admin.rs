mod common;
use common::*;

#[test]
fn config_initialized() {
    let env = setup();
    let cfg: v1_core::state::Config = read_account(&env.svm, &config_pda());
    assert_eq!(cfg.admin, env.admin.pubkey());
    assert_eq!(cfg.usdc_mint, env.usdc);
    assert!(!cfg.paused);
    assert!(cfg.venues.iter().all(|v| *v == Pubkey::default()));
    assert_eq!(cfg.pending_venue, Pubkey::default());
    assert_eq!(cfg.pending_venue_eta, 0);
    assert_eq!(
        cfg.bump,
        Pubkey::find_program_address(&[b"config"], &v1_core::ID).1
    );
}

#[test]
fn config_cannot_init_twice() {
    let mut env = setup();
    assert!(send(
        &mut env.svm,
        &[ix_initialize_config(&env.admin.pubkey(), env.usdc)],
        &[&env.admin]
    )
    .is_err());
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
