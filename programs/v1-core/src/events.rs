use anchor_lang::prelude::*;

#[event]
pub struct FundCreated {
    pub fund: Pubkey,
    pub captain: Pubkey,
    pub deposit: u64,
}

#[event]
pub struct Deposited {
    pub fund: Pubkey,
    pub member: Pubkey,
    pub amount: u64,
    pub shares: u64,
    pub price_per_share: u64,
}

#[event]
pub struct Exited {
    pub fund: Pubkey,
    pub member: Pubkey,
    pub shares_burned: u64,
    pub fee_shares: u64,
    /// The pps the fee was priced at: `max(last recorded pps, fresh upper-bound pps)`,
    /// or the last recorded pps when fresh NAV is absent or invalid.
    pub price_per_share: u64,
}

#[event]
pub struct FeeCharged {
    pub fund: Pubkey,
    pub member: Pubkey,
    pub fee_usdc: u64,
    pub fee_shares: u64,
    pub price_per_share: u64,
}

#[event]
pub struct TradeExecuted {
    pub fund: Pubkey,
    pub signer: Pubkey,
    pub venue: Pubkey,
    pub input_mint: Pubkey,
    pub output_mint: Pubkey,
    pub amount_in: u64,
    pub amount_out: u64,
    pub via_proposal: Option<u64>,
}

#[event]
pub struct ProposalCreated {
    pub fund: Pubkey,
    pub id: u64,
    pub deadline: i64,
    /// Venue data length and the route hash (see `Proposal.route_hash`).
    pub venue_data_len: u16,
    pub route_hash: [u8; 32],
}

#[event]
pub struct Voted {
    pub proposal: Pubkey,
    pub voter: Pubkey,
    pub yes: bool,
    pub weight: u64,
}

#[event]
pub struct BreakerChanged {
    pub fund: Pubkey,
    pub frozen: bool,
    pub price_per_share: u64,
    pub peak: u64,
}

#[event]
pub struct PolicyQueued {
    pub fund: Pubkey,
    pub eta: i64,
}

#[event]
pub struct PolicyApplied {
    pub fund: Pubkey,
}

#[event]
pub struct CaptainLog {
    pub fund: Pubkey,
    pub signer: Pubkey,
    pub reason_hash: [u8; 32],
    pub slot: u64,
}
