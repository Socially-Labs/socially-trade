//! Fund NAV from real vault balances and oracle prices, plus the drawdown breaker.
//!
//! Remaining-accounts layout, 4 per holding, in `fund.holdings` order:
//! `[vault_i, token_entry_i, price_a_i, price_b_i]`. The two price accounts
//! depend on the token's `PriceSource`:
//! - Pyth: `price_a` = PriceUpdateV2; `price_b` is not read (pass any key).
//! - KaminoReserve: `price_a` = reserve; `price_b` = the underlying's PriceUpdateV2.
//! - Switchboard: `price_a` = the feed; `price_b` is not read.
//!
//! Only the Pyth arm prices today; the others fail with `PriceSourceUnsupported`.
//! USDC is valued 1:1; its entry and price accounts are not read, but they
//! must be present (uniform layout). This module is the only place that
//! knows the layout: other code uses the constants and `price`.

use {
    crate::{
        constants::{MAX_HOLDINGS, TOKEN_SEED},
        errors::ErrorCode,
        events::BreakerChanged,
        math, pyth,
        state::{Config, Fund, Policy, PriceSource, Tier, TokenEntry},
    },
    anchor_lang::prelude::*,
    anchor_spl::{
        associated_token::get_associated_token_address_with_program_id, token::ID as TOKEN_PROGRAM,
        token_2022::ID as TOKEN_2022_PROGRAM,
    },
};

/// `[price_a, price_b]` of one token.
pub const PRICE_ACCOUNTS: usize = 2;
/// `[vault, token_entry]` + the price accounts.
pub const ACCOUNTS_PER_HOLDING: usize = 2 + PRICE_ACCOUNTS;

/// How a non-USDC holding is priced. USDC is always 1:1.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ValuationMode {
    /// Pyth spot price.
    Spot,
    /// `max(price, ema_price) + conf`: an upper bound, so a depositor cannot
    /// pick a low in-window price to get more shares.
    DepositUpperBound,
    /// Pyth EMA price: slow to move, for the breaker / peak / recorded pps.
    Ema,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Valuation {
    /// Total fund value, USDC base units.
    pub nav: u128,
    /// Value of each holding, USDC base units; 0 past `holdings_len`.
    pub values: [u128; MAX_HOLDINGS],
}

/// Validated vault amounts and prices. Read once, value in any mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NavResult {
    pub len: usize,
    pub amounts: [u64; MAX_HOLDINGS],
    /// `None` = USDC (1:1). Otherwise the price and the token's decimals.
    pub prices: [Option<(pyth::PythPrice, u8)>; MAX_HOLDINGS],
    /// True for a T2 holding (tier caps).
    pub t2: [bool; MAX_HOLDINGS],
}

impl NavResult {
    pub fn valuation(&self, mode: ValuationMode) -> Result<Valuation> {
        let mut out = Valuation {
            nav: 0,
            values: [0; MAX_HOLDINGS],
        };
        for i in 0..self.len {
            let value = self.value_at(i, self.amounts[i], mode)?;
            out.values[i] = value;
            out.nav = out.nav.checked_add(value).ok_or(ErrorCode::MathOverflow)?;
        }
        Ok(out)
    }

    /// USDC value of `amount` base units of holding `i`, priced in `mode`.
    pub fn value_at(&self, i: usize, amount: u64, mode: ValuationMode) -> Result<u128> {
        let Some((p, decimals)) = self.prices[i] else {
            return Ok(amount as u128);
        };
        let price = match mode {
            ValuationMode::Spot => p.price,
            ValuationMode::DepositUpperBound => {
                let hi = p.price.max(p.ema_price) as i128 + p.conf as i128;
                i64::try_from(hi).map_err(|_| ErrorCode::MathOverflow)?
            }
            ValuationMode::Ema => {
                require!(p.ema_price > 0, ErrorCode::PriceNonPositive);
                p.ema_price
            }
        };
        Ok(math::token_value_usdc(amount, price, p.expo, decimals)?)
    }
}

/// Read and validate every holding's vault, registry entry and price.
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
        len,
        amounts: [0; MAX_HOLDINGS],
        prices: [None; MAX_HOLDINGS],
        t2: [false; MAX_HOLDINGS],
    };
    for (i, (mint, accs)) in fund.holdings[..len]
        .iter()
        .zip(remaining.chunks_exact(ACCOUNTS_PER_HOLDING))
        .enumerate()
    {
        out.amounts[i] = vault_amount(&accs[0], fund_key, mint)?;
        if *mint != config.usdc_mint {
            let entry = token_entry(&accs[1], mint, program_id)?;
            let p = price(&entry, &accs[2..], now)?;
            out.prices[i] = Some((p, entry.decimals));
            out.t2[i] = entry.tier == Tier::T2;
        }
    }
    Ok(out)
}

/// The price of a listed token from its `[price_a, price_b]` accounts.
pub(crate) fn price(entry: &TokenEntry, accs: &[AccountInfo], now: i64) -> Result<pyth::PythPrice> {
    require!(accs.len() >= PRICE_ACCOUNTS, ErrorCode::PriceAccountMissing);
    match entry.price_source {
        PriceSource::Pyth { feed_id } => {
            let a = &accs[0];
            Ok(pyth::parse_price_update(
                a.owner,
                &a.try_borrow_data()?,
                &feed_id,
                now,
            )?)
        }
        PriceSource::KaminoReserve { .. } | PriceSource::Switchboard { .. } => {
            err!(ErrorCode::PriceSourceUnsupported)
        }
    }
}

/// The amount in `vault`, which must be ATA(fund, mint) on the token program that owns it.
pub(crate) fn vault_amount(vault: &AccountInfo, fund: &Pubkey, mint: &Pubkey) -> Result<u64> {
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
pub(crate) fn token_entry(
    info: &AccountInfo,
    mint: &Pubkey,
    program_id: &Pubkey,
) -> Result<TokenEntry> {
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
