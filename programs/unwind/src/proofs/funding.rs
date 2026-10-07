//! Funding: `Market::accrue_funding` and what positions owe on the indices
//! it writes. Two legs fold into one index per side: borrow, which both
//! sides pay the pool, and skew funding, which the heavier side pays the
//! lighter one on a linear curve in the skew, capped per hour
//! (docs/funding.md).
//!
//! The bounds: the funding sensitivity `funding_k_bps` and the hourly cap
//! are any value their u16 holds in every harness, so every curve and every
//! cap is covered. The borrow rate is any u16 or up to 255 bps an hour, as
//! each harness says, and utilization any value up to 100 percent. Books
//! (the long and short open interest) are either concrete, from `BOOKS`, or
//! symbolic from 1 to 15, and elapsed time is either symbolic, an hour, or
//! the 8 hour accrual window. Each accrual is half a dozen 128-bit
//! divisions, which the model checker encodes in full whatever the values,
//! so a harness runs at most four accruals, and each says which books and
//! times it takes.
//! `budget.rs` holds the two older funding harnesses.

use super::kit::*;
use crate::constants::*;
use crate::errors::PerpError;
use crate::math::funding_owed_usd;
use crate::state::Market;

/// Long heavy with a ratio that does not divide, short heavy, a one-unit
/// light side against a large heavy one, and sizes near the top of a u64.
const BOOKS: [(u64, u64); 4] = [(7, 3), (3, 7), (1_000_000, 1), (u64::MAX / 2, u64::MAX / 3)];

fn book(long: u64, short: u64) -> Market {
    let mut m = blank_market();
    m.long_size_usd = long;
    m.short_size_usd = short;
    m.funding_k_bps = kani::any();
    m.max_funding_rate_bps_per_hour = kani::any();
    m
}

/// A book with both sides 1 to 15.
fn small_book() -> Market {
    let (l, s) = (nibble(), nibble());
    kani::assume(l > 0 && s > 0);
    book(l, s)
}

fn any_utilization() -> u16 {
    let u: u16 = kani::any();
    kani::assume(u as u128 <= BPS);
    u
}

fn heavy_index(m: &Market) -> i128 {
    if m.long_size_usd >= m.short_size_usd { m.cumulative_long_funding } else { m.cumulative_short_funding }
}

/// The heavy side's index never falls: on every book, whatever the curve,
/// the cap, the borrow rate, the utilization and the time, the side holding
/// more open interest only ever pays. Every book in `BOOKS` over the 8 hour
/// window, any borrow rate.
#[kani::proof]
#[kani::solver(cadical)]
#[kani::stub(PerpError::name, no_name)]
#[kani::stub(<PerpError as core::fmt::Display>::fmt, no_message)]
#[kani::stub(<anchor_lang::error::Error as core::convert::From<crate::errors::PerpError>>::from, cheap_error)]
fn the_heavy_side_index_never_falls() {
    for (long, short) in BOOKS {
        let mut m = book(long, short);
        m.borrow_rate_bps_per_hour = kani::any();
        m.accrue_funding(MAX_FUNDING_ACCRUAL_SECONDS, any_utilization()).unwrap();
        assert!(heavy_index(&m) >= 0);
    }
}

/// Skew funding mints nothing on any small book: what the light side is
/// credited across its whole size is at most what the heavy side is charged
/// across its own, short of it by less than one index unit per dollar of the
/// light side. The older harness proves this on six concrete books at five
/// times; this one takes every book with sides 1 to 15, over an hour, borrow
/// off.
#[kani::proof]
#[kani::solver(cadical)]
#[kani::stub(PerpError::name, no_name)]
#[kani::stub(<PerpError as core::fmt::Display>::fmt, no_message)]
#[kani::stub(<anchor_lang::error::Error as core::convert::From<crate::errors::PerpError>>::from, cheap_error)]
fn the_light_side_is_never_credited_more_than_the_heavy_side_pays() {
    let mut m = small_book();
    m.accrue_funding(SECONDS_PER_HOUR, 0).unwrap();
    let (l, s) = (m.long_size_usd as i128, m.short_size_usd as i128);
    let net = m.cumulative_long_funding * l + m.cumulative_short_funding * s;
    assert!(net >= 0);
    assert!(net < l.min(s));
    kani::cover!(m.cumulative_long_funding != 0 && l != s, "skew funding is paid");
}

/// The borrow leg is the same non-negative charge on both sides, and adds to
/// the skew leg without changing it: a market accrued with borrow differs
/// from the same market accrued without it by the same amount on each side,
/// never negative and never more than the borrow rate for the 8 hours.
/// Long heavy and short heavy books over the 8 hour window on the site
/// listing's curve (docs/funding.md: `funding_k` 100 bps, cap 100 bps an
/// hour), any borrow rate and utilization. The curve is held to one value
/// because comparing two accruals bit for bit is an equivalence of two
/// dividers, which the solver does not finish for symbolic rates.
#[kani::proof]
#[kani::solver(cadical)]
#[kani::stub(PerpError::name, no_name)]
#[kani::stub(<PerpError as core::fmt::Display>::fmt, no_message)]
#[kani::stub(<anchor_lang::error::Error as core::convert::From<crate::errors::PerpError>>::from, cheap_error)]
fn the_borrow_leg_is_one_non_negative_charge_on_both_sides() {
    let now = MAX_FUNDING_ACCRUAL_SECONDS;
    for (long, short) in [(7u64, 3u64), (3, 7)] {
        let mut without = blank_market();
        without.long_size_usd = long;
        without.short_size_usd = short;
        without.funding_k_bps = 100;
        without.max_funding_rate_bps_per_hour = 100;
        let mut with = without.clone();
        with.borrow_rate_bps_per_hour = kani::any();
        let util = any_utilization();
        with.accrue_funding(now, util).unwrap();
        without.accrue_funding(now, 0).unwrap();

        let on_long = with.cumulative_long_funding - without.cumulative_long_funding;
        let on_short = with.cumulative_short_funding - without.cumulative_short_funding;
        assert!(on_long == on_short);
        assert!(on_long >= 0);
        assert!(on_long <= with.borrow_rate_bps_per_hour as i128 * (FUNDING_SCALE / BPS as i128) * 8);
    }
}

/// Elapsed time is clamped: one accrual, from any last time to any now,
/// charges the heavy side at most the cap and the borrow rate for 8 hours
/// and the light side at most the borrow for 8 hours, and records `now` as
/// the last accrual whichever way the clock moved. So a clock gap cannot
/// wipe positions out in one step. Any times at full width, borrow up to
/// 255 bps an hour, any utilization, on a long-heavy book that does not
/// divide evenly and the site listing's curve (`funding_k` 100 bps, cap 100
/// bps an hour): a symbolic time times a symbolic curve is a product of
/// three unknowns, which the solver does not finish.
#[kani::proof]
#[kani::solver(cadical)]
#[kani::stub(PerpError::name, no_name)]
#[kani::stub(<PerpError as core::fmt::Display>::fmt, no_message)]
#[kani::stub(<anchor_lang::error::Error as core::convert::From<crate::errors::PerpError>>::from, cheap_error)]
fn elapsed_time_is_clamped_to_the_accrual_window() {
    let mut m = book(7, 3);
    m.funding_k_bps = 100;
    m.max_funding_rate_bps_per_hour = 100;
    m.borrow_rate_bps_per_hour = kani::any::<u8>() as u16;
    let (last, now): (i64, i64) = (kani::any(), kani::any());
    m.last_funding_ts = last;

    m.accrue_funding(now, any_utilization()).unwrap();
    let per_bps = FUNDING_SCALE / BPS as i128;
    let hours = (MAX_FUNDING_ACCRUAL_SECONDS / SECONDS_PER_HOUR) as i128;
    let cap = m.max_funding_rate_bps_per_hour as i128;
    let borrow = m.borrow_rate_bps_per_hour as i128;
    assert!(m.last_funding_ts == now);
    assert!(m.cumulative_long_funding <= (cap + borrow) * per_bps * hours);
    assert!(m.cumulative_short_funding <= borrow * per_bps * hours);
    kani::cover!(now.saturating_sub(last) > MAX_FUNDING_ACCRUAL_SECONDS, "a gap the cap clamps");
}

/// A clock that stands still or runs back accrues nothing on either side,
/// whatever the rates and the indices. A long-heavy book; rates, indices,
/// times and utilization any value. (The checker encodes the accrual path
/// even where it is never taken, and over a symbolic book that alone does
/// not finish.)
#[kani::proof]
#[kani::solver(cadical)]
#[kani::stub(PerpError::name, no_name)]
#[kani::stub(<PerpError as core::fmt::Display>::fmt, no_message)]
#[kani::stub(<anchor_lang::error::Error as core::convert::From<crate::errors::PerpError>>::from, cheap_error)]
fn a_clock_that_stands_still_or_runs_back_accrues_nothing() {
    let mut m = book(7, 3);
    m.borrow_rate_bps_per_hour = kani::any();
    m.cumulative_long_funding = kani::any();
    m.cumulative_short_funding = kani::any();
    m.last_funding_ts = kani::any();
    let now: i64 = kani::any();
    kani::assume(now <= m.last_funding_ts);
    let before = m.clone();

    assert!(m.accrue_funding(now, kani::any()).is_ok());
    assert!(m.cumulative_long_funding == before.cumulative_long_funding);
    assert!(m.cumulative_short_funding == before.cumulative_short_funding);
    assert!(m.last_funding_ts == now);
}

/// A second accrual at the same time changes nothing, so a crank that runs
/// twice in one second charges once. Every book in `BOOKS`, any curve and
/// borrow, any time, any index below 2^63.
#[kani::proof]
#[kani::solver(cadical)]
#[kani::stub(PerpError::name, no_name)]
#[kani::stub(<PerpError as core::fmt::Display>::fmt, no_message)]
#[kani::stub(<anchor_lang::error::Error as core::convert::From<crate::errors::PerpError>>::from, cheap_error)]
fn a_second_accrual_at_the_same_time_changes_nothing() {
    for (long, short) in BOOKS {
        let mut m = book(long, short);
        m.borrow_rate_bps_per_hour = kani::any();
        m.cumulative_long_funding = kani::any::<i64>() as i128;
        m.cumulative_short_funding = kani::any::<i64>() as i128;
        m.last_funding_ts = kani::any();
        let now: i64 = kani::any();
        if m.accrue_funding(now, any_utilization()).is_err() {
            continue;
        }
        let once = m.clone();
        m.accrue_funding(now, kani::any()).unwrap();
        assert!(m.cumulative_long_funding == once.cumulative_long_funding);
        assert!(m.cumulative_short_funding == once.cumulative_short_funding);
    }
}

/// Over one hour the heavy side pays the documented linear curve:
/// `min(funding_k_bps * skew, max_funding_rate)` bps, with skew
/// `(heavy - light) / (heavy + light)` in whole bps and the product in whole
/// bps an hour, both rounded down (docs/funding.md). Stated without a
/// division: the charge is at most the cap, at most `funding_k_bps * skew`,
/// and within one bp of it unless the cap binds. A long-heavy book whose
/// ratio does not divide, any curve and cap, borrow off.
#[kani::proof]
#[kani::solver(cadical)]
#[kani::stub(PerpError::name, no_name)]
#[kani::stub(<PerpError as core::fmt::Display>::fmt, no_message)]
#[kani::stub(<anchor_lang::error::Error as core::convert::From<crate::errors::PerpError>>::from, cheap_error)]
fn the_skew_rate_is_the_linear_curve_up_to_its_cap() {
    let mut m = book(7, 3);
    m.accrue_funding(SECONDS_PER_HOUR, 0).unwrap();
    // (7 - 3) / (7 + 3) is 4,000 bps.
    let skew_bps = 4_000i128;
    let per_bps = FUNDING_SCALE / BPS as i128;
    let bps = BPS as i128;
    let paid = m.cumulative_long_funding;
    let (k, cap) = (m.funding_k_bps as i128, m.max_funding_rate_bps_per_hour as i128);
    assert!(paid >= 0 && paid <= cap * per_bps);
    assert!(paid * bps <= k * skew_bps * per_bps);
    assert!(paid == cap * per_bps || (paid + per_bps) * bps > k * skew_bps * per_bps);
    kani::cover!(paid > 0 && paid == cap * per_bps, "the cap binds");
    kani::cover!(paid > 0 && paid < cap * per_bps, "the curve binds");
}

/// More skew never lowers the rate: against the same light side, a heavier
/// heavy side pays at least as much per dollar. Two pairs of books (3
/// against 4 and 7; 1,000 against 1,001 and 5,000), any curve and cap,
/// over an hour, borrow off.
#[kani::proof]
#[kani::solver(cadical)]
#[kani::stub(PerpError::name, no_name)]
#[kani::stub(<PerpError as core::fmt::Display>::fmt, no_message)]
#[kani::stub(<anchor_lang::error::Error as core::convert::From<crate::errors::PerpError>>::from, cheap_error)]
fn more_skew_never_lowers_the_rate() {
    for (light, less, more) in [(3u64, 4u64, 7u64), (1_000, 1_001, 5_000)] {
        let mut a = book(less, light);
        let mut b = a.clone();
        b.long_size_usd = more;
        a.accrue_funding(SECONDS_PER_HOUR, 0).unwrap();
        b.accrue_funding(SECONDS_PER_HOUR, 0).unwrap();
        assert!(b.cumulative_long_funding >= a.cumulative_long_funding);
    }
}

/// A book with one side empty, or both sides equal, pays no skew funding:
/// with nobody to receive or no imbalance to correct, both sides are charged
/// the same borrow and nothing else, never negative and never more than the
/// borrow rate for the 8 hour window. A one-sided book at full width, a
/// balanced one up to 15 a side; any curve, borrow up to 255 bps an hour,
/// any time.
#[kani::proof]
#[kani::solver(cadical)]
#[kani::stub(PerpError::name, no_name)]
#[kani::stub(<PerpError as core::fmt::Display>::fmt, no_message)]
#[kani::stub(<anchor_lang::error::Error as core::convert::From<crate::errors::PerpError>>::from, cheap_error)]
fn a_one_sided_or_balanced_book_pays_no_skew_funding() {
    let mut m = blank_market();
    let size: u64 = kani::any();
    match kani::any::<u8>() % 3 {
        0 => m.long_size_usd = size,
        1 => m.short_size_usd = size,
        _ => {
            // Balanced: the skew is computed, and divided by the book.
            m.long_size_usd = size & 0x0f;
            m.short_size_usd = size & 0x0f;
        }
    }
    m.funding_k_bps = kani::any();
    m.max_funding_rate_bps_per_hour = kani::any();
    m.borrow_rate_bps_per_hour = kani::any::<u8>() as u16;

    m.accrue_funding(kani::any(), any_utilization()).unwrap();
    let window = m.borrow_rate_bps_per_hour as i128 * (FUNDING_SCALE / BPS as i128) * 8;
    assert!(m.cumulative_long_funding == m.cumulative_short_funding);
    assert!(m.cumulative_long_funding >= 0 && m.cumulative_long_funding <= window);
}

/// Accrual never fails on any of the books: every product fits in 128 bits
/// for any curve, any borrow rate and any time, so only an index already
/// within 2^126 of the i128 limit could overflow, and the crank cannot be
/// stopped by the book it charges. A one-unit light side against a large
/// heavy one, and sizes near the top of a u64; rates, utilization and the
/// clock any value.
#[kani::proof]
#[kani::solver(cadical)]
#[kani::stub(PerpError::name, no_name)]
#[kani::stub(<PerpError as core::fmt::Display>::fmt, no_message)]
#[kani::stub(<anchor_lang::error::Error as core::convert::From<crate::errors::PerpError>>::from, cheap_error)]
fn accrual_never_fails_on_any_book() {
    for (long, short) in [BOOKS[2], BOOKS[3]] {
        let mut m = book(long, short);
        m.borrow_rate_bps_per_hour = kani::any();
        m.cumulative_long_funding = kani::any();
        m.cumulative_short_funding = kani::any();
        m.last_funding_ts = kani::any();
        let limit = 1u128 << 126;
        kani::assume(m.cumulative_long_funding.unsigned_abs() < limit);
        kani::assume(m.cumulative_short_funding.unsigned_abs() < limit);
        assert!(m.accrue_funding(kani::any(), any_utilization()).is_ok());
    }
}

/// Cranking more often never charges the heavy side more: two accruals that
/// split a window charge it at most what one accrual over the whole window
/// does, because each rounds down. A long-heavy book whose ratio does not
/// divide, `funding_k` and the cap up to 255 bps, borrow off, an hour split
/// after its first second.
#[kani::proof]
#[kani::solver(cadical)]
#[kani::stub(PerpError::name, no_name)]
#[kani::stub(<PerpError as core::fmt::Display>::fmt, no_message)]
#[kani::stub(<anchor_lang::error::Error as core::convert::From<crate::errors::PerpError>>::from, cheap_error)]
fn cranking_more_often_never_charges_the_heavy_side_more() {
    for (t1, t2) in [(1i64, SECONDS_PER_HOUR - 1)] {
        let mut split = book(7, 3);
        split.funding_k_bps = kani::any::<u8>() as u16;
        split.max_funding_rate_bps_per_hour = kani::any::<u8>() as u16;
        let mut whole = split.clone();
        split.accrue_funding(t1, 0).unwrap();
        split.accrue_funding(t1 + t2, 0).unwrap();
        whole.accrue_funding(t1 + t2, 0).unwrap();
        assert!(heavy_index(&split) <= heavy_index(&whole));
    }
}

/// Positions settling funding never mint: after any accrual, a long and a
/// short holding each whole side owe, between them, at least zero. The
/// receiving side's credit is rounded toward zero, and the paying side's
/// charge is not rounded in its favour. Long heavy and short heavy books
/// over the 8 hour window, any curve, borrow off.
#[kani::proof]
#[kani::solver(cadical)]
#[kani::stub(PerpError::name, no_name)]
#[kani::stub(<PerpError as core::fmt::Display>::fmt, no_message)]
#[kani::stub(<anchor_lang::error::Error as core::convert::From<crate::errors::PerpError>>::from, cheap_error)]
fn positions_settling_funding_never_mint() {
    for (long, short) in [(7u64, 3u64), (3, 7)] {
        let mut m = book(long, short);
        m.accrue_funding(MAX_FUNDING_ACCRUAL_SECONDS, 0).unwrap();
        let l = funding_owed_usd(long, 0, m.cumulative_long_funding).unwrap();
        let s = funding_owed_usd(short, 0, m.cumulative_short_funding).unwrap();
        assert!(l as i128 + s as i128 >= 0);
    }
}

/// A position owes nothing for funding before it existed, and otherwise
/// owes exactly the index move times its size, rounded toward zero: a
/// charge is rounded down and a credit is rounded down in size, so neither
/// side is paid a fraction of a unit it did not earn. Size 0 to 255, index
/// readings any i16 multiple of 10^-4 of a unit, so up to about 1,700 units
/// owed either way, with every remainder.
#[kani::proof]
#[kani::solver(cadical)]
#[kani::stub(<anchor_lang::error::Error as core::convert::From<crate::errors::PerpError>>::from, cheap_error)]
fn funding_owed_starts_at_zero_and_is_the_index_move_rounded_toward_zero() {
    let size = byte();
    let step = FUNDING_SCALE / 10_000;
    let entry = kani::any::<i16>() as i128 * step;
    let now = kani::any::<i16>() as i128 * step;
    assert!(funding_owed_usd(size, entry, entry).unwrap() == 0);
    let owed = funding_owed_usd(size, entry, now).unwrap() as i128;
    let exact = (now - entry) * size as i128;
    if exact >= 0 {
        assert!(owed * FUNDING_SCALE <= exact && exact < (owed + 1) * FUNDING_SCALE);
    } else {
        assert!(owed * FUNDING_SCALE >= exact && exact > (owed - 1) * FUNDING_SCALE);
    }
    kani::cover!(owed < 0, "a credit");
    kani::cover!(owed > 0 && exact % FUNDING_SCALE != 0, "a charge that rounds");
}
