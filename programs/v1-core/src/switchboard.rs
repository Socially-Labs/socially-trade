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
//! The feed authority can repoint a feed to another job (`feed_hash`) or
//! queue at any time, with no timelock. The registry pins both, so a repoint
//! stops pricing (`FeedConfigChanged`) until the admin re-queues the token.
//!
//! Checks mirror the crate's `PullFeedAccountData::value(clock_slot)`: the
//! result slot must be within `max_staleness` slots, and a slot of 0 means no
//! result. We also cap the age at 60 s, require a positive value, and require
//! `std_dev <= 200 bps` of the value.
//!
//! The feed has no EMA, and a thin pool can be pumped or dumped while every
//! oracle agrees (std_dev near 0). So the registry entry keeps two slow
//! mark prices (`next_marks`) that NAV uses in place of an EMA.

use {
    crate::{
        constants::{BPS_DENOMINATOR, MARK_INTERVAL_SLOTS, MARK_MAX_STEP_BPS, MARK_WARMUP_SLOTS},
        errors::ErrorCode,
        pyth::PythPrice,
        state::Marks,
    },
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

// After `submissions: [OracleSubmission; 32]` (64 bytes each, 8..2056) and
// `authority` (2056): the queue oracles must be bound to, then the job hash.
const QUEUE: usize = 2088;
const FEED_HASH: usize = 2120;
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
    /// ema = the deposit mark (the slow two-way mark) and conf = std_dev,
    /// plus the low mark at the same expo. The 18-decimal values are cut until the highest of them +
    /// std_dev fits `i64` (the deposit upper bound; floor, std_dev rounds
    /// up), so they keep 18+ digits.
    pub fn to_pyth(&self, marks: &Marks) -> Result<(PythPrice, i64), ErrorCode> {
        let (mut value, mut deposit, mut low, mut std_dev, mut expo) = (
            self.value,
            marks.deposit,
            marks.low,
            self.std_dev,
            -PRECISION,
        );
        while value
            .max(deposit)
            .max(low)
            .checked_add(std_dev)
            .is_none_or(|hi| hi > i64::MAX as i128)
        {
            value /= 10;
            deposit /= 10;
            low /= 10;
            std_dev = (std_dev + 9) / 10;
            expo += 1;
        }
        let conf = u64::try_from(std_dev).map_err(|_| ErrorCode::MathOverflow)?;
        let price = PythPrice {
            price: value as i64,
            conf,
            expo,
            publish_time: 0, // not read for a Switchboard price
            ema_price: deposit as i64,
            ema_conf: conf,
        };
        Ok((price, low as i64))
    }
}

/// `MARK_MAX_STEP_BPS` of `mark`, floor. `mark / 10_000 * bps` cannot
/// overflow; the remainder adds the rest.
fn step(mark: i128) -> i128 {
    let d = BPS_DENOMINATOR as i128;
    let bps = MARK_MAX_STEP_BPS as i128;
    mark / d * bps + mark % d * bps / d
}

/// The marks after a read of `value` at `now_slot`.
/// - Unseeded (deposit mark 0): both marks = value, all slots = now (seed).
/// - Deposit mark: at most once per `MARK_INTERVAL_SLOTS`, toward the value
///   by at most `MARK_MAX_STEP_BPS` of the mark, both ways.
/// - Low mark: drops to the value at once when the value is lower; else at
///   most once per interval it rises toward the value by at most one step.
///   So it is never above the value after a read, and a pump raises it 10%
///   per interval at most, from wherever the price really was.
pub fn next_marks(m: Marks, value: i128, now_slot: u64) -> Marks {
    if m.deposit <= 0 {
        return Marks {
            deposit: value,
            deposit_slot: now_slot,
            low: value,
            low_slot: now_slot,
            seed_slot: now_slot,
        };
    }
    let due = |slot: u64| now_slot >= slot.saturating_add(MARK_INTERVAL_SLOTS);
    let mut m = m;
    if due(m.deposit_slot) {
        let s = step(m.deposit);
        m.deposit = value.clamp(m.deposit - s, m.deposit.saturating_add(s));
        m.deposit_slot = now_slot;
    }
    if value < m.low {
        m.low = value;
    } else if due(m.low_slot) {
        m.low = value.min(m.low.saturating_add(step(m.low)));
        m.low_slot = now_slot;
    }
    m
}

impl Marks {
    /// True until `MARK_WARMUP_SLOTS` after the seed: NAV reads do not
    /// record the peak or the last pps yet.
    pub fn warming(&self, now_slot: u64) -> bool {
        now_slot < self.seed_slot.saturating_add(MARK_WARMUP_SLOTS)
    }
}

fn i128_at(data: &[u8], at: usize) -> i128 {
    i128::from_le_bytes(data[at..at + 16].try_into().unwrap())
}

/// Validate the pull feed `key` (owner, data) against the registry entry's
/// `expected_feed`, `expected_hash` and `expected_queue`, and read its
/// current result.
pub fn parse_feed(
    key: &Pubkey,
    owner: &Pubkey,
    data: &[u8],
    expected_feed: &Pubkey,
    expected_hash: &[u8; 32],
    expected_queue: &Pubkey,
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
    if data[FEED_HASH..FEED_HASH + 32] != expected_hash[..]
        || data[QUEUE..QUEUE + 32] != expected_queue.as_ref()[..]
    {
        return Err(ErrorCode::FeedConfigChanged);
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
    /// Job hash.
    pub feed_hash: [u8; 32],
    pub queue: Pubkey,
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
    put(FEED_HASH, &f.feed_hash);
    put(QUEUE, f.queue.as_ref());
    d
}

#[cfg(test)]
mod tests {
    use super::*;

    const SLOT: u64 = 10_000;
    const E18: i128 = 1_000_000_000_000_000_000;
    const FEED: Pubkey = pubkey!("FTcFqwCjAgv2VMaowQ9XSBcesVzFzZkaju25nKio6bki");
    /// Job hash and queue of the live POPCAT/USD feed (fixture).
    const POPCAT_HASH: [u8; 32] = [
        235, 79, 154, 67, 2, 79, 143, 51, 120, 107, 114, 145, 64, 69, 16, 175, 142, 148, 166, 110,
        26, 203, 68, 149, 58, 49, 55, 135, 142, 231, 3, 63,
    ];
    const MAINNET_QUEUE: Pubkey = pubkey!("A43DyUGA7s8eXPxqEjJY6EBu1KKbNgfxF8h17VAHn13w");

    /// $0.05 +- 1%.
    fn fields() -> FeedFields {
        FeedFields {
            value: E18 / 20,
            std_dev: E18 / 2_000,
            slot: SLOT,
            min_slot: SLOT,
            num_samples: MIN_SAMPLES,
            max_staleness: 250,
            feed_hash: POPCAT_HASH,
            queue: MAINNET_QUEUE,
        }
    }
    fn parse_with(
        key: &Pubkey,
        owner: &Pubkey,
        data: &[u8],
        now_slot: u64,
    ) -> Result<SbPrice, ErrorCode> {
        parse_feed(
            key,
            owner,
            data,
            &FEED,
            &POPCAT_HASH,
            &MAINNET_QUEUE,
            now_slot,
        )
    }
    fn parse(f: &FeedFields, now_slot: u64) -> Result<SbPrice, ErrorCode> {
        parse_with(&FEED, &SWITCHBOARD_ON_DEMAND, &encode_feed(f), now_slot)
    }

    #[test]
    fn accepts_matching_job_hash_and_queue() {
        assert!(parse(&fields(), SLOT).is_ok());
    }

    #[test]
    fn rejects_changed_job_hash() {
        // The feed authority repoints the feed to another job.
        let mut feed_hash = POPCAT_HASH;
        feed_hash[31] ^= 1;
        let f = FeedFields {
            feed_hash,
            ..fields()
        };
        assert_eq!(parse(&f, SLOT), Err(ErrorCode::FeedConfigChanged));
    }

    #[test]
    fn rejects_changed_queue() {
        let f = FeedFields {
            queue: Pubkey::new_unique(),
            ..fields()
        };
        assert_eq!(parse(&f, SLOT), Err(ErrorCode::FeedConfigChanged));
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
        let py = at_value(&p);
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
        let py = at_value(&p);
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
            parse_with(&other, &SWITCHBOARD_ON_DEMAND, &d, SLOT),
            Err(ErrorCode::FeedMismatch)
        );
    }

    #[test]
    fn rejects_wrong_owner_type_and_length() {
        let d = encode_feed(&fields());
        assert_eq!(
            parse_with(&FEED, &Pubkey::new_unique(), &d, SLOT),
            Err(ErrorCode::FeedInvalid)
        );
        let mut bad = d.clone();
        bad[0] ^= 1;
        assert_eq!(
            parse_with(&FEED, &SWITCHBOARD_ON_DEMAND, &bad, SLOT),
            Err(ErrorCode::FeedInvalid)
        );
        assert_eq!(
            parse_with(&FEED, &SWITCHBOARD_ON_DEMAND, &d[..PULL_FEED_LEN - 1], SLOT),
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
        let py = at_value(&p);
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
        assert_eq!(at_value(&p).expo, -18);
    }

    /// Both marks at `v`, warmed up (seeded long before `SLOT`).
    fn marks(v: i128) -> Marks {
        Marks {
            deposit: v,
            deposit_slot: SLOT,
            low: v,
            low_slot: SLOT,
            seed_slot: SLOT - MARK_WARMUP_SLOTS,
        }
    }
    fn at_value(p: &SbPrice) -> PythPrice {
        p.to_pyth(&marks(p.value)).unwrap().0
    }

    #[test]
    fn deposit_mark_is_the_ema_and_the_cut_fits_the_highest_value() {
        // Value $0.05, deposit mark $0.10, low mark $0.04: same expo.
        let p = parse(&fields(), SLOT).unwrap();
        let m = Marks {
            deposit: E18 / 10,
            low: E18 / 25,
            ..marks(0)
        };
        let (py, low) = p.to_pyth(&m).unwrap();
        assert_eq!(
            (py.price, py.ema_price, low, py.expo),
            (E18 as i64 / 20, E18 as i64 / 10, E18 as i64 / 25, -18)
        );
        // Value $1, deposit mark $9.30: 9.30e18 + std_dev does not fit i64, so all are cut.
        let p = SbPrice {
            value: E18,
            std_dev: 1,
            slot: SLOT,
        };
        let m = Marks {
            deposit: E18 * 93 / 10,
            ..marks(E18)
        };
        let (py, low) = p.to_pyth(&m).unwrap();
        assert_eq!(
            (py.price, low, py.ema_price, py.conf, py.expo),
            (
                E18 as i64 / 10,
                E18 as i64 / 10,
                930_000_000_000_000_000,
                1,
                -17
            )
        );
    }

    #[test]
    fn first_read_seeds_both_marks() {
        let m = next_marks(Marks::default(), E18 / 20, SLOT);
        let seeded = Marks {
            seed_slot: SLOT,
            ..marks(E18 / 20)
        };
        assert_eq!(m, seeded);
        assert!(m.warming(SLOT + MARK_WARMUP_SLOTS - 1));
        assert!(!m.warming(SLOT + MARK_WARMUP_SLOTS));
    }

    #[test]
    fn deposit_mark_stays_two_way_during_the_warmup() {
        // Seeded at a 10x pump ($0.50); the pump ends ($0.05).
        let seeded = next_marks(Marks::default(), E18 / 2, SLOT);
        let m = next_marks(seeded, E18 / 20, SLOT + 1);
        assert_eq!((m.deposit, m.low), (E18 / 2, E18 / 20));
        // One interval later: one step down, still in the warmup.
        let m = next_marks(m, E18 / 20, SLOT + MARK_INTERVAL_SLOTS);
        assert!(m.warming(SLOT + MARK_INTERVAL_SLOTS));
        assert_eq!(m.deposit, E18 * 45 / 100);
    }

    #[test]
    fn deposit_mark_moves_once_per_interval() {
        let v = E18 / 20;
        // A 10x pump inside the interval: no move.
        let last = SLOT + MARK_INTERVAL_SLOTS - 1;
        assert_eq!(next_marks(marks(v), E18 / 2, last).deposit, v);
        // At the interval: one 10% step, and the interval restarts.
        let at = SLOT + MARK_INTERVAL_SLOTS;
        let m = next_marks(marks(v), E18 / 2, at);
        assert_eq!((m.deposit, m.deposit_slot), (v * 11 / 10, at));
        // A slot before the mark slot (no clock goes back, but no panic either).
        assert_eq!(next_marks(marks(v), E18, SLOT - 1), marks(v));
    }

    #[test]
    fn deposit_mark_step_is_at_most_ten_percent_both_ways() {
        let (v, at) = (E18 / 20, SLOT + MARK_INTERVAL_SLOTS);
        let dep = |value| next_marks(marks(v), value, at).deposit;
        assert_eq!(dep(E18), E18 * 55 / 1_000);
        assert_eq!(dep(1), E18 * 45 / 1_000);
        // Inside one step: the mark becomes the value.
        assert_eq!(dep(E18 * 54 / 1_000), E18 * 54 / 1_000);
        assert_eq!(dep(E18 * 46 / 1_000), E18 * 46 / 1_000);
        // The step floors: 10% of 19 base units is 1.
        assert_eq!(next_marks(marks(19), 100, at).deposit, 20);
        // A mark near i128::MAX does not overflow.
        assert_eq!(
            next_marks(marks(i128::MAX), i128::MAX, at).deposit,
            i128::MAX
        );
        let big = i128::MAX - 7;
        assert_eq!(next_marks(marks(big), 1, at).deposit, big - big / 10);
    }

    #[test]
    fn low_mark_drops_at_once_and_rises_one_step_per_interval() {
        let v = E18 / 20;
        // A 90% fall, inside the interval: the low mark drops at once, its
        // slot stays; the deposit mark does not move.
        let m = next_marks(marks(v), v / 10, SLOT + 1);
        assert_eq!((m.low, m.low_slot, m.deposit), (v / 10, SLOT, v));
        // A pump back inside the interval: no rise.
        let pumped = next_marks(m, v, SLOT + MARK_INTERVAL_SLOTS - 1);
        assert_eq!(pumped.low, v / 10);
        // At the interval: one 10% step up, not to the pumped value.
        let at = SLOT + MARK_INTERVAL_SLOTS;
        let m = next_marks(m, v, at);
        assert_eq!((m.low, m.low_slot), (v / 10 * 11 / 10, at));
        // A rise stops at the value.
        let m = next_marks(marks(v), v + 1, at);
        assert_eq!(m.low, v + 1);
        // The low mark is never above the value after a read.
        for value in [1, v / 2, v, v * 2, E18] {
            assert!(next_marks(marks(v), value, at).low <= value);
        }
    }

    /// The live mainnet POPCAT/USD pull feed (RPC context slot 453046410).
    #[test]
    fn parses_live_popcat_feed() {
        let d = include_bytes!("../tests/fixtures/popcat_pull_feed.bin");
        assert_eq!(d.len(), PULL_FEED_LEN);
        // The registry pins the job hash and queue read from this account.
        assert_eq!(d[FEED_HASH..FEED_HASH + 32], POPCAT_HASH);
        assert_eq!(d[QUEUE..QUEUE + 32], MAINNET_QUEUE.to_bytes());
        // The feed authority (can change the job hash) sits right before the queue.
        assert_eq!(
            d[QUEUE - 32..QUEUE],
            pubkey!("69fYfCVsBvV5CJQeiALyZZ5Auuh1GtqY8f8NnhMt39na").to_bytes()
        );
        let p = parse_with(&FEED, &SWITCHBOARD_ON_DEMAND, d, 428_452_357).unwrap();
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
        assert!(parse_with(&FEED, &SWITCHBOARD_ON_DEMAND, d, 428_452_349 + 150).is_ok());
        assert_eq!(
            parse_with(&FEED, &SWITCHBOARD_ON_DEMAND, d, 428_452_349 + 151),
            Err(ErrorCode::PriceStale)
        );
        // 1,000 POPCAT (9 dp) = 51.508418 USDC.
        let py = at_value(&p);
        assert_eq!(
            crate::math::token_value_usdc(1_000_000_000_000, py.price, py.expo, 9),
            Ok(51_508_418)
        );
    }
}
