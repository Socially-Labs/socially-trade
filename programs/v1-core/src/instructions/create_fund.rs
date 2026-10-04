//! Captain opens a fund: USDC stake into the vault, 1:1 non-transferable shares out.

use {
    crate::{
        constants::*,
        errors::ErrorCode,
        events::FundCreated,
        state::{Config, Fund, Member, Policy, PolicyParams},
    },
    anchor_lang::{prelude::*, system_program},
    anchor_spl::{
        associated_token::{self, get_associated_token_address_with_program_id, AssociatedToken},
        token_2022::{spl_token_2022::extension::ExtensionType, Token2022},
        token_interface::{self, find_mint_account_size, Mint, TokenAccount, TokenInterface},
    },
};

/// 1 share = 1 USDC at creation (USDC base units per 1e6 share units).
const INITIAL_PRICE_PER_SHARE: u64 = 1_000_000;

#[derive(Accounts)]
#[instruction(fund_id: u64)]
pub struct CreateFund<'info> {
    #[account(mut)]
    pub captain: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, constraint = !config.paused @ ErrorCode::Paused)]
    pub config: Box<Account<'info, Config>>,
    #[account(
        init,
        payer = captain,
        space = 8 + Fund::INIT_SPACE,
        seeds = [FUND_SEED, captain.key().as_ref(), &fund_id.to_le_bytes()],
        bump
    )]
    pub fund: Box<Account<'info, Fund>>,
    #[account(
        init,
        payer = captain,
        space = 8 + Policy::INIT_SPACE,
        seeds = [POLICY_SEED, fund.key().as_ref()],
        bump
    )]
    pub policy: Box<Account<'info, Policy>>,
    #[account(
        init,
        payer = captain,
        space = 8 + Member::INIT_SPACE,
        seeds = [MEMBER_SEED, fund.key().as_ref(), captain.key().as_ref()],
        bump
    )]
    pub member: Box<Account<'info, Member>>,
    /// CHECK: Token-2022 mint with the NonTransferable extension, created in the
    /// handler. Anchor 1.2 parses no `extensions::non_transferable` constraint.
    #[account(mut, seeds = [SHARES_SEED, fund.key().as_ref()], bump)]
    pub share_mint: UncheckedAccount<'info>,
    #[account(address = config.usdc_mint, mint::token_program = usdc_token_program)]
    pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        mut,
        token::mint = usdc_mint,
        token::authority = captain,
        token::token_program = usdc_token_program
    )]
    pub captain_usdc: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        init,
        payer = captain,
        associated_token::mint = usdc_mint,
        associated_token::authority = fund,
        associated_token::token_program = usdc_token_program
    )]
    pub fund_usdc_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: the captain's Token-2022 share ATA, created in the handler once
    /// the share mint exists. The address is pinned here.
    #[account(
        mut,
        address = get_associated_token_address_with_program_id(
            &captain.key(), &share_mint.key(), &share_token_program.key()
        )
    )]
    pub captain_shares: UncheckedAccount<'info>,
    pub usdc_token_program: Interface<'info, TokenInterface>,
    pub share_token_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn create_fund(
    ctx: Context<CreateFund>,
    fund_id: u64,
    deposit: u64,
    open_seas: bool,
) -> Result<()> {
    require!(
        deposit >= CAPTAIN_MIN_DEPOSIT,
        ErrorCode::CaptainDepositTooSmall
    );
    let now = Clock::get()?.unix_timestamp;
    let a = &ctx.accounts;
    let captain = a.captain.key();
    let fund_key = a.fund.key();
    let fund_bump = ctx.bumps.fund;
    let fund_id_le = fund_id.to_le_bytes();
    let fund_seeds: &[&[u8]] = &[FUND_SEED, captain.as_ref(), &fund_id_le, &[fund_bump]];
    let mint_seeds: &[&[u8]] = &[SHARES_SEED, fund_key.as_ref(), &[ctx.bumps.share_mint]];

    create_share_mint(a, mint_seeds, &fund_key)?;

    associated_token::create(CpiContext::new(
        a.associated_token_program.key(),
        associated_token::Create {
            payer: a.captain.to_account_info(),
            associated_token: a.captain_shares.to_account_info(),
            authority: a.captain.to_account_info(),
            mint: a.share_mint.to_account_info(),
            system_program: a.system_program.to_account_info(),
            token_program: a.share_token_program.to_account_info(),
        },
    ))?;

    token_interface::transfer_checked(
        CpiContext::new(
            a.usdc_token_program.key(),
            token_interface::TransferChecked {
                from: a.captain_usdc.to_account_info(),
                mint: a.usdc_mint.to_account_info(),
                to: a.fund_usdc_vault.to_account_info(),
                authority: a.captain.to_account_info(),
            },
        ),
        deposit,
        a.usdc_mint.decimals,
    )?;

    token_interface::mint_to(
        CpiContext::new_with_signer(
            a.share_token_program.key(),
            token_interface::MintTo {
                mint: a.share_mint.to_account_info(),
                to: a.captain_shares.to_account_info(),
                authority: a.fund.to_account_info(),
            },
            &[fund_seeds],
        ),
        deposit,
    )?;

    let usdc = a.usdc_mint.key();
    let share_mint = a.share_mint.key();
    let mut holdings = [Pubkey::default(); MAX_HOLDINGS];
    holdings[0] = usdc;
    ctx.accounts.fund.set_inner(Fund {
        captain,
        fund_id,
        share_mint,
        holdings,
        holdings_len: 1,
        total_shares: deposit,
        last_price_per_share: INITIAL_PRICE_PER_SHARE,
        peak_price_per_share: INITIAL_PRICE_PER_SHARE,
        frozen: false,
        proposal_count: 0,
        created_at: now,
        bump: fund_bump,
        window_start: now,
        window_volume_usd: 0,
        open_seas,
        t3_cost_basis_usd: 0,
        t3_window_start: now,
        t3_window_buys_usd: 0,
        t3_basis_usd: [0; MAX_HOLDINGS],
        t3_prev_window_buys_usd: 0,
        last_pps_slot: Clock::get()?.slot,
    });
    let params = PolicyParams {
        autonomous_bps: DEFAULT_AUTONOMOUS_BPS,
        drawdown_bps: DEFAULT_DRAWDOWN_BPS,
        max_slippage_bps: DEFAULT_MAX_SLIPPAGE_BPS,
        vote_window_secs: DEFAULT_VOTE_WINDOW_SECS,
    };
    ctx.accounts.policy.set_inner(Policy {
        fund: fund_key,
        params,
        pending: params,
        pending_eta: 0,
        bump: ctx.bumps.policy,
    });
    ctx.accounts.member.set_inner(Member {
        fund: fund_key,
        owner: captain,
        hwm: deposit,
        joined_at: now,
        last_fee_at: now,
        last_deposit_ts: now,
        is_captain: true,
        bump: ctx.bumps.member,
    });

    emit!(FundCreated {
        fund: fund_key,
        captain,
        deposit
    });
    Ok(())
}

/// Create the share-mint PDA as a Token-2022 mint: NonTransferable, 6 dp,
/// mint authority = fund, permanent delegate = fund, no freeze authority. Tolerates lamports that someone
/// sent to the PDA in advance (create_account would fail on them).
fn create_share_mint(a: &CreateFund, mint_seeds: &[&[u8]], fund: &Pubkey) -> Result<()> {
    let space = find_mint_account_size(Some(&vec![
        ExtensionType::NonTransferable,
        ExtensionType::PermanentDelegate,
    ]))?;
    let rent = Rent::get()?.minimum_balance(space);
    let token_2022 = a.share_token_program.key();
    let system = a.system_program.key();
    let payer = a.captain.to_account_info();
    let mint = a.share_mint.to_account_info();
    let signer: &[&[&[u8]]] = &[mint_seeds];

    let current = mint.lamports();
    if current == 0 {
        system_program::create_account(
            CpiContext::new_with_signer(
                system,
                system_program::CreateAccount {
                    from: payer,
                    to: mint.clone(),
                },
                signer,
            ),
            rent,
            space as u64,
            &token_2022,
        )?;
    } else {
        let top_up = rent.saturating_sub(current);
        if top_up > 0 {
            system_program::transfer(
                CpiContext::new(
                    system,
                    system_program::Transfer {
                        from: payer,
                        to: mint.clone(),
                    },
                ),
                top_up,
            )?;
        }
        system_program::allocate(
            CpiContext::new_with_signer(
                system,
                system_program::Allocate {
                    account_to_allocate: mint.clone(),
                },
                signer,
            ),
            space as u64,
        )?;
        system_program::assign(
            CpiContext::new_with_signer(
                system,
                system_program::Assign {
                    account_to_assign: mint.clone(),
                },
                signer,
            ),
            &token_2022,
        )?;
    }

    // The extension must be initialized before the mint itself.
    // Permanent delegate = fund PDA: only program code can burn fee shares
    // from a member (annual fee), without the member signing.
    token_interface::permanent_delegate_initialize(
        CpiContext::new(
            token_2022,
            token_interface::PermanentDelegateInitialize {
                token_program_id: a.share_token_program.to_account_info(),
                mint: mint.clone(),
            },
        ),
        fund,
    )?;
    token_interface::non_transferable_mint_initialize(CpiContext::new(
        token_2022,
        token_interface::NonTransferableMintInitialize {
            token_program_id: a.share_token_program.to_account_info(),
            mint: mint.clone(),
        },
    ))?;
    token_interface::initialize_mint2(
        CpiContext::new(token_2022, token_interface::InitializeMint2 { mint }),
        SHARE_DECIMALS,
        fund,
        None,
    )
}
