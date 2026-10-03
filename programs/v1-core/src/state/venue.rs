use anchor_lang::prelude::*;

/// An approved venue program. Seeds: `[b"venue", program]`. One account per
/// program, so there is no limit on the number of venues.
#[account]
#[derive(InitSpace)]
pub struct VenueEntry {
    pub program: Pubkey,
    /// False until an approval is applied after the timelock.
    pub active: bool,
    /// The value `apply_venue` sets.
    pub pending_active: bool,
    /// 0 = nothing pending.
    pub pending_eta: i64,
    pub bump: u8,
}
