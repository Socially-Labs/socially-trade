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
    /// Open Seas fund: may buy T3 tokens. Set at creation, never changed.
    pub open_seas: bool,
    /// Cost of the T3 positions still held, USD (6 dp). Sum of `t3_basis_usd`.
    pub t3_cost_basis_usd: u64,
    /// Start of the current 30-day T3 buy window. Windows follow each other
    /// with no gap, from the fund's creation.
    pub t3_window_start: i64,
    /// USD (6 dp) of T3 buys in the current window.
    pub t3_window_buys_usd: u64,
    /// Cost basis of each holding bought as T3, USD (6 dp), in `holdings` order.
    pub t3_basis_usd: [u64; MAX_HOLDINGS],
    /// USD (6 dp) of T3 buys in the window before the current one.
    pub t3_prev_window_buys_usd: u64,
    /// Slot of the last move of `last_price_per_share`: it moves at most one
    /// step per interval (see `nav::update_breaker`).
    pub last_pps_slot: u64,
}
