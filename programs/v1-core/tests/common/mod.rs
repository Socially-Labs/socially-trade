//! LiteSVM test harness shared by every integration test.
//!
//! Build the programs first (`scripts/build-programs.sh`): the tests load
//! `target/deploy/*.so` at compile time.

#![allow(dead_code, unused_imports)] // Each test binary uses a different subset.

use {
    anchor_lang::solana_program::bpf_loader_upgradeable,
    anchor_spl::{
        associated_token::{
            get_associated_token_address_with_program_id,
            spl_associated_token_account::instruction::create_associated_token_account,
        },
        token_2022::{spl_token_2022, ID as TOKEN_2022},
    },
    solana_instruction_error::InstructionError,
    solana_program_pack::Pack,
    solana_transaction_error::TransactionError,
    spl_token_interface::state::Mint as SplMint,
};
pub use {
    anchor_lang::{prelude::Pubkey, AccountDeserialize, InstructionData, ToAccountMetas},
    litesvm::{
        types::{FailedTransactionMetadata, TransactionMetadata},
        LiteSVM,
    },
    solana_account::Account,
    solana_clock::Clock,
    solana_instruction::{AccountMeta, Instruction},
    solana_keypair::Keypair,
    solana_signer::Signer,
    solana_transaction::Transaction,
    v1_core::{
        constants::*,
        errors::ErrorCode,
        state::{Config, PriceSource, Tier, TokenEntry, VenueEntry},
    },
};

pub const AIRDROP_LAMPORTS: u64 = 100_000_000_000;
pub const TOKEN_2022_ID: Pubkey = TOKEN_2022;

pub struct Env {
    pub svm: LiteSVM,
    pub admin: Keypair,
    pub usdc: Pubkey,
}

/// Arbitrary distinct Pyth feed ids for tests.
pub const USDC_FEED: [u8; 32] = [1; 32];
pub const SOL_FEED: [u8; 32] = [2; 32];
pub const BONK_FEED: [u8; 32] = [3; 32];

/// A Pyth price source for `feed_id`.
pub fn pyth(feed_id: [u8; 32]) -> PriceSource {
    PriceSource::Pyth { feed_id }
}

/// The key the harness passes for a price slot the source does not read
/// (Pyth `price_b`). The program never reads it.
pub const UNUSED_PRICE_ACCOUNT: Pubkey = v1_core::ID;

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
        mock_venue::ID,
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
    write_mint_with_freeze(svm, authority, decimals, token_program, None)
}

/// `write_mint` with an optional freeze authority.
pub fn write_mint_with_freeze(
    svm: &mut LiteSVM,
    authority: &Pubkey,
    decimals: u8,
    token_program: &Pubkey,
    freeze_authority: Option<Pubkey>,
) -> Pubkey {
    let mut data = vec![0u8; SplMint::LEN];
    SplMint {
        mint_authority: Some(*authority).into(),
        supply: 0,
        decimals,
        is_initialized: true,
        freeze_authority: freeze_authority.into(),
    }
    .pack_into_slice(&mut data);
    write_raw_mint(svm, data, token_program)
}

/// A Token-2022 mint (admin authority, no freeze) with the NonTransferable extension.
pub fn write_t22_mint_with_extension(
    svm: &mut LiteSVM,
    authority: &Pubkey,
    decimals: u8,
) -> Pubkey {
    use spl_token_2022::{
        extension::{
            non_transferable::NonTransferable, BaseStateWithExtensionsMut, ExtensionType,
            StateWithExtensionsMut,
        },
        state::Mint,
    };
    let len = ExtensionType::try_calculate_account_len::<Mint>(&[ExtensionType::NonTransferable])
        .unwrap();
    let mut data = vec![0u8; len];
    let mut state = StateWithExtensionsMut::<Mint>::unpack_uninitialized(&mut data).unwrap();
    state.init_extension::<NonTransferable>(true).unwrap();
    state.base = Mint {
        mint_authority: Some(*authority).into(),
        supply: 0,
        decimals,
        is_initialized: true,
        freeze_authority: None.into(),
    };
    state.pack_base();
    state.init_account_type().unwrap();
    write_raw_mint(svm, data, &TOKEN_2022)
}

fn write_raw_mint(svm: &mut LiteSVM, data: Vec<u8>, token_program: &Pubkey) -> Pubkey {
    let mint = Pubkey::new_unique();
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
pub fn venue_pda(program: &Pubkey) -> Pubkey {
    pda(&[VENUE_SEED, program.as_ref()])
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
    price_source: PriceSource,
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
            price_source,
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

/// Queue `venue` to become `active` (true = approve, false = remove).
pub fn ix_queue_venue(admin: &Pubkey, venue: Pubkey, active: bool) -> Instruction {
    v1_ix(
        v1_core::accounts::QueueVenue {
            admin: *admin,
            config: config_pda(),
            venue_program: venue,
            venue_entry: venue_pda(&venue),
            system_program: anchor_lang::system_program::ID,
        },
        v1_core::instruction::QueueVenue { active },
    )
}

/// Permissionless: no signer account.
pub fn ix_apply_venue(venue: Pubkey) -> Instruction {
    v1_ix(
        v1_core::accounts::ApplyVenue {
            venue_entry: venue_pda(&venue),
        },
        v1_core::instruction::ApplyVenue {},
    )
}

pub fn read_venue(env: &Env, venue: &Pubkey) -> VenueEntry {
    read_account(&env.svm, &venue_pda(venue))
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

/// List `mint` with a Pyth source (queue, wait out the timelock, apply).
pub fn register_token(env: &mut Env, mint: Pubkey, feed_id: [u8; 32], tier: Tier) {
    register_token_with(env, mint, pyth(feed_id), tier);
}

/// List `mint` with any price source. Decimals come from the mint.
pub fn register_token_with(env: &mut Env, mint: Pubkey, source: PriceSource, tier: Tier) {
    let data = env.svm.get_account(&mint).expect("mint account").data;
    let decimals = SplMint::unpack_from_slice(&data).expect("mint").decimals;
    let ix = ix_queue_token(&env.admin.pubkey(), mint, source, tier, decimals);
    send(&mut env.svm, &[ix], &[&env.admin]).expect("queue_token");
    warp(&mut env.svm, ADMIN_TIMELOCK_SECS);
    let ix = ix_apply_token(mint);
    send(&mut env.svm, &[ix], &[&env.admin]).expect("apply_token");
}

/// Approve `venue` (queue, wait out the timelock, apply).
pub fn register_venue(env: &mut Env, venue: Pubkey) {
    set_venue(env, venue, true);
}

/// Set `venue` to `active` (queue, wait out the timelock, apply).
pub fn set_venue(env: &mut Env, venue: Pubkey, active: bool) {
    let ix = ix_queue_venue(&env.admin.pubkey(), venue, active);
    send(&mut env.svm, &[ix], &[&env.admin]).expect("queue_venue");
    warp(&mut env.svm, ADMIN_TIMELOCK_SECS);
    send(&mut env.svm, &[ix_apply_venue(venue)], &[&env.admin]).expect("apply_venue");
}

// ---------------------------------------------------------------------------
// Funds
// ---------------------------------------------------------------------------

/// The addresses of one fund.
#[derive(Debug, Clone, Copy)]
pub struct FundHandles {
    pub fund: Pubkey,
    pub share_mint: Pubkey,
    pub usdc_vault: Pubkey,
    pub policy: Pubkey,
}

impl FundHandles {
    pub fn new(captain: &Pubkey, fund_id: u64, usdc: &Pubkey) -> Self {
        let fund = fund_pda(captain, fund_id);
        Self {
            fund,
            share_mint: share_mint_pda(&fund),
            usdc_vault: ata(&fund, usdc, &spl_token_interface::ID),
            policy: policy_pda(&fund),
        }
    }
}

pub fn ata(owner: &Pubkey, mint: &Pubkey, token_program: &Pubkey) -> Pubkey {
    get_associated_token_address_with_program_id(owner, mint, token_program)
}
pub fn usdc_ata(env: &Env, owner: &Pubkey) -> Pubkey {
    ata(owner, &env.usdc, &spl_token_interface::ID)
}
/// The Token-2022 share ATA of `owner` in fund `f`.
pub fn share_ata(f: &FundHandles, owner: &Pubkey) -> Pubkey {
    ata(owner, &f.share_mint, &TOKEN_2022)
}

pub fn ix_create_ata(
    payer: &Pubkey,
    owner: &Pubkey,
    mint: &Pubkey,
    token_program: &Pubkey,
) -> Instruction {
    create_associated_token_account(payer, owner, mint, token_program)
}

/// A funded keypair with a USDC ATA holding `usdc` base units (minted by the admin).
pub fn funded_user(env: &mut Env, usdc: u64) -> Keypair {
    let user = funded(&mut env.svm);
    let token = spl_token_interface::ID;
    let create = ix_create_ata(&user.pubkey(), &user.pubkey(), &env.usdc, &token);
    let mint = spl_token_interface::instruction::mint_to(
        &token,
        &env.usdc,
        &usdc_ata(env, &user.pubkey()),
        &env.admin.pubkey(),
        &[],
        usdc,
    )
    .unwrap();
    send(&mut env.svm, &[create, mint], &[&user, &env.admin]).expect("funded_user");
    user
}

pub fn ix_create_fund(env: &Env, captain: &Pubkey, fund_id: u64, deposit: u64) -> Instruction {
    ix_create_fund_with(captain, fund_id, deposit, env.usdc)
}

/// `create_fund` with an explicit USDC mint (for negative tests). Not Open Seas.
pub fn ix_create_fund_with(
    captain: &Pubkey,
    fund_id: u64,
    deposit: u64,
    usdc_mint: Pubkey,
) -> Instruction {
    ix_create_fund_full(captain, fund_id, deposit, usdc_mint, false)
}

/// `create_fund` with every argument.
pub fn ix_create_fund_full(
    captain: &Pubkey,
    fund_id: u64,
    deposit: u64,
    usdc_mint: Pubkey,
    open_seas: bool,
) -> Instruction {
    let f = FundHandles::new(captain, fund_id, &usdc_mint);
    v1_ix(
        v1_core::accounts::CreateFund {
            captain: *captain,
            config: config_pda(),
            fund: f.fund,
            policy: f.policy,
            member: member_pda(&f.fund, captain),
            share_mint: f.share_mint,
            usdc_mint,
            captain_usdc: ata(captain, &usdc_mint, &spl_token_interface::ID),
            fund_usdc_vault: f.usdc_vault,
            captain_shares: share_ata(&f, captain),
            usdc_token_program: spl_token_interface::ID,
            share_token_program: TOKEN_2022,
            associated_token_program: anchor_spl::associated_token::ID,
            system_program: anchor_lang::system_program::ID,
        },
        v1_core::instruction::CreateFund {
            fund_id,
            deposit,
            open_seas,
        },
    )
}

/// Send `create_fund` signed by the captain.
#[allow(clippy::result_large_err)] // LiteSVM's own error type.
pub fn create_fund(
    env: &mut Env,
    captain: &Keypair,
    fund_id: u64,
    deposit: u64,
) -> Result<FundHandles, FailedTransactionMetadata> {
    let ix = ix_create_fund(env, &captain.pubkey(), fund_id, deposit);
    send(&mut env.svm, &[ix], &[captain])?;
    Ok(FundHandles::new(&captain.pubkey(), fund_id, &env.usdc))
}

/// The amount of an SPL Token or Token-2022 account. Bytes 64..72 in both layouts.
#[track_caller]
pub fn token_balance(svm: &LiteSVM, address: &Pubkey) -> u64 {
    let data = svm
        .get_account(address)
        .unwrap_or_else(|| panic!("token account {address} not found"))
        .data;
    u64::from_le_bytes(data[64..72].try_into().unwrap())
}

pub struct ShareMintState {
    pub base: spl_token_2022::state::Mint,
    pub non_transferable: bool,
    pub permanent_delegate: Option<Pubkey>,
}

/// Unpack a Token-2022 mint and report whether it has the NonTransferable extension.
pub fn share_mint_state(svm: &LiteSVM, mint: &Pubkey) -> ShareMintState {
    use spl_token_2022::extension::{
        non_transferable::NonTransferable, permanent_delegate::PermanentDelegate,
        BaseStateWithExtensions, StateWithExtensions,
    };
    let account = svm.get_account(mint).expect("share mint");
    assert_eq!(
        account.owner, TOKEN_2022,
        "share mint not owned by Token-2022"
    );
    let state = StateWithExtensions::<spl_token_2022::state::Mint>::unpack(&account.data)
        .expect("unpack mint");
    ShareMintState {
        base: state.base,
        non_transferable: state.get_extension::<NonTransferable>().is_ok(),
        permanent_delegate: state
            .get_extension::<PermanentDelegate>()
            .ok()
            .and_then(|e| Option::<Pubkey>::from(e.delegate)),
    }
}

pub fn read_config(env: &Env) -> Config {
    read_account(&env.svm, &config_pda())
}

/// Write a fake Pyth `PriceUpdateV2` account (Full verification, owner = Pyth
/// receiver) with ema = spot (ema_price = price, ema_conf = conf).
pub fn set_price(
    svm: &mut LiteSVM,
    address: Pubkey,
    feed_id: &[u8; 32],
    price: i64,
    conf: u64,
    expo: i32,
    publish_time: i64,
) {
    set_price_ema(
        svm,
        address,
        feed_id,
        price,
        conf,
        expo,
        publish_time,
        price,
        conf,
    );
}

/// `set_price` with an explicit EMA.
#[allow(clippy::too_many_arguments)]
pub fn set_price_ema(
    svm: &mut LiteSVM,
    address: Pubkey,
    feed_id: &[u8; 32],
    price: i64,
    conf: u64,
    expo: i32,
    publish_time: i64,
    ema_price: i64,
    ema_conf: u64,
) {
    let data = v1_core::pyth::encode_price_update_ema(
        true,
        feed_id,
        price,
        conf,
        expo,
        publish_time,
        ema_price,
        ema_conf,
    );
    svm.set_account(
        address,
        Account {
            lamports: svm.minimum_balance_for_rent_exemption(data.len()),
            data,
            owner: v1_core::pyth::PYTH_RECEIVER,
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();
}

/// Mint `amount` USDC base units into the token account `to` (admin is mint authority).
pub fn mint_usdc(env: &mut Env, to: &Pubkey, amount: u64) {
    let ix = spl_token_interface::instruction::mint_to(
        &spl_token_interface::ID,
        &env.usdc,
        to,
        &env.admin.pubkey(),
        &[],
        amount,
    )
    .unwrap();
    send(&mut env.svm, &[ix], &[&env.admin]).expect("mint_usdc");
}

// ---------------------------------------------------------------------------
// NAV + deposit
// ---------------------------------------------------------------------------

/// The test convention for where the Pyth price account of `mint` lives.
/// Write it with `set_price(&mut env.svm, price_account(&mint), ...)`.
pub fn price_account(mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"price", mint.as_ref()], &v1_core::pyth::PYTH_RECEIVER).0
}

/// `[price_a, price_b]` of `mint`, from its registry entry (test conventions):
/// - Pyth, or not listed (USDC): `[price_account(mint), UNUSED_PRICE_ACCOUNT]`.
/// - KaminoReserve: `[reserve, price_account(reserve)]` (the underlying's Pyth account).
/// - Switchboard: `[feed, UNUSED_PRICE_ACCOUNT]`.
pub fn price_accounts(env: &Env, mint: &Pubkey) -> [Pubkey; 2] {
    let source = env
        .svm
        .get_account(&token_pda(mint))
        .filter(|a| a.owner == v1_core::ID)
        .map(|a| {
            TokenEntry::try_deserialize(&mut &a.data[..])
                .unwrap()
                .price_source
        });
    match source {
        Some(PriceSource::KaminoReserve { reserve, .. }) => [reserve, price_account(&reserve)],
        Some(PriceSource::Switchboard { feed }) => [feed, UNUSED_PRICE_ACCOUNT],
        _ => [price_account(mint), UNUSED_PRICE_ACCOUNT],
    }
}

/// NAV remaining accounts for the fund's current holdings:
/// `[vault_i, token_entry_i, price_a_i, price_b_i]` per holding, in order
/// (price accounts from `price_accounts`).
pub fn nav_accounts(env: &Env, f: &FundHandles) -> Vec<AccountMeta> {
    let fund: v1_core::state::Fund = read_account(&env.svm, &f.fund);
    fund.holdings[..fund.holdings_len as usize]
        .iter()
        .flat_map(|mint| {
            let token_program = env.svm.get_account(mint).expect("holding mint").owner;
            let [a, b] = price_accounts(env, mint);
            [
                AccountMeta::new_readonly(ata(&f.fund, mint, &token_program), false),
                AccountMeta::new_readonly(token_pda(mint), false),
                AccountMeta::new_readonly(a, false),
                AccountMeta::new_readonly(b, false),
            ]
        })
        .collect()
}

/// `deposit` with the NAV remaining accounts of the fund's current holdings.
pub fn ix_deposit(env: &Env, f: &FundHandles, user: &Pubkey, amount: u64) -> Instruction {
    let mut ix = ix_deposit_bare(env, f, user, amount);
    ix.accounts.extend(nav_accounts(env, f));
    ix
}

/// `deposit` with NO remaining accounts (append your own).
pub fn ix_deposit_bare(env: &Env, f: &FundHandles, user: &Pubkey, amount: u64) -> Instruction {
    v1_ix(
        v1_core::accounts::Deposit {
            user: *user,
            config: config_pda(),
            fund: f.fund,
            policy: f.policy,
            member: member_pda(&f.fund, user),
            share_mint: f.share_mint,
            usdc_mint: env.usdc,
            user_usdc: usdc_ata(env, user),
            fund_usdc_vault: f.usdc_vault,
            user_shares: share_ata(f, user),
            usdc_token_program: spl_token_interface::ID,
            share_token_program: TOKEN_2022,
            associated_token_program: anchor_spl::associated_token::ID,
            system_program: anchor_lang::system_program::ID,
        },
        v1_core::instruction::Deposit { amount },
    )
}

/// Send `deposit` of `amount` USDC signed by `user`.
#[allow(clippy::result_large_err)] // LiteSVM's own error type.
pub fn deposit(
    env: &mut Env,
    f: &FundHandles,
    user: &Keypair,
    amount: u64,
) -> Result<TransactionMetadata, FailedTransactionMetadata> {
    let ix = ix_deposit(env, f, &user.pubkey(), amount);
    send(&mut env.svm, &[ix], &[user])
}

// ---------------------------------------------------------------------------
// Shared fund fixtures
// ---------------------------------------------------------------------------

pub fn now(env: &Env) -> i64 {
    env.svm.get_sysvar::<Clock>().unix_timestamp
}

/// Number of emitted Anchor events (`Program data:` log lines).
pub fn events(res: &TransactionMetadata) -> usize {
    res.logs
        .iter()
        .filter(|l| l.starts_with("Program data: "))
        .count()
}

pub fn read_fund(env: &Env, f: &FundHandles) -> v1_core::state::Fund {
    read_account(&env.svm, &f.fund)
}

/// Captain (300 USDC stake) + one funded member.
pub fn fund_with_member() -> (Env, Keypair, Keypair, FundHandles) {
    let mut env = setup();
    let cap = funded_user(&mut env, 1_000_000_000);
    let m = funded_user(&mut env, 1_000_000_000);
    let f = create_fund(&mut env, &cap, 1, 300_000_000).unwrap();
    (env, cap, m, f)
}

/// Add `mint` as a holding by writing the Fund account directly (the swap
/// path that adds holdings comes in a later task), create the fund's vault
/// for it on the mint's token program, and mint `amount` into the vault.
pub fn inject_holding(env: &mut Env, f: &FundHandles, mint: Pubkey, amount: u64) -> Pubkey {
    let mut fund = read_fund(env, f);
    let i = fund.holdings_len as usize;
    fund.holdings[i] = mint;
    fund.holdings_len += 1;
    write_fund(env, f, &fund);

    let token = env.svm.get_account(&mint).expect("holding mint").owner;
    let vault = ata(&f.fund, &mint, &token);
    let create = ix_create_ata(&env.admin.pubkey(), &f.fund, &mint, &token);
    // The Token-2022 builder accepts either token program id.
    let mint_ix = spl_token_2022::instruction::mint_to(
        &token,
        &mint,
        &vault,
        &env.admin.pubkey(),
        &[],
        amount,
    )
    .unwrap();
    send(&mut env.svm, &[create, mint_ix], &[&env.admin]).expect("inject_holding");
    vault
}

/// A 9-dp "SOL" mint, listed T1, priced at `usd` dollars (expo -8), fresh now.
pub fn listed_sol(env: &mut Env, usd: i64) -> Pubkey {
    let sol = create_mint(env, 9);
    register_token(env, sol, SOL_FEED, Tier::T1);
    let t = now(env);
    set_price(
        &mut env.svm,
        price_account(&sol),
        &SOL_FEED,
        usd * 100_000_000,
        0,
        -8,
        t,
    );
    sol
}

// ---------------------------------------------------------------------------
// Kamino kTokens
// ---------------------------------------------------------------------------

pub use v1_core::kamino::{ReserveFields, KAMINO_LEND, MAX_RESERVE_AGE_SLOTS};

/// A kUSDC test token: the kToken mint, its klend reserve and the reserve fields.
#[derive(Debug, Clone, Copy)]
pub struct KToken {
    pub mint: Pubkey,
    pub reserve: Pubkey,
    pub fields: ReserveFields,
}

/// Write a klend `Reserve` account (real layout, owner = Kamino Lend) at `address`.
pub fn write_reserve(svm: &mut LiteSVM, address: Pubkey, fields: &ReserveFields) {
    let data = v1_core::kamino::encode_reserve(fields);
    svm.set_account(
        address,
        Account {
            lamports: svm.minimum_balance_for_rent_exemption(data.len()),
            data,
            owner: KAMINO_LEND,
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();
}

/// A 6-dp kUSDC mint listed T1 with a `KaminoReserve` source. Its reserve has
/// rate 1.05 (1,050,000 USDC over 1,000,000 kUSDC), and USDC is $1.00
/// (`USDC_FEED` at `price_account(reserve)`); both fresh now.
pub fn listed_kusdc(env: &mut Env) -> KToken {
    let mint = create_mint(env, 6);
    let reserve = Pubkey::new_unique();
    let source = PriceSource::KaminoReserve {
        reserve,
        underlying_feed_id: USDC_FEED,
        underlying_decimals: 6,
    };
    register_token_with(env, mint, source, Tier::T1);
    let k = KToken {
        mint,
        reserve,
        fields: ReserveFields {
            liquidity_mint: env.usdc,
            decimals: 6,
            available: 600_000_000_000,
            borrowed_sf: 460_000_000_000u128 << 60,
            protocol_fees_sf: 10_000_000_000u128 << 60,
            collateral_mint: mint,
            collateral_supply: 1_000_000_000_000,
            ..Default::default()
        },
    };
    refresh_kusdc(env, &k);
    k
}

/// Re-write `k`'s reserve (refreshed at the current slot, not stale) and the
/// USDC price ($1.00, conf 0) at the current clock.
pub fn refresh_kusdc(env: &mut Env, k: &KToken) {
    let fields = ReserveFields {
        slot: env.svm.get_sysvar::<Clock>().slot,
        ..k.fields
    };
    write_reserve(&mut env.svm, k.reserve, &fields);
    let t = now(env);
    set_price(
        &mut env.svm,
        price_account(&k.reserve),
        &USDC_FEED,
        100_000_000,
        0,
        -8,
        t,
    );
}

// ---------------------------------------------------------------------------
// Switchboard On-Demand feeds
// ---------------------------------------------------------------------------

pub use v1_core::switchboard::{FeedFields, MAX_RESULT_AGE_SLOTS, SWITCHBOARD_ON_DEMAND};

/// 10^18: Switchboard values are USD with 18 decimals.
pub const SB_ONE: i128 = 1_000_000_000_000_000_000;

/// A long-tail test token priced by a Switchboard pull feed.
#[derive(Debug, Clone, Copy)]
pub struct SbToken {
    pub mint: Pubkey,
    pub feed: Pubkey,
    pub fields: FeedFields,
}

/// Write a `PullFeedAccountData` account (real layout, owner = Switchboard On-Demand).
pub fn write_feed(svm: &mut LiteSVM, address: Pubkey, fields: &FeedFields) {
    let data = v1_core::switchboard::encode_feed(fields);
    svm.set_account(
        address,
        Account {
            lamports: svm.minimum_balance_for_rent_exemption(data.len()),
            data,
            owner: SWITCHBOARD_ON_DEMAND,
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();
}

/// A 9-dp memecoin listed `tier` with a `Switchboard` source at $0.05
/// (std_dev 0, 3 samples), feed fresh now.
pub fn listed_meme(env: &mut Env, tier: Tier) -> SbToken {
    let mint = create_mint(env, 9);
    let feed = Pubkey::new_unique();
    register_token_with(env, mint, PriceSource::Switchboard { feed }, tier);
    let t = SbToken {
        mint,
        feed,
        fields: FeedFields {
            value: SB_ONE / 20,
            std_dev: 0,
            slot: 0,
            min_slot: 0,
            num_samples: v1_core::switchboard::MIN_SAMPLES,
            max_staleness: 250,
        },
    };
    refresh_meme(env, &t);
    t
}

/// Re-write `t`'s feed with its fields, all samples at the current slot.
pub fn refresh_meme(env: &mut Env, t: &SbToken) {
    let slot = env.svm.get_sysvar::<Clock>().slot;
    let fields = FeedFields {
        slot,
        min_slot: slot,
        ..t.fields
    };
    write_feed(&mut env.svm, t.feed, &fields);
}

/// Write SOL's price account: spot and ema in whole dollars, conf in cents.
pub fn sol_price(env: &mut Env, sol: &Pubkey, spot: i64, conf_cents: u64, ema: i64) {
    let t = now(env);
    let conf = conf_cents * 1_000_000;
    set_price_ema(
        &mut env.svm,
        price_account(sol),
        &SOL_FEED,
        spot * 100_000_000,
        conf,
        -8,
        t,
        ema * 100_000_000,
        conf,
    );
}

/// Overwrite the Fund account with `fund`.
pub fn write_fund(env: &mut Env, f: &FundHandles, fund: &v1_core::state::Fund) {
    use anchor_lang::AccountSerialize;
    let mut account = env.svm.get_account(&f.fund).unwrap();
    let mut data = Vec::new();
    fund.try_serialize(&mut data).unwrap();
    account.data[..data.len()].copy_from_slice(&data);
    env.svm.set_account(f.fund, account).unwrap();
}

// ---------------------------------------------------------------------------
// exit
// ---------------------------------------------------------------------------

/// Exit remaining accounts for the fund's current holdings:
/// `[vault_i (w), user_token_account_i (w), mint_i]` per holding, in order.
/// The user accounts are the user's ATAs on each mint's token program.
pub fn exit_accounts(env: &Env, f: &FundHandles, user: &Pubkey) -> Vec<AccountMeta> {
    let fund: v1_core::state::Fund = read_account(&env.svm, &f.fund);
    fund.holdings[..fund.holdings_len as usize]
        .iter()
        .flat_map(|mint| {
            let token_program = env.svm.get_account(mint).expect("holding mint").owner;
            [
                AccountMeta::new(ata(&f.fund, mint, &token_program), false),
                AccountMeta::new(ata(user, mint, &token_program), false),
                AccountMeta::new_readonly(*mint, false),
            ]
        })
        .collect()
}

/// `exit` with NO remaining accounts (append your own).
pub fn ix_exit_bare(env: &Env, f: &FundHandles, user: &Pubkey, shares: u64) -> Instruction {
    let fund: v1_core::state::Fund = read_account(&env.svm, &f.fund);
    v1_ix(
        v1_core::accounts::Exit {
            user: *user,
            config: config_pda(),
            fund: f.fund,
            policy: f.policy,
            member: member_pda(&f.fund, user),
            share_mint: f.share_mint,
            user_shares: share_ata(f, user),
            captain_shares: share_ata(f, &fund.captain),
            token_program: spl_token_interface::ID,
            share_token_program: TOKEN_2022,
        },
        v1_core::instruction::Exit { shares },
    )
}

/// `exit` with the exit accounts but no NAV accounts (the fee uses the last pps).
pub fn ix_exit_unpriced(env: &Env, f: &FundHandles, user: &Pubkey, shares: u64) -> Instruction {
    let mut ix = ix_exit_bare(env, f, user, shares);
    ix.accounts.extend(exit_accounts(env, f, user));
    ix
}

/// `exit` with the exit accounts, then the NAV accounts (fresh fee price).
pub fn ix_exit(env: &Env, f: &FundHandles, user: &Pubkey, shares: u64) -> Instruction {
    let mut ix = ix_exit_unpriced(env, f, user, shares);
    ix.accounts.extend(nav_accounts(env, f));
    ix
}

/// Send `exit` of `shares` (with NAV accounts) signed by `user`.
#[allow(clippy::result_large_err)] // LiteSVM's own error type.
pub fn exit(
    env: &mut Env,
    f: &FundHandles,
    user: &Keypair,
    shares: u64,
) -> Result<TransactionMetadata, FailedTransactionMetadata> {
    let ix = ix_exit(env, f, &user.pubkey(), shares);
    send(&mut env.svm, &[ix], &[user])
}

// ---------------------------------------------------------------------------
// Delegates
// ---------------------------------------------------------------------------

pub fn ix_add_delegate(
    captain: &Pubkey,
    f: &FundHandles,
    key: &Pubkey,
    max_trade_usd: u64,
    daily_volume_usd: u64,
) -> Instruction {
    v1_ix(
        v1_core::accounts::AddDelegate {
            captain: *captain,
            fund: f.fund,
            delegate: delegate_pda(&f.fund, key),
            system_program: anchor_lang::system_program::ID,
        },
        v1_core::instruction::AddDelegate {
            key: *key,
            max_trade_usd,
            daily_volume_usd,
        },
    )
}

pub fn ix_update_delegate(
    captain: &Pubkey,
    f: &FundHandles,
    key: &Pubkey,
    max_trade_usd: u64,
    daily_volume_usd: u64,
) -> Instruction {
    v1_ix(
        v1_core::accounts::UpdateDelegate {
            captain: *captain,
            fund: f.fund,
            delegate: delegate_pda(&f.fund, key),
        },
        v1_core::instruction::UpdateDelegate {
            max_trade_usd,
            daily_volume_usd,
        },
    )
}

pub fn ix_revoke_delegate(captain: &Pubkey, f: &FundHandles, key: &Pubkey) -> Instruction {
    v1_ix(
        v1_core::accounts::RevokeDelegate {
            captain: *captain,
            fund: f.fund,
            delegate: delegate_pda(&f.fund, key),
        },
        v1_core::instruction::RevokeDelegate {},
    )
}

// ---------------------------------------------------------------------------
// Mock venue
// ---------------------------------------------------------------------------

/// The addresses of a funded mock-venue pool for one mint pair.
#[derive(Debug, Clone, Copy)]
pub struct VenuePool {
    pub authority: Pubkey,
    pub pool_in: Pubkey,
    pub pool_out: Pubkey,
}

/// The venue pool authority PDA `[b"pool"]`.
pub fn venue_pool_authority() -> Pubkey {
    Pubkey::find_program_address(&[b"pool"], &mock_venue::ID).0
}

/// Create the pool ATAs (owner = venue pool PDA, on each mint's own token
/// program) for `mint_in` and `mint_out`, and mint `liquidity_in` /
/// `liquidity_out` base units into them. The admin must be mint authority of both
/// mints (true for `create_mint`, `write_mint(admin)` and `env.usdc`).
/// Safe to call again for a mint that already has a pool ATA.
pub fn setup_venue_pool(
    env: &mut Env,
    mint_in: &Pubkey,
    mint_out: &Pubkey,
    liquidity_in: u64,
    liquidity_out: u64,
) -> VenuePool {
    let authority = venue_pool_authority();
    let mut ixs = vec![];
    let mut accounts = vec![];
    for (mint, amount) in [(mint_in, liquidity_in), (mint_out, liquidity_out)] {
        let token = env.svm.get_account(mint).expect("pool mint").owner;
        let pool_ata = ata(&authority, mint, &token);
        ixs.push(
            anchor_spl::associated_token::spl_associated_token_account::instruction::create_associated_token_account_idempotent(
                &env.admin.pubkey(), &authority, mint, &token,
            ),
        );
        ixs.push(
            spl_token_2022::instruction::mint_to(
                &token,
                mint,
                &pool_ata,
                &env.admin.pubkey(),
                &[],
                amount,
            )
            .unwrap(),
        );
        accounts.push(pool_ata);
    }
    send(&mut env.svm, &ixs, &[&env.admin]).expect("setup_venue_pool");
    VenuePool {
        authority,
        pool_in: accounts[0],
        pool_out: accounts[1],
    }
}

/// A direct `mock_venue::swap` instruction. `authority` owns `user_in`.
/// Token programs are taken from the mint accounts in `svm`.
#[allow(clippy::too_many_arguments)]
pub fn ix_venue_swap(
    svm: &LiteSVM,
    authority: &Pubkey,
    user_in: &Pubkey,
    user_out: &Pubkey,
    pool: &VenuePool,
    mint_in: &Pubkey,
    mint_out: &Pubkey,
    amount_in: u64,
    out_num: u64,
    out_den: u64,
    mode: u8,
) -> Instruction {
    Instruction {
        program_id: mock_venue::ID,
        accounts: mock_venue::accounts::Swap {
            authority: *authority,
            pool_authority: pool.authority,
            user_in: *user_in,
            user_out: *user_out,
            pool_in: pool.pool_in,
            pool_out: pool.pool_out,
            mint_in: *mint_in,
            mint_out: *mint_out,
            token_program_in: svm.get_account(mint_in).unwrap().owner,
            token_program_out: svm.get_account(mint_out).unwrap().owner,
        }
        .to_account_metas(None),
        data: mock_venue::instruction::Swap {
            amount_in,
            out_num,
            out_den,
            mode,
        }
        .data(),
    }
}

// ---------------------------------------------------------------------------
// swap
// ---------------------------------------------------------------------------

/// SOL $150, BONK $0.00002 (expo -8).
pub const SOL_PRICE_E8: i64 = 15_000_000_000;
pub const BONK_PRICE_E8: i64 = 2_000;

/// Write the Pyth account of `mint` (`price_account(mint)`): spot = ema = `price_e8`,
/// expo -8, conf 0, published now.
pub fn set_usd_price(env: &mut Env, mint: &Pubkey, feed: &[u8; 32], price_e8: i64) {
    let t = now(env);
    set_price(&mut env.svm, price_account(mint), feed, price_e8, 0, -8, t);
}

/// A fund ready to trade (see `trading_fund`).
pub struct Trading {
    pub env: Env,
    pub cap: Keypair,
    pub f: FundHandles,
    /// 9 dp, T1, $150.
    pub sol: Pubkey,
    /// 5 dp, T2, $0.00002.
    pub bonk: Pubkey,
}

impl Trading {
    /// Re-publish the SOL and BONK prices at the current clock.
    pub fn refresh_prices(&mut self) {
        let (sol, bonk) = (self.sol, self.bonk);
        set_usd_price(&mut self.env, &sol, &SOL_FEED, SOL_PRICE_E8);
        set_usd_price(&mut self.env, &bonk, &BONK_FEED, BONK_PRICE_E8);
    }

    /// Empty the fund's 24 h autonomous budget (for tests about other checks).
    pub fn reset_budget(&mut self) {
        let mut fund = read_fund(&self.env, &self.f);
        fund.window_volume_usd = 0;
        write_fund(&mut self.env, &self.f, &fund);
    }

    /// `reset_budget`, then `swap`.
    #[allow(clippy::result_large_err)] // LiteSVM's own error type.
    pub fn swap_fresh(
        &mut self,
        args: &SwapArgs,
    ) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        self.reset_budget();
        self.swap(args)
    }

    /// Captain swap through the mock venue; see `SwapArgs::new`.
    #[allow(clippy::result_large_err)] // LiteSVM's own error type.
    pub fn swap(
        &mut self,
        args: &SwapArgs,
    ) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let ix = ix_swap(&self.env, &self.f, &self.cap.pubkey(), None, args);
        send(&mut self.env.svm, &[ix], &[&self.cap])
    }
}

/// SOL (T1, 9 dp) and BONK (T2, 5 dp) listed, the mock venue approved, with
/// deep pools of USDC, SOL and BONK, prices SOL $150 and BONK $0.00002, and a
/// fund whose captain deposited 10,000 USDC (the captain keeps 10,000 more).
pub fn trading_fund() -> Trading {
    let mut env = setup();
    let sol = create_mint(&mut env, 9);
    let bonk = create_mint(&mut env, 5);
    register_token(&mut env, sol, SOL_FEED, Tier::T1);
    register_token(&mut env, bonk, BONK_FEED, Tier::T2);
    register_venue(&mut env, mock_venue::ID);
    let usdc = env.usdc;
    setup_venue_pool(&mut env, &usdc, &sol, 1_000_000_000_000, 1_000_000_000_000);
    setup_venue_pool(&mut env, &bonk, &bonk, 1_000_000_000_000_000, 0);
    let cap = funded_user(&mut env, 20_000_000_000);
    let f = create_fund(&mut env, &cap, 1, 10_000_000_000).unwrap();
    let mut t = Trading {
        env,
        cap,
        f,
        sol,
        bonk,
    };
    t.refresh_prices();
    t
}

/// One swap request. `out_num / out_den` is the mock venue's rate in base units.
#[derive(Debug, Clone, Copy)]
pub struct SwapArgs {
    pub input: Pubkey,
    pub output: Pubkey,
    pub amount_in: u64,
    pub min_out: u64,
    pub out_num: u64,
    pub out_den: u64,
    pub mode: u8,
    pub venue: Pubkey,
}

impl SwapArgs {
    /// Honest mock-venue swap (mode 0).
    pub fn new(
        input: Pubkey,
        output: Pubkey,
        amount_in: u64,
        min_out: u64,
        out_num: u64,
        out_den: u64,
    ) -> Self {
        Self {
            input,
            output,
            amount_in,
            min_out,
            out_num,
            out_den,
            mode: 0,
            venue: mock_venue::ID,
        }
    }
    pub fn mode(mut self, mode: u8) -> Self {
        self.mode = mode;
        self
    }
}

/// The `Trade` accounts of a swap or a proposal execution for `a`.
pub fn trade_accounts(env: &Env, f: &FundHandles, a: &SwapArgs) -> v1_core::accounts::Trade {
    let prog = |mint: &Pubkey| env.svm.get_account(mint).expect("mint").owner;
    let (in_prog, out_prog) = (prog(&a.input), prog(&a.output));
    v1_core::accounts::Trade {
        config: config_pda(),
        fund: f.fund,
        policy: f.policy,
        venue_program: a.venue,
        venue_entry: venue_pda(&a.venue),
        input_mint: a.input,
        output_mint: a.output,
        input_entry: token_pda(&a.input),
        output_entry: token_pda(&a.output),
        fund_input_vault: ata(&f.fund, &a.input, &in_prog),
        fund_output_vault: ata(&f.fund, &a.output, &out_prog),
        output_token_program: out_prog,
        associated_token_program: anchor_spl::associated_token::ID,
        system_program: anchor_lang::system_program::ID,
    }
}

/// The mock venue's instruction data for `a`.
pub fn venue_data(a: &SwapArgs) -> Vec<u8> {
    mock_venue::instruction::Swap {
        amount_in: a.amount_in,
        out_num: a.out_num,
        out_den: a.out_den,
        mode: a.mode,
    }
    .data()
}

/// Remaining accounts of a trade: NAV accounts, then `[price_a, price_b]` of the output when the
/// output is new to the fund, then the T3 accounts for a T3 trade (`t3_accounts`),
/// then the mock venue's accounts (fund vaults as user_in / user_out).
pub fn trade_remaining(env: &Env, f: &FundHandles, a: &SwapArgs) -> Vec<AccountMeta> {
    let mut metas = nav_accounts(env, f);
    let fund: v1_core::state::Fund = read_account(&env.svm, &f.fund);
    let held = &fund.holdings[..fund.holdings_len as usize];
    if !held.contains(&a.output) {
        let [pa, pb] = price_accounts(env, &a.output);
        metas.push(AccountMeta::new_readonly(pa, false));
        metas.push(AccountMeta::new_readonly(pb, false));
    }
    let t3_buy = env
        .svm
        .get_account(&token_pda(&a.output))
        .is_some_and(|e| TokenEntry::try_deserialize(&mut &e.data[..]).unwrap().tier == Tier::T3);
    let t3_sell = held
        .iter()
        .position(|m| *m == a.input)
        .is_some_and(|i| fund.t3_basis_usd[i] > 0);
    if t3_buy || t3_sell {
        metas.extend(t3_accounts(f, &fund.captain));
    }
    metas.extend(venue_accounts(env, f, a));
    metas
}

/// The T3 accounts of a trade: `[captain_member, captain_shares, share_mint, Token-2022]`.
pub fn t3_accounts(f: &FundHandles, captain: &Pubkey) -> Vec<AccountMeta> {
    vec![
        AccountMeta::new(member_pda(&f.fund, captain), false),
        AccountMeta::new(share_ata(f, captain), false),
        AccountMeta::new(f.share_mint, false),
        AccountMeta::new_readonly(TOKEN_2022, false),
    ]
}

/// The mock venue's accounts for `a` (10, in `mock_venue::accounts::Swap` order).
pub fn venue_accounts(env: &Env, f: &FundHandles, a: &SwapArgs) -> Vec<AccountMeta> {
    let prog = |mint: &Pubkey| env.svm.get_account(mint).expect("mint").owner;
    let (in_prog, out_prog) = (prog(&a.input), prog(&a.output));
    let pool = venue_pool_authority();
    let venue = mock_venue::accounts::Swap {
        authority: f.fund,
        pool_authority: pool,
        user_in: ata(&f.fund, &a.input, &in_prog),
        user_out: ata(&f.fund, &a.output, &out_prog),
        pool_in: ata(&pool, &a.input, &in_prog),
        pool_out: ata(&pool, &a.output, &out_prog),
        mint_in: a.input,
        mint_out: a.output,
        token_program_in: in_prog,
        token_program_out: out_prog,
    }
    .to_account_metas(None);
    // The fund PDA cannot sign the transaction; v1-core signs for it in the CPI.
    venue
        .into_iter()
        .map(|mut m| {
            m.is_signer = false;
            m
        })
        .collect()
}

/// `swap` signed by `signer`, with `delegate` as the Delegate account (None = captain).
pub fn ix_swap(
    env: &Env,
    f: &FundHandles,
    signer: &Pubkey,
    delegate: Option<Pubkey>,
    a: &SwapArgs,
) -> Instruction {
    let mut ix = v1_ix(
        v1_core::accounts::Swap {
            signer: *signer,
            delegate,
            trade: trade_accounts(env, f, a),
        },
        v1_core::instruction::Swap {
            amount_in: a.amount_in,
            min_out: a.min_out,
            venue_data: venue_data(a),
        },
    );
    ix.accounts.extend(trade_remaining(env, f, a));
    ix
}

// ---------------------------------------------------------------------------
// Proposals
// ---------------------------------------------------------------------------

/// `propose_trade` for `a`, with the mock venue accounts of `a` as remaining
/// accounts. The new proposal id is the fund's current `proposal_count`.
pub fn ix_propose(
    env: &Env,
    f: &FundHandles,
    proposer: &Pubkey,
    delegate: Option<Pubkey>,
    a: &SwapArgs,
    data: Vec<u8>,
) -> Instruction {
    let id = read_fund(env, f).proposal_count;
    let mut ix = v1_ix(
        v1_core::accounts::ProposeTrade {
            proposer: *proposer,
            delegate,
            config: config_pda(),
            fund: f.fund,
            policy: f.policy,
            proposal: proposal_pda(&f.fund, id),
            venue_program: a.venue,
            venue_entry: venue_pda(&a.venue),
            input_mint: a.input,
            output_mint: a.output,
            input_entry: token_pda(&a.input),
            output_entry: token_pda(&a.output),
            system_program: anchor_lang::system_program::ID,
        },
        v1_core::instruction::ProposeTrade {
            amount_in: a.amount_in,
            min_out: a.min_out,
            venue_data: data,
        },
    );
    ix.accounts.extend(venue_accounts(env, f, a));
    ix
}

/// `vote` on proposal `id`, with the voter's Token-2022 share ATA.
pub fn ix_vote(f: &FundHandles, voter: &Pubkey, id: u64, yes: bool) -> Instruction {
    let proposal = proposal_pda(&f.fund, id);
    v1_ix(
        v1_core::accounts::CastVote {
            voter: *voter,
            fund: f.fund,
            proposal,
            member: member_pda(&f.fund, voter),
            voter_shares: share_ata(f, voter),
            vote_record: vote_pda(&proposal, voter),
            system_program: anchor_lang::system_program::ID,
        },
        v1_core::instruction::Vote { yes },
    )
}

/// `execute_proposal` of `id`, signed by `caller`; `a` gives the trade accounts,
/// `data` the venue data (data + venue accounts must match `route_hash`).
pub fn ix_execute_proposal(
    env: &Env,
    f: &FundHandles,
    caller: &Pubkey,
    id: u64,
    a: &SwapArgs,
    data: Vec<u8>,
) -> Instruction {
    let mut ix = v1_ix(
        v1_core::accounts::ExecuteProposal {
            caller: *caller,
            trade: trade_accounts(env, f, a),
            proposal: proposal_pda(&f.fund, id),
        },
        v1_core::instruction::ExecuteProposal { venue_data: data },
    );
    ix.accounts.extend(trade_remaining(env, f, a));
    ix
}

pub fn ix_cancel_proposal(captain: &Pubkey, f: &FundHandles, id: u64) -> Instruction {
    v1_ix(
        v1_core::accounts::CancelProposal {
            captain: *captain,
            fund: f.fund,
            proposal: proposal_pda(&f.fund, id),
        },
        v1_core::instruction::CancelProposal {},
    )
}

pub fn read_proposal(env: &Env, f: &FundHandles, id: u64) -> v1_core::state::Proposal {
    read_account(&env.svm, &proposal_pda(&f.fund, id))
}

/// The `TradeExecuted` events of a transaction, decoded from `Program data:` logs.
pub fn trade_events(res: &TransactionMetadata) -> Vec<v1_core::events::TradeExecuted> {
    decode_events(res)
}

/// The events of type `E` of a transaction, decoded from `Program data:` logs.
pub fn decode_events<E: anchor_lang::Discriminator + anchor_lang::AnchorDeserialize>(
    res: &TransactionMetadata,
) -> Vec<E> {
    use anchor_lang::__private::base64::{engine::general_purpose::STANDARD, Engine};
    res.logs
        .iter()
        .filter_map(|l| l.strip_prefix("Program data: "))
        .filter_map(|b| STANDARD.decode(b).ok())
        .filter(|d| d.starts_with(E::DISCRIMINATOR))
        .map(|d| E::try_from_slice(&d[E::DISCRIMINATOR.len()..]).expect("event"))
        .collect()
}

/// A ComputeBudget `SetComputeUnitLimit` instruction (no crate needed).
pub fn ix_compute_limit(units: u32) -> Instruction {
    let mut data = vec![2u8];
    data.extend_from_slice(&units.to_le_bytes());
    Instruction {
        program_id: solana_pubkey::pubkey!("ComputeBudget111111111111111111111111111111"),
        accounts: vec![],
        data,
    }
}

// ---------------------------------------------------------------------------
// Policy + breaker
// ---------------------------------------------------------------------------

pub use v1_core::state::{Policy, PolicyParams};

pub fn read_policy(env: &Env, f: &FundHandles) -> Policy {
    read_account(&env.svm, &f.policy)
}

/// Overwrite the Policy account with `policy`.
pub fn write_policy(env: &mut Env, f: &FundHandles, policy: &Policy) {
    use anchor_lang::AccountSerialize;
    let mut account = env.svm.get_account(&f.policy).unwrap();
    let mut data = Vec::new();
    policy.try_serialize(&mut data).unwrap();
    account.data[..data.len()].copy_from_slice(&data);
    env.svm.set_account(f.policy, account).unwrap();
}

pub fn ix_update_policy(captain: &Pubkey, f: &FundHandles, new: PolicyParams) -> Instruction {
    v1_ix(
        v1_core::accounts::UpdatePolicy {
            captain: *captain,
            fund: f.fund,
            policy: f.policy,
        },
        v1_core::instruction::UpdatePolicy { new },
    )
}

pub fn ix_apply_policy(f: &FundHandles) -> Instruction {
    v1_ix(
        v1_core::accounts::ApplyPolicy {
            fund: f.fund,
            policy: f.policy,
        },
        v1_core::instruction::ApplyPolicy {},
    )
}

/// `poke_nav` with the NAV remaining accounts of the fund's current holdings.
pub fn ix_poke_nav(env: &Env, f: &FundHandles) -> Instruction {
    let mut ix = v1_ix(
        v1_core::accounts::PokeNav {
            config: config_pda(),
            fund: f.fund,
            policy: f.policy,
        },
        v1_core::instruction::PokeNav {},
    );
    ix.accounts.extend(nav_accounts(env, f));
    ix
}
