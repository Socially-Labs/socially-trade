use {crate::constants::MAX_VENUES, anchor_lang::prelude::*};

/// Global protocol config. Seeds: `[b"config"]`.
#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    pub usdc_mint: Pubkey,
    pub paused: bool,
    /// `Pubkey::default()` = empty slot.
    pub venues: [Pubkey; MAX_VENUES],
    /// `Pubkey::default()` = none pending.
    pub pending_venue: Pubkey,
    pub pending_venue_slot: u8,
    pub pending_venue_eta: i64,
    pub bump: u8,
}
