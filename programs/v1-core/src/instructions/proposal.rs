//! Crew vote for trades above the autonomous limit.
//!
//! The captain (or a delegate) proposes a trade. Members vote once, weighted
//! by their share balance (shares are non-transferable). A member who
//! deposited at or after the proposal time cannot vote, so votes cannot be
//! bought. When yes > 50% of the share supply at proposal time, anyone may
//! execute the trade before the deadline, through the same checked swap core
//! (price guard, pause and breaker, venue allowlist, balance checks, tier caps),
//! without the autonomous size limit and without a delegate charge.
//!
//! Only sha256 of the venue data is stored. The executor passes the bytes.

use {
    crate::{
        constants::*,
        errors::ErrorCode,
        events::{ProposalCreated, Voted},
        // Glob: the composite `Trade` needs its generated modules in scope.
        instructions::swap::*,
        state::{Config, Delegate, Fund, Member, Policy, Proposal, ProposalStatus, VoteRecord},
    },
    anchor_lang::prelude::*,
    anchor_spl::token_interface::TokenAccount,
};

#[derive(Accounts)]
pub struct ProposeTrade<'info> {
    /// The captain or a delegate key. Pays for the proposal account.
    #[account(mut)]
    pub proposer: Signer<'info>,
    /// Required unless the proposer is the captain.
    pub delegate: Option<Box<Account<'info, Delegate>>>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(
        mut,
        seeds = [FUND_SEED, fund.captain.as_ref(), &fund.fund_id.to_le_bytes()],
        bump = fund.bump
    )]
    pub fund: Box<Account<'info, Fund>>,
    #[account(seeds = [POLICY_SEED, fund.key().as_ref()], bump = policy.bump)]
    pub policy: Box<Account<'info, Policy>>,
    #[account(
        init,
        payer = proposer,
        space = 8 + Proposal::INIT_SPACE,
        seeds = [PROPOSAL_SEED, fund.key().as_ref(), &fund.proposal_count.to_le_bytes()],
        bump
    )]
    pub proposal: Box<Account<'info, Proposal>>,
    /// CHECK: must be an allowed venue (`venue_allowed`).
    pub venue_program: UncheckedAccount<'info>,
    /// CHECK: only the key is used; it must be listed (via `input_entry`).
    pub input_mint: UncheckedAccount<'info>,
    /// CHECK: only the key is used; it must be listed (via `output_entry`).
    pub output_mint: UncheckedAccount<'info>,
    /// CHECK: the active TokenEntry PDA of `input_mint`. Not read for USDC.
    pub input_entry: UncheckedAccount<'info>,
    /// CHECK: the active TokenEntry PDA of `output_mint`. Not read for USDC.
    pub output_entry: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub fn propose_trade(
    ctx: Context<ProposeTrade>,
    amount_in: u64,
    min_out: u64,
    venue_data: Vec<u8>,
) -> Result<()> {
    let a = ctx.accounts;
    let signer = a.proposer.key();
    let fund_key = a.fund.key();
    if signer != a.fund.captain {
        let d = a.delegate.as_deref().ok_or(ErrorCode::Unauthorized)?;
        require!(
            d.key == signer && d.fund == fund_key,
            ErrorCode::Unauthorized
        );
    }
    require!(
        venue_data.len() <= MAX_VENUE_DATA,
        ErrorCode::VenueDataTooLong
    );
    let (input, output) = (a.input_mint.key(), a.output_mint.key());
    require_keys_neq!(input, output, ErrorCode::SameMint);
    require!(amount_in > 0, ErrorCode::ZeroAmount);
    require!(
        venue_allowed(&a.config, &a.venue_program.key()),
        ErrorCode::VenueNotAllowed
    );
    listed(&a.input_entry, &input, &a.config)?;
    listed(&a.output_entry, &output, &a.config)?;

    let now = Clock::get()?.unix_timestamp;
    let deadline = now
        .checked_add(a.policy.params.vote_window_secs as i64)
        .ok_or(ErrorCode::MathOverflow)?;
    let id = a.fund.proposal_count;
    a.fund.proposal_count = id.checked_add(1).ok_or(ErrorCode::MathOverflow)?;
    let venue_data_hash = solana_sha256_hasher::hash(&venue_data).to_bytes();
    a.proposal.set_inner(Proposal {
        fund: fund_key,
        id,
        proposer: signer,
        venue: a.venue_program.key(),
        input_mint: input,
        output_mint: output,
        amount_in,
        min_out,
        venue_data_hash,
        created_at: now,
        deadline,
        total_shares_snapshot: a.fund.total_shares,
        yes_weight: 0,
        no_weight: 0,
        status: ProposalStatus::Open,
        bump: ctx.bumps.proposal,
    });
    emit!(ProposalCreated {
        fund: fund_key,
        id,
        deadline,
        venue_data_len: venue_data.len() as u16,
        venue_data_hash,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct CastVote<'info> {
    #[account(mut)]
    pub voter: Signer<'info>,
    #[account(
        seeds = [FUND_SEED, fund.captain.as_ref(), &fund.fund_id.to_le_bytes()],
        bump = fund.bump
    )]
    pub fund: Box<Account<'info, Fund>>,
    #[account(
        mut,
        seeds = [PROPOSAL_SEED, fund.key().as_ref(), &proposal.id.to_le_bytes()],
        bump = proposal.bump
    )]
    pub proposal: Box<Account<'info, Proposal>>,
    /// CHECK: the voter's Member PDA. Read in the handler, so that a missing
    /// account gives `NotMember`.
    #[account(seeds = [MEMBER_SEED, fund.key().as_ref(), voter.key().as_ref()], bump)]
    pub member: UncheckedAccount<'info>,
    /// CHECK: a share token account of the voter. Read in the handler.
    pub voter_shares: UncheckedAccount<'info>,
    /// `init` rejects a second vote ("already in use").
    #[account(
        init,
        payer = voter,
        space = 8 + VoteRecord::INIT_SPACE,
        seeds = [VOTE_SEED, proposal.key().as_ref(), voter.key().as_ref()],
        bump
    )]
    pub vote_record: Box<Account<'info, VoteRecord>>,
    pub system_program: Program<'info, System>,
}

pub fn vote(ctx: Context<CastVote>, yes: bool) -> Result<()> {
    let a = ctx.accounts;
    let voter = a.voter.key();
    let member = {
        let info = &a.member;
        require!(
            *info.owner == crate::ID && !info.data_is_empty(),
            ErrorCode::NotMember
        );
        Member::try_deserialize(&mut &info.try_borrow_data()?[..])
            .map_err(|_| ErrorCode::NotMember)?
    };
    // Shares live on Token-2022 (see create_fund / deposit).
    require_keys_eq!(
        *a.voter_shares.owner,
        anchor_spl::token_2022::ID,
        ErrorCode::NotMember
    );
    let shares = TokenAccount::try_deserialize(&mut &a.voter_shares.try_borrow_data()?[..])?;
    require!(
        shares.mint == a.fund.share_mint && shares.owner == voter,
        ErrorCode::NotMember
    );

    let now = Clock::get()?.unix_timestamp;
    let p = &mut a.proposal;
    require!(p.status == ProposalStatus::Open, ErrorCode::ProposalNotOpen);
    require!(now <= p.deadline, ErrorCode::ProposalExpired);
    require!(
        member.last_deposit_ts < p.created_at,
        ErrorCode::VoteAfterDeposit
    );

    let weight = shares.amount;
    let tally = if yes {
        &mut p.yes_weight
    } else {
        &mut p.no_weight
    };
    *tally = tally.checked_add(weight).ok_or(ErrorCode::MathOverflow)?;
    let proposal = p.key();
    a.vote_record.set_inner(VoteRecord {
        proposal,
        voter,
        yes,
        weight,
        bump: ctx.bumps.vote_record,
    });
    emit!(Voted {
        proposal,
        voter,
        yes,
        weight,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct ExecuteProposal<'info> {
    /// Anyone. Pays for a new output vault.
    #[account(mut)]
    pub caller: Signer<'info>,
    pub trade: Trade<'info>,
    #[account(
        mut,
        seeds = [PROPOSAL_SEED, trade.fund.key().as_ref(), &proposal.id.to_le_bytes()],
        bump = proposal.bump,
        constraint = proposal.venue == trade.venue_program.key()
            && proposal.input_mint == trade.input_mint.key()
            && proposal.output_mint == trade.output_mint.key() @ ErrorCode::Unauthorized
    )]
    pub proposal: Box<Account<'info, Proposal>>,
}

pub fn execute_proposal<'info>(
    ctx: Context<'info, ExecuteProposal<'info>>,
    venue_data: Vec<u8>,
) -> Result<()> {
    let ExecuteProposal {
        caller,
        trade,
        proposal,
    } = ctx.accounts;
    let now = Clock::get()?.unix_timestamp;
    require!(
        proposal.status == ProposalStatus::Open,
        ErrorCode::ProposalNotOpen
    );
    require!(now <= proposal.deadline, ErrorCode::ProposalExpired);
    require!(
        (proposal.yes_weight as u128) * 2 > proposal.total_shares_snapshot as u128,
        ErrorCode::ProposalNotPassed
    );
    require!(
        solana_sha256_hasher::hash(&venue_data).to_bytes() == proposal.venue_data_hash,
        ErrorCode::VenueDataMismatch
    );
    proposal.status = ProposalStatus::Executed;

    let params = SwapParams {
        signer: caller.key(),
        amount_in: proposal.amount_in,
        min_out: proposal.min_out,
        venue_data: &venue_data,
        check_size: false,
        via_proposal: Some(proposal.id),
    };
    execute_swap(
        trade,
        &caller.to_account_info(),
        ctx.remaining_accounts,
        &params,
        None,
    )?;
    Ok(())
}

#[derive(Accounts)]
pub struct CancelProposal<'info> {
    pub captain: Signer<'info>,
    #[account(
        seeds = [FUND_SEED, fund.captain.as_ref(), &fund.fund_id.to_le_bytes()],
        bump = fund.bump,
        has_one = captain @ ErrorCode::Unauthorized
    )]
    pub fund: Box<Account<'info, Fund>>,
    #[account(
        mut,
        seeds = [PROPOSAL_SEED, fund.key().as_ref(), &proposal.id.to_le_bytes()],
        bump = proposal.bump
    )]
    pub proposal: Box<Account<'info, Proposal>>,
}

pub fn cancel_proposal(ctx: Context<CancelProposal>) -> Result<()> {
    let p = &mut ctx.accounts.proposal;
    require!(p.status == ProposalStatus::Open, ErrorCode::ProposalNotOpen);
    p.status = ProposalStatus::Cancelled;
    Ok(())
}
