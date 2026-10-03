//! LiteSVM test harness shared by every integration test.
//!
//! Build the programs first (`scripts/build-programs.sh`): the tests load
//! `target/deploy/*.so` at compile time.

#![allow(dead_code)]

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
};
use {
    solana_instruction_error::InstructionError, solana_program_pack::Pack,
    solana_transaction_error::TransactionError, spl_token_interface::state::Mint as SplMint,
};

pub const USDC_DECIMALS: u8 = 6;
pub const AIRDROP_LAMPORTS: u64 = 100_000_000_000;

pub struct Env {
    pub svm: LiteSVM,
    pub admin: Keypair,
    pub usdc: Pubkey,
}

/// A LiteSVM with both programs loaded, a USDC mint (SPL Token, 6 dp, admin is
/// mint authority), a funded admin, and the config initialized.
pub fn setup() -> Env {
    // LiteSVM::new() already loads SPL Token, Token-2022 and the ATA program.
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
    let usdc = create_mint(
        &mut svm,
        &admin.pubkey(),
        USDC_DECIMALS,
        &spl_token_interface::ID,
    );
    send(
        &mut svm,
        &[ix_initialize_config(&admin.pubkey(), usdc)],
        &[&admin],
    )
    .expect("initialize_config");
    Env { svm, admin, usdc }
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
pub fn expect_err<T: std::fmt::Debug>(
    res: Result<T, FailedTransactionMetadata>,
    code: v1_core::errors::ErrorCode,
) {
    let err = res.expect_err("expected the transaction to fail");
    let want = 6000 + code as u32;
    assert_eq!(
        custom_code(&err),
        Some(want),
        "got {:?}, want custom error {want}\nlogs: {:#?}",
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

/// Write an initialized mint straight into the SVM, owned by `token_program`
/// (SPL Token or Token-2022; a base mint has the same layout in both).
pub fn create_mint(
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
    pda(&[b"config"])
}
pub fn token_entry_pda(mint: &Pubkey) -> Pubkey {
    pda(&[b"token", mint.as_ref()])
}
pub fn fund_pda(captain: &Pubkey, fund_id: u64) -> Pubkey {
    pda(&[b"fund", captain.as_ref(), &fund_id.to_le_bytes()])
}
pub fn share_mint_pda(fund: &Pubkey) -> Pubkey {
    pda(&[b"shares", fund.as_ref()])
}
pub fn member_pda(fund: &Pubkey, owner: &Pubkey) -> Pubkey {
    pda(&[b"member", fund.as_ref(), owner.as_ref()])
}
pub fn delegate_pda(fund: &Pubkey, key: &Pubkey) -> Pubkey {
    pda(&[b"delegate", fund.as_ref(), key.as_ref()])
}
pub fn policy_pda(fund: &Pubkey) -> Pubkey {
    pda(&[b"policy", fund.as_ref()])
}
pub fn proposal_pda(fund: &Pubkey, id: u64) -> Pubkey {
    pda(&[b"proposal", fund.as_ref(), &id.to_le_bytes()])
}
pub fn vote_pda(proposal: &Pubkey, voter: &Pubkey) -> Pubkey {
    pda(&[b"vote", proposal.as_ref(), voter.as_ref()])
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
    v1_ix(
        v1_core::accounts::InitializeConfig {
            admin: *admin,
            config: config_pda(),
            system_program: anchor_lang::system_program::ID,
        },
        v1_core::instruction::InitializeConfig { usdc_mint },
    )
}
