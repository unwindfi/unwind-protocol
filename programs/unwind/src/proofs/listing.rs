//! Listing: what a permissionless listing may ask for, what the authority may
//! set afterwards, and how a pool's measured depth turns into the leverage and
//! the loss budget an observed market may carry.
//!
//! The bounds: the validation harnesses take every parameter they read as a
//! full-width symbolic value (u16, u32, u64), because validation only
//! compares, apart from one u128 division by the leverage. The depth
//! harnesses take any u64 depth and any i64 time. Nothing here is bounded
//! below its type unless the harness says so.
//!
//! Harnesses that can reach an `Err` stub the two text builders of the error
//! (`no_name`, `no_message`), as budget.rs does: no property reads the text,
//! and formatting it symbolically costs minutes.
//!
//! The observation fold, seasoning itself and the oracle rescale are in
//! feeds.rs; this file uses `is_seasoned` only as the gate on cutting a
//! budget.

use crate::constants::*;
use crate::errors::PerpError;
use crate::instructions::admin::{CustodyParams, MarketParams, PoolParams};
use crate::instructions::observe::depth_capped_budget;
use crate::state::{Observation, SourceKind};
use anchor_lang::prelude::Pubkey;

fn no_name(_: &PerpError) -> String {
    String::new()
}

fn no_message(_: &PerpError, _: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
    Ok(())
}

/// Every field `validate` or `validate_listing` reads is symbolic. The rest
/// (symbol, feed id, observation account) is never read by either.
fn any_market_params() -> MarketParams {
    MarketParams {
        symbol: [0; 16],
        feed_id: [0; 32],
        max_price_age_sec: kani::any(),
        max_conf_bps: kani::any(),
        max_leverage_bps: kani::any(),
        maintenance_margin_bps: kani::any(),
        liquidation_fee_bps: kani::any(),
        open_fee_bps: kani::any(),
        close_fee_bps: kani::any(),
        min_position_usd: kani::any(),
        max_oi_long_usd: kani::any(),
        max_oi_short_usd: kani::any(),
        pnl_reserve_bps: kani::any(),
        base_spread_bps: kani::any(),
        conf_spread_mult_bps: kani::any(),
        max_spread_bps: kani::any(),
        closed_session_leverage_bps: kani::any(),
        closed_session_oi_mult_bps: kani::any(),
        max_funding_rate_bps_per_hour: kani::any(),
        funding_k_bps: kani::any(),
        borrow_rate_bps_per_hour: kani::any(),
        price_source: kani::any(),
        observation: Pubkey::default(),
    }
}

/// The consistency rules `validate` documents, written out independently of
/// it: a position opened at the maximum leverage starts with more margin than
/// maintenance (initial margin is 1 / leverage, in bps), a liquidation fee
/// fits inside maintenance, the spread cap is above its floor, and the rates
/// that are fractions stay fractions.
fn consistent(p: &MarketParams) -> bool {
    let bps = BPS as u64;
    p.max_leverage_bps > 0
        && p.max_price_age_sec > 0
        && p.pnl_reserve_bps > 0
        && p.maintenance_margin_bps > 0
        && (p.maintenance_margin_bps as u64) < bps
        // initial margin > maintenance, i.e. BPS*BPS / lev > mm, without
        // dividing: floor(a / l) > m  exactly when  a >= (m + 1) * l.
        && (BPS * BPS) >= (p.maintenance_margin_bps as u128 + 1) * p.max_leverage_bps as u128
        && p.max_spread_bps >= p.base_spread_bps
        && (p.max_conf_bps as u64) < bps
        && (p.closed_session_oi_mult_bps as u64) <= bps
        && p.liquidation_fee_bps < p.maintenance_margin_bps
}

/// The listing bounds from constants.rs, written out independently of
/// `validate_listing`.
fn within_listing_bounds(p: &MarketParams) -> bool {
    p.max_leverage_bps <= LISTING_MAX_LEVERAGE_BPS
        && p.closed_session_leverage_bps <= p.max_leverage_bps
        && p.max_oi_long_usd >= LISTING_MIN_OI_USD
        && p.max_oi_long_usd <= LISTING_MAX_OI_USD
        && p.max_oi_short_usd >= LISTING_MIN_OI_USD
        && p.max_oi_short_usd <= LISTING_MAX_OI_USD
        && p.max_price_age_sec <= LISTING_MAX_PRICE_AGE_SEC
        && p.max_conf_bps <= LISTING_MAX_CONF_BPS
        && p.open_fee_bps >= LISTING_MIN_FEE_BPS
        && p.open_fee_bps <= LISTING_MAX_FEE_BPS
        && p.close_fee_bps >= LISTING_MIN_FEE_BPS
        && p.close_fee_bps <= LISTING_MAX_FEE_BPS
        && p.maintenance_margin_bps >= LISTING_MIN_MAINTENANCE_BPS
        && p.pnl_reserve_bps >= LISTING_MIN_PNL_RESERVE_BPS
        && p.base_spread_bps >= LISTING_MIN_BASE_SPREAD_BPS
        && p.min_position_usd >= LISTING_MIN_POSITION_USD
        && p.max_funding_rate_bps_per_hour <= LISTING_MAX_FUNDING_RATE_BPS_PER_HOUR
}

/// An observation whose depth state is any value, for the crank harnesses.
/// Only `sustained_depth_usd` and `depth_rise_ts` are read by `track_depth`.
fn any_depth_state() -> Observation {
    Observation {
        bump: 0,
        market: Pubkey::default(),
        source: Pubkey::default(),
        source_kind: SourceKind::RaydiumClmm as u8,
        quote_is_token_0: false,
        ewma_price: 0,
        last_spot: 0,
        last_update_ts: 0,
        first_update_ts: 0,
        observations: 0,
        alpha_bps: 500,
        max_move_bps: 100,
        depth_usd: 0,
        dec_x: 0,
        dec_y: 0,
        unit_exp: 0,
        sustained_depth_usd: kani::any(),
        depth_rise_ts: kani::any(),
        keeper_priced: false,
        _reserved: [0; 11],
    }
}

// ---------------------------------------------------------------------------
// Market parameters
// ---------------------------------------------------------------------------

/// `validate`, the check every market passes at listing and on every
/// `update_market_params`, accepts exactly the consistent parameter sets. In
/// particular no accepted set lets a position opened at the market's maximum
/// leverage start at or below maintenance margin (it would be liquidatable
/// the moment it opened), or charge a liquidation fee larger than the margin
/// it is taken from. And every consistent set is accepted, so the authority
/// is held to consistency and nothing else.
///
/// Bounds: every field full width.
#[kani::proof]
#[kani::stub(PerpError::name, no_name)]
#[kani::stub(<PerpError as core::fmt::Display>::fmt, no_message)]
#[kani::solver(cadical)]
fn validate_accepts_exactly_the_consistent_markets() {
    let p = any_market_params();
    assert_eq!(p.validate().is_ok(), consistent(&p));
}

/// A market listed by anyone but the authority is accepted exactly when it is
/// consistent and inside every listing bound: at most 5x, a closed-session
/// leverage no higher than the market's own, open interest per side between
/// 1,000 and 50,000 USDC, fees of 10 to 100 bps, a price at most 120 seconds
/// old, and the floors on maintenance, PnL reserve, spread and position size.
/// A hand-built transaction gets nothing the site would not give it, and the
/// site's own listing is never refused for a reason it cannot see.
///
/// Bounds: every field full width.
#[kani::proof]
#[kani::stub(PerpError::name, no_name)]
#[kani::stub(<PerpError as core::fmt::Display>::fmt, no_message)]
#[kani::solver(cadical)]
fn validate_listing_accepts_exactly_the_listing_bounds() {
    let p = any_market_params();
    assert_eq!(
        p.validate_listing().is_ok(),
        consistent(&p) && within_listing_bounds(&p)
    );
}

/// No depth reading can lift a permissionless market past the leverage it
/// was listed with, nor past 5x: the depth tiers top out at the listing cap,
/// and the market's own ceiling, which `validate_listing` holds to that cap,
/// bounds them again. This is the chain `effective_max_leverage_bps` relies
/// on: min(listed, depth tier) is at most 5x for every listed market.
///
/// Bounds: every depth.
#[kani::proof]
fn no_depth_tier_passes_the_listing_cap() {
    let depth: u64 = kani::any();
    let x = leverage_for_depth(depth) as u32;
    assert!(x * BPS as u32 <= LISTING_MAX_LEVERAGE_BPS);
    assert!(x >= DEPTH_LEVERAGE_TIERS[0].1 as u32);
}

// ---------------------------------------------------------------------------
// Pool and custody parameters
// ---------------------------------------------------------------------------

/// `initialize_pool` accepts exactly the pools whose fee shares, together
/// with the chain's fixed share, fit inside one fee, whose utilization cap is
/// at most the whole pool, and whose deposit and withdrawal fees are under
/// 100 percent. The fee-split proofs in settlement.rs assume the first of
/// these (`any_pool`); this is where the program enforces it.
///
/// Bounds: every field full width.
#[kani::proof]
#[kani::stub(PerpError::name, no_name)]
#[kani::stub(<PerpError as core::fmt::Display>::fmt, no_message)]
fn pool_params_accept_exactly_a_split_that_fits_the_fee() {
    let p = PoolParams {
        pyth_receiver: Pubkey::default(),
        chain_fee_destination: Pubkey::default(),
        add_liquidity_fee_bps: kani::any(),
        remove_liquidity_fee_bps: kani::any(),
        protocol_fee_share_bps: kani::any(),
        insurance_fee_share_bps: kani::any(),
        max_utilization_bps: kani::any(),
    };
    let fits = p.protocol_fee_share_bps as u64
        + p.insurance_fee_share_bps as u64
        + CHAIN_FEE_SHARE_BPS as u64
        <= 10_000
        && p.max_utilization_bps <= 10_000
        && p.add_liquidity_fee_bps < 10_000
        && p.remove_liquidity_fee_bps < 10_000;
    assert_eq!(p.validate().is_ok(), fits);
}

/// A custody the pool accepts never counts a token for more than its value
/// toward a market's budget (weight at most 10,000 bps), and a token priced by
/// an oracle always has a nonzero staleness and confidence limit, so it is
/// never valued off a price of any age or any width. Every such custody is
/// accepted.
///
/// Bounds: every field full width.
#[kani::proof]
#[kani::stub(PerpError::name, no_name)]
#[kani::stub(<PerpError as core::fmt::Display>::fmt, no_message)]
fn custody_params_never_count_a_token_above_its_value() {
    let p = CustodyParams {
        is_stable: kani::any(),
        feed_id: [0; 32],
        max_price_age_sec: kani::any(),
        max_conf_bps: kani::any(),
        budget_weight_bps: kani::any(),
    };
    let sound = p.budget_weight_bps <= 10_000
        && (p.is_stable || (p.max_price_age_sec > 0 && p.max_conf_bps > 0));
    assert_eq!(p.validate().is_ok(), sound);
}

// ---------------------------------------------------------------------------
// Depth to leverage
// ---------------------------------------------------------------------------

/// More sustained depth never lowers the leverage tier. `observe` writes the
/// tier onto the market on every crank, so a pool that deepens can only keep
/// or raise its market's leverage, and one that thins can only keep or lower
/// it.
///
/// Bounds: every pair of depths.
#[kani::proof]
fn leverage_never_falls_as_depth_grows() {
    let a: u64 = kani::any();
    let b: u64 = kani::any();
    kani::assume(a <= b);
    assert!(leverage_for_depth(a) <= leverage_for_depth(b));
}

/// Each depth gets exactly the tier of the highest floor it clears, as the
/// table in docs/margining.md lists: under 10,000 USD 2x, to 50,000 3x, to
/// 250,000 4x, and 5x above. Pins the loop in `leverage_for_depth` to the
/// documented table rather than to a table in the same order.
///
/// Bounds: every depth.
#[kani::proof]
fn leverage_is_the_documented_tier() {
    let d: u64 = kani::any();
    let k = 1_000 * USD_SCALE as u64;
    let want = if d < 10 * k {
        2
    } else if d < 50 * k {
        3
    } else if d < 250 * k {
        4
    } else {
        5
    };
    assert_eq!(leverage_for_depth(d), want);
}

/// After any crank, the leverage written to the market is no higher than the
/// reading itself supports: sustained depth never rises past the reading it
/// is moving toward. And a reading at or below the sustained depth becomes
/// the sustained depth at once, so a thinning pool lowers the market's tier
/// on that same crank, before the next order is accepted (docs/margining.md).
///
/// Bounds: any sustained depth, any last-rise time, any reading, any time.
#[kani::proof]
fn a_crank_never_grants_more_leverage_than_its_reading() {
    let mut o = any_depth_state();
    let before = o.sustained_depth_usd;
    let reading: u64 = kani::any();
    let now: i64 = kani::any();

    o.track_depth(reading, now);

    assert!(o.sustained_depth_usd <= before.max(reading));
    assert!(leverage_for_depth(o.sustained_depth_usd) <= leverage_for_depth(reading));
    if reading <= before {
        assert_eq!(o.sustained_depth_usd, reading);
    }
}

/// A rise in sustained depth is at most a tenth of the gap to the reading,
/// or one unit when a tenth rounds to nothing, so a rise always moves and
/// never jumps to the reading.
///
/// Bounds: any sustained depth, any last-rise time, any time, and a reading
/// up to 2^24 units above the sustained depth (about 16 USD; drawn narrow and
/// widened so the solver can fold the high bits of the u128 division away).
/// The rounding of a tenth does not depend on the size of the gap, and
/// `a_crank_never_grants_more_leverage_than_its_reading` covers every gap for
/// the weaker bound of the rise never passing the reading.
#[kani::proof]
#[kani::solver(cadical)]
fn a_rise_is_at_most_a_tenth_of_the_gap() {
    let mut o = any_depth_state();
    let s0 = o.sustained_depth_usd;
    let gap = (kani::any::<u32>() & 0x00ff_ffff) as u64;
    kani::assume(s0 <= u64::MAX - gap);
    o.track_depth(s0 + gap, kani::any());
    let rise = o.sustained_depth_usd - s0;
    if rise > 0 {
        assert!(rise == 1 || rise * 10 <= gap);
    }
}

/// A rise happens at most once per twenty seconds: a second crank inside that
/// interval, whatever it reads, cannot raise sustained depth or leverage
/// again. A burst of cranks in one transaction therefore counts parked
/// liquidity once, not thirty times.
///
/// Bounds: any sustained depth, two readings of any size, times from 0 to
/// 2^40 seconds (about 35,000 years; the cap keeps `saturating_add` from
/// clamping at the end of i64, which no clock reaches), the second crank up
/// to 19 seconds after the first.
#[kani::proof]
fn a_burst_of_cranks_rises_at_most_once() {
    let mut o = any_depth_state();
    kani::assume(o.depth_rise_ts >= 0 && o.depth_rise_ts < 1 << 40);
    let s0 = o.sustained_depth_usd;
    let r1: u64 = kani::any();
    let r2: u64 = kani::any();
    let t1: i64 = kani::any();
    let dt: u8 = kani::any();
    kani::assume(dt < DEPTH_RISE_MIN_INTERVAL_SEC as u8);
    kani::assume(t1 >= 0 && t1 < 1 << 40);

    o.track_depth(r1, t1);
    let s1 = o.sustained_depth_usd;

    o.track_depth(r2, t1 + dt as i64);
    if s1 > s0 {
        // A rise just landed at t1, so the second crank can only hold or fall.
        assert!(o.sustained_depth_usd <= s1);
        assert!(leverage_for_depth(o.sustained_depth_usd) <= leverage_for_depth(s1));
    }
}

/// One crank from any state raises the leverage tier by at most one step, so
/// liquidity parked for a single crank cannot lift a market to the top tier
/// (docs/margining.md). This failed before each rise was capped at the next
/// tier's floor: a fresh market cranked once while 2,500,000 USD was parked
/// in its pool rose to 250,000 USD of sustained depth and was written 5x, and
/// the liquidity could be added and removed around the crank in one
/// transaction (a flash loan is enough).
///
/// Bounds: any state, any reading, any time.
#[kani::proof]
fn one_crank_raises_leverage_by_at_most_one_tier() {
    let mut o = any_depth_state();
    let before = leverage_for_depth(o.sustained_depth_usd);
    o.track_depth(kani::any(), kani::any());
    assert!(leverage_for_depth(o.sustained_depth_usd) <= before + 1);
}

// ---------------------------------------------------------------------------
// Depth to loss budget
// ---------------------------------------------------------------------------

/// `derive_market_budget`, which anyone may call, can only cut a budget and
/// only to the pool's measured depth: it succeeds exactly when the mark is
/// seasoned and the depth is below the current budget, and then the new
/// budget is the depth. It never raises a budget (docs/loss-budget.md: depth
/// is temporarily purchasable, so no account may raise a budget from it), and
/// an unseasoned mark, whose depth has no history behind it, cuts nothing.
///
/// Bounds: every depth and budget, seasoned or not.
#[kani::proof]
#[kani::stub(PerpError::name, no_name)]
#[kani::stub(<PerpError as core::fmt::Display>::fmt, no_message)]
fn a_derived_budget_only_ever_cuts_to_depth() {
    let seasoned: bool = kani::any();
    let depth: u64 = kani::any();
    let budget: u64 = kani::any();
    match depth_capped_budget(seasoned, depth, budget) {
        Ok(new) => {
            assert!(seasoned);
            assert_eq!(new, depth);
            assert!(new < budget);
        }
        Err(_) => assert!(!seasoned || depth >= budget),
    }
}

/// More measured depth never leaves a market with a smaller budget after a
/// cut: whatever budget the market has, the budget it is left with, cut or
/// not, never falls as depth grows, and never exceeds either the depth or
/// what it had. So the budget a pool's liquidity supports is monotone in that
/// liquidity, and the cut never takes more than the depth justifies.
///
/// Bounds: every pair of depths and every budget, on a seasoned mark.
#[kani::proof]
#[kani::stub(PerpError::name, no_name)]
#[kani::stub(<PerpError as core::fmt::Display>::fmt, no_message)]
fn a_deeper_pool_never_leaves_a_smaller_budget() {
    let a: u64 = kani::any();
    let b: u64 = kani::any();
    let budget: u64 = kani::any();
    kani::assume(a <= b);
    // Refusal leaves the budget as it was.
    let left = |d: u64| depth_capped_budget(true, d, budget).unwrap_or(budget);
    let (la, lb) = (left(a), left(b));
    assert!(la <= lb);
    assert!(la <= budget && lb <= budget);
    assert!(la == budget || la == a);
}
