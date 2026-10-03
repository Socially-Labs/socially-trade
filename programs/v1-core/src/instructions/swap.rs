//! Trade fund tokens through an allowlisted venue (the autonomous zone).
//!
//! The fund PDA signs one CPI into the venue. The program does not trust the
//! venue: after the CPI it reads the vaults again. The input vault must fall by
//! exactly `amount_in`, the output vault must rise by at least `min_out`, and
//! every other holding vault must not change.
//!
//! Remaining accounts, in this order:
//! 1. The NAV layout for the current holdings (see `nav`), `4 * holdings_len`.
//! 2. Only when the output mint is not a holding yet (and is not USDC): the
//!    output mint's two price accounts `[price_a, price_b]`, the same pair as
//!    in the NAV layout for its price source.
//! 3. Only for a T3 trade (the output is a T3 token, or the input or the
//!    output holding has a T3 cost basis): `[captain_member (w), captain_shares (w), share_mint (w),
//!    Token-2022 program]`. The captain's Member PDA and share ATA.
//! 4. The venue's accounts, passed through as they are. The fund PDA is one of
//!    them (the venue's swap authority); the program marks it as a signer.
//!
//! T3 first-loss rules (Open Seas funds only). A T3 buy (a buy of a T3 token,
//! or any buy into a holding that has a basis, whatever its tier) adds its spot
//! USD cost to the cost basis. A T3 buy into a holding that has units but no
//! basis is rejected (`T3UnbasedHolding`): those units would dilute the basis.
//! The total basis, and the T3 buys of the current and the previous 30-day
//! window together, must each stay at most the captain's stake value (captain
//! shares x pre-trade spot price per share). Any 30-day span lies inside two
//! adjacent windows, so this bounds the buys of every 30-day span. A sale of a holding with a basis takes out
//! `basis * amount_in / position`. If the spot value received is less, the fund
//! PDA (permanent delegate of the share mint) burns captain shares worth the
//! loss at the pre-trade spot price per share, at most the captain's balance.
//! A T3 to T3 trade is a T3 sale, then a T3 buy.

use {
    crate::{
        constants::*,
        errors::ErrorCode,
        events::{FirstLossApplied, TradeExecuted},
        instructions::delegate::charge_delegate,
        math,
        nav::{self, NavResult, ValuationMode, ACCOUNTS_PER_HOLDING, PRICE_ACCOUNTS},
        state::{Config, Delegate, Fund, Member, Policy, Tier, TokenEntry, VenueEntry},
    },
    anchor_lang::{
        error::ErrorCode as AnchorError,
        prelude::*,
        solana_program::{
            instruction::{AccountMeta, Instruction},
            program::invoke_signed,
        },
    },
    anchor_spl::{
        associated_token::get_associated_token_address_with_program_id,
        associated_token::{self, AssociatedToken},
        token::ID as TOKEN_PROGRAM,
        token_2022::ID as TOKEN_2022_PROGRAM,
        token_interface::{self, Mint, TokenInterface},
    },
};

/// The accounts every trade uses. `swap` (and the proposal executor) wrap it.
#[derive(Accounts)]
pub struct Trade<'info> {
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
    /// CHECK: checked by `venue_allowed` against `venue_entry` and the denylist.
    pub venue_program: UncheckedAccount<'info>,
    /// CHECK: the active VenueEntry PDA `[b"venue", venue_program]`. Read by
    /// `venue_allowed`, so a missing or inactive entry gives `VenueNotAllowed`.
    pub venue_entry: UncheckedAccount<'info>,
    pub input_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mint::token_program = output_token_program)]
    pub output_mint: Box<InterfaceAccount<'info, Mint>>,
    /// CHECK: the active TokenEntry PDA `[b"token", input_mint]`. Not read for USDC.
    pub input_entry: UncheckedAccount<'info>,
    /// CHECK: the active TokenEntry PDA `[b"token", output_mint]`. Not read for USDC.
    pub output_entry: UncheckedAccount<'info>,
    /// CHECK: ATA(fund, input_mint); must be the input holding's NAV vault.
    #[account(mut)]
    pub fund_input_vault: UncheckedAccount<'info>,
    /// CHECK: ATA(fund, output_mint) on `output_token_program`; created when missing.
    #[account(mut)]
    pub fund_output_vault: UncheckedAccount<'info>,
    pub output_token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Swap<'info> {
    /// The captain or a delegate key. Pays for a new output vault.
    #[account(mut)]
    pub signer: Signer<'info>,
    /// Required unless the signer is the captain.
    #[account(mut)]
    pub delegate: Option<Box<Account<'info, Delegate>>>,
    pub trade: Trade<'info>,
}

/// The trade request. `signer` and `via_proposal` only go into the event.
pub struct SwapParams<'a> {
    pub signer: Pubkey,
    pub amount_in: u64,
    pub min_out: u64,
    pub venue_data: &'a [u8],
    /// False for a trade the crew voted for (no autonomous size limit).
    pub check_size: bool,
    pub via_proposal: Option<u64>,
    /// For a proposal: the venue data and venue accounts must hash to this
    /// (see `route_hash`), else `VenueDataMismatch`.
    pub route_hash: Option<[u8; 32]>,
}

pub fn swap<'info>(
    ctx: Context<'info, Swap<'info>>,
    amount_in: u64,
    min_out: u64,
    venue_data: Vec<u8>,
) -> Result<()> {
    let Swap {
        signer,
        delegate,
        trade,
    } = ctx.accounts;
    let signer_key = signer.key();
    let delegate = if signer_key == trade.fund.captain {
        None
    } else {
        let d = delegate.as_deref_mut().ok_or(ErrorCode::Unauthorized)?;
        require!(
            d.key == signer_key && d.fund == trade.fund.key(),
            ErrorCode::Unauthorized
        );
        Some(&mut **d)
    };
    require!(
        venue_data.len() <= MAX_VENUE_DATA,
        ErrorCode::VenueDataTooLong
    );
    let params = SwapParams {
        signer: signer_key,
        amount_in,
        min_out,
        venue_data: &venue_data,
        check_size: true,
        via_proposal: None,
        route_hash: None,
    };
    execute_swap(
        trade,
        &signer.to_account_info(),
        ctx.remaining_accounts,
        &params,
        delegate,
    )?;
    Ok(())
}

/// The T3 accounts of a trade (remaining accounts, see the module doc).
pub const T3_ACCOUNTS: usize = 4;

/// What `prepare` found: holding indexes and where the venue accounts start.
struct Plan {
    in_idx: usize,
    out_idx: usize,
    out_is_new: bool,
    venue_start: usize,
    /// The new `(window_start, window_volume_usd)`; None for a voted trade.
    window: Option<(i64, u64)>,
    /// Pre-trade spot NAV and the spot USD value of `amount_in`.
    pre_nav: u128,
    trade_usd: u128,
    /// The input has a T3 cost basis (T3 sale rules apply).
    t3_sell: bool,
    /// The output is a T3 token (T3 buy rules apply).
    t3_buy: bool,
    /// Index of the T3 accounts in the remaining accounts.
    t3_start: usize,
}

/// The shared trade core: checks, venue CPI, balance checks, tier caps,
/// breaker, event. Returns the amount the output vault received.
/// The caller has already checked who may trade (captain, delegate or a vote).
pub fn execute_swap<'info>(
    t: &mut Trade<'info>,
    payer: &AccountInfo<'info>,
    remaining: &[AccountInfo<'info>],
    p: &SwapParams,
    delegate: Option<&mut Delegate>,
) -> Result<u64> {
    let now = Clock::get()?.unix_timestamp;
    let mut priced = Box::new(NavResult {
        len: 0,
        amounts: [0; MAX_HOLDINGS],
        prices: [None; MAX_HOLDINGS],
        t2: [false; MAX_HOLDINGS],
    });
    let plan = prepare(t, remaining, p, delegate, now, &mut priced)?;
    if let Some((start, volume)) = plan.window {
        t.fund.window_start = start;
        t.fund.window_volume_usd = volume;
    }
    if let Some(want) = p.route_hash {
        require!(
            route_hash(p.venue_data, &remaining[plan.venue_start..]) == want,
            ErrorCode::VenueDataMismatch
        );
    }
    let mut before = priced.amounts;
    before[plan.out_idx] = output_vault_before(t, payer, &plan, remaining)?;
    // Account sizes too: the venue must not grow a vault (Token-2022 Reallocate).
    let mut lens = [0usize; MAX_HOLDINGS];
    for (i, l) in lens[..priced.len].iter_mut().enumerate() {
        *l = vault_at(t, remaining, i).data_len();
    }

    call_venue(t, &remaining[plan.venue_start..], p.venue_data)?;

    let amount_out = settle(t, remaining, p, &plan, &before, &lens, &mut priced, now)?;
    emit!(TradeExecuted {
        fund: t.fund.key(),
        signer: p.signer,
        venue: t.venue_program.key(),
        input_mint: t.input_mint.key(),
        output_mint: t.output_mint.key(),
        amount_in: p.amount_in,
        amount_out,
        via_proposal: p.via_proposal,
    });
    Ok(amount_out)
}

/// Checks 1-7 (in the order of the spec), before any token moves.
fn prepare(
    t: &Trade,
    remaining: &[AccountInfo],
    p: &SwapParams,
    delegate: Option<&mut Delegate>,
    now: i64,
    priced: &mut NavResult,
) -> Result<Plan> {
    let (input, output) = (t.input_mint.key(), t.output_mint.key());
    let config = &t.config;
    let fund = &t.fund;

    // 1. Mints, amount, venue.
    require_keys_neq!(input, output, ErrorCode::SameMint);
    require!(p.amount_in > 0, ErrorCode::ZeroAmount);
    venue_allowed(&t.venue_entry, &t.venue_program.key())?;

    // 2. Pause and breaker stop everything but sales into USDC.
    let sell_to_usdc = output == config.usdc_mint;
    if !sell_to_usdc {
        require!(!config.paused, ErrorCode::Paused);
        require!(!fund.frozen, ErrorCode::FundFrozen);
    }

    // 3. Listed and active; input held; room for a new output. Only an
    // Open Seas fund buys T3 tokens.
    listed(&t.input_entry, &input, config)?;
    let out_entry = listed(&t.output_entry, &output, config)?;
    let t3_tier = out_entry.as_ref().is_some_and(|e| e.tier == Tier::T3);
    require!(!t3_tier || fund.open_seas, ErrorCode::NotOpenSeas);
    let len = fund.holdings_len as usize;
    let held = &fund.holdings[..len];
    let in_idx = held
        .iter()
        .position(|m| *m == input)
        .ok_or(ErrorCode::HoldingNotFound)?;
    let out_held = held.iter().position(|m| *m == output);
    if out_held.is_none() {
        require!(len < MAX_HOLDINGS, ErrorCode::TooManyHoldings);
    }

    // 4. Prices of every holding, plus the new output's price.
    let fund_key = fund.key();
    *priced = nav::compute(fund, &fund_key, config, remaining, now, &crate::ID)?;
    let nav_end = len * ACCOUNTS_PER_HOLDING;
    require_keys_eq!(
        t.fund_input_vault.key(),
        remaining[in_idx * ACCOUNTS_PER_HOLDING].key(),
        ErrorCode::HoldingNotFound
    );
    let (out_idx, mut venue_start) = match out_held {
        Some(i) => {
            require_keys_eq!(
                t.fund_output_vault.key(),
                remaining[i * ACCOUNTS_PER_HOLDING].key(),
                ErrorCode::HoldingNotFound
            );
            (i, nav_end)
        }
        None => {
            priced.len = len + 1;
            match out_entry {
                // USDC is always holding 0, so this is only for safety.
                None => (len, nav_end),
                Some(entry) => {
                    let price = nav::price(&entry, remaining.get(nav_end..).unwrap_or(&[]), now)?;
                    priced.prices[len] = Some(price);
                    priced.t2[len] = entry.tier == Tier::T2;
                    (len, nav_end + PRICE_ACCOUNTS)
                }
            }
        }
    };
    // The sale rules follow the basis, not the tier: a token listed T3 that the
    // fund holds without a basis sells like any other token. A buy into a
    // based holding is a T3 buy whatever the tier. A T3 buy must not mix with
    // unbased units of a holding.
    let t3_sell = fund.t3_basis_usd[in_idx] > 0;
    let out_based = out_held.is_some_and(|i| fund.t3_basis_usd[i] > 0);
    if let Some(i) = out_held {
        require!(
            !t3_tier || out_based || priced.amounts[i] == 0,
            ErrorCode::T3UnbasedHolding
        );
    }
    let t3_buy = t3_tier || out_based;
    let t3_start = venue_start;
    if t3_buy || t3_sell {
        venue_start += T3_ACCOUNTS;
    }
    require!(
        remaining.len() >= venue_start,
        ErrorCode::PriceAccountMissing
    );
    let pre_nav = priced.valuation(ValuationMode::Spot)?.nav;
    let trade_usd = priced.value_at(in_idx, p.amount_in, ValuationMode::Spot)?;

    // 5. Autonomous size limit, per trade and as a rolling 24 h budget for the
    // fund (captain and delegates together), so a split trade cannot skip the
    // vote. A trade the crew voted for skips both and does not use the budget.
    let window = if p.check_size {
        let limit = math::bps_of(pre_nav, t.policy.params.autonomous_bps)?;
        require!(trade_usd <= limit, ErrorCode::TradeTooLarge);
        let (start, used) = if now.saturating_sub(fund.window_start) >= DAY_SECS {
            (now, 0)
        } else {
            (fund.window_start, fund.window_volume_usd)
        };
        let total = used
            .checked_add(math::to_u64(trade_usd)?)
            .ok_or(ErrorCode::MathOverflow)?;
        require!(total as u128 <= limit, ErrorCode::TradeTooLarge);
        Some((start, total))
    } else {
        None
    };

    // 6. Delegate speed limits.
    if let Some(d) = delegate {
        charge_delegate(d, math::to_u64(trade_usd)?, now)?;
    }

    // 7. Price guard on every trade: min_out within the slippage band of the
    // oracle amount. Sales into USDC (allowed while paused or frozen) get a
    // wider band, 3x max slippage capped at 15%, so de-risking still clears.
    let slippage_bps = if sell_to_usdc {
        t.policy
            .params
            .max_slippage_bps
            .saturating_mul(3)
            .min(MAX_SELL_TO_USDC_SLIPPAGE_BPS)
    } else {
        t.policy.params.max_slippage_bps
    };
    let oracle_out = match priced.prices[out_idx] {
        None => trade_usd,
        Some(price) => price.amount_for(trade_usd)?,
    };
    let keep = 10_000u16
        .checked_sub(slippage_bps)
        .ok_or(ErrorCode::MathOverflow)?;
    require!(
        p.min_out as u128 >= math::bps_of(oracle_out, keep)?,
        ErrorCode::SlippageTooHigh
    );

    Ok(Plan {
        in_idx,
        out_idx,
        out_is_new: out_held.is_none(),
        venue_start,
        window,
        pre_nav,
        trade_usd,
        t3_sell,
        t3_buy,
        t3_start,
    })
}

/// sha256(venue_data || for each venue account, in order:
/// pubkey (32) || is_signer (1) || is_writable (1)).
/// The flags are the runtime flags the program sees (the transaction merges
/// the flags of a key that appears more than once).
pub(crate) fn route_hash(venue_data: &[u8], venue_accounts: &[AccountInfo]) -> [u8; 32] {
    let mut buf = Vec::with_capacity(venue_data.len() + venue_accounts.len() * 34);
    buf.extend_from_slice(venue_data);
    for a in venue_accounts {
        buf.extend_from_slice(a.key.as_ref());
        buf.push(a.is_signer as u8);
        buf.push(a.is_writable as u8);
    }
    solana_sha256_hasher::hash(&buf).to_bytes()
}

/// `venue` has an active `VenueEntry` (`entry`, the PDA of `venue`), and is not
/// system, v1-core, a token program or the ATA program, even if approved.
/// Shared by `swap`, `propose_trade` and `execute_proposal`.
pub(crate) fn venue_allowed(entry: &AccountInfo, venue: &Pubkey) -> Result<()> {
    const DENIED: [Pubkey; 5] = [
        Pubkey::new_from_array([0; 32]), // system program
        crate::ID,
        TOKEN_PROGRAM,
        TOKEN_2022_PROGRAM,
        associated_token::ID,
    ];
    require!(!DENIED.contains(venue), ErrorCode::VenueNotAllowed);
    require_keys_eq!(*entry.owner, crate::ID, ErrorCode::VenueNotAllowed);
    let e = VenueEntry::try_deserialize(&mut &entry.try_borrow_data()?[..])
        .map_err(|_| ErrorCode::VenueNotAllowed)?;
    let pda = Pubkey::create_program_address(&[VENUE_SEED, venue.as_ref(), &[e.bump]], &crate::ID)
        .map_err(|_| ErrorCode::VenueNotAllowed)?;
    require!(entry.key() == pda && e.active, ErrorCode::VenueNotAllowed);
    Ok(())
}

/// The registry entry of `mint` (None for USDC, which needs none).
pub(crate) fn listed(
    info: &AccountInfo,
    mint: &Pubkey,
    config: &Config,
) -> Result<Option<TokenEntry>> {
    if *mint == config.usdc_mint {
        return Ok(None);
    }
    nav::token_entry(info, mint, &crate::ID).map(Some)
}

/// The output vault balance before the trade. A new output gets its vault now.
fn output_vault_before<'info>(
    t: &Trade<'info>,
    payer: &AccountInfo<'info>,
    plan: &Plan,
    remaining: &[AccountInfo<'info>],
) -> Result<u64> {
    if !plan.out_is_new {
        return clean_vault_amount(
            &remaining[plan.out_idx * ACCOUNTS_PER_HOLDING],
            &t.fund.key(),
        );
    }
    associated_token::create_idempotent(CpiContext::new(
        t.associated_token_program.key(),
        associated_token::Create {
            payer: payer.clone(),
            associated_token: t.fund_output_vault.to_account_info(),
            authority: t.fund.to_account_info(),
            mint: t.output_mint.to_account_info(),
            system_program: t.system_program.to_account_info(),
            token_program: t.output_token_program.to_account_info(),
        },
    ))?;
    nav::vault_amount(&t.fund_output_vault, &t.fund.key(), &t.output_mint.key())
}

/// 8. One CPI into the venue, signed by the fund PDA.
fn call_venue<'info>(
    t: &Trade<'info>,
    venue_accounts: &[AccountInfo<'info>],
    data: &[u8],
) -> Result<()> {
    let fund_key = t.fund.key();
    let share_mint = t.fund.share_mint;
    let mut metas = Vec::with_capacity(venue_accounts.len());
    for a in venue_accounts {
        // The fund PDA is the share mint authority and the permanent delegate
        // (burn authority) of the share mint: the venue must never see the mint.
        require_keys_neq!(*a.key, share_mint, ErrorCode::VenueNotAllowed);
        metas.push(AccountMeta {
            pubkey: *a.key,
            is_signer: a.is_signer || *a.key == fund_key,
            is_writable: a.is_writable,
        });
    }
    let ix = Instruction {
        program_id: t.venue_program.key(),
        accounts: metas,
        data: data.to_vec(),
    };
    let mut infos = venue_accounts.to_vec();
    infos.push(t.venue_program.to_account_info());
    let fund_id_le = t.fund.fund_id.to_le_bytes();
    let seeds: &[&[u8]] = &[
        FUND_SEED,
        t.fund.captain.as_ref(),
        &fund_id_le,
        &[t.fund.bump],
    ];
    invoke_signed(&ix, &infos, &[seeds])?;
    Ok(())
}

/// Checks 9-11 after the CPI: balances, T3 rules, tier caps, breaker, new holding.
#[allow(clippy::too_many_arguments)]
fn settle<'info>(
    t: &mut Trade<'info>,
    remaining: &[AccountInfo<'info>],
    p: &SwapParams,
    plan: &Plan,
    before: &[u64; MAX_HOLDINGS],
    lens: &[usize; MAX_HOLDINGS],
    priced: &mut NavResult,
    now: i64,
) -> Result<u64> {
    let fund_key = t.fund.key();
    let len = t.fund.holdings_len as usize;
    let mut after = [0u64; MAX_HOLDINGS];
    for (i, amount) in after[..priced.len].iter_mut().enumerate() {
        let vault = vault_at(t, remaining, i);
        require!(vault.data_len() == lens[i], ErrorCode::VaultResized);
        *amount = clean_vault_amount(vault, &fund_key)?;
    }

    // 9. Input fell by exactly amount_in; output rose by >= min_out; nothing else moved.
    for i in 0..priced.len {
        if i != plan.in_idx && i != plan.out_idx {
            require!(after[i] == before[i], ErrorCode::InputOverdrawn);
        }
    }
    let spent = before[plan.in_idx]
        .checked_sub(after[plan.in_idx])
        .ok_or(ErrorCode::InputOverdrawn)?;
    require!(spent == p.amount_in, ErrorCode::InputOverdrawn);
    let amount_out = after[plan.out_idx]
        .checked_sub(before[plan.out_idx])
        .ok_or(ErrorCode::OutputNotReceived)?;
    require!(amount_out >= p.min_out, ErrorCode::OutputNotReceived);

    // T3 sale (basis out, first loss), then T3 buy (basis in, caps).
    if plan.t3_sell || plan.t3_buy {
        let accs = &remaining[plan.t3_start..plan.t3_start + T3_ACCOUNTS];
        apply_t3(t, accs, p, plan, before, amount_out, priced, now)?;
    }

    // 10. Tier caps on the post-trade spot NAV, when the trade buys a T2 token.
    priced.amounts = after;
    if priced.t2[plan.out_idx] {
        let post = priced.valuation(ValuationMode::Spot)?;
        let one_cap = math::bps_of(post.nav, T2_TOKEN_CAP_BPS)?;
        let mut t2_total: u128 = 0;
        for i in (0..priced.len).filter(|&i| priced.t2[i]) {
            require!(post.values[i] <= one_cap, ErrorCode::TierCapExceeded);
            t2_total = t2_total
                .checked_add(post.values[i])
                .ok_or(ErrorCode::MathOverflow)?;
        }
        require!(
            t2_total <= math::bps_of(post.nav, T2_TOTAL_CAP_BPS)?,
            ErrorCode::TierCapExceeded
        );
    }

    // 11. New holding; drop an emptied non-USDC input (swap-remove, never
    // index 0); then the breaker on the post-trade EMA pps.
    let usdc = t.config.usdc_mint;
    let fund = &mut t.fund;
    if plan.out_is_new {
        fund.holdings[len] = t.output_mint.key();
        fund.holdings_len += 1;
    }
    if after[plan.in_idx] == 0 && fund.holdings[plan.in_idx] != usdc && plan.in_idx > 0 {
        let last = fund.holdings_len as usize - 1;
        fund.holdings[plan.in_idx] = fund.holdings[last];
        fund.holdings[last] = Pubkey::default();
        fund.t3_basis_usd[plan.in_idx] = fund.t3_basis_usd[last];
        fund.t3_basis_usd[last] = 0;
        fund.holdings_len -= 1;
    }
    let ema_nav = priced.valuation(ValuationMode::Ema)?.nav;
    let pps = math::price_per_share(ema_nav, fund.total_shares)?;
    nav::update_breaker(fund, &fund_key, &t.policy, pps)?;
    Ok(amount_out)
}

/// The T3 rules of the module doc, after the balance checks. `accs` are the
/// T3 accounts. Only a loss changes the captain's shares and Member record.
#[inline(never)]
#[allow(clippy::too_many_arguments)]
fn apply_t3<'info>(
    t: &mut Trade<'info>,
    accs: &[AccountInfo<'info>],
    p: &SwapParams,
    plan: &Plan,
    before: &[u64; MAX_HOLDINGS],
    amount_out: u64,
    priced: &NavResult,
    now: i64,
) -> Result<()> {
    let fund_key = t.fund.key();
    let captain = t.fund.captain;
    let share_mint = t.fund.share_mint;
    let (member_info, shares_info, mint_info, program_info) =
        (&accs[0], &accs[1], &accs[2], &accs[3]);
    require_keys_eq!(
        *member_info.owner,
        crate::ID,
        AnchorError::AccountOwnedByWrongProgram
    );
    let mut member = Member::try_deserialize(&mut &member_info.try_borrow_data()?[..])?;
    let member_pda = Pubkey::create_program_address(
        &[
            MEMBER_SEED,
            fund_key.as_ref(),
            captain.as_ref(),
            &[member.bump],
        ],
        &crate::ID,
    )
    .map_err(|_| AnchorError::ConstraintSeeds)?;
    require_keys_eq!(member_info.key(), member_pda, AnchorError::ConstraintSeeds);
    // The captain's own share ATA: any other account (empty) would dodge the burn.
    require_keys_eq!(
        shares_info.key(),
        get_associated_token_address_with_program_id(&captain, &share_mint, &TOKEN_2022_PROGRAM),
        AnchorError::ConstraintAddress
    );
    require_keys_eq!(mint_info.key(), share_mint, AnchorError::ConstraintAddress);
    require_keys_eq!(
        program_info.key(),
        TOKEN_2022_PROGRAM,
        AnchorError::InvalidProgramId
    );
    // The ATA address pins mint and owner; the owner check pins the layout.
    require_keys_eq!(
        *shares_info.owner,
        TOKEN_2022_PROGRAM,
        AnchorError::AccountOwnedByWrongProgram
    );
    let mut balance = {
        let data = shares_info.try_borrow_data()?;
        require!(data.len() >= 72, AnchorError::AccountDidNotDeserialize);
        u64::from_le_bytes(data[64..72].try_into().unwrap())
    };
    let total = t.fund.total_shares;
    let mut basis = t.fund.t3_cost_basis_usd;

    // T3 sale: the pro-rata basis leaves; a loss against it burns captain shares.
    if plan.t3_sell {
        let held = t.fund.t3_basis_usd[plan.in_idx];
        let out = math::pro_rata(held, p.amount_in, before[plan.in_idx])?;
        t.fund.t3_basis_usd[plan.in_idx] = held - out;
        basis = basis.checked_sub(out).ok_or(ErrorCode::MathOverflow)?;
        let proceeds = priced.value_at(plan.out_idx, amount_out, ValuationMode::Spot)?;
        let loss = (out as u128).saturating_sub(proceeds);
        if loss > 0 {
            // Shares worth the loss at the pre-trade spot pps, rounded up.
            require!(plan.pre_nav > 0, ErrorCode::NavZero);
            let burn = loss
                .checked_mul(total as u128)
                .ok_or(ErrorCode::MathOverflow)?
                .div_ceil(plan.pre_nav);
            let burn = math::to_u64(burn.min(balance as u128))?;
            if burn > 0 {
                burn_captain_shares(t, shares_info, mint_info, program_info, burn)?;
                // Same as a partial exit: keep the same share of the high-water mark.
                member.hwm = math::to_u64(math::mul_div_floor(
                    member.hwm as u128,
                    (balance - burn) as u128,
                    balance as u128,
                )?)?;
                member.try_serialize(&mut &mut member_info.try_borrow_mut_data()?[..])?;
                balance -= burn;
                t.fund.total_shares = total - burn;
            }
            emit!(FirstLossApplied {
                fund: fund_key,
                loss_usd: math::to_u64(loss)?,
                captain_shares_burned: burn,
            });
        }
    }

    // T3 buy: the cost joins the basis; the basis and the buys of the current
    // and previous windows must each fit the captain's stake (after any burn, at the
    // pre-trade spot pps).
    if plan.t3_buy {
        let cost = math::to_u64(plan.trade_usd)?;
        let i = plan.out_idx;
        t.fund.t3_basis_usd[i] = t.fund.t3_basis_usd[i]
            .checked_add(cost)
            .ok_or(ErrorCode::MathOverflow)?;
        basis = basis.checked_add(cost).ok_or(ErrorCode::MathOverflow)?;
        let stake = math::mul_div_floor(balance as u128, plan.pre_nav, total as u128)?;
        require!(basis as u128 <= stake, ErrorCode::T3CapExceeded);
        let fund = &mut t.fund;
        let w = t3_window(
            fund.t3_window_start,
            fund.t3_prev_window_buys_usd,
            fund.t3_window_buys_usd,
            now,
        )?;
        // Any 30-day span lies inside two adjacent windows, so both count in full.
        let recent = w.prev as u128 + w.current as u128 + cost as u128;
        require!(recent <= stake, ErrorCode::T3CapExceeded);
        fund.t3_window_start = w.start;
        fund.t3_prev_window_buys_usd = w.prev;
        fund.t3_window_buys_usd = w.current.checked_add(cost).ok_or(ErrorCode::MathOverflow)?;
    }
    t.fund.t3_cost_basis_usd = basis;
    Ok(())
}

/// The T3 buy buckets at `now`.
struct T3Window {
    /// Start of the current window.
    start: i64,
    /// Buys of the previous window and of the current window.
    prev: u64,
    current: u64,
}

/// Move the windows forward to `now`: one window passed makes the current
/// bucket the previous one; two or more empty both. Windows follow each other
/// with no gap.
fn t3_window(start: i64, prev: u64, current: u64, now: i64) -> Result<T3Window> {
    let passed = now.saturating_sub(start) / T3_WINDOW_SECS;
    let (prev, current) = match passed {
        0 => (prev, current),
        1 => (current, 0),
        _ => (0, 0),
    };
    let start = start
        .checked_add(passed * T3_WINDOW_SECS)
        .ok_or(ErrorCode::MathOverflow)?;
    Ok(T3Window {
        start,
        prev,
        current,
    })
}

/// Burn `amount` captain shares, signed by the fund PDA as the share mint's
/// permanent delegate. The captain does not sign.
fn burn_captain_shares<'info>(
    t: &Trade<'info>,
    from: &AccountInfo<'info>,
    mint: &AccountInfo<'info>,
    program: &AccountInfo<'info>,
    amount: u64,
) -> Result<()> {
    let fund_id_le = t.fund.fund_id.to_le_bytes();
    let seeds: &[&[u8]] = &[
        FUND_SEED,
        t.fund.captain.as_ref(),
        &fund_id_le,
        &[t.fund.bump],
    ];
    token_interface::burn(
        CpiContext::new_with_signer(
            program.key(),
            token_interface::Burn {
                mint: mint.clone(),
                from: from.clone(),
                authority: t.fund.to_account_info(),
            },
            &[seeds],
        ),
        amount,
    )
}

/// The vault of holding `i`: its NAV account, or the new output vault (`i == holdings_len`).
fn vault_at<'a, 'info>(
    t: &'a Trade<'info>,
    remaining: &'a [AccountInfo<'info>],
    i: usize,
) -> &'a AccountInfo<'info> {
    if i < t.fund.holdings_len as usize {
        &remaining[i * ACCOUNTS_PER_HOLDING]
    } else {
        &t.fund_output_vault
    }
}

/// A fund vault after the CPI: still owned by the fund, no delegate and no
/// close authority (the venue had the fund's signature). Returns the amount.
fn clean_vault_amount(vault: &AccountInfo, fund: &Pubkey) -> Result<u64> {
    // Base token-account layout (both programs): owner 32..64, amount 64..72,
    // delegate COption tag 72..76, close_authority COption tag 129..133.
    let data = vault.try_borrow_data()?;
    require!(
        data.len() >= 165
            && data[32..64] == fund.as_ref()[..]
            && data[72..76] == [0; 4]
            && data[129..133] == [0; 4],
        ErrorCode::HoldingNotFound
    );
    Ok(u64::from_le_bytes(data[64..72].try_into().unwrap()))
}
