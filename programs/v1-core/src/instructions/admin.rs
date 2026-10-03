//! Admin: timelocked token registry and venue allowlist, immediate pause.

use {
    crate::{
        constants::{ADMIN_TIMELOCK_SECS, CONFIG_SEED, MAX_VENUES, TOKEN_SEED},
        errors::ErrorCode,
        state::{Config, Tier, TokenEntry},
    },
    anchor_lang::prelude::*,
    anchor_spl::token_interface::Mint,
};

/// The time at which an action queued now may be applied.
fn eta() -> Result<i64> {
    Clock::get()?
        .unix_timestamp
        .checked_add(ADMIN_TIMELOCK_SECS)
        .ok_or_else(|| error!(ErrorCode::MathOverflow))
}

/// Fail unless something is pending and its timelock has elapsed.
fn check_due(pending_eta: i64) -> Result<()> {
    require!(pending_eta != 0, ErrorCode::NothingPending);
    require!(
        Clock::get()?.unix_timestamp >= pending_eta,
        ErrorCode::TimelockNotElapsed
    );
    Ok(())
}

// --- token registry --------------------------------------------------------

#[derive(Accounts)]
#[instruction(feed_id: [u8; 32], tier: Tier, decimals: u8)]
pub struct QueueToken<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ ErrorCode::Unauthorized)]
    pub config: Account<'info, Config>,
    #[account(constraint = mint.decimals == decimals)]
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(
        init_if_needed,
        payer = admin,
        space = 8 + TokenEntry::INIT_SPACE,
        seeds = [TOKEN_SEED, mint.key().as_ref()],
        bump
    )]
    pub token_entry: Account<'info, TokenEntry>,
    pub system_program: Program<'info, System>,
}

/// Queue a listing or a listing change. A new queue overwrites the pending
/// change and restarts the clock. The live fields stay in force until apply.
pub fn queue_token(
    ctx: Context<QueueToken>,
    feed_id: [u8; 32],
    tier: Tier,
    decimals: u8,
) -> Result<()> {
    let entry = &mut ctx.accounts.token_entry;
    entry.mint = ctx.accounts.mint.key();
    entry.decimals = decimals;
    entry.pending_feed_id = feed_id;
    entry.pending_tier = tier;
    entry.pending_eta = eta()?;
    entry.bump = ctx.bumps.token_entry;
    Ok(())
}

#[derive(Accounts)]
pub struct ApplyToken<'info> {
    #[account(mut, seeds = [TOKEN_SEED, token_entry.mint.as_ref()], bump = token_entry.bump)]
    pub token_entry: Account<'info, TokenEntry>,
}

/// Permissionless: anyone may apply a change whose timelock has elapsed.
pub fn apply_token(ctx: Context<ApplyToken>) -> Result<()> {
    let entry = &mut ctx.accounts.token_entry;
    check_due(entry.pending_eta)?;
    entry.feed_id = entry.pending_feed_id;
    entry.tier = entry.pending_tier;
    entry.active = true;
    entry.pending_eta = 0;
    Ok(())
}

// --- venues ------------------------------------------------------------------

#[derive(Accounts)]
pub struct QueueVenue<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ ErrorCode::Unauthorized)]
    pub config: Account<'info, Config>,
}

/// Queue `venue` into `slot`; `Pubkey::default()` queues a removal. One change
/// is pending at a time: a new queue overwrites it and restarts the clock.
pub fn queue_venue(ctx: Context<QueueVenue>, slot: u8, venue: Pubkey) -> Result<()> {
    let config = &mut ctx.accounts.config;
    let i = slot as usize;
    require!(i < MAX_VENUES, ErrorCode::VenueNotAllowed);
    require!(
        venue == Pubkey::default() || config.venues[i] == Pubkey::default(),
        ErrorCode::VenueSlotTaken
    );
    config.pending_venue = venue;
    config.pending_venue_slot = slot;
    config.pending_venue_eta = eta()?;
    Ok(())
}

#[derive(Accounts)]
pub struct ApplyVenue<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
}

/// Permissionless: anyone may apply a venue change whose timelock has elapsed.
pub fn apply_venue(ctx: Context<ApplyVenue>) -> Result<()> {
    let config = &mut ctx.accounts.config;
    check_due(config.pending_venue_eta)?;
    // queue_venue bounds the slot, so the index is in range.
    let slot = config.pending_venue_slot as usize;
    config.venues[slot] = config.pending_venue;
    config.pending_venue = Pubkey::default();
    config.pending_venue_slot = 0;
    config.pending_venue_eta = 0;
    Ok(())
}

// --- pause -------------------------------------------------------------------

#[derive(Accounts)]
pub struct SetPaused<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ ErrorCode::Unauthorized)]
    pub config: Account<'info, Config>,
}

/// Immediate, no timelock.
pub fn set_paused(ctx: Context<SetPaused>, paused: bool) -> Result<()> {
    ctx.accounts.config.paused = paused;
    Ok(())
}
