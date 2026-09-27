//! Orders and positions: the checks an open must pass before it is booked,
//! what booking an open and a close does to a position and the pool, how
//! liquidation decides and splits, and the per-wallet limit on a batch.
//!
//! The bounds: sizes, collateral, reserves and prices are drawn as u8 (0 to
//! 255) or narrower, and funding moves the index in quarter-steps, so a
//! position owes or earns a few units at most. Rates (leverage, margins, fee
//! shares, caps) are any value their type holds unless a harness narrows them
//! to what `MarketParams::validate` or `initialize_pool` accepts, and says so.
//! The properties are about ordering, exactness of the books, and which way
//! each floor rounds, none of which depends on magnitude. Harnesses that run
//! `settle` twice use 0 to 7.
//!
//! Every harness stubs the text of an Anchor error and the event log, as
//! `settlement.rs` does: no property reads either, and formatting them
//! symbolically is what makes a harness take minutes.

use crate::constants::*;
use crate::errors::PerpError;
use crate::instructions::liquidate::liquidation;
use crate::instructions::trade::{
    book_close, book_open, check_open, payable_usd, settle, Settlement,
};
use crate::auction::MAX_BATCH_ORDERS;
use crate::state::*;
use anchor_lang::prelude::Pubkey;

fn no_name(_: &PerpError) -> String {
    String::new()
}

fn no_message(_: &PerpError, _: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
    Ok(())
}

fn no_log(_: &[&[u8]]) {}

/// Stands in for anchor's `From<PerpError> for Error`, which the `?` on every
/// checked step goes through, as in `money.rs`: it keeps the error code and
/// skips building its text.
fn cheap_error(e: PerpError) -> anchor_lang::error::Error {
    anchor_lang::error::Error::from(
        anchor_lang::solana_program::program_error::ProgramError::Custom(u32::from(e)),
    )
}

/// A symbolic amount from 0 to 255, widened so the high bits are constant.
fn byte() -> u64 {
    kani::any::<u8>() as u64
}

/// A symbolic amount from 0 to 7.
fn tiny() -> u64 {
    (kani::any::<u8>() & 0x07) as u64
}

/// A pool with symbolic balances below 2^8. Fee shares are the documented
/// split (docs/fees.md: 20 percent protocol, 10 insurance, 10 chain) unless a
/// harness sets its own.
fn pool() -> Pool {
    Pool {
        bump: 0,
        vault_bump: 0,
        lp_mint_bump: 0,
        authority: Pubkey::default(),
        pending_authority: Pubkey::default(),
        usdc_mint: Pubkey::default(),
        usdc_vault: Pubkey::default(),
        lp_mint: Pubkey::default(),
        num_markets: 1,
        liquidity_usd: byte(),
        locked_usd: byte(),
        trader_collateral_usd: byte(),
        protocol_fees_usd: byte(),
        insurance_usd: byte(),
        insurance_fee_share_bps: 1_000,
        escrow_usd: byte(),
        chain_fee_destination: Pubkey::default(),
        chain_fees_usd: byte(),
        rewards_usd: 0,
        pyth_receiver: Pubkey::default(),
        add_liquidity_fee_bps: 0,
        remove_liquidity_fee_bps: 0,
        protocol_fee_share_bps: 2_000,
        max_utilization_bps: kani::any(),
        paused: false,
        backing_usd: byte(),
        num_custodies: 0,
        markets_with_oi: kani::any::<u8>() as u16,
        _reserved: [0; 3],
    }
}

/// A market with symbolic balances below 2^8, any session, any price source,
/// and rates as each harness sets them. No corporate action is in play: the
/// price factor is the one positions below are written under.
fn market() -> Market {
    let net_loss = kani::any::<i8>() as i64;
    Market {
        bump: 0,
        pool: Pubkey::default(),
        symbol: [0; 16],
        feed_id: [0; 32],
        max_price_age_sec: 60,
        max_conf_bps: 500,
        max_leverage_bps: kani::any(),
        maintenance_margin_bps: 500,
        liquidation_fee_bps: 100,
        open_fee_bps: 0,
        close_fee_bps: 0,
        min_position_usd: 1,
        max_oi_long_usd: byte(),
        max_oi_short_usd: byte(),
        pnl_reserve_bps: kani::any(),
        base_spread_bps: 4,
        conf_spread_mult_bps: 10_000,
        max_spread_bps: 500,
        session: kani::any::<u8>() % 3,
        closed_session_leverage_bps: kani::any(),
        closed_session_oi_mult_bps: kani::any(),
        cumulative_long_funding: 0,
        cumulative_short_funding: 0,
        last_funding_ts: 0,
        max_funding_rate_bps_per_hour: 100,
        funding_k_bps: 8_000,
        borrow_rate_bps_per_hour: 1,
        long_size_usd: byte(),
        long_avg_entry_price: byte(),
        short_size_usd: byte(),
        short_avg_entry_price: byte(),
        collateral_usd: byte(),
        price_factor: PRICE_FACTOR_ONE,
        split_epoch: 0,
        last_multiplier: MULTIPLIER_SCALE as u64,
        paused: false,
        price_source: kani::any::<u8>() & 1,
        observation: Pubkey::default(),
        deployer: Pubkey::default(),
        backing_usd: byte(),
        backing_shares: byte(),
        backing_drawn_usd: byte(),
        loss_budget_usd: byte(),
        net_loss_usd: net_loss,
        locked_usd: byte(),
        last_price_ts: 0,
        depth_leverage_x: kani::any::<u8>() & 0x0f,
        _reserved: [0; 2],
        volume_usd: 0,
        deployer_synced_volume_usd: 0,
        deployer_rewards_usd: 0,
        deployer_earned_usd: 0,
    }
}

fn empty_position(is_long: bool) -> Position {
    Position {
        bump: 0,
        owner: Pubkey::default(),
        market: Pubkey::default(),
        is_long,
        size_usd: 0,
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

/// Sets the funding index on `is_long`'s side to a symbolic quarter-step
/// from -2 to 2, and returns it.
fn any_index(m: &mut Market, is_long: bool) -> i128 {
    let k = (kani::any::<i8>() % 3) as i128;
    let index = k * (FUNDING_SCALE / 4);
    if is_long {
        m.cumulative_long_funding = index;
    } else {
        m.cumulative_short_funding = index;
    }
    index
}

/// A position that is either empty or open with symbolic size, collateral,
/// entry, lock and a funding index a quarter-step or two from the market's.
fn any_position(max: fn() -> u64) -> Position {
    let mut pos = empty_position(kani::any());
    pos.size_usd = max();
    pos.collateral_usd = max();
    pos.locked_usd = max();
    pos.entry_price = max();
    kani::assume(pos.entry_price >= 1);
    pos.entry_funding = (kani::any::<i8>() % 3) as i128 * (FUNDING_SCALE / 4);
    if !pos.is_open() {
        pos.collateral_usd = 0;
        pos.locked_usd = 0;
        pos.entry_price = 0;
        pos.entry_funding = 0;
    }
    pos
}

// ------------------------------------------------------------ check_open

/// Frees `m` of every limit but leverage, so the leverage harnesses spend
/// nothing on the others.
fn leverage_only(m: &mut Market) {
    m.max_oi_long_usd = u64::MAX;
    m.max_oi_short_usd = u64::MAX;
    m.pnl_reserve_bps = 0;
}

/// A fresh open that passes `check_open` is inside the market's leverage cap,
/// whatever the session and price source: the listed `max_leverage_bps`, and
/// while the underlying is closed also the closed-session cap. The ratio is
/// rounded down to whole bps, so the size can pass cap times collateral by
/// less than one bps of the collateral, never more. The plan is the fill and
/// the collateral as given. Bounds: size, collateral and price below 2^8, any
/// leverage caps.
#[kani::proof]
#[kani::stub(PerpError::name, no_name)]
#[kani::stub(<PerpError as core::fmt::Display>::fmt, no_message)]
#[kani::stub(anchor_lang::solana_program::log::sol_log_data, no_log)]
#[kani::stub(<anchor_lang::error::Error as core::convert::From<crate::errors::PerpError>>::from, cheap_error)]
#[kani::solver(cadical)]
fn an_accepted_open_is_inside_the_leverage_cap() {
    let mut p = pool();
    p.max_utilization_bps = BPS as u16;
    kani::assume(p.locked_usd <= p.liquidity_usd);
    let mut m = market();
    leverage_only(&mut m);
    let is_long: bool = kani::any();
    let pos = empty_position(is_long);
    let (net, size, fill) = (byte(), byte(), byte());

    if let Ok(plan) = check_open(&p, &m, &pos, is_long, net, size, fill) {
        let margin = net as u128;
        let grown = size as u128 * BPS;
        assert!(margin > 0);
        assert!(grown < (m.max_leverage_bps as u128 + 1) * margin);
        if m.session == Session::Closed as u8 {
            assert!(grown < (m.closed_session_leverage_bps as u128 + 1) * margin);
        }
        assert!(plan.new_size == size && plan.new_collateral == net && plan.new_entry == fill);
    }
}

/// Adding to a position is held to the same cap, measured on the grown size
/// against the collateral left after the funding the position owes so far
/// plus the new collateral: owed funding counts against the margin even though
/// it is not settled. An add to the other side is refused, so a position never
/// flips. The plan grows size and collateral by exactly what was added.
/// Bounds: sizes, collateral and prices 0 to 7; the funding index sits 0 to 2
/// quarter-steps either side of the entry, so the position owes or has
/// received up to half its size.
#[kani::proof]
#[kani::stub(PerpError::name, no_name)]
#[kani::stub(<PerpError as core::fmt::Display>::fmt, no_message)]
#[kani::stub(anchor_lang::solana_program::log::sol_log_data, no_log)]
#[kani::stub(<anchor_lang::error::Error as core::convert::From<crate::errors::PerpError>>::from, cheap_error)]
#[kani::solver(cadical)]
fn an_accepted_add_is_inside_the_leverage_cap_net_of_funding() {
    let mut p = pool();
    p.max_utilization_bps = BPS as u16;
    kani::assume(p.locked_usd <= p.liquidity_usd);
    let mut m = market();
    leverage_only(&mut m);
    let mut pos = empty_position(kani::any());
    pos.size_usd = tiny();
    pos.collateral_usd = tiny();
    pos.entry_price = tiny();
    kani::assume(pos.size_usd >= 1 && pos.entry_price >= 1);
    // Entry at quarter-step e, market now at quarter-step k, both in -2..=2.
    let e = kani::any::<i8>() % 3;
    let k = kani::any::<i8>() % 3;
    pos.entry_funding = e as i128 * (FUNDING_SCALE / 4);
    let is_long: bool = kani::any();
    if is_long {
        m.cumulative_long_funding = k as i128 * (FUNDING_SCALE / 4);
    } else {
        m.cumulative_short_funding = k as i128 * (FUNDING_SCALE / 4);
    }
    let (net, size, fill) = (tiny(), tiny(), tiny());

    let r = check_open(&p, &m, &pos, is_long, net, size, fill);
    if pos.is_long != is_long {
        assert!(r.is_err());
    }
    if let Ok(plan) = r {
        // Owed is (k - e) quarters of the size, truncated toward zero, as
        // `funding_owed_usd` computes it.
        let owed = (k as i64 - e as i64) * pos.size_usd as i64 / 4;
        let left = (pos.collateral_usd as i64 - owed).max(0) as u128;
        let margin = left + net as u128;
        let grown = (pos.size_usd + size) as u128 * BPS;
        assert!(margin > 0);
        assert!(grown < (m.max_leverage_bps as u128 + 1) * margin);
        if m.session == Session::Closed as u8 {
            assert!(grown < (m.closed_session_leverage_bps as u128 + 1) * margin);
        }
        assert!(plan.new_size == pos.size_usd + size);
        assert!(plan.new_collateral == pos.collateral_usd + net);
    }
}

/// An open that passes `check_open` leaves its side's open interest at or
/// under the listed cap, and while the underlying is closed under the cap
/// scaled by `closed_session_oi_mult_bps`. The other side's cap plays no part.
/// Bounds: sizes and caps below 2^8, any closed-session multiplier that
/// `MarketParams::validate` accepts.
#[kani::proof]
#[kani::stub(PerpError::name, no_name)]
#[kani::stub(<PerpError as core::fmt::Display>::fmt, no_message)]
#[kani::stub(anchor_lang::solana_program::log::sol_log_data, no_log)]
#[kani::stub(<anchor_lang::error::Error as core::convert::From<crate::errors::PerpError>>::from, cheap_error)]
#[kani::solver(cadical)]
fn an_accepted_open_is_inside_the_open_interest_cap() {
    let p = pool();
    let mut m = market();
    m.max_leverage_bps = u32::MAX;
    m.closed_session_leverage_bps = u32::MAX;
    m.price_source = PriceSource::Pyth as u8;
    // `MarketParams::validate` holds the multiplier to at most 100 percent;
    // past that the closed-session cap would be looser than the listed one.
    kani::assume(m.closed_session_oi_mult_bps as u128 <= BPS);
    let is_long: bool = kani::any();
    let pos = empty_position(is_long);
    let net = byte();
    let size = byte();

    if let Ok(plan) = check_open(&p, &m, &pos, is_long, net, size, 1) {
        let (was, cap) = if is_long {
            (m.long_size_usd, m.max_oi_long_usd)
        } else {
            (m.short_size_usd, m.max_oi_short_usd)
        };
        assert!(plan.side_oi == was + size);
        assert!(plan.side_oi <= cap);
        if m.session == Session::Closed as u8 {
            assert!(plan.side_oi as u128 * BPS <= cap as u128 * m.closed_session_oi_mult_bps as u128);
        }
    }
}

/// An open that passes `check_open` reserves exactly its size times the
/// market's PnL reserve rate, rounded down, and that reservation fits the
/// pool: locked stays within liquidity and within the utilization cap, with
/// no rounding in the pool's favour. Bounds: sizes and pool balances below
/// 2^8, any reserve rate and utilization cap.
#[kani::proof]
#[kani::stub(PerpError::name, no_name)]
#[kani::stub(<PerpError as core::fmt::Display>::fmt, no_message)]
#[kani::stub(anchor_lang::solana_program::log::sol_log_data, no_log)]
#[kani::stub(<anchor_lang::error::Error as core::convert::From<crate::errors::PerpError>>::from, cheap_error)]
#[kani::solver(cadical)]
fn an_accepted_open_reserves_its_share_and_fits_the_pool() {
    let p = pool();
    let mut m = market();
    m.max_leverage_bps = u32::MAX;
    m.closed_session_leverage_bps = u32::MAX;
    m.max_oi_long_usd = u64::MAX;
    m.max_oi_short_usd = u64::MAX;
    m.session = Session::Regular as u8;
    m.price_source = PriceSource::Pyth as u8;
    let is_long: bool = kani::any();
    let pos = empty_position(is_long);
    let size = byte();

    if let Ok(plan) = check_open(&p, &m, &pos, is_long, 1, size, 1) {
        let want = size as u128 * m.pnl_reserve_bps as u128;
        let lock = plan.extra_lock as u128;
        assert!(lock * BPS <= want && want < (lock + 1) * BPS);
        let locked = p.locked_usd as u128 + lock;
        assert!(locked <= p.liquidity_usd as u128);
        assert!(locked * BPS <= p.max_utilization_bps as u128 * p.liquidity_usd as u128);
    }
}

// ------------------------------------------------------------ book_open

/// What booking an open does to the lines it touches, exactly: the position,
/// the pool and the market each lock the same reserve, no more than the
/// fill; the position's size and collateral grow by the fill and its
/// collateral, the pool's and the market's collateral lines by the same, and
/// the side's open interest by the fill while the other side's does not move.
/// The position stays on its side.
fn assert_open_booked(
    before: (&Pool, &Market, &Position),
    after: (&Pool, &Market, &Position),
    is_long: bool,
    net: u64,
    size: u64,
) {
    let ((p0, m0, pos0), (p, m, pos)) = (before, after);
    let lock = pos.locked_usd - pos0.locked_usd;
    assert!(p.locked_usd - p0.locked_usd == lock);
    assert!(m.locked_usd - m0.locked_usd == lock);
    assert!(lock <= size);
    assert!(pos.is_long == is_long);
    assert!(pos.size_usd == pos0.size_usd + size);
    assert!(pos.collateral_usd == pos0.collateral_usd + net);
    assert!(p.trader_collateral_usd == p0.trader_collateral_usd + net);
    assert!(m.collateral_usd == m0.collateral_usd + net);
    if is_long {
        assert!(m.long_size_usd == m0.long_size_usd + size);
        assert!(m.short_size_usd == m0.short_size_usd);
    } else {
        assert!(m.short_size_usd == m0.short_size_usd + size);
        assert!(m.long_size_usd == m0.long_size_usd);
    }
}

/// Anything `check_open` accepts, `book_open` books. Settlement relies on
/// this: it asks `check_open` first and sends a refused open home unfilled,
/// and a `book_open` that failed after that would hold the sealed batch. What
/// it books is exact (see `assert_open_booked`), and a new position records
/// the fill as its entry and the market's current funding index as its own.
/// Bounds: amounts and prices below 2^8, any reserve rate up to 100 percent,
/// funding a quarter-step or two, no open fee (the harness after next).
#[kani::proof]
#[kani::stub(PerpError::name, no_name)]
#[kani::stub(<PerpError as core::fmt::Display>::fmt, no_message)]
#[kani::stub(anchor_lang::solana_program::log::sol_log_data, no_log)]
#[kani::stub(<anchor_lang::error::Error as core::convert::From<crate::errors::PerpError>>::from, cheap_error)]
#[kani::solver(cadical)]
fn an_accepted_open_always_books_exactly() {
    let mut p = pool();
    let mut m = market();
    kani::assume(m.pnl_reserve_bps as u128 <= BPS);
    let is_long: bool = kani::any();
    let index = any_index(&mut m, is_long);
    let mut pos = empty_position(is_long);
    let (net, size, fill) = (byte(), byte(), byte());
    kani::assume(check_open(&p, &m, &pos, is_long, net, size, fill).is_ok());
    let (p0, m0, pos0) = (p.clone(), m.clone(), pos.clone());

    let r = book_open(&mut p, &mut m, &mut pos, Pubkey::default(), 0, is_long, net, 0,
        Pubkey::default(), size, fill, 1);
    assert!(r.is_ok());
    assert_open_booked((&p0, &m0, &pos0), (&p, &m, &pos), is_long, net, size);
    assert!(pos.entry_price == fill && pos.entry_funding == index);
}

/// Adding to a position books exactly as opening one does, and blends: the
/// new entry price lies between the old entry and the fill, and the new
/// funding index between the old one and the market's, so the size already
/// held keeps owing its funding from where it started and the new size owes
/// from now. Bounds: amounts and prices 0 to 7, a 50 percent reserve rate,
/// funding a quarter-step or two either way.
#[kani::proof]
#[kani::stub(PerpError::name, no_name)]
#[kani::stub(<PerpError as core::fmt::Display>::fmt, no_message)]
#[kani::stub(anchor_lang::solana_program::log::sol_log_data, no_log)]
#[kani::stub(<anchor_lang::error::Error as core::convert::From<crate::errors::PerpError>>::from, cheap_error)]
#[kani::solver(cadical)]
fn an_add_books_exactly_and_blends_between() {
    let mut p = pool();
    let mut m = market();
    // The reserve rate is the fresh-open harness's subject; one rate here.
    m.pnl_reserve_bps = 5_000;
    let mut pos = any_position(tiny);
    kani::assume(pos.is_open());
    let is_long = pos.is_long;
    let index = any_index(&mut m, is_long);
    let (net, size, fill) = (tiny(), tiny(), tiny());
    let (p0, m0, pos0) = (p.clone(), m.clone(), pos.clone());

    if book_open(&mut p, &mut m, &mut pos, Pubkey::default(), 0, is_long, net, 0,
        Pubkey::default(), size, fill, 1).is_ok()
    {
        assert_open_booked((&p0, &m0, &pos0), (&p, &m, &pos), is_long, net, size);
        let (lo, hi) = (pos0.entry_price.min(fill), pos0.entry_price.max(fill));
        assert!(lo <= pos.entry_price && pos.entry_price <= hi);
        let (lo, hi) = (pos0.entry_funding.min(index), pos0.entry_funding.max(index));
        assert!(lo <= pos.entry_funding && pos.entry_funding <= hi);
    }
}

/// The open fee is booked exactly once and in full: the pool's own lines
/// (protocol and chain fees, insurance, backing, LP liquidity) grow by
/// precisely the fee, however it is split and whether or not the market has
/// backers. The fee was paid into the vault on top of the collateral, so any
/// other total would leave the vault and the books apart. Bounds: fees below
/// 2^8, any backing, the documented fee split.
#[kani::proof]
#[kani::stub(PerpError::name, no_name)]
#[kani::stub(<PerpError as core::fmt::Display>::fmt, no_message)]
#[kani::stub(anchor_lang::solana_program::log::sol_log_data, no_log)]
#[kani::stub(<anchor_lang::error::Error as core::convert::From<crate::errors::PerpError>>::from, cheap_error)]
#[kani::solver(cadical)]
fn an_open_fee_is_booked_exactly_once() {
    let mut p = pool();
    let mut m = market();
    m.max_leverage_bps = u32::MAX;
    m.closed_session_leverage_bps = u32::MAX;
    m.max_oi_long_usd = u64::MAX;
    m.max_oi_short_usd = u64::MAX;
    m.pnl_reserve_bps = 0;
    let is_long: bool = kani::any();
    let mut pos = empty_position(is_long);
    let fee = byte();
    let lines = |p: &Pool| {
        p.protocol_fees_usd as u128
            + p.chain_fees_usd as u128
            + p.insurance_usd as u128
            + p.backing_usd as u128
            + p.liquidity_usd as u128
    };
    let before = lines(&p);
    let backing = m.backing_usd;

    if let Ok(to_backers) = book_open(&mut p, &mut m, &mut pos, Pubkey::default(), 0, is_long,
        1, fee, Pubkey::default(), 1, 1, 1)
    {
        assert!(lines(&p) == before + fee as u128);
        assert!(m.backing_usd - backing == to_backers);
        assert!(to_backers <= fee);
    }
}

// ------------------------------------------------------------ liquidation

/// Any settled position, as `liquidate` would see it.
fn any_settlement() -> Settlement {
    let pnl = kani::any::<i16>() as i64;
    Settlement {
        collateral_share: byte(),
        locked_release: byte(),
        pnl_usd: pnl,
        funding_usd: 0,
        equity_usd: kani::any::<u16>() as u64 & 0x1ff,
    }
}

/// A position may be liquidated exactly when its equity is below its
/// maintenance margin: every unhealthy position can be, and no healthy one
/// can, at any maintenance rate. Bounds: size below 2^8, equity below 2^9.
#[kani::proof]
#[kani::stub(PerpError::name, no_name)]
#[kani::stub(<PerpError as core::fmt::Display>::fmt, no_message)]
#[kani::stub(anchor_lang::solana_program::log::sol_log_data, no_log)]
#[kani::stub(<anchor_lang::error::Error as core::convert::From<crate::errors::PerpError>>::from, cheap_error)]
#[kani::solver(cadical)]
fn only_a_position_under_maintenance_is_liquidated() {
    let p = pool();
    let mut m = market();
    m.maintenance_margin_bps = kani::any();
    // The fee plays no part in the decision; with none, its split folds away.
    m.liquidation_fee_bps = 0;
    let s = any_settlement();
    let size = byte();

    let r = liquidation(&p, &m, &s, size);
    // equity < floor(size * rate / BPS), without a division.
    let under = (s.equity_usd as u128 + 1) * BPS <= size as u128 * m.maintenance_margin_bps as u128;
    assert!(r.is_ok() == under);
}

/// A liquidation pays the liquidator no more than the market's liquidation
/// fee, `liquidation_fee_bps` of the size, and the fee itself comes out of the
/// position's payable equity, never out of LP capital. The liquidator's share
/// is the documented one (docs/fees.md): the 60 percent of the fee the LPs
/// would have had, give or take the rounding of the three cuts. The split adds
/// up with nothing underflowing: the fee and the owner's remainder are what
/// the position may be paid, and what leaves the vault is the bounty plus the
/// remainder. With `a_forced_close_moves_exactly_the_payout_out_of_the_vault`
/// and `fee_cuts_move_money_without_creating_any` in settlement.rs, which
/// cover the two calls `liquidate` makes with these numbers, the books fall
/// by exactly the two transfers. Bounds: size and equity below 2^8, any fee rate, the documented
/// split. The maintenance rate is 100 percent so every settlement below its
/// size is liquidatable; which ones are is the harness above.
#[kani::proof]
#[kani::stub(PerpError::name, no_name)]
#[kani::stub(<PerpError as core::fmt::Display>::fmt, no_message)]
#[kani::stub(anchor_lang::solana_program::log::sol_log_data, no_log)]
#[kani::stub(<anchor_lang::error::Error as core::convert::From<crate::errors::PerpError>>::from, cheap_error)]
#[kani::solver(cadical)]
fn a_liquidator_is_paid_at_most_the_fee() {
    let p = pool();
    let mut m = market();
    m.maintenance_margin_bps = BPS as u16;
    m.liquidation_fee_bps = kani::any();
    let mut s = any_settlement();
    s.equity_usd = byte();
    let size = byte();

    if let Ok(l) = liquidation(&p, &m, &s, size) {
        let payable = payable_usd(&m, &s);
        let (fee, bounty) = (l.fee as u128, l.bounty as u128);
        assert!(fee * BPS <= size as u128 * m.liquidation_fee_bps as u128);
        assert!(l.bounty <= l.fee && l.fee <= payable);
        assert!(bounty * BPS >= fee * 6_000 && bounty * BPS < fee * 6_000 + 3 * BPS);
        assert!(l.fee + l.to_owner == payable);
        assert!(l.payout == l.bounty + l.to_owner);
        assert!(l.payout <= s.equity_usd);
    }
}

/// A liquidation costs the pool nothing past the position's collateral unless
/// the position is in profit, and then no more than that profit and no more
/// than the market's remaining loss budget. An underwater position, the usual
/// case, leaves the pool its collateral less what the owner and liquidator
/// take, and never draws on LPs. Bounds: size, equity and collateral below
/// 2^8, the listed 1 percent fee, a 100 percent maintenance rate so that
/// every settlement below its size is liquidatable.
#[kani::proof]
#[kani::stub(PerpError::name, no_name)]
#[kani::stub(<PerpError as core::fmt::Display>::fmt, no_message)]
#[kani::stub(anchor_lang::solana_program::log::sol_log_data, no_log)]
#[kani::stub(<anchor_lang::error::Error as core::convert::From<crate::errors::PerpError>>::from, cheap_error)]
#[kani::solver(cadical)]
fn a_liquidation_costs_the_pool_at_most_the_profit_and_the_budget() {
    let p = pool();
    let mut m = market();
    m.maintenance_margin_bps = BPS as u16;
    let mut s = any_settlement();
    s.equity_usd = byte();
    let size = byte();

    if let Ok(l) = liquidation(&p, &m, &s, size) {
        let cost = l.payout.saturating_sub(s.collateral_share);
        assert!(cost <= s.equity_usd.saturating_sub(s.collateral_share));
        assert!(cost <= m.remaining_budget_usd());
        if s.equity_usd <= s.collateral_share {
            assert!(l.payout <= s.collateral_share);
        }
    }
}

// ------------------------------------------------------------ the batch

/// No wallet holds more than `MAX_ORDERS_PER_OWNER` (4) live orders in a
/// batch. An insert for a wallet already at the limit is refused, one below
/// it lands in a slot that was free, and nothing else in the batch changes.
/// This is what makes filling a batch to block other traders cost many funded
/// wallets rather than one. The 64 slots are each free or live and belong to
/// the inserting wallet or someone else, in any combination.
#[kani::proof]
#[kani::stub(PerpError::name, no_name)]
#[kani::stub(<PerpError as core::fmt::Display>::fmt, no_message)]
#[kani::stub(anchor_lang::solana_program::log::sol_log_data, no_log)]
#[kani::stub(<anchor_lang::error::Error as core::convert::From<crate::errors::PerpError>>::from, cheap_error)]
#[kani::unwind(66)]
#[kani::solver(cadical)]
fn no_wallet_holds_more_than_four_orders_in_a_batch() {
    let me = Pubkey::new_from_array([1; 32]);
    let other = Pubkey::new_from_array([2; 32]);
    let mut b: Batch = bytemuck::Zeroable::zeroed();
    let mut mine = [false; MAX_BATCH_ORDERS];
    let mut live = [false; MAX_BATCH_ORDERS];
    let mut mine_before = 0usize;
    for j in 0..MAX_BATCH_ORDERS {
        mine[j] = kani::any();
        live[j] = kani::any();
        b.orders[j].owner = if mine[j] { me } else { other };
        b.orders[j].active = live[j] as u8;
        if live[j] && mine[j] {
            mine_before += 1;
        }
    }
    let new = BatchOrder {
        owner: me,
        price: 7,
        size_usd: 1,
        collateral_usd: 0,
        is_bid: 1,
        filled_usd: 0,
        active: 1,
        reduce_only: 0,
        is_maker: 0,
        _pad: [0; 4],
    };

    match b.insert(new) {
        Ok(i) => {
            let i = i as usize;
            assert!(mine_before < MAX_ORDERS_PER_OWNER);
            assert!(!live[i]);
            // The marker price says the whole new order landed in slot `i`.
            assert!(b.orders[i].price == 7);
            assert!(b.orders[i].active == 1);
            // Compared as bytes: `Pubkey ==` on this slot reports spurious
            // failures under the model checker, though the same comparison
            // inside `insert` is exact (the count assertions above would
            // catch it if it were not).
            assert!(b.orders[i].owner.to_bytes() == [1; 32]);
            for j in 0..MAX_BATCH_ORDERS {
                if j != i {
                    assert!(b.orders[j].price == 0);
                    assert!(b.orders[j].active == live[j] as u8);
                }
            }
        }
        Err(_) => {
            assert!(mine_before >= MAX_ORDERS_PER_OWNER || live.iter().all(|l| *l));
        }
    }
}
