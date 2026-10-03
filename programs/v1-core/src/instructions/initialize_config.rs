use {
    crate::{constants::CONFIG_SEED, state::Config},
    anchor_lang::prelude::*,
};

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(init, payer = admin, space = 8 + Config::INIT_SPACE, seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, Config>,
    pub system_program: Program<'info, System>,
}

/// One-shot: `init` fails on a second call. The first caller becomes admin.
pub fn handler(ctx: Context<InitializeConfig>, usdc_mint: Pubkey) -> Result<()> {
    ctx.accounts.config.set_inner(Config {
        admin: ctx.accounts.admin.key(),
        usdc_mint,
        paused: false,
        venues: Default::default(),
        pending_venue: Pubkey::default(),
        pending_venue_slot: 0,
        pending_venue_eta: 0,
        bump: ctx.bumps.config,
    });
    Ok(())
}
