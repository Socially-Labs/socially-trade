use anchor_lang::prelude::*;

/// Program errors. On chain each code is `6000 + variant index`, so only append.
#[derive(PartialEq, Eq)]
#[error_code]
pub enum ErrorCode {
    #[msg("Arithmetic overflow")]
    MathOverflow,
    #[msg("Signer is not authorized")]
    Unauthorized,
    #[msg("Protocol is paused")]
    Paused,
    #[msg("Timelock has not elapsed")]
    TimelockNotElapsed,
    #[msg("Nothing is pending")]
    NothingPending,
    #[msg("Venue is not on the allowlist")]
    VenueNotAllowed,
    /// Unused since the venue registry. Kept so later codes do not move.
    #[msg("Venue slot is already taken")]
    VenueSlotTaken,
    #[msg("Token is not listed")]
    TokenNotListed,
    #[msg("Token is not active")]
    TokenInactive,
    #[msg("Fund already holds the maximum number of tokens")]
    TooManyHoldings,
    #[msg("Holding not found")]
    HoldingNotFound,
    #[msg("Price account is not owned by the Pyth receiver")]
    PriceWrongOwner,
    #[msg("Price update is not fully verified")]
    PriceNotFullyVerified,
    #[msg("Price feed does not match the token entry")]
    PriceFeedMismatch,
    #[msg("Price is stale")]
    PriceStale,
    #[msg("Price confidence interval is too wide")]
    PriceConfTooWide,
    #[msg("Price is not positive")]
    PriceNonPositive,
    #[msg("Price account is missing")]
    PriceAccountMissing,
    #[msg("Operation would mint or burn zero shares")]
    ZeroShares,
    #[msg("Amount is zero")]
    ZeroAmount,
    #[msg("Captain deposit is below the minimum")]
    CaptainDepositTooSmall,
    #[msg("Captain stake would fall below the floor")]
    CaptainStakeFloor,
    #[msg("Exit is larger than the member's shares")]
    ExitTooLarge,
    #[msg("Fund is frozen")]
    FundFrozen,
    #[msg("Trade is larger than the autonomous limit")]
    TradeTooLarge,
    #[msg("Trade is larger than the delegate's per-trade limit")]
    DelegateTradeLimit,
    #[msg("Trade exceeds the delegate's daily limit")]
    DelegateDailyLimit,
    #[msg("Slippage is too high")]
    SlippageTooHigh,
    #[msg("Swap output was not received")]
    OutputNotReceived,
    #[msg("Venue took more input than allowed")]
    InputOverdrawn,
    #[msg("Tier cap exceeded")]
    TierCapExceeded,
    #[msg("Policy is looser than the protocol floor")]
    PolicyBelowFloor,
    #[msg("Policy change is not stricter")]
    NotStricter,
    #[msg("Proposal is not open")]
    ProposalNotOpen,
    #[msg("Proposal has expired")]
    ProposalExpired,
    #[msg("Proposal has not passed")]
    ProposalNotPassed,
    #[msg("Member deposited after the proposal was created")]
    VoteAfterDeposit,
    #[msg("Signer is not a member of this fund")]
    NotMember,
    #[msg("Fee is not due")]
    FeeNotDue,
    #[msg("Input and output mint are the same")]
    SameMint,
    #[msg("Price account is not a PriceUpdateV2 account")]
    PriceWrongAccountType,
    #[msg("Fund is closed (no shares outstanding)")]
    FundClosed,
    #[msg("Fund NAV is zero while shares are outstanding")]
    NavZero,
    #[msg("Mint has a freeze authority or Token-2022 extensions")]
    UnsafeMint,
    #[msg("Venue instruction data is too long")]
    VenueDataTooLong,
    #[msg("Venue data or venue accounts do not match the proposal route")]
    VenueDataMismatch,
    #[msg("Venue or mints do not match the proposal")]
    ProposalMismatch,
    #[msg("Venue changed the size of a fund vault")]
    VaultResized,
    #[msg("Exit accounts list the same holding twice")]
    DuplicateHolding,
    /// Unused since every price source is supported. Kept so later codes do not move.
    #[msg("Price source not supported yet")]
    PriceSourceUnsupported,
    #[msg("Kamino reserve is not a klend Reserve account")]
    ReserveInvalid,
    #[msg("Kamino reserve does not match the token entry")]
    ReserveMismatch,
    #[msg("Switchboard feed is not a PullFeedAccountData account")]
    FeedInvalid,
    #[msg("Switchboard feed does not match the token entry")]
    FeedMismatch,
    #[msg("Switchboard result has too few oracle samples")]
    FeedTooFewSamples,
    #[msg("T3 buys need an Open Seas fund")]
    NotOpenSeas,
    #[msg("T3 buys exceed the captain's stake")]
    T3CapExceeded,
}
