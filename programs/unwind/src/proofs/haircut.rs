//! The loss budget and the profit haircut: what a market may still lose, how
//! its budget is raised and capped, what the LPs count it at, and how a
//! winning close is paid when the market cannot pay every winner in full
//! (docs/loss-budget.md, docs/auto-deleveraging.md).
//!
//! The bounds: budget arithmetic runs at full width. Where a harness prices
//! a side or divides by the winners, sizes, entries, prices, balances and
//! amounts owed are 0 to 15: each 128-bit division by a symbolic value
//! costs the solver minutes at eight bits.
//! Every market here is untracked (empty sums), so each side counts at its
//! net profit; `tracking.rs` proves the bound a tracked side counts at.

use super::kit::*;
use crate::errors::PerpError;
use crate::instructions::backing::{budget_cap, raised_budget};
use crate::instructions::trade::haircut_profit_usd;
use crate::math::{mul_div_u64, position_pnl_usd};
use crate::state::*;

fn winners_bound_unreached(_: u128, _: u128, _: u128, _: u128, _: bool) -> Option<u64> {
    kani::assert(false, "every side here is untracked");
    None
}

/// A market whose long and short sides are 0 to 15 at entries 1 to 15,
/// with untracked sums, a pool and budget of 0 to 15, and a net loss from
/// -16 to 15.
fn any_book() -> (Pool, Market) {
    let mut m = blank_market();
    m.long_size_usd = nibble();
    m.short_size_usd = nibble();
    m.long_avg_entry_price = nibble();
    m.short_avg_entry_price = nibble();
    kani::assume(m.long_avg_entry_price > 0 && m.short_avg_entry_price > 0);
    m.loss_budget_usd = nibble();
    m.net_loss_usd = (kani::any::<i8>() >> 3) as i64;
    m.backing_usd = nibble();
    let mut p = blank_pool();
    p.liquidity_usd = nibble();
    p.insurance_usd = nibble();
    (p, m)
}

fn side_profit(m: &Market, is_long: bool, price: u64) -> u64 {
    let (size, entry) = if is_long {
        (m.long_size_usd, m.long_avg_entry_price)
    } else {
        (m.short_size_usd, m.short_avg_entry_price)
    };
    if size == 0 {
        return 0;
    }
    position_pnl_usd(is_long, size, entry, price).unwrap().max(0) as u64
}

/// The haircut is the documented fair share: a close owed `owed` profit is
/// paid `owed * min(1, available / winners)`, rounded down, where
/// `available` is the smaller of the remaining budget and the money there is
/// (the market's backing, LP liquidity, the insurance fund) and `winners` is
/// both sides' winners, the closer's own side counted at no less than
/// `owed`. So every winner paid in the same state is paid the same fraction
/// of what it is owed. Sizes, entries, price, balances and owed 0 to 15.
#[kani::proof]
#[kani::solver(cadical)]
#[kani::stub(crate::state::market::winners_bound, winners_bound_unreached)]
#[kani::stub(PerpError::name, no_name)]
#[kani::stub(<PerpError as core::fmt::Display>::fmt, no_message)]
#[kani::stub(<anchor_lang::error::Error as core::convert::From<crate::errors::PerpError>>::from, cheap_error)]
fn the_haircut_is_the_documented_fair_share() {
    let (p, m) = any_book();
    let is_long: bool = kani::any();
    let (owed, price) = (nibble(), nibble());

    let paid = haircut_profit_usd(&p, &m, owed, price, is_long).unwrap();
    let available = m
        .remaining_budget_usd()
        .min(m.backing_usd + p.liquidity_usd + p.insurance_usd);
    let winners = side_profit(&m, is_long, price).max(owed) + side_profit(&m, !is_long, price);
    if owed == 0 || winners <= available {
        assert!(paid == owed);
    } else {
        assert!(paid == mul_div_u64(owed, available as u128, winners as u128).unwrap());
    }
    kani::cover!(owed > 0 && paid < owed && paid > 0, "a partial haircut");
}

/// More owed is never paid less: in one market state the haircut is
/// monotone in what the close is owed, so a larger winner never leaves with
/// less than a smaller one. Sizes, entries, price, balances and owed 0 to
/// 255.
#[kani::proof]
#[kani::solver(cadical)]
#[kani::stub(crate::state::market::winners_bound, winners_bound_unreached)]
#[kani::stub(PerpError::name, no_name)]
#[kani::stub(<PerpError as core::fmt::Display>::fmt, no_message)]
#[kani::stub(<anchor_lang::error::Error as core::convert::From<crate::errors::PerpError>>::from, cheap_error)]
fn more_owed_is_never_paid_less() {
    let (p, m) = any_book();
    let is_long: bool = kani::any();
    let (a, b, price) = (nibble(), nibble(), nibble());
    kani::assume(a <= b);
    let pa = haircut_profit_usd(&p, &m, a, price, is_long).unwrap();
    let pb = haircut_profit_usd(&p, &m, b, price, is_long).unwrap();
    assert!(pa <= pb);
}

/// The haircut's order does not favour whoever closes first. With winners
/// `w` and `available` short of them, a first close owed `a` is paid its
/// fair share; after it the budget is that payment lower and the winners `a`
/// lower. A second close owed `b` is then paid at least the share it would
/// have had first, and the two together never exceed what was available.
/// So no winner gains by racing another to the money. Stated on the formula
/// `the_haircut_is_the_documented_fair_share` proves the program computes,
/// with the winners' bound exact; a bound that overstates only lowers every
/// share in the same proportion. Amounts 0 to 15.
#[kani::proof]
#[kani::solver(cadical)]
#[kani::stub(PerpError::name, no_name)]
#[kani::stub(<PerpError as core::fmt::Display>::fmt, no_message)]
#[kani::stub(<anchor_lang::error::Error as core::convert::From<crate::errors::PerpError>>::from, cheap_error)]
fn closing_first_wins_nothing() {
    let (w, available, a, b) = (nibble(), nibble(), nibble(), nibble());
    kani::assume(available < w && a + b <= w);
    let share = |owed: u64, avail: u64, winners: u64| -> u64 {
        if owed == 0 || winners <= avail {
            owed
        } else {
            mul_div_u64(owed, avail as u128, winners as u128).unwrap()
        }
    };
    let first = share(a, available, w);
    let b_first = share(b, available, w);
    let b_second = share(b, available - first, w - a);
    assert!(b_second >= b_first);
    assert!(first + b_second <= available);
    kani::cover!(b_second > b_first, "rounding goes to the later closer");
}

/// What is left of a budget is the budget less the net loss, never more
/// than the budget itself: a market that is net up does not bank its gains
/// into a larger allowance. Every input at full width.
#[kani::proof]
fn the_remaining_budget_never_grows_past_the_budget() {
    let mut m = blank_market();
    m.loss_budget_usd = kani::any();
    m.net_loss_usd = kani::any();
    let left = m.remaining_budget_usd();
    assert!(left <= m.loss_budget_usd);
    if m.net_loss_usd <= 0 {
        assert!(left == m.loss_budget_usd);
    } else {
        assert!(left == m.loss_budget_usd.saturating_sub(m.net_loss_usd as u64));
    }
}

/// A deposit raises a market's budget by at most what it counts for, never
/// past what stands behind the market, and never lowers it: a budget the
/// authority set above its backing keeps that figure, and fee income cannot
/// widen it. Every input at full width.
#[kani::proof]
fn a_raised_budget_never_falls_and_never_passes_its_cover() {
    let (budget, cover, counted): (u64, u64, u64) = (kani::any(), kani::any(), kani::any());
    let raised = raised_budget(budget, cover, counted);
    assert!(raised >= budget);
    assert!(raised as u128 <= budget as u128 + counted as u128);
    assert!(raised <= budget.max(cover));
}

/// A budget capped at `budget_cap(cover, net_loss)` leaves at most the cover
/// remaining, and a cap at least the cover never counts a loss twice: the
/// remaining budget under the cap is exactly the cover whenever the budget
/// reaches it. Every input at full width, net loss below 2^63.
#[kani::proof]
fn a_budget_capped_at_its_cover_leaves_at_most_the_cover_remaining() {
    let mut m = blank_market();
    let cover: u64 = kani::any();
    m.net_loss_usd = kani::any();
    let cap = budget_cap(cover, m.net_loss_usd);
    let budget: u64 = kani::any();
    m.loss_budget_usd = budget.min(cap);
    let left = m.remaining_budget_usd();
    if cap < u64::MAX {
        assert!(left <= cover);
    }
    if budget >= cap && cap < u64::MAX {
        assert!(left == cover);
    }
}

/// The LPs never count a market at more than its worst case, and never at
/// more than its traders' collateral as a gain: at any price, what the
/// market owes the LPs (`lp_pnl_usd`) is at most `lp_worst_pnl_usd`, what a
/// withdrawal counts a market at when its price cannot be read, and at least
/// minus the collateral posted. Sizes, entries, price and balances 0 to 15,
/// funding untracked.
#[kani::proof]
#[kani::solver(cadical)]
#[kani::stub(PerpError::name, no_name)]
#[kani::stub(<PerpError as core::fmt::Display>::fmt, no_message)]
#[kani::stub(<anchor_lang::error::Error as core::convert::From<crate::errors::PerpError>>::from, cheap_error)]
fn the_lps_never_count_a_market_past_its_worst_case() {
    let (_, mut m) = any_book();
    m.collateral_usd = nibble();
    m.backing_shares = nibble();
    m.backing_drawn_usd = nibble();
    let price = nibble();
    let owed = m.lp_pnl_usd(price).unwrap();
    assert!(owed <= m.lp_worst_pnl_usd());
    assert!(owed >= -(m.collateral_usd as i64));
    kani::cover!(owed == m.lp_worst_pnl_usd() && owed > 0, "the worst case is reached");
}

/// On a book that is all long, what the LPs owe never falls as the price
/// rises: more trader profit is never a smaller liability. Size, entry,
/// prices and balances 0 to 15, funding untracked.
#[kani::proof]
#[kani::solver(cadical)]
#[kani::stub(PerpError::name, no_name)]
#[kani::stub(<PerpError as core::fmt::Display>::fmt, no_message)]
#[kani::stub(<anchor_lang::error::Error as core::convert::From<crate::errors::PerpError>>::from, cheap_error)]
fn what_the_lps_owe_rises_with_trader_profit() {
    let (_, mut m) = any_book();
    m.short_size_usd = 0;
    m.collateral_usd = nibble();
    m.backing_shares = nibble();
    m.backing_drawn_usd = nibble();
    let (p1, p2) = (nibble(), nibble());
    kani::assume(p1 <= p2);
    assert!(m.lp_pnl_usd(p1).unwrap() <= m.lp_pnl_usd(p2).unwrap());
}

/// What a leaving backer leaves behind for a visible loss is at most the
/// remaining budget and at most what traders are net up: never zero when
/// both are positive, never more than the backing could be asked to pay.
/// Sizes, entries, price and budget 0 to 15.
#[kani::proof]
#[kani::solver(cadical)]
#[kani::stub(PerpError::name, no_name)]
#[kani::stub(<PerpError as core::fmt::Display>::fmt, no_message)]
#[kani::stub(<anchor_lang::error::Error as core::convert::From<crate::errors::PerpError>>::from, cheap_error)]
fn backing_held_back_is_at_most_the_budget_and_the_profit() {
    let (_, m) = any_book();
    let price = nibble();
    let held = m.backing_owed_usd(price).unwrap();
    let net = m.trader_pnl_usd(price).unwrap();
    assert!(held <= m.remaining_budget_usd());
    assert!(held as i64 <= net.max(0));
    if net > 0 && m.remaining_budget_usd() > 0 {
        assert!(held > 0);
    }
}
