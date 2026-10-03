//! LiteSVM test harness shared by every integration test.
//!
//! Build the programs first (`scripts/build-programs.sh`): the tests load
//! `target/deploy/*.so` at compile time.

#![allow(dead_code)]

use {
    anchor_lang::solana_program::bpf_loader_upgradeable,
    solana_instruction_error::InstructionError, solana_program_pack::Pack,
    solana_transaction_error::TransactionError, spl_token_interface::state::Mint as SplMint,
};
pub use {
    anchor_lang::{prelude::Pubkey, AccountDeserialize, InstructionData, ToAccountMetas},
    litesvm::{
        types::{FailedTransactionMetadata, TransactionMetadata},
        LiteSVM,
    },
    solana_account::Account,
    solana_clock::Clock,
    solana_instruction::Instruction,
    solana_keypair::Keypair,
    solana_signer::Signer,
    solana_transaction::Transaction,
    v1_core::{
        constants::*,
        errors::ErrorCode,
        state::{Config, Tier, TokenEntry},
    },
};

pub const AIRDROP_LAMPORTS: u64 = 100_000_000_000;

pub struct Env {
    pub svm: LiteSVM,
    pub admin: Keypair,
    pub usdc: Pubkey,
}

/// Arbitrary distinct Pyth feed ids for tests.
pub const USDC_FEED: [u8; 32] = [1; 32];
pub const SOL_FEED: [u8; 32] = [2; 32];
pub const BONK_FEED: [u8; 32] = [3; 32];

/// `setup_bare()` plus `initialize_config` sent by the admin.
pub fn setup() -> Env {
    let mut env = setup_bare();
    let ix = ix_initialize_config(&env.admin.pubkey(), env.usdc);
    send(&mut env.svm, &[ix], &[&env.admin]).expect("initialize_config");
    env
}

/// A LiteSVM with both programs loaded under the upgradeable loader, a funded
/// admin that is the v1-core upgrade authority, and a USDC mint (SPL Token,
/// 6 dp, admin is mint authority). The config is NOT initialized.
pub fn setup_bare() -> Env {
    // LiteSVM::new() already loads SPL Token, Token-2022 and the ATA program.
    // add_program uses BPFLoaderUpgradeable and writes a ProgramData account.
    let mut svm = LiteSVM::new();
    svm.add_program(
        v1_core::ID,
        include_bytes!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../target/deploy/v1_core.so"
        )),
    )
    .unwrap();
    svm.add_program(
        mock_venue_id(),
        include_bytes!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../target/deploy/mock_venue.so"
        )),
    )
    .unwrap();

    let admin = funded(&mut svm);
    set_upgrade_authority(&mut svm, &v1_core::ID, Some(admin.pubkey()));
    let usdc = write_mint(
        &mut svm,
        &admin.pubkey(),
        USDC_DECIMALS,
        &spl_token_interface::ID,
    );
    Env { svm, admin, usdc }
}

/// The ProgramData address of an upgradeable program.
pub fn program_data_address(program_id: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[program_id.as_ref()], &bpf_loader_upgradeable::ID).0
}

/// Overwrite the upgrade authority in a program's ProgramData account.
/// Layout (bincode): u32 variant tag = 3, u64 slot, Option<Pubkey> (1-byte tag + 32 bytes).
pub fn set_upgrade_authority(svm: &mut LiteSVM, program_id: &Pubkey, authority: Option<Pubkey>) {
    let address = program_data_address(program_id);
    let mut account = svm.get_account(&address).expect("ProgramData account");
    assert_eq!(
        account.data[..4],
        3u32.to_le_bytes(),
        "not a ProgramData account"
    );
    match authority {
        Some(key) => {
            account.data[12] = 1;
            account.data[13..45].copy_from_slice(key.as_ref());
        }
        None => account.data[12..45].fill(0),
    }
    svm.set_account(address, account).unwrap();
}

/// The mock venue id. Not a dev-dependency, so the id lives here; it must
/// match `declare_id!` in programs/mock-venue/src/lib.rs.
pub fn mock_venue_id() -> Pubkey {
    Pubkey::from_str_const("7wy5kqiVEWLHgmoccpe1DUD5vFA6tm68CM3hWiMcY1ng")
}

// ---------------------------------------------------------------------------
// Transactions, clock, errors
// ---------------------------------------------------------------------------

/// Send one legacy transaction. `signers[0]` pays the fee.
#[allow(clippy::result_large_err)] // LiteSVM's own error type.
pub fn send(
    svm: &mut LiteSVM,
    ixs: &[Instruction],
    signers: &[&Keypair],
) -> Result<TransactionMetadata, FailedTransactionMetadata> {
    // A new blockhash on each send, so a test can send the same instruction twice.
    svm.expire_blockhash();
    let tx = Transaction::new_signed_with_payer(
        ixs,
        Some(&signers[0].pubkey()),
        signers,
        svm.latest_blockhash(),
    );
    svm.send_transaction(tx)
}

/// Move `Clock.unix_timestamp` by `secs` and the slot forward by at least one.
pub fn warp(svm: &mut LiteSVM, secs: i64) {
    let mut clock: Clock = svm.get_sysvar();
    clock.unix_timestamp += secs;
    clock.slot += secs.unsigned_abs().max(1);
    svm.set_sysvar(&clock);
    svm.expire_blockhash();
}

/// The custom program error code of a failed transaction, if it has one.
pub fn custom_code(err: &FailedTransactionMetadata) -> Option<u32> {
    match &err.err {
        TransactionError::InstructionError(_, InstructionError::Custom(code)) => Some(*code),
        _ => None,
    }
}

/// Assert that `res` failed with the v1-core error `code` (Anchor offsets by 6000).
#[track_caller]
pub fn expect_err<T: std::fmt::Debug>(res: Result<T, FailedTransactionMetadata>, code: ErrorCode) {
    expect_code(res, 6000 + code as u32);
}

/// Assert that `res` failed with the Anchor framework error `code` (e.g. ConstraintRaw).
#[track_caller]
pub fn expect_anchor_err<T: std::fmt::Debug>(
    res: Result<T, FailedTransactionMetadata>,
    code: anchor_lang::error::ErrorCode,
) {
    expect_code(res, code as u32);
}

/// Assert that `res` failed with custom program error `want`.
#[track_caller]
pub fn expect_code<T: std::fmt::Debug>(res: Result<T, FailedTransactionMetadata>, want: u32) {
    let err = res.expect_err("expected the transaction to fail");
    assert_eq!(
        custom_code(&err),
        Some(want),
        "got {:?}, want custom error {want}\nlogs: {:#?}",
        err.err,
        err.meta.logs
    );
}

/// Assert that `res` failed and some log line contains `needle`.
#[track_caller]
pub fn expect_log<T: std::fmt::Debug>(res: Result<T, FailedTransactionMetadata>, needle: &str) {
    let err = res.expect_err("expected the transaction to fail");
    assert!(
        err.meta.logs.iter().any(|l| l.contains(needle)),
        "no log contains {needle:?}; err {:?}\nlogs: {:#?}",
        err.err,
        err.meta.logs
    );
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

/// Deserialize an Anchor account (discriminator checked). Panics if missing.
#[track_caller]
pub fn read_account<T: AccountDeserialize>(svm: &LiteSVM, address: &Pubkey) -> T {
    let account = svm
        .get_account(address)
        .unwrap_or_else(|| panic!("account {address} not found"));
    T::try_deserialize(&mut account.data.as_slice()).expect("deserialize account")
}

pub fn funded(svm: &mut LiteSVM) -> Keypair {
    let key = Keypair::new();
    svm.airdrop(&key.pubkey(), AIRDROP_LAMPORTS).unwrap();
    key
}

/// A new SPL Token mint with `decimals`, admin is mint authority.
pub fn create_mint(env: &mut Env, decimals: u8) -> Pubkey {
    write_mint(
        &mut env.svm,
        &env.admin.pubkey(),
        decimals,
        &spl_token_interface::ID,
    )
}

/// Write an initialized mint straight into the SVM, owned by `token_program`
/// (SPL Token or Token-2022; a base mint has the same layout in both).
pub fn write_mint(
    svm: &mut LiteSVM,
    authority: &Pubkey,
    decimals: u8,
    token_program: &Pubkey,
) -> Pubkey {
    let mint = Pubkey::new_unique();
    let mut data = vec![0u8; SplMint::LEN];
    SplMint {
        mint_authority: Some(*authority).into(),
        supply: 0,
        decimals,
        is_initialized: true,
        freeze_authority: None.into(),
    }
    .pack_into_slice(&mut data);
    let lamports = svm.minimum_balance_for_rent_exemption(data.len());
    svm.set_account(
        mint,
        Account {
            lamports,
            data,
            owner: *token_program,
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();
    mint
}

// ---------------------------------------------------------------------------
// PDAs (seeds from programs/v1-core/src/state)
// ---------------------------------------------------------------------------

pub fn pda(seeds: &[&[u8]]) -> Pubkey {
    Pubkey::find_program_address(seeds, &v1_core::ID).0
}
pub fn config_pda() -> Pubkey {
    pda(&[CONFIG_SEED])
}
pub fn token_pda(mint: &Pubkey) -> Pubkey {
    pda(&[TOKEN_SEED, mint.as_ref()])
}
pub fn fund_pda(captain: &Pubkey, fund_id: u64) -> Pubkey {
    pda(&[FUND_SEED, captain.as_ref(), &fund_id.to_le_bytes()])
}
pub fn share_mint_pda(fund: &Pubkey) -> Pubkey {
    pda(&[SHARES_SEED, fund.as_ref()])
}
pub fn member_pda(fund: &Pubkey, owner: &Pubkey) -> Pubkey {
    pda(&[MEMBER_SEED, fund.as_ref(), owner.as_ref()])
}
pub fn delegate_pda(fund: &Pubkey, key: &Pubkey) -> Pubkey {
    pda(&[DELEGATE_SEED, fund.as_ref(), key.as_ref()])
}
pub fn policy_pda(fund: &Pubkey) -> Pubkey {
    pda(&[POLICY_SEED, fund.as_ref()])
}
pub fn proposal_pda(fund: &Pubkey, id: u64) -> Pubkey {
    pda(&[PROPOSAL_SEED, fund.as_ref(), &id.to_le_bytes()])
}
pub fn vote_pda(proposal: &Pubkey, voter: &Pubkey) -> Pubkey {
    pda(&[VOTE_SEED, proposal.as_ref(), voter.as_ref()])
}

// ---------------------------------------------------------------------------
// Instruction builders
// ---------------------------------------------------------------------------

/// Build a v1-core instruction from its Anchor `accounts` and `instruction` structs.
pub fn v1_ix(accounts: impl ToAccountMetas, data: impl InstructionData) -> Instruction {
    Instruction {
        program_id: v1_core::ID,
        accounts: accounts.to_account_metas(None),
        data: data.data(),
    }
}

pub fn ix_initialize_config(admin: &Pubkey, usdc_mint: Pubkey) -> Instruction {
    ix_initialize_config_with(admin, usdc_mint, program_data_address(&v1_core::ID))
}

/// `initialize_config` with an explicit ProgramData account (for negative tests).
pub fn ix_initialize_config_with(
    admin: &Pubkey,
    usdc_mint: Pubkey,
    program_data: Pubkey,
) -> Instruction {
    v1_ix(
        v1_core::accounts::InitializeConfig {
            admin: *admin,
            config: config_pda(),
            usdc_mint,
            program: v1_core::ID,
            program_data,
            system_program: anchor_lang::system_program::ID,
        },
        v1_core::instruction::InitializeConfig {},
    )
}

pub fn ix_queue_token(
    admin: &Pubkey,
    mint: Pubkey,
    feed_id: [u8; 32],
    tier: Tier,
    decimals: u8,
) -> Instruction {
    v1_ix(
        v1_core::accounts::QueueToken {
            admin: *admin,
            config: config_pda(),
            mint,
            token_entry: token_pda(&mint),
            system_program: anchor_lang::system_program::ID,
        },
        v1_core::instruction::QueueToken {
            feed_id,
            tier,
            decimals,
        },
    )
}

/// Permissionless: no signer account.
pub fn ix_apply_token(mint: Pubkey) -> Instruction {
    v1_ix(
        v1_core::accounts::ApplyToken {
            token_entry: token_pda(&mint),
        },
        v1_core::instruction::ApplyToken {},
    )
}

pub fn ix_queue_venue(admin: &Pubkey, slot: u8, venue: Pubkey) -> Instruction {
    v1_ix(
        v1_core::accounts::QueueVenue {
            admin: *admin,
            config: config_pda(),
        },
        v1_core::instruction::QueueVenue { slot, venue },
    )
}

/// Permissionless: no signer account.
pub fn ix_apply_venue() -> Instruction {
    v1_ix(
        v1_core::accounts::ApplyVenue {
            config: config_pda(),
        },
        v1_core::instruction::ApplyVenue {},
    )
}

pub fn ix_set_paused(admin: &Pubkey, paused: bool) -> Instruction {
    v1_ix(
        v1_core::accounts::SetPaused {
            admin: *admin,
            config: config_pda(),
        },
        v1_core::instruction::SetPaused { paused },
    )
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/// List `mint` (queue, wait out the timelock, apply). Decimals come from the mint.
pub fn register_token(env: &mut Env, mint: Pubkey, feed_id: [u8; 32], tier: Tier) {
    let data = env.svm.get_account(&mint).expect("mint account").data;
    let decimals = SplMint::unpack_from_slice(&data).expect("mint").decimals;
    let ix = ix_queue_token(&env.admin.pubkey(), mint, feed_id, tier, decimals);
    send(&mut env.svm, &[ix], &[&env.admin]).expect("queue_token");
    warp(&mut env.svm, ADMIN_TIMELOCK_SECS);
    let ix = ix_apply_token(mint);
    send(&mut env.svm, &[ix], &[&env.admin]).expect("apply_token");
}

/// Put `venue` into `slot` (queue, wait out the timelock, apply).
pub fn register_venue(env: &mut Env, slot: u8, venue: Pubkey) {
    let ix = ix_queue_venue(&env.admin.pubkey(), slot, venue);
    send(&mut env.svm, &[ix], &[&env.admin]).expect("queue_venue");
    warp(&mut env.svm, ADMIN_TIMELOCK_SECS);
    send(&mut env.svm, &[ix_apply_venue()], &[&env.admin]).expect("apply_venue");
}

pub fn read_config(env: &Env) -> Config {
    read_account(&env.svm, &config_pda())
}
