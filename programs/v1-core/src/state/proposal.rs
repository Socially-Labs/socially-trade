use anchor_lang::prelude::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum ProposalStatus {
    Open,
    Executed,
    Cancelled,
}

/// A trade proposal. Seeds: `[b"proposal", fund, id.to_le_bytes()]`.
#[account]
#[derive(InitSpace)]
pub struct Proposal {
    pub fund: Pubkey,
    pub id: u64,
    pub proposer: Pubkey,
    pub venue: Pubkey,
    pub input_mint: Pubkey,
    pub output_mint: Pubkey,
    pub amount_in: u64,
    pub min_out: u64,
    /// Opaque venue instruction data, zero-padded.
    pub venue_data: [u8; 64],
    pub venue_data_len: u8,
    pub created_at: i64,
    pub deadline: i64,
    pub total_shares_snapshot: u64,
    pub yes_weight: u64,
    pub no_weight: u64,
    pub status: ProposalStatus,
    pub bump: u8,
}

/// One member's vote. Seeds: `[b"vote", proposal, voter]`.
/// `init` on this account rejects a second vote.
#[account]
#[derive(InitSpace)]
pub struct VoteRecord {
    pub proposal: Pubkey,
    pub voter: Pubkey,
    pub yes: bool,
    pub weight: u64,
    pub bump: u8,
}
