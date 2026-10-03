//! Yearly performance fee. Anyone can call it for a member, once per year.
//! Prices must be fresh and valid (unlike `exit`): the fee pps is the fresh
//! upper-bound pps only. A keeper cannot pick a low price (invalid prices fail
//! the call), and a stale high `last_price_per_share` cannot inflate the fee.
//! The breaker moves on the fresh EMA pps before the fee is computed.
//! The fee shares are minted to the captain and burned from the member by
//! the fund PDA, the permanent delegate of the share mint.

use {
    crate::{
        constants::*,
        errors::ErrorCode,
        instructions::exit::{charge_fee, fresh_pps},
        nav,
        state::{Config, Fund, Member, Policy},
    },
    anchor_lang::prelude::*,
    anchor_spl::{
        token_2022::Token2022,
        token_interface::{self, Mint, TokenAccount},
    },
};

#[derive(Accounts)]
pub struct ChargeAnnualFee<'info> {
    pub payer: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
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
        mut,
        seeds = [MEMBER_SEED, fund.key().as_ref(), member.owner.as_ref()],
        bump = member.bump
    )]
    pub member: Box<Account<'info, Member>>,
    #[account(mut, address = fund.share_mint, mint::token_program = share_token_program)]
    pub share_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        mut,
        associated_token::mint = share_mint,
        associated_token::authority = member.owner,
        associated_token::token_program = share_token_program
    )]
    pub member_shares: Box<InterfaceAccount<'info, TokenAccount>>,
    /// Same account as `member_shares` when the target is the captain (rejected in the handler).
    #[account(
        mut,
        dup,
        associated_token::mint = share_mint,
        associated_token::authority = fund.captain,
        associated_token::token_program = share_token_program
    )]
    pub captain_shares: Box<InterfaceAccount<'info, TokenAccount>>,
    pub share_token_program: Program<'info, Token2022>,
}

pub fn charge_annual_fee<'info>(ctx: Context<'info, ChargeAnnualFee<'info>>) -> Result<()> {
    let a = &ctx.accounts;
    require!(
        !a.member.is_captain && a.member.owner != a.fund.captain,
        ErrorCode::Unauthorized
    );
    let now = Clock::get()?.unix_timestamp;
    let due = a
        .member
        .last_fee_at
        .checked_add(YEAR_SECS)
        .ok_or(ErrorCode::MathOverflow)?;
    require!(now >= due, ErrorCode::FeeNotDue);

    let fund_key = a.fund.key();
    // Invalid or missing prices fail the call.
    let (pps, ema_pps) = fresh_pps(
        &a.fund,
        &fund_key,
        &a.config,
        ctx.remaining_accounts,
        now,
        ctx.program_id,
    )?;
    // The breaker moves first, so the fee sees the same fund state as the next caller.
    nav::update_breaker(
        &mut ctx.accounts.fund,
        &fund_key,
        &ctx.accounts.policy,
        ema_pps,
    )?;

    let a = &ctx.accounts;
    let balance = a.member_shares.amount;
    let fund_id_le = a.fund.fund_id.to_le_bytes();
    let fund_seeds: &[&[u8]] = &[
        FUND_SEED,
        a.fund.captain.as_ref(),
        &fund_id_le,
        &[a.fund.bump],
    ];
    let signer = &[fund_seeds];
    let fee = charge_fee(
        &a.share_token_program,
        &a.share_mint,
        &a.captain_shares,
        &a.fund,
        signer,
        a.member.owner,
        balance,
        pps,
        a.member.hwm,
    )?;
    if fee.fee_shares > 0 {
        token_interface::burn(
            CpiContext::new_with_signer(
                a.share_token_program.key(),
                token_interface::Burn {
                    mint: a.share_mint.to_account_info(),
                    from: a.member_shares.to_account_info(),
                    authority: a.fund.to_account_info(),
                },
                signer,
            ),
            fee.fee_shares,
        )?;
    }

    let member = &mut ctx.accounts.member;
    member.hwm = fee.new_hwm;
    member.last_fee_at = now;
    Ok(())
}
