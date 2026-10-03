//! Fund NAV from real vault balances and Pyth prices, plus the drawdown breaker.
//!
//! Remaining-accounts layout, 3 per holding, in `fund.holdings` order:
//! `[vault_i, token_entry_i, price_i]`. USDC is valued 1:1; its entry and
//! price accounts are not read, but they must be present (uniform layout).

use {
    crate::{
        constants::{MAX_HOLDINGS, TOKEN_SEED},
        errors::ErrorCode,
        events::BreakerChanged,
        math, pyth,
        state::{Config, Fund, Policy, TokenEntry},
    },
    anchor_lang::prelude::*,
    anchor_spl::{
        associated_token::get_associated_token_address_with_program_id, token::ID as TOKEN_PROGRAM,
        token_2022::ID as TOKEN_2022_PROGRAM,
    },
};

pub const ACCOUNTS_PER_HOLDING: usize = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NavResult {
    /// Total fund value, USDC base units.
    pub nav: u128,
    /// Value of each holding, USDC base units; 0 past `holdings_len`.
    pub values: [u128; MAX_HOLDINGS],
}

pub fn compute(
    fund: &Fund,
    fund_key: &Pubkey,
    config: &Config,
    remaining: &[AccountInfo],
    now: i64,
    program_id: &Pubkey,
) -> Result<NavResult> {
    let len = fund.holdings_len as usize;
    require!(
        remaining.len() >= len * ACCOUNTS_PER_HOLDING,
        ErrorCode::PriceAccountMissing
    );
    let mut out = NavResult {
        nav: 0,
        values: [0; MAX_HOLDINGS],
    };
    for (i, (mint, accs)) in fund.holdings[..len]
        .iter()
        .zip(remaining.chunks_exact(ACCOUNTS_PER_HOLDING))
        .enumerate()
    {
        let amount = vault_amount(&accs[0], fund_key, mint)?;
        let value = if *mint == config.usdc_mint {
            amount as u128
        } else {
            let entry = token_entry(&accs[1], mint, program_id)?;
            let price = accs[2].try_borrow_data()?;
            let p = pyth::parse_price_update(accs[2].owner, &price, &entry.feed_id, now)?;
            math::token_value_usdc(amount, p.price, p.expo, entry.decimals)?
        };
        out.values[i] = value;
        out.nav = out.nav.checked_add(value).ok_or(ErrorCode::MathOverflow)?;
    }
    Ok(out)
}

/// The amount in `vault`, which must be ATA(fund, mint) on the token program that owns it.
fn vault_amount(vault: &AccountInfo, fund: &Pubkey, mint: &Pubkey) -> Result<u64> {
    let program = vault.owner;
    require!(
        *program == TOKEN_PROGRAM || *program == TOKEN_2022_PROGRAM,
        ErrorCode::HoldingNotFound
    );
    require_keys_eq!(
        vault.key(),
        get_associated_token_address_with_program_id(fund, mint, program),
        ErrorCode::HoldingNotFound
    );
    // Base token-account layout (both programs): mint 0..32, owner 32..64, amount 64..72.
    let data = vault.try_borrow_data()?;
    require!(data.len() >= 72, ErrorCode::HoldingNotFound);
    require!(
        data[..32] == mint.as_ref()[..] && data[32..64] == fund.as_ref()[..],
        ErrorCode::HoldingNotFound
    );
    Ok(u64::from_le_bytes(data[64..72].try_into().unwrap()))
}

/// The active registry entry of `mint`, at PDA `[b"token", mint]`.
fn token_entry(info: &AccountInfo, mint: &Pubkey, program_id: &Pubkey) -> Result<TokenEntry> {
    require_keys_eq!(*info.owner, *program_id, ErrorCode::TokenNotListed);
    let entry = TokenEntry::try_deserialize(&mut &info.try_borrow_data()?[..])
        .map_err(|_| ErrorCode::TokenNotListed)?;
    let pda =
        Pubkey::create_program_address(&[TOKEN_SEED, mint.as_ref(), &[entry.bump]], program_id)
            .map_err(|_| ErrorCode::TokenNotListed)?;
    require_keys_eq!(info.key(), pda, ErrorCode::TokenNotListed);
    require!(entry.active, ErrorCode::TokenInactive);
    Ok(entry)
}

/// Record `pps` and move the drawdown breaker: peak only rises; frozen while
/// `pps < peak * (1 - drawdown)`. Emits `BreakerChanged` when `frozen` flips.
pub fn update_breaker(fund: &mut Fund, fund_key: &Pubkey, policy: &Policy, pps: u64) -> Result<()> {
    fund.last_price_per_share = pps;
    fund.peak_price_per_share = fund.peak_price_per_share.max(pps);
    let keep_bps = 10_000u16
        .checked_sub(policy.params.drawdown_bps)
        .ok_or(ErrorCode::MathOverflow)?;
    let line = math::bps_of(fund.peak_price_per_share as u128, keep_bps)?;
    let frozen = (pps as u128) < line;
    if frozen != fund.frozen {
        fund.frozen = frozen;
        emit!(BreakerChanged {
            fund: *fund_key,
            frozen,
            price_per_share: pps,
            peak: fund.peak_price_per_share,
        });
    }
    Ok(())
}
