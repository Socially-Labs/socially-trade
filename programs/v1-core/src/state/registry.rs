use anchor_lang::prelude::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum Tier {
    T1,
    T2,
    /// Open-seas tokens. Buys are rejected until the open-seas rules exist.
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
    /// `price_a` = the Switchboard On-Demand feed; `price_b` not read.
    Switchboard { feed: Pubkey },
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
}
