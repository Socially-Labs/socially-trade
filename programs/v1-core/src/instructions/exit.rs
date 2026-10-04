//! A member leaves with a pro-rata slice of every holding, in kind.
//! Never blocked: no pause, freeze or price check can stop an exit.
//!
//! Remaining accounts:
//! 1. 3 per holding: `[vault_i (w), user_token_i (w), mint_i]`. Matched to the
//!    holdings by mint key, in any order; each holding exactly once
//!    (`DuplicateHolding` for a repeat, `HoldingNotFound` for a non-holding mint
//!    or a short list).
//!    `user_token_i` is the user's token account for `mint_i` on the mint's
//!    token program. It is not read when the user's slice of that holding is 0.
//! 2. Optional, after that: the NAV layout (see `nav`). The fee pps is
//!    `max(fund.last_price_per_share, fresh ExitFeeUpperBound pps)` when every NAV
//!    account is valid (T3 holdings at no less than cost, see
//!    `NavResult::nav_at_least_cost`), and the breaker moves on the fresh
//!    prices. If any is absent or invalid, the fee pps is `fund.last_price_per_share` and the
//!    breaker does not move. So the exiter cannot lower the fee by the choice
//!    of fresh vs stale prices.
//!
//! 3. Optional, after the NAV layout: the captain's Member PDA (w), for the
//!    first-loss burn below.
//!
//! One exception to "no price check": while the fund holds T3 cost basis and
//! others hold shares, a captain exit needs valid fresh prices (see below).
//!
//! First loss. When a crew member exits with valid prices, the exit pays
//! the member's part of the unrealized T3 loss from captain shares:
//! `comp = t3_loss x shares / total_shares`, rounded up (`NavResult::t3_loss`:
//! a Switchboard holding at its slow deposit mark only, a Pyth or Kamino
//! holding at the higher of spot and EMA, a holding in its mark warmup
//! counts no loss). The fund PDA burns captain shares worth
//! `comp` at the true pps, the recorded NAV less `t3_loss`
//! (`swap::burn_nav`), at most the captain's balance (the captain exit floor
//! does not apply), and the member redeems them too:
//! `(shares + burned) / total_shares` of every holding. Then the Member PDA
//! of item 3 is required (`CaptainMemberMissing`): a priced exit does not
//! drop the compensation in silence. An exit without prices pays no
//! compensation. The captain gets none.

use {
    crate::{
        constants::*,
        errors::ErrorCode,
        events::{Exited, FeeCharged, FirstLossApplied},
        instructions::swap::{burn_nav, captain_stake},
        math,
        nav::{self, ValuationMode, ACCOUNTS_PER_HOLDING},
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
    let pps = fresh.map_or(last, |f| f.fee.max(last));

    let fund_id_le = a.fund.fund_id.to_le_bytes();
    let fund_seeds: &[&[u8]] = &[FUND_SEED, captain.as_ref(), &fund_id_le, &[a.fund.bump]];
    let signer = &[fund_seeds];

    // Performance fee on profit above the member's high-water mark. Not the captain.
    let mut hwm = a.member.hwm;
    let mut fee_shares = 0;
    if user != captain {
        let fee = charge_fee(
            &a.share_token_program,
            &a.share_mint,
            &a.captain_shares,
            &a.fund,
            signer,
            user,
            balance,
            pps,
            hwm,
        )?;
        fee_shares = fee.fee_shares;
        hwm = fee.new_hwm;
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

        // While T3 is held, the stake left must cover the T3 basis left, at
        // the fresh pps of the lower of spot and the slow price, so a pump
        // cannot let the captain out. A stale pps must not let the captain
        // leave early, so this needs valid prices (the call below returns the error).
        let basis = a.fund.t3_cost_basis_usd;
        if basis > 0 {
            let low = match fresh {
                Some(f) => f.stake,
                None => {
                    fresh_pps(&a.fund, &fund_key, &a.config, nav_accs, now, ctx.program_id)?.stake
                }
            };
            let stake = math::value_of_shares(balance - shares, low)?;
            let basis_left = math::pro_rata(basis, total - shares, total)?;
            require!(stake >= basis_left, ErrorCode::CaptainStakeFloor);
        }
    }

    // First loss (module doc). The member gets `comp` in kind, so the
    // burned shares are priced at the true pps: the record less the loss.
    let mut burned = 0;
    if let Some(f) = fresh.filter(|f| user != captain && f.t3_loss > 0 && last > 0) {
        let comp = f
            .t3_loss
            .checked_mul(shares as u128)
            .ok_or(ErrorCode::MathOverflow)?
            .div_ceil(total as u128);
        if comp > 0 {
            let member_info = nav_accs
                .get(len * ACCOUNTS_PER_HOLDING)
                .ok_or(ErrorCode::CaptainMemberMissing)?;
            let shares_info = a.captain_shares.to_account_info();
            let mint_info = a.share_mint.to_account_info();
            let program_info = a.share_token_program.to_account_info();
            let mut stake = captain_stake(
                &a.fund,
                member_info,
                &shares_info,
                &mint_info,
                &program_info,
            )?;
            burned = stake.shares_worth(comp, burn_nav(&a.fund, f.t3_loss)?, total)?;
            if burned > 0 {
                stake.burn(&a.fund, burned)?;
            }
            emit!(FirstLossApplied {
                fund: fund_key,
                loss_usd: math::to_u64(comp)?,
                captain_shares_burned: burned,
            });
        }
    }
    // The member redeems its shares and the burned captain shares.
    let redeemed = shares.checked_add(burned).ok_or(ErrorCode::MathOverflow)?;

    // Pay out redeemed/total of each vault. `total` still counts the fee shares
    // (minted to the captain, burned from the user below), so it is the real supply.
    // Triples are matched to holdings by mint key, in any order (a swap-remove
    // can reorder holdings after the client built the list). `len` triples,
    // each a holding and none twice, cover every holding exactly once.
    let mut seen = [false; MAX_HOLDINGS];
    let mut left = [0u64; MAX_HOLDINGS];
    for accs in exit_accs.chunks_exact(EXIT_ACCOUNTS_PER_HOLDING) {
        let (vault, to, mint) = (&accs[0], &accs[1], &accs[2]);
        let mint_key = mint.key;
        let i = a.fund.holdings[..len]
            .iter()
            .position(|h| h == mint_key)
            .ok_or(ErrorCode::HoldingNotFound)?;
        require!(!seen[i], ErrorCode::DuplicateHolding);
        seen[i] = true;
        let held = nav::vault_amount(vault, &fund_key, mint_key)?;
        let out = math::pro_rata(held, redeemed, total)?;
        left[i] = held - out;
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
    fund.total_shares = total.checked_sub(redeemed).ok_or(ErrorCode::MathOverflow)?;
    // Every holding fell by redeemed/total, so the T3 cost basis does too.
    // Rounded up while the holding keeps units, so a basis never reaches 0
    // with units left (they would be unbased).
    if fund.t3_cost_basis_usd > 0 {
        let mut sum: u64 = 0;
        for (b, &units) in fund.t3_basis_usd.iter_mut().zip(left.iter()) {
            let scaled = *b as u128 * (total - redeemed) as u128;
            *b = math::to_u64(if units > 0 {
                scaled.div_ceil(total as u128)
            } else {
                scaled / total as u128
            })?;
            sum = sum.checked_add(*b).ok_or(ErrorCode::MathOverflow)?;
        }
        fund.t3_cost_basis_usd = sum;
    }
    if let Some(f) = fresh {
        nav::update_breaker(fund, &fund_key, &ctx.accounts.policy, f.breaker)?;
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

/// Performance fee on `balance` shares at `pps`: mint the fee shares to the
/// captain and emit `FeeCharged`. Does nothing when the fee is 0. The caller
/// burns the same shares from the member and stores `new_hwm`.
#[allow(clippy::too_many_arguments)]
pub(crate) fn charge_fee<'info>(
    token_program: &Program<'info, Token2022>,
    share_mint: &InterfaceAccount<'info, Mint>,
    captain_shares: &InterfaceAccount<'info, TokenAccount>,
    fund: &Account<'info, Fund>,
    signer: &[&[&[u8]]],
    member: Pubkey,
    balance: u64,
    pps: u64,
    hwm: u64,
) -> Result<math::FeeOutcome> {
    let fee = math::performance_fee(balance, pps, hwm)?;
    if fee.fee_shares > 0 {
        token_interface::mint_to(
            CpiContext::new_with_signer(
                token_program.key(),
                token_interface::MintTo {
                    mint: share_mint.to_account_info(),
                    to: captain_shares.to_account_info(),
                    authority: fund.to_account_info(),
                },
                signer,
            ),
            fee.fee_shares,
        )?;
        emit!(FeeCharged {
            fund: fund.key(),
            member,
            fee_usdc: fee.fee_usdc,
            fee_shares: fee.fee_shares,
            price_per_share: pps,
        });
    }
    Ok(fee)
}

/// Price per share of fresh valid prices, by use.
#[derive(Clone, Copy)]
pub(crate) struct FreshPps {
    /// Exit fee pps (`ExitFeeUpperBound`, T3 holdings at no less than cost).
    pub fee: u64,
    /// Captain stake pps (`StakeLowerBound`).
    pub stake: u64,
    /// Breaker inputs; `breaker.pps` is the target of the recorded pps.
    pub breaker: nav::BreakerPps,
    /// Unrealized T3 loss (`NavResult::t3_loss`), USD.
    pub t3_loss: u128,
}

pub(crate) fn fresh_pps(
    fund: &Fund,
    fund_key: &Pubkey,
    config: &Config,
    nav_accs: &[AccountInfo],
    now: i64,
    program_id: &Pubkey,
) -> Result<FreshPps> {
    let priced = nav::compute(fund, fund_key, config, nav_accs, now, program_id)?;
    let pps = |nav| -> Result<u64> { Ok(math::price_per_share(nav, fund.total_shares)?) };
    Ok(FreshPps {
        fee: pps(priced.nav_at_least_cost(ValuationMode::ExitFeeUpperBound)?)?,
        stake: pps(priced.valuation(ValuationMode::StakeLowerBound)?.nav)?,
        breaker: priced.breaker(fund.total_shares)?,
        t3_loss: priced.t3_loss()?,
    })
}
