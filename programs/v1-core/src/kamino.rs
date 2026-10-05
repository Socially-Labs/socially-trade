//! Kamino Lend (klend) `Reserve` parser: the kToken -> underlying exchange rate.
//!
//! Layout source: github.com/Kamino-Finance/klend, tag `release/v1.25.0`
//! (commit a08760976f51a3a58c4a0c6ea27b4a0e565bca79),
//! `programs/klend/src/state/reserve.rs` (`Reserve`, `ReserveLiquidity`,
//! `ReserveCollateral`) and `state/last_update.rs` (`LastUpdate`). `Reserve` is
//! `#[account(zero_copy)] #[repr(C)]`, `RESERVE_SIZE = 8616` (`utils/consts.rs`),
//! so the account is 8 + 8616 bytes. Offsets below include the 8-byte
//! discriminator, and match the live kUSDC reserve
//! (D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59, `tests/fixtures`).
//!
//! `_sf` values are klend `Fraction` = `U68F60` bits (`utils/fraction.rs`):
//! the value times 2^60.

use {
    crate::errors::ErrorCode,
    anchor_lang::prelude::{pubkey, Pubkey},
};

pub const KAMINO_LEND: Pubkey = pubkey!("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");
/// First 8 bytes of sha256("account:Reserve").
pub const RESERVE_DISCRIMINATOR: [u8; 8] = [43, 242, 204, 202, 26, 247, 59, 127];
pub const RESERVE_LEN: usize = 8 + 8616;
/// klend's own slot-time assumption (`utils/consts.rs`: `SLOTS_PER_SECOND = 2`).
pub const SLOTS_PER_SECOND: u64 = 2;
/// 60 s, the same age limit as the Pyth prices.
pub const MAX_RESERVE_AGE_SLOTS: u64 = 60 * SLOTS_PER_SECOND;
const FRACTION_BITS: u32 = 60;

// last_update: slot u64, stale u8, price_status u8, padding [u8; 2], timestamp u32.
const LAST_UPDATE_SLOT: usize = 16;
const LAST_UPDATE_STALE: usize = 24;
// liquidity (ReserveLiquidity) starts at 128.
#[cfg(any(test, feature = "test-helpers"))]
const LIQUIDITY_MINT: usize = 128;
const LIQUIDITY_AVAILABLE: usize = 224; // total_available_amount u64
const LIQUIDITY_BORROWED_SF: usize = 232; // borrowed_amount_sf u128
const LIQUIDITY_DECIMALS: usize = 272; // mint_decimals u64
const LIQUIDITY_PROTOCOL_FEES_SF: usize = 344; // accumulated_protocol_fees_sf u128
const LIQUIDITY_REFERRER_FEES_SF: usize = 360; // accumulated_referrer_fees_sf u128
const LIQUIDITY_PENDING_REFERRER_FEES_SF: usize = 376; // pending_referrer_fees_sf u128
                                                       // collateral (ReserveCollateral) starts at 2560.
const COLLATERAL_MINT: usize = 2560;
const COLLATERAL_SUPPLY: usize = 2592; // mint_total_supply u64

/// kTokens -> underlying: `underlying = kTokens * total_liquidity_sf / collateral_supply / 2^60`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KaminoRate {
    /// klend `ReserveLiquidity::total_supply()` as U68F60 bits.
    pub total_liquidity_sf: u128,
    /// klend `ReserveCollateral::mint_total_supply`.
    pub collateral_supply: u128,
}

impl KaminoRate {
    /// klend `INITIAL_COLLATERAL_RATE`: 1:1.
    pub const ONE: Self = Self {
        total_liquidity_sf: 1 << FRACTION_BITS,
        collateral_supply: 1,
    };

    /// Underlying base units for `ktokens`, floor. Exact in u128:
    /// `k * L / S = k * (L / S) + k * (L % S) / S`, and `k`, `L % S` < 2^64.
    pub fn to_underlying(&self, ktokens: u64) -> Result<u64, ErrorCode> {
        let (l, s, k) = (
            self.total_liquidity_sf,
            self.collateral_supply,
            ktokens as u128,
        );
        let whole = k.checked_mul(l / s).ok_or(ErrorCode::MathOverflow)?;
        let part = k.checked_mul(l % s).ok_or(ErrorCode::MathOverflow)? / s;
        let sf = whole.checked_add(part).ok_or(ErrorCode::MathOverflow)?;
        u64::try_from(sf >> FRACTION_BITS).map_err(|_| ErrorCode::MathOverflow)
    }

    /// kTokens for `underlying` base units, floor. For the swap price guard only.
    // Note: total liquidity is floored to whole base units, so the result
    // is high by at most 1 / total_liquidity (relative); go exact (u256) if a
    // reserve with tiny liquidity is ever listed.
    pub fn to_ktokens(&self, underlying: u128) -> Result<u128, ErrorCode> {
        let liquidity = self.total_liquidity_sf >> FRACTION_BITS;
        crate::math::mul_div_floor(underlying, self.collateral_supply, liquidity)
    }
}

fn u64_at(data: &[u8], at: usize) -> u64 {
    u64::from_le_bytes(data[at..at + 8].try_into().unwrap())
}
fn u128_at(data: &[u8], at: usize) -> u128 {
    u128::from_le_bytes(data[at..at + 16].try_into().unwrap())
}

/// Validate a klend reserve for the kToken `collateral_mint` and read its rate.
/// The caller checks the reserve key against the registry entry.
pub fn parse_reserve(
    owner: &Pubkey,
    data: &[u8],
    collateral_mint: &Pubkey,
    underlying_decimals: u8,
    now_slot: u64,
) -> Result<KaminoRate, ErrorCode> {
    if *owner != KAMINO_LEND || data.len() != RESERVE_LEN || data[..8] != RESERVE_DISCRIMINATOR {
        return Err(ErrorCode::ReserveInvalid);
    }
    if data[COLLATERAL_MINT..COLLATERAL_MINT + 32] != collateral_mint.as_ref()[..]
        || u64_at(data, LIQUIDITY_DECIMALS) != underlying_decimals as u64
    {
        return Err(ErrorCode::ReserveMismatch);
    }
    // klend marks a reserve stale after every deposit or withdraw; a client
    // sends `refresh_reserve` before our instruction (same transaction).
    if data[LAST_UPDATE_STALE] != 0
        || now_slot.saturating_sub(u64_at(data, LAST_UPDATE_SLOT)) > MAX_RESERVE_AGE_SLOTS
    {
        return Err(ErrorCode::PriceStale);
    }
    // klend `ReserveLiquidity::total_supply()`: available + borrowed
    // - accumulated protocol fees - accumulated referrer fees - pending referrer fees.
    let total_liquidity_sf = ((u64_at(data, LIQUIDITY_AVAILABLE) as u128) << FRACTION_BITS)
        .checked_add(u128_at(data, LIQUIDITY_BORROWED_SF))
        .and_then(|v| v.checked_sub(u128_at(data, LIQUIDITY_PROTOCOL_FEES_SF)))
        .and_then(|v| v.checked_sub(u128_at(data, LIQUIDITY_REFERRER_FEES_SF)))
        .and_then(|v| v.checked_sub(u128_at(data, LIQUIDITY_PENDING_REFERRER_FEES_SF)))
        .ok_or(ErrorCode::ReserveInvalid)?;
    let collateral_supply = u64_at(data, COLLATERAL_SUPPLY) as u128;
    // klend `ReserveCollateral::exchange_rate`: 1:1 while either side is zero.
    if collateral_supply == 0 || total_liquidity_sf == 0 {
        return Ok(KaminoRate::ONE);
    }
    Ok(KaminoRate {
        total_liquidity_sf,
        collateral_supply,
    })
}

/// The `Reserve` fields this module reads. For tests and `test-helpers` only.
#[cfg(any(test, feature = "test-helpers"))]
#[derive(Debug, Clone, Copy, Default)]
pub struct ReserveFields {
    pub slot: u64,
    pub stale: bool,
    pub liquidity_mint: Pubkey,
    pub decimals: u8,
    pub available: u64,
    pub borrowed_sf: u128,
    pub protocol_fees_sf: u128,
    pub referrer_fees_sf: u128,
    pub pending_referrer_fees_sf: u128,
    pub collateral_mint: Pubkey,
    pub collateral_supply: u64,
}

/// Build `Reserve` account bytes (real length and offsets, other fields 0).
#[cfg(any(test, feature = "test-helpers"))]
pub fn encode_reserve(f: &ReserveFields) -> Vec<u8> {
    let mut d = vec![0u8; RESERVE_LEN];
    let mut put = |at: usize, b: &[u8]| d[at..at + b.len()].copy_from_slice(b);
    put(0, &RESERVE_DISCRIMINATOR);
    put(8, &1u64.to_le_bytes()); // version
    put(LAST_UPDATE_SLOT, &f.slot.to_le_bytes());
    put(LAST_UPDATE_STALE, &[f.stale as u8]);
    put(LIQUIDITY_MINT, f.liquidity_mint.as_ref());
    put(LIQUIDITY_AVAILABLE, &f.available.to_le_bytes());
    put(LIQUIDITY_BORROWED_SF, &f.borrowed_sf.to_le_bytes());
    put(LIQUIDITY_DECIMALS, &(f.decimals as u64).to_le_bytes());
    put(
        LIQUIDITY_PROTOCOL_FEES_SF,
        &f.protocol_fees_sf.to_le_bytes(),
    );
    put(
        LIQUIDITY_REFERRER_FEES_SF,
        &f.referrer_fees_sf.to_le_bytes(),
    );
    put(
        LIQUIDITY_PENDING_REFERRER_FEES_SF,
        &f.pending_referrer_fees_sf.to_le_bytes(),
    );
    put(COLLATERAL_MINT, f.collateral_mint.as_ref());
    put(COLLATERAL_SUPPLY, &f.collateral_supply.to_le_bytes());
    d
}

#[cfg(test)]
mod tests {
    use super::*;

    const SLOT: u64 = 1_000;
    const K: Pubkey = pubkey!("B8V6WVjPxW1UGwVDfxH2d2r8SyT4cqn7dQRK6XneVa7D");

    /// Rate 1.05: 1,050,000 USDC of liquidity over 1,000,000 kUSDC.
    fn fields() -> ReserveFields {
        ReserveFields {
            slot: SLOT,
            decimals: 6,
            available: 600_000_000_000,
            borrowed_sf: 460_000_000_000u128 << 60,
            protocol_fees_sf: 9_000_000_000u128 << 60,
            referrer_fees_sf: 600_000_000u128 << 60,
            pending_referrer_fees_sf: 400_000_000u128 << 60,
            collateral_mint: K,
            collateral_supply: 1_000_000_000_000,
            ..Default::default()
        }
    }
    fn parse(d: &[u8], slot: u64) -> Result<KaminoRate, ErrorCode> {
        parse_reserve(&KAMINO_LEND, d, &K, 6, slot)
    }

    #[test]
    fn rate_is_total_supply_over_collateral() {
        let r = parse(&encode_reserve(&fields()), SLOT).unwrap();
        assert_eq!(r.collateral_supply, 1_000_000_000_000);
        assert_eq!(r.total_liquidity_sf, 1_050_000_000_000u128 << 60);
        assert_eq!(r.to_underlying(1_000_000_000).unwrap(), 1_050_000_000);
        assert_eq!(r.to_underlying(1).unwrap(), 1); // 1.05 floors to 1
        assert_eq!(r.to_ktokens(1_050_000_000).unwrap(), 1_000_000_000);
    }

    #[test]
    fn fractional_borrow_keeps_precision() {
        // borrowed = 0.5 base unit: 1 kToken -> 1.5 -> 1; 2 kTokens -> 3.
        let f = ReserveFields {
            available: 1,
            borrowed_sf: 1 << 59,
            protocol_fees_sf: 0,
            referrer_fees_sf: 0,
            pending_referrer_fees_sf: 0,
            collateral_supply: 1,
            ..fields()
        };
        let r = parse(&encode_reserve(&f), SLOT).unwrap();
        assert_eq!(r.to_underlying(1).unwrap(), 1);
        assert_eq!(r.to_underlying(2).unwrap(), 3);
        // u64::MAX kTokens at 1.5 does not fit u64.
        assert_eq!(r.to_underlying(u64::MAX), Err(ErrorCode::MathOverflow));
    }

    #[test]
    fn empty_reserve_is_one_to_one() {
        let f = ReserveFields {
            collateral_supply: 0,
            ..fields()
        };
        assert_eq!(parse(&encode_reserve(&f), SLOT), Ok(KaminoRate::ONE));
        let f = ReserveFields {
            available: 0,
            borrowed_sf: 10_000_000_000u128 << 60,
            ..fields()
        };
        assert_eq!(parse(&encode_reserve(&f), SLOT), Ok(KaminoRate::ONE));
        assert_eq!(KaminoRate::ONE.to_underlying(7).unwrap(), 7);
    }

    #[test]
    fn rejects_wrong_owner_type_and_length() {
        let d = encode_reserve(&fields());
        let other = Pubkey::new_unique();
        assert_eq!(
            parse_reserve(&other, &d, &K, 6, SLOT),
            Err(ErrorCode::ReserveInvalid)
        );
        let mut bad = d.clone();
        bad[0] ^= 1;
        assert_eq!(parse(&bad, SLOT), Err(ErrorCode::ReserveInvalid));
        assert_eq!(
            parse(&d[..RESERVE_LEN - 8], SLOT),
            Err(ErrorCode::ReserveInvalid)
        );
    }

    #[test]
    fn rejects_other_collateral_mint_or_decimals() {
        let d = encode_reserve(&fields());
        assert_eq!(
            parse_reserve(&KAMINO_LEND, &d, &Pubkey::new_unique(), 6, SLOT),
            Err(ErrorCode::ReserveMismatch)
        );
        assert_eq!(
            parse_reserve(&KAMINO_LEND, &d, &K, 9, SLOT),
            Err(ErrorCode::ReserveMismatch)
        );
    }

    #[test]
    fn rejects_stale_flag_and_old_slot() {
        let d = encode_reserve(&fields());
        assert!(parse(&d, SLOT + MAX_RESERVE_AGE_SLOTS).is_ok());
        assert_eq!(
            parse(&d, SLOT + MAX_RESERVE_AGE_SLOTS + 1),
            Err(ErrorCode::PriceStale)
        );
        let f = ReserveFields {
            stale: true,
            ..fields()
        };
        assert_eq!(parse(&encode_reserve(&f), SLOT), Err(ErrorCode::PriceStale));
    }

    #[test]
    fn rejects_fees_above_liquidity() {
        let f = ReserveFields {
            available: 0,
            borrowed_sf: 0,
            ..fields()
        };
        assert_eq!(
            parse(&encode_reserve(&f), SLOT),
            Err(ErrorCode::ReserveInvalid)
        );
    }

    /// The live mainnet kUSDC reserve (slot 453042085), stale flag cleared.
    #[test]
    fn parses_live_kusdc_reserve() {
        let mut d = include_bytes!("../tests/fixtures/kusdc_reserve.bin").to_vec();
        let slot = u64_at(&d, LAST_UPDATE_SLOT);
        d[LAST_UPDATE_STALE] = 0;
        let r = parse_reserve(&KAMINO_LEND, &d, &K, 6, slot).unwrap();
        assert_eq!(
            d[LIQUIDITY_MINT..LIQUIDITY_MINT + 32],
            pubkey!("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v").as_ref()[..]
        );
        assert_eq!(r.collateral_supply, 100_677_140_254_147);
        assert_eq!(
            r.total_liquidity_sf,
            139_712_208_366_313_552_554_223_169_583_186
        );
        // 1 kUSDC = 1.203659... USDC.
        assert_eq!(r.to_underlying(1_000_000).unwrap(), 1_203_659);
    }
}
