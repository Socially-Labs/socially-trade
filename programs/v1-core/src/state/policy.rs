use anchor_lang::prelude::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub struct PolicyParams {
    pub autonomous_bps: u16,
    pub drawdown_bps: u16,
    pub max_slippage_bps: u16,
    pub vote_window_secs: u32,
}

/// A fund's risk policy. Seeds: `[b"policy", fund]`.
#[account]
#[derive(InitSpace)]
pub struct Policy {
    pub fund: Pubkey,
    pub params: PolicyParams,
    pub pending: PolicyParams,
    /// 0 = none.
    pub pending_eta: i64,
    pub bump: u8,
}
