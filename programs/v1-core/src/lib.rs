//! socially.trade v1 core: social-trading funds on Solana.

pub mod constants;
pub mod errors;
pub mod events;
pub mod instructions;
pub mod state;

use {anchor_lang::prelude::*, instructions::*, state::Tier};

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
        feed_id: [u8; 32],
        tier: Tier,
        decimals: u8,
    ) -> Result<()> {
        instructions::admin::queue_token(ctx, feed_id, tier, decimals)
    }

    /// Anyone: apply a queued token change after the timelock.
    pub fn apply_token(ctx: Context<ApplyToken>) -> Result<()> {
        instructions::admin::apply_token(ctx)
    }

    /// Admin: queue a venue for a slot, or a removal (7-day timelock).
    pub fn queue_venue(ctx: Context<QueueVenue>, slot: u8, venue: Pubkey) -> Result<()> {
        instructions::admin::queue_venue(ctx, slot, venue)
    }

    /// Anyone: apply the queued venue change after the timelock.
    pub fn apply_venue(ctx: Context<ApplyVenue>) -> Result<()> {
        instructions::admin::apply_venue(ctx)
    }

    /// Admin: pause or unpause, immediate.
    pub fn set_paused(ctx: Context<SetPaused>, paused: bool) -> Result<()> {
        instructions::admin::set_paused(ctx, paused)
    }
}
