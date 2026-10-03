mod common;

use {
    common::*,
    v1_core::events::{BreakerChanged, PolicyApplied, PolicyQueued},
};

const SOL: u64 = 1_000_000_000;
const USDC: u64 = 1_000_000;

fn params(
    autonomous_bps: u16,
    drawdown_bps: u16,
    max_slippage_bps: u16,
    vote: u32,
) -> PolicyParams {
    PolicyParams {
        autonomous_bps,
        drawdown_bps,
        max_slippage_bps,
        vote_window_secs: vote,
    }
}

fn defaults() -> PolicyParams {
    params(1000, 3000, 100, 1800)
}

#[allow(clippy::result_large_err)] // LiteSVM's own error type.
fn update(
    env: &mut Env,
    f: &FundHandles,
    cap: &Keypair,
    new: PolicyParams,
) -> Result<TransactionMetadata, FailedTransactionMetadata> {
    warp(&mut env.svm, 0); // fresh blockhash: repeats are new transactions
    let ix = ix_update_policy(&cap.pubkey(), f, new);
    send(&mut env.svm, &[ix], &[cap])
}

#[allow(clippy::result_large_err)] // LiteSVM's own error type.
fn apply(
    env: &mut Env,
    f: &FundHandles,
    payer: &Keypair,
) -> Result<TransactionMetadata, FailedTransactionMetadata> {
    warp(&mut env.svm, 0);
    send(&mut env.svm, &[ix_apply_policy(f)], &[payer])
}

#[allow(clippy::result_large_err)] // LiteSVM's own error type.
fn poke(
    env: &mut Env,
    f: &FundHandles,
    payer: &Keypair,
) -> Result<TransactionMetadata, FailedTransactionMetadata> {
    warp(&mut env.svm, 0);
    let ix = ix_poke_nav(env, f);
    send(&mut env.svm, &[ix], &[payer])
}

// ---------------------------------------------------------------------------
// Policy timelock
// ---------------------------------------------------------------------------

#[test]
fn stricter_applies_now() {
    let (mut env, cap, m, f) = fund_with_member();
    // Every field stricter: lower bps, longer vote window.
    let strict = params(500, 2000, 50, 3600);

    // Captain only.
    expect_err(update(&mut env, &f, &m, strict), ErrorCode::Unauthorized);
    assert_eq!(read_policy(&env, &f).params, defaults());

    let res = update(&mut env, &f, &cap, strict).unwrap();
    let p = read_policy(&env, &f);
    assert_eq!(p.params, strict);
    assert_eq!(p.pending_eta, 0);
    let applied: Vec<PolicyApplied> = decode_events(&res);
    assert_eq!(applied.len(), 1);
    assert_eq!(applied[0].fund, f.fund);
    assert!(decode_events::<PolicyQueued>(&res).is_empty());

    // Equal in every field also applies now.
    warp(&mut env.svm, 1);
    update(&mut env, &f, &cap, strict).unwrap();
    assert_eq!(read_policy(&env, &f).params, strict);
    assert_eq!(read_policy(&env, &f).pending_eta, 0);

    // One field stricter, the rest equal: applies now.
    let one = params(500, 2000, 50, 7200);
    update(&mut env, &f, &cap, one).unwrap();
    assert_eq!(read_policy(&env, &f).params, one);
}

#[test]
fn looser_waits_48h() {
    let (mut env, cap, m, f) = fund_with_member();
    expect_err(apply(&mut env, &f, &m), ErrorCode::NothingPending);

    // Each single looser field queues: higher bps, or a shorter vote window.
    let loose = [
        params(2000, 3000, 100, 1800),
        params(1000, 4000, 100, 1800),
        params(1000, 3000, 200, 1800),
        params(1000, 3000, 100, 600),
        // Mixed: stricter in three fields, looser in one.
        params(500, 2000, 50, 900),
    ];
    for new in loose {
        warp(&mut env.svm, 1);
        let t0 = now(&env);
        let res = update(&mut env, &f, &cap, new).unwrap();
        let p = read_policy(&env, &f);
        assert_eq!(p.params, defaults(), "{new:?} must not apply now");
        assert_eq!(p.pending, new);
        assert_eq!(p.pending_eta, t0 + POLICY_LOOSEN_DELAY_SECS);
        let queued: Vec<PolicyQueued> = decode_events(&res);
        assert_eq!(queued.len(), 1);
        assert_eq!((queued[0].fund, queued[0].eta), (f.fund, p.pending_eta));
        assert!(decode_events::<PolicyApplied>(&res).is_empty());
    }

    // A new queue overwrites the pending change and restarts the clock.
    let first = params(2000, 3000, 100, 1800);
    update(&mut env, &f, &cap, first).unwrap();
    warp(&mut env.svm, 100_000);
    let t1 = now(&env);
    let second = params(2500, 5000, 500, 60);
    update(&mut env, &f, &cap, second).unwrap();
    let p = read_policy(&env, &f);
    assert_eq!(
        (p.pending, p.pending_eta),
        (second, t1 + POLICY_LOOSEN_DELAY_SECS)
    );

    // The old eta passes: not yet.
    warp(&mut env.svm, POLICY_LOOSEN_DELAY_SECS - 100_000);
    expect_err(apply(&mut env, &f, &m), ErrorCode::TimelockNotElapsed);
    warp(&mut env.svm, 100_000 - 1);
    expect_err(apply(&mut env, &f, &m), ErrorCode::TimelockNotElapsed);

    // At the eta, anyone applies.
    warp(&mut env.svm, 1);
    let res = apply(&mut env, &f, &m).unwrap();
    let p = read_policy(&env, &f);
    assert_eq!(p.params, second);
    assert_eq!(p.pending_eta, 0);
    assert_eq!(decode_events::<PolicyApplied>(&res).len(), 1);
    expect_err(apply(&mut env, &f, &m), ErrorCode::NothingPending);
}

#[test]
fn stricter_cancels_pending_loosen() {
    let (mut env, cap, m, f) = fund_with_member();
    warp(&mut env.svm, 1);
    update(&mut env, &f, &cap, params(2000, 3000, 100, 1800)).unwrap();
    assert_ne!(read_policy(&env, &f).pending_eta, 0);
    let strict = params(500, 2000, 50, 3600);
    update(&mut env, &f, &cap, strict).unwrap();
    let p = read_policy(&env, &f);
    assert_eq!((p.params, p.pending, p.pending_eta), (strict, strict, 0));
    warp(&mut env.svm, POLICY_LOOSEN_DELAY_SECS + 1);
    expect_err(apply(&mut env, &f, &m), ErrorCode::NothingPending);
    assert_eq!(read_policy(&env, &f).params, strict);
}

#[test]
fn below_floor_rejected() {
    let (mut env, cap, _m, f) = fund_with_member();
    let over = [
        params(2501, 3000, 100, 1800),
        params(1000, 5001, 100, 1800),
        params(1000, 3000, 501, 1800),
        params(1000, 3000, 100, 59),
        // Stricter (longer window) but past the floor: rejected on the fast path too.
        params(1000, 3000, 100, 604_801),
        params(u16::MAX, u16::MAX, u16::MAX, 0),
    ];
    for new in over {
        expect_err(update(&mut env, &f, &cap, new), ErrorCode::PolicyBelowFloor);
    }
    let p = read_policy(&env, &f);
    assert_eq!((p.params, p.pending_eta), (defaults(), 0));

    // At the floor exactly: ok (queued, it is looser).
    update(&mut env, &f, &cap, params(2500, 5000, 500, 60)).unwrap();
    assert_eq!(read_policy(&env, &f).pending, params(2500, 5000, 500, 60));
    warp(&mut env.svm, 1);
    update(&mut env, &f, &cap, params(0, 0, 0, 604_800)).unwrap();
    assert_eq!(read_policy(&env, &f).params, params(0, 0, 0, 604_800));
}

#[test]
fn apply_rechecks_floor() {
    let (mut env, _cap, m, f) = fund_with_member();
    warp(&mut env.svm, 10); // eta 0 means none: start the clock past 0
    let mut p = read_policy(&env, &f);
    p.pending = params(1000, 6000, 100, 1800);
    p.pending_eta = now(&env);
    write_policy(&mut env, &f, &p);
    expect_err(apply(&mut env, &f, &m), ErrorCode::PolicyBelowFloor);
    assert_eq!(read_policy(&env, &f).params, defaults());
}

// ---------------------------------------------------------------------------
// Breaker
// ---------------------------------------------------------------------------

/// The trading fund (captain 10,000 USDC = 10,000 shares) plus 100 SOL at
/// $100: NAV 20,000, pps 2.0, poked so peak = last = 2.0.
fn half_sol_fund() -> Trading {
    let mut t = trading_fund();
    let sol = t.sol;
    sol_price(&mut t.env, &sol, 100, 0, 100);
    inject_holding(&mut t.env, &t.f, sol, 100 * SOL);
    let anyone = funded(&mut t.env.svm);
    poke(&mut t.env, &t.f, &anyone).unwrap();
    let fd = read_fund(&t.env, &t.f);
    assert_eq!(
        (fd.last_price_per_share, fd.peak_price_per_share),
        (2_000_000, 2_000_000)
    );
    assert!(!fd.frozen);
    t
}

/// SOL -> USDC at `usd` dollars: 1 SOL unit = usd / 1000 USDC units.
fn sell_sol_at(t: &Trading, sol: u64, usd: u64) -> SwapArgs {
    let oracle = sol * usd / 1000;
    SwapArgs::new(t.sol, t.env.usdc, sol, oracle * 97 / 100, usd, 1000)
}

#[test]
fn breaker_freezes_after_30pct_drop() {
    let mut t = half_sol_fund();
    let sol = t.sol;
    let anyone = funded(&mut t.env.svm);

    // Spot -70% but EMA flat: the breaker reads the EMA, no freeze.
    sol_price(&mut t.env, &sol, 30, 0, 100);
    poke(&mut t.env, &t.f, &anyone).unwrap();
    assert!(!read_fund(&t.env, &t.f).frozen);

    // EMA -70%: EMA NAV 10,000 + 3,000 = 13,000 -> pps 1.3 < 1.4 line.
    sol_price(&mut t.env, &sol, 30, 0, 30);
    let res = poke(&mut t.env, &t.f, &anyone).unwrap();
    let fd = read_fund(&t.env, &t.f);
    assert!(fd.frozen);
    assert_eq!(fd.last_price_per_share, 1_300_000);
    assert_eq!(fd.peak_price_per_share, 2_000_000);
    let ev: Vec<BreakerChanged> = decode_events(&res);
    assert_eq!(ev.len(), 1);
    assert_eq!(
        (ev[0].fund, ev[0].frozen, ev[0].price_per_share, ev[0].peak),
        (t.f.fund, true, 1_300_000, 2_000_000)
    );

    // Buys are blocked.
    let buy = SwapArgs::new(t.env.usdc, sol, 100 * USDC, 0, 100, 3);
    expect_err(t.swap(&buy), ErrorCode::FundFrozen);
    // Sells into USDC go through (10 SOL at $30 = 300 USDC).
    t.swap(&sell_sol_at(&t, 10 * SOL, 30)).unwrap();
    assert_eq!(
        token_balance(&t.env.svm, &ata(&t.f.fund, &sol, &spl_token_interface::ID)),
        90 * SOL
    );
    assert_eq!(token_balance(&t.env.svm, &t.f.usdc_vault), 10_300 * USDC);
    // Still 13,000 / 10,000: still frozen.
    assert!(read_fund(&t.env, &t.f).frozen);

    // A stale price fails the poke; the state does not move.
    warp(&mut t.env.svm, MAX_PRICE_AGE_SECS as i64 + 1);
    expect_err(poke(&mut t.env, &t.f, &anyone), ErrorCode::PriceStale);
}

#[test]
fn breaker_clears_on_recovery() {
    let mut t = half_sol_fund();
    let sol = t.sol;
    let anyone = funded(&mut t.env.svm);
    sol_price(&mut t.env, &sol, 30, 0, 30);
    poke(&mut t.env, &t.f, &anyone).unwrap();
    assert!(read_fund(&t.env, &t.f).frozen);

    // EMA $39: 13,900 -> 1.39, under the line: no change, no event.
    sol_price(&mut t.env, &sol, 30, 0, 39);
    let res = poke(&mut t.env, &t.f, &anyone).unwrap();
    assert!(read_fund(&t.env, &t.f).frozen);
    assert!(decode_events::<BreakerChanged>(&res).is_empty());

    // EMA $40 (spot still $30): 14,000 -> 1.4 = the line, not under: clears.
    sol_price(&mut t.env, &sol, 30, 0, 40);
    let res = poke(&mut t.env, &t.f, &anyone).unwrap();
    let fd = read_fund(&t.env, &t.f);
    assert!(!fd.frozen);
    assert_eq!(fd.last_price_per_share, 1_400_000);
    assert_eq!(fd.peak_price_per_share, 2_000_000, "peak only rises");
    let ev: Vec<BreakerChanged> = decode_events(&res);
    assert_eq!(ev.len(), 1);
    assert!(!ev[0].frozen);
}

#[test]
fn stricter_drawdown_freezes_on_next_poke() {
    let mut t = half_sol_fund();
    let sol = t.sol;
    let cap = t.cap.insecure_clone();
    let anyone = funded(&mut t.env.svm);
    // EMA $70: 17,000 -> 1.7, above the 30% line (1.4).
    sol_price(&mut t.env, &sol, 70, 0, 70);
    poke(&mut t.env, &t.f, &anyone).unwrap();
    assert!(!read_fund(&t.env, &t.f).frozen);
    // Drawdown 10% (stricter, applies now): line 1.8 > 1.7.
    update(&mut t.env, &t.f, &cap, params(1000, 1000, 100, 1800)).unwrap();
    warp(&mut t.env.svm, 1);
    sol_price(&mut t.env, &sol, 70, 0, 70);
    poke(&mut t.env, &t.f, &anyone).unwrap();
    assert!(read_fund(&t.env, &t.f).frozen);
}

#[test]
fn exit_works_when_paused_frozen_and_stale() {
    let mut t = trading_fund();
    let sol = t.sol;
    let anyone = funded(&mut t.env.svm);
    // Member buys 10,000 shares at $1. The fund then holds 20,000 USDC + 200 SOL at $100.
    let m = funded_user(&mut t.env, 10_000 * USDC);
    deposit(&mut t.env, &t.f, &m, 10_000 * USDC).unwrap();
    sol_price(&mut t.env, &sol, 100, 0, 100);
    inject_holding(&mut t.env, &t.f, sol, 200 * SOL);
    poke(&mut t.env, &t.f, &anyone).unwrap();
    assert_eq!(read_fund(&t.env, &t.f).last_price_per_share, 2_000_000);

    // EMA crash to $30: 20,000 + 6,000 = 26,000 / 20,000 -> pps 1.3, frozen.
    sol_price(&mut t.env, &sol, 30, 0, 30);
    poke(&mut t.env, &t.f, &anyone).unwrap();
    let fd = read_fund(&t.env, &t.f);
    assert!(fd.frozen);
    assert_eq!(fd.last_price_per_share, 1_300_000);

    // The member's SOL account, then pause and let every price go stale.
    let ix = ix_create_ata(&m.pubkey(), &m.pubkey(), &sol, &spl_token_interface::ID);
    send(&mut t.env.svm, &[ix], &[&m]).unwrap();
    let ix = ix_set_paused(&t.env.admin.pubkey(), true);
    send(&mut t.env.svm, &[ix], &[&t.env.admin]).unwrap();
    assert!(read_config(&t.env).paused);
    warp(&mut t.env.svm, MAX_PRICE_AGE_SECS as i64 + 1);
    expect_err(poke(&mut t.env, &t.f, &anyone), ErrorCode::PriceStale);

    exit(&mut t.env, &t.f, &m, 10_000 * USDC).unwrap();

    // Fee at the last pps 1.3: value 13,000, hwm 10,000 -> 300 USDC
    // = floor(300 / 1.3) = 230.769230 shares to the captain.
    let fee_shares = 230_769_230;
    assert_eq!(
        token_balance(&t.env.svm, &share_ata(&t.f, &t.cap.pubkey())),
        10_000 * USDC + fee_shares
    );
    // Paid (10,000 - fee) / 20,000 of each vault.
    let q = 10_000 * USDC - fee_shares;
    assert_eq!(token_balance(&t.env.svm, &usdc_ata(&t.env, &m.pubkey())), q);
    assert_eq!(
        token_balance(
            &t.env.svm,
            &ata(&m.pubkey(), &sol, &spl_token_interface::ID)
        ),
        97_692_307_700, // floor(200 SOL * q / 20,000 shares)
    );
    assert_eq!(token_balance(&t.env.svm, &share_ata(&t.f, &m.pubkey())), 0);
    let fd = read_fund(&t.env, &t.f);
    assert!(fd.frozen, "the stale exit does not move the breaker");
    assert_eq!(fd.last_price_per_share, 1_300_000);
    assert_eq!(fd.total_shares, 10_000 * USDC + fee_shares);
}
