//! Pure money math. All ops are checked in u128; overflow gives `MathOverflow`.
//! Shares and fees round down (favor the fund).

use crate::{constants::PERF_FEE_BPS, errors::ErrorCode};

const ONE: u128 = 1_000_000;
const BPS_DENOM: u128 = 10_000;

fn to_u64(v: u128) -> Result<u64, ErrorCode> {
    u64::try_from(v).map_err(|_| ErrorCode::MathOverflow)
}

pub fn mul_div_floor(a: u128, b: u128, d: u128) -> Result<u128, ErrorCode> {
    if d == 0 {
        return Err(ErrorCode::MathOverflow);
    }
    Ok(a.checked_mul(b).ok_or(ErrorCode::MathOverflow)? / d)
}
pub fn shares_for_deposit(deposit: u64, total_shares: u64, nav: u128) -> Result<u64, ErrorCode> {
    if total_shares == 0 {
        return Ok(deposit);
    }
    let shares = mul_div_floor(deposit as u128, total_shares as u128, nav)?;
    match u64::try_from(shares).map_err(|_| ErrorCode::MathOverflow)? {
        0 => Err(ErrorCode::ZeroShares),
        s => Ok(s),
    }
}
pub fn price_per_share(nav: u128, total_shares: u64) -> Result<u64, ErrorCode> {
    if total_shares == 0 {
        return Ok(ONE as u64);
    }
    to_u64(mul_div_floor(nav, ONE, total_shares as u128)?)
}
pub fn value_of_shares(shares: u64, price_per_share: u64) -> Result<u64, ErrorCode> {
    to_u64(mul_div_floor(shares as u128, price_per_share as u128, ONE)?)
}
pub fn token_value_usdc(
    amount: u64,
    price: i64,
    expo: i32,
    token_decimals: u8,
) -> Result<u128, ErrorCode> {
    if price <= 0 {
        return Err(ErrorCode::MathOverflow);
    }
    let base = (amount as u128)
        .checked_mul(price as u128)
        .ok_or(ErrorCode::MathOverflow)?;
    let exp = 6 + expo - token_decimals as i32;
    if exp >= 0 {
        let scale = 10u128
            .checked_pow(exp as u32)
            .ok_or(ErrorCode::MathOverflow)?;
        base.checked_mul(scale).ok_or(ErrorCode::MathOverflow)
    } else {
        // base < 2^127 < 10^39, so a divisor of 10^39 or more floors to 0.
        Ok(10u128
            .checked_pow(exp.unsigned_abs())
            .map_or(0, |scale| base / scale))
    }
}
pub fn pro_rata(amount: u64, part: u64, whole: u64) -> Result<u64, ErrorCode> {
    to_u64(mul_div_floor(amount as u128, part as u128, whole as u128)?)
}

#[derive(Debug, PartialEq, Eq)]
pub struct FeeOutcome {
    pub fee_usdc: u64,
    pub fee_shares: u64,
    pub new_hwm: u64,
}
pub fn performance_fee(
    member_shares: u64,
    price_per_share: u64,
    hwm: u64,
) -> Result<FeeOutcome, ErrorCode> {
    let value = value_of_shares(member_shares, price_per_share)?;
    if value <= hwm {
        return Ok(FeeOutcome {
            fee_usdc: 0,
            fee_shares: 0,
            new_hwm: hwm,
        });
    }
    let fee = to_u64(bps_of((value - hwm) as u128, PERF_FEE_BPS)?)?;
    let fee_shares = if price_per_share == 0 {
        0
    } else {
        to_u64(mul_div_floor(fee as u128, ONE, price_per_share as u128)?)?
    };
    let new_hwm = if fee > 0 { value - fee } else { hwm };
    Ok(FeeOutcome {
        fee_usdc: fee,
        fee_shares,
        new_hwm,
    })
}
pub fn bps_of(value: u128, bps: u16) -> Result<u128, ErrorCode> {
    mul_div_floor(value, bps as u128, BPS_DENOM)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_deposit_is_one_to_one() {
        assert_eq!(shares_for_deposit(250_000_000, 0, 0).unwrap(), 250_000_000);
    }
    #[test]
    fn deposit_rounds_down() {
        assert_eq!(shares_for_deposit(100, 1_000, 1_001).unwrap(), 99);
    }
    #[test]
    fn deposit_zero_shares_rejected() {
        assert_eq!(
            shares_for_deposit(1, 1, 1_000_000),
            Err(ErrorCode::ZeroShares)
        );
    }
    #[test]
    fn deposit_nav_zero_with_shares_overflows() {
        assert_eq!(shares_for_deposit(1, 1, 0), Err(ErrorCode::MathOverflow));
    }
    #[test]
    fn deposit_result_over_u64_overflows() {
        assert_eq!(
            shares_for_deposit(u64::MAX, u64::MAX, 1),
            Err(ErrorCode::MathOverflow)
        );
    }
    #[test]
    fn mul_div_zero_divisor() {
        assert_eq!(mul_div_floor(1, 1, 0), Err(ErrorCode::MathOverflow));
    }
    #[test]
    fn mul_div_overflow() {
        assert_eq!(mul_div_floor(u128::MAX, 2, 1), Err(ErrorCode::MathOverflow));
    }
    #[test]
    fn pps_empty_fund_is_one_dollar() {
        assert_eq!(price_per_share(0, 0).unwrap(), 1_000_000);
    }
    #[test]
    fn pps_floor() {
        assert_eq!(
            price_per_share(1_150_000_000, 1_000_000_000).unwrap(),
            1_150_000
        );
        assert_eq!(price_per_share(10, 3).unwrap(), 3_333_333);
    }
    #[test]
    fn pps_over_u64_overflows() {
        assert_eq!(
            price_per_share(u128::MAX / ONE, 1),
            Err(ErrorCode::MathOverflow)
        );
    }
    #[test]
    fn value_of_shares_floor() {
        assert_eq!(
            value_of_shares(1_000_000_000, 1_150_000).unwrap(),
            1_150_000_000
        );
        assert_eq!(value_of_shares(1, 999_999).unwrap(), 0);
    }
    #[test]
    fn value_of_shares_overflow() {
        assert_eq!(
            value_of_shares(u64::MAX, u64::MAX),
            Err(ErrorCode::MathOverflow)
        );
    }
    #[test]
    fn sol_value() {
        // 2 SOL (9dp) at $150.00 (price 15000000000, expo -8) = 300 USDC
        assert_eq!(
            token_value_usdc(2_000_000_000, 15_000_000_000, -8, 9).unwrap(),
            300_000_000
        );
    }
    #[test]
    fn usdc_value_one_to_one() {
        // 1 USDC (6dp) at $1.00000000 (expo -8)
        assert_eq!(
            token_value_usdc(1_000_000, 100_000_000, -8, 6).unwrap(),
            1_000_000
        );
    }
    #[test]
    fn value_positive_exponent_multiplies() {
        // price 5 * 10^2 = $500, 1 token (6dp) = 500 USDC
        assert_eq!(token_value_usdc(1_000_000, 5, 2, 6).unwrap(), 500_000_000);
    }
    #[test]
    fn value_low_decimals_token_multiplies() {
        // 2 units of a 0dp token at $3.00 (price 300, expo -2) = 6 USDC
        assert_eq!(token_value_usdc(2, 300, -2, 0).unwrap(), 6_000_000);
    }
    #[test]
    fn value_deep_negative_exponent_floors_to_zero() {
        // 10^(6-30-9) is far below 1: floor to 0, no overflow
        assert_eq!(token_value_usdc(1, 1, -30, 9).unwrap(), 0);
        assert_eq!(token_value_usdc(u64::MAX, i64::MAX, -60, 18).unwrap(), 0);
    }
    #[test]
    fn value_huge_positive_exponent_overflows() {
        assert_eq!(token_value_usdc(1, 1, 60, 0), Err(ErrorCode::MathOverflow));
    }
    #[test]
    fn value_non_positive_price_rejected() {
        assert_eq!(token_value_usdc(1, 0, -8, 9), Err(ErrorCode::MathOverflow));
        assert_eq!(token_value_usdc(1, -5, -8, 9), Err(ErrorCode::MathOverflow));
    }
    #[test]
    fn pro_rata_floor() {
        assert_eq!(pro_rata(100, 1, 3).unwrap(), 33);
        assert_eq!(pro_rata(u64::MAX, u64::MAX, u64::MAX).unwrap(), u64::MAX);
    }
    #[test]
    fn pro_rata_zero_whole() {
        assert_eq!(pro_rata(1, 1, 0), Err(ErrorCode::MathOverflow));
    }
    #[test]
    fn pro_rata_part_over_whole_overflows() {
        assert_eq!(pro_rata(u64::MAX, 2, 1), Err(ErrorCode::MathOverflow));
    }
    #[test]
    fn fee_whitepaper_priya() {
        // V=1150, HWM=1000 -> fee 15, new HWM 1135
        let pps = 1_150_000;
        let shares = 1_000_000_000; // 1000 shares at $1.15
        let o = performance_fee(shares, pps, 1_000_000_000).unwrap();
        assert_eq!(o.fee_usdc, 15_000_000);
        assert_eq!(o.new_hwm, 1_135_000_000);
        assert_eq!(o.fee_shares, 13_043_478);
    }
    #[test]
    fn no_fee_below_hwm() {
        let o = performance_fee(1_000_000_000, 1_100_000, 1_135_000_000).unwrap();
        assert_eq!(o.fee_usdc, 0);
        assert_eq!(o.fee_shares, 0);
        assert_eq!(o.new_hwm, 1_135_000_000);
    }
    #[test]
    fn no_fee_at_hwm() {
        let o = performance_fee(1_000_000_000, 1_000_000, 1_000_000_000).unwrap();
        assert_eq!(
            o,
            FeeOutcome {
                fee_usdc: 0,
                fee_shares: 0,
                new_hwm: 1_000_000_000
            }
        );
    }
    #[test]
    fn fee_with_zero_pps_gives_zero_fee_shares() {
        // V = 0 here, so no gain; direct pps==0 path: hwm 0, shares>0 -> V=0 -> no fee
        let o = performance_fee(1_000, 0, 0).unwrap();
        assert_eq!((o.fee_usdc, o.fee_shares, o.new_hwm), (0, 0, 0));
    }
    #[test]
    fn bps_floor() {
        assert_eq!(bps_of(999, 1000).unwrap(), 99);
        assert_eq!(bps_of(1_000_000, 2500).unwrap(), 250_000);
        assert_eq!(bps_of(u128::MAX, 2), Err(ErrorCode::MathOverflow));
    }
}
