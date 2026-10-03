//! Admin: timelocked token and venue registries, immediate pause.

use {
    crate::{
        constants::{ADMIN_TIMELOCK_SECS, CONFIG_SEED, TOKEN_SEED, VENUE_SEED},
        errors::ErrorCode,
        state::{Config, PriceSource, Tier, TokenEntry, VenueEntry},
    },
    anchor_lang::prelude::*,
    anchor_spl::{token_2022::ID as TOKEN_2022_PROGRAM, token_interface::Mint},
};

/// Size of a base SPL mint. A Token-2022 mint with any extension is longer.
const BASE_MINT_LEN: usize = 82;

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
#[instruction(price_source: PriceSource, tier: Tier, decimals: u8)]
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
    price_source: PriceSource,
    tier: Tier,
    decimals: u8,
) -> Result<()> {
    // Exits never wait on token behavior: no freeze authority, and no
    // Token-2022 extensions (transfer fee, hook, pausable, ...). Every price
    // source gets this check. USDC is exempt.
    let mint = &ctx.accounts.mint;
    if mint.key() != ctx.accounts.config.usdc_mint {
        require!(mint.freeze_authority.is_none(), ErrorCode::UnsafeMint);
        let info = mint.to_account_info();
        require!(
            *info.owner != TOKEN_2022_PROGRAM || info.data_len() == BASE_MINT_LEN,
            ErrorCode::UnsafeMint
        );
    }
    let entry = &mut ctx.accounts.token_entry;
    entry.mint = ctx.accounts.mint.key();
    entry.decimals = decimals;
    entry.pending_price_source = price_source;
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
    entry.price_source = entry.pending_price_source;
    entry.tier = entry.pending_tier;
    entry.active = true;
    entry.pending_eta = 0;
    Ok(())
}

// --- venues ------------------------------------------------------------------

#[derive(Accounts)]
pub struct QueueVenue<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ ErrorCode::Unauthorized)]
    pub config: Account<'info, Config>,
    /// CHECK: only the key is used. The swap denylist (`venue_allowed`) still
    /// rejects v1-core, the token programs, the ATA program and system.
    pub venue_program: UncheckedAccount<'info>,
    #[account(
        init_if_needed,
        payer = admin,
        space = 8 + VenueEntry::INIT_SPACE,
        seeds = [VENUE_SEED, venue_program.key().as_ref()],
        bump
    )]
    pub venue_entry: Account<'info, VenueEntry>,
    pub system_program: Program<'info, System>,
}

/// Queue an approval (`active = true`) or a removal (`false`) of one venue.
/// A new queue overwrites the pending change and restarts the clock. The live
/// `active` stays in force until apply.
pub fn queue_venue(ctx: Context<QueueVenue>, active: bool) -> Result<()> {
    let entry = &mut ctx.accounts.venue_entry;
    entry.program = ctx.accounts.venue_program.key();
    entry.pending_active = active;
    entry.pending_eta = eta()?;
    entry.bump = ctx.bumps.venue_entry;
    Ok(())
}

#[derive(Accounts)]
pub struct ApplyVenue<'info> {
    #[account(mut, seeds = [VENUE_SEED, venue_entry.program.as_ref()], bump = venue_entry.bump)]
    pub venue_entry: Account<'info, VenueEntry>,
}

/// Permissionless: anyone may apply a venue change whose timelock has elapsed.
pub fn apply_venue(ctx: Context<ApplyVenue>) -> Result<()> {
    let entry = &mut ctx.accounts.venue_entry;
    check_due(entry.pending_eta)?;
    entry.active = entry.pending_active;
    entry.pending_eta = 0;
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
