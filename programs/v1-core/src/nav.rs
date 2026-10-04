//! Fund NAV from real vault balances and oracle prices, plus the drawdown breaker.
//!
//! Remaining-accounts layout, 4 per holding, in `fund.holdings` order:
//! `[vault_i, token_entry_i, price_a_i, price_b_i]`. `token_entry_i` must be
//! writable for a Switchboard token (it holds the mark, see below), and may be
//! read only for any other token. The two price accounts depend on the
//! token's `PriceSource`:
//! - Pyth: `price_a` = PriceUpdateV2; `price_b` is not read (pass any key).
//! - KaminoReserve: `price_a` = the reserve in the entry (owner Kamino Lend,
//!   refreshed: see `kamino`); `price_b` = the underlying's PriceUpdateV2.
//!   A kToken amount is converted to underlying base units at the reserve
//!   rate, then valued like a Pyth token (all modes, underlying EMA and conf).
//! - Switchboard: `price_a` = the On-Demand pull feed in the entry (see
//!   `switchboard`); `price_b` is not read. The feed has no EMA, so the entry
//!   keeps two slow mark prices (`switchboard::next_marks`), moved and stored
//!   by every read. The deposit mark (the slow mark) moves at most 10% per
//!   150 slots both ways; it is the token's EMA. The low mark drops to
//!   the value at once and rises at most 10% per 150 slots; it serves only
//!   the captain stake (StakeLowerBound) and the breaker trip check
//!   (BreakerCheck). Spot uses the feed value; DepositUpperBound and High
//!   `max(value, deposit mark)` (+ std_dev for the deposit); Ema the deposit
//!   mark; ExitFeeUpperBound `min(value, deposit mark) + std_dev`, so marks
//!   seeded at a pump do not raise the exit fee.
//!
//! Warmup: for `MARK_WARMUP_SLOTS` after a Switchboard token's marks are
//! seeded (first read, or a new price source), `NavResult::warming` is true:
//! callers do not record the peak or `last_price_per_share` (`update_breaker`
//! with `record = false`; the breaker can still trip), and the holding counts
//! 0 toward the captain stake.
//!
//! T3 cost floor: the deposit price, the exit fee price and the record target
//! value each holding at no less than its T3 cost basis
//! (`NavResult::nav_at_least_cost`), so a dump cannot lower them below cost.
//! Pumps stay capped as above. The breaker check and the captain stake use no
//! floor, so a real crash below cost still trips the breaker.
//!
//! Sales into USDC (`compute_for_usdc_sale`): a holding other than the
//! input whose entry or price does not read counts 0
//! (`NavResult::unpriced`), so one broken feed cannot block a sale of
//! another holding. Such a read stores no mark, and the caller writes no
//! breaker state.
//!
//! USDC is valued 1:1; its entry and price accounts are not read, but they
//! must be present (uniform layout). This module is the only place that
//! knows the layout: other code uses the constants and `price`.

use {
    crate::{
        constants::{
            BPS_DENOMINATOR, MARK_INTERVAL_SLOTS, MARK_MAX_STEP_BPS, MAX_HOLDINGS, TOKEN_SEED,
        },
        errors::ErrorCode,
        events::BreakerChanged,
        kamino::{self, KaminoRate},
        math, pyth,
        state::{Config, Fund, Marks, Policy, PriceSource, Tier, TokenEntry},
        switchboard,
    },
    anchor_lang::{error::ErrorCode as AnchorError, prelude::*},
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
    /// EMA price of the price source (the deposit mark for a Switchboard
    /// token): slow both ways, for the recorded pps / peak and the annual fee.
    Ema,
    /// `min(price, low)`, low = the low mark for a Switchboard token, else the
    /// EMA: a lower bound, so a pump cannot raise the captain stake value (T3
    /// caps, captain exit floor). A warming Switchboard holding counts 0.
    StakeLowerBound,
    /// `max(price, ema_price)`, no confidence: a dump cannot lower a value.
    High,
    /// The exit fee price: DepositUpperBound, except a Switchboard token at
    /// `min(price, ema_price) + conf` (ema = the slow mark): neither a pump
    /// nor marks seeded at a pump raise it. Exit takes the max with the
    /// recorded pps, so a dump does not lower the fee.
    ExitFeeUpperBound,
    /// The breaker trip check: the low mark for a Switchboard token (a real
    /// crash trips at once), else the EMA.
    BreakerCheck,
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
    /// Switchboard only: the low mark at `pyth.expo` (`pyth.ema_price` is
    /// the deposit mark).
    pub low_mark: Option<i64>,
    /// Switchboard only: the marks are in their warmup (`Marks::warming`).
    pub warming: bool,
}

impl TokenPrice {
    /// USDC value of `amount` base units, priced in `mode`, floor.
    pub fn value(&self, amount: u64, mode: ValuationMode) -> Result<u128> {
        let p = &self.pyth;
        let amount = match self.rate {
            Some(r) => r.to_underlying(amount)?,
            None => amount,
        };
        let high = p.price.max(p.ema_price);
        let low = self.low_mark.unwrap_or(p.ema_price);
        let plus_conf = |price: i64| -> Result<i64> {
            i64::try_from(price as i128 + p.conf as i128)
                .map_err(|_| error!(ErrorCode::MathOverflow))
        };
        let positive = |price: i64| -> Result<i64> {
            require!(price > 0, ErrorCode::PriceNonPositive);
            Ok(price)
        };
        let price = match mode {
            ValuationMode::Spot => p.price,
            ValuationMode::DepositUpperBound => plus_conf(high)?,
            ValuationMode::ExitFeeUpperBound => match self.low_mark {
                Some(_) => plus_conf(p.price.min(p.ema_price))?,
                None => plus_conf(high)?,
            },
            ValuationMode::StakeLowerBound if self.warming => return Ok(0),
            ValuationMode::StakeLowerBound => positive(p.price.min(low))?,
            ValuationMode::BreakerCheck => positive(low)?,
            ValuationMode::Ema => {
                require!(p.ema_price > 0, ErrorCode::PriceNonPositive);
                p.ema_price
            }
            ValuationMode::High => high,
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
    /// T3 cost basis of each holding, USD (6 dp), from `fund.t3_basis_usd`:
    /// the floor of `nav_at_least_cost`.
    pub basis: [u64; MAX_HOLDINGS],
    /// True for a holding whose price did not read (`compute_for_usdc_sale`
    /// only): it counts 0 in every mode.
    pub unpriced: [bool; MAX_HOLDINGS],
}

/// What `update_breaker` needs from one NAV read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BreakerPps {
    /// `min(Spot pps, Ema pps)`, each NAV at least at cost
    /// (`nav_at_least_cost`): the target of `last_price_per_share`.
    pub pps: u64,
    /// BreakerCheck pps: the trip check.
    pub check: u64,
    /// False during a mark warmup: record nothing, only trip.
    pub record: bool,
}

impl NavResult {
    /// The breaker inputs of this read for `total_shares`.
    pub fn breaker(&self, total_shares: u64) -> Result<BreakerPps> {
        let pps = |nav: u128| -> Result<u64> { Ok(math::price_per_share(nav, total_shares)?) };
        // Marks seeded at a pump stay above the spot for many intervals; the
        // lower of the two keeps the record and the peak off them. A dump
        // cannot take a T3 holding under its cost.
        let record = self
            .nav_at_least_cost(ValuationMode::Ema)?
            .min(self.nav_at_least_cost(ValuationMode::Spot)?);
        Ok(BreakerPps {
            pps: pps(record)?,
            check: pps(self.valuation(ValuationMode::BreakerCheck)?.nav)?,
            record: !self.warming(),
        })
    }

    /// Every holding has a price (no `unpriced` holding).
    pub fn complete(&self) -> bool {
        !self.unpriced[..self.len].contains(&true)
    }

    /// A held (or newly bought) Switchboard token is in its mark warmup:
    /// do not record the peak or the last pps.
    pub fn warming(&self) -> bool {
        self.prices[..self.len]
            .iter()
            .any(|p| p.is_some_and(|p| p.warming))
    }

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

    /// NAV in `mode`, with each holding valued at no less than its T3 cost
    /// basis. In Open Seas the captain stake (capped at >= the T3 basis)
    /// backs the crew's T3 holdings at cost, so a dump below cost must not
    /// lower a fee price or the deposit price. Holdings without a basis
    /// keep their `mode` value. Not for sizes, caps or the breaker check.
    pub fn nav_at_least_cost(&self, mode: ValuationMode) -> Result<u128> {
        let v = self.valuation(mode)?;
        v.values[..self.len]
            .iter()
            .zip(&self.basis)
            .try_fold(0u128, |nav, (&value, &basis)| {
                nav.checked_add(value.max(basis as u128))
            })
            .ok_or_else(|| error!(ErrorCode::MathOverflow))
    }

    /// Unrealized T3 loss: the sum over based holdings of `basis - value`
    /// where positive. A Switchboard holding is valued at its deposit mark
    /// only (`Ema`): its spot follows a pool, so a pump would cancel the
    /// loss and a dump would raise it; the mark moves one step per interval.
    /// Pyth and Kamino holdings at `High` (spot or EMA, the higher), so a
    /// dump does not raise it. A holding in its mark warmup counts no loss.
    pub fn t3_loss(&self) -> Result<u128> {
        let mut loss: u128 = 0;
        for i in 0..self.len {
            let basis = self.basis[i] as u128;
            if basis == 0 || self.prices[i].is_some_and(|p| p.warming) {
                continue;
            }
            let mode = match self.prices[i] {
                Some(p) if p.low_mark.is_some() => ValuationMode::Ema,
                _ => ValuationMode::High,
            };
            let value = self.value_at(i, self.amounts[i], mode)?;
            loss = loss
                .checked_add(basis.saturating_sub(value))
                .ok_or(ErrorCode::MathOverflow)?;
        }
        Ok(loss)
    }

    /// USDC value of `amount` base units of holding `i`, priced in `mode`.
    pub fn value_at(&self, i: usize, amount: u64, mode: ValuationMode) -> Result<u128> {
        if self.unpriced[i] {
            return Ok(0);
        }
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
    read_nav(fund, fund_key, config, remaining, now, program_id, None)
}

/// `compute` for a sale of holding `input` into USDC. The input must price;
/// any other holding whose registry entry or price does not read counts 0
/// (`NavResult::unpriced`). A 0 value lowers the NAV, so the size limits of
/// the trade get stricter, never looser. When a read fails, the trade
/// stores no mark at all.
pub fn compute_for_usdc_sale(
    fund: &Fund,
    fund_key: &Pubkey,
    config: &Config,
    remaining: &[AccountInfo],
    now: i64,
    program_id: &Pubkey,
    input: usize,
) -> Result<NavResult> {
    read_nav(
        fund,
        fund_key,
        config,
        remaining,
        now,
        program_id,
        Some(input),
    )
}

/// `compute`; with `tolerate = Some(input)`, `compute_for_usdc_sale`. The
/// moved marks are stored after every read passed.
#[inline(never)]
fn read_nav(
    fund: &Fund,
    fund_key: &Pubkey,
    config: &Config,
    remaining: &[AccountInfo],
    now: i64,
    program_id: &Pubkey,
    tolerate: Option<usize>,
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
        basis: fund.t3_basis_usd,
        unpriced: [false; MAX_HOLDINGS],
    };
    let mut marks: [Option<Marks>; MAX_HOLDINGS] = [None; MAX_HOLDINGS];
    let holdings = fund.holdings[..len]
        .iter()
        .zip(remaining.chunks_exact(ACCOUNTS_PER_HOLDING));
    for (i, (mint, accs)) in holdings.clone().enumerate() {
        out.amounts[i] = vault_amount(&accs[0], fund_key, mint)?;
        if *mint == config.usdc_mint {
            continue;
        }
        let read = token_entry(&accs[1], mint, program_id).and_then(|mut entry| {
            out.t2[i] = entry.tier == Tier::T2;
            price_with_marks(&accs[1], &mut entry, &accs[2..], now)
        });
        match read {
            Ok((price, moved)) => {
                out.prices[i] = Some(price);
                marks[i] = moved;
            }
            Err(_) if tolerate.is_some_and(|input| input != i) => {
                out.t2[i] = false;
                out.unpriced[i] = true;
            }
            Err(e) => return Err(e),
        }
    }
    if out.complete() {
        for ((_, accs), m) in holdings.zip(marks) {
            if let Some(m) = m {
                let info = &accs[1];
                let mut entry = TokenEntry::try_deserialize(&mut &info.try_borrow_data()?[..])?;
                entry.marks = m;
                entry.try_serialize(&mut &mut info.try_borrow_mut_data()?[..])?;
            }
        }
    }
    Ok(out)
}

/// `price`, then store the moved mark of a Switchboard token in `info`, the
/// entry's account (`entry` read from it). For a Switchboard token `info`
/// must be writable (`ConstraintMut`), whether or not the mark moves.
pub(crate) fn price_and_store_mark(
    info: &AccountInfo,
    mut entry: TokenEntry,
    accs: &[AccountInfo],
    now: i64,
) -> Result<TokenPrice> {
    let (p, moved) = price_with_marks(info, &mut entry, accs, now)?;
    if moved.is_some() {
        entry.try_serialize(&mut &mut info.try_borrow_mut_data()?[..])?;
    }
    Ok(p)
}

/// `price`, and the moved marks of a Switchboard token to store (None when
/// they did not move, or for any other source). For a Switchboard token
/// `info`, the entry's account, must be writable (`ConstraintMut`), whether
/// or not the marks move.
fn price_with_marks(
    info: &AccountInfo,
    entry: &mut TokenEntry,
    accs: &[AccountInfo],
    now: i64,
) -> Result<(TokenPrice, Option<Marks>)> {
    if !matches!(entry.price_source, PriceSource::Switchboard { .. }) {
        return Ok((price(entry, accs, now)?, None));
    }
    require!(info.is_writable, AnchorError::ConstraintMut);
    let before = entry.marks;
    let p = price(entry, accs, now)?;
    Ok((p, (entry.marks != before).then_some(entry.marks)))
}

/// The price of a listed token from its `[price_a, price_b]` accounts. For a
/// Switchboard token this moves `entry`'s marks (`switchboard::next_marks`);
/// the caller stores it (`price_and_store_mark`).
fn price(entry: &mut TokenEntry, accs: &[AccountInfo], now: i64) -> Result<TokenPrice> {
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
            low_mark: None,
            warming: false,
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
                low_mark: None,
                warming: false,
            })
        }
        PriceSource::Switchboard {
            feed,
            feed_hash,
            queue,
        } => {
            let a = &accs[0];
            let slot = Clock::get()?.slot;
            let p = switchboard::parse_feed(
                a.key,
                a.owner,
                &a.try_borrow_data()?,
                &feed,
                &feed_hash,
                &queue,
                slot,
            )?;
            entry.marks = switchboard::next_marks(entry.marks, p.value, slot);
            let (pyth, low_mark) = p.to_pyth(&entry.marks)?;
            Ok(TokenPrice {
                pyth,
                decimals: entry.decimals,
                rate: None,
                low_mark: Some(low_mark),
                warming: entry.marks.warming(slot),
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

/// Record `pps` (the lower of the Spot and Ema pps) and move the drawdown
/// breaker.
/// `last_price_per_share` moves toward `pps` at most once per
/// `MARK_INTERVAL_SLOTS`, by at most `MARK_MAX_STEP_BPS` of itself, for every
/// price source, so no pump or dump moves the recorded pps (the deposit
/// floor, the exit fee floor, the annual fee price) faster. The peak follows
/// the recorded pps only. Frozen while `check < peak * (1 - drawdown)`
/// (`check` = the fresh BreakerCheck pps, so a real crash trips at once).
/// Emits `BreakerChanged` when `frozen` flips. With `record = false` (a mark
/// warmup, see `NavResult::warming`) nothing is recorded, and the breaker can
/// only trip.
pub fn update_breaker(
    fund: &mut Fund,
    fund_key: &Pubkey,
    policy: &Policy,
    b: BreakerPps,
) -> Result<()> {
    let BreakerPps { pps, check, record } = b;
    let slot = Clock::get()?.slot;
    if record && slot >= fund.last_pps_slot.saturating_add(MARK_INTERVAL_SLOTS) {
        fund.last_price_per_share = rate_limited(fund.last_price_per_share, pps);
        fund.last_pps_slot = slot;
        fund.peak_price_per_share = fund.peak_price_per_share.max(fund.last_price_per_share);
    }
    let keep_bps = 10_000u16
        .checked_sub(policy.params.drawdown_bps)
        .ok_or(ErrorCode::MathOverflow)?;
    let line = math::bps_of(fund.peak_price_per_share as u128, keep_bps)?;
    let frozen = (check as u128) < line || (!record && fund.frozen);
    if frozen != fund.frozen {
        fund.frozen = frozen;
        emit!(BreakerChanged {
            fund: *fund_key,
            frozen,
            price_per_share: check,
            peak: fund.peak_price_per_share,
        });
    }
    Ok(())
}

/// `fresh` clamped to one `MARK_MAX_STEP_BPS` step around `last` (floor
/// step). A recorded 0 (a NAV that was 0) takes `fresh` at once.
fn rate_limited(last: u64, fresh: u64) -> u64 {
    if last == 0 {
        return fresh;
    }
    let step = (last as u128 * MARK_MAX_STEP_BPS as u128 / BPS_DENOMINATOR as u128) as u64;
    fresh.clamp(last - step, last.saturating_add(step))
}

#[cfg(test)]
mod tests {
    use super::{ValuationMode::*, *};

    /// Spot `price`, EMA (or mark) `ema`, conf $0.10, 6 dp, expo -6.
    fn token(price: i64, ema: i64, rate: Option<KaminoRate>) -> TokenPrice {
        TokenPrice {
            pyth: pyth::PythPrice {
                price,
                conf: 100_000,
                expo: -6,
                publish_time: 0,
                ema_price: ema,
                ema_conf: 100_000,
            },
            decimals: 6,
            rate,
            low_mark: None,
            warming: false,
        }
    }

    #[test]
    fn each_mode_takes_its_side_of_spot_and_ema() {
        // 10 tokens at $2 and $1.50, both orders.
        for (spot, ema) in [(2_000_000, 1_500_000), (1_500_000, 2_000_000)] {
            let p = token(spot, ema, None);
            let v = |m| p.value(10_000_000, m).unwrap();
            assert_eq!(v(Spot), spot as u128 * 10);
            assert_eq!(v(Ema), ema as u128 * 10);
            assert_eq!(v(DepositUpperBound), 21_000_000);
            assert_eq!(v(StakeLowerBound), 15_000_000);
            assert_eq!(v(High), 20_000_000);
            assert_eq!(v(ExitFeeUpperBound), 21_000_000);
            assert_eq!(v(BreakerCheck), ema as u128 * 10);
        }
    }

    #[test]
    fn switchboard_modes_use_the_deposit_mark_and_the_low_mark() {
        // 10 tokens: spot $2, deposit mark $2.50, low mark $1, std_dev $0.10.
        let p = TokenPrice {
            low_mark: Some(1_000_000),
            ..token(2_000_000, 2_500_000, None)
        };
        let v = |m| p.value(10_000_000, m).unwrap();
        assert_eq!(v(Spot), 20_000_000);
        assert_eq!(v(DepositUpperBound), 26_000_000);
        assert_eq!(v(High), 25_000_000);
        assert_eq!(v(Ema), 25_000_000);
        assert_eq!(v(ExitFeeUpperBound), 21_000_000);
        // Spot above the deposit mark: the mark + std_dev.
        let up = TokenPrice {
            low_mark: Some(1_000_000),
            ..token(3_000_000, 2_500_000, None)
        };
        assert_eq!(up.value(10_000_000, ExitFeeUpperBound).unwrap(), 26_000_000);
        assert_eq!(v(StakeLowerBound), 10_000_000);
        assert_eq!(v(BreakerCheck), 10_000_000);
        // A warming holding counts 0 toward the captain stake only.
        let w = TokenPrice { warming: true, ..p };
        assert_eq!(w.value(10_000_000, StakeLowerBound).unwrap(), 0);
        assert_eq!(w.value(10_000_000, Ema).unwrap(), 25_000_000);
    }

    #[test]
    fn recorded_pps_moves_one_step_toward_the_fresh_pps() {
        assert_eq!(rate_limited(2_000_000, 11_000_000), 2_200_000);
        assert_eq!(rate_limited(2_000_000, 1_000), 1_800_000);
        assert_eq!(rate_limited(2_000_000, 2_150_000), 2_150_000);
        assert_eq!(rate_limited(2_000_000, 1_850_000), 1_850_000);
        assert_eq!(rate_limited(0, 1_500_000), 1_500_000);
        assert_eq!(rate_limited(u64::MAX, u64::MAX), u64::MAX);
    }

    #[test]
    fn kamino_stake_lower_bound_is_the_lower_of_spot_and_ema_value() {
        // 10 kTokens at 2 underlying each: 20 underlying at $2 spot, $1.50 EMA.
        let two = KaminoRate {
            total_liquidity_sf: KaminoRate::ONE.total_liquidity_sf * 2,
            collateral_supply: 1,
        };
        let p = token(2_000_000, 1_500_000, Some(two));
        assert_eq!(p.value(10_000_000, Spot).unwrap(), 40_000_000);
        assert_eq!(p.value(10_000_000, StakeLowerBound).unwrap(), 30_000_000);
    }

    #[test]
    fn t3_loss_uses_the_high_price_and_skips_a_warming_holding() {
        // 10 tokens, basis $40: spot $1, mark $3 (High $30, loss $10).
        let p = token(1_000_000, 3_000_000, None);
        let mut r = NavResult {
            len: 2,
            amounts: [0; MAX_HOLDINGS],
            prices: [None; MAX_HOLDINGS],
            t2: [false; MAX_HOLDINGS],
            basis: [0; MAX_HOLDINGS],
            unpriced: [false; MAX_HOLDINGS],
        };
        r.amounts[..2].copy_from_slice(&[5_000_000, 10_000_000]);
        r.prices[1] = Some(p);
        r.basis[1] = 40_000_000;
        assert_eq!(r.t3_loss().unwrap(), 10_000_000);
        // Above cost: no loss.
        r.basis[1] = 20_000_000;
        assert_eq!(r.t3_loss().unwrap(), 0);
        // In its warmup: no loss.
        r.basis[1] = 40_000_000;
        r.prices[1] = Some(TokenPrice { warming: true, ..p });
        assert_eq!(r.t3_loss().unwrap(), 0);
        // Switchboard: the deposit mark only. Spot $4 above the $3 mark
        // does not lower the loss; spot $1 below it does not raise it.
        for spot in [4_000_000, 1_000_000] {
            r.prices[1] = Some(TokenPrice {
                low_mark: Some(500_000),
                ..token(spot, 3_000_000, None)
            });
            assert_eq!(r.t3_loss().unwrap(), 10_000_000);
        }
    }

    #[test]
    fn stake_lower_bound_rejects_a_non_positive_ema() {
        let p = token(2_000_000, 0, None);
        assert!(p.value(10_000_000, StakeLowerBound).is_err());
    }
}
