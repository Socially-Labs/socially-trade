//! Test-only swap venue for the v1-core tests. Never deploy.
//!
//! One instruction, `swap`, at a fixed rate `out_num / out_den`. The `mode`
//! argument makes the venue honest or make one specific mistake, so the
//! v1-core guards can be tested.
//!
//! - `0` honest: take `amount_in` from `user_in`, pay `amount_in * num / den`.
//! - `1` short-pay: pay half of the honest output.
//! - `2` overdraw: take `amount_in + 1` from `user_in`, pay the honest output.
//! - `3` divert: take `amount_in`, pay nothing. The output never reaches `user_out`.
//!   (Simplest variant: the mints can differ, so there is no valid other account to pay.)
use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};

declare_id!("7wy5kqiVEWLHgmoccpe1DUD5vFA6tm68CM3hWiMcY1ng");

pub const POOL_SEED: &[u8] = b"pool";

#[error_code]
pub enum VenueError {
    BadMode,
    Overflow,
}

#[program]
pub mod mock_venue {
    use super::*;

    pub fn swap(
        ctx: Context<Swap>,
        amount_in: u64,
        out_num: u64,
        out_den: u64,
        mode: u8,
    ) -> Result<()> {
        require!(mode <= 3, VenueError::BadMode);
        require!(out_den > 0, VenueError::Overflow);
        let honest = u64::try_from(
            (amount_in as u128)
                .checked_mul(out_num as u128)
                .ok_or(VenueError::Overflow)?
                / out_den as u128,
        )
        .map_err(|_| VenueError::Overflow)?;
        let take = if mode == 2 {
            amount_in.checked_add(1).ok_or(VenueError::Overflow)?
        } else {
            amount_in
        };
        let pay = match mode {
            1 => honest / 2,
            3 => 0,
            _ => honest,
        };
        let a = &ctx.accounts;
        transfer_checked(
            CpiContext::new(
                a.token_program_in.key(),
                TransferChecked {
                    from: a.user_in.to_account_info(),
                    mint: a.mint_in.to_account_info(),
                    to: a.pool_in.to_account_info(),
                    authority: a.authority.to_account_info(),
                },
            ),
            take,
            a.mint_in.decimals,
        )?;
        if pay > 0 {
            let seeds: &[&[u8]] = &[POOL_SEED, &[ctx.bumps.pool_authority]];
            transfer_checked(
                CpiContext::new_with_signer(
                    a.token_program_out.key(),
                    TransferChecked {
                        from: a.pool_out.to_account_info(),
                        mint: a.mint_out.to_account_info(),
                        to: a.user_out.to_account_info(),
                        authority: a.pool_authority.to_account_info(),
                    },
                    &[seeds],
                ),
                pay,
                a.mint_out.decimals,
            )?;
        }
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Swap<'info> {
    /// Owner of `user_in`. The fund PDA when v1-core calls in.
    pub authority: Signer<'info>,
    /// CHECK: PDA `[b"pool"]`, signs the pool-side transfer.
    #[account(seeds = [POOL_SEED], bump)]
    pub pool_authority: UncheckedAccount<'info>,
    #[account(mut, token::mint = mint_in, token::authority = authority)]
    pub user_in: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, token::mint = mint_out)]
    pub user_out: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, token::mint = mint_in, token::authority = pool_authority)]
    pub pool_in: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, token::mint = mint_out, token::authority = pool_authority)]
    pub pool_out: InterfaceAccount<'info, TokenAccount>,
    pub mint_in: InterfaceAccount<'info, Mint>,
    pub mint_out: InterfaceAccount<'info, Mint>,
    pub token_program_in: Interface<'info, TokenInterface>,
    pub token_program_out: Interface<'info, TokenInterface>,
}
