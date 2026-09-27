//! What one market may cost the pool, and the pool's own ledger: the loss
//! budget, backing, how a close pays or is paid, payouts, AUM, oracle
//! freshness, leverage caps and funding.
//!
//! The bounds differ per harness and each one says what it assumes. Most run
//! over the full width of their types. Where two unknowns are multiplied
//! (a size times a funding index), one of them is held to a list of concrete
//! values, because the solver does not get through a 128 bit nonlinear
//! product in useful time. Properties that are nothing but such products
//! (share prices, the utilization cap, the fill spread, the band) are left to
//! exhaustive unit tests, and say so where they would have been.

use crate::constants::*;
use crate::oracle::OraclePrice;
use crate::state::{Market, Pool, PriceSource, Session};
use crate::errors::PerpError;
use anchor_lang::prelude::Pubkey;

// Stand-ins for the text of an error.
//
// Every `require!` builds an Anchor error that carries the variant's name and
// message as `String`s, and formatting those is thousands of symbolic steps
// the model checker has to unroll on every failing path (a harness with one
// `Err` branch ran for 14 minutes without finishing). No property here reads
// an error's text, only whether a call failed, so the harnesses that reach an
// `Err` swap the two text builders for these, which return empty text. The
// error variant, its code and the control flow are untouched.
fn no_name(_: &PerpError) -> String {
    String::new()
}

fn no_message(_: &PerpError, _: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
    Ok(())
}

/// A market with every field zero, for a harness to fill in what it needs.
fn blank_market() -> Market {
    Market {
        bump: 0,
        pool: Pubkey::default(),
        symbol: [0; 16],
        feed_id: [0; 32],
        max_price_age_sec: 0,
        max_conf_bps: 0,
        max_leverage_bps: 0,
        maintenance_margin_bps: 0,
        liquidation_fee_bps: 0,
        open_fee_bps: 0,
        close_fee_bps: 0,
        min_position_usd: 0,
        max_oi_long_usd: 0,
        max_oi_short_usd: 0,
        pnl_reserve_bps: 0,
        base_spread_bps: 0,
        conf_spread_mult_bps: 0,
        max_spread_bps: 0,
        session: Session::Regular as u8,
        closed_session_leverage_bps: 0,
        closed_session_oi_mult_bps: 0,
        cumulative_long_funding: 0,
        cumulative_short_funding: 0,
        last_funding_ts: 0,
        max_funding_rate_bps_per_hour: 0,
        funding_k_bps: 0,
        borrow_rate_bps_per_hour: 0,
        long_size_usd: 0,
        long_avg_entry_price: 0,
        short_size_usd: 0,
        short_avg_entry_price: 0,
        collateral_usd: 0,
        price_factor: 0,
        split_epoch: 0,
        last_multiplier: 0,
        paused: false,
        loss_budget_usd: 0,
        net_loss_usd: 0,
        locked_usd: 0,
        price_source: PriceSource::Pyth as u8,
        observation: Pubkey::default(),
        deployer: Pubkey::default(),
        backing_usd: 0,
        backing_shares: 0,
        backing_drawn_usd: 0,
        last_price_ts: 0,
        depth_leverage_x: 0,
        _reserved: [0; 2],
        volume_usd: 0,
        deployer_synced_volume_usd: 0,
        deployer_rewards_usd: 0,
        deployer_earned_usd: 0,
    }
}

/// A pool with every field zero, for a harness to fill in what it needs.
fn blank_pool() -> Pool {
    Pool {
        bump: 0,
        vault_bump: 0,
        lp_mint_bump: 0,
        authority: Pubkey::default(),
        pending_authority: Pubkey::default(),
        usdc_mint: Pubkey::default(),
        usdc_vault: Pubkey::default(),
        lp_mint: Pubkey::default(),
        num_markets: 0,
        liquidity_usd: 0,
        locked_usd: 0,
        trader_collateral_usd: 0,
        protocol_fees_usd: 0,
        add_liquidity_fee_bps: 0,
        remove_liquidity_fee_bps: 0,
        protocol_fee_share_bps: 0,
        max_utilization_bps: 0,
        insurance_usd: 0,
        insurance_fee_share_bps: 0,
        pyth_receiver: Pubkey::default(),
        escrow_usd: 0,
        chain_fee_destination: Pubkey::default(),
        chain_fees_usd: 0,
        rewards_usd: 0,
        paused: false,
        backing_usd: 0,
        num_custodies: 0,
        markets_with_oi: 0,
        _reserved: [0; 3],
    }
}

/// A market whose budget has not been overspent, which is the state every
/// checked charge leaves it in.
///
/// The budget is held to `i64::MAX`. Past that `amount as i64` in the charge
/// wraps negative and a loss books as a gain; no USDC supply comes near it
/// ($9.2 trillion), but it is a precondition, not a property.
fn any_budgeted_market() -> Market {
    let mut m = blank_market();
    m.loss_budget_usd = kani::any();
    m.net_loss_usd = kani::any();
    kani::assume(m.loss_budget_usd <= i64::MAX as u64);
    kani::assume(m.net_loss_usd <= m.loss_budget_usd as i64);
    m
}

// ---------------------------------------------------------------------------
// Loss budget
// ---------------------------------------------------------------------------

/// A checked loss is booked exactly when it fits what is left of the budget,
/// and once booked the market has still not lost more than it was
/// underwritten for. This is what stops one market's winners being paid out
/// of capital put up for the others: `apply_settlement_to_pool` charges the
/// loss before any money moves, and a refusal fails the whole close.
///
/// Bounds: any budget up to `i64::MAX`, any net loss within it, any amount.
#[kani::proof]
#[kani::stub(PerpError::name, no_name)]
#[kani::stub(<PerpError as core::fmt::Display>::fmt, no_message)]
fn a_checked_loss_never_spends_past_the_budget() {
    let mut m = any_budgeted_market();
    let before = m.net_loss_usd;
    let remaining = m.remaining_budget_usd();
    let amount: u64 = kani::any();

    let ok = m.charge_loss(amount).is_ok();

    assert_eq!(ok, amount <= remaining);
    if ok {
        assert_eq!(m.net_loss_usd, before + amount as i64);
        assert!(m.net_loss_usd <= m.loss_budget_usd as i64);
    } else {
        assert_eq!(m.net_loss_usd, before, "a refused charge books nothing");
    }
}

/// What is left of the budget never grows on a loss and shrinks by no more
/// than the loss, and by exactly the loss while the market is not in profit.
/// The pool sizes its quote from what is left, so a charge that shrank it by
/// more would stop quoting early, and one that shrank it by less would let a
/// market lose past its allowance.
///
/// Bounds: as above.
#[kani::proof]
#[kani::stub(PerpError::name, no_name)]
#[kani::stub(<PerpError as core::fmt::Display>::fmt, no_message)]
fn a_loss_shrinks_the_remaining_budget_by_at_most_itself() {
    let mut m = any_budgeted_market();
    let before = m.remaining_budget_usd();
    assert!(before <= m.loss_budget_usd, "gains never enlarge the allowance");
    let was_in_profit = m.net_loss_usd < 0;
    let amount: u64 = kani::any();

    if m.charge_loss(amount).is_ok() {
        let after = m.remaining_budget_usd();
        assert!(after <= before);
        assert!(before - after <= amount);
        if !was_in_profit {
            assert_eq!(before - after, amount);
        }
    }
}

/// A gain of the same size undoes a loss exactly: net loss and the remaining
/// budget are both back where they started. A market that loses and then wins
/// the same amount has cost the pool nothing, and must be able to lose it
/// again.
///
/// Bounds: as above.
#[kani::proof]
#[kani::stub(PerpError::name, no_name)]
#[kani::stub(<PerpError as core::fmt::Display>::fmt, no_message)]
fn a_gain_undoes_a_loss_exactly() {
    let mut m = any_budgeted_market();
    let net = m.net_loss_usd;
    let remaining = m.remaining_budget_usd();
    let amount: u64 = kani::any();

    if m.charge_loss(amount).is_ok() {
        m.credit_gain(amount).unwrap();
        assert_eq!(m.net_loss_usd, net);
        assert_eq!(m.remaining_budget_usd(), remaining);
    }
}

/// Liquidation and deleveraging book their loss whatever the budget says,
/// and when the loss fits they book exactly what the checked path would.
/// A liquidation blocked by an exhausted budget would leave an insolvent
/// position open, which is worse than the overrun it avoids.
///
/// Bounds: any budget, any net loss and amount whose sum does not overflow
/// `i64` (the one failure `charge_loss_unchecked` has).
#[kani::proof]
#[kani::stub(PerpError::name, no_name)]
#[kani::stub(<PerpError as core::fmt::Display>::fmt, no_message)]
fn the_unchecked_loss_is_never_blocked_by_the_budget() {
    let mut checked = blank_market();
    checked.loss_budget_usd = kani::any();
    checked.net_loss_usd = kani::any();
    let amount: u64 = kani::any();
    kani::assume(amount <= i64::MAX as u64);
    kani::assume(checked.net_loss_usd.checked_add(amount as i64).is_some());
    let mut unchecked = blank_market();
    unchecked.loss_budget_usd = checked.loss_budget_usd;
    unchecked.net_loss_usd = checked.net_loss_usd;

    assert!(unchecked.charge_loss_unchecked(amount).is_ok());
    if checked.charge_loss(amount).is_ok() {
        assert_eq!(checked.net_loss_usd, unchecked.net_loss_usd);
    }
}

// ---------------------------------------------------------------------------
// Backing
// ---------------------------------------------------------------------------

/// A loss draws on backing for at most the loss and at most what is held,
/// and the money only moves from `backing_usd` to `backing_drawn_usd`. The
/// settlement subtracts the draw from the loss (`loss - from_backing`) and
/// from the pool's backing total, so a draw past either would underflow the
/// close or pay a loss twice.
///
/// Bounds: full `u64` range, with backing plus drawn not overflowing.
#[kani::proof]
fn a_draw_takes_no_more_than_the_loss_or_the_backing() {
    let mut m = blank_market();
    m.backing_usd = kani::any();
    m.backing_drawn_usd = kani::any();
    kani::assume(m.backing_usd.checked_add(m.backing_drawn_usd).is_some());
    let (held, drawn) = (m.backing_usd, m.backing_drawn_usd);
    let amount: u64 = kani::any();

    let taken = m.draw_backing(amount);

    assert_eq!(taken, amount.min(held));
    assert_eq!(m.backing_usd, held - taken);
    assert_eq!(m.backing_drawn_usd, drawn + taken);
    assert_eq!(m.backing_usd + m.backing_drawn_usd, held + drawn);
}

/// A gain repays backing for at most the gain and at most what losses took,
/// and the money only moves back from `backing_drawn_usd` to `backing_usd`.
/// Backers underwrite the downside and do not own the upside, and the
/// settlement's `gain - to_backing` relies on the repayment fitting the gain.
/// With no shares held nothing is restored at all: the backers who were drawn
/// on have left, and an unowned pot would go to whoever backed next.
///
/// Bounds: full `u64` range, with backing plus drawn not overflowing.
#[kani::proof]
fn a_restore_repays_only_what_was_drawn() {
    let mut m = blank_market();
    m.backing_usd = kani::any();
    m.backing_drawn_usd = kani::any();
    m.backing_shares = kani::any();
    kani::assume(m.backing_usd.checked_add(m.backing_drawn_usd).is_some());
    let (held, drawn) = (m.backing_usd, m.backing_drawn_usd);
    let amount: u64 = kani::any();

    let owed = m.restore_backing(amount);

    if m.backing_shares == 0 {
        assert_eq!(owed, 0);
    } else {
        assert_eq!(owed, amount.min(drawn));
    }
    assert_eq!(m.backing_drawn_usd, drawn - owed);
    assert_eq!(m.backing_usd + m.backing_drawn_usd, held + drawn);
}

/// A loss followed by a gain of the same size leaves the backers exactly as
/// they were. Without it a market that lost and then won would have moved
/// money from its backers to the LPs.
///
/// Bounds: full `u64` range, with backing plus drawn not overflowing.
#[kani::proof]
fn a_draw_and_an_equal_restore_leave_backing_as_it_was() {
    let mut m = blank_market();
    // Somebody holds the backing that was drawn on.
    m.backing_shares = 1;
    m.backing_usd = kani::any();
    m.backing_drawn_usd = kani::any();
    kani::assume(m.backing_usd.checked_add(m.backing_drawn_usd).is_some());
    let (held, drawn) = (m.backing_usd, m.backing_drawn_usd);
    let amount: u64 = kani::any();

    let taken = m.draw_backing(amount);
    let owed = m.restore_backing(taken);

    assert_eq!(owed, taken);
    assert_eq!((m.backing_usd, m.backing_drawn_usd), (held, drawn));
}

// What a backing share is worth, and what a deposit buys, are `x * y / z`
// with all three unknown. A SAT solver has to reason about that as a 128 bit
// multiply and divide however small the values are, and a harness with two
// of them did not finish in eight minutes. Those properties (a new backer
// neither gains nor dilutes, backers together cannot withdraw more than is
// held, a fee never lowers a share) are instead checked exhaustively over
// every value up to 40 by the unit tests in `state/market.rs`. Finding a
// counterexample is far easier for the solver than ruling one out, which is
// why the harness below, which once failed, runs quickly.

/// A market whose backing has been drawn to zero, with the earlier backers'
/// shares still outstanding, refuses new backing rather than sharing the
/// deposit with those wiped-out holders.
///
/// This failed before the fix: `backing_usd = 0`, `backing_shares = 1`,
/// deposit 1 bought 1 share, and the new backer could withdraw 0 of the 1
/// they paid. At scale, 1,000 zombie shares and a 1,000 deposit handed the
/// old holders 500. `custody::shares_for`, which `back_market` calls, has
/// the same refusal (proved in money.rs).
///
/// Bounds: shares and the deposit from 1 to 255.
#[kani::proof]
#[kani::solver(cadical)]
#[kani::stub(PerpError::name, no_name)]
#[kani::stub(<PerpError as core::fmt::Display>::fmt, no_message)]
fn a_backer_into_a_wiped_out_market_is_not_diluted() {
    let mut m = blank_market();
    m.backing_usd = 0;
    m.backing_shares = kani::any();
    let amount: u64 = kani::any();
    kani::assume(m.backing_shares >= 1 && m.backing_shares <= 255);
    kani::assume(amount >= 1 && amount <= 255);

    assert!(m.backing_shares_for(amount).is_err());
}

// ---------------------------------------------------------------------------
// Locks, fees, fills and the band
// ---------------------------------------------------------------------------

// The utilization cap, the backers' fee cut, the fill spread and the price
// band all multiply a balance or a price by a bps figure and divide by
// 10,000. With both factors unknown that is a 128 bit nonlinear product, and
// each harness written for them ran past eight minutes without an answer, so
// they are not claimed as proofs here. The unit tests in `state/pool.rs` and
// `state/market.rs` check the same properties exhaustively over bounded
// ranges instead.

// ---------------------------------------------------------------------------
// Payouts and AUM
// ---------------------------------------------------------------------------

/// A payout is made in full or not at all. When it is made, liquidity and
/// the insurance fund between them fall by exactly the amount paid, the fund
/// is touched only for what liquidity could not cover, and the call returns
/// what the fund gave. When it is refused, nothing moves. A trader is never
/// handed part of what they are owed with the position called settled.
///
/// Bounds: full `u64` range, with liquidity plus the fund not overflowing.
#[kani::proof]
#[kani::stub(PerpError::name, no_name)]
#[kani::stub(<PerpError as core::fmt::Display>::fmt, no_message)]
fn a_payout_is_paid_in_full_or_not_at_all() {
    let mut p = blank_pool();
    p.liquidity_usd = kani::any();
    p.insurance_usd = kani::any();
    kani::assume(p.liquidity_usd.checked_add(p.insurance_usd).is_some());
    let (liq, ins) = (p.liquidity_usd, p.insurance_usd);
    let amount: u64 = kani::any();

    match p.pay_out(amount) {
        Ok(from_fund) => {
            assert!(amount <= liq + ins);
            assert_eq!(p.liquidity_usd + p.insurance_usd + amount, liq + ins);
            assert_eq!(from_fund, amount.saturating_sub(liq));
            assert_eq!(p.insurance_usd, ins - from_fund);
        }
        Err(_) => {
            assert!(amount > liq + ins);
            assert_eq!((p.liquidity_usd, p.insurance_usd), (liq, ins));
        }
    }
}

/// AUM never rises as traders' unrealised profit rises, never underflows or
/// overflows (it saturates), and is exactly liquidity when traders are flat.
/// LP shares are priced from it, so a pool that read richer while its
/// traders were further up would sell shares into a loss that has already
/// happened.
///
/// Bounds: full `u64` liquidity and full `i64` PnL.
#[kani::proof]
fn aum_falls_as_trader_profit_rises() {
    let mut p = blank_pool();
    p.liquidity_usd = kani::any();
    let a: i64 = kani::any();
    let b: i64 = kani::any();
    kani::assume(a <= b);

    assert!(p.aum_usd(a) >= p.aum_usd(b));
    assert_eq!(p.aum_usd(0), p.liquidity_usd);
    if b >= 0 {
        assert!(p.aum_usd(b) <= p.liquidity_usd);
    }
    if a <= 0 {
        assert!(p.aum_usd(a) >= p.liquidity_usd);
    }
}

/// A market and the pool it draws on, with the balances a close touches
/// left unknown.
fn any_close() -> (Market, Pool) {
    let mut m = any_budgeted_market();
    m.backing_usd = kani::any();
    m.backing_drawn_usd = kani::any();
    kani::assume(m.backing_usd.checked_add(m.backing_drawn_usd).is_some());
    let mut p = blank_pool();
    p.liquidity_usd = kani::any();
    p.insurance_usd = kani::any();
    p.backing_usd = kani::any();
    kani::assume(p.liquidity_usd.checked_add(p.insurance_usd).is_some());
    // The pool's backing total is the sum over markets, so it holds at least
    // this market's part.
    kani::assume(p.backing_usd >= m.backing_usd);
    (m, p)
}

/// A losing close, in the order `apply_settlement_to_pool` runs it (charge
/// the budget, draw backing, pay the rest from liquidity and then the fund),
/// pays the loss exactly once. Backing, liquidity and the fund between them
/// fall by exactly the loss; backing is spent before any LP money; the fund
/// before nothing but liquidity; and a close the budget refuses moves no
/// money at all. This is the whole of what "a market spends its backers'
/// money first and the LPs' only after" means in the ledger.
///
/// Bounds: any budget up to `i64::MAX` with any net loss inside it, full
/// `u64` balances whose sums do not overflow, any loss.
#[kani::proof]
#[kani::stub(PerpError::name, no_name)]
#[kani::stub(<PerpError as core::fmt::Display>::fmt, no_message)]
fn a_losing_close_is_paid_once_backers_first() {
    let (mut m, mut p) = any_close();
    let (backing, liq, fund, pool_backing) =
        (m.backing_usd, p.liquidity_usd, p.insurance_usd, p.backing_usd);
    let loss: u64 = kani::any();

    if m.charge_loss(loss).is_err() {
        // Refused before anything moved; the whole close fails with it.
        assert_eq!((m.backing_usd, p.liquidity_usd, p.insurance_usd), (backing, liq, fund));
        return;
    }
    let from_backing = m.draw_backing(loss);
    p.backing_usd = p.backing_usd.saturating_sub(from_backing);
    let rest = loss - from_backing;
    if let Ok(from_fund) = p.pay_out(rest) {
        let spent = (backing - m.backing_usd) + (liq - p.liquidity_usd) + (fund - p.insurance_usd);
        assert_eq!(spent, loss, "paid exactly once");
        assert_eq!(p.backing_usd, pool_backing - from_backing);
        assert_eq!(from_fund, fund - p.insurance_usd);
        if p.liquidity_usd < liq {
            assert_eq!(m.backing_usd, 0, "LP money only once the backers' is gone");
        }
        if from_fund > 0 {
            assert_eq!(p.liquidity_usd, 0, "the fund only once liquidity is gone");
        }
    }
}

/// A winning close for the pool puts the gain back where losses took it
/// from: backing is repaid up to what it lost, the rest goes to LP
/// liquidity, and the two rise by exactly the gain between them. Backers
/// never receive more than was drawn from them, and the market's net loss
/// falls by the gain. With no backers left, all of it goes to the LPs.
///
/// Bounds: any net loss that the gain cannot overflow, full `u64` balances
/// whose sums do not overflow, any gain.
#[kani::proof]
#[kani::stub(PerpError::name, no_name)]
#[kani::stub(<PerpError as core::fmt::Display>::fmt, no_message)]
fn a_winning_close_repays_backers_then_lps() {
    let (mut m, mut p) = any_close();
    let gain: u64 = kani::any();
    kani::assume(gain <= i64::MAX as u64);
    kani::assume(m.net_loss_usd.checked_sub(gain as i64).is_some());
    let (net, backing, drawn, liq) =
        (m.net_loss_usd, m.backing_usd, m.backing_drawn_usd, p.liquidity_usd);
    kani::assume(liq.checked_add(gain).is_some());

    m.credit_gain(gain).unwrap();
    let to_backing = m.restore_backing(gain);
    p.liquidity_usd += gain - to_backing;

    assert_eq!(m.net_loss_usd, net - gain as i64);
    assert!(to_backing <= drawn);
    assert_eq!((m.backing_usd - backing) + (p.liquidity_usd - liq), gain);
    if m.backing_shares == 0 {
        assert_eq!(to_backing, 0, "an unowned pot is not refilled");
    } else if to_backing < gain {
        assert_eq!(m.backing_drawn_usd, 0, "LPs gain only once backers are whole");
    }
}

// ---------------------------------------------------------------------------
// Prices
// ---------------------------------------------------------------------------

/// A market only ever acts on prices that move forward in time: after any
/// two accepts, the second succeeds only if its price is at least as new as
/// the first, and the recorded time never goes back. Otherwise whoever sends
/// the instruction chooses the most favourable price of the last two
/// minutes.
///
/// Bounds: any recorded time and publish times from 0 to `u32::MAX` (the
/// year 2106). Outside that range `accept_price` clamps the time into it.
#[kani::proof]
#[kani::stub(PerpError::name, no_name)]
#[kani::stub(<PerpError as core::fmt::Display>::fmt, no_message)]
fn a_market_never_goes_back_to_an_older_price() {
    let mut m = blank_market();
    m.last_price_ts = kani::any();
    let first = OraclePrice { price: 1, conf: 0, published_ts: kani::any() };
    let second = OraclePrice { price: 1, conf: 0, published_ts: kani::any() };
    for t in [first.published_ts, second.published_ts] {
        kani::assume(t >= 0 && t <= u32::MAX as i64);
    }
    let start = m.last_price_ts;

    let first_ok = m.accept_price(&first).is_ok();
    let mid = m.last_price_ts;
    assert!(mid >= start);
    if !first_ok {
        assert_eq!(mid, start, "a refused price is not recorded");
    }
    let second_ok = m.accept_price(&second).is_ok();
    assert!(m.last_price_ts >= mid);
    if first_ok {
        assert_eq!(mid as i64, first.published_ts);
        assert_eq!(second_ok, second.published_ts >= first.published_ts);
    }
}

// ---------------------------------------------------------------------------
// Session caps
// ---------------------------------------------------------------------------

/// In any session and for any price source, the leverage a market allows
/// never exceeds the leverage it was listed with, and while the underlying's
/// market is closed never exceeds the closed-session ceiling either. The
/// closed session and the pool-depth cap may only tighten, which is what
/// lets a listing set its ceiling once and have every other rule stay under
/// it.
///
/// Bounds: every session, every price source, any leverage settings and any
/// depth reading.
#[kani::proof]
#[kani::stub(PerpError::name, no_name)]
#[kani::stub(<PerpError as core::fmt::Display>::fmt, no_message)]
fn leverage_caps_only_tighten() {
    let mut m = blank_market();
    m.session = kani::any();
    m.price_source = kani::any();
    kani::assume(m.session <= Session::Closed as u8);
    kani::assume(m.price_source <= PriceSource::Observed as u8);
    m.max_leverage_bps = kani::any();
    m.closed_session_leverage_bps = kani::any();
    m.depth_leverage_x = kani::any();

    let lev = m.effective_max_leverage_bps().unwrap();
    assert!(lev <= m.max_leverage_bps);
    if m.session == Session::Closed as u8 {
        assert!(lev <= m.closed_session_leverage_bps);
    }
    if m.price_source == PriceSource::Observed as u8 {
        // An observed market never gets more than its depth supports, and a
        // market with no reading yet gets the lowest tier, not the ceiling.
        let x = m.depth_leverage_x.max(DEPTH_LEVERAGE_TIERS[0].1) as u32;
        assert!(lev <= x * BPS as u32);
    }
}

// ---------------------------------------------------------------------------
// Funding
// ---------------------------------------------------------------------------

/// Skew funding moves money from the heavier side to the lighter one and
/// creates none: the heavy side's index rises, the light side's falls, and
/// what the light side is credited, across its whole size, is at most what
/// the heavy side is charged, short by less than one index unit per dollar
/// of the light side (the rounding of `recv`). Funding that paid out more
/// than it took would be a leak from the pool on every accrual.
///
/// Bounds: any funding sensitivity and any hourly rate cap, over each book
/// and elapsed time in `CASES` (long heavy, short heavy, balanced, ratios
/// that do and do not divide evenly; a second, a minute, an hour, the 8 hour
/// accrual cap, and a day that the cap clamps), borrow off (the next harness
/// covers it). Sizes and times are concrete because a size or a time
/// multiplied by an unknown rate is a product the solver does not get
/// through in useful time.
#[kani::proof]
#[kani::unwind(7)]
#[kani::solver(cadical)]
#[kani::stub(PerpError::name, no_name)]
#[kani::stub(<PerpError as core::fmt::Display>::fmt, no_message)]
fn skew_funding_is_paid_by_the_heavy_side_to_the_light_side() {
    const CASES: [(u64, u64, i64); 6] = [
        (7, 3, 1),
        (3, 7, 3_600),
        (5, 5, 600),
        (1_000_000, 1, MAX_FUNDING_ACCRUAL_SECONDS),
        (2, 1, 24 * SECONDS_PER_HOUR),
        (999, 1_000, 59),
    ];
    for (long_size, short_size, now) in CASES {
        let mut m = blank_market();
        m.long_size_usd = long_size;
        m.short_size_usd = short_size;
        m.funding_k_bps = kani::any();
        m.max_funding_rate_bps_per_hour = kani::any();

        m.accrue_funding(now, 0).unwrap();

        let (long, short) = (m.cumulative_long_funding, m.cumulative_short_funding);
        let (l, s) = (long_size as i128, short_size as i128);
        let (heavy_delta, light_delta, light) =
            if l >= s { (long, short, s) } else { (short, long, l) };
        assert!(heavy_delta >= 0 && light_delta <= 0);
        let net = long * l + short * s;
        assert!(net >= 0, "the light side never receives more than the heavy side pays");
        assert!(net < light, "and keeps back less than one unit per light dollar");
        if l == s {
            assert_eq!((long, short), (0, 0), "a balanced book pays no skew funding");
        }
    }
}

/// Borrow charges both sides the same per dollar, never credits either, and
/// is zero at zero utilization; and a crank that has not run for longer than
/// `MAX_FUNDING_ACCRUAL_SECONDS` accrues no more than that window. Both sides
/// rent the pool's balance sheet, and a clock gap must not wipe positions out
/// in one step.
///
/// Bounds: borrow rate up to 2^8 bps an hour, any utilization up to 100%,
/// any elapsed time, one side of the book empty so skew funding is off.
#[kani::proof]
#[kani::solver(cadical)]
#[kani::stub(PerpError::name, no_name)]
#[kani::stub(<PerpError as core::fmt::Display>::fmt, no_message)]
fn borrow_charges_both_sides_alike_and_is_capped_in_time() {
    let mut m = blank_market();
    m.borrow_rate_bps_per_hour = kani::any();
    kani::assume(m.borrow_rate_bps_per_hour <= 255);
    m.long_size_usd = kani::any();
    let util: u16 = kani::any();
    kani::assume(util as u128 <= BPS);
    let now: i64 = kani::any();

    m.accrue_funding(now, util).unwrap();

    let (long, short) = (m.cumulative_long_funding, m.cumulative_short_funding);
    assert_eq!(long, short);
    assert!(long >= 0);
    if util == 0 {
        assert_eq!(long, 0);
    }
    let window = m.borrow_rate_bps_per_hour as i128 * FUNDING_SCALE * MAX_FUNDING_ACCRUAL_SECONDS as i128
        / (BPS as i128 * SECONDS_PER_HOUR as i128);
    assert!(long <= window);
    assert_eq!(m.last_funding_ts, now);
}
