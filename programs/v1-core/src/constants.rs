//! Protocol constants. Amounts are USDC base units (6 dp).

pub const MAX_HOLDINGS: usize = 8;
pub const MAX_VENUES: usize = 4;
/// Max venue instruction data for `swap` (fits a Jupiter route).
pub const MAX_VENUE_DATA: usize = 1024;
/// Max venue instruction data stored in a `Proposal` (`venue_data: [u8; 64]`).
pub const MAX_PROPOSAL_VENUE_DATA: usize = 64;
pub const CAPTAIN_MIN_DEPOSIT: u64 = 250_000_000;
pub const CAPTAIN_MIN_STAKE_BPS: u16 = 500;
pub const PERF_FEE_BPS: u16 = 1000;
pub const ADMIN_TIMELOCK_SECS: i64 = 604_800;
pub const POLICY_LOOSEN_DELAY_SECS: i64 = 172_800;
pub const YEAR_SECS: i64 = 31_536_000;
pub const SHARE_DECIMALS: u8 = 6;
pub const USDC_DECIMALS: u8 = 6;
pub const BPS_DENOMINATOR: u64 = 10_000;

// Policy defaults.
pub const DEFAULT_AUTONOMOUS_BPS: u16 = 1000;
pub const DEFAULT_DRAWDOWN_BPS: u16 = 3000;
pub const DEFAULT_MAX_SLIPPAGE_BPS: u16 = 100;
pub const DEFAULT_VOTE_WINDOW_SECS: u32 = 1800;

// Protocol floor: a policy may never be looser than these.
pub const MAX_AUTONOMOUS_BPS: u16 = 2500;
pub const MAX_DRAWDOWN_BPS: u16 = 5000;
pub const MAX_SLIPPAGE_BPS: u16 = 500;
/// Cap on the price-guard band of a sale into USDC (3x max slippage, at most this).
pub const MAX_SELL_TO_USDC_SLIPPAGE_BPS: u16 = 1500;
pub const MIN_VOTE_WINDOW_SECS: u32 = 60;
pub const MAX_VOTE_WINDOW_SECS: u32 = 604_800;

// Tier caps after every buy, in bps of NAV.
pub const T2_TOKEN_CAP_BPS: u16 = 2500;
pub const T2_TOTAL_CAP_BPS: u16 = 5000;

// Pyth.
pub const PYTH_RECEIVER_ID: anchor_lang::prelude::Pubkey =
    anchor_lang::prelude::pubkey!("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ");
pub const MAX_PRICE_AGE_SECS: u64 = 60;
pub const MAX_CONF_BPS: u64 = 200;

// PDA seeds.
pub const CONFIG_SEED: &[u8] = b"config";
pub const TOKEN_SEED: &[u8] = b"token";
pub const FUND_SEED: &[u8] = b"fund";
pub const SHARES_SEED: &[u8] = b"shares";
pub const MEMBER_SEED: &[u8] = b"member";
pub const DELEGATE_SEED: &[u8] = b"delegate";
pub const POLICY_SEED: &[u8] = b"policy";
pub const PROPOSAL_SEED: &[u8] = b"proposal";
pub const VOTE_SEED: &[u8] = b"vote";
