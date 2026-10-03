//! A member leaves with a pro-rata slice of every holding, in kind.
//! Never blocked: no pause, freeze or price check can stop an exit.
//!
//! Remaining accounts:
//! 1. 3 per holding, in `fund.holdings` order: `[vault_i (w), user_token_i (w), mint_i]`.
//!    `user_token_i` is the user's token account for `mint_i` on the mint's
//!    token program. It is not read when the user's slice of that holding is 0.
//! 2. Optional, after that: the NAV layout (see `nav`). The fee pps is
//!    `max(fund.last_price_per_share, fresh upper-bound pps)` when every NAV
//!    account is valid, and the breaker moves on the fresh EMA pps. If any is
//!    absent or invalid, the fee pps is `fund.last_price_per_share` and the
//!    breaker does not move. So the exiter cannot lower the fee by the choice
//!    of fresh vs stale prices.

use {
    crate::{
        constants::*,
        errors::ErrorCode,
        events::{Exited, FeeCharged},
        math,
        nav::{self, ValuationMode},
        state::{Config, Fund, Member, Policy},
    },
    anchor_lang::{error::ErrorCode as AnchorError, prelude::*},
    anchor_spl::{
        token::Token,
        token_2022::Token2022,
        token_interface::{self, Mint, TokenAccount},
    },
};

pub const EXIT_ACCOUNTS_PER_HOLDING: usize = 3;

#[derive(Accounts)]
pub struct Exit<'info> {
    pub user: Signer<'info>,
    /// Read only for `usdc_mint` (NAV). No pause check.
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
        seeds = [MEMBER_SEED, fund.key().as_ref(), user.key().as_ref()],
        bump = member.bump
    )]
    pub member: Box<Account<'info, Member>>,
    #[account(mut, address = fund.share_mint, mint::token_program = share_token_program)]
    pub share_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        mut,
        associated_token::mint = share_mint,
        associated_token::authority = user,
        associated_token::token_program = share_token_program
    )]
    pub user_shares: Box<InterfaceAccount<'info, TokenAccount>>,
    /// Receives fee shares. The same account as `user_shares` when the captain exits.
    #[account(
        mut,
        dup,
        associated_token::mint = share_mint,
        associated_token::authority = fund.captain,
        associated_token::token_program = share_token_program
    )]
    pub captain_shares: Box<InterfaceAccount<'info, TokenAccount>>,
    /// SPL Token, for holdings on the classic program (USDC).
    pub token_program: Program<'info, Token>,
    /// Token-2022: the share mint, and holdings on Token-2022.
    pub share_token_program: Program<'info, Token2022>,
}

pub fn exit<'info>(ctx: Context<'info, Exit<'info>>, shares: u64) -> Result<()> {
    let a = &ctx.accounts;
    let balance = a.user_shares.amount;
    require!(shares > 0 && shares <= balance, ErrorCode::ExitTooLarge);
    let now = Clock::get()?.unix_timestamp;
    let fund_key = a.fund.key();
    let user = a.user.key();
    let captain = a.fund.captain;
    let total = a.fund.total_shares;
    let len = a.fund.holdings_len as usize;

    let exit_len = len * EXIT_ACCOUNTS_PER_HOLDING;
    require!(
        ctx.remaining_accounts.len() >= exit_len,
        ErrorCode::HoldingNotFound
    );
    let (exit_accs, nav_accs) = ctx.remaining_accounts.split_at(exit_len);

    // Prices never block an exit: any NAV failure falls back to the last pps.
    // Fresh prices can only raise the fee pps, never lower it below the last pps.
    let fresh = fresh_pps(&a.fund, &fund_key, &a.config, nav_accs, now, ctx.program_id).ok();
    let last = a.fund.last_price_per_share;
    let pps = fresh.map_or(last, |(up, _)| up.max(last));

    let fund_id_le = a.fund.fund_id.to_le_bytes();
    let fund_seeds: &[&[u8]] = &[FUND_SEED, captain.as_ref(), &fund_id_le, &[a.fund.bump]];
    let signer = &[fund_seeds];

    // Performance fee on profit above the member's high-water mark. Not the captain.
    let mut hwm = a.member.hwm;
    let mut fee_shares = 0;
    if user != captain {
        let fee = math::performance_fee(balance, pps, hwm)?;
        if fee.fee_shares > 0 {
            fee_shares = fee.fee_shares;
            hwm = fee.new_hwm;
            token_interface::mint_to(
                CpiContext::new_with_signer(
                    a.share_token_program.key(),
                    token_interface::MintTo {
                        mint: a.share_mint.to_account_info(),
                        to: a.captain_shares.to_account_info(),
                        authority: a.fund.to_account_info(),
                    },
                    signer,
                ),
                fee_shares,
            )?;
            emit!(FeeCharged {
                fund: fund_key,
                member: user,
                fee_usdc: fee.fee_usdc,
                fee_shares,
                price_per_share: pps,
            });
        }
    }
    // The fee is at most 10% of the value, so some balance is left.
    let balance = balance
        .checked_sub(fee_shares)
        .ok_or(ErrorCode::MathOverflow)?;
    let shares = shares.min(balance);

    // Captain keeps >= 5% of the shares while anyone else holds shares.
    if user == captain && total > balance {
        let keep = (balance - shares) as u128 * BPS_DENOMINATOR as u128;
        let floor = (total - shares) as u128 * CAPTAIN_MIN_STAKE_BPS as u128;
        require!(keep >= floor, ErrorCode::CaptainStakeFloor);
    }

    // Pay out shares/total of each vault. `total` still counts the fee shares
    // (minted to the captain, burned from the user below), so it is the real supply.
    for (mint_key, accs) in a.fund.holdings[..len]
        .iter()
        .zip(exit_accs.chunks_exact(EXIT_ACCOUNTS_PER_HOLDING))
    {
        let (vault, to, mint) = (&accs[0], &accs[1], &accs[2]);
        let held = nav::vault_amount(vault, &fund_key, mint_key)?;
        require_keys_eq!(mint.key(), *mint_key, ErrorCode::HoldingNotFound);
        let out = math::pro_rata(held, shares, total)?;
        if out == 0 {
            continue;
        }
        require_keys_eq!(*mint.owner, *vault.owner, ErrorCode::HoldingNotFound);
        let decimals = InterfaceAccount::<Mint>::try_from(mint)?.decimals;
        let dest = InterfaceAccount::<TokenAccount>::try_from(to)?;
        require_keys_eq!(dest.mint, *mint_key, AnchorError::ConstraintTokenMint);
        require_keys_eq!(dest.owner, user, AnchorError::ConstraintTokenOwner);
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                *vault.owner,
                token_interface::TransferChecked {
                    from: vault.clone(),
                    mint: mint.clone(),
                    to: to.clone(),
                    authority: a.fund.to_account_info(),
                },
                signer,
            ),
            out,
            decimals,
        )?;
    }

    // One burn for the fee shares and the exited shares.
    token_interface::burn(
        CpiContext::new(
            a.share_token_program.key(),
            token_interface::Burn {
                mint: a.share_mint.to_account_info(),
                from: a.user_shares.to_account_info(),
                authority: a.user.to_account_info(),
            },
        ),
        shares
            .checked_add(fee_shares)
            .ok_or(ErrorCode::MathOverflow)?,
    )?;

    let fund = &mut ctx.accounts.fund;
    fund.total_shares = total.checked_sub(shares).ok_or(ErrorCode::MathOverflow)?;
    if let Some((_, ema_pps)) = fresh {
        nav::update_breaker(fund, &fund_key, &ctx.accounts.policy, ema_pps)?;
    }

    // Partial exit keeps the same share of the high-water mark.
    ctx.accounts.member.hwm = math::to_u64(math::mul_div_floor(
        hwm as u128,
        (balance - shares) as u128,
        balance as u128,
    )?)?;

    emit!(Exited {
        fund: fund_key,
        member: user,
        shares_burned: shares,
        fee_shares,
        price_per_share: pps,
    });
    Ok(())
}

/// `(fee pps from the upper-bound NAV, breaker pps from the EMA NAV)`.
fn fresh_pps(
    fund: &Fund,
    fund_key: &Pubkey,
    config: &Config,
    nav_accs: &[AccountInfo],
    now: i64,
    program_id: &Pubkey,
) -> Result<(u64, u64)> {
    let priced = nav::compute(fund, fund_key, config, nav_accs, now, program_id)?;
    let upper = priced.valuation(ValuationMode::DepositUpperBound)?.nav;
    let ema = priced.valuation(ValuationMode::Ema)?.nav;
    Ok((
        math::price_per_share(upper, fund.total_shares)?,
        math::price_per_share(ema, fund.total_shares)?,
    ))
}
