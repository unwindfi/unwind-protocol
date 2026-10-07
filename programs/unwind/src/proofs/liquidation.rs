//! Liquidation: how `liquidation` splits what a failing position has left,
//! that it never costs the pool more than letting the position close, and
//! that the price it closes at is never kinder to the position than the one
//! that triggered it. `orders.rs` holds the older harnesses on when a
//! position is liquidatable and the liquidator's cap.
//!
//! The bounds: settlement figures (collateral share, equity) and close sizes
//! up to 2^10, any liquidation fee and maintenance margin, and the
//! documented fee split (`fee_cuts_never_exceed_the_fee` in `settlement.rs`
//! covers every split). A liquidation is five divisions of symbolic values,
//! which is what bounds the sizes. Where a harness runs `settle`, sizes,
//! collateral and prices are 0 to 15.

use super::kit::*;
use crate::constants::*;
use crate::errors::PerpError;
use crate::instructions::liquidate::liquidation;
use crate::instructions::trade::{payable_usd, settle, Settlement};
use crate::state::*;

const MAX_BAL: u64 = 1 << 10;

fn upto(max: u64) -> u64 {
    let v: u64 = kani::any();
    kani::assume(v <= max);
    v
}

fn any_settlement() -> Settlement {
    Settlement {
        collateral_share: upto(MAX_BAL),
        locked_release: 0,
        pnl_usd: 0,
        funding_usd: 0,
        equity_usd: upto(2 * MAX_BAL),
    }
}

/// A market with any liquidation fee and maintenance margin, and a budget
/// that has not been overspent.
fn any_liquidation_market() -> Market {
    let mut m = blank_market();
    m.liquidation_fee_bps = kani::any();
    m.maintenance_margin_bps = kani::any();
    m.loss_budget_usd = upto(MAX_BAL);
    m.net_loss_usd = upto(2 * MAX_BAL) as i64 - MAX_BAL as i64;
    kani::assume(m.liquidation_fee_bps as u128 <= BPS);
    m
}

/// A liquidation divides what the position has left, and nothing more,
/// exactly: the fee and what goes back to the owner add up to the payable
/// equity; the liquidator's bounty and the protocol, chain and insurance
/// cuts add up to the fee; and what leaves the vault is the bounty and the
/// owner's part, the cuts staying in the pool.
#[kani::proof]
#[kani::solver(cadical)]
#[kani::stub(PerpError::name, no_name)]
#[kani::stub(<PerpError as core::fmt::Display>::fmt, no_message)]
#[kani::stub(<anchor_lang::error::Error as core::convert::From<crate::errors::PerpError>>::from, cheap_error)]
fn a_liquidation_splits_what_is_left_exactly() {
    let p = blank_pool();
    let m = any_liquidation_market();
    let s = any_settlement();
    let size = upto(1 << 10);

    let Ok(l) = liquidation(&p, &m, &s, size) else {
        return;
    };
    let equity = payable_usd(&m, &s);
    assert!(l.fee + l.to_owner == equity);
    assert!(l.bounty <= l.fee);
    assert!(l.payout == l.bounty + l.to_owner);
    // The cuts, `fee - bounty`, are what stays behind in the pool.
    assert!(l.payout + (l.fee - l.bounty) == equity);
    kani::cover!(l.bounty > 0 && l.to_owner > 0, "both the liquidator and the owner are paid");
}

/// The liquidation fee never exceeds what the position has left: it is at
/// most the payable equity, so a position already through zero pays nobody
/// anything and costs the pool nothing past its collateral.
#[kani::proof]
#[kani::solver(cadical)]
#[kani::stub(PerpError::name, no_name)]
#[kani::stub(<PerpError as core::fmt::Display>::fmt, no_message)]
#[kani::stub(<anchor_lang::error::Error as core::convert::From<crate::errors::PerpError>>::from, cheap_error)]
fn the_liquidation_fee_never_exceeds_what_is_left() {
    let p = blank_pool();
    let m = any_liquidation_market();
    let s = any_settlement();
    let size = upto(1 << 10);

    let Ok(l) = liquidation(&p, &m, &s, size) else {
        return;
    };
    assert!(l.fee <= s.equity_usd);
    assert!(l.fee <= payable_usd(&m, &s));
    assert!(l.fee as u128 * BPS <= size as u128 * m.liquidation_fee_bps as u128);
    if s.equity_usd == 0 {
        assert!(l.fee == 0 && l.bounty == 0 && l.to_owner == 0 && l.payout == 0);
    }
    kani::cover!(l.fee == s.equity_usd && l.fee > 0, "the fee takes everything left");
}

/// Liquidating never leaves the pool worse off than letting the position
/// close at the same price: what leaves the vault is at most the position's
/// equity, at most what a forced close would pay (`payable_usd`), and so at
/// most its collateral plus the market's remaining budget. The pool keeps the
/// cuts on top.
#[kani::proof]
#[kani::solver(cadical)]
#[kani::stub(PerpError::name, no_name)]
#[kani::stub(<PerpError as core::fmt::Display>::fmt, no_message)]
#[kani::stub(<anchor_lang::error::Error as core::convert::From<crate::errors::PerpError>>::from, cheap_error)]
fn liquidating_never_leaves_the_pool_worse_than_a_close() {
    let p = blank_pool();
    let m = any_liquidation_market();
    let s = any_settlement();
    let size = upto(1 << 10);

    let Ok(l) = liquidation(&p, &m, &s, size) else {
        return;
    };
    assert!(l.payout <= s.equity_usd);
    assert!(l.payout <= payable_usd(&m, &s));
    assert!(l.payout.saturating_sub(s.collateral_share) <= m.remaining_budget_usd());
    kani::cover!(
        s.equity_usd > s.collateral_share + m.remaining_budget_usd(),
        "a winner the budget cannot pay in full"
    );
}

/// On the documented split the liquidator keeps at least 60 percent of the
/// fee, the share the LPs would have had: the protocol's 20, the chain's 10
/// and the fund's 10 percent are each rounded down.
#[kani::proof]
#[kani::solver(cadical)]
#[kani::stub(PerpError::name, no_name)]
#[kani::stub(<PerpError as core::fmt::Display>::fmt, no_message)]
#[kani::stub(<anchor_lang::error::Error as core::convert::From<crate::errors::PerpError>>::from, cheap_error)]
fn the_liquidator_keeps_the_lps_share_of_the_fee() {
    let p = blank_pool();
    let m = any_liquidation_market();
    let s = any_settlement();
    let size = upto(1 << 10);

    let Ok(l) = liquidation(&p, &m, &s, size) else {
        return;
    };
    assert!(l.bounty as u128 * BPS >= l.fee as u128 * 6_000);
    assert!(l.bounty <= l.fee);
}

/// A liquidation is refused exactly when the position is not under its
/// maintenance margin, and never refused otherwise: no healthy position is
/// closed, and nothing in the split can fail on one that is not.
#[kani::proof]
#[kani::solver(cadical)]
#[kani::stub(PerpError::name, no_name)]
#[kani::stub(<PerpError as core::fmt::Display>::fmt, no_message)]
#[kani::stub(<anchor_lang::error::Error as core::convert::From<crate::errors::PerpError>>::from, cheap_error)]
fn a_liquidation_fails_only_on_a_healthy_position() {
    let p = blank_pool();
    let m = any_liquidation_market();
    let s = any_settlement();
    let size = upto(1 << 10);
    // equity < floor(size * margin / BPS), stated without the division.
    let under = (s.equity_usd as u128 + 1) * BPS <= size as u128 * m.maintenance_margin_bps as u128;
    assert!(liquidation(&p, &m, &s, size).is_ok() == under);
}

/// A position that fails at the trigger fails at the close: a liquidation
/// closes at the worse of the risk price and the oracle for the position
/// (`liquidation_fills`), and equity never rises as the fill gets worse
/// for the position, lower for a long and higher for a short. So the close
/// never finds a position healthy that the trigger found failing. Size,
/// collateral, entry and fills 0 to 15, funding owed in quarter-steps.
#[kani::proof]
#[kani::solver(cadical)]
#[kani::stub(PerpError::name, no_name)]
#[kani::stub(<PerpError as core::fmt::Display>::fmt, no_message)]
#[kani::stub(<anchor_lang::error::Error as core::convert::From<crate::errors::PerpError>>::from, cheap_error)]
fn equity_never_rises_as_the_fill_gets_worse_for_the_position() {
    let mut m = blank_market();
    let is_long: bool = kani::any();
    let mut pos = blank_position(is_long);
    pos.size_usd = nibble();
    pos.collateral_usd = nibble();
    pos.entry_price = nibble();
    kani::assume(pos.entry_price > 0 && pos.size_usd > 0);
    let index = (kani::any::<i8>() % 3) as i128 * (FUNDING_SCALE / 4);
    if is_long { m.cumulative_long_funding = index } else { m.cumulative_short_funding = index }
    let (worse, better) = (nibble(), nibble());
    if is_long {
        kani::assume(worse <= better);
    } else {
        kani::assume(worse >= better);
    }
    let size = pos.size_usd;
    let at_worse = settle(&pos, &m, size, worse).unwrap();
    let at_better = settle(&pos, &m, size, better).unwrap();
    assert!(at_worse.equity_usd <= at_better.equity_usd);
}
