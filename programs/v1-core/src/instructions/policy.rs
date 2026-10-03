//! Fund risk policy: stricter changes apply now, any looser field waits
//! `POLICY_LOOSEN_DELAY_SECS`. Plus `poke_nav`, which moves the drawdown
//! breaker without a trade.

use {
    crate::{
        constants::*,
        errors::ErrorCode,
        events::{PolicyApplied, PolicyQueued},
        math,
        nav::{self, ValuationMode},
        state::{Config, Fund, Policy, PolicyParams},
    },
    anchor_lang::prelude::*,
};

#[derive(Accounts)]
pub struct UpdatePolicy<'info> {
    pub captain: Signer<'info>,
    #[account(
        seeds = [FUND_SEED, fund.captain.as_ref(), &fund.fund_id.to_le_bytes()],
        bump = fund.bump,
        has_one = captain @ ErrorCode::Unauthorized
    )]
    pub fund: Box<Account<'info, Fund>>,
    #[account(mut, seeds = [POLICY_SEED, fund.key().as_ref()], bump = policy.bump)]
    pub policy: Box<Account<'info, Policy>>,
}

pub fn update_policy(ctx: Context<UpdatePolicy>, new: PolicyParams) -> Result<()> {
    require!(new.within_floor(), ErrorCode::PolicyBelowFloor);
    let fund = ctx.accounts.fund.key();
    let policy = &mut ctx.accounts.policy;
    if new.stricter_or_equal(&policy.params) {
        // A pending loosen stays queued: it was announced and still waits its delay.
        policy.params = new;
        emit!(PolicyApplied { fund });
    } else {
        let eta = Clock::get()?
            .unix_timestamp
            .checked_add(POLICY_LOOSEN_DELAY_SECS)
            .ok_or(ErrorCode::MathOverflow)?;
        policy.pending = new;
        policy.pending_eta = eta;
        emit!(PolicyQueued { fund, eta });
    }
    Ok(())
}

#[derive(Accounts)]
pub struct ApplyPolicy<'info> {
    #[account(
        seeds = [FUND_SEED, fund.captain.as_ref(), &fund.fund_id.to_le_bytes()],
        bump = fund.bump
    )]
    pub fund: Box<Account<'info, Fund>>,
    #[account(mut, seeds = [POLICY_SEED, fund.key().as_ref()], bump = policy.bump)]
    pub policy: Box<Account<'info, Policy>>,
}

pub fn apply_policy(ctx: Context<ApplyPolicy>) -> Result<()> {
    let policy = &mut ctx.accounts.policy;
    require!(policy.pending_eta != 0, ErrorCode::NothingPending);
    require!(
        Clock::get()?.unix_timestamp >= policy.pending_eta,
        ErrorCode::TimelockNotElapsed
    );
    require!(policy.pending.within_floor(), ErrorCode::PolicyBelowFloor);
    policy.params = policy.pending;
    policy.pending_eta = 0;
    emit!(PolicyApplied {
        fund: ctx.accounts.fund.key()
    });
    Ok(())
}

#[derive(Accounts)]
pub struct PokeNav<'info> {
    /// Read only for `usdc_mint` (NAV). No pause check: the breaker always moves.
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
}

/// Recompute the EMA pps from the NAV remaining accounts and move the breaker.
pub fn poke_nav(ctx: Context<PokeNav>) -> Result<()> {
    let fund_key = ctx.accounts.fund.key();
    let now = Clock::get()?.unix_timestamp;
    let priced = nav::compute(
        &ctx.accounts.fund,
        &fund_key,
        &ctx.accounts.config,
        ctx.remaining_accounts,
        now,
        ctx.program_id,
    )?;
    let nav_ema = priced.valuation(ValuationMode::Ema)?.nav;
    let pps = math::price_per_share(nav_ema, ctx.accounts.fund.total_shares)?;
    nav::update_breaker(&mut ctx.accounts.fund, &fund_key, &ctx.accounts.policy, pps)
}
