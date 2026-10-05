//! socially.trade v1 core: social-trading funds on Solana.

pub mod constants;
pub mod errors;
pub mod events;
pub mod instructions;
pub mod kamino;
pub mod math;
pub mod nav;
pub mod pyth;
pub mod state;
pub mod switchboard;

use {
    anchor_lang::prelude::*,
    instructions::*,
    state::{PolicyParams, PriceSource, Tier},
};

declare_id!("HjRBKzvcuSiztYH97iL6RtbwDU9Mw8AF3Av3Q1nJgQsi");

#[program]
pub mod v1_core {
    use super::*;

    /// Create the global config. Only the upgrade authority; it becomes admin.
    pub fn initialize_config(ctx: Context<InitializeConfig>) -> Result<()> {
        instructions::initialize_config::handler(ctx)
    }

    /// Admin: queue a token listing or change (7-day timelock).
    pub fn queue_token(
        ctx: Context<QueueToken>,
        price_source: PriceSource,
        tier: Tier,
        decimals: u8,
    ) -> Result<()> {
        instructions::admin::queue_token(ctx, price_source, tier, decimals)
    }

    /// Anyone: apply a queued token change after the timelock.
    pub fn apply_token(ctx: Context<ApplyToken>) -> Result<()> {
        instructions::admin::apply_token(ctx)
    }

    /// Admin: queue a venue approval (`active`) or removal (7-day timelock).
    pub fn queue_venue(ctx: Context<QueueVenue>, active: bool) -> Result<()> {
        instructions::admin::queue_venue(ctx, active)
    }

    /// Anyone: apply the queued venue change after the timelock.
    pub fn apply_venue(ctx: Context<ApplyVenue>) -> Result<()> {
        instructions::admin::apply_venue(ctx)
    }

    /// Admin: pause or unpause, immediate.
    pub fn set_paused(ctx: Context<SetPaused>, paused: bool) -> Result<()> {
        instructions::admin::set_paused(ctx, paused)
    }

    /// Captain: open a fund with a USDC stake; mints 1:1 non-transferable shares.
    /// `open_seas` lets the fund buy T3 tokens (see `swap`).
    pub fn create_fund(
        ctx: Context<CreateFund>,
        fund_id: u64,
        deposit: u64,
        open_seas: bool,
    ) -> Result<()> {
        instructions::create_fund::create_fund(ctx, fund_id, deposit, open_seas)
    }

    /// Anyone: buy shares at NAV with USDC; fewer than `min_shares` fails.
    /// Remaining accounts: NAV layout (see `nav`).
    pub fn deposit(ctx: Context<Deposit>, amount: u64, min_shares: u64) -> Result<()> {
        instructions::deposit::deposit(ctx, amount, min_shares)
    }

    /// Member: leave with a pro-rata slice of every holding, in kind. Never
    /// blocked by pause, freeze or prices. Remaining accounts: see `exit`.
    pub fn exit<'info>(ctx: Context<'info, Exit<'info>>, shares: u64) -> Result<()> {
        instructions::exit::exit(ctx, shares)
    }

    /// Captain: add a trading delegate with a per-trade and a daily USD limit.
    pub fn add_delegate(
        ctx: Context<AddDelegate>,
        key: Pubkey,
        max_trade_usd: u64,
        daily_volume_usd: u64,
    ) -> Result<()> {
        instructions::delegate::add_delegate(ctx, key, max_trade_usd, daily_volume_usd)
    }

    /// Captain: change the limits of a delegate.
    pub fn update_delegate(
        ctx: Context<UpdateDelegate>,
        max_trade_usd: u64,
        daily_volume_usd: u64,
    ) -> Result<()> {
        instructions::delegate::update_delegate(ctx, max_trade_usd, daily_volume_usd)
    }

    /// Captain or delegate: swap fund tokens through an allowlisted venue,
    /// checked by vault balances. Remaining accounts: see `swap`.
    pub fn swap<'info>(
        ctx: Context<'info, Swap<'info>>,
        amount_in: u64,
        min_out: u64,
        venue_data: Vec<u8>,
    ) -> Result<()> {
        instructions::swap::swap(ctx, amount_in, min_out, venue_data)
    }

    /// Captain or delegate: propose a trade of any size for a crew vote.
    /// Remaining accounts: the venue accounts (hashed into `route_hash`).
    pub fn propose_trade<'info>(
        ctx: Context<'info, ProposeTrade<'info>>,
        amount_in: u64,
        min_out: u64,
        venue_data: Vec<u8>,
    ) -> Result<()> {
        instructions::proposal::propose_trade(ctx, amount_in, min_out, venue_data)
    }

    /// Member: vote once on an open proposal, weighted by share balance.
    pub fn vote(ctx: Context<CastVote>, yes: bool) -> Result<()> {
        instructions::proposal::vote(ctx, yes)
    }

    /// Anyone: execute a passed proposal through the swap core.
    /// Accounts and remaining accounts: as `swap`, plus the proposal.
    /// `venue_data` and the venue accounts must match `proposal.route_hash`.
    pub fn execute_proposal<'info>(
        ctx: Context<'info, ExecuteProposal<'info>>,
        venue_data: Vec<u8>,
    ) -> Result<()> {
        instructions::proposal::execute_proposal(ctx, venue_data)
    }

    /// Captain: cancel an open proposal.
    pub fn cancel_proposal(ctx: Context<CancelProposal>) -> Result<()> {
        instructions::proposal::cancel_proposal(ctx)
    }

    /// Captain: remove a delegate and take back the rent.
    pub fn revoke_delegate(ctx: Context<RevokeDelegate>) -> Result<()> {
        instructions::delegate::revoke_delegate(ctx)
    }

    /// Captain: change the fund policy. Stricter-or-equal in every field applies
    /// now; anything looser queues for 48 h (a new queue restarts the clock).
    pub fn update_policy(ctx: Context<UpdatePolicy>, new: PolicyParams) -> Result<()> {
        instructions::policy::update_policy(ctx, new)
    }

    /// Anyone: apply the queued policy after its delay.
    pub fn apply_policy(ctx: Context<ApplyPolicy>) -> Result<()> {
        instructions::policy::apply_policy(ctx)
    }

    /// Anyone: recompute NAV (EMA) and move the drawdown breaker.
    /// Remaining accounts: NAV layout (see `nav`).
    pub fn poke_nav(ctx: Context<PokeNav>) -> Result<()> {
        instructions::policy::poke_nav(ctx)
    }

    /// Anyone: charge a member's yearly performance fee (not the captain).
    /// Needs fresh prices. Remaining accounts: NAV layout (see `nav`).
    pub fn charge_annual_fee<'info>(ctx: Context<'info, ChargeAnnualFee<'info>>) -> Result<()> {
        instructions::fees::charge_annual_fee(ctx)
    }

    /// Captain or delegate: log a reason hash on chain (event only, no state).
    pub fn captain_log(ctx: Context<WriteLog>, reason_hash: [u8; 32]) -> Result<()> {
        instructions::captain_log::captain_log(ctx, reason_hash)
    }
}
