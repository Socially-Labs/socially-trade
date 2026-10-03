use {
    crate::{
        constants::{CONFIG_SEED, USDC_DECIMALS},
        errors::ErrorCode,
        program::V1Core,
        state::Config,
    },
    anchor_lang::prelude::*,
    anchor_spl::token_interface::Mint,
};

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(init, payer = admin, space = 8 + Config::INIT_SPACE, seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, Config>,
    #[account(constraint = usdc_mint.decimals == USDC_DECIMALS)]
    pub usdc_mint: InterfaceAccount<'info, Mint>,
    /// This program. Its ProgramData holds the upgrade authority.
    #[account(constraint = program.programdata_address()? == Some(program_data.key()))]
    pub program: Program<'info, V1Core>,
    #[account(
        constraint = program_data.upgrade_authority_address == Some(admin.key())
            @ ErrorCode::Unauthorized
    )]
    pub program_data: Account<'info, ProgramData>,
    pub system_program: Program<'info, System>,
}

/// One-shot: `init` fails on a second call. Only the program's upgrade
/// authority may call it, so a deploy cannot be front-run.
pub fn handler(ctx: Context<InitializeConfig>) -> Result<()> {
    ctx.accounts.config.set_inner(Config {
        admin: ctx.accounts.admin.key(),
        usdc_mint: ctx.accounts.usdc_mint.key(),
        paused: false,
        venues: Default::default(),
        pending_venue: Pubkey::default(),
        pending_venue_slot: 0,
        pending_venue_eta: 0,
        bump: ctx.bumps.config,
    });
    Ok(())
}
