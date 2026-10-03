//! Fund NAV from real vault balances and oracle prices, plus the drawdown breaker.
//!
//! Remaining-accounts layout, 4 per holding, in `fund.holdings` order:
//! `[vault_i, token_entry_i, price_a_i, price_b_i]`. The two price accounts
//! depend on the token's `PriceSource`:
//! - Pyth: `price_a` = PriceUpdateV2; `price_b` is not read (pass any key).
//! - KaminoReserve: `price_a` = the reserve in the entry (owner Kamino Lend,
//!   refreshed: see `kamino`); `price_b` = the underlying's PriceUpdateV2.
//!   A kToken amount is converted to underlying base units at the reserve
//!   rate, then valued like a Pyth token (all modes, underlying EMA and conf).
//! - Switchboard: `price_a` = the On-Demand pull feed in the entry (see
//!   `switchboard`); `price_b` is not read. The feed has no EMA: Spot and Ema
//!   use the feed value, DepositUpperBound adds the feed's std_dev.
//!
//! USDC is valued 1:1; its entry and price accounts are not read, but they
//! must be present (uniform layout). This module is the only place that
//! knows the layout: other code uses the constants and `price`.

use {
    crate::{
        constants::{MAX_HOLDINGS, TOKEN_SEED},
        errors::ErrorCode,
        events::BreakerChanged,
        kamino::{self, KaminoRate},
        math, pyth,
        state::{Config, Fund, Policy, PriceSource, Tier, TokenEntry},
        switchboard,
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
    /// Spot price of the token's price source.
    Spot,
    /// `max(price, ema_price) + conf`: an upper bound, so a depositor cannot
    /// pick a low in-window price to get more shares.
    DepositUpperBound,
    /// EMA price of the price source (the spot value for a source without
    /// one): slow to move, for the breaker / peak / recorded pps.
    Ema,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Valuation {
    /// Total fund value, USDC base units.
    pub nav: u128,
    /// Value of each holding, USDC base units; 0 past `holdings_len`.
    pub values: [u128; MAX_HOLDINGS],
}

/// The validated price of a listed token.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TokenPrice {
    /// Pyth price of the token, or of the underlying for a kToken. A
    /// Switchboard price in the same shape (`SbPrice::to_pyth`).
    pub pyth: pyth::PythPrice,
    /// Decimals `pyth` prices: the token's, or the underlying's for a kToken.
    pub decimals: u8,
    /// kToken -> underlying rate; None for a plain Pyth token.
    pub rate: Option<KaminoRate>,
}

impl TokenPrice {
    /// USDC value of `amount` base units, priced in `mode`, floor.
    pub fn value(&self, amount: u64, mode: ValuationMode) -> Result<u128> {
        let p = &self.pyth;
        let amount = match self.rate {
            Some(r) => r.to_underlying(amount)?,
            None => amount,
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
        Ok(math::token_value_usdc(
            amount,
            price,
            p.expo,
            self.decimals,
        )?)
    }

    /// Token base units worth `usd` USDC base units at the spot price, floor.
    pub fn amount_for(&self, usd: u128) -> Result<u128> {
        let p = &self.pyth;
        let amount = math::usdc_to_token(usd, p.price, p.expo, self.decimals)?;
        Ok(match self.rate {
            Some(r) => r.to_ktokens(amount)?,
            None => amount,
        })
    }
}

/// Validated vault amounts and prices. Read once, value in any mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NavResult {
    pub len: usize,
    pub amounts: [u64; MAX_HOLDINGS],
    /// `None` = USDC (1:1).
    pub prices: [Option<TokenPrice>; MAX_HOLDINGS],
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
        match self.prices[i] {
            Some(p) => p.value(amount, mode),
            None => Ok(amount as u128),
        }
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
            out.prices[i] = Some(price(&entry, &accs[2..], now)?);
            out.t2[i] = entry.tier == Tier::T2;
        }
    }
    Ok(out)
}

/// The price of a listed token from its `[price_a, price_b]` accounts.
pub(crate) fn price(entry: &TokenEntry, accs: &[AccountInfo], now: i64) -> Result<TokenPrice> {
    require!(accs.len() >= PRICE_ACCOUNTS, ErrorCode::PriceAccountMissing);
    let pyth_at = |a: &AccountInfo, feed: &[u8; 32]| -> Result<pyth::PythPrice> {
        Ok(pyth::parse_price_update(
            a.owner,
            &a.try_borrow_data()?,
            feed,
            now,
        )?)
    };
    match entry.price_source {
        PriceSource::Pyth { feed_id } => Ok(TokenPrice {
            pyth: pyth_at(&accs[0], &feed_id)?,
            decimals: entry.decimals,
            rate: None,
        }),
        PriceSource::KaminoReserve {
            reserve,
            underlying_feed_id,
            underlying_decimals,
        } => {
            let r = &accs[0];
            require_keys_eq!(r.key(), reserve, ErrorCode::ReserveMismatch);
            let rate = kamino::parse_reserve(
                r.owner,
                &r.try_borrow_data()?,
                &entry.mint,
                underlying_decimals,
                Clock::get()?.slot,
            )?;
            Ok(TokenPrice {
                pyth: pyth_at(&accs[1], &underlying_feed_id)?,
                decimals: underlying_decimals,
                rate: Some(rate),
            })
        }
        PriceSource::Switchboard {
            feed,
            feed_hash,
            queue,
        } => {
            let a = &accs[0];
            let p = switchboard::parse_feed(
                a.key,
                a.owner,
                &a.try_borrow_data()?,
                &feed,
                &feed_hash,
                &queue,
                Clock::get()?.slot,
            )?;
            Ok(TokenPrice {
                pyth: p.to_pyth()?,
                decimals: entry.decimals,
                rate: None,
            })
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
