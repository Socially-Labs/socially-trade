use anchor_lang::prelude::*;

/// Global protocol config. Seeds: `[b"config"]`.
/// Approved venues are separate `VenueEntry` accounts.
#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    pub usdc_mint: Pubkey,
    pub paused: bool,
    pub bump: u8,
}
