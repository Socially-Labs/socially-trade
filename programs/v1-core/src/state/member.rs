use anchor_lang::prelude::*;

/// A fund member. Seeds: `[b"member", fund, owner]`.
#[account]
#[derive(InitSpace)]
pub struct Member {
    pub fund: Pubkey,
    pub owner: Pubkey,
    /// High-water mark, USDC base units.
    pub hwm: u64,
    pub joined_at: i64,
    /// Anniversary anchor for the performance fee.
    pub last_fee_at: i64,
    pub last_deposit_ts: i64,
    pub is_captain: bool,
    pub bump: u8,
}
