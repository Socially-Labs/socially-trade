//! Switchboard On-Demand pull feed parser: the price of a long-tail token.
//!
//! Layout source: crate `switchboard-on-demand` 0.13.0 (crates.io),
//! `src/on_demand/accounts/pull_feed.rs` (`PullFeedAccountData`,
//! `CurrentResult`, `DISCRIMINATOR`) and `src/program_id.rs`
//! (`ON_DEMAND_MAINNET_PID`). `PullFeedAccountData` is `#[repr(C)]` and
//! `bytemuck::Pod` (no padding), 3200 bytes, so the account is 8 + 3200
//! bytes. Offsets below include the 8-byte discriminator, and match the live
//! POPCAT/USD feed (FTcFqwCjAgv2VMaowQ9XSBcesVzFzZkaju25nKio6bki,
//! `tests/fixtures`).
//!
//! Values are `i128` with 18 decimals (`PRECISION = 18`): USD per whole token.
//!
//! Checks mirror the crate's `PullFeedAccountData::value(clock_slot)`: the
//! result slot must be within `max_staleness` slots, and a slot of 0 means no
//! result. We also cap the age at 60 s, require a positive value, and require
//! `std_dev <= 200 bps` of the value.

use {
    crate::{errors::ErrorCode, pyth::PythPrice},
    anchor_lang::{
        prelude::{pubkey, Pubkey},
        solana_program::clock::DEFAULT_MS_PER_SLOT,
    },
};

pub const SWITCHBOARD_ON_DEMAND: Pubkey = pubkey!("SBondMDrcV3K4kxZR1HNVT7osZxAHVHgYXL5Ze1oMUv");
/// First 8 bytes of sha256("account:PullFeedAccountData").
pub const PULL_FEED_DISCRIMINATOR: [u8; 8] = [196, 27, 108, 196, 10, 215, 219, 40];
pub const PULL_FEED_LEN: usize = 8 + 3200;
/// The feed exposes its result age in slots only. 60 s at the Solana target
/// slot time (`solana_clock::DEFAULT_MS_PER_SLOT` = 400 ms) = 150 slots.
pub const MAX_RESULT_AGE_SLOTS: u64 =
    crate::pyth::MAX_PRICE_AGE_SECS as u64 * 1_000 / DEFAULT_MS_PER_SLOT;
/// Fewest oracle samples in the current result. With one sample std_dev is
/// 0, so the spread check and the deposit upper bound would mean nothing.
pub const MIN_SAMPLES: u8 = 3;
/// Decimals of every Switchboard value.
const PRECISION: i32 = 18;

// result (CurrentResult) starts at 2264: value, std_dev, mean, range,
// min_value, max_value (i128 each), num_samples u8, submission_idx u8,
// padding [u8; 6], slot u64, min_slot u64, max_slot u64.
const RESULT_VALUE: usize = 2264;
const RESULT_STD_DEV: usize = 2280;
const RESULT_NUM_SAMPLES: usize = 2360;
const RESULT_SLOT: usize = 2368;
const RESULT_MIN_SLOT: usize = 2376; // slot of the oldest sample in the result
const MAX_STALENESS: usize = 2392; // u32, right after the result

/// The feed's current aggregated result.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SbPrice {
    /// Median USD price of one whole token, 18 decimals.
    pub value: i128,
    /// Standard deviation of the samples, 18 decimals.
    pub std_dev: i128,
    /// Slot of the result.
    pub slot: u64,
}

impl SbPrice {
    /// The same price in the Pyth shape NAV uses: `price * 10^expo`, with
    /// ema = spot (no EMA) and conf = std_dev. The 18-decimal value is cut
    /// until `value + std_dev` fits `i64` (the deposit upper bound; floor,
    /// std_dev rounds up), so it keeps 18+ digits.
    pub fn to_pyth(&self) -> Result<PythPrice, ErrorCode> {
        let (mut value, mut std_dev, mut expo) = (self.value, self.std_dev, -PRECISION);
        while value
            .checked_add(std_dev)
            .is_none_or(|hi| hi > i64::MAX as i128)
        {
            value /= 10;
            std_dev = (std_dev + 9) / 10;
            expo += 1;
        }
        let price = value as i64;
        let conf = u64::try_from(std_dev).map_err(|_| ErrorCode::MathOverflow)?;
        Ok(PythPrice {
            price,
            conf,
            expo,
            publish_time: 0, // not read for a Switchboard price
            ema_price: price,
            ema_conf: conf,
        })
    }
}

fn i128_at(data: &[u8], at: usize) -> i128 {
    i128::from_le_bytes(data[at..at + 16].try_into().unwrap())
}

/// Validate the pull feed `key` (owner, data) against the registry entry's
/// `expected_feed`, and read its current result.
pub fn parse_feed(
    key: &Pubkey,
    owner: &Pubkey,
    data: &[u8],
    expected_feed: &Pubkey,
    now_slot: u64,
) -> Result<SbPrice, ErrorCode> {
    if key != expected_feed {
        return Err(ErrorCode::FeedMismatch);
    }
    // The crate accepts a longer account (`data.len() < expected_size` fails).
    if *owner != SWITCHBOARD_ON_DEMAND
        || data.len() < PULL_FEED_LEN
        || data[..8] != PULL_FEED_DISCRIMINATOR
    {
        return Err(ErrorCode::FeedInvalid);
    }
    let price = SbPrice {
        value: i128_at(data, RESULT_VALUE),
        std_dev: i128_at(data, RESULT_STD_DEV),
        slot: u64::from_le_bytes(data[RESULT_SLOT..RESULT_SLOT + 8].try_into().unwrap()),
    };
    let feed_max = u32::from_le_bytes(data[MAX_STALENESS..MAX_STALENESS + 4].try_into().unwrap());
    let max_age = MAX_RESULT_AGE_SLOTS.min(feed_max as u64);
    // Every sample in the result must be fresh: age from the oldest one.
    let min_slot = u64::from_le_bytes(
        data[RESULT_MIN_SLOT..RESULT_MIN_SLOT + 8]
            .try_into()
            .unwrap(),
    );
    if price.slot == 0 || now_slot.saturating_sub(min_slot.min(price.slot)) > max_age {
        return Err(ErrorCode::PriceStale);
    }
    if data[RESULT_NUM_SAMPLES] < MIN_SAMPLES {
        return Err(ErrorCode::FeedTooFewSamples);
    }
    if price.value <= 0 {
        return Err(ErrorCode::PriceNonPositive);
    }
    if price.std_dev < 0 {
        return Err(ErrorCode::FeedInvalid);
    }
    let spread = (price.std_dev as u128)
        .checked_mul(10_000)
        .ok_or(ErrorCode::PriceConfTooWide)?;
    let limit = (price.value as u128)
        .checked_mul(crate::pyth::MAX_CONF_BPS)
        .ok_or(ErrorCode::MathOverflow)?;
    if spread > limit {
        return Err(ErrorCode::PriceConfTooWide);
    }
    Ok(price)
}

/// The `PullFeedAccountData` fields this module reads. For tests and `test-helpers` only.
#[cfg(any(test, feature = "test-helpers"))]
#[derive(Debug, Clone, Copy)]
pub struct FeedFields {
    pub value: i128,
    pub std_dev: i128,
    pub slot: u64,
    /// Slot of the oldest sample in the result.
    pub min_slot: u64,
    pub num_samples: u8,
    pub max_staleness: u32,
}

/// Build `PullFeedAccountData` account bytes (real length and offsets, other fields 0).
#[cfg(any(test, feature = "test-helpers"))]
pub fn encode_feed(f: &FeedFields) -> Vec<u8> {
    let mut d = vec![0u8; PULL_FEED_LEN];
    let mut put = |at: usize, b: &[u8]| d[at..at + b.len()].copy_from_slice(b);
    put(0, &PULL_FEED_DISCRIMINATOR);
    put(RESULT_VALUE, &f.value.to_le_bytes());
    put(RESULT_STD_DEV, &f.std_dev.to_le_bytes());
    put(RESULT_NUM_SAMPLES, &[f.num_samples]);
    put(RESULT_SLOT, &f.slot.to_le_bytes());
    put(RESULT_MIN_SLOT, &f.min_slot.to_le_bytes());
    put(MAX_STALENESS, &f.max_staleness.to_le_bytes());
    d
}

#[cfg(test)]
mod tests {
    use super::*;

    const SLOT: u64 = 1_000;
    const E18: i128 = 1_000_000_000_000_000_000;
    const FEED: Pubkey = pubkey!("FTcFqwCjAgv2VMaowQ9XSBcesVzFzZkaju25nKio6bki");

    /// $0.05 +- 1%.
    fn fields() -> FeedFields {
        FeedFields {
            value: E18 / 20,
            std_dev: E18 / 2_000,
            slot: SLOT,
            min_slot: SLOT,
            num_samples: MIN_SAMPLES,
            max_staleness: 250,
        }
    }
    fn parse(f: &FeedFields, now_slot: u64) -> Result<SbPrice, ErrorCode> {
        parse_feed(
            &FEED,
            &SWITCHBOARD_ON_DEMAND,
            &encode_feed(f),
            &FEED,
            now_slot,
        )
    }

    #[test]
    fn reads_the_current_result() {
        let p = parse(&fields(), SLOT).unwrap();
        assert_eq!(
            p,
            SbPrice {
                value: E18 / 20,
                std_dev: E18 / 2_000,
                slot: SLOT
            }
        );
        let py = p.to_pyth().unwrap();
        assert_eq!(
            (py.price, py.conf, py.expo),
            (E18 as i64 / 20, E18 as u64 / 2_000, -18)
        );
        assert_eq!(py.ema_price, py.price);
        // 2,000 tokens (9 dp) at $0.05 = 100 USDC.
        assert_eq!(
            crate::math::token_value_usdc(2_000_000_000_000, py.price, py.expo, 9),
            Ok(100_000_000)
        );
    }

    #[test]
    fn large_value_is_cut_to_fit_i64() {
        // $70,000.123456789012345678 +- 0.000000000000000001.
        let p = SbPrice {
            value: 70_000_123_456_789_012_345_678,
            std_dev: 1,
            slot: SLOT,
        };
        let py = p.to_pyth().unwrap();
        assert_eq!((py.price, py.expo), (7_000_012_345_678_901_234, -14));
        // std_dev rounds up, never to 0.
        assert_eq!(py.conf, 1);
        // 1 whole token (6 dp) = 70,000.123456 USDC, floor.
        assert_eq!(
            crate::math::token_value_usdc(1_000_000, py.price, py.expo, 6),
            Ok(70_000_123_456)
        );
    }

    #[test]
    fn rejects_other_feed() {
        let other = Pubkey::new_unique();
        let d = encode_feed(&fields());
        assert_eq!(
            parse_feed(&other, &SWITCHBOARD_ON_DEMAND, &d, &FEED, SLOT),
            Err(ErrorCode::FeedMismatch)
        );
    }

    #[test]
    fn rejects_wrong_owner_type_and_length() {
        let d = encode_feed(&fields());
        assert_eq!(
            parse_feed(&FEED, &Pubkey::new_unique(), &d, &FEED, SLOT),
            Err(ErrorCode::FeedInvalid)
        );
        let mut bad = d.clone();
        bad[0] ^= 1;
        assert_eq!(
            parse_feed(&FEED, &SWITCHBOARD_ON_DEMAND, &bad, &FEED, SLOT),
            Err(ErrorCode::FeedInvalid)
        );
        assert_eq!(
            parse_feed(
                &FEED,
                &SWITCHBOARD_ON_DEMAND,
                &d[..PULL_FEED_LEN - 1],
                &FEED,
                SLOT
            ),
            Err(ErrorCode::FeedInvalid)
        );
    }

    #[test]
    fn rejects_old_or_missing_result() {
        assert!(parse(&fields(), SLOT + MAX_RESULT_AGE_SLOTS).is_ok());
        assert_eq!(
            parse(&fields(), SLOT + MAX_RESULT_AGE_SLOTS + 1),
            Err(ErrorCode::PriceStale)
        );
        // The feed's own max_staleness, when tighter.
        let f = FeedFields {
            max_staleness: 10,
            ..fields()
        };
        assert!(parse(&f, SLOT + 10).is_ok());
        assert_eq!(parse(&f, SLOT + 11), Err(ErrorCode::PriceStale));
        // Slot 0: the feed has no result yet.
        let f = FeedFields {
            slot: 0,
            ..fields()
        };
        assert_eq!(parse(&f, 0), Err(ErrorCode::PriceStale));
    }

    #[test]
    fn rejects_non_positive_value() {
        for value in [0, -E18] {
            let f = FeedFields {
                value,
                std_dev: 0,
                ..fields()
            };
            assert_eq!(parse(&f, SLOT), Err(ErrorCode::PriceNonPositive));
        }
    }

    #[test]
    fn rejects_wide_or_negative_std_dev() {
        // 200 bps of $0.05 = 0.001.
        let f = FeedFields {
            std_dev: E18 / 1_000,
            ..fields()
        };
        assert!(parse(&f, SLOT).is_ok());
        let f = FeedFields {
            std_dev: E18 / 1_000 + 1,
            ..fields()
        };
        assert_eq!(parse(&f, SLOT), Err(ErrorCode::PriceConfTooWide));
        let f = FeedFields {
            std_dev: -1,
            ..fields()
        };
        assert_eq!(parse(&f, SLOT), Err(ErrorCode::FeedInvalid));
    }

    #[test]
    fn rejects_fewer_than_three_samples() {
        for (n, ok) in [(0, false), (1, false), (2, false), (3, true), (4, true)] {
            let f = FeedFields {
                num_samples: n,
                ..fields()
            };
            let res = parse(&f, SLOT);
            assert_eq!(res.is_ok(), ok, "{n} samples");
            if !ok {
                assert_eq!(res, Err(ErrorCode::FeedTooFewSamples));
            }
        }
    }

    #[test]
    fn age_counts_from_the_oldest_sample() {
        // Fresh result slot, but its oldest sample is 151 slots old.
        let f = FeedFields {
            slot: SLOT + 100,
            min_slot: SLOT,
            ..fields()
        };
        assert!(parse(&f, SLOT + MAX_RESULT_AGE_SLOTS).is_ok());
        assert_eq!(
            parse(&f, SLOT + MAX_RESULT_AGE_SLOTS + 1),
            Err(ErrorCode::PriceStale)
        );
        // min_slot 0 (unset) with a fresh result: stale.
        let f = FeedFields {
            min_slot: 0,
            ..fields()
        };
        assert_eq!(parse(&f, SLOT), Err(ErrorCode::PriceStale));
    }

    #[test]
    fn upper_bound_fits_i64() {
        // $9.10 + $0.15: the value fits i64 at 18 decimals, value + std_dev does not.
        let p = SbPrice {
            value: 9_100_000_000_000_000_000,
            std_dev: 150_000_000_000_000_000,
            slot: SLOT,
        };
        let py = p.to_pyth().unwrap();
        assert_eq!(
            (py.price, py.conf, py.expo),
            (910_000_000_000_000_000, 15_000_000_000_000_000, -17)
        );
        assert!(i64::try_from(py.price as i128 + py.conf as i128).is_ok());
        // At i64::MAX with std_dev 0 there is no cut.
        let p = SbPrice {
            value: i64::MAX as i128,
            std_dev: 0,
            slot: SLOT,
        };
        assert_eq!(p.to_pyth().unwrap().expo, -18);
    }

    /// The live mainnet POPCAT/USD pull feed (RPC context slot 453046410).
    #[test]
    fn parses_live_popcat_feed() {
        let d = include_bytes!("../tests/fixtures/popcat_pull_feed.bin");
        assert_eq!(d.len(), PULL_FEED_LEN);
        let p = parse_feed(&FEED, &SWITCHBOARD_ON_DEMAND, d, &FEED, 428_452_357).unwrap();
        assert_eq!(
            p,
            SbPrice {
                value: 51_508_418_218_638_674, // $0.0515...
                std_dev: 9_656_571_768_230,    // 1.87 bps
                slot: 428_452_357,
            }
        );
        // 4 samples; oldest at slot 428452349. Its own max_staleness is
        // 250 slots, so our 150-slot cap binds, counted from the oldest sample.
        assert_eq!(d[RESULT_NUM_SAMPLES], 4);
        assert!(parse_feed(&FEED, &SWITCHBOARD_ON_DEMAND, d, &FEED, 428_452_349 + 150).is_ok());
        assert_eq!(
            parse_feed(&FEED, &SWITCHBOARD_ON_DEMAND, d, &FEED, 428_452_349 + 151),
            Err(ErrorCode::PriceStale)
        );
        // 1,000 POPCAT (9 dp) = 51.508418 USDC.
        let py = p.to_pyth().unwrap();
        assert_eq!(
            crate::math::token_value_usdc(1_000_000_000_000, py.price, py.expo, 9),
            Ok(51_508_418)
        );
    }
}
