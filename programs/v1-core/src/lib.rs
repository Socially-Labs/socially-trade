//! socially.trade v1 core: social-trading funds on Solana.

pub mod constants;
pub mod errors;
pub mod events;
pub mod instructions;
pub mod state;

use {anchor_lang::prelude::*, instructions::*};

declare_id!("HjRBKzvcuSiztYH97iL6RtbwDU9Mw8AF3Av3Q1nJgQsi");

#[program]
pub mod v1_core {
    use super::*;

    /// Create the global config. The signer becomes admin.
    pub fn initialize_config(ctx: Context<InitializeConfig>, usdc_mint: Pubkey) -> Result<()> {
        instructions::initialize_config::handler(ctx, usdc_mint)
    }
}
