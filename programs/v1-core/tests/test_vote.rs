mod common;

use {common::*, v1_core::state::ProposalStatus};

const SOL: u64 = 1_000_000_000;
const USDC: u64 = 1_000_000;
/// Captain 10,000 shares; member deposit for 40% of the total.
const MEMBER_DEPOSIT: u64 = 6_666_666_667;

/// A trading fund (captain 10,000 USDC) plus a member holding 40% of the shares.
/// The clock moves 1 s after the deposits, so both may vote on a new proposal.
fn crew() -> (Trading, Keypair) {
    let mut t = trading_fund();
    let m = funded_user(&mut t.env, 10_000 * USDC);
    deposit(&mut t.env, &t.f, &m, MEMBER_DEPOSIT).unwrap();
    warp(&mut t.env.svm, 1);
    t.refresh_prices();
    (t, m)
}

/// 3,000 USDC -> 20 SOL at $150: 18% of NAV, above the 10% autonomous limit.
fn big_buy(t: &Trading) -> SwapArgs {
    SwapArgs::new(t.env.usdc, t.sol, 3_000 * USDC, 19_800_000_000, 20, 3)
}

fn sol_vault(t: &Trading) -> Pubkey {
    ata(&t.f.fund, &t.sol, &spl_token_interface::ID)
}

#[allow(clippy::result_large_err)]
fn propose(
    t: &mut Trading,
    a: &SwapArgs,
) -> Result<TransactionMetadata, FailedTransactionMetadata> {
    let ix = ix_propose(&t.env, &t.f, &t.cap.pubkey(), None, a, venue_data(a));
    send(&mut t.env.svm, &[ix], &[&t.cap])
}

#[allow(clippy::result_large_err)]
fn vote(
    t: &mut Trading,
    voter: &Keypair,
    id: u64,
    yes: bool,
) -> Result<TransactionMetadata, FailedTransactionMetadata> {
    let ix = ix_vote(&t.f, &voter.pubkey(), id, yes);
    send(&mut t.env.svm, &[ix], &[voter])
}

#[allow(clippy::result_large_err)]
fn execute(
    t: &mut Trading,
    caller: &Keypair,
    id: u64,
    a: &SwapArgs,
) -> Result<TransactionMetadata, FailedTransactionMetadata> {
    let ix = ix_execute_proposal(&t.env, &t.f, &caller.pubkey(), id, a);
    send(&mut t.env.svm, &[ix], &[caller])
}

#[test]
fn big_trade_passes_with_majority() {
    let (mut t, m) = crew();
    let a = big_buy(&t);
    // The same trade as a direct swap is over the autonomous limit.
    expect_err(t.swap(&a), ErrorCode::TradeTooLarge);

    let created = now(&t.env);
    propose(&mut t, &a).unwrap();
    let p = read_proposal(&t.env, &t.f, 0);
    assert_eq!((p.id, p.fund, p.proposer), (0, t.f.fund, t.cap.pubkey()));
    assert_eq!(
        (p.venue, p.input_mint, p.output_mint),
        (mock_venue::ID, t.env.usdc, t.sol)
    );
    assert_eq!((p.amount_in, p.min_out), (a.amount_in, a.min_out));
    assert_eq!(
        &p.venue_data[..p.venue_data_len as usize],
        &venue_data(&a)[..]
    );
    assert!(p.venue_data[p.venue_data_len as usize..]
        .iter()
        .all(|b| *b == 0));
    assert_eq!((p.created_at, p.deadline), (created, created + 1800));
    assert_eq!(p.total_shares_snapshot, 10_000 * USDC + MEMBER_DEPOSIT);
    assert_eq!(p.status, ProposalStatus::Open);
    assert_eq!(read_fund(&t.env, &t.f).proposal_count, 1);

    // Captain (60%) votes yes, the member (40%) votes no.
    let cap = t.cap.insecure_clone();
    vote(&mut t, &cap, 0, true).unwrap();
    vote(&mut t, &m, 0, false).unwrap();
    let p = read_proposal(&t.env, &t.f, 0);
    assert_eq!((p.yes_weight, p.no_weight), (10_000 * USDC, MEMBER_DEPOSIT));
    let rec: v1_core::state::VoteRecord = read_account(
        &t.env.svm,
        &vote_pda(&proposal_pda(&t.f.fund, 0), &m.pubkey()),
    );
    assert_eq!(
        (rec.voter, rec.yes, rec.weight),
        (m.pubkey(), false, MEMBER_DEPOSIT)
    );

    // Anyone executes, at the deadline itself (inclusive).
    warp(&mut t.env.svm, 1800);
    assert_eq!(now(&t.env), read_proposal(&t.env, &t.f, 0).deadline);
    t.refresh_prices();
    let stranger = funded(&mut t.env.svm);
    let res = execute(&mut t, &stranger, 0, &a).unwrap();
    eprintln!("execute_proposal CU: {}", res.compute_units_consumed);
    assert!(res.compute_units_consumed < 200_000);
    assert_eq!(token_balance(&t.env.svm, &sol_vault(&t)), 20 * SOL);
    let ev = trade_events(&res);
    assert_eq!(ev.len(), 1);
    assert_eq!(ev[0].via_proposal, Some(0));
    assert_eq!(
        (ev[0].signer, ev[0].amount_out),
        (stranger.pubkey(), 20 * SOL)
    );
    assert_eq!(
        read_proposal(&t.env, &t.f, 0).status,
        ProposalStatus::Executed
    );
    assert_eq!(read_fund(&t.env, &t.f).holdings[1], t.sol);

    // Executed once only.
    expect_err(
        execute(&mut t, &stranger, 0, &a),
        ErrorCode::ProposalNotOpen,
    );
}

#[test]
fn big_trade_fails_without_majority() {
    let (mut t, m) = crew();
    let a = big_buy(&t);
    propose(&mut t, &a).unwrap();
    vote(&mut t, &m, 0, true).unwrap();
    let cap = t.cap.insecure_clone();
    expect_err(execute(&mut t, &cap, 0, &a), ErrorCode::ProposalNotPassed);
    // No votes at all: also not passed.
    propose(&mut t, &a).unwrap();
    expect_err(execute(&mut t, &cap, 1, &a), ErrorCode::ProposalNotPassed);
}

#[test]
fn exactly_half_is_not_a_majority() {
    let mut t = trading_fund();
    let m = funded_user(&mut t.env, 10_000 * USDC);
    deposit(&mut t.env, &t.f, &m, 10_000 * USDC).unwrap();
    warp(&mut t.env.svm, 1);
    t.refresh_prices();
    let a = SwapArgs::new(t.env.usdc, t.sol, 3_000 * USDC, 19_800_000_000, 20, 3);
    propose(&mut t, &a).unwrap();
    assert_eq!(
        read_proposal(&t.env, &t.f, 0).total_shares_snapshot,
        20_000 * USDC
    );
    vote(&mut t, &m, 0, true).unwrap();
    let cap = t.cap.insecure_clone();
    expect_err(execute(&mut t, &cap, 0, &a), ErrorCode::ProposalNotPassed);
    // One more share of yes passes: captain joins.
    vote(&mut t, &cap, 0, true).unwrap();
    execute(&mut t, &cap, 0, &a).unwrap();
}

#[test]
fn vote_rejected_after_late_deposit() {
    let (mut t, m) = crew();
    let a = big_buy(&t);
    propose(&mut t, &a).unwrap();
    // A deposit in the same second as the proposal already counts as late.
    deposit(&mut t.env, &t.f, &m, 1_000 * USDC).unwrap();
    expect_err(vote(&mut t, &m, 0, true), ErrorCode::VoteAfterDeposit);
    // A new member who joins after the proposal cannot vote either.
    warp(&mut t.env.svm, 10);
    t.refresh_prices();
    let late = funded_user(&mut t.env, 10_000 * USDC);
    deposit(&mut t.env, &t.f, &late, 9_000 * USDC).unwrap();
    expect_err(vote(&mut t, &late, 0, true), ErrorCode::VoteAfterDeposit);
    // The captain did not deposit again and still votes.
    let cap = t.cap.insecure_clone();
    vote(&mut t, &cap, 0, true).unwrap();
}

#[test]
fn double_vote_rejected() {
    let (mut t, m) = crew();
    let a = big_buy(&t);
    propose(&mut t, &a).unwrap();
    vote(&mut t, &m, 0, true).unwrap();
    expect_log(vote(&mut t, &m, 0, true), "already in use");
    expect_log(vote(&mut t, &m, 0, false), "already in use");
    let p = read_proposal(&t.env, &t.f, 0);
    assert_eq!((p.yes_weight, p.no_weight), (MEMBER_DEPOSIT, 0));
}

#[test]
fn execute_after_deadline_rejected() {
    let (mut t, m) = crew();
    let a = big_buy(&t);
    propose(&mut t, &a).unwrap();
    let cap = t.cap.insecure_clone();
    vote(&mut t, &cap, 0, true).unwrap();
    warp(&mut t.env.svm, 1801);
    t.refresh_prices();
    expect_err(vote(&mut t, &m, 0, true), ErrorCode::ProposalExpired);
    expect_err(execute(&mut t, &cap, 0, &a), ErrorCode::ProposalExpired);
    assert_eq!(
        token_balance(&t.env.svm, &t.f.usdc_vault),
        10_000 * USDC + MEMBER_DEPOSIT
    );
}

#[test]
fn non_member_cannot_vote() {
    let (mut t, _m) = crew();
    let a = big_buy(&t);
    propose(&mut t, &a).unwrap();
    let stranger = funded(&mut t.env.svm);
    expect_err(vote(&mut t, &stranger, 0, true), ErrorCode::NotMember);
    assert!(t
        .env
        .svm
        .get_account(&vote_pda(&proposal_pda(&t.f.fund, 0), &stranger.pubkey()))
        .is_none());
}

#[test]
fn cancelled_proposal_cannot_execute() {
    let (mut t, m) = crew();
    let a = big_buy(&t);
    propose(&mut t, &a).unwrap();
    let cap = t.cap.insecure_clone();
    vote(&mut t, &cap, 0, true).unwrap();
    // Only the captain cancels.
    let ix = ix_cancel_proposal(&m.pubkey(), &t.f, 0);
    expect_err(send(&mut t.env.svm, &[ix], &[&m]), ErrorCode::Unauthorized);
    let ix = ix_cancel_proposal(&cap.pubkey(), &t.f, 0);
    send(&mut t.env.svm, &[ix], &[&cap]).unwrap();
    assert_eq!(
        read_proposal(&t.env, &t.f, 0).status,
        ProposalStatus::Cancelled
    );

    expect_err(execute(&mut t, &cap, 0, &a), ErrorCode::ProposalNotOpen);
    expect_err(vote(&mut t, &m, 0, true), ErrorCode::ProposalNotOpen);
    let ix = ix_cancel_proposal(&cap.pubkey(), &t.f, 0);
    expect_err(
        send(&mut t.env.svm, &[ix], &[&cap]),
        ErrorCode::ProposalNotOpen,
    );
}

#[test]
fn executed_trade_still_checked_by_balance() {
    let (mut t, _m) = crew();
    // Mode 1: the venue takes the input and short-pays the output.
    let a = big_buy(&t).mode(1);
    propose(&mut t, &a).unwrap();
    let cap = t.cap.insecure_clone();
    vote(&mut t, &cap, 0, true).unwrap();
    expect_err(execute(&mut t, &cap, 0, &a), ErrorCode::OutputNotReceived);
    assert_eq!(read_proposal(&t.env, &t.f, 0).status, ProposalStatus::Open);
    assert_eq!(read_fund(&t.env, &t.f).holdings_len, 1);
}

#[test]
fn executed_trade_still_price_guarded() {
    let (mut t, _m) = crew();
    // min_out 2% under the oracle amount: outside the 1% band.
    let a = SwapArgs::new(t.env.usdc, t.sol, 3_000 * USDC, 19_600_000_000, 20, 3);
    propose(&mut t, &a).unwrap();
    let cap = t.cap.insecure_clone();
    vote(&mut t, &cap, 0, true).unwrap();
    expect_err(execute(&mut t, &cap, 0, &a), ErrorCode::SlippageTooHigh);
    // Paused: a buy through a vote is still blocked.
    let good = big_buy(&t);
    propose(&mut t, &good).unwrap();
    vote(&mut t, &cap, 1, true).unwrap();
    let admin = t.env.admin.insecure_clone();
    send(
        &mut t.env.svm,
        &[ix_set_paused(&admin.pubkey(), true)],
        &[&admin],
    )
    .unwrap();
    expect_err(execute(&mut t, &cap, 1, &good), ErrorCode::Paused);
}

#[test]
fn execute_requires_the_proposal_accounts() {
    let (mut t, _m) = crew();
    let a = big_buy(&t);
    propose(&mut t, &a).unwrap();
    let cap = t.cap.insecure_clone();
    vote(&mut t, &cap, 0, true).unwrap();
    // Another output mint than the one voted for.
    let other = SwapArgs::new(t.env.usdc, t.bonk, 3_000 * USDC, 0, 1, 1);
    expect_err(execute(&mut t, &cap, 0, &other), ErrorCode::Unauthorized);
}

#[test]
fn propose_checks() {
    let (mut t, m) = crew();
    let a = big_buy(&t);
    // A member (not captain, not delegate) cannot propose.
    let ix = ix_propose(&t.env, &t.f, &m.pubkey(), None, &a, venue_data(&a));
    expect_err(send(&mut t.env.svm, &[ix], &[&m]), ErrorCode::Unauthorized);
    // Venue data over 64 bytes.
    let ix = ix_propose(&t.env, &t.f, &t.cap.pubkey(), None, &a, vec![0; 65]);
    expect_err(
        send(&mut t.env.svm, &[ix], &[&t.cap]),
        ErrorCode::VenueDataTooLong,
    );
    // Venue not on the allowlist.
    let mut bad = a;
    bad.venue = Keypair::new().pubkey();
    expect_err(propose(&mut t, &bad), ErrorCode::VenueNotAllowed);
    // Unlisted output.
    let unlisted = create_mint(&mut t.env, 6);
    let bad = SwapArgs::new(t.env.usdc, unlisted, 3_000 * USDC, 0, 1, 1);
    expect_err(propose(&mut t, &bad), ErrorCode::TokenNotListed);
    assert_eq!(read_fund(&t.env, &t.f).proposal_count, 0);

    // 64 bytes exactly is fine; a delegate may propose; ids count up.
    let ix = ix_propose(&t.env, &t.f, &t.cap.pubkey(), None, &a, vec![7; 64]);
    send(&mut t.env.svm, &[ix], &[&t.cap]).unwrap();
    let key = funded(&mut t.env.svm);
    let ix = ix_add_delegate(&t.cap.pubkey(), &t.f, &key.pubkey(), 1, 1);
    send(&mut t.env.svm, &[ix], &[&t.cap]).unwrap();
    let d = Some(delegate_pda(&t.f.fund, &key.pubkey()));
    let ix = ix_propose(&t.env, &t.f, &key.pubkey(), d, &a, venue_data(&a));
    send(&mut t.env.svm, &[ix], &[&key]).unwrap();
    let p = read_proposal(&t.env, &t.f, 1);
    assert_eq!((p.id, p.proposer), (1, key.pubkey()));
    assert_eq!(read_fund(&t.env, &t.f).proposal_count, 2);
}
