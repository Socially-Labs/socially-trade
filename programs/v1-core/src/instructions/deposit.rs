//! Anyone buys shares at NAV with USDC. Remaining accounts: the NAV layout (see `nav`).

use {
    crate::{
        constants::*,
        errors::ErrorCode,
        events::Deposited,
        math,
        nav::{self, ValuationMode},
        state::{Config, Fund, Member, Policy},
    },
    anchor_lang::prelude::*,
    anchor_spl::{
        associated_token::AssociatedToken,
        token_2022::Token2022,
        token_interface::{self, Mint, TokenAccount, TokenInterface},
    },
};

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, constraint = !config.paused @ ErrorCode::Paused)]
    pub config: Box<Account<'info, Config>>,
    #[account(
        mut,
        seeds = [FUND_SEED, fund.captain.as_ref(), &fund.fund_id.to_le_bytes()],
        bump = fund.bump
    )]
    pub fund: Box<Account<'info, Fund>>,
    #[account(seeds = [POLICY_SEED, fund.key().as_ref()], bump = policy.bump)]
    pub policy: Box<Account<'info, Policy>>,
    #[account(
        init_if_needed,
        payer = user,
        space = 8 + Member::INIT_SPACE,
        seeds = [MEMBER_SEED, fund.key().as_ref(), user.key().as_ref()],
        bump
    )]
    pub member: Box<Account<'info, Member>>,
    #[account(mut, address = fund.share_mint, mint::token_program = share_token_program)]
    pub share_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = config.usdc_mint, mint::token_program = usdc_token_program)]
    pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        mut,
        token::mint = usdc_mint,
        token::authority = user,
        token::token_program = usdc_token_program
    )]
    pub user_usdc: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        associated_token::mint = usdc_mint,
        associated_token::authority = fund,
        associated_token::token_program = usdc_token_program
    )]
    pub fund_usdc_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = share_mint,
        associated_token::authority = user,
        associated_token::token_program = share_token_program
    )]
    pub user_shares: Box<InterfaceAccount<'info, TokenAccount>>,
    pub usdc_token_program: Interface<'info, TokenInterface>,
    pub share_token_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
    require!(amount > 0, ErrorCode::ZeroAmount);
    let now = Clock::get()?.unix_timestamp;
    let a = &ctx.accounts;
    let fund_key = a.fund.key();
    let user = a.user.key();

    // Price before the deposit lands in the vault.
    let total_before = a.fund.total_shares;
    require!(total_before > 0, ErrorCode::FundClosed);
    let priced = nav::compute(
        &a.fund,
        &fund_key,
        &a.config,
        ctx.remaining_accounts,
        now,
        ctx.program_id,
    )?;
    // Shares from the upper-bound NAV (favor the fund); breaker from the EMA NAV.
    let nav_upper = priced.valuation(ValuationMode::DepositUpperBound)?.nav;
    require!(nav_upper > 0, ErrorCode::NavZero);
    let nav_ema = priced.valuation(ValuationMode::Ema)?.nav;
    let pps_paid = math::price_per_share(nav_upper, total_before)?;
    let pps_ema = math::price_per_share(nav_ema, total_before)?;
    let shares = math::shares_for_deposit(amount, total_before, nav_upper)?;

    token_interface::transfer_checked(
        CpiContext::new(
            a.usdc_token_program.key(),
            token_interface::TransferChecked {
                from: a.user_usdc.to_account_info(),
                mint: a.usdc_mint.to_account_info(),
                to: a.fund_usdc_vault.to_account_info(),
                authority: a.user.to_account_info(),
            },
        ),
        amount,
        a.usdc_mint.decimals,
    )?;

    let fund_id_le = a.fund.fund_id.to_le_bytes();
    let fund_seeds: &[&[u8]] = &[
        FUND_SEED,
        a.fund.captain.as_ref(),
        &fund_id_le,
        &[a.fund.bump],
    ];
    token_interface::mint_to(
        CpiContext::new_with_signer(
            a.share_token_program.key(),
            token_interface::MintTo {
                mint: a.share_mint.to_account_info(),
                to: a.user_shares.to_account_info(),
                authority: a.fund.to_account_info(),
            },
            &[fund_seeds],
        ),
        shares,
    )?;

    let fund = &mut ctx.accounts.fund;
    fund.total_shares = fund
        .total_shares
        .checked_add(shares)
        .ok_or(ErrorCode::MathOverflow)?;
    nav::update_breaker(fund, &fund_key, &ctx.accounts.policy, pps_ema)?;

    let member = &mut ctx.accounts.member;
    if member.owner == Pubkey::default() {
        member.fund = fund_key;
        member.owner = user;
        member.joined_at = now;
        member.last_fee_at = now;
        member.is_captain = false;
        member.bump = ctx.bumps.member;
    }
    member.hwm = member
        .hwm
        .checked_add(amount)
        .ok_or(ErrorCode::MathOverflow)?;
    member.last_deposit_ts = now;

    emit!(Deposited {
        fund: fund_key,
        member: user,
        amount,
        shares,
        price_per_share: pps_paid,
    });
    Ok(())
}
