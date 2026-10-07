//! Side tracking: the moment sums and funding sums a market keeps over its
//! open positions, the average entry recomputed from them, how a close takes
//! a position off its side, and the bound on a side's winners that the
//! haircut divides by.
//!
//! These are the functions `orders.rs` and `settlement.rs` stub out. Each
//! stub there is justified by a contract proven here: `retrack`,
//! `retrack_funding` and `side_avg_from_moments` never fail or panic and
//! keep the sums equal to a recomputation; `close_side` takes exactly the
//! closed size off its side and leaves the sums of an untracked position
//! alone; and the winners bound is reached only for a side its sums track in
//! full, where it is never below what the winners hold.
//!
//! The bounds: sizes, entries and prices are 0 to 255, or 0 to 15 where a
//! harness puts two positions on a side or takes a square root. Sums the
//! harness does not build itself are any value their type holds.
//!
//! `mul_div_u128` is stubbed by `mul_div_u128_when_it_fits`, which computes
//! the same floor on the path where the product fits in 128 bits and fails
//! the harness if it is ever called on the other path. With these bounds
//! every product fits, so the stand-in returns what the real function does.
//! The real one carries a 128-step long division for the wide path, which
//! the model checker unwinds over symbolic values even where it is never
//! taken.

use super::kit::*;
use crate::constants::*;
use crate::math::position_pnl_usd;
use crate::state::market::{isqrt_ceil, moment_terms, MOMENT_Q_STEP, MOMENT_U_SCALE};
use crate::state::*;

fn mul_div_u128_when_it_fits(a: u128, b: u128, d: u128) -> anchor_lang::Result<u128> {
    if d == 0 {
        return Err(cheap_error(crate::errors::PerpError::MathOverflow));
    }
    let p = a.checked_mul(b);
    kani::assert(p.is_some(), "every product here fits in 128 bits");
    Ok(p.unwrap() / d)
}

/// Stands in for `isqrt_ceil` by its contract, which
/// `isqrt_ceil_is_the_smallest_root` proves for every x below 2^16: the
/// result is the smallest r with r * r >= x. The stand-in fails the harness
/// if it is called with a larger x, so it never answers outside what was
/// proven. It replaces a Newton loop the checker would unwind over symbolic
/// values.
fn isqrt_ceil_by_contract(x: u128) -> u128 {
    kani::assert(x < 1u128 << 16, "isqrt_ceil is proven below 2^16");
    let r = kani::any::<u16>() as u128 + kani::any::<bool>() as u128;
    kani::assume(r * r >= x && (r == 0 || (r - 1) * (r - 1) < x));
    r
}

fn winners_bound_unreached(_: u128, _: u128, _: u128, _: u128, _: bool) -> Option<u64> {
    kani::assert(false, "the moment bound is reached only for a fully tracked side");
    None
}

fn any_moments() -> SideMoments {
    SideMoments { tracked_usd: kani::any(), inv_entry: kani::any(), inv_entry_sq: kani::any() }
}

/// A size and an entry from 1 to 15. Each moment term is three 128-bit
/// divisions by the entry, and a harness that takes two terms at eight bits
/// does not finish in ten minutes.
fn term() -> (u64, u64) {
    let (s, e) = (nibble(), nibble());
    kani::assume(s > 0 && e > 0);
    (s, e)
}

fn moments(m: &Market, is_long: bool) -> SideMoments {
    if is_long { m.long_moments } else { m.short_moments }
}

fn funding(m: &Market, is_long: bool) -> SideFunding {
    if is_long { m.long_funding } else { m.short_funding }
}

// ---------------------------------------------------------------- moments

/// One position's moment terms are `size / entry` rounded down and
/// `size / entry^2` rounded up, each at its fixed point, and are refused only
/// for a zero entry. Rounded that way, `inv_entry` never overstates the
/// side's units and `inv_entry_sq` never understates its second moment,
/// which is the direction the winners bound needs. Size and entry 0 to 15.
#[kani::proof]
#[kani::solver(cadical)]
fn moment_terms_round_the_way_the_bound_needs() {
    let (s, e) = (nibble(), nibble());
    let terms = moment_terms(s, e);
    if e == 0 {
        assert!(terms.is_none());
        return;
    }
    let (u, q) = terms.unwrap();
    let (s, e) = (s as u128, e as u128);
    assert!(u * e <= s * MOMENT_U_SCALE && s * MOMENT_U_SCALE < (u + 1) * e);
    assert!(q * e * e >= s * MOMENT_Q_STEP * MOMENT_Q_STEP);
    kani::cover!(s > 0 && s * MOMENT_U_SCALE % e != 0, "a term that rounds");
}

/// Putting a position's term into a side's sums and taking it out again
/// leaves the sums exactly as they were, whatever they held: every write
/// replaces one whole term, so the sums stay equal to a fresh recomputation
/// over the positions they track. A term that does not fit goes in not at
/// all and says so. Any sums at full width, size and entry 1 to 15.
#[kani::proof]
#[kani::solver(cadical)]
fn a_moment_term_put_in_and_taken_out_leaves_the_sums_as_they_were() {
    let mut m = blank_market();
    let is_long: bool = kani::any();
    let before = any_moments();
    if is_long { m.long_moments = before } else { m.short_moments = before }
    let (s, e) = term();

    let added = m.retrack(is_long, None, s, e);
    if !added {
        assert!(moments(&m, is_long) == before);
        return;
    }
    let mid = moments(&m, is_long);
    assert!(mid.tracked_usd == before.tracked_usd + s);
    assert!(!m.retrack(is_long, Some((s, e)), 0, e));
    assert!(moments(&m, is_long) == before);
    // The other side is never touched.
    assert!(moments(&m, !is_long) == SideMoments::default());
    kani::cover!(true, "a term goes in and comes out");
}

/// Replacing a tracked term takes out exactly the old term and puts in
/// exactly the new one, and reports whether the new one went in. A size of
/// zero puts nothing in, which is how a full close leaves the sums. Sums
/// that held the old term (as they do for a tracked position) at full width,
/// sizes and entries 0 to 7: the harness takes four moment terms.
#[kani::proof]
#[kani::solver(cadical)]
fn a_retrack_replaces_one_term_exactly() {
    let mut m = blank_market();
    let is_long: bool = kani::any();
    let (os, oe) = (nibble() & 7, nibble() & 7);
    kani::assume(os > 0 && oe > 0);
    let (ou, oq) = moment_terms(os, oe).unwrap();
    let before = any_moments();
    kani::assume(before.tracked_usd >= os && before.inv_entry >= ou && before.inv_entry_sq >= oq);
    if is_long { m.long_moments = before } else { m.short_moments = before }
    let ns = nibble() & 7;
    let ne = nibble() & 7;
    kani::assume(ne > 0);

    let added = m.retrack(is_long, Some((os, oe)), ns, ne);
    let after = moments(&m, is_long);
    if ns == 0 {
        assert!(!added);
    }
    if added {
        let (nu, nq) = moment_terms(ns, ne).unwrap();
        assert!(after.tracked_usd == before.tracked_usd - os + ns);
        assert!(after.inv_entry == before.inv_entry - ou + nu);
        assert!(after.inv_entry_sq == before.inv_entry_sq - oq + nq);
    } else {
        assert!(after.tracked_usd == before.tracked_usd - os);
        assert!(after.inv_entry == before.inv_entry - ou);
        assert!(after.inv_entry_sq == before.inv_entry_sq - oq);
    }
    kani::cover!(added, "the new term goes in");
    kani::cover!(!added && ns > 0, "the new term does not fit");
}

/// `retrack` never fails or panics, whatever the sums, the old term and the
/// new one: its arithmetic saturates or is checked, and it divides only by
/// an entry it has checked is not zero. This is what lets `orders.rs`
/// replace it with a stand-in that returns any answer. Every input at full
/// width but the entries, which are 0 to 2^16 so the divisions finish.
#[kani::proof]
#[kani::solver(cadical)]
fn retrack_never_fails_or_panics() {
    let mut m = blank_market();
    let is_long: bool = kani::any();
    m.long_moments = any_moments();
    m.short_moments = any_moments();
    let old: Option<(u64, u64)> = if kani::any() {
        Some((kani::any(), kani::any::<u16>() as u64))
    } else {
        None
    };
    let added = m.retrack(is_long, old, kani::any(), kani::any::<u16>() as u64);
    kani::cover!(added, "a term goes in");
}

// ---------------------------------------------------------------- funding sums

fn any_side_funding() -> SideFunding {
    SideFunding {
        tracked_usd: kani::any(),
        size_entry_funding: kani::any(),
        min_cover: kani::any(),
        worst_entry: kani::any(),
    }
}

/// A funding term with size, collateral and entry from 0 to 255 and an
/// entry funding index of any quarter-step from -127 to 127.
fn any_funding_term() -> FundingTerm {
    FundingTerm {
        size: byte(),
        entry_funding: kani::any::<i8>() as i128 * (FUNDING_SCALE / 4),
        collateral: byte(),
        entry: byte(),
    }
}

/// Putting a position's funding term into a side and taking it out again
/// leaves the side's tracked size and its `size * entry_funding` sum exactly
/// as they were, the two sums `funding_owed_usd` reads. A term that does not
/// fit goes in not at all. Any sums at full width.
#[kani::proof]
#[kani::solver(cadical)]
fn a_funding_term_put_in_and_taken_out_leaves_the_sums_as_they_were() {
    let mut m = blank_market();
    let is_long: bool = kani::any();
    let before = any_side_funding();
    if is_long { m.long_funding = before } else { m.short_funding = before }
    let t = any_funding_term();

    let added = m.retrack_funding(is_long, None, Some(t));
    let mid = funding(&m, is_long);
    if !added {
        assert!(mid == before);
        return;
    }
    assert!(t.size > 0 && t.entry > 0);
    assert!(mid.tracked_usd == before.tracked_usd + t.size);
    m.retrack_funding(is_long, Some((t.size, t.entry_funding)), None);
    let after = funding(&m, is_long);
    assert!(after.tracked_usd == before.tracked_usd);
    assert!(after.size_entry_funding == before.size_entry_funding);
    kani::cover!(true, "a funding term goes in and comes out");
}

/// While a side tracks anything, its least cover and its worst entry only
/// move toward the worse value: a new term never raises `min_cover` and
/// never improves `worst_entry`, and both are at least as bad as the new
/// term's own. That is what lets the bad debt bound read one figure for
/// every tracked position. A side that tracks nothing starts again from the
/// new term. Any sums at full width; the new term's size and collateral 0 to
/// 15, its entry 0 to 255.
#[kani::proof]
#[kani::solver(cadical)]
fn min_cover_and_worst_entry_only_move_toward_the_worse_value() {
    let mut m = blank_market();
    let is_long: bool = kani::any();
    let before = any_side_funding();
    if is_long { m.long_funding = before } else { m.short_funding = before }
    let mut t = any_funding_term();
    t.size = nibble();
    t.collateral = nibble();

    if !m.retrack_funding(is_long, None, Some(t)) {
        return;
    }
    let after = funding(&m, is_long);
    let cover = t.cover().unwrap();
    if before.tracked_usd == 0 {
        assert!(after.min_cover == cover && after.worst_entry == t.entry);
    } else {
        assert!(after.min_cover <= before.min_cover && after.min_cover <= cover);
        if is_long {
            assert!(after.worst_entry >= before.worst_entry && after.worst_entry >= t.entry);
        } else {
            assert!(after.worst_entry <= before.worst_entry && after.worst_entry <= t.entry);
        }
    }
    kani::cover!(before.tracked_usd > 0 && cover < before.min_cover, "a worse cover lowers it");
}

/// `retrack_funding` never fails or panics, whatever the sums, the old term
/// and the new one: it saturates or wraps where it subtracts, and a cover
/// or a sum that does not fit leaves the term out. Every input at full width.
#[kani::proof]
#[kani::solver(cadical)]
fn retrack_funding_never_fails_or_panics() {
    let mut m = blank_market();
    let is_long: bool = kani::any();
    m.long_funding = any_side_funding();
    m.short_funding = any_side_funding();
    let old: Option<(u64, i128)> = if kani::any() { Some((kani::any(), kani::any())) } else { None };
    let new = if kani::any() {
        Some(FundingTerm {
            size: kani::any(),
            entry_funding: kani::any(),
            collateral: kani::any(),
            entry: kani::any(),
        })
    } else {
        None
    };
    let added = m.retrack_funding(is_long, old, new);
    kani::cover!(added, "a term goes in");
}

// ---------------------------------------------------------------- side average

/// `side_avg_from_moments` answers only for a side its sums track in full
/// (tracked size equal to open size, neither zero, units not zero), never
/// panics, and never answers zero. Any sizes and sums at full width.
#[kani::proof]
#[kani::solver(cadical)]
#[kani::stub(crate::math::mul_div_u128, mul_div_u128_when_it_fits)]
fn the_side_average_answers_only_for_a_fully_tracked_side() {
    let mut m = blank_market();
    let is_long: bool = kani::any();
    m.long_size_usd = kani::any();
    m.short_size_usd = kani::any();
    m.long_moments = any_moments();
    m.short_moments = any_moments();
    let (size, sums) = if is_long { (m.long_size_usd, m.long_moments) } else { (m.short_size_usd, m.short_moments) };

    let avg = m.side_avg_from_moments(is_long);
    if size == 0 || sums.tracked_usd != size || sums.inv_entry == 0 {
        assert!(avg.is_none());
    }
    if let Some(a) = avg {
        assert!(a > 0);
    }
    kani::cover!(avg.is_some(), "a tracked side has an average");
}

/// A side holding one tracked position averages at exactly that position's
/// entry. Size and entry 1 to 15.
#[kani::proof]
#[kani::solver(cadical)]
#[kani::stub(crate::math::mul_div_u128, mul_div_u128_when_it_fits)]
fn one_tracked_position_averages_at_its_entry() {
    let mut m = blank_market();
    let (s, e) = (nibble(), nibble());
    kani::assume(s > 0 && e > 0);
    m.long_size_usd = s;
    assert!(m.retrack(true, None, s, e));
    assert!(m.side_avg_from_moments(true) == Some(e));
}

/// A side holding two tracked positions averages between their entries:
/// never below the lower, never above the higher. Sizes and entries 1 to 15.
#[kani::proof]
#[kani::solver(cadical)]
#[kani::stub(crate::math::mul_div_u128, mul_div_u128_when_it_fits)]
fn two_tracked_positions_average_between_their_entries() {
    let mut m = blank_market();
    let is_long: bool = kani::any();
    let (s1, e1, s2, e2) = (nibble(), nibble(), nibble(), nibble());
    kani::assume(s1 > 0 && e1 > 0 && s2 > 0 && e2 > 0);
    assert!(m.retrack(is_long, None, s1, e1) && m.retrack(is_long, None, s2, e2));
    if is_long { m.long_size_usd = s1 + s2 } else { m.short_size_usd = s1 + s2 }

    let avg = m.side_avg_from_moments(is_long).unwrap();
    assert!(e1.min(e2) <= avg && avg <= e1.max(e2));
    kani::cover!(e1 != e2 && avg != e1 && avg != e2, "an average strictly between");
}

// ---------------------------------------------------------------- close_side

/// A position the market's sums do not track, written under today's price
/// factor: what every position in `settlement.rs` is.
fn untracked_position(is_long: bool) -> Position {
    let mut pos = blank_position(is_long);
    pos.size_usd = byte();
    pos.collateral_usd = byte();
    pos.entry_price = byte();
    kani::assume(pos.entry_price > 0);
    pos
}

/// `close_side` on a position the sums do not track takes exactly the closed
/// size off its side's open interest, saturating at zero, leaves every sum on
/// both sides and the other side's size alone, and never fails. That is the
/// whole of what `settlement.rs`'s stand-in `close_side_sizes_only` does,
/// which also leaves the average entry as any value. Sizes, averages and the
/// close 0 to 255; sums any value.
#[kani::proof]
#[kani::solver(cadical)]
#[kani::stub(crate::math::mul_div_u128, mul_div_u128_when_it_fits)]
#[kani::stub(PerpError::name, no_name)]
#[kani::stub(<PerpError as core::fmt::Display>::fmt, no_message)]
#[kani::stub(<anchor_lang::error::Error as core::convert::From<crate::errors::PerpError>>::from, cheap_error)]
fn close_side_takes_exactly_the_closed_size_off_an_untracked_side() {
    let mut m = blank_market();
    let is_long: bool = kani::any();
    m.long_size_usd = byte();
    m.short_size_usd = byte();
    m.long_avg_entry_price = byte();
    m.short_avg_entry_price = byte();
    m.long_moments = any_moments();
    m.short_moments = any_moments();
    m.long_funding = any_side_funding();
    m.short_funding = any_side_funding();
    let pos = untracked_position(is_long);
    let close = byte();
    let before = m.clone();

    assert!(m.close_side(is_long, &pos, close).is_ok());
    let (was, is, other_was, other_is) = if is_long {
        (before.long_size_usd, m.long_size_usd, before.short_size_usd, m.short_size_usd)
    } else {
        (before.short_size_usd, m.short_size_usd, before.long_size_usd, m.long_size_usd)
    };
    assert!(is == was.saturating_sub(close));
    assert!(other_is == other_was);
    assert!(m.long_moments == before.long_moments && m.short_moments == before.short_moments);
    assert!(m.long_funding == before.long_funding && m.short_funding == before.short_funding);
    kani::cover!(close > 0 && close < was, "a partial close");
}

use crate::errors::PerpError;

/// Closing a tracked position takes its own terms out of its side's sums:
/// all of them on a full close, and on a partial close it puts back the
/// size left at the same entry. The sums then hold exactly what the
/// positions still open put in. The position is the only one on its side,
/// size and entry 1 to 7, collateral 0 to 7. A close runs a dozen 128-bit
/// divisions by the entry and the average, which is what bounds it.
#[kani::proof]
#[kani::solver(cadical)]
#[kani::stub(crate::math::mul_div_u128, mul_div_u128_when_it_fits)]
#[kani::stub(PerpError::name, no_name)]
#[kani::stub(<PerpError as core::fmt::Display>::fmt, no_message)]
#[kani::stub(<anchor_lang::error::Error as core::convert::From<crate::errors::PerpError>>::from, cheap_error)]
fn closing_a_tracked_position_takes_its_own_terms_out() {
    let mut m = blank_market();
    let is_long: bool = kani::any();
    let (s, e) = (nibble() & 7, nibble() & 7);
    kani::assume(s > 0 && e > 0);
    let mut pos = blank_position(is_long);
    pos.size_usd = s;
    pos.entry_price = e;
    pos.collateral_usd = nibble() & 7;
    pos.q_epoch = m.q_tag();
    pos.f_epoch = m.q_tag();
    assert!(m.retrack(is_long, None, s, e));
    let ft = FundingTerm { size: s, entry_funding: 0, collateral: pos.collateral_usd, entry: e };
    assert!(m.retrack_funding(is_long, None, Some(ft)));
    if is_long { m.long_size_usd = s; m.long_avg_entry_price = e } else { m.short_size_usd = s; m.short_avg_entry_price = e }
    let close = nibble() & 7;
    kani::assume(close > 0 && close <= s);

    assert!(m.close_side(is_long, &pos, close).is_ok());
    let left = s - close;
    let sums = moments(&m, is_long);
    let fs = funding(&m, is_long);
    assert!(sums.tracked_usd == left && fs.tracked_usd == left);
    if left == 0 {
        assert!(sums == SideMoments::default());
        assert!(fs.size_entry_funding == 0);
    } else {
        let (u, q) = moment_terms(left, e).unwrap();
        assert!(sums.inv_entry == u && sums.inv_entry_sq == q);
        // And the side still averages at the one entry it holds.
        let avg = if is_long { m.long_avg_entry_price } else { m.short_avg_entry_price };
        assert!(avg == e);
    }
    kani::cover!(left > 0, "a partial close");
}

// ---------------------------------------------------------------- winners bound

/// The moment bound on a side's winners is reached only for a side whose
/// open size its sums track in full and which is not empty. An empty side
/// counts zero, and a side its sums do not track (as in `settlement.rs`,
/// where every position is untracked) counts at its net profit from its
/// size and average entry. So the stand-in `winners_bound_unreached` is
/// sound: it fails the harness if it is ever called, and here it never is.
/// Sizes and prices any value; sums any value but the tracked size.
#[kani::proof]
#[kani::solver(cadical)]
#[kani::stub(crate::state::market::winners_bound, winners_bound_unreached)]
#[kani::stub(PerpError::name, no_name)]
#[kani::stub(<PerpError as core::fmt::Display>::fmt, no_message)]
#[kani::stub(<anchor_lang::error::Error as core::convert::From<crate::errors::PerpError>>::from, cheap_error)]
fn the_winners_bound_is_reached_only_for_a_fully_tracked_side() {
    let mut m = blank_market();
    let is_long: bool = kani::any();
    let size = byte();
    let entry = byte();
    let mut sums = any_moments();
    kani::assume(size == 0 || sums.tracked_usd != size);
    if size == 0 {
        sums.tracked_usd = 0;
    }
    if is_long {
        m.long_size_usd = size;
        m.long_avg_entry_price = entry;
        m.long_moments = sums;
    } else {
        m.short_size_usd = size;
        m.short_avg_entry_price = entry;
        m.short_moments = sums;
    }
    let price = byte();

    let bound = m.side_winners_bound_usd(is_long, price);
    if size == 0 {
        assert!(bound == Some(0));
        assert!(m.side_winners_usd(is_long, price).unwrap() == 0);
    } else {
        assert!(bound.is_none());
        if entry > 0 {
            let net = position_pnl_usd(is_long, size, entry, price).unwrap().max(0) as u64;
            assert!(m.side_winners_usd(is_long, price).unwrap() == net);
        }
    }
    kani::cover!(size > 0 && entry > 0, "an untracked side counts its net profit");
}

/// `isqrt_ceil` is the smallest r with r * r >= x. Every x below 2^16,
/// which covers every square root the winners bound takes in the harnesses
/// below.
#[kani::proof]
#[kani::unwind(12)]
#[kani::solver(cadical)]
fn isqrt_ceil_is_the_smallest_root() {
    let x = kani::any::<u16>() as u128;
    let r = isqrt_ceil(x);
    assert!(r * r >= x);
    if r > 0 {
        assert!((r - 1) * (r - 1) < x);
    }
}

/// Puts one tracked position on `is_long`'s side.
fn track(m: &mut Market, is_long: bool, s: u64, e: u64) {
    assert!(m.retrack(is_long, None, s, e));
    if is_long { m.long_size_usd += s } else { m.short_size_usd += s }
}

fn profit(is_long: bool, s: u64, e: u64, p: u64) -> u64 {
    position_pnl_usd(is_long, s, e, p).unwrap().max(0) as u64
}

/// The bound on a side's winners is never below the profit its one tracked
/// position holds, at any price, and at most four units above it: the
/// bound is exact in real numbers when every entry on a side is the same,
/// and only its rounding, always up, separates it from the profit. So the
/// haircut never pays a winner more than its fair share. Size, entry and
/// price 1 to 15.
#[kani::proof]
#[kani::stub(crate::state::market::isqrt_ceil, isqrt_ceil_by_contract)]
#[kani::solver(cadical)]
#[kani::stub(crate::math::mul_div_u128, mul_div_u128_when_it_fits)]
#[kani::stub(PerpError::name, no_name)]
#[kani::stub(<PerpError as core::fmt::Display>::fmt, no_message)]
#[kani::stub(<anchor_lang::error::Error as core::convert::From<crate::errors::PerpError>>::from, cheap_error)]
fn the_winners_bound_covers_one_tracked_position() {
    let mut m = blank_market();
    let is_long: bool = kani::any();
    let (s, e, p) = (nibble(), nibble(), nibble());
    kani::assume(s > 0 && e > 0 && p > 0);
    track(&mut m, is_long, s, e);

    let bound = m.side_winners_bound_usd(is_long, p).unwrap();
    let w = profit(is_long, s, e, p);
    assert!(bound >= w);
    // Every piece rounds up, which at these sizes adds at most four units
    // (a flat position of 9 at 7 bounds at 4).
    assert!(bound <= w + 4);
    kani::cover!(w > 0, "a winner");
}

/// The bound on a side's winners is never below what its winners hold
/// gross, at any price, with two tracked positions at different entries: a
/// winner beside a loser on the same side is still counted in full. This is
/// the haircut's bound for tracked sides, which `settlement.rs` does not
/// reach. Sizes, entries and price 1 to 7.
#[kani::proof]
#[kani::stub(crate::state::market::isqrt_ceil, isqrt_ceil_by_contract)]
#[kani::solver(cadical)]
#[kani::stub(crate::math::mul_div_u128, mul_div_u128_when_it_fits)]
#[kani::stub(PerpError::name, no_name)]
#[kani::stub(<PerpError as core::fmt::Display>::fmt, no_message)]
#[kani::stub(<anchor_lang::error::Error as core::convert::From<crate::errors::PerpError>>::from, cheap_error)]
fn the_winners_bound_covers_two_tracked_positions() {
    let mut m = blank_market();
    let is_long: bool = kani::any();
    let (s1, e1, s2, e2, p) = (nibble() & 7, nibble() & 7, nibble() & 7, nibble() & 7, nibble() & 7);
    kani::assume(s1 > 0 && e1 > 0 && s2 > 0 && e2 > 0 && p > 0);
    track(&mut m, is_long, s1, e1);
    track(&mut m, is_long, s2, e2);

    let bound = m.side_winners_bound_usd(is_long, p).unwrap();
    assert!(bound >= profit(is_long, s1, e1, p) + profit(is_long, s2, e2, p));
    kani::cover!(
        profit(is_long, s1, e1, p) > 0 && position_pnl_usd(is_long, s2, e2, p).unwrap() < 0,
        "a winner beside a loser"
    );
}
