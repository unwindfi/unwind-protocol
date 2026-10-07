//! Smaller pieces around a position and the pool's value: close triggers,
//! which order may close which position, the withdrawal cooldown,
//! utilization, the in-kind AUM and the AUM drift a settlement books.
//! Corporate-action entry adjustment (`adjust_entry_price`) and the
//! size-weighted held clock (`Position::add_held`) did not finish in 15
//! minutes at 16 bits and are left to unit tests.
//!
//! The bounds: every input is any value its type holds unless a harness
//! says otherwise.

use super::kit::*;
use crate::aum::lp_owed_now;
use crate::constants::*;
use crate::errors::PerpError;
use crate::state::*;

/// A fired close trigger asks for what is still closable, never more, never
/// nothing, and never less than the minimum position unless that is all
/// that is left. Every input at full width.
#[kani::proof]
#[kani::solver(cadical)]
#[kani::stub(PerpError::name, no_name)]
#[kani::stub(<PerpError as core::fmt::Display>::fmt, no_message)]
fn a_trigger_closes_only_what_is_closable() {
    let mut pos = blank_position(kani::any());
    pos.size_usd = kani::any();
    pos.closing_usd = kani::any();
    kani::assume(pos.closing_usd <= pos.size_usd);
    let (requested, min): (u64, u64) = (kani::any(), kani::any());
    let closable = pos.closable_usd();

    match pos.trigger_close_size(requested, min) {
        Ok(size) => {
            assert!(size > 0 && size <= closable);
            assert!(size >= min || size == closable);
            if requested > 0 && requested <= closable {
                assert!(size == requested);
            }
        }
        Err(_) => assert!(closable == 0 || (requested > 0 && requested < closable && requested < min)),
    }
}

/// An order closes nothing on a position opened after its batch opened: a
/// position like that was opened by a settlement of the same batch, after a
/// liquidation emptied the one the order was placed against. Otherwise it
/// closes what `closable_by` allows. Every input at full width.
#[kani::proof]
fn an_order_never_closes_a_position_opened_after_its_batch() {
    let mut pos = blank_position(kani::any());
    pos.size_usd = kani::any();
    pos.open_ts = kani::any();
    let (is_bid, filled, opened): (bool, u64, i64) = (kani::any(), kani::any(), kani::any());
    let take = pos.closable_in(is_bid, filled, opened);
    if pos.open_ts > opened {
        assert!(take == 0);
    } else {
        assert!(take == pos.closable_by(is_bid, filled));
    }
}

/// Escrowing shares restarts the cooldown for every share in the request:
/// none can be claimed before `WITHDRAW_COOLDOWN_SLOTS` after the latest
/// escrow, and all can after. Every input at full width.
#[kani::proof]
#[kani::stub(PerpError::name, no_name)]
#[kani::stub(<PerpError as core::fmt::Display>::fmt, no_message)]
#[kani::stub(<anchor_lang::error::Error as core::convert::From<crate::errors::PerpError>>::from, cheap_error)]
fn escrowing_more_restarts_the_cooldown_for_everything() {
    let mut r = WithdrawRequest {
        bump: 0,
        escrow_bump: 0,
        pool: Default::default(),
        owner: Default::default(),
        shares: kani::any(),
        request_slot: kani::any(),
        points_usd: kani::any(),
    };
    let (shares, points, slot): (u64, u64, u64) = (kani::any(), kani::any(), kani::any());
    let before = r.clone();
    if r.escrow(shares, points, slot).is_ok() {
        assert!(r.shares == before.shares + shares && r.points_usd == before.points_usd + points);
        assert!(r.request_slot == slot);
        let at: u64 = kani::any();
        assert!(r.is_ready(at) == (at >= slot.saturating_add(WITHDRAW_COOLDOWN_SLOTS)));
    }
}

/// A market's utilization is at most 100 percent, zero for a balanced book,
/// and full for an imbalanced one against a pool with no liquidity. Every
/// input at full width.
#[kani::proof]
#[kani::solver(cadical)]
fn utilization_is_zero_when_balanced_and_never_past_full() {
    let mut m = blank_market();
    m.long_size_usd = kani::any();
    m.short_size_usd = kani::any();
    let liquidity: u64 = kani::any();
    let u = m.utilization_bps(liquidity);
    assert!(u as u128 <= BPS);
    if m.long_size_usd == m.short_size_usd {
        assert!(u == 0);
    } else if liquidity == 0 {
        assert!(u as u128 == BPS);
    }
}

/// The LPs' value counts trader profit against USDC and in-kind tokens
/// together: it never rises as traders gain, never falls as tokens are
/// added, moves by exactly a change in either while it is above zero, and is
/// never below zero. Every input at full width.
#[kani::proof]
#[kani::solver(cadical)]
fn lp_value_counts_profit_against_usdc_and_tokens_together() {
    let mut p = blank_pool();
    p.liquidity_usd = kani::any();
    let (pnl, more_pnl): (i64, i64) = (kani::any(), kani::any());
    let (tokens, more_tokens): (u64, u64) = (kani::any(), kani::any());
    kani::assume(pnl <= more_pnl && tokens <= more_tokens);
    let base = p.aum_with_in_kind_usd(pnl, tokens);
    assert!(p.aum_with_in_kind_usd(more_pnl, tokens) <= base);
    assert!(p.aum_with_in_kind_usd(pnl, more_tokens) >= base);
    let exact = p.liquidity_usd as i128 + tokens as i128 - pnl as i128;
    if exact >= 0 && exact <= u64::MAX as i128 {
        assert!(base as i128 == exact);
    }
}

/// What a market owes the LPs, as the AUM drift measures it, is zero when
/// the market has no open interest or no price it has accepted. This is why
/// the booking harnesses in `orders.rs` may stub the moment and funding
/// sums: their markets have no last or risk price, so the only reader of
/// those sums in `book_open` reads nothing. Sizes and entries 0 to 15 (the
/// checker encodes the pricing path even where it is not taken), sums and
/// balances any value.
#[kani::proof]
#[kani::solver(cadical)]
#[kani::stub(PerpError::name, no_name)]
#[kani::stub(<PerpError as core::fmt::Display>::fmt, no_message)]
#[kani::stub(<anchor_lang::error::Error as core::convert::From<crate::errors::PerpError>>::from, cheap_error)]
fn the_drift_reads_nothing_without_a_price_or_open_interest() {
    let mut m = blank_market();
    m.long_size_usd = nibble();
    m.short_size_usd = nibble();
    m.long_avg_entry_price = nibble();
    m.short_avg_entry_price = nibble();
    m.collateral_usd = kani::any();
    m.loss_budget_usd = kani::any();
    m.net_loss_usd = kani::any();
    m.backing_usd = kani::any();
    m.long_moments = SideMoments { tracked_usd: kani::any(), inv_entry: kani::any(), inv_entry_sq: kani::any() };
    if kani::any() {
        m.last_price = 0;
        m.risk_price = 0;
    } else {
        m.last_price = kani::any();
        m.risk_price = kani::any();
        m.long_size_usd = 0;
        m.short_size_usd = 0;
    }
    assert!(lp_owed_now(&m).unwrap() == 0);
}
