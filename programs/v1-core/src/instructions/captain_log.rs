//! A signed on-chain note from the captain or a delegate. Event only, no state.

use {
    crate::{
        constants::*,
        errors::ErrorCode,
        events::CaptainLog,
        state::{Delegate, Fund},
    },
    anchor_lang::prelude::*,
};

#[derive(Accounts)]
pub struct WriteLog<'info> {
    pub signer: Signer<'info>,
    #[account(
        seeds = [FUND_SEED, fund.captain.as_ref(), &fund.fund_id.to_le_bytes()],
        bump = fund.bump
    )]
    pub fund: Box<Account<'info, Fund>>,
    /// Required unless the signer is the captain.
    pub delegate: Option<Box<Account<'info, Delegate>>>,
}

pub fn captain_log(ctx: Context<WriteLog>, reason_hash: [u8; 32]) -> Result<()> {
    let a = &ctx.accounts;
    let signer = a.signer.key();
    if signer != a.fund.captain {
        let d = a.delegate.as_deref().ok_or(ErrorCode::Unauthorized)?;
        require!(
            d.key == signer && d.fund == a.fund.key(),
            ErrorCode::Unauthorized
        );
    }
    emit!(CaptainLog {
        fund: a.fund.key(),
        signer,
        reason_hash,
        slot: Clock::get()?.slot,
    });
    Ok(())
}
