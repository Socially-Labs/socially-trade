use anchor_lang::prelude::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum Tier {
    T1,
    T2,
}

/// A listed token. Seeds: `[b"token", mint]`.
#[account]
#[derive(InitSpace)]
pub struct TokenEntry {
    pub mint: Pubkey,
    pub feed_id: [u8; 32],
    pub tier: Tier,
    pub decimals: u8,
    /// False until the listing is applied after the timelock.
    pub active: bool,
    pub pending_feed_id: [u8; 32],
    pub pending_tier: Tier,
    /// 0 = nothing pending.
    pub pending_eta: i64,
    pub bump: u8,
}
