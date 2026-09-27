//! Settlement: fee cuts, what a forced close may pay, how a close moves money
//! between the trader and the pool, how far a reduce-only order may fill, and
//! the reservations that stop a position being closed twice.
//!
//! The bounds: pool and market balances up to 2^20 (about a dollar in
//! `USD_SCALE`), payouts up to 2^21, fees up to 2^10 unless a harness says
//! otherwise. Where a harness runs a whole `settle`, the bounds are smaller
//! and stated above those harnesses. Fee shares are either any split
//! `initialize_pool` accepts (protocol, insurance and chain together at most
//! 100 percent) or the documented one, as each harness says.
//!
//! Liquidation is covered by composition rather than by one harness: its
//! payout is `payable_usd` (`a_forced_close_pays_what_is_owed_up_to_the_budget`),
//! its fee cuts never exceed its fee (`fee_cuts_never_exceed_the_fee`), it
//! settles with no fee of its own
//! (`a_forced_close_moves_exactly_the_payout_out_of_the_vault`), and its cuts
//! then move between lines (`fee_cuts_move_money_without_creating_any`).
//!
//! Most harnesses use `#[kani::stub]`, which Cargo.toml turns on for Kani.

use crate::constants::*;
use crate::errors::PerpError;
use crate::instructions::adl::deleverage_due;
use crate::instructions::trade::{
    apply_settlement_to_pool, book_close, close_within_budget, fee_cuts_usd, payable_usd, settle,
    take_fee_cuts, Settlement,
};
use crate::math::bps_of;
use crate::state::*;
use anchor_lang::prelude::Pubkey;

// Stand-ins for things no property here reads.
//
// Every `require!` builds an Anchor error carrying the variant's name and
// message as `String`s, and formatting them is thousands of symbolic steps on
// every failing path. The harnesses only ask whether a call failed, so the two
// text builders return empty text; the variant and the control flow are
// untouched. Settlement also logs an `InsuranceDrawn` event when the fund
// pays, and Kani's compiler panics on the host logging path behind `emit!`,
// so the log call does nothing. The event is a log line and moves no money.
fn no_name(_: &PerpError) -> String {
    String::new()
}

fn no_message(_: &PerpError, _: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
    Ok(())
}

fn no_log(_: &[&[u8]]) {}

/// Balances up to about a dollar. The properties are about which line money
/// moves between, not how much of it there is.
const MAX_BAL: u64 = 1 << 20;

/// Fees up to 2^10. A fee's cuts are three multiply-then-divide steps by
/// unknown shares, which is the costly shape for a model checker; ten bits
/// cover every way three floors can round against each other.
const MAX_FEE: u64 = 1 << 10;

fn small(max: u64) -> u64 {
    let v: u64 = kani::any();
    kani::assume(v <= max);
    v
}

/// A pool whose fee shares are any split `initialize_pool` would accept.
fn any_pool() -> Pool {
    let p = Pool {
        bump: 0,
        vault_bump: 0,
        lp_mint_bump: 0,
        authority: Pubkey::default(),
        pending_authority: Pubkey::default(),
        usdc_mint: Pubkey::default(),
        usdc_vault: Pubkey::default(),
        lp_mint: Pubkey::default(),
        num_markets: 1,
        liquidity_usd: small(MAX_BAL),
        locked_usd: small(MAX_BAL),
        trader_collateral_usd: small(MAX_BAL),
        protocol_fees_usd: small(MAX_BAL),
        insurance_usd: small(MAX_BAL),
        insurance_fee_share_bps: kani::any(),
        escrow_usd: small(MAX_BAL),
        chain_fee_destination: Pubkey::default(),
        chain_fees_usd: small(MAX_BAL),
        rewards_usd: 0,
        pyth_receiver: Pubkey::default(),
        add_liquidity_fee_bps: 0,
        remove_liquidity_fee_bps: 0,
        protocol_fee_share_bps: kani::any(),
        max_utilization_bps: 8_000,
        paused: false,
        backing_usd: small(MAX_BAL),
        num_custodies: 0,
        markets_with_oi: kani::any(),
        _reserved: [0; 3],
    };
    kani::assume(
        p.protocol_fee_share_bps as u128
            + p.insurance_fee_share_bps as u128
            + CHAIN_FEE_SHARE_BPS as u128
            <= BPS,
    );
    p
}

/// A pool on the documented split (docs/fees.md: 20 percent protocol, 10
/// percent insurance) with symbolic balances. The harnesses about where money
/// goes use it: those properties do not depend on the split, and
/// `fee_cuts_never_exceed_the_fee` covers every split the pool accepts.
/// Unknown shares multiply against unknown fees, which is what makes the
/// model checker slow, so each harness takes only the unknowns it is about.
fn documented_pool() -> Pool {
    let mut p = any_pool();
    kani::assume(p.protocol_fee_share_bps == 2_000 && p.insurance_fee_share_bps == 1_000);
    p.protocol_fee_share_bps = 2_000;
    p.insurance_fee_share_bps = 1_000;
    p
}

/// A market with a symbolic budget, backing and open interest. Its price
/// factor is the one positions below are written under, so no corporate
/// action is in play.
fn any_market() -> Market {
    let net_loss: i64 = kani::any();
    kani::assume(net_loss >= -(MAX_BAL as i64) && net_loss <= MAX_BAL as i64);
    let m = Market {
        bump: 0,
        pool: Pubkey::default(),
        symbol: [0; 16],
        feed_id: [0; 32],
        max_price_age_sec: 60,
        max_conf_bps: 500,
        max_leverage_bps: 100_000,
        maintenance_margin_bps: 500,
        liquidation_fee_bps: 100,
        open_fee_bps: 0,
        close_fee_bps: kani::any(),
        min_position_usd: 1,
        max_oi_long_usd: u64::MAX,
        max_oi_short_usd: u64::MAX,
        pnl_reserve_bps: 10_000,
        base_spread_bps: 4,
        conf_spread_mult_bps: 10_000,
        max_spread_bps: 500,
        session: Session::Regular as u8,
        closed_session_leverage_bps: 20_000,
        closed_session_oi_mult_bps: 2_500,
        cumulative_long_funding: 0,
        cumulative_short_funding: 0,
        last_funding_ts: 0,
        max_funding_rate_bps_per_hour: 100,
        funding_k_bps: 8_000,
        borrow_rate_bps_per_hour: 1,
        long_size_usd: small(MAX_BAL),
        long_avg_entry_price: 1,
        short_size_usd: small(MAX_BAL),
        short_avg_entry_price: 1,
        collateral_usd: small(MAX_BAL),
        price_factor: PRICE_FACTOR_ONE,
        split_epoch: 0,
        last_multiplier: MULTIPLIER_SCALE as u64,
        paused: false,
        price_source: PriceSource::Pyth as u8,
        observation: Pubkey::default(),
        deployer: Pubkey::default(),
        backing_usd: small(MAX_BAL),
        backing_shares: small(MAX_BAL),
        backing_drawn_usd: small(MAX_BAL),
        loss_budget_usd: small(MAX_BAL),
        net_loss_usd: net_loss,
        locked_usd: small(MAX_BAL),
        last_price_ts: 0,
        depth_leverage_x: 0,
        _reserved: [0; 2],
        volume_usd: 0,
        deployer_synced_volume_usd: 0,
        deployer_rewards_usd: 0,
        deployer_earned_usd: 0,
    };
    kani::assume(m.close_fee_bps as u128 <= BPS);
    m
}

fn empty_position(is_long: bool, size_usd: u64) -> Position {
    Position {
        bump: 0,
        owner: Pubkey::default(),
        market: Pubkey::default(),
        is_long,
        size_usd,
        collateral_usd: 0,
        entry_price: 0,
        entry_price_factor: PRICE_FACTOR_ONE,
        entry_funding: 0,
        locked_usd: 0,
        closing_usd: 0,
        open_ts: 0,
        last_update_ts: 0,
        _reserved: [0; 24],
    }
}

fn any_settlement() -> Settlement {
    let pnl: i64 = kani::any();
    kani::assume(pnl >= -(MAX_BAL as i64) && pnl <= MAX_BAL as i64);
    Settlement {
        collateral_share: small(MAX_BAL),
        locked_release: small(MAX_BAL),
        pnl_usd: pnl,
        funding_usd: 0,
        equity_usd: small(2 * MAX_BAL),
    }
}

/// The pool's backing line is the sum of every market's backing, so for one
/// market it holds at least that market's share.
fn assume_books_consistent(p: &Pool, m: &Market) {
    kani::assume(p.backing_usd >= m.backing_usd);
}

// Fees.

/// The protocol, chain and insurance cuts of a fee never add up to more than
/// the fee. Liquidation computes the liquidator's bounty as `fee - cuts` and
/// settlement the LPs' part as `fee_usd - cuts`; this is what keeps both from
/// underflowing, for any share split the pool can be created with. Fees up to
/// 2^10 (see `MAX_FEE`).
#[kani::proof]
#[kani::stub(PerpError::name, no_name)]
#[kani::stub(<PerpError as core::fmt::Display>::fmt, no_message)]
#[kani::stub(anchor_lang::solana_program::log::sol_log_data, no_log)]
#[kani::solver(kissat)]
fn fee_cuts_never_exceed_the_fee() {
    let p = any_pool();
    let fee = small(MAX_FEE);
    let cuts = fee_cuts_usd(&p, fee).unwrap();
    assert!(cuts <= fee);
}

/// Taking the cuts out of a fee moves money between the pool's lines and never
/// creates or destroys any: liquidity loses exactly what the protocol, chain
/// and insurance lines gain, and that is what the function reports. No line is
/// ever paid more than its documented share of the fee (docs/fees.md), even
/// when liquidity is too thin to pay them all. On the documented split, fees
/// up to 2^10 and balances up to 2^20.
#[kani::proof]
#[kani::stub(PerpError::name, no_name)]
#[kani::stub(<PerpError as core::fmt::Display>::fmt, no_message)]
#[kani::stub(anchor_lang::solana_program::log::sol_log_data, no_log)]
#[kani::solver(cadical)]
fn fee_cuts_move_money_without_creating_any() {
    let mut p = documented_pool();
    let fee = small(MAX_FEE);
    let before = p.clone();
    let taken = take_fee_cuts(&mut p, fee).unwrap();

    let protocol = p.protocol_fees_usd - before.protocol_fees_usd;
    let chain = p.chain_fees_usd - before.chain_fees_usd;
    let insurance = p.insurance_usd - before.insurance_usd;
    assert!(taken == protocol + chain + insurance);
    assert!(before.liquidity_usd - p.liquidity_usd == taken);
    assert!(protocol as u128 * BPS <= fee as u128 * 2_000);
    assert!(chain as u128 * BPS <= fee as u128 * CHAIN_FEE_SHARE_BPS as u128);
    assert!(insurance as u128 * BPS <= fee as u128 * 1_000);
}

/// When liquidity is not short, each line gets exactly its documented share
/// of the fee, rounded down: 20 percent to the protocol, 10 to the chain and
/// 10 to the insurance fund (docs/fees.md). "Not short" is taken as three
/// times the fee, which covers the cuts in any order they are taken. Fees up
/// to 2^10.
#[kani::proof]
#[kani::stub(PerpError::name, no_name)]
#[kani::stub(<PerpError as core::fmt::Display>::fmt, no_message)]
#[kani::stub(anchor_lang::solana_program::log::sol_log_data, no_log)]
#[kani::solver(cadical)]
fn each_fee_line_gets_its_documented_share() {
    let mut p = documented_pool();
    let fee = small(MAX_FEE);
    kani::assume(p.liquidity_usd >= 3 * fee);
    let before = p.clone();
    take_fee_cuts(&mut p, fee).unwrap();

    let protocol = (p.protocol_fees_usd - before.protocol_fees_usd) as u128;
    let chain = (p.chain_fees_usd - before.chain_fees_usd) as u128;
    let insurance = (p.insurance_usd - before.insurance_usd) as u128;
    // Floor of the exact share: at most it, and less than one unit short.
    let f = fee as u128;
    assert!(protocol * BPS <= f * 2_000 && f * 2_000 < (protocol + 1) * BPS);
    assert!(chain * BPS <= f * 1_000 && f * 1_000 < (chain + 1) * BPS);
    assert!(insurance * BPS <= f * 1_000 && f * 1_000 < (insurance + 1) * BPS);
}

// What a forced close may pay.

/// A forced close (deleveraging, liquidation) pays no more than the position's
/// equity, and no more profit past its collateral than the market's remaining
/// budget. Within that it pays everything owed: a position whose equity the
/// budget covers, and so every losing or flat one, is paid in full. It follows
/// that `equity - payout`, the haircut `auto_deleverage` reports, never
/// underflows, and that charging the payout's profit to the budget never fails.
#[kani::proof]
#[kani::stub(PerpError::name, no_name)]
#[kani::stub(<PerpError as core::fmt::Display>::fmt, no_message)]
#[kani::stub(anchor_lang::solana_program::log::sol_log_data, no_log)]
#[kani::solver(cadical)]
fn a_forced_close_pays_what_is_owed_up_to_the_budget() {
    let mut m = any_market();
    let s = any_settlement();
    let remaining = m.remaining_budget_usd();
    let payout = payable_usd(&m, &s);

    assert!(payout <= s.equity_usd);
    assert!(payout.saturating_sub(s.collateral_share) <= remaining);
    if s.equity_usd as u128 <= s.collateral_share as u128 + remaining as u128 {
        assert!(payout == s.equity_usd);
    }
    // A loser's collateral is what it has left, and it gets all of it.
    if s.equity_usd <= s.collateral_share {
        assert!(payout == s.equity_usd);
    }
    assert!(m.charge_loss(payout.saturating_sub(s.collateral_share)).is_ok());
}

/// Deleveraging at `payable_usd` completes whenever the money is there, and
/// never takes the market's net loss past its budget. This is the close that
/// runs once a market has spent its budget, so it is the one that must not
/// fail on it, and must not overspend it either.
#[kani::proof]
#[kani::stub(PerpError::name, no_name)]
#[kani::stub(<PerpError as core::fmt::Display>::fmt, no_message)]
#[kani::stub(anchor_lang::solana_program::log::sol_log_data, no_log)]
#[kani::solver(cadical)]
fn a_forced_close_settles_inside_the_budget() {
    let mut p = documented_pool();
    let mut m = any_market();
    let s = any_settlement();
    assume_books_consistent(&p, &m);
    kani::assume(m.net_loss_usd <= m.loss_budget_usd as i64);
    kani::assume(p.trader_collateral_usd >= s.collateral_share);
    let payout = payable_usd(&m, &s);
    // The money to pay it exists: the market's backing, then LP liquidity,
    // then the insurance fund.
    let loss = payout.saturating_sub(s.collateral_share);
    kani::assume(
        loss as u128 <= m.backing_usd as u128 + p.liquidity_usd as u128 + p.insurance_usd as u128,
    );
    let is_long: bool = kani::any();
    let close_size = small(MAX_BAL);

    let r = apply_settlement_to_pool(&mut p, &mut m, &s, payout, 0, close_size, is_long);
    assert!(r.is_ok());
    assert!(m.net_loss_usd <= m.loss_budget_usd as i64);
}

// Settlement.

/// What a settlement does to the vault's books, stated line by line: the
/// trader's collateral leaves the collateral line in full, escrow is not
/// touched, and the pool's own lines together (liquidity, backing, insurance,
/// protocol and chain fees) pay exactly the payout past that collateral on a
/// winning close and keep exactly the collateral past the payout on a losing
/// one. So nothing is created or lost, whichever of backing, LPs and the fund
/// the loss lands on and however a fee is split between lines.
///
/// The conservation is asserted per path rather than as one sum over every
/// line: a single seven-term equation is the same claim, but a SAT solver has
/// to rediscover addition to reassociate it and runs for minutes.
fn assert_settlement_conserves(before: &Pool, after: &Pool, s: &Settlement, payout: u64) {
    let pool_lines = |p: &Pool| {
        p.liquidity_usd as u128
            + p.backing_usd as u128
            + p.insurance_usd as u128
            + p.protocol_fees_usd as u128
            + p.chain_fees_usd as u128
    };
    assert!(before.trader_collateral_usd - after.trader_collateral_usd == s.collateral_share);
    assert!(before.escrow_usd == after.escrow_usd);
    let (was, is) = (pool_lines(before), pool_lines(after));
    if payout >= s.collateral_share {
        assert!(was - is == (payout - s.collateral_share) as u128);
    } else {
        assert!(is - was == (s.collateral_share - payout) as u128);
    }
}

/// A forced close, which settles with no fee of its own (`auto_deleverage`,
/// and `liquidate` before it moves its fee), takes exactly the payout out of
/// the vault's books and books the same amount against the market's budget.
/// See `assert_settlement_conserves`. Balances up to 2^20, payouts to 2^21.
#[kani::proof]
#[kani::stub(PerpError::name, no_name)]
#[kani::stub(<PerpError as core::fmt::Display>::fmt, no_message)]
#[kani::stub(anchor_lang::solana_program::log::sol_log_data, no_log)]
#[kani::solver(cadical)]
fn a_forced_close_moves_exactly_the_payout_out_of_the_vault() {
    let mut p = documented_pool();
    let mut m = any_market();
    let s = any_settlement();
    assume_books_consistent(&p, &m);
    kani::assume(p.trader_collateral_usd >= s.collateral_share);
    let payout = small(2 * MAX_BAL);
    kani::assume(payout <= s.equity_usd);
    let is_long: bool = kani::any();
    let close_size = small(MAX_BAL);
    let before = p.clone();
    let net_loss = m.net_loss_usd;

    if apply_settlement_to_pool(&mut p, &mut m, &s, payout, 0, close_size, is_long).is_ok() {
        assert_settlement_conserves(&before, &p, &s, payout);
        assert!(m.net_loss_usd as i128 - net_loss as i128
            == payout as i128 - s.collateral_share as i128);
    }
}

// How far a reduce-only order fills.
//
// `settle_order` closes `close_within_budget(..)` of a filled reduce-only
// order and then calls `book_close` on it. The two harnesses below prove the
// two halves: what `close_within_budget` returns fits the budget and the cash,
// and anything that fits both books. Together: a close cut to the budget
// always settles, which is what keeps a sealed batch from being held.
//
// Bounds for everything that runs `settle`: size, collateral and reserve up
// to 7, entry and fill prices 1 to 4, funding up to two quarter-steps of the
// index either way (so a size of 4 owes or earns up to 2 units), budget, cash
// and backing up to 63, close fee any rate.

const SMALL_BOOKS: u64 = 63;

/// Narrows a pool and market to the books a settle-sized harness can afford.
fn assume_small_books(p: &Pool, m: &Market) {
    kani::assume(p.liquidity_usd <= SMALL_BOOKS && p.insurance_usd <= SMALL_BOOKS);
    kani::assume(m.backing_usd <= SMALL_BOOKS && m.loss_budget_usd <= SMALL_BOOKS);
    kani::assume(m.net_loss_usd >= -(SMALL_BOOKS as i64) && m.net_loss_usd <= SMALL_BOOKS as i64);
    kani::assume(m.net_loss_usd <= m.loss_budget_usd as i64);
}

/// A small open position, written under the market's current price factor,
/// that owes funding on its side in quarter-steps of the index from
/// `min_steps` to 2 (negative means it has received funding).
fn any_open_position(market: &mut Market, min_steps: i8) -> Position {
    let mut pos = empty_position(kani::any(), small(7));
    kani::assume(pos.size_usd >= 1);
    pos.collateral_usd = small(7);
    pos.locked_usd = small(7);
    pos.entry_price = small(4);
    kani::assume(pos.entry_price >= 1);
    let k: i8 = kani::any();
    kani::assume(k >= min_steps && k <= 2);
    let cumulative = k as i128 * (FUNDING_SCALE / 4);
    if pos.is_long {
        market.cumulative_long_funding = cumulative;
    } else {
        market.cumulative_short_funding = cumulative;
    }
    pos
}

fn any_fill() -> u64 {
    let fill = small(4);
    kani::assume(fill >= 1);
    fill
}

/// What closing `size` at `fill` costs the market's budget, computed the way
/// `book_close` pays it: equity less the close fee, past the collateral the
/// close releases.
fn close_cost(pos: &Position, m: &Market, size: u64, fill: u64) -> u64 {
    let s = settle(pos, m, size, fill).unwrap();
    let fee = bps_of(size, m.close_fee_bps).unwrap().min(s.equity_usd);
    (s.equity_usd - fee).saturating_sub(s.collateral_share)
}

/// What `close_within_budget` hands back is never more than was asked, and
/// closing it costs no more than the market's remaining budget or the money
/// there is to pay with (the market's backing, LP liquidity and the insurance
/// fund).
#[kani::proof]
#[kani::stub(PerpError::name, no_name)]
#[kani::stub(<PerpError as core::fmt::Display>::fmt, no_message)]
#[kani::stub(anchor_lang::solana_program::log::sol_log_data, no_log)]
#[kani::unwind(6)]
#[kani::solver(cadical)]
fn a_close_is_cut_to_what_the_market_can_pay() {
    let p = documented_pool();
    let mut m = any_market();
    let pos = any_open_position(&mut m, -2);
    assume_small_books(&p, &m);
    let close_size = small(7);
    kani::assume(close_size >= 1 && close_size <= pos.size_usd);
    let fill = any_fill();

    let size = close_within_budget(&p, &pos, &m, close_size, fill).unwrap();
    assert!(size <= close_size);
    if size > 0 {
        let cash = m.backing_usd + p.liquidity_usd + p.insurance_usd;
        assert!(close_cost(&pos, &m, size, fill) <= m.remaining_budget_usd().min(cash));
    }
}

/// Any close whose cost fits the remaining budget and the money there is to
/// pay it with books: `book_close` does not fail, and the market's net loss
/// stays inside its budget. With the harness above, a close cut by
/// `close_within_budget` always settles.
#[kani::proof]
#[kani::stub(PerpError::name, no_name)]
#[kani::stub(<PerpError as core::fmt::Display>::fmt, no_message)]
#[kani::stub(anchor_lang::solana_program::log::sol_log_data, no_log)]
#[kani::solver(cadical)]
fn a_close_the_market_can_pay_always_books() {
    let mut p = documented_pool();
    let mut m = any_market();
    let mut pos = any_open_position(&mut m, -2);
    assume_small_books(&p, &m);
    assume_books_consistent(&p, &m);
    // The position's own lines are inside the pool's and the market's.
    kani::assume(p.trader_collateral_usd >= pos.collateral_usd);
    kani::assume(m.collateral_usd >= pos.collateral_usd);
    let size = small(7);
    kani::assume(size >= 1 && size <= pos.size_usd);
    let fill = any_fill();
    let cash = m.backing_usd + p.liquidity_usd + p.insurance_usd;
    kani::assume(close_cost(&pos, &m, size, fill) <= m.remaining_budget_usd().min(cash));

    assert!(book_close(&mut p, &mut m, &mut pos, size, fill, 1).is_ok());
    assert!(m.net_loss_usd <= m.loss_budget_usd as i64);
}

/// A close that costs the pool nothing, one whose equity after the fee is no
/// more than the collateral it releases, fills in full however empty the
/// budget and the pool are. A market with no budget left stays open for exits
/// (docs/loss-budget.md).
#[kani::proof]
#[kani::stub(PerpError::name, no_name)]
#[kani::stub(<PerpError as core::fmt::Display>::fmt, no_message)]
#[kani::stub(anchor_lang::solana_program::log::sol_log_data, no_log)]
#[kani::unwind(6)]
#[kani::solver(cadical)]
fn a_close_that_costs_the_pool_nothing_fills_in_full() {
    let p = any_pool();
    let mut m = any_market();
    let pos = any_open_position(&mut m, -2);
    assume_small_books(&p, &m);
    let close_size = small(7);
    kani::assume(close_size >= 1 && close_size <= pos.size_usd);
    let fill = any_fill();
    kani::assume(close_cost(&pos, &m, close_size, fill) == 0);

    assert!(close_within_budget(&p, &pos, &m, close_size, fill).unwrap() == close_size);
}

/// No price winner is stuck. If the budget stops a close from filling in full
/// for a position whose funding has cost it something or nothing, the same
/// position at the same price is due for deleveraging, which pays it at the
/// mark with what the budget has left. Without this a winner in a market that
/// has spent its budget could neither leave by the batch nor be deleveraged
/// (docs/auto-deleveraging.md). Holds when the budget, not the pool's cash,
/// is what binds. For a position that has received funding it does not hold:
/// see the disabled harness below.
#[kani::proof]
#[kani::stub(PerpError::name, no_name)]
#[kani::stub(<PerpError as core::fmt::Display>::fmt, no_message)]
#[kani::stub(anchor_lang::solana_program::log::sol_log_data, no_log)]
#[kani::unwind(6)]
#[kani::solver(cadical)]
fn a_price_winner_the_budget_holds_back_can_be_deleveraged() {
    let p = any_pool();
    let mut m = any_market();
    let pos = any_open_position(&mut m, 0);
    assume_small_books(&p, &m);
    let fill = any_fill();
    let remaining = m.remaining_budget_usd();
    kani::assume(remaining <= m.backing_usd + p.liquidity_usd + p.insurance_usd);

    let size = close_within_budget(&p, &pos, &m, pos.size_usd, fill).unwrap();
    if size < pos.size_usd {
        let whole = settle(&pos, &m, pos.size_usd, fill).unwrap();
        assert!(deleverage_due(&pos, &m, &whole));
    }
}

/// The same property for any funding: a position the budget holds back is
/// always one deleveraging can close, whatever share of its gain is funding.
///
/// This failed before the fix, and is kept as the record of it: a long at a
/// flat price (fill equal to entry, so `pnl_usd` is 0) that had received
/// funding had equity past its collateral. With the budget spent,
/// `close_within_budget` filled none of it, collateral included, but
/// `deleverage_due` returned false for any `pnl_usd <= 0`. The position could
/// neither leave by the batch nor be deleveraged, and was not liquidatable
/// because it was healthy. `deleverage_due` now reads equity past collateral.
#[kani::proof]
#[kani::stub(PerpError::name, no_name)]
#[kani::stub(<PerpError as core::fmt::Display>::fmt, no_message)]
#[kani::stub(anchor_lang::solana_program::log::sol_log_data, no_log)]
#[kani::unwind(6)]
#[kani::solver(cadical)]
fn a_winner_the_budget_holds_back_can_be_deleveraged() {
    let p = any_pool();
    let mut m = any_market();
    let pos = any_open_position(&mut m, -2);
    assume_small_books(&p, &m);
    let fill = any_fill();
    let remaining = m.remaining_budget_usd();
    kani::assume(remaining <= m.backing_usd + p.liquidity_usd + p.insurance_usd);

    let size = close_within_budget(&p, &pos, &m, pos.size_usd, fill).unwrap();
    if size < pos.size_usd {
        let whole = settle(&pos, &m, pos.size_usd, fill).unwrap();
        assert!(deleverage_due(&pos, &m, &whole));
    }
}

// Close reservations.

/// However many closing orders a trader submits, the size they reserve never
/// adds up to more than the position holds: each is accepted only if it fits
/// in what is left, and `closing_usd` stays within `size_usd`. Without this
/// the same size could be submitted to close three times and each settlement
/// would unwind a position that only covered the first.
#[kani::proof]
#[kani::stub(PerpError::name, no_name)]
#[kani::stub(<PerpError as core::fmt::Display>::fmt, no_message)]
#[kani::stub(anchor_lang::solana_program::log::sol_log_data, no_log)]
#[kani::solver(cadical)]
fn reservations_never_promise_more_than_the_position_holds() {
    let mut pos = empty_position(kani::any(), kani::any());
    let mut accepted: u128 = 0;
    for _ in 0..3 {
        let ask: u64 = kani::any();
        let closable = pos.closable_usd();
        let ok = pos.reserve_close(ask).is_ok();
        assert!(ok == (ask <= closable));
        if ok {
            accepted += ask as u128;
        }
        assert!(pos.closing_usd <= pos.size_usd);
        assert!(pos.closable_usd() == pos.size_usd - pos.closing_usd);
    }
    assert!(accepted <= pos.size_usd as u128);
}

/// Releasing a reservation gives back exactly what reserving it took, so a
/// cancelled or settled order leaves the position able to promise the same
/// size again. A release for more than is reserved, which a liquidation can
/// cause, empties the reservation instead of wrapping to a huge one that
/// would block every later close.
#[kani::proof]
#[kani::stub(PerpError::name, no_name)]
#[kani::stub(<PerpError as core::fmt::Display>::fmt, no_message)]
#[kani::stub(anchor_lang::solana_program::log::sol_log_data, no_log)]
#[kani::solver(cadical)]
fn a_release_gives_back_exactly_what_was_reserved() {
    let mut pos = empty_position(kani::any(), kani::any());
    pos.closing_usd = kani::any();
    kani::assume(pos.closing_usd <= pos.size_usd);
    let (closing, closable) = (pos.closing_usd, pos.closable_usd());

    let ask: u64 = kani::any();
    if pos.reserve_close(ask).is_ok() {
        pos.release_close(ask);
        assert!(pos.closing_usd == closing && pos.closable_usd() == closable);
    }

    // After a liquidation: the size is gone but the reservation is not.
    pos.size_usd = kani::any();
    let before = pos.closing_usd;
    let back: u64 = kani::any();
    pos.release_close(back);
    assert!(pos.closing_usd <= before);
    assert!(pos.closing_usd == before.saturating_sub(back));
}

/// At settlement a filled close takes no more than it filled, no more than
/// the position holds, and nothing at all from a position that is empty or
/// has flipped to the side the order would add to. So `book_close` never
/// refuses what `closable_by` hands it for being larger than the position,
/// and a stale sell cannot shrink the short that replaced a liquidated long.
#[kani::proof]
fn a_settling_close_takes_only_what_is_there_on_its_own_side() {
    let pos = empty_position(kani::any(), kani::any());
    let is_bid: bool = kani::any();
    let filled: u64 = kani::any();
    let take = pos.closable_by(is_bid, filled);

    assert!(take <= filled && take <= pos.size_usd);
    if take > 0 {
        // Positive only for an open position, on the side the order closes.
        assert!(pos.is_open() && is_bid != pos.is_long);
    }
    if pos.is_open() && is_bid != pos.is_long {
        // And there, it takes everything it can.
        assert!(take == filled.min(pos.size_usd));
    }
}
