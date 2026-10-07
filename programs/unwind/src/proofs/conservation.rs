//! Conservation of each pure money transition: fee cuts, backing draws,
//! restores and fees, backing share prices on the way in and out, LP claims and their escrow, and the pool's own payout, sweep and
//! lock. Each harness states that money moves between lines without being
//! created, or that a rounding goes against whoever acts.
//!
//! The bounds: where a harness only adds, subtracts or compares, every input
//! is any value its type holds. Where it divides by a symbolic value,
//! amounts are 0 to 15, or below 2^16 or 2^32 where the divisor is a
//! constant, as each harness says. Fees on their own are up to 2^10 and
//! balances up to 2^20, as in `settlement.rs`.
//!
//! A close that carries its own fee (`apply_settlement_to_pool` with a
//! nonzero fee) is not proven here: at fees to 15 and balances to 2^10 it
//! did not finish in 15 minutes. `settlement.rs` proves the fee-free close,
//! and the fee cuts are proven on their own below.
//!
//! LP claims are proven on the program's own `check_withdrawal_allowed`,
//! `escrow_burn` and `WithdrawRequest::release`, which `claim_withdraw`
//! calls, rather than on a copy of the handler's lines. `split_claim` itself
//! is a dozen 128-bit divisions by symbolic values, which the solver did not
//! finish in ten minutes even at three bits; it is left to unit tests.

use super::kit::*;
use crate::constants::*;
use crate::errors::PerpError;
use crate::instructions::backing::{entry_pot_usd, exit_part};
use crate::instructions::liquidity::{check_withdrawal_allowed, escrow_burn};
use crate::instructions::trade::take_fee_cuts;
use crate::state::custody::shares_for;
use crate::state::*;

const MAX_BAL: u64 = 1 << 20;
const MAX_FEE: u64 = 1 << 10;

fn upto(max: u64) -> u64 {
    let v: u64 = kani::any();
    kani::assume(v <= max);
    v
}

// ---------------------------------------------------------------- fee cuts

/// Taking a fee's cuts moves money from LP liquidity onto the protocol,
/// chain and insurance lines and creates none, on every split
/// `initialize_pool` accepts (protocol, insurance and chain together at most
/// the whole fee): liquidity loses exactly what the three lines gain, which
/// is what the function reports, and that is never more than the fee. The
/// older harness proves this on the documented split. Fees up to 2^10,
/// balances up to 2^20.
#[kani::proof]
#[kani::solver(kissat)]
#[kani::stub(PerpError::name, no_name)]
#[kani::stub(<PerpError as core::fmt::Display>::fmt, no_message)]
#[kani::stub(<anchor_lang::error::Error as core::convert::From<crate::errors::PerpError>>::from, cheap_error)]
fn fee_cuts_move_money_without_creating_any_on_every_split() {
    let mut p = blank_pool();
    p.protocol_fee_share_bps = kani::any();
    p.insurance_fee_share_bps = kani::any();
    kani::assume(
        p.protocol_fee_share_bps as u128 + p.insurance_fee_share_bps as u128 + CHAIN_FEE_SHARE_BPS as u128
            <= BPS,
    );
    p.liquidity_usd = upto(MAX_BAL);
    p.protocol_fees_usd = upto(MAX_BAL);
    p.chain_fees_usd = upto(MAX_BAL);
    p.insurance_usd = upto(MAX_BAL);
    let fee = upto(MAX_FEE);
    let before = p.clone();

    let taken = take_fee_cuts(&mut p, fee).unwrap();
    let gained = (p.protocol_fees_usd - before.protocol_fees_usd)
        + (p.chain_fees_usd - before.chain_fees_usd)
        + (p.insurance_usd - before.insurance_usd);
    assert!(taken == gained);
    assert!(before.liquidity_usd - p.liquidity_usd == taken);
    assert!(taken <= fee);
}

// ---------------------------------------------------------------- backing

/// A backer fee is half the LPs' part of a fee, rounded down, and only when
/// somebody holds a share; it is added to the backing pot and to nothing
/// else. The pot, shares and fee below 2^32.
#[kani::proof]
#[kani::solver(cadical)]
#[kani::stub(PerpError::name, no_name)]
#[kani::stub(<PerpError as core::fmt::Display>::fmt, no_message)]
#[kani::stub(<anchor_lang::error::Error as core::convert::From<crate::errors::PerpError>>::from, cheap_error)]
fn a_backer_fee_is_half_the_lp_part_and_only_with_shares() {
    let mut m = blank_market();
    m.backing_usd = kani::any::<u32>() as u64;
    m.backing_shares = kani::any::<u32>() as u64;
    m.backing_drawn_usd = kani::any::<u32>() as u64;
    let lp_fee = kani::any::<u32>() as u64;
    let before = m.clone();

    match m.credit_backer_fee(lp_fee) {
        Ok(share) => {
            if before.backing_shares == 0 {
                assert!(share == 0);
            } else {
                assert!(share * 2 <= lp_fee && lp_fee <= share * 2 + 1);
            }
            assert!(m.backing_usd == before.backing_usd + share);
            assert!(m.backing_drawn_usd == before.backing_drawn_usd);
        }
        Err(_) => assert!(before.backing_usd as u128 + lp_fee as u128 / 2 > u64::MAX as u128),
    }
}

/// A draw and a restore move money between what the backing pot holds and
/// what losses have drawn from it, and create none: held plus drawn is the
/// same before and after a draw, and after a restore while shares are held.
/// With no shares held a restore changes nothing. A draw takes at most the
/// pot; a restore gives back at most what was drawn. Every input at full
/// width, held plus drawn below 2^64.
#[kani::proof]
#[kani::solver(cadical)]
fn drawing_and_restoring_backing_conserve_held_plus_drawn() {
    let mut m = blank_market();
    m.backing_usd = kani::any();
    m.backing_drawn_usd = kani::any();
    m.backing_shares = kani::any();
    kani::assume((m.backing_usd as u128 + m.backing_drawn_usd as u128) <= u64::MAX as u128);
    let total = m.backing_usd as u128 + m.backing_drawn_usd as u128;
    let before = m.clone();

    if kani::any() {
        let taken = m.draw_backing(kani::any());
        assert!(taken <= before.backing_usd);
        assert!(m.backing_usd as u128 + m.backing_drawn_usd as u128 == total);
    } else {
        let owed = m.restore_backing(kani::any());
        assert!(owed <= before.backing_drawn_usd);
        if before.backing_shares == 0 {
            assert!(owed == 0 && m.backing_usd == before.backing_usd);
        } else {
            assert!(m.backing_usd as u128 + m.backing_drawn_usd as u128 == total);
        }
    }
}

/// New backing never dilutes the backers already in, counting what a later
/// gain owes back to the pot: the shares a deposit buys are priced against
/// held plus drawn, so after it the pot and its claim per share are no
/// smaller than before, and the depositor gets every whole share they paid
/// for. A pot with nothing held and nothing owed back refuses. Amounts,
/// shares and balances 0 to 15.
#[kani::proof]
#[kani::solver(cadical)]
#[kani::stub(PerpError::name, no_name)]
#[kani::stub(<PerpError as core::fmt::Display>::fmt, no_message)]
#[kani::stub(<anchor_lang::error::Error as core::convert::From<crate::errors::PerpError>>::from, cheap_error)]
fn new_backing_never_dilutes_counting_what_is_owed_back() {
    let mut m = blank_market();
    m.backing_usd = nibble();
    m.backing_drawn_usd = nibble();
    m.backing_shares = nibble();
    let amount = nibble();
    let pot = m.backing_usd as u128 + m.backing_drawn_usd as u128;

    let r = m.backing_shares_for(amount);
    if m.backing_shares == 0 {
        assert!(r.unwrap() == amount);
        return;
    }
    if pot == 0 {
        assert!(r.is_err());
        return;
    }
    let n = r.unwrap() as u128;
    let (s, a) = (m.backing_shares as u128, amount as u128);
    // Pot per share after is at least before: (pot + a) / (s + n) >= pot / s.
    assert!((pot + a) * s >= pot * (s + n));
    // And one more share would have cost more than was paid.
    assert!((n + 1) * pot > a * s);
    kani::cover!(n > 0 && a * s % pot != 0, "a deposit that rounds");
}

/// What two backers' holdings are worth never adds up to more than the pot,
/// however the shares are split between them: each is rounded down, so the
/// last backer out cannot overdraw. Shares and pot 0 to 15.
#[kani::proof]
#[kani::solver(cadical)]
fn two_backers_together_are_worth_at_most_the_pot() {
    let mut m = blank_market();
    m.backing_usd = nibble();
    m.backing_shares = nibble();
    let (a, b) = (nibble(), nibble());
    kani::assume(a + b <= m.backing_shares);
    assert!(m.backing_value(a) + m.backing_value(b) <= m.backing_usd);
    if a + b == m.backing_shares && m.backing_shares > 0 {
        // Together they are short of the pot by less than one unit each.
        assert!(m.backing_value(a) + m.backing_value(b) + 2 > m.backing_usd);
    }
}

/// A backer who leaves takes at most their part of the holding, and leaves
/// their part of what the market's traders are owed behind: `exit_part` is
/// never more than `shares / total` of the holding, and never more than
/// `shares / total` of the pot less what is held back. Two backers leaving
/// together never take more than the holding. Amounts 0 to 15.
#[kani::proof]
#[kani::solver(cadical)]
fn an_exit_takes_at_most_its_part_less_what_is_held_back() {
    let (x, total, pot, held) = (nibble(), nibble(), nibble(), nibble());
    let (a, b) = (nibble(), nibble());
    kani::assume(a + b <= total && x <= pot);
    let (ea, eb) = (exit_part(x, a, total, pot, held), exit_part(x, b, total, pot, held));
    if total == 0 || pot == 0 {
        assert!(ea == 0);
        return;
    }
    let (x, t, p, h) = (x as u128, total as u128, pot as u128, held as u128);
    assert!(ea as u128 * t <= x * a as u128);
    assert!(ea as u128 * t * p <= x * a as u128 * (p - h.min(p)));
    assert!(ea as u128 + eb as u128 <= x);
    kani::cover!(h > 0 && ea > 0, "a held-back exit that still pays");
}

/// Backing in and straight back out never profits: shares bought at the
/// entry pot (held, plus what is drawn and what is reimbursed in kind), then
/// sold at once for their part of the pot with the deposit in it, return at
/// most the deposit, whatever is held back. Amounts 0 to 15.
#[kani::proof]
#[kani::solver(cadical)]
#[kani::stub(PerpError::name, no_name)]
#[kani::stub(<PerpError as core::fmt::Display>::fmt, no_message)]
#[kani::stub(<anchor_lang::error::Error as core::convert::From<crate::errors::PerpError>>::from, cheap_error)]
fn backing_in_and_straight_out_never_profits() {
    let (held, drawn, reimbursed) = (nibble(), nibble(), nibble());
    let (total, amount, held_back) = (nibble(), nibble(), nibble());
    kani::assume(total > 0);
    let entry = entry_pot_usd(held, drawn, reimbursed).unwrap();
    let Ok(bought) = shares_for(amount, total, entry) else {
        return;
    };
    let pot = held + amount;
    let back = exit_part(pot, bought, total + bought, pot, held_back);
    assert!(back <= amount);
    kani::cover!(bought > 0 && back > 0, "a round trip that pays something back");
}

// ---------------------------------------------------------------- LP claims

/// A claim the pool allows is paid only from unlocked LP liquidity and
/// leaves at least what is locked, and while anything is locked at least the
/// minimum pool. Every balance at full width.
#[kani::proof]
#[kani::solver(cadical)]
#[kani::stub(PerpError::name, no_name)]
#[kani::stub(<PerpError as core::fmt::Display>::fmt, no_message)]
#[kani::stub(<anchor_lang::error::Error as core::convert::From<crate::errors::PerpError>>::from, cheap_error)]
fn an_allowed_claim_leaves_locked_capital_in_place() {
    let mut p = blank_pool();
    p.liquidity_usd = kani::any();
    p.locked_usd = kani::any();
    let gross: u64 = kani::any();
    if check_withdrawal_allowed(&p, gross).is_ok() {
        assert!(gross <= p.liquidity_usd);
        assert!(p.liquidity_usd - gross >= p.locked_usd);
        if p.locked_usd > 0 {
            assert!(p.liquidity_usd - gross >= MIN_POOL_LIQUIDITY_USD);
        }
    }
}

/// A claim burns at least the shares it was for, and the last claim on a
/// request burns everything in its escrow so the account can close. Every
/// input at full width.
#[kani::proof]
fn an_escrow_burns_the_claim_and_empties_on_the_last() {
    let (lp, remaining, balance): (u64, u64, u64) = (kani::any(), kani::any(), kani::any());
    let burned = escrow_burn(lp, remaining, balance);
    assert!(burned >= lp);
    if remaining == 0 {
        assert!(burned >= balance);
    } else {
        assert!(burned == lp);
    }
}

/// Releasing shares from a withdrawal request returns their part of its
/// points stake, rounded down, takes exactly those shares off, and releasing
/// all of them returns the whole stake: nothing is created and nothing is
/// stranded. Shares and points 0 to 255.
#[kani::proof]
#[kani::solver(cadical)]
#[kani::stub(PerpError::name, no_name)]
#[kani::stub(<PerpError as core::fmt::Display>::fmt, no_message)]
#[kani::stub(<anchor_lang::error::Error as core::convert::From<crate::errors::PerpError>>::from, cheap_error)]
fn releasing_escrowed_shares_returns_their_part_of_the_points() {
    let mut r = WithdrawRequest {
        bump: 0,
        escrow_bump: 0,
        pool: Default::default(),
        owner: Default::default(),
        shares: byte(),
        request_slot: 0,
        points_usd: byte(),
    };
    let (shares, points) = (r.shares, r.points_usd);
    let a = byte();
    let Ok(pa) = r.release(a) else {
        assert!(a == 0 || a > shares);
        return;
    };
    assert!(r.shares == shares - a);
    assert!(pa as u128 * shares as u128 <= points as u128 * a as u128);
    assert!(r.points_usd == points - pa);
    if r.shares > 0 {
        let pb = r.release(r.shares).unwrap();
        assert!(pa + pb == points);
    } else {
        assert!(pa == points);
    }
}

// ---------------------------------------------------------------- the pool

/// A payout comes out of LP liquidity, then the insurance fund for what
/// liquidity cannot cover, by exactly the amount, and reports what the fund
/// paid; when the two together fall short it fails and moves nothing.
/// Every balance at full width.
#[kani::proof]
#[kani::solver(cadical)]
#[kani::stub(PerpError::name, no_name)]
#[kani::stub(<PerpError as core::fmt::Display>::fmt, no_message)]
#[kani::stub(<anchor_lang::error::Error as core::convert::From<crate::errors::PerpError>>::from, cheap_error)]
fn a_payout_takes_exactly_the_amount_from_liquidity_then_insurance() {
    let mut p = blank_pool();
    p.liquidity_usd = kani::any();
    p.insurance_usd = kani::any();
    let before = p.clone();
    let amount: u64 = kani::any();
    let both = before.liquidity_usd as u128 + before.insurance_usd as u128;

    match p.pay_out(amount) {
        Ok(from_insurance) => {
            assert!(both - (p.liquidity_usd as u128 + p.insurance_usd as u128) == amount as u128);
            assert!(before.insurance_usd - p.insurance_usd == from_insurance);
            if from_insurance > 0 {
                assert!(p.liquidity_usd == 0);
            }
        }
        Err(_) => {
            assert!(amount as u128 > both);
            assert!(p.liquidity_usd == before.liquidity_usd && p.insurance_usd == before.insurance_usd);
        }
    }
}

/// Sweeping liquidity nobody owns moves exactly the unlocked part to the
/// insurance fund and creates nothing: liquidity keeps what is locked, and
/// the fund gains what liquidity lost. Every balance at full width, the fund
/// with room for it.
#[kani::proof]
#[kani::solver(cadical)]
#[kani::stub(PerpError::name, no_name)]
#[kani::stub(<PerpError as core::fmt::Display>::fmt, no_message)]
#[kani::stub(<anchor_lang::error::Error as core::convert::From<crate::errors::PerpError>>::from, cheap_error)]
fn sweeping_ownerless_liquidity_moves_it_to_insurance_and_creates_nothing() {
    let mut p = blank_pool();
    p.liquidity_usd = kani::any();
    p.locked_usd = kani::any();
    p.insurance_usd = kani::any();
    kani::assume(p.insurance_usd as u128 + p.liquidity_usd as u128 <= u64::MAX as u128);
    let before = p.clone();
    let moved = p.sweep_ownerless_liquidity().unwrap();
    assert!(moved == before.liquidity_usd.saturating_sub(before.locked_usd));
    assert!(p.liquidity_usd == before.liquidity_usd.min(before.locked_usd));
    assert!(p.insurance_usd == before.insurance_usd + moved);
}

/// What the pool says it can still lock can always be locked in full, and a
/// lock that succeeds never takes the pool past its utilization cap or past
/// its liquidity. Liquidity, lock and amount below 2^16, any cap.
#[kani::proof]
#[kani::solver(cadical)]
#[kani::stub(PerpError::name, no_name)]
#[kani::stub(<PerpError as core::fmt::Display>::fmt, no_message)]
#[kani::stub(<anchor_lang::error::Error as core::convert::From<crate::errors::PerpError>>::from, cheap_error)]
fn the_pool_can_always_lock_its_headroom_and_never_past_its_cap() {
    let mut p = blank_pool();
    p.liquidity_usd = kani::any::<u16>() as u64;
    p.locked_usd = kani::any::<u16>() as u64;
    p.max_utilization_bps = kani::any();
    let headroom = p.lock_headroom_usd();
    let mut q = p.clone();
    assert!(q.lock(headroom).is_ok());

    let amount = kani::any::<u16>() as u64;
    if p.lock(amount).is_ok() && amount > 0 {
        assert!(p.locked_usd <= p.liquidity_usd);
        assert!(p.locked_usd as u128 * BPS <= p.max_utilization_bps as u128 * p.liquidity_usd as u128);
    }
}

/// A market's lock headroom keeps what it reserves within its cap on the
/// remaining budget: locking exactly the headroom leaves `locked_usd` at
/// most `max_utilization` of the remaining budget, and a market already at
/// or past it has none. Budget, net loss and lock below 2^32, any cap.
#[kani::proof]
#[kani::solver(cadical)]
#[kani::stub(PerpError::name, no_name)]
#[kani::stub(<PerpError as core::fmt::Display>::fmt, no_message)]
#[kani::stub(<anchor_lang::error::Error as core::convert::From<crate::errors::PerpError>>::from, cheap_error)]
fn a_market_locked_to_its_headroom_stays_under_its_cap() {
    let mut m = blank_market();
    m.loss_budget_usd = kani::any::<u32>() as u64;
    m.net_loss_usd = kani::any::<i32>() as i64;
    m.locked_usd = kani::any::<u32>() as u64;
    let cap: u16 = kani::any();
    let headroom = m.lock_headroom_usd(cap);
    let allowed = cap as u128 * m.remaining_budget_usd() as u128 / BPS;
    if m.locked_usd as u128 >= allowed {
        assert!(headroom == 0);
    }
    if m.lock_admitted(headroom).is_ok() && headroom > 0 {
        assert!(m.locked_usd as u128 <= allowed);
    }
}
