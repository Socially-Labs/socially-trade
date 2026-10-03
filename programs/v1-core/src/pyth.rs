//! Pyth `PriceUpdateV2` parser. The account is Borsh-laid-out; we read it by offset.

use {
    crate::errors::ErrorCode,
    anchor_lang::prelude::{pubkey, Pubkey},
};

pub const PYTH_RECEIVER: Pubkey = pubkey!("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ");
pub const MAX_PRICE_AGE_SECS: i64 = 60;
pub const MAX_CONF_BPS: u128 = 200;
/// First 8 bytes of sha256("account:PriceUpdateV2").
pub const PRICE_UPDATE_V2_DISCRIMINATOR: [u8; 8] = [34, 241, 35, 99, 157, 126, 244, 205];
// feed_id 32, price 8, conf 8, expo 4, publish_time 8, prev_publish_time 8,
// ema_price 8, ema_conf 8.
const MSG_LEN: usize = 84;

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub struct PythPrice {
    pub price: i64,
    pub conf: u64,
    pub expo: i32,
    pub publish_time: i64,
    pub ema_price: i64,
    pub ema_conf: u64,
}

pub fn parse_price_update(
    owner: &Pubkey,
    data: &[u8],
    expected_feed: &[u8; 32],
    now: i64,
) -> Result<PythPrice, ErrorCode> {
    if *owner != PYTH_RECEIVER {
        return Err(ErrorCode::PriceWrongOwner);
    }
    let disc = data.get(..8).ok_or(ErrorCode::PriceAccountMissing)?;
    if disc != PRICE_UPDATE_V2_DISCRIMINATOR {
        return Err(ErrorCode::PriceWrongAccountType);
    }
    // 8 discriminator + 32 write_authority, then the verification level tag.
    let tag = *data.get(40).ok_or(ErrorCode::PriceAccountMissing)?;
    if tag != 1 {
        return Err(ErrorCode::PriceNotFullyVerified);
    }
    // Full has no payload: price_message starts at 41.
    let msg = data
        .get(41..41 + MSG_LEN)
        .ok_or(ErrorCode::PriceAccountMissing)?;
    if msg[..32] != expected_feed[..] {
        return Err(ErrorCode::PriceFeedMismatch);
    }
    let price = PythPrice {
        price: i64::from_le_bytes(msg[32..40].try_into().unwrap()),
        conf: u64::from_le_bytes(msg[40..48].try_into().unwrap()),
        expo: i32::from_le_bytes(msg[48..52].try_into().unwrap()),
        publish_time: i64::from_le_bytes(msg[52..60].try_into().unwrap()),
        // msg[60..68] = prev_publish_time.
        ema_price: i64::from_le_bytes(msg[68..76].try_into().unwrap()),
        ema_conf: u64::from_le_bytes(msg[76..84].try_into().unwrap()),
    };
    if now.saturating_sub(price.publish_time) > MAX_PRICE_AGE_SECS {
        return Err(ErrorCode::PriceStale);
    }
    if price.price <= 0 {
        return Err(ErrorCode::PriceNonPositive);
    }
    if (price.conf as u128) * 10_000 > (price.price as u128) * MAX_CONF_BPS {
        return Err(ErrorCode::PriceConfTooWide);
    }
    Ok(price)
}

/// Build `PriceUpdateV2` bytes with ema = spot. For tests and `test-helpers` only.
#[cfg(any(test, feature = "test-helpers"))]
pub fn encode_price_update(
    level_full: bool,
    feed_id: &[u8; 32],
    price: i64,
    conf: u64,
    expo: i32,
    publish_time: i64,
) -> Vec<u8> {
    encode_price_update_ema(
        level_full,
        feed_id,
        price,
        conf,
        expo,
        publish_time,
        price,
        conf,
    )
}

/// Build `PriceUpdateV2` bytes with an explicit ema. For tests and `test-helpers` only.
#[cfg(any(test, feature = "test-helpers"))]
#[allow(clippy::too_many_arguments)]
pub fn encode_price_update_ema(
    level_full: bool,
    feed_id: &[u8; 32],
    price: i64,
    conf: u64,
    expo: i32,
    publish_time: i64,
    ema_price: i64,
    ema_conf: u64,
) -> Vec<u8> {
    let mut d = PRICE_UPDATE_V2_DISCRIMINATOR.to_vec();
    d.extend_from_slice(&[0u8; 32]); // write_authority
    if level_full {
        d.push(1);
    } else {
        d.extend_from_slice(&[0, 13]); // Partial { num_signatures }
    }
    d.extend_from_slice(feed_id);
    d.extend_from_slice(&price.to_le_bytes());
    d.extend_from_slice(&conf.to_le_bytes());
    d.extend_from_slice(&expo.to_le_bytes());
    d.extend_from_slice(&publish_time.to_le_bytes());
    d.extend_from_slice(&publish_time.to_le_bytes()); // prev_publish_time
    d.extend_from_slice(&ema_price.to_le_bytes());
    d.extend_from_slice(&ema_conf.to_le_bytes());
    d.extend_from_slice(&[0u8; 8]); // posted_slot
    d
}

#[cfg(test)]
mod tests {
    use super::*;

    const FEED: [u8; 32] = [7; 32];
    const NOW: i64 = 1_000_000;

    fn enc(full: bool, feed: &[u8; 32], price: i64, conf: u64, t: i64) -> Vec<u8> {
        encode_price_update(full, feed, price, conf, -8, t)
    }
    fn parse(data: &[u8]) -> Result<PythPrice, ErrorCode> {
        parse_price_update(&PYTH_RECEIVER, data, &FEED, NOW)
    }

    #[test]
    fn pyth_ok() {
        let d = enc(true, &FEED, 15_000_000_000, 1_000_000, NOW - 5);
        assert_eq!(
            parse(&d).unwrap(),
            PythPrice {
                price: 15_000_000_000,
                conf: 1_000_000,
                expo: -8,
                publish_time: NOW - 5,
                ema_price: 15_000_000_000,
                ema_conf: 1_000_000,
            }
        );
    }
    #[test]
    fn pyth_discriminator_is_sha256_of_account_name() {
        let h = solana_sha256_hasher::hash(b"account:PriceUpdateV2").to_bytes();
        assert_eq!(h[..8], PRICE_UPDATE_V2_DISCRIMINATOR);
    }
    #[test]
    fn pyth_wrong_discriminator() {
        let mut d = enc(true, &FEED, 100, 0, NOW);
        d[0] ^= 1;
        assert_eq!(parse(&d), Err(ErrorCode::PriceWrongAccountType));
        assert_eq!(parse(&d[..7]), Err(ErrorCode::PriceAccountMissing));
    }
    #[test]
    fn pyth_reads_ema() {
        let d = encode_price_update_ema(true, &FEED, 100, 1, -8, NOW, 90, 2);
        let p = parse(&d).unwrap();
        assert_eq!((p.price, p.conf, p.ema_price, p.ema_conf), (100, 1, 90, 2));
    }
    #[test]
    fn pyth_wrong_owner() {
        let d = enc(true, &FEED, 100, 0, NOW);
        assert_eq!(
            parse_price_update(&Pubkey::new_unique(), &d, &FEED, NOW),
            Err(ErrorCode::PriceWrongOwner)
        );
    }
    #[test]
    fn pyth_partial() {
        assert_eq!(
            parse(&enc(false, &FEED, 100, 0, NOW)),
            Err(ErrorCode::PriceNotFullyVerified)
        );
    }
    #[test]
    fn pyth_feed_mismatch() {
        assert_eq!(
            parse(&enc(true, &[8; 32], 100, 0, NOW)),
            Err(ErrorCode::PriceFeedMismatch)
        );
    }
    #[test]
    fn pyth_stale() {
        assert_eq!(
            parse(&enc(true, &FEED, 100, 0, NOW - 61)),
            Err(ErrorCode::PriceStale)
        );
        assert!(parse(&enc(true, &FEED, 100, 0, NOW - 60)).is_ok());
    }
    #[test]
    fn pyth_future_publish_time_ok() {
        assert!(parse(&enc(true, &FEED, 100, 0, NOW + 5)).is_ok());
    }
    #[test]
    fn pyth_conf_too_wide() {
        // 3% of 10_000
        assert_eq!(
            parse(&enc(true, &FEED, 10_000, 300, NOW)),
            Err(ErrorCode::PriceConfTooWide)
        );
    }
    #[test]
    fn pyth_conf_exactly_200_bps_ok() {
        assert!(parse(&enc(true, &FEED, 10_000, 200, NOW)).is_ok());
        assert_eq!(
            parse(&enc(true, &FEED, 10_000, 201, NOW)),
            Err(ErrorCode::PriceConfTooWide)
        );
    }
    #[test]
    fn pyth_conf_u64_max_no_overflow() {
        assert_eq!(
            parse(&enc(true, &FEED, i64::MAX, u64::MAX, NOW)),
            Err(ErrorCode::PriceConfTooWide)
        );
    }
    #[test]
    fn pyth_negative_and_zero_price() {
        assert_eq!(
            parse(&enc(true, &FEED, -5, 0, NOW)),
            Err(ErrorCode::PriceNonPositive)
        );
        assert_eq!(
            parse(&enc(true, &FEED, 0, 0, NOW)),
            Err(ErrorCode::PriceNonPositive)
        );
    }
    #[test]
    fn pyth_short_data() {
        let d = enc(true, &FEED, 100, 0, NOW);
        assert_eq!(parse(&d[..40]), Err(ErrorCode::PriceAccountMissing));
        assert_eq!(parse(&d[..100]), Err(ErrorCode::PriceAccountMissing));
        assert_eq!(parse(&d[..124]), Err(ErrorCode::PriceAccountMissing));
        assert!(parse(&d[..125]).is_ok());
        assert_eq!(parse(&[]), Err(ErrorCode::PriceAccountMissing));
    }
}
