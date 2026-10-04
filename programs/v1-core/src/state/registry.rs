use anchor_lang::prelude::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum Tier {
    T1,
    T2,
    /// Open-seas tokens. Only Open Seas funds may buy them, within the
    /// captain-stake caps measured at cost; the captain's stake takes the
    /// first loss on a sale.
    T3,
}

/// Where the price of a listed token comes from. The NAV layout gives every
/// holding two price accounts, `[price_a, price_b]` (see `nav`).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum PriceSource {
    /// `price_a` = Pyth PriceUpdateV2 account for `feed_id`; `price_b` not read.
    Pyth { feed_id: [u8; 32] },
    /// `price_a` = the Kamino Lend reserve; `price_b` = the Pyth PriceUpdateV2
    /// account of the underlying token.
    KaminoReserve {
        reserve: Pubkey,
        underlying_feed_id: [u8; 32],
        underlying_decimals: u8,
    },
    /// `price_a` = the Switchboard On-Demand feed; `price_b` not read. The
    /// feed's job hash and queue must still equal `feed_hash` and `queue`.
    Switchboard {
        feed: Pubkey,
        feed_hash: [u8; 32],
        queue: Pubkey,
    },
}

/// A listed token. Seeds: `[b"token", mint]`.
#[account]
#[derive(InitSpace)]
pub struct TokenEntry {
    pub mint: Pubkey,
    pub price_source: PriceSource,
    pub tier: Tier,
    pub decimals: u8,
    /// False until the listing is applied after the timelock.
    pub active: bool,
    pub pending_price_source: PriceSource,
    pub pending_tier: Tier,
    /// 0 = nothing pending.
    pub pending_eta: i64,
    pub bump: u8,
    /// Switchboard only: the slow mark prices, shared by every fund. NAV
    /// reads move them (see `switchboard::next_marks`). Reset when the price
    /// source changes.
    pub marks: Marks,
}

/// The two mark prices of a Switchboard token, USD per whole token with 18
/// decimals (the feed's scale). All 0 = not seeded yet.
#[derive(
    AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, Default, InitSpace,
)]
pub struct Marks {
    /// Moves toward the feed value both ways, at most 10% per interval. Only
    /// for the deposit upper bound.
    pub deposit: i128,
    pub deposit_slot: u64,
    /// Drops to the feed value at once when the value is lower; rises at most
    /// 10% per interval. For everything slow: the EMA mode (breaker, peak,
    /// last pps, annual fee), the stake lower bound and the exit fee.
    pub low: i128,
    /// Slot of the last rise of `low` (or the seed).
    pub low_slot: u64,
    /// Slot of the first read after a listing or a price source change.
    pub seed_slot: u64,
}
