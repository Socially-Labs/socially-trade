use anchor_lang::prelude::*;

/// A trading delegate of a fund. Seeds: `[b"delegate", fund, key]`.
#[account]
#[derive(InitSpace)]
pub struct Delegate {
    pub fund: Pubkey,
    pub key: Pubkey,
    /// USDC base units.
    pub max_trade_usd: u64,
    pub daily_volume_usd: u64,
    pub day_start: i64,
    pub day_volume: u64,
    pub bump: u8,
}
