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
    /// Switchboard only: the slow mark price, USD per whole token with 18
    /// decimals (the feed's scale), shared by every fund. 0 = not set yet.
    /// NAV reads move it (see `switchboard::next_mark`).
    pub mark_price: i128,
    /// Slot of the last mark update.
    pub mark_slot: u64,
}
