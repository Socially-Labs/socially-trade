mod common;

use {
    common::*,
    v1_core::state::{Delegate, Fund},
};

fn delegate(env: &Env, f: &FundHandles, key: &Pubkey) -> Delegate {
    read_account(&env.svm, &delegate_pda(&f.fund, key))
}

#[test]
fn add_delegate_captain_only() {
    let (mut env, cap, m, f) = fund_with_member();
    let key = Keypair::new().pubkey();
    // A member (not the captain) cannot add.
    let ix = ix_add_delegate(&m.pubkey(), &f, &key, 100, 1000);
    expect_err(send(&mut env.svm, &[ix], &[&m]), ErrorCode::Unauthorized);
    assert!(env.svm.get_account(&delegate_pda(&f.fund, &key)).is_none());

    let ix = ix_add_delegate(&cap.pubkey(), &f, &key, 100, 1000);
    send(&mut env.svm, &[ix], &[&cap]).unwrap();
    let d = delegate(&env, &f, &key);
    assert_eq!((d.fund, d.key), (f.fund, key));
    assert_eq!((d.max_trade_usd, d.daily_volume_usd), (100, 1000));
    assert_eq!((d.day_start, d.day_volume), (0, 0));

    // Same key twice fails.
    let ix = ix_add_delegate(&cap.pubkey(), &f, &key, 1, 1);
    expect_log(send(&mut env.svm, &[ix], &[&cap]), "already in use");
}

#[test]
fn update_delegate_captain_only() {
    let (mut env, cap, m, f) = fund_with_member();
    let key = Keypair::new().pubkey();
    send(
        &mut env.svm,
        &[ix_add_delegate(&cap.pubkey(), &f, &key, 100, 1000)],
        &[&cap],
    )
    .unwrap();
    let ix = ix_update_delegate(&m.pubkey(), &f, &key, 5, 5);
    expect_err(send(&mut env.svm, &[ix], &[&m]), ErrorCode::Unauthorized);
    let ix = ix_update_delegate(&cap.pubkey(), &f, &key, 7, 70);
    send(&mut env.svm, &[ix], &[&cap]).unwrap();
    let d = delegate(&env, &f, &key);
    assert_eq!((d.max_trade_usd, d.daily_volume_usd), (7, 70));
}

#[test]
fn revoke_closes_account() {
    let (mut env, cap, m, f) = fund_with_member();
    let key = Keypair::new().pubkey();
    let addr = delegate_pda(&f.fund, &key);
    send(
        &mut env.svm,
        &[ix_add_delegate(&cap.pubkey(), &f, &key, 100, 1000)],
        &[&cap],
    )
    .unwrap();
    let rent = env.svm.get_account(&addr).unwrap().lamports;

    let ix = ix_revoke_delegate(&m.pubkey(), &f, &key);
    expect_err(send(&mut env.svm, &[ix], &[&m]), ErrorCode::Unauthorized);
    assert!(env.svm.get_account(&addr).is_some());

    let before = env.svm.get_balance(&cap.pubkey()).unwrap();
    let ix = ix_revoke_delegate(&cap.pubkey(), &f, &key);
    let res = send(&mut env.svm, &[ix], &[&cap]).unwrap();
    assert!(env.svm.get_account(&addr).is_none_or(|a| a.lamports == 0));
    // Rent comes back to the captain (minus the 5000 lamport fee).
    let after = env.svm.get_balance(&cap.pubkey()).unwrap();
    assert_eq!(after, before + rent - 5000, "{:?}", res.logs);
}

#[test]
fn mock_venue_honest_swap_with_keypair_authority() {
    let mut env = setup();
    let user = funded_user(&mut env, 1_000_000_000);
    let sol = create_mint(&mut env, 9);
    let usdc = env.usdc;
    let pool = setup_venue_pool(&mut env, &usdc, &sol, 0, 50_000_000_000);
    let user_sol = ata(&user.pubkey(), &sol, &spl_token_interface::ID);
    let create = ix_create_ata(
        &user.pubkey(),
        &user.pubkey(),
        &sol,
        &spl_token_interface::ID,
    );
    // 100 USDC (1e8 base units) at 5 out per 1 in = 0.5 SOL (5e8 base units).
    let swap = ix_venue_swap(
        &env.svm,
        &user.pubkey(),
        &usdc_ata(&env, &user.pubkey()),
        &user_sol,
        &pool,
        &env.usdc,
        &sol,
        100_000_000,
        5,
        1,
        0,
    );
    send(&mut env.svm, &[create, swap], &[&user]).unwrap();
    assert_eq!(usdc_of_user(&env, &user), 900_000_000);
    assert_eq!(token_balance(&env.svm, &pool.pool_in), 100_000_000);
    assert_eq!(token_balance(&env.svm, &user_sol), 500_000_000);
    assert_eq!(token_balance(&env.svm, &pool.pool_out), 49_500_000_000);
}

fn usdc_of_user(env: &Env, user: &Keypair) -> u64 {
    token_balance(&env.svm, &usdc_ata(env, &user.pubkey()))
}

// ---------------------------------------------------------------------------
// swap (Task 9)
// ---------------------------------------------------------------------------

const SOL: u64 = 1_000_000_000;
const USDC: u64 = 1_000_000;

/// USDC -> SOL at $150 in base units: 1 USDC unit = 20/3 SOL units.
fn buy_sol(t: &Trading, usdc: u64, min_out: u64) -> SwapArgs {
    SwapArgs::new(t.env.usdc, t.sol, usdc, min_out, 20, 3)
}
/// SOL -> USDC at $150: 1 SOL unit = 3/20 USDC units. min_out at the edge of
/// the sell-to-USDC band (3 x 1% = 3% under the oracle amount).
fn sell_sol(t: &Trading, sol: u64) -> SwapArgs {
    let oracle = sol * 3 / 20;
    SwapArgs::new(t.sol, t.env.usdc, sol, oracle * 97 / 100, 3, 20)
}
/// USDC -> BONK at $0.00002: 1 USDC unit = 5000 BONK units.
fn buy_bonk(t: &Trading, usdc: u64) -> SwapArgs {
    SwapArgs::new(t.env.usdc, t.bonk, usdc, usdc * 5000 * 99 / 100, 5000, 1)
}

fn sol_vault(t: &Trading) -> Pubkey {
    ata(&t.f.fund, &t.sol, &spl_token_interface::ID)
}

fn fund(t: &Trading) -> Fund {
    read_fund(&t.env, &t.f)
}

#[test]
fn captain_swaps_within_10pct() {
    let mut t = trading_fund();
    let res = t
        .swap_fresh(&buy_sol(&t, 900 * USDC, 5_940_000_000))
        .unwrap();
    assert_eq!(token_balance(&t.env.svm, &sol_vault(&t)), 6 * SOL);
    assert_eq!(token_balance(&t.env.svm, &t.f.usdc_vault), 9_100 * USDC);
    let fd = fund(&t);
    assert_eq!(fd.holdings_len, 2);
    assert_eq!(fd.holdings[1], t.sol);
    // Honest venue at the oracle price: NAV unchanged, pps stays $1.
    assert_eq!(fd.last_price_per_share, 1_000_000);
    assert!(!fd.frozen);
    assert!(events(&res) >= 1, "TradeExecuted");

    // A second buy of a held token does not add a holding.
    t.swap_fresh(&buy_sol(&t, 150 * USDC, 990_000_000)).unwrap();
    assert_eq!(fund(&t).holdings_len, 2);
    assert_eq!(token_balance(&t.env.svm, &sol_vault(&t)), 7 * SOL);
}

#[test]
fn swap_at_exact_10pct_ok_and_over_rejected() {
    let mut t = trading_fund();
    // 10% of 10,000 = 1,000 USDC is the limit (inclusive). Size is checked before price.
    expect_err(
        t.swap(&buy_sol(&t, 1_000 * USDC + 1, 0)),
        ErrorCode::TradeTooLarge,
    );
    t.swap(&buy_sol(&t, 1_000 * USDC, 6_600_000_000)).unwrap();
}

#[test]
fn swap_rejects_over_10pct() {
    let mut t = trading_fund();
    expect_err(
        t.swap(&buy_sol(&t, 1_100 * USDC, 7_260_000_000)),
        ErrorCode::TradeTooLarge,
    );
    assert_eq!(fund(&t).holdings_len, 1);
}

#[test]
fn swap_rejects_unlisted_venue() {
    let mut t = trading_fund();
    let mut a = buy_sol(&t, 100 * USDC, 0);
    // An empty venue slot is Pubkey::default() (the system program id).
    for venue in [
        Keypair::new().pubkey(),
        Pubkey::default(),
        v1_core::ID,
        spl_token_interface::ID,
        anchor_spl::associated_token::ID,
    ] {
        a.venue = venue;
        expect_err(t.swap(&a), ErrorCode::VenueNotAllowed);
    }
}

#[test]
fn swap_rejects_token_program_even_if_allowlisted() {
    // A compromised admin lists the token program: the fund PDA must still
    // never sign a raw token instruction.
    let mut t = trading_fund();
    register_venue(&mut t.env, spl_token_interface::ID);
    register_venue(&mut t.env, v1_core::ID);
    register_venue(&mut t.env, anchor_spl::associated_token::ID);
    register_venue(&mut t.env, Pubkey::default());
    t.refresh_prices();
    let mut a = buy_sol(&t, 100 * USDC, 0);
    for venue in [
        spl_token_interface::ID,
        v1_core::ID,
        anchor_spl::associated_token::ID,
        Pubkey::default(),
    ] {
        a.venue = venue;
        expect_err(t.swap(&a), ErrorCode::VenueNotAllowed);
    }
}

#[test]
fn swap_rejects_inactive_venue() {
    let mut t = trading_fund();
    let a = buy_sol(&t, 150 * USDC, 990_000_000);
    // A removal is queued: the venue stays usable until it is applied.
    send(
        &mut t.env.svm,
        &[ix_queue_venue(&t.env.admin.pubkey(), mock_venue::ID, false)],
        &[&t.env.admin],
    )
    .unwrap();
    t.swap_fresh(&a).unwrap();
    warp(&mut t.env.svm, ADMIN_TIMELOCK_SECS);
    send(
        &mut t.env.svm,
        &[ix_apply_venue(mock_venue::ID)],
        &[&t.env.admin],
    )
    .unwrap();
    t.refresh_prices();
    expect_err(t.swap_fresh(&a), ErrorCode::VenueNotAllowed);
    // Approved again (also timelocked), it trades again.
    set_venue(&mut t.env, mock_venue::ID, true);
    t.refresh_prices();
    t.swap_fresh(&a).unwrap();
}

#[test]
fn swap_rejects_venue_entry_of_another_program() {
    // The entry account must be the PDA of the venue program itself.
    let mut t = trading_fund();
    let mut a = buy_sol(&t, 100 * USDC, 0);
    a.venue = Keypair::new().pubkey();
    let mut ix = ix_swap(&t.env, &t.f, &t.cap.pubkey(), None, &a);
    // An unapproved venue, with the approved mock venue's entry.
    let entry = ix
        .accounts
        .iter_mut()
        .find(|m| m.pubkey == venue_pda(&a.venue))
        .unwrap();
    entry.pubkey = venue_pda(&mock_venue::ID);
    expect_err(
        send(&mut t.env.svm, &[ix], &[&t.cap]),
        ErrorCode::VenueNotAllowed,
    );
}

#[test]
fn swap_reverts_when_venue_shortpays() {
    let mut t = trading_fund();
    expect_err(
        t.swap(&buy_sol(&t, 900 * USDC, 5_940_000_000).mode(1)),
        ErrorCode::OutputNotReceived,
    );
    assert_eq!(token_balance(&t.env.svm, &t.f.usdc_vault), 10_000 * USDC);
    assert!(t.env.svm.get_account(&sol_vault(&t)).is_none());
    assert_eq!(fund(&t).holdings_len, 1);
}

#[test]
fn swap_reverts_when_venue_overdraws() {
    let mut t = trading_fund();
    expect_err(
        t.swap(&buy_sol(&t, 900 * USDC, 5_940_000_000).mode(2)),
        ErrorCode::InputOverdrawn,
    );
    assert_eq!(token_balance(&t.env.svm, &t.f.usdc_vault), 10_000 * USDC);
}

#[test]
fn swap_reverts_when_output_diverted() {
    let mut t = trading_fund();
    expect_err(
        t.swap(&buy_sol(&t, 900 * USDC, 5_940_000_000).mode(3)),
        ErrorCode::OutputNotReceived,
    );
    assert_eq!(token_balance(&t.env.svm, &t.f.usdc_vault), 10_000 * USDC);
}

#[test]
fn swap_rejects_bad_min_out() {
    let mut t = trading_fund();
    // Oracle out = 6 SOL; 1% max slippage -> floor 5.94 SOL. 2% under is rejected.
    expect_err(
        t.swap(&buy_sol(&t, 900 * USDC, 5_880_000_000)),
        ErrorCode::SlippageTooHigh,
    );
    expect_err(
        t.swap(&buy_sol(&t, 900 * USDC, 5_940_000_000 - 1)),
        ErrorCode::SlippageTooHigh,
    );
    t.swap(&buy_sol(&t, 900 * USDC, 5_940_000_000)).unwrap();
}

#[test]
fn delegate_limited_by_max_trade_and_daily() {
    let mut t = trading_fund();
    let bot = funded(&mut t.env.svm);
    let ix = ix_add_delegate(&t.cap.pubkey(), &t.f, &bot.pubkey(), 500 * USDC, 700 * USDC);
    send(&mut t.env.svm, &[ix], &[&t.cap]).unwrap();
    let d_addr = delegate_pda(&t.f.fund, &bot.pubkey());
    let d = Some(d_addr);
    let go = |t: &mut Trading, usdc: u64, min_out: u64| {
        let a = buy_sol(t, usdc, min_out);
        let ix = ix_swap(&t.env, &t.f, &bot.pubkey(), d, &a);
        send(&mut t.env.svm, &[ix], &[&bot])
    };

    // A stranger with no delegate account, and a stranger with the bot's account.
    let eve = funded(&mut t.env.svm);
    let a = buy_sol(&t, 100 * USDC, 0);
    let ix = ix_swap(&t.env, &t.f, &eve.pubkey(), None, &a);
    expect_err(
        send(&mut t.env.svm, &[ix], &[&eve]),
        ErrorCode::Unauthorized,
    );
    let ix = ix_swap(&t.env, &t.f, &eve.pubkey(), d, &a);
    expect_err(
        send(&mut t.env.svm, &[ix], &[&eve]),
        ErrorCode::Unauthorized,
    );

    expect_err(go(&mut t, 501 * USDC, 0), ErrorCode::DelegateTradeLimit);
    go(&mut t, 400 * USDC, 2_640_000_000).unwrap();
    let dl: Delegate = read_account(&t.env.svm, &d_addr);
    assert_eq!(dl.day_volume, 400 * USDC);
    expect_err(go(&mut t, 301 * USDC, 0), ErrorCode::DelegateDailyLimit);
    go(&mut t, 300 * USDC, 1_980_000_000).unwrap();
    // A new day resets the window.
    warp(&mut t.env.svm, 86_400);
    t.refresh_prices();
    go(&mut t, 300 * USDC, 1_980_000_000).unwrap();
    assert_eq!(token_balance(&t.env.svm, &sol_vault(&t)), 6_666_666_666);
}

#[test]
fn delegate_of_other_fund_rejected() {
    let mut t = trading_fund();
    let other = create_fund(&mut t.env, &t.cap.insecure_clone(), 2, 1_000 * USDC).unwrap();
    let bot = funded(&mut t.env.svm);
    let ix = ix_add_delegate(
        &t.cap.pubkey(),
        &other,
        &bot.pubkey(),
        500 * USDC,
        700 * USDC,
    );
    send(&mut t.env.svm, &[ix], &[&t.cap]).unwrap();
    let a = buy_sol(&t, 100 * USDC, 0);
    let d = Some(delegate_pda(&other.fund, &bot.pubkey()));
    let ix = ix_swap(&t.env, &t.f, &bot.pubkey(), d, &a);
    expect_err(
        send(&mut t.env.svm, &[ix], &[&bot]),
        ErrorCode::Unauthorized,
    );
}

#[test]
fn t2_cap_25pct() {
    let mut t = trading_fund();
    // 900 USDC each (< 10% of NAV 10,000). 1,800 = 18% ok; 2,700 = 27% > 25%.
    t.swap_fresh(&buy_bonk(&t, 900 * USDC)).unwrap();
    t.swap_fresh(&buy_bonk(&t, 900 * USDC)).unwrap();
    expect_err(
        t.swap_fresh(&buy_bonk(&t, 900 * USDC)),
        ErrorCode::TierCapExceeded,
    );
    // Exactly 25% is allowed.
    t.swap_fresh(&buy_bonk(&t, 700 * USDC)).unwrap();
    let bonk_vault = ata(&t.f.fund, &t.bonk, &spl_token_interface::ID);
    assert_eq!(token_balance(&t.env.svm, &bonk_vault), 2_500 * USDC * 5000);
}

#[test]
fn t2_total_cap_50pct() {
    let mut t = trading_fund();
    // Two more T2 tokens, 4,500 USDC each at $1: each 23.7% of NAV 19,000; total 47.4%.
    let feeds = [[4u8; 32], [5u8; 32]];
    let mints: Vec<Pubkey> = feeds
        .iter()
        .map(|feed| {
            let m = create_mint(&mut t.env, 6);
            register_token(&mut t.env, m, *feed, Tier::T2);
            inject_holding(&mut t.env, &t.f, m, 4_500 * USDC);
            m
        })
        .collect();
    // Registration warps the clock: publish every price now.
    for (m, feed) in mints.iter().zip(&feeds) {
        set_usd_price(&mut t.env, m, feed, 100_000_000);
    }
    t.refresh_prices();
    // +900 BONK: each T2 still <= 25%, but T2 total 9,900 / 19,000 = 52% > 50%.
    expect_err(
        t.swap(&buy_bonk(&t, 900 * USDC)),
        ErrorCode::TierCapExceeded,
    );
    // +500 BONK: 9,500 / 19,000 = 50% exactly is allowed.
    t.swap(&buy_bonk(&t, 500 * USDC)).unwrap();
}

#[test]
fn paused_blocks_buys_allows_sell_to_usdc() {
    let mut t = trading_fund();
    t.swap_fresh(&buy_sol(&t, 900 * USDC, 5_940_000_000))
        .unwrap();
    let ix = ix_set_paused(&t.env.admin.pubkey(), true);
    send(&mut t.env.svm, &[ix], &[&t.env.admin]).unwrap();
    expect_err(t.swap_fresh(&buy_sol(&t, 100 * USDC, 0)), ErrorCode::Paused);
    t.swap_fresh(&sell_sol(&t, 2 * SOL)).unwrap();
    assert_eq!(token_balance(&t.env.svm, &sol_vault(&t)), 4 * SOL);
    assert_eq!(token_balance(&t.env.svm, &t.f.usdc_vault), 9_400 * USDC);
}

#[test]
fn frozen_fund_only_sells_to_usdc() {
    let mut t = trading_fund();
    t.swap_fresh(&buy_sol(&t, 900 * USDC, 5_940_000_000))
        .unwrap();
    let mut fd = fund(&t);
    fd.frozen = true;
    write_fund(&mut t.env, &t.f, &fd);
    expect_err(
        t.swap_fresh(&buy_sol(&t, 100 * USDC, 0)),
        ErrorCode::FundFrozen,
    );
    expect_err(
        t.swap_fresh(&buy_bonk(&t, 100 * USDC)),
        ErrorCode::FundFrozen,
    );
    // Selling to USDC is allowed and the breaker (EMA pps 1.0 >= 0.7 line) thaws the fund.
    t.swap_fresh(&sell_sol(&t, SOL)).unwrap();
    assert!(!fund(&t).frozen);
}

#[test]
fn swap_breaker_uses_ema_and_size_uses_spot() {
    let mut t = trading_fund();
    t.swap_fresh(&buy_sol(&t, 900 * USDC, 5_940_000_000))
        .unwrap();
    // Next interval (the recorded pps moves at most once per interval).
    warp(&mut t.env.svm, MARK_INTERVAL_SLOTS as i64);
    t.refresh_prices();
    // Spot $150 (trade size, price guard), EMA $50: EMA NAV = 9,100 + 6*50 = 9,400.
    let now_ts = now(&t.env);
    set_price_ema(
        &mut t.env.svm,
        price_account(&t.sol),
        &SOL_FEED,
        SOL_PRICE_E8,
        0,
        -8,
        now_ts,
        5_000_000_000,
        0,
    );
    t.swap_fresh(&buy_sol(&t, 150 * USDC, 990_000_000)).unwrap();
    // After: USDC 8,950, SOL 7 -> EMA NAV 8,950 + 350 = 9,300 over 10,000
    // shares: 0.93, inside one 10% step of 1.0.
    assert_eq!(fund(&t).last_price_per_share, 930_000);
}

#[test]
fn swap_rejects_same_mint_and_zero_amount() {
    let mut t = trading_fund();
    let usdc = t.env.usdc;
    expect_err(
        t.swap(&SwapArgs::new(usdc, usdc, 100 * USDC, 0, 1, 1)),
        ErrorCode::SameMint,
    );
    expect_err(t.swap(&buy_sol(&t, 0, 0)), ErrorCode::ZeroAmount);
}

#[test]
fn swap_rejects_input_not_held_and_unlisted_output() {
    let mut t = trading_fund();
    // SOL is listed but not held.
    expect_err(t.swap(&sell_sol(&t, SOL)), ErrorCode::HoldingNotFound);
    let junk = create_mint(&mut t.env, 6);
    let usdc = t.env.usdc;
    expect_err(
        t.swap(&SwapArgs::new(usdc, junk, 100 * USDC, 0, 1, 1)),
        ErrorCode::TokenNotListed,
    );
}

#[test]
fn swap_venue_data_limit_1024() {
    let mut t = trading_fund();
    let a = buy_sol(&t, 150 * USDC, 990_000_000);
    let send_with = |t: &mut Trading, len: usize| {
        let mut ix = ix_swap(&t.env, &t.f, &t.cap.pubkey(), None, &a);
        let mut venue_data = mock_venue::instruction::Swap {
            amount_in: a.amount_in,
            out_num: a.out_num,
            out_den: a.out_den,
            mode: 0,
        }
        .data();
        venue_data.resize(len, 0); // trailing bytes the venue ignores
        ix.data = anchor_lang::InstructionData::data(&v1_core::instruction::Swap {
            amount_in: a.amount_in,
            min_out: a.min_out,
            venue_data,
        });
        send(&mut t.env.svm, &[ix], &[&t.cap])
    };
    expect_err(send_with(&mut t, 1025), ErrorCode::VenueDataTooLong);
    send_with(&mut t, 1024).unwrap();
    assert_eq!(token_balance(&t.env.svm, &sol_vault(&t)), SOL);
}

#[test]
fn swap_rejects_share_mint_in_venue_accounts() {
    let mut t = trading_fund();
    let mut ix = ix_swap(
        &t.env,
        &t.f,
        &t.cap.pubkey(),
        None,
        &buy_sol(&t, USDC, 6_600_000),
    );
    ix.accounts.push(AccountMeta::new(t.f.share_mint, false));
    expect_err(
        send(&mut t.env.svm, &[ix], &[&t.cap]),
        ErrorCode::VenueNotAllowed,
    );
}

#[test]
fn swap_rejects_other_holding_moved_by_venue() {
    // The venue takes SOL (another holding) instead of USDC: the USDC vault is
    // unchanged (input not spent) and the SOL vault falls.
    let mut t = trading_fund();
    t.swap_fresh(&buy_sol(&t, 900 * USDC, 5_940_000_000))
        .unwrap();
    t.reset_budget();
    let mut ix = ix_swap(
        &t.env,
        &t.f,
        &t.cap.pubkey(),
        None,
        &buy_bonk(&t, 150 * USDC),
    );
    // Venue accounts are the last 10; user_in is index 2, pool_in 4, mint_in 6.
    let n = ix.accounts.len();
    let pool = venue_pool_authority();
    ix.accounts[n - 8] = AccountMeta::new(sol_vault(&t), false);
    ix.accounts[n - 6] = AccountMeta::new(ata(&pool, &t.sol, &spl_token_interface::ID), false);
    ix.accounts[n - 4] = AccountMeta::new_readonly(t.sol, false);
    // The venue moves 0.15 SOL (amount_in units) out of the SOL vault and pays BONK.
    expect_err(
        send(&mut t.env.svm, &[ix], &[&t.cap]),
        ErrorCode::InputOverdrawn,
    );
}

#[test]
fn swap_into_token_2022_mint() {
    let mut t = trading_fund();
    let admin = t.env.admin.pubkey();
    let t22 = write_mint(&mut t.env.svm, &admin, 6, &TOKEN_2022_ID);
    let feed = [7u8; 32];
    register_token(&mut t.env, t22, feed, Tier::T1);
    let usdc = t.env.usdc;
    setup_venue_pool(&mut t.env, &usdc, &t22, 0, 1_000_000 * USDC);
    t.refresh_prices();
    set_usd_price(&mut t.env, &t22, &feed, 200_000_000); // $2
    let a = SwapArgs::new(usdc, t22, 900 * USDC, 445_500_000, 1, 2);
    t.swap(&a).unwrap();
    let vault = ata(&t.f.fund, &t22, &TOKEN_2022_ID);
    assert_eq!(t.env.svm.get_account(&vault).unwrap().owner, TOKEN_2022_ID);
    assert_eq!(token_balance(&t.env.svm, &vault), 450 * USDC);
    assert_eq!(fund(&t).holdings[1], t22);
    // And back out to USDC.
    t.swap(&SwapArgs::new(t22, usdc, 50 * USDC, 97 * USDC, 2, 1))
        .unwrap();
    assert_eq!(token_balance(&t.env.svm, &vault), 400 * USDC);
}

#[test]
fn deposit_rejects_stale_price() {
    let mut t = trading_fund();
    t.swap(&buy_sol(&t, 900 * USDC, 5_940_000_000)).unwrap();
    let ts = now(&t.env) - 61;
    set_price(
        &mut t.env.svm,
        price_account(&t.sol),
        &SOL_FEED,
        SOL_PRICE_E8,
        0,
        -8,
        ts,
    );
    let cap = t.cap.insecure_clone();
    expect_err(
        deposit(&mut t.env, &t.f, &cap, 100 * USDC),
        ErrorCode::PriceStale,
    );
}

#[test]
fn deposit_rejects_foreign_price_account() {
    let mut t = trading_fund();
    t.swap(&buy_sol(&t, 900 * USDC, 5_940_000_000)).unwrap();
    let mut ix = ix_deposit(&t.env, &t.f, &t.cap.pubkey(), 100 * USDC);
    let sol_price = price_account(&t.sol);
    let slot = ix
        .accounts
        .iter()
        .position(|m| m.pubkey == sol_price)
        .unwrap();
    ix.accounts[slot] = AccountMeta::new_readonly(price_account(&t.bonk), false);
    expect_err(
        send(&mut t.env.svm, &[ix], &[&t.cap]),
        ErrorCode::PriceFeedMismatch,
    );
}

#[test]
fn exit_returns_pro_rata_sol_and_usdc() {
    let mut t = trading_fund();
    let m = funded_user(&mut t.env, 10_000 * USDC);
    deposit(&mut t.env, &t.f, &m, 10_000 * USDC).unwrap();
    // NAV 20,000: buy 12 SOL for 1,800 USDC (9%).
    t.swap(&buy_sol(&t, 1_800 * USDC, 11_880_000_000)).unwrap();
    let create = ix_create_ata(&m.pubkey(), &m.pubkey(), &t.sol, &spl_token_interface::ID);
    send(&mut t.env.svm, &[create], &[&m]).unwrap();
    exit(&mut t.env, &t.f, &m, 10_000 * USDC).unwrap();
    let m_sol = ata(&m.pubkey(), &t.sol, &spl_token_interface::ID);
    assert_eq!(token_balance(&t.env.svm, &m_sol), 6 * SOL);
    assert_eq!(
        token_balance(&t.env.svm, &usdc_ata(&t.env, &m.pubkey())),
        9_100 * USDC
    );
    assert_eq!(token_balance(&t.env.svm, &sol_vault(&t)), 6 * SOL);
}

#[test]
fn ktoken_buy_sell_nav_and_exit_pro_rata() {
    let mut t = trading_fund();
    let m = funded_user(&mut t.env, 10_000 * USDC);
    let k = listed_kusdc(&mut t.env);
    let (usdc, kusdc) = (t.env.usdc, k.mint);
    setup_venue_pool(&mut t.env, &usdc, &kusdc, 0, 1_000_000 * USDC);
    t.refresh_prices();
    refresh_kusdc(&mut t.env, &k);
    deposit(&mut t.env, &t.f, &m, 10_000 * USDC).unwrap(); // NAV 20,000
                                                           // "Deposit" 1,050 USDC into the reserve: 1,000 kUSDC at rate 1.05.
                                                           // The guard prices the output through the rate: oracle 1,000 kUSDC.
    let buy = |min_out| SwapArgs::new(usdc, kusdc, 1_050 * USDC, min_out, 20, 21);
    expect_err(t.swap(&buy(979 * USDC)), ErrorCode::SlippageTooHigh);
    t.swap(&buy(990 * USDC)).unwrap();
    let k_vault = ata(&t.f.fund, &kusdc, &spl_token_interface::ID);
    assert_eq!(token_balance(&t.env.svm, &k_vault), 1_000 * USDC);
    assert_eq!(fund(&t).holdings[1], kusdc);
    let ix = ix_poke_nav(&t.env, &t.f);
    send(&mut t.env.svm, &[ix], &[&m]).unwrap();
    assert_eq!(fund(&t).last_price_per_share, 1_000_000);
    // Sell 100 kUSDC for 105 USDC: the input is valued through the rate.
    t.swap(&SwapArgs::new(kusdc, usdc, 100 * USDC, 102 * USDC, 21, 20))
        .unwrap();
    assert_eq!(token_balance(&t.env.svm, &k_vault), 900 * USDC);
    assert_eq!(fund(&t).last_price_per_share, 1_000_000);
    // Exit half the shares: half of each vault.
    let create = ix_create_ata(&m.pubkey(), &m.pubkey(), &kusdc, &spl_token_interface::ID);
    send(&mut t.env.svm, &[create], &[&m]).unwrap();
    exit(&mut t.env, &t.f, &m, 10_000 * USDC).unwrap();
    let m_k = ata(&m.pubkey(), &kusdc, &spl_token_interface::ID);
    assert_eq!(token_balance(&t.env.svm, &m_k), 450 * USDC);
    assert_eq!(token_balance(&t.env.svm, &k_vault), 450 * USDC);
    assert_eq!(
        token_balance(&t.env.svm, &usdc_ata(&t.env, &m.pubkey())),
        9_527_500_000
    );
}

// ---------------------------------------------------------------------------
// Compute budget
// ---------------------------------------------------------------------------

/// Add `n` listed $1 T1 holdings (6 dp, 1 USDC each) by direct injection.
fn inject_listed(t: &mut Trading, n: u8) -> Vec<(Pubkey, [u8; 32])> {
    let mut out = vec![];
    for i in 0..n {
        let m = create_mint(&mut t.env, 6);
        let feed = [20 + i; 32];
        register_token(&mut t.env, m, feed, Tier::T1);
        inject_holding(&mut t.env, &t.f, m, USDC);
        out.push((m, feed));
    }
    for (m, feed) in &out {
        set_usd_price(&mut t.env, m, feed, 100_000_000);
    }
    t.refresh_prices();
    out
}

#[allow(clippy::result_large_err)]
fn measured(t: &mut Trading, a: SwapArgs) -> u64 {
    let ix = ix_swap(&t.env, &t.f, &t.cap.pubkey(), None, &a);
    let res = send(
        &mut t.env.svm,
        &[ix_compute_limit(1_400_000), ix],
        &[&t.cap],
    )
    .unwrap_or_else(|e| panic!("{:?}\n{:#?}", e.err, e.meta.logs));
    res.compute_units_consumed
}

#[test]
fn compute_units_2_and_8_holdings() {
    let mut t = trading_fund();
    let new_out_2 = {
        let a = buy_sol(&t, 300 * USDC, 1_980_000_000);
        measured(&mut t, a)
    };
    let held_2 = {
        let a = buy_sol(&t, 300 * USDC, 1_980_000_000);
        measured(&mut t, a)
    };
    // 6 more holdings: USDC, SOL + 5 injected = 7; then BONK is new -> 8.
    inject_listed(&mut t, 5);
    assert_eq!(fund(&t).holdings_len, 7);
    let new_out_8 = {
        let a = buy_bonk(&t, 100 * USDC);
        measured(&mut t, a)
    };
    assert_eq!(fund(&t).holdings_len, 8);
    let held_8 = {
        let a = buy_sol(&t, 300 * USDC, 1_980_000_000);
        measured(&mut t, a)
    };
    println!(
        "CU swap: 2 holdings new-output {new_out_2}, 2 holdings held-output {held_2}, \
         7->8 holdings new-output {new_out_8}, 8 holdings held-output {held_8}"
    );
    assert!(held_8 < 1_400_000 && new_out_8 < 1_400_000);
    // A ninth token cannot be added.
    let m = create_mint(&mut t.env, 6);
    register_token(&mut t.env, m, [30; 32], Tier::T1);
    t.refresh_prices();
    let fd = fund(&t);
    for (i, h) in fd.holdings[2..7].iter().enumerate() {
        set_usd_price(&mut t.env, h, &[20 + i as u8; 32], 100_000_000);
    }
    set_usd_price(&mut t.env, &m, &[30; 32], 100_000_000);
    let usdc = t.env.usdc;
    expect_err(
        t.swap(&SwapArgs::new(usdc, m, USDC, 0, 1, 1)),
        ErrorCode::TooManyHoldings,
    );
}

// ---------------------------------------------------------------------------
// Fix round 1
// ---------------------------------------------------------------------------

/// Sell 1 SOL ($150) into USDC with `min_out`.
#[allow(clippy::result_large_err)] // LiteSVM's own error type.
fn sell_one_sol(
    t: &mut Trading,
    min_out: u64,
) -> Result<TransactionMetadata, FailedTransactionMetadata> {
    let mut a = sell_sol(t, SOL);
    a.min_out = min_out;
    t.swap_fresh(&a)
}

#[test]
fn sell_to_usdc_is_price_guarded_with_3x_band() {
    // Band: 3 x 100 bps = 300 bps under the 150 USDC oracle amount -> 145.5 USDC.
    for state in ["normal", "paused", "frozen"] {
        let mut t = trading_fund();
        t.swap_fresh(&buy_sol(&t, 900 * USDC, 5_940_000_000))
            .unwrap();
        match state {
            "paused" => {
                let ix = ix_set_paused(&t.env.admin.pubkey(), true);
                send(&mut t.env.svm, &[ix], &[&t.env.admin]).unwrap();
            }
            "frozen" => {
                let mut fd = fund(&t);
                fd.frozen = true;
                write_fund(&mut t.env, &t.f, &fd);
            }
            _ => {}
        }
        // A sale at min_out 1 through a venue that pays 1 unit is the drain.
        expect_err(sell_one_sol(&mut t, 1), ErrorCode::SlippageTooHigh);
        expect_err(
            sell_one_sol(&mut t, 145_500_000 - 1),
            ErrorCode::SlippageTooHigh,
        );
        sell_one_sol(&mut t, 145_500_000).unwrap_or_else(|e| panic!("{state}: {:?}", e.err));
        assert_eq!(
            token_balance(&t.env.svm, &sol_vault(&t)),
            5 * SOL,
            "{state}"
        );
    }
}

#[test]
fn sell_to_usdc_band_is_capped_at_15pct() {
    let mut t = trading_fund();
    t.swap_fresh(&buy_sol(&t, 900 * USDC, 5_940_000_000))
        .unwrap();
    // Max slippage 600 bps (above the 500 floor, so only reachable by a direct
    // write): 3x = 1800, capped at 1500 bps -> 127.5 USDC. With a valid policy
    // (<= 500) the cap is never below 3x; this shows the min() binds.
    let mut pol: v1_core::state::Policy = read_account(&t.env.svm, &t.f.policy);
    pol.params.max_slippage_bps = 600;
    let mut acc = t.env.svm.get_account(&t.f.policy).unwrap();
    let mut data = Vec::new();
    anchor_lang::AccountSerialize::try_serialize(&pol, &mut data).unwrap();
    acc.data[..data.len()].copy_from_slice(&data);
    t.env.svm.set_account(t.f.policy, acc).unwrap();
    expect_err(
        sell_one_sol(&mut t, 127_500_000 - 1),
        ErrorCode::SlippageTooHigh,
    );
    sell_one_sol(&mut t, 127_500_000).unwrap();
}

#[test]
fn tier_cap_only_blocks_t2_buys() {
    let mut t = trading_fund();
    // A second T1 token ($1, 6 dp) with a pool.
    let t1b = create_mint(&mut t.env, 6);
    register_token(&mut t.env, t1b, [9; 32], Tier::T1);
    let sol = t.sol;
    setup_venue_pool(&mut t.env, &sol, &t1b, 0, 1_000_000 * USDC);
    t.refresh_prices();
    set_usd_price(&mut t.env, &t1b, &[9; 32], 100_000_000);
    t.swap_fresh(&buy_sol(&t, 900 * USDC, 5_940_000_000))
        .unwrap();
    t.swap_fresh(&buy_bonk(&t, 900 * USDC)).unwrap();
    t.swap_fresh(&buy_bonk(&t, 900 * USDC)).unwrap();
    // BONK doubles: 3,600 of NAV 11,800 = 30.5% > 25%.
    let bonk = t.bonk;
    set_usd_price(&mut t.env, &bonk, &BONK_FEED, 2 * BONK_PRICE_E8);

    // T2 -> T1: sell 100,000 BONK ($4) into SOL. 1 BONK unit = 1/375 SOL unit.
    t.swap_fresh(&SwapArgs::new(
        bonk,
        sol,
        10_000_000_000,
        26_400_000,
        1,
        375,
    ))
    .unwrap();
    // T1 -> T1: 1 SOL into the second T1 token ($150 -> 150 tokens).
    t.swap_fresh(&SwapArgs::new(sol, t1b, SOL, 148_500_000, 3, 20))
        .unwrap();
    // USDC -> T1 is fine too.
    t.swap_fresh(&buy_sol(&t, 150 * USDC, 990_000_000)).unwrap();
    // Buying more T2 is still blocked.
    expect_err(
        t.swap_fresh(&buy_bonk(&t, 10 * USDC)),
        ErrorCode::TierCapExceeded,
    );
}

#[test]
fn emptied_input_leaves_holdings() {
    let mut t = trading_fund();
    t.swap_fresh(&buy_sol(&t, 900 * USDC, 5_940_000_000))
        .unwrap();
    assert_eq!(fund(&t).holdings_len, 2);
    t.swap_fresh(&sell_sol(&t, 6 * SOL)).unwrap();
    let fd = fund(&t);
    assert_eq!(fd.holdings_len, 1);
    assert_eq!(fd.holdings[1], Pubkey::default());
    // A partial sale keeps the holding.
    t.swap_fresh(&buy_sol(&t, 900 * USDC, 5_940_000_000))
        .unwrap();
    t.swap_fresh(&sell_sol(&t, SOL)).unwrap();
    assert_eq!(fund(&t).holdings_len, 2);
}

#[test]
fn emptied_middle_holding_is_swap_removed() {
    let mut t = trading_fund();
    t.swap_fresh(&buy_sol(&t, 900 * USDC, 5_940_000_000))
        .unwrap();
    t.swap_fresh(&buy_bonk(&t, 100 * USDC)).unwrap();
    let fd = fund(&t);
    assert_eq!(fd.holdings[..3], [t.env.usdc, t.sol, t.bonk]);
    // Empty SOL (index 1): BONK moves into its slot.
    t.swap_fresh(&sell_sol(&t, 6 * SOL)).unwrap();
    let fd = fund(&t);
    assert_eq!(fd.holdings_len, 2);
    assert_eq!(fd.holdings[..3], [t.env.usdc, t.bonk, Pubkey::default()]);
    // The NAV layout follows the new order: a deposit still prices.
    let cap = t.cap.insecure_clone();
    deposit(&mut t.env, &t.f, &cap, 100 * USDC).unwrap();
}

#[test]
fn emptied_last_holding_is_removed() {
    let mut t = trading_fund();
    t.swap_fresh(&buy_sol(&t, 900 * USDC, 5_940_000_000))
        .unwrap();
    t.swap_fresh(&buy_bonk(&t, 100 * USDC)).unwrap();
    // Sell all 500,000,000,000 BONK units (100 USDC); 1 BONK unit = 1/5000 USDC unit.
    let usdc = t.env.usdc;
    let a = SwapArgs::new(t.bonk, usdc, 500_000_000_000, 97 * USDC, 1, 5000);
    t.swap_fresh(&a).unwrap();
    let fd = fund(&t);
    assert_eq!(fd.holdings_len, 2);
    assert_eq!(fd.holdings[..3], [usdc, t.sol, Pubkey::default()]);
}

#[test]
fn venue_that_moves_a_third_holding_reverts() {
    // Mode 4: an honest USDC -> SOL swap, plus 1 BONK unit out of the BONK vault.
    let mut t = trading_fund();
    t.swap_fresh(&buy_sol(&t, 900 * USDC, 5_940_000_000))
        .unwrap();
    t.swap_fresh(&buy_bonk(&t, 100 * USDC)).unwrap();
    let bonk_vault = ata(&t.f.fund, &t.bonk, &spl_token_interface::ID);
    let before = token_balance(&t.env.svm, &bonk_vault);
    t.reset_budget();
    let a = buy_sol(&t, 150 * USDC, 990_000_000).mode(4);
    let mut ix = ix_swap(&t.env, &t.f, &t.cap.pubkey(), None, &a);
    let pool = venue_pool_authority();
    ix.accounts.extend([
        AccountMeta::new(bonk_vault, false),
        AccountMeta::new(ata(&pool, &t.bonk, &spl_token_interface::ID), false),
        AccountMeta::new_readonly(t.bonk, false),
        AccountMeta::new_readonly(spl_token_interface::ID, false),
    ]);
    expect_err(
        send(&mut t.env.svm, &[ix], &[&t.cap]),
        ErrorCode::InputOverdrawn,
    );
    assert_eq!(token_balance(&t.env.svm, &bonk_vault), before);
}

#[test]
fn venue_that_approves_a_delegate_reverts() {
    // Mode 5: an honest swap, plus Approve(pool authority, 1) on the input vault.
    let mut t = trading_fund();
    let a = buy_sol(&t, 150 * USDC, 990_000_000).mode(5);
    expect_err(t.swap(&a), ErrorCode::HoldingNotFound);
}

// ---------------------------------------------------------------------------
// Final review fixes
// ---------------------------------------------------------------------------

#[test]
fn split_trade_hits_24h_autonomous_budget() {
    // A 30% trade split into 3 x 10% must not skip the vote.
    let mut t = trading_fund();
    let start = now(&t.env);
    t.swap(&buy_sol(&t, 1_000 * USDC, 6_600_000_000)).unwrap();
    let fd = fund(&t);
    assert_eq!(
        (fd.window_start, fd.window_volume_usd),
        (start, 1_000 * USDC)
    );
    expect_err(
        t.swap(&buy_sol(&t, 1_000 * USDC, 6_600_000_000)),
        ErrorCode::TradeTooLarge,
    );
    expect_err(
        t.swap(&buy_sol(&t, USDC, 6_600_000)),
        ErrorCode::TradeTooLarge,
    );
    // 1 s before the window ends: still full.
    warp(&mut t.env.svm, 86_399);
    t.refresh_prices();
    expect_err(
        t.swap(&buy_sol(&t, USDC, 6_600_000)),
        ErrorCode::TradeTooLarge,
    );
    // 24 h after the window start: a new window.
    warp(&mut t.env.svm, 1);
    t.refresh_prices();
    // (NAV is now a hair under 10,000 from rounding, so 990 not 1,000.)
    t.swap(&buy_sol(&t, 990 * USDC, 6_534_000_000)).unwrap();
    let fd = fund(&t);
    assert_eq!(
        (fd.window_start, fd.window_volume_usd),
        (start + 86_400, 990 * USDC)
    );
}

#[test]
fn delegate_trades_count_against_fund_window() {
    let mut t = trading_fund();
    let bot = funded(&mut t.env.svm);
    // The delegate's own limits are wide; only the fund window binds.
    let ix = ix_add_delegate(
        &t.cap.pubkey(),
        &t.f,
        &bot.pubkey(),
        1_000 * USDC,
        5_000 * USDC,
    );
    send(&mut t.env.svm, &[ix], &[&t.cap]).unwrap();
    let d = Some(delegate_pda(&t.f.fund, &bot.pubkey()));
    let go = |t: &mut Trading, usdc: u64| {
        let a = buy_sol(t, usdc, usdc * 20 / 3 * 99 / 100);
        let ix = ix_swap(&t.env, &t.f, &bot.pubkey(), d, &a);
        send(&mut t.env.svm, &[ix], &[&bot])
    };
    t.swap(&buy_sol(&t, 600 * USDC, 3_960_000_000)).unwrap();
    go(&mut t, 400 * USDC).unwrap();
    assert_eq!(fund(&t).window_volume_usd, 1_000 * USDC);
    expect_err(go(&mut t, USDC), ErrorCode::TradeTooLarge);
    expect_err(
        t.swap(&buy_sol(&t, USDC, 6_600_000)),
        ErrorCode::TradeTooLarge,
    );
    assert_eq!(delegate(&t.env, &t.f, &bot.pubkey()).day_volume, 400 * USDC);
}

#[test]
fn venue_that_sets_close_authority_reverts() {
    // Mode 6: an honest swap, plus SetAuthority(CloseAccount) on the input vault.
    let mut t = trading_fund();
    let a = buy_sol(&t, 150 * USDC, 990_000_000).mode(6);
    expect_err(t.swap(&a), ErrorCode::HoldingNotFound);
    assert_eq!(token_balance(&t.env.svm, &t.f.usdc_vault), 10_000 * USDC);
}

#[test]
fn venue_that_reallocates_a_vault_reverts() {
    // Mode 7: an honest swap, plus a Token-2022 Reallocate of the input vault
    // (USDC is classic SPL, so the input is a Token-2022 holding).
    let mut t = trading_fund();
    let admin = t.env.admin.pubkey();
    let t22 = write_mint(&mut t.env.svm, &admin, 6, &TOKEN_2022_ID);
    let feed = [7u8; 32];
    register_token(&mut t.env, t22, feed, Tier::T1);
    let usdc = t.env.usdc;
    setup_venue_pool(&mut t.env, &usdc, &t22, 0, 1_000_000 * USDC);
    t.refresh_prices();
    set_usd_price(&mut t.env, &t22, &feed, 200_000_000); // $2
    t.swap(&SwapArgs::new(usdc, t22, 900 * USDC, 445_500_000, 1, 2))
        .unwrap();
    let vault = ata(&t.f.fund, &t22, &TOKEN_2022_ID);
    let len = t.env.svm.get_account(&vault).unwrap().data.len();

    let pool = venue_pool_authority();
    t.env.svm.airdrop(&pool, 1_000_000_000).unwrap();
    let a = SwapArgs::new(t22, usdc, 50 * USDC, 97 * USDC, 2, 1).mode(7);
    let mut ix = ix_swap(&t.env, &t.f, &t.cap.pubkey(), None, &a);
    // Venue accounts are the last 10; pool_authority (index 1) pays the rent.
    let n = ix.accounts.len();
    assert_eq!(ix.accounts[n - 9].pubkey, pool);
    ix.accounts[n - 9].is_writable = true;
    ix.accounts.push(AccountMeta::new_readonly(
        anchor_lang::system_program::ID,
        false,
    ));
    expect_err(
        send(&mut t.env.svm, &[ix], &[&t.cap]),
        ErrorCode::VaultResized,
    );
    assert_eq!(t.env.svm.get_account(&vault).unwrap().data.len(), len);
    assert_eq!(token_balance(&t.env.svm, &vault), 450 * USDC);
}

/// Exit triples are matched by mint: holdings reordered by a swap-remove after
/// the client built the exit still pay out.
#[test]
fn exit_matches_triples_by_mint_after_reorder() {
    let mut t = trading_fund();
    let m = funded_user(&mut t.env, 10_000 * USDC);
    deposit(&mut t.env, &t.f, &m, 10_000 * USDC).unwrap();
    t.swap_fresh(&buy_sol(&t, 900 * USDC, 5_940_000_000))
        .unwrap();
    t.swap_fresh(&buy_bonk(&t, 100 * USDC)).unwrap();
    assert_eq!(fund(&t).holdings[..3], [t.env.usdc, t.sol, t.bonk]);
    for mint in [t.sol, t.bonk] {
        let ix = ix_create_ata(&m.pubkey(), &m.pubkey(), &mint, &spl_token_interface::ID);
        send(&mut t.env.svm, &[ix], &[&m]).unwrap();
    }
    // Built for [USDC, SOL, BONK].
    let old = ix_exit_unpriced(&t.env, &t.f, &m.pubkey(), 10_000 * USDC);

    // Empty SOL (BONK moves into slot 1), then buy SOL again: [USDC, BONK, SOL].
    t.swap_fresh(&sell_sol(&t, 6 * SOL)).unwrap();
    t.swap_fresh(&buy_sol(&t, 900 * USDC, 5_940_000_000))
        .unwrap();
    assert_eq!(fund(&t).holdings[..3], [t.env.usdc, t.bonk, t.sol]);

    // A list naming one holding twice (and so missing another) is rejected.
    let mut dup = old.clone();
    let n = dup.accounts.len();
    let first = dup.accounts[n - 6..n - 3].to_vec();
    dup.accounts[n - 3..].clone_from_slice(&first);
    expect_err(
        send(&mut t.env.svm, &[dup], &[&m]),
        ErrorCode::DuplicateHolding,
    );

    let bonk_vault = ata(&t.f.fund, &t.bonk, &spl_token_interface::ID);
    let (usdc_v, sol_v, bonk_v) = (
        token_balance(&t.env.svm, &t.f.usdc_vault),
        token_balance(&t.env.svm, &sol_vault(&t)),
        token_balance(&t.env.svm, &bonk_vault),
    );
    send(&mut t.env.svm, &[old], &[&m]).unwrap();
    // The member held half the shares: half of every vault.
    let user = |mint: &Pubkey| {
        token_balance(
            &t.env.svm,
            &ata(&m.pubkey(), mint, &spl_token_interface::ID),
        )
    };
    assert_eq!(user(&t.sol), sol_v / 2);
    assert_eq!(user(&t.bonk), bonk_v / 2);
    assert_eq!(user(&t.env.usdc), usdc_v / 2);
}

// ---------------------------------------------------------------------------
// Price sources
// ---------------------------------------------------------------------------

#[test]
fn swap_rejects_t3_buy_in_a_fund_that_is_not_open_seas() {
    let mut t = trading_fund();
    assert!(!fund(&t).open_seas);
    let m = create_mint(&mut t.env, 6);
    register_token(&mut t.env, m, [40; 32], Tier::T3);
    t.refresh_prices();
    set_usd_price(&mut t.env, &m, &[40; 32], 100_000_000);
    let usdc = t.env.usdc;
    expect_err(
        t.swap(&SwapArgs::new(usdc, m, USDC, 0, 1, 1)),
        ErrorCode::NotOpenSeas,
    );
}

#[test]
fn switchboard_token_buy_sell_nav_and_exit_pro_rata() {
    const MEME: u64 = 1_000_000_000; // 9 dp
    let mut t = trading_fund();
    let m = funded_user(&mut t.env, 10_000 * USDC);
    let meme = listed_meme(&mut t.env, Tier::T1); // $0.05
    let usdc = t.env.usdc;
    setup_venue_pool(&mut t.env, &usdc, &meme.mint, 0, 1_000_000 * MEME);
    t.refresh_prices();
    refresh_meme(&mut t.env, &meme);
    deposit(&mut t.env, &t.f, &m, 10_000 * USDC).unwrap(); // NAV 20,000
                                                           // Buy 500 USDC -> 10,000 MEME (20,000 base units per USDC base unit).
                                                           // The guard prices the output from the feed: oracle 10,000 MEME.
    let buy = |min_out| SwapArgs::new(usdc, meme.mint, 500 * USDC, min_out, 20_000, 1);
    expect_err(t.swap(&buy(9_899 * MEME)), ErrorCode::SlippageTooHigh);
    t.swap(&buy(9_900 * MEME)).unwrap();
    let vault = ata(&t.f.fund, &meme.mint, &spl_token_interface::ID);
    assert_eq!(token_balance(&t.env.svm, &vault), 10_000 * MEME);
    assert_eq!(fund(&t).holdings[1], meme.mint);
    let ix = ix_poke_nav(&t.env, &t.f);
    send(&mut t.env.svm, &[ix], &[&m]).unwrap();
    assert_eq!(fund(&t).last_price_per_share, 1_000_000);
    // Sell 1,000 MEME for 50 USDC: the input is valued from the feed.
    t.swap(&SwapArgs::new(
        meme.mint,
        usdc,
        1_000 * MEME,
        49 * USDC,
        1,
        20_000,
    ))
    .unwrap();
    assert_eq!(token_balance(&t.env.svm, &vault), 9_000 * MEME);
    assert_eq!(fund(&t).last_price_per_share, 1_000_000);
    // Exit half the shares: half of each vault.
    let create = ix_create_ata(
        &m.pubkey(),
        &m.pubkey(),
        &meme.mint,
        &spl_token_interface::ID,
    );
    send(&mut t.env.svm, &[create], &[&m]).unwrap();
    exit(&mut t.env, &t.f, &m, 10_000 * USDC).unwrap();
    let m_meme = ata(&m.pubkey(), &meme.mint, &spl_token_interface::ID);
    assert_eq!(token_balance(&t.env.svm, &m_meme), 4_500 * MEME);
    assert_eq!(token_balance(&t.env.svm, &vault), 4_500 * MEME);
    assert_eq!(
        token_balance(&t.env.svm, &usdc_ata(&t.env, &m.pubkey())),
        9_775 * USDC
    );
}

#[test]
fn swap_new_output_takes_two_price_accounts() {
    let mut t = trading_fund();
    assert_eq!(fund(&t).holdings_len, 1);
    let a = buy_sol(&t, 300 * USDC, 1_980_000_000);
    let mut ix = ix_swap(&t.env, &t.f, &t.cap.pubkey(), None, &a);
    // ... NAV, then SOL's [price_a, price_b], then the 10 venue accounts.
    let n = ix.accounts.len();
    assert_eq!(ix.accounts[n - 12].pubkey, price_account(&t.sol));
    ix.accounts[n - 11].pubkey = Pubkey::new_unique(); // not read for Pyth
    t.reset_budget();
    send(&mut t.env.svm, &[ix], &[&t.cap]).unwrap();
    assert_eq!(fund(&t).holdings_len, 2);
}

#[test]
fn new_output_with_zero_amount_out_is_rejected() {
    let mut t = trading_fund();
    t.swap_fresh(&buy_sol(&t, 300 * USDC, 1_980_000_000))
        .unwrap();
    // 1 SOL unit is worth 0 USDC units, so min_out 0 passes the price guard;
    // the venue pays 0 BONK. BONK must not become a holding.
    let a = SwapArgs::new(t.sol, t.bonk, 1, 0, 0, 1);
    expect_err(t.swap_fresh(&a), ErrorCode::OutputNotReceived);
    assert_eq!(fund(&t).holdings_len, 2);
}
