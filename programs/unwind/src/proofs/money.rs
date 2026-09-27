//! The money math: fees, PnL, funding, equity, entry prices, token values,
//! backing shares, and the decimal and tick helpers that turn a pool into a
//! price.
//!
//! The bounds: where the arithmetic multiplies and divides in u128, amounts
//! and prices are below 2^8 (0 to 255), or 0 to 15 where a harness divides
//! by a quotient of symbolic values, so the solver stays fast. The
//! properties are about rounding direction, sign and ordering, which do not
//! depend on magnitude, and 255 is plenty of room for every rounding case
//! (remainders, exact divisions, zero). Larger values are covered by the
//! unit tests. Harnesses that only add, subtract or compare run over the
//! full range of their types, and say so.
//!
//! Every harness stubs anchor's error conversion with `cheap_error`, which
//! keeps the error code and skips formatting the message. Without it the
//! checker spends minutes unrolling `fmt::write` for strings no proof reads.

use crate::amm::{apply_decimals, sqrt_price_at_tick, to_usd_scale};
use crate::math::{
    apply_signed, blend_entry_price, bps_of, funding_owed_usd, mul_div_u64, position_equity_usd,
    position_pnl_usd,
};
use crate::state::custody::{
    lp_borne_usd, plan_sync, shares_for, token_value_usd, tokens_for_usd, Held, Sync,
};

/// Stands in for anchor's `From<PerpError> for Error`, which builds the
/// error's message with `to_string()`. The formatting machinery is what the
/// model checker spends its time on, and no proof here looks at the message:
/// they check whether a call errors, never what it says. The stub keeps the
/// error code and drops the string.
fn cheap_error(e: crate::errors::PerpError) -> anchor_lang::error::Error {
    anchor_lang::error::Error::from(
        anchor_lang::solana_program::program_error::ProgramError::Custom(u32::from(e)),
    )
}

/// A symbolic amount below 2^8. Drawn as a u8 and widened, rather than a
/// u64 with an assumption, so the high bits are constant zeros the solver
/// can fold away inside the u128 multiplies and divides.
fn small() -> u64 {
    kani::any::<u8>() as u64
}

/// A symbolic amount from 0 to 15, for the harnesses that divide by a
/// quotient of symbolic values (the auction proofs use the same bound).
fn tiny() -> u64 {
    (kani::any::<u8>() & 0x0f) as u64
}

fn small_positive() -> u64 {
    let v = small();
    kani::assume(v > 0);
    v
}

/// Token decimals as mints actually carry them: 0 to 9.
fn decimals() -> u8 {
    let d: u8 = kani::any();
    kani::assume(d <= 9);
    d
}

// ------------------------------------------------------------ mul_div, bps

/// `mul_div_u64` rounds down, exactly: the result is the floor of a*b/denom,
/// so the protocol, which computes every fee and payout with it, never pays
/// out a fraction of a unit it did not have. A zero denominator is an error,
/// not a panic. Bounds: every input below 2^8.
#[kani::proof]
#[kani::stub(<anchor_lang::error::Error as core::convert::From<crate::errors::PerpError>>::from, cheap_error)]
#[kani::solver(cadical)]
fn mul_div_is_floor_and_never_panics() {
    let a = small();
    let b = small() as u128;
    let denom = small() as u128;
    match mul_div_u64(a, b, denom) {
        Err(_) => assert!(denom == 0),
        Ok(r) => {
            let exact = (a as u128) * b;
            let r = r as u128;
            assert!(r * denom <= exact);
            assert!(exact < (r + 1) * denom);
        }
    }
}

/// Scaling by a fraction no larger than one never grows the amount. Every
/// fee, share and haircut the program takes is a fraction of what it is taken
/// from, so none of them can exceed it. Bounds: every input below 2^8.
#[kani::proof]
#[kani::stub(<anchor_lang::error::Error as core::convert::From<crate::errors::PerpError>>::from, cheap_error)]
#[kani::solver(cadical)]
fn mul_div_by_at_most_one_never_grows() {
    let a = small();
    let b = small() as u128;
    let denom = small() as u128;
    kani::assume(denom > 0 && b <= denom);
    assert!(mul_div_u64(a, b, denom).unwrap() <= a);
}

/// A full 10,000 bps is the whole amount: no dust is lost when a rate is
/// 100 percent. Bounds: amount below 2^16 (the unit tests check u64::MAX).
#[kani::proof]
#[kani::stub(<anchor_lang::error::Error as core::convert::From<crate::errors::PerpError>>::from, cheap_error)]
#[kani::solver(cadical)]
fn bps_of_everything_is_everything() {
    let x = kani::any::<u16>() as u64;
    assert_eq!(bps_of(x, 10_000).unwrap(), x);
}

/// Two cuts of the same amount whose rates sum to at most 100 percent never
/// sum to more than the amount. This is what makes a fee split (chain share,
/// backer share, LP remainder) unable to pay out more than the fee.
/// Bounds: amount below 2^8, rates any u16 summing to at most 10,000.
#[kani::proof]
#[kani::stub(<anchor_lang::error::Error as core::convert::From<crate::errors::PerpError>>::from, cheap_error)]
#[kani::solver(cadical)]
fn two_bps_cuts_never_exceed_the_whole() {
    let x = small();
    let b1: u16 = kani::any();
    let b2: u16 = kani::any();
    kani::assume((b1 as u32) + (b2 as u32) <= 10_000);
    let c1 = bps_of(x, b1).unwrap();
    let c2 = bps_of(x, b2).unwrap();
    assert!(c1 + c2 <= x);
}

// ------------------------------------------------------------ apply_signed

/// `apply_signed` never panics, for any balance and any delta. It errors only
/// when a credit would overflow u64, and a debit past zero saturates at zero
/// rather than wrapping to a huge balance. Full range.
#[kani::proof]
#[kani::stub(<anchor_lang::error::Error as core::convert::From<crate::errors::PerpError>>::from, cheap_error)]
fn apply_signed_adds_exactly_or_saturates() {
    let base: u64 = kani::any();
    let delta: i64 = kani::any();
    let want = (base as i128) + (delta as i128);
    match apply_signed(base, delta) {
        Err(_) => assert!(want > u64::MAX as i128),
        Ok(r) => {
            if want < 0 {
                assert_eq!(r, 0);
            } else {
                assert_eq!(r as i128, want);
            }
        }
    }
}

/// A credit followed by the matching debit restores the balance: settling a
/// win and then reversing it leaves nothing behind. Full range.
#[kani::proof]
#[kani::stub(<anchor_lang::error::Error as core::convert::From<crate::errors::PerpError>>::from, cheap_error)]
fn apply_signed_credit_then_debit_is_identity() {
    let base: u64 = kani::any();
    let delta: i64 = kani::any();
    kani::assume(delta >= 0);
    if let Ok(up) = apply_signed(base, delta) {
        assert_eq!(apply_signed(up, -delta).unwrap(), base);
    }
}

// ------------------------------------------------------------ PnL

/// A long and a short of the same size at the same prices have PnL that are
/// exact negatives: whatever one side wins the other loses, to the unit, so
/// the pool's book of longs against shorts nets to zero.
/// Bounds: size and prices below 2^8.
#[kani::proof]
#[kani::stub(<anchor_lang::error::Error as core::convert::From<crate::errors::PerpError>>::from, cheap_error)]
#[kani::solver(cadical)]
fn long_and_short_pnl_are_exact_negatives() {
    let size = small();
    let entry = small_positive();
    let exit = small();
    let long = position_pnl_usd(true, size, entry, exit).unwrap();
    let short = position_pnl_usd(false, size, entry, exit).unwrap();
    assert_eq!(long, -short);
}

/// PnL has the sign of the price move (zero if the price did not move), is
/// the floor of size * move / entry in magnitude, and a long can lose at most
/// its notional. Rounding is toward zero on both sides, so neither a winner
/// nor a loser is charged a unit they did not earn. Bounds: below 2^8.
#[kani::proof]
#[kani::stub(<anchor_lang::error::Error as core::convert::From<crate::errors::PerpError>>::from, cheap_error)]
#[kani::solver(cadical)]
fn pnl_sign_and_size_follow_the_price() {
    let size = small();
    let entry = small_positive();
    let exit = small();
    let pnl = position_pnl_usd(true, size, entry, exit).unwrap();
    if exit == entry {
        assert_eq!(pnl, 0);
    }
    if exit > entry {
        assert!(pnl >= 0);
    }
    if exit < entry {
        assert!(pnl <= 0);
        assert!(pnl >= -(size as i64));
    }
    let mag = pnl.unsigned_abs() as u128;
    let exact = (size as u128) * (exit.abs_diff(entry) as u128);
    assert!(mag * (entry as u128) <= exact);
    assert!(exact < (mag + 1) * (entry as u128));
}

/// A zero entry price is refused, never divided by. Full range.
#[kani::proof]
#[kani::stub(<anchor_lang::error::Error as core::convert::From<crate::errors::PerpError>>::from, cheap_error)]
fn pnl_refuses_a_zero_entry() {
    let is_long: bool = kani::any();
    let size: u64 = kani::any();
    let exit: u64 = kani::any();
    assert!(position_pnl_usd(is_long, size, 0, exit).is_err());
}

// ------------------------------------------------------------ funding

/// Funding is antisymmetric in the two index readings and zero when the
/// index has not moved: swapping entry and current flips who pays, to the
/// unit, and it is never rounded toward the payer. Sign follows the index:
/// a rising index means the trader pays.
/// Bounds: size below 2^16, index readings any i32 (so up to a few hundred
/// units owed, which covers every remainder the truncation can see).
#[kani::proof]
#[kani::stub(<anchor_lang::error::Error as core::convert::From<crate::errors::PerpError>>::from, cheap_error)]
#[kani::solver(cadical)]
fn funding_is_antisymmetric_and_signed_by_the_index() {
    let size = kani::any::<u16>() as u64;
    let a = kani::any::<i32>() as i128;
    let b = kani::any::<i32>() as i128;
    let ab = funding_owed_usd(size, a, b).unwrap();
    let ba = funding_owed_usd(size, b, a).unwrap();
    assert_eq!(ab, -ba);
    if a == b {
        assert_eq!(ab, 0);
    }
    if b > a {
        assert!(ab >= 0);
    }
}

// ------------------------------------------------------------ equity

/// Equity is collateral plus PnL less funding, floored at zero, and it never
/// errors: a trader can lose everything they posted but never owe more, and
/// no combination of inputs that fits halts the instruction. Because the
/// result is exactly max(0, net), it also rises and falls with the mark,
/// which the liquidation and withdrawal checks rely on. Full range.
#[kani::proof]
#[kani::stub(<anchor_lang::error::Error as core::convert::From<crate::errors::PerpError>>::from, cheap_error)]
fn equity_is_exact_and_floored_at_zero() {
    let collateral: u64 = kani::any();
    let pnl: i64 = kani::any();
    let funding: i64 = kani::any();
    let net = (collateral as i128) + (pnl as i128) - (funding as i128);
    let eq = position_equity_usd(collateral, pnl, funding);
    if net <= 0 {
        assert_eq!(eq.unwrap(), 0);
    } else if net <= u64::MAX as i128 {
        assert_eq!(eq.unwrap() as i128, net);
    } else {
        assert!(eq.is_err());
    }
}

// ------------------------------------------------------------ entry price

/// Adding to a position blends its entry price to somewhere between the old
/// average and the new fill. A blended entry outside that range would hand
/// the trader PnL no price ever gave them. Bounds: sizes and prices 0 to 15.
#[kani::proof]
#[kani::stub(<anchor_lang::error::Error as core::convert::From<crate::errors::PerpError>>::from, cheap_error)]
#[kani::solver(cadical)]
fn blended_entry_lies_between_the_two_prices() {
    let size = tiny();
    let avg = tiny();
    let add = tiny();
    let price = tiny();
    let p = blend_entry_price(size, avg, add, price).unwrap();
    if size + add > 0 {
        let lo = if size == 0 { price } else if add == 0 { avg } else { avg.min(price) };
        let hi = if size == 0 { price } else if add == 0 { avg } else { avg.max(price) };
        assert!(lo <= p && p <= hi);
    }
}

/// Adding nothing to a position leaves its entry price exactly where it
/// was, whatever price the empty add names. Bounds: below 2^8.
#[kani::proof]
#[kani::stub(<anchor_lang::error::Error as core::convert::From<crate::errors::PerpError>>::from, cheap_error)]
#[kani::solver(cadical)]
fn adding_nothing_keeps_the_entry_price() {
    let size = small_positive();
    let avg = small();
    let price = small();
    assert_eq!(blend_entry_price(size, avg, 0, price).unwrap(), avg);
}

// ------------------------------------------------------------ custody

/// Tokens handed to the LPs for a USD loss are always worth at least that
/// loss at the same oracle price, and one base unit fewer would not be: the
/// rounding goes to the LPs who covered the loss, never to the backers who
/// owe it, and by no more than a unit.
/// Bounds: USD and price 0 to 15 (price positive), every decimals from 0 to
/// 9 (each checked with the power of ten as a constant).
#[kani::proof]
#[kani::stub(<anchor_lang::error::Error as core::convert::From<crate::errors::PerpError>>::from, cheap_error)]
#[kani::unwind(11)]
#[kani::solver(cadical)]
fn tokens_for_usd_covers_the_loss_by_at_most_one_unit() {
    let usd = tiny();
    let price = tiny();
    kani::assume(price > 0);
    for d in 0..=9u8 {
        let t = tokens_for_usd(usd, price, d).unwrap();
        assert!(token_value_usd(t, price, d).unwrap() >= usd);
        if t > 0 {
            assert!(token_value_usd(t - 1, price, d).unwrap() < usd);
        }
    }
}

/// When a custody's holding is worth more than what is still owed, the tokens
/// for what is owed never exceed the holding. `plan_sync` relies on this when
/// it books exactly `need` USD for a partial take: the `.min(amount)` there
/// can never bind, so the USD it records is always backed by the tokens it
/// moves. Bounds: below 2^8, decimals 0 to 9.
#[kani::proof]
#[kani::stub(<anchor_lang::error::Error as core::convert::From<crate::errors::PerpError>>::from, cheap_error)]
#[kani::unwind(6)]
#[kani::solver(cadical)]
fn a_partial_take_fits_inside_the_holding() {
    let amount = small();
    let need = small();
    let price = small_positive();
    let d = decimals();
    kani::assume(token_value_usd(amount, price, d).unwrap() > need);
    assert!(tokens_for_usd(need, price, d).unwrap() <= amount);
}

/// A zero price is refused rather than divided by. Full range.
#[kani::proof]
#[kani::stub(<anchor_lang::error::Error as core::convert::From<crate::errors::PerpError>>::from, cheap_error)]
#[kani::unwind(6)]
fn tokens_for_usd_refuses_a_zero_price() {
    let usd: u64 = kani::any();
    let d = decimals();
    assert!(tokens_for_usd(usd, 0, d).is_err());
}

/// Fresh backing never dilutes the backers already in: the new shares, at the
/// pot's pre-deposit price, are worth no more than the USD paid, so the value
/// of every existing share can only hold or rise. The first backer into an
/// empty pot gets one share per dollar. Bounds: below 2^8.
#[kani::proof]
#[kani::stub(<anchor_lang::error::Error as core::convert::From<crate::errors::PerpError>>::from, cheap_error)]
#[kani::solver(cadical)]
fn new_backing_never_dilutes_existing_backers() {
    let usd = small();
    let total = small();
    let pot = small();
    let Ok(s) = shares_for(usd, total, pot) else {
        // Refused only for a wiped pot with shares still held.
        assert!(total > 0 && pot == 0);
        return;
    };
    if total == 0 {
        assert_eq!(s, usd);
    } else {
        // Worth of the new shares <= what was paid. Rearranged, this is
        // (pot + usd) / (total + s) >= pot / total: the pot per share after
        // the deposit is at least the pot per share before it.
        assert!((s as u128) * (pot as u128) <= (usd as u128) * (total as u128));
    }
}

/// A backer never gives more than a share's worth of rounding to the pot:
/// one more share would have cost more than they paid. Holds only while the
/// pot has value; see `shares_into_a_wiped_pot_keep_their_value` below for
/// why the zero-pot case is excluded. Bounds: below 2^8.
#[kani::proof]
#[kani::stub(<anchor_lang::error::Error as core::convert::From<crate::errors::PerpError>>::from, cheap_error)]
#[kani::solver(cadical)]
fn new_backing_gets_every_whole_share_it_paid_for() {
    let usd = small();
    let total = small_positive();
    let pot = small_positive();
    let s = shares_for(usd, total, pot).unwrap();
    assert!(((s + 1) as u128) * (pot as u128) > (usd as u128) * (total as u128));
}

/// A pot worth nothing while shares are still held refuses new backing, so
/// no deposit is ever split with old shares worth zero. This failed before
/// the fix: total = 200, pot = 0, usd = 100 minted 100 shares of a 300-share,
/// $100 pot, and the new backer owned $33.33 of the $100 they paid.
/// Bounds: below 2^8.
#[kani::proof]
#[kani::stub(<anchor_lang::error::Error as core::convert::From<crate::errors::PerpError>>::from, cheap_error)]
#[kani::solver(cadical)]
fn shares_into_a_wiped_pot_keep_their_value() {
    let usd = small_positive();
    let total = small_positive();
    let pot: u64 = 0;
    assert!(shares_for(usd, total, pot).is_err());
}

/// The loss the LPs carried for a market is never negative and never more
/// than the market's net loss: the backing drawn can only reduce it, and a
/// market in profit owes the LPs nothing. Bounds: net loss any i64, drawn any
/// u64 up to i64::MAX (`lp_borne_past_i64_max` covers the rest).
#[kani::proof]
#[kani::stub(<anchor_lang::error::Error as core::convert::From<crate::errors::PerpError>>::from, cheap_error)]
fn lp_borne_is_between_zero_and_the_net_loss() {
    let net: i64 = kani::any();
    let drawn: u64 = kani::any();
    kani::assume(drawn <= i64::MAX as u64);
    let b = lp_borne_usd(net, drawn);
    assert!(b >= 0);
    assert!(b <= net.max(0));
    if (net as i128) - (drawn as i128) >= 0 {
        assert_eq!(b as i128, (net as i128) - (drawn as i128));
    }
}

/// Past i64::MAX drawn, the LP-borne loss still stays between zero and the
/// net loss: the drawn amount saturates instead of wrapping. This failed
/// before the fix: net = 0, drawn = 2^63 gave i64::MAX, a loss the LPs never
/// took. Bounds: every i64 net loss and every u64 drawn.
#[kani::proof]
#[kani::stub(<anchor_lang::error::Error as core::convert::From<crate::errors::PerpError>>::from, cheap_error)]
fn lp_borne_past_i64_max() {
    let net: i64 = kani::any();
    let drawn: u64 = kani::any();
    let b = lp_borne_usd(net, drawn);
    assert!(b >= 0 && b <= net.max(0));
}

fn any_held() -> Held {
    let h = Held {
        amount: tiny(),
        price: tiny(),
        decimals: kani::any(),
        is_stable: kani::any(),
        weight_bps: 10_000,
    };
    kani::assume(h.price > 0 && h.decimals <= 2);
    h
}

/// Syncing a market's in-kind backing never takes more tokens than a custody
/// holds, pays the LPs more than they are still owed, or pays out value the
/// tokens do not have; a refund never exceeds what was reimbursed or what the
/// LPs can pay. This is the reconciliation that moves backers' tokens to LPs.
/// Bounds: two custodies, amounts and prices 0 to 15, decimals 0 to 2,
/// every USD figure within +/- 2^7.
#[kani::proof]
#[kani::stub(<anchor_lang::error::Error as core::convert::From<crate::errors::PerpError>>::from, cheap_error)]
#[kani::unwind(4)]
#[kani::solver(cadical)]
fn sync_never_takes_more_than_held_or_owed() {
    let held = [any_held(), any_held()];
    let lp_borne = kani::any::<i8>() as i64;
    let baseline = kani::any::<i8>() as i64;
    let reimbursed = kani::any::<u8>() as u64;
    let liquidity = kani::any::<u8>() as u64;
    let owed = (lp_borne - baseline).max(0) as u64;
    match plan_sync(lp_borne, baseline, reimbursed, &held, liquidity).unwrap() {
        Sync::Nothing => {}
        Sync::PayLps { usd, taken } => {
            assert!(reimbursed + usd <= owed);
            let mut worth = 0u64;
            for i in 0..2 {
                assert!(taken[i] <= held[i].amount);
                worth += token_value_usd(taken[i], held[i].price, held[i].decimals).unwrap();
            }
            assert!(worth >= usd);
            assert!(taken[2] == 0 && taken[3] == 0);
        }
        Sync::Refund { usd } => {
            assert!(usd <= liquidity);
            assert!(usd <= reimbursed);
            assert!(reimbursed - usd >= owed);
        }
    }
}

// ------------------------------------------------------------ amm helpers

/// Converting a pool's raw price between token decimals never panics, for any
/// pair of u8 decimals: an exponent too large is an error. For decimals mints
/// actually use (0 to 18 apart) and a price that fits u64 it always succeeds.
/// Bounds: raw price below 2^64.
#[kani::proof]
#[kani::stub(<anchor_lang::error::Error as core::convert::From<crate::errors::PerpError>>::from, cheap_error)]
#[kani::unwind(10)]
#[kani::solver(cadical)]
fn apply_decimals_never_panics() {
    let raw = kani::any::<u64>() as u128;
    let d0: u8 = kani::any();
    let d1: u8 = kani::any();
    let r = apply_decimals(raw, d0, d1);
    if d0.abs_diff(d1) <= 18 {
        assert!(r.is_ok());
    }
}

/// Rescaling a token amount to six decimals never panics for any u8
/// decimals, and for mints with up to 24 decimals and amounts that fit u64
/// it always succeeds. Rounding is down when shrinking. Bounds: raw below 2^64.
#[kani::proof]
#[kani::stub(<anchor_lang::error::Error as core::convert::From<crate::errors::PerpError>>::from, cheap_error)]
#[kani::unwind(10)]
#[kani::solver(cadical)]
fn to_usd_scale_never_panics_and_rounds_down() {
    let raw = kani::any::<u64>() as u128;
    let d: u8 = kani::any();
    let r = to_usd_scale(raw, d);
    if d <= 24 {
        let v = r.unwrap();
        if d >= 6 {
            assert!(v <= raw);
        } else {
            assert!(v >= raw);
        }
    }
}

/// The square-root price rises strictly with the tick. The TWAP reader turns
/// an averaged tick back into a price with this, so a higher average tick
/// must never read as a lower price. Kani checks adjacent ticks in
/// -64..64 (all seven low bits of the factor table); the unit test
/// `every_tick_is_above_the_one_below` checks every tick Raydium allows.
#[kani::proof]
#[kani::stub(<anchor_lang::error::Error as core::convert::From<crate::errors::PerpError>>::from, cheap_error)]
#[kani::unwind(20)]
#[kani::solver(cadical)]
fn sqrt_price_rises_with_the_tick() {
    let t: i32 = kani::any();
    kani::assume(t >= -64 && t < 64);
    assert!(sqrt_price_at_tick(t).unwrap() < sqrt_price_at_tick(t + 1).unwrap());
}

/// Every tick outside the range a pool can report is refused with an error,
/// never a panic, down to i32::MIN. This failed before the fix: the guard used
/// `tick.abs()`, which overflows for i32::MIN, and with overflow checks on
/// (the release profile sets them) that was a panic. Unreachable from a real
/// Raydium ring, but `ring_twap_tick` derives the tick from account bytes.
/// Bounds: every i32 outside +/- 443,636 (the ticks inside are covered by
/// `sqrt_price_rises_with_the_tick` and the unit test over the whole range).
#[kani::proof]
#[kani::stub(<anchor_lang::error::Error as core::convert::From<crate::errors::PerpError>>::from, cheap_error)]
#[kani::unwind(20)]
fn sqrt_price_never_panics() {
    let t: i32 = kani::any();
    kani::assume(t < -443_636 || t > 443_636);
    assert!(sqrt_price_at_tick(t).is_err());
}
