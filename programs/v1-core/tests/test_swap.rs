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
/// SOL -> USDC at $150: 1 SOL unit = 3/20 USDC units.
fn sell_sol(t: &Trading, sol: u64) -> SwapArgs {
    SwapArgs::new(t.sol, t.env.usdc, sol, 0, 3, 20)
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
    let res = t.swap(&buy_sol(&t, 900 * USDC, 5_940_000_000)).unwrap();
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
    t.swap(&buy_sol(&t, 150 * USDC, 990_000_000)).unwrap();
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
    register_venue(&mut t.env, 1, spl_token_interface::ID);
    register_venue(&mut t.env, 2, v1_core::ID);
    t.refresh_prices();
    let mut a = buy_sol(&t, 100 * USDC, 0);
    for venue in [spl_token_interface::ID, v1_core::ID] {
        a.venue = venue;
        expect_err(t.swap(&a), ErrorCode::VenueNotAllowed);
    }
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
    t.swap(&buy_bonk(&t, 900 * USDC)).unwrap();
    t.swap(&buy_bonk(&t, 900 * USDC)).unwrap();
    expect_err(
        t.swap(&buy_bonk(&t, 900 * USDC)),
        ErrorCode::TierCapExceeded,
    );
    // Exactly 25% is allowed.
    t.swap(&buy_bonk(&t, 700 * USDC)).unwrap();
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
    t.swap(&buy_sol(&t, 900 * USDC, 5_940_000_000)).unwrap();
    let ix = ix_set_paused(&t.env.admin.pubkey(), true);
    send(&mut t.env.svm, &[ix], &[&t.env.admin]).unwrap();
    expect_err(t.swap(&buy_sol(&t, 100 * USDC, 0)), ErrorCode::Paused);
    t.swap(&sell_sol(&t, 2 * SOL)).unwrap();
    assert_eq!(token_balance(&t.env.svm, &sol_vault(&t)), 4 * SOL);
    assert_eq!(token_balance(&t.env.svm, &t.f.usdc_vault), 9_400 * USDC);
}

#[test]
fn frozen_fund_only_sells_to_usdc() {
    let mut t = trading_fund();
    t.swap(&buy_sol(&t, 900 * USDC, 5_940_000_000)).unwrap();
    let mut fd = fund(&t);
    fd.frozen = true;
    write_fund(&mut t.env, &t.f, &fd);
    expect_err(t.swap(&buy_sol(&t, 100 * USDC, 0)), ErrorCode::FundFrozen);
    expect_err(t.swap(&buy_bonk(&t, 100 * USDC)), ErrorCode::FundFrozen);
    // Selling to USDC is allowed and the breaker (EMA pps 1.0 >= 0.7 line) thaws the fund.
    t.swap(&sell_sol(&t, SOL)).unwrap();
    assert!(!fund(&t).frozen);
}

#[test]
fn swap_breaker_uses_ema_and_size_uses_spot() {
    let mut t = trading_fund();
    t.swap(&buy_sol(&t, 900 * USDC, 5_940_000_000)).unwrap();
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
    t.swap(&buy_sol(&t, 150 * USDC, 990_000_000)).unwrap();
    // After: USDC 8,950, SOL 7 -> EMA NAV 8,950 + 350 = 9,300 over 10,000 shares.
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
fn swap_rejects_venue_data_over_64_bytes() {
    let mut t = trading_fund();
    let mut ix = ix_swap(&t.env, &t.f, &t.cap.pubkey(), None, &buy_sol(&t, USDC, 0));
    let data = v1_core::instruction::Swap {
        amount_in: USDC,
        min_out: 0,
        venue_data: vec![0; 65],
    };
    ix.data = anchor_lang::InstructionData::data(&data);
    expect_err(
        send(&mut t.env.svm, &[ix], &[&t.cap]),
        ErrorCode::VenueDataTooLong,
    );
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
    t.swap(&buy_sol(&t, 900 * USDC, 5_940_000_000)).unwrap();
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
    t.swap(&SwapArgs::new(t22, usdc, 50 * USDC, 0, 2, 1))
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
