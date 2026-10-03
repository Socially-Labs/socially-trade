//! Captain-managed trading delegates with a per-trade and a daily USD limit.

use {
    crate::{
        constants::*,
        errors::ErrorCode,
        state::{Delegate, Fund},
    },
    anchor_lang::prelude::*,
};

const DAY_SECS: i64 = 86_400;

#[derive(Accounts)]
#[instruction(key: Pubkey)]
pub struct AddDelegate<'info> {
    #[account(mut)]
    pub captain: Signer<'info>,
    #[account(
        seeds = [FUND_SEED, fund.captain.as_ref(), &fund.fund_id.to_le_bytes()],
        bump = fund.bump,
        has_one = captain @ ErrorCode::Unauthorized
    )]
    pub fund: Box<Account<'info, Fund>>,
    #[account(
        init,
        payer = captain,
        space = 8 + Delegate::INIT_SPACE,
        seeds = [DELEGATE_SEED, fund.key().as_ref(), key.as_ref()],
        bump
    )]
    pub delegate: Box<Account<'info, Delegate>>,
    pub system_program: Program<'info, System>,
}

pub fn add_delegate(
    ctx: Context<AddDelegate>,
    key: Pubkey,
    max_trade_usd: u64,
    daily_volume_usd: u64,
) -> Result<()> {
    let d = &mut ctx.accounts.delegate;
    d.fund = ctx.accounts.fund.key();
    d.key = key;
    d.max_trade_usd = max_trade_usd;
    d.daily_volume_usd = daily_volume_usd;
    d.day_start = 0;
    d.day_volume = 0;
    d.bump = ctx.bumps.delegate;
    Ok(())
}

#[derive(Accounts)]
pub struct UpdateDelegate<'info> {
    pub captain: Signer<'info>,
    #[account(
        seeds = [FUND_SEED, fund.captain.as_ref(), &fund.fund_id.to_le_bytes()],
        bump = fund.bump,
        has_one = captain @ ErrorCode::Unauthorized
    )]
    pub fund: Box<Account<'info, Fund>>,
    #[account(
        mut,
        seeds = [DELEGATE_SEED, fund.key().as_ref(), delegate.key.as_ref()],
        bump = delegate.bump
    )]
    pub delegate: Box<Account<'info, Delegate>>,
}

pub fn update_delegate(
    ctx: Context<UpdateDelegate>,
    max_trade_usd: u64,
    daily_volume_usd: u64,
) -> Result<()> {
    let d = &mut ctx.accounts.delegate;
    d.max_trade_usd = max_trade_usd;
    d.daily_volume_usd = daily_volume_usd;
    Ok(())
}

#[derive(Accounts)]
pub struct RevokeDelegate<'info> {
    #[account(mut)]
    pub captain: Signer<'info>,
    #[account(
        seeds = [FUND_SEED, fund.captain.as_ref(), &fund.fund_id.to_le_bytes()],
        bump = fund.bump,
        has_one = captain @ ErrorCode::Unauthorized
    )]
    pub fund: Box<Account<'info, Fund>>,
    #[account(
        mut,
        close = captain,
        seeds = [DELEGATE_SEED, fund.key().as_ref(), delegate.key.as_ref()],
        bump = delegate.bump
    )]
    pub delegate: Box<Account<'info, Delegate>>,
}

pub fn revoke_delegate(_ctx: Context<RevokeDelegate>) -> Result<()> {
    Ok(())
}

/// Count `trade_usd` against the delegate limits. Used by `swap`.
/// The day window restarts when 24 h have passed since `day_start`.
pub fn charge_delegate(d: &mut Delegate, trade_usd: u64, now: i64) -> Result<()> {
    if now.saturating_sub(d.day_start) >= DAY_SECS {
        d.day_start = now;
        d.day_volume = 0;
    }
    require!(trade_usd <= d.max_trade_usd, ErrorCode::DelegateTradeLimit);
    let total = d
        .day_volume
        .checked_add(trade_usd)
        .ok_or(ErrorCode::MathOverflow)?;
    require!(total <= d.daily_volume_usd, ErrorCode::DelegateDailyLimit);
    d.day_volume = total;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(max: u64, daily: u64) -> Delegate {
        Delegate {
            fund: Pubkey::default(),
            key: Pubkey::default(),
            max_trade_usd: max,
            daily_volume_usd: daily,
            day_start: 0,
            day_volume: 0,
            bump: 0,
        }
    }

    fn code(r: Result<()>) -> u32 {
        match r.unwrap_err() {
            anchor_lang::error::Error::AnchorError(e) => e.error_code_number,
            e => panic!("{e:?}"),
        }
    }

    #[test]
    fn per_trade_limit() {
        let mut x = d(100, 1000);
        charge_delegate(&mut x, 100, 1000).unwrap();
        assert_eq!(
            code(charge_delegate(&mut x, 101, 1000)),
            6000 + ErrorCode::DelegateTradeLimit as u32
        );
        assert_eq!(x.day_volume, 100);
    }

    #[test]
    fn daily_limit_and_reset() {
        let mut x = d(100, 250);
        let t0 = 1_000_000;
        charge_delegate(&mut x, 100, t0).unwrap();
        charge_delegate(&mut x, 100, t0 + 10).unwrap();
        assert_eq!(x.day_start, t0);
        assert_eq!(
            code(charge_delegate(&mut x, 51, t0 + 20)),
            6000 + ErrorCode::DelegateDailyLimit as u32
        );
        // Exact fill is ok.
        charge_delegate(&mut x, 50, t0 + 20).unwrap();
        // One second before the window ends: still full.
        assert!(charge_delegate(&mut x, 1, t0 + DAY_SECS - 1).is_err());
        // At 24 h the window resets.
        charge_delegate(&mut x, 100, t0 + DAY_SECS).unwrap();
        assert_eq!((x.day_start, x.day_volume), (t0 + DAY_SECS, 100));
    }

    #[test]
    fn day_volume_overflow_is_math_overflow() {
        let mut x = d(u64::MAX, u64::MAX);
        x.day_start = 5;
        x.day_volume = u64::MAX;
        assert_eq!(
            code(charge_delegate(&mut x, 1, 5)),
            6000 + ErrorCode::MathOverflow as u32
        );
    }
}
