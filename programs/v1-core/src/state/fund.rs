use {crate::constants::MAX_HOLDINGS, anchor_lang::prelude::*};

/// A fund. Seeds: `[b"fund", captain, fund_id.to_le_bytes()]`.
/// Share mint seeds: `[b"shares", fund]`. Vaults: ATA(fund PDA, mint) on the mint's token program.
#[account]
#[derive(InitSpace)]
pub struct Fund {
    pub captain: Pubkey,
    /// Chosen by the captain; part of the seeds.
    pub fund_id: u64,
    pub share_mint: Pubkey,
    /// `[0]` = USDC; `Pubkey::default()` = empty.
    pub holdings: [Pubkey; MAX_HOLDINGS],
    pub holdings_len: u8,
    /// Mirrors the share mint supply.
    pub total_shares: u64,
    /// USDC base units per 1e6 share units (1_000_000 = $1).
    pub last_price_per_share: u64,
    pub peak_price_per_share: u64,
    pub frozen: bool,
    pub proposal_count: u64,
    pub created_at: i64,
    pub bump: u8,
    /// Start of the rolling 24 h autonomous budget (captain and delegate trades).
    pub window_start: i64,
    /// USD (6 dp) traded autonomously since `window_start`. Votes do not count.
    pub window_volume_usd: u64,
}
