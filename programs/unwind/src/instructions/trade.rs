use crate::constants::*;
use crate::errors::PerpError;
use crate::math::*;
use crate::state::*;
use anchor_lang::prelude::*;

// No oracle import, and no token accounts. Nothing in this file reads a price
// or moves a lamport any more: it books what a clearing decided, and the
// callers in `batch.rs` bring both the price and the vault.

/*
 * The `Trade` account context was here, along with `check_slippage`.
 *
 * Both existed for instructions a trader called directly with a price in hand
 * -- `open_position` and `close_position`. Neither survives: an order is a
 * limit into a batch, and a limit is already a slippage bound, checked by the
 * clearing rather than against an oracle read. `SubmitOrder` and `SettleOrder`
 * in `batch.rs` carry the accounts now.
 */

/// What an open will do to a position and the market, worked out before
/// anything is written.
pub struct OpenPlan {
    pub(crate) new_size: u64,
    pub(crate) new_collateral: u64,
    pub(crate) new_entry: u64,
    /// The size-weighted funding index for the grown position.
    pub(crate) new_entry_funding: i128,
    pub(crate) side_oi: u64,
    pub(crate) extra_lock: u64,
}

/// Every reason an open can be refused, with nothing written.
///
/// Asked when an order enters a batch (`batch::admit_open`), where the trader
/// can be told, and by `book_open`. Settlement does not ask it again: see
/// `book_cleared_open`.
///
/// The market's loss budget is deliberately not one of the reasons. It was
/// applied when the batch cleared, to the pool's share of it, which is the
/// only part of a batch that adds net exposure; see `Market::lock_admitted`.
pub fn check_open(
    pool: &Pool,
    market: &Market,
    position: &Position,
    is_long: bool,
    net_collateral: u64,
    size_usd: u64,
    fill: u64,
) -> Result<OpenPlan> {
    plan_open(pool, market, position, is_long, net_collateral, size_usd, fill, true)
}

/// What an open does, with the leverage and open interest caps applied only
/// when `limits` is set.
#[allow(clippy::too_many_arguments)]
pub(crate) fn plan_open(
    pool: &Pool,
    market: &Market,
    position: &Position,
    is_long: bool,
    net_collateral: u64,
    size_usd: u64,
    fill: u64,
    limits: bool,
) -> Result<OpenPlan> {
    let cumulative = market.cumulative_funding(is_long);

    let (new_size, new_collateral, new_entry, new_entry_funding, check_collateral) = if position.is_open() {
        require!(position.is_long == is_long, PerpError::PositionAlreadyOpen);

        // Funding is not settled here. It used to be, against collateral, but
        // only a payer's side ever moved: funding a position had *received*
        // raised its collateral while nothing was taken from the pool or the
        // market, and the books drifted apart until a later close credited
        // money that did not exist. Instead the index is blended by size, so
        // the existing size keeps owing from where it started and the new
        // size owes from now. Funding is linear in size, so this is exact.
        //
        // What it owes so far still counts against its margin, though: the
        // leverage check below is made on collateral net of it.
        let owed = funding_owed_usd(position.size_usd, position.entry_funding, cumulative)?;
        let settled_collateral = position_equity_usd(position.collateral_usd, 0, owed)?;
        let grown = position
            .size_usd
            .checked_add(size_usd)
            .ok_or(PerpError::MathOverflow)?;
        let blended_funding = (position.entry_funding
            .checked_mul(position.size_usd as i128)
            .ok_or(PerpError::MathOverflow)?
            .checked_add(cumulative.checked_mul(size_usd as i128).ok_or(PerpError::MathOverflow)?)
            .ok_or(PerpError::MathOverflow)?)
            / grown as i128;

        let prior_entry =
            market.adjust_entry_price(position.entry_price, position.entry_price_factor)?;
        (
            grown,
            position
                .collateral_usd
                .checked_add(net_collateral)
                .ok_or(PerpError::MathOverflow)?,
            blend_entry_price(position.size_usd, prior_entry, size_usd, fill)?,
            blended_funding,
            settled_collateral
                .checked_add(net_collateral)
                .ok_or(PerpError::MathOverflow)?,
        )
    } else {
        (size_usd, net_collateral, fill, cumulative, net_collateral)
    };

    require!(check_collateral > 0, PerpError::ZeroAmount);
    let leverage_bps = (new_size as u128)
        .checked_mul(BPS)
        .ok_or(PerpError::MathOverflow)?
        / (check_collateral as u128);
    require!(
        !limits || leverage_bps <= market.effective_max_leverage_bps()? as u128,
        PerpError::LeverageTooHigh
    );

    // Open interest caps, tightened automatically while the underlying market
    // is closed and the index has only the thin on-chain spot leg to anchor to.
    let side_oi = if is_long {
        market.long_size_usd.checked_add(size_usd)
    } else {
        market.short_size_usd.checked_add(size_usd)
    }
    .ok_or(PerpError::MathOverflow)?;
    require!(
        !limits || side_oi <= market.effective_oi_cap_usd(is_long)?,
        PerpError::OpenInterestCapExceeded
    );

    // Nothing is held against an open. Reserving the full notional on both
    // sides froze backing a balanced book never needed, and a backer of a
    // market with open interest could withdraw nothing. What bounds a market
    // now is what bounds its payouts: profit is paid only as far as the market
    // can pay it (`haircut_profit_usd`), so open size needs no reserve behind
    // it. `pnl_reserve_bps` is kept on the account and no longer read.
    let extra_lock = 0;
    pool.check_lock(extra_lock)?;

    Ok(OpenPlan {
        new_size,
        new_collateral,
        new_entry,
        new_entry_funding,
        side_oi,
        extra_lock,
    })
}

/// Books a fill against the pool and returns what of its fee went to the
/// market's backers, so the caller can say so in an event: the function has no
/// market key to put in one.
#[allow(clippy::too_many_arguments)]
pub fn book_open(
    pool: &mut Pool,
    market: &mut Market,
    position: &mut Position,
    owner: Pubkey,
    position_bump: u8,
    is_long: bool,
    net_collateral: u64,
    open_fee: u64,
    market_key: Pubkey,
    size_usd: u64,
    fill: u64,
    now: i64,
) -> Result<u64> {
    let plan = check_open(pool, market, position, is_long, net_collateral, size_usd, fill)?;
    book_planned(pool, market, position, plan, owner, position_bump, is_long, net_collateral,
        open_fee, market_key, size_usd, fill, now)
}

/// Books an open a sealed batch filled, without asking the leverage and open
/// interest caps again.
///
/// Both were asked when the order entered the batch (`batch::admit_open`).
/// Asking at settlement made the answer depend on which orders a caller
/// chose to settle first and on funding accrued since the clearing, and an
/// open refused there went home while the order it crossed still booked. A
/// cross between two traders is net zero for the pool only while both legs
/// book, so a refusal the caller could arrange handed the surviving leg a
/// position at the band's edge with the pool alone on the other side.
#[allow(clippy::too_many_arguments)]
pub fn book_cleared_open(
    pool: &mut Pool,
    market: &mut Market,
    position: &mut Position,
    owner: Pubkey,
    position_bump: u8,
    is_long: bool,
    net_collateral: u64,
    open_fee: u64,
    market_key: Pubkey,
    size_usd: u64,
    fill: u64,
    now: i64,
) -> Result<u64> {
    let plan = plan_open(pool, market, position, is_long, net_collateral, size_usd, fill, false)?;
    book_planned(pool, market, position, plan, owner, position_bump, is_long, net_collateral,
        open_fee, market_key, size_usd, fill, now)
}

#[allow(clippy::too_many_arguments)]
fn book_planned(
    pool: &mut Pool,
    market: &mut Market,
    position: &mut Position,
    plan: OpenPlan,
    owner: Pubkey,
    position_bump: u8,
    is_long: bool,
    net_collateral: u64,
    open_fee: u64,
    market_key: Pubkey,
    size_usd: u64,
    fill: u64,
    now: i64,
) -> Result<u64> {
    let OpenPlan {
        new_size,
        new_collateral,
        new_entry,
        new_entry_funding,
        side_oi,
        extra_lock,
    } = plan;

    // Two ceilings: the pool's utilization cap, checked above, and this
    // market's budget, which was applied when the batch cleared. An open
    // listing needs the second one -- the first says nothing about which
    // market spent the capital.
    pool.lock(extra_lock)?;
    market.lock_admitted(extra_lock)?;

    let protocol_fee = bps_of(open_fee, pool.protocol_fee_share_bps)?;
    let chain_fee = bps_of(open_fee, CHAIN_FEE_SHARE_BPS)?;
    let insurance_fee = bps_of(open_fee, pool.insurance_fee_share_bps)?;
    pool.protocol_fees_usd = pool
        .protocol_fees_usd
        .checked_add(protocol_fee)
        .ok_or(PerpError::MathOverflow)?;
    pool.chain_fees_usd = pool
        .chain_fees_usd
        .checked_add(chain_fee)
        .ok_or(PerpError::MathOverflow)?;
    pool.insurance_usd = pool
        .insurance_usd
        .checked_add(insurance_fee)
        .ok_or(PerpError::MathOverflow)?;
    // What is left is the LPs', less the backers' cut when the market has
    // any. Both halves stay in the vault; only the line they are booked on
    // differs, so the vault reconciles exactly as it did.
    let lp_fee = open_fee - protocol_fee - chain_fee - insurance_fee;
    let to_backers = market.credit_backer_fee(lp_fee)?;
    pool.backing_usd = pool
        .backing_usd
        .checked_add(to_backers)
        .ok_or(PerpError::MathOverflow)?;
    pool.liquidity_usd = pool
        .liquidity_usd
        .checked_add(lp_fee - to_backers)
        .ok_or(PerpError::MathOverflow)?;
    pool.trader_collateral_usd = pool
        .trader_collateral_usd
        .checked_add(net_collateral)
        .ok_or(PerpError::MathOverflow)?;

    // The market's side average moves with the new size, so the aggregate
    // carries the same entry the positions do and `trader_pnl_usd` can price
    // the whole book without walking it.
    let had_open_interest = market.has_open_interest();
    // The position's term in its side's moment sums is replaced whole, read
    // before anything below changes the position: what it put in comes out,
    // and the grown position goes in at its blended entry.
    let old_term = market.tracked_term(position);
    let tracked = market.retrack(is_long, old_term, new_size, new_entry);
    if is_long {
        market.long_avg_entry_price = blend_entry_price(
            market.long_size_usd,
            market.long_avg_entry_price,
            size_usd,
            fill,
        )?;
        market.long_size_usd = side_oi;
    } else {
        market.short_avg_entry_price = blend_entry_price(
            market.short_size_usd,
            market.short_avg_entry_price,
            size_usd,
            fill,
        )?;
        market.short_size_usd = side_oi;
    }
    // The blend is exact up to rounding; with every position on the side in
    // the sums, the average is recomputed from them instead, so rounding
    // never accumulates.
    if let Some(a) = market.side_avg_from_moments(is_long) {
        if is_long {
            market.long_avg_entry_price = a;
        } else {
            market.short_avg_entry_price = a;
        }
    }
    if !had_open_interest && market.has_open_interest() {
        pool.markets_with_oi = pool
            .markets_with_oi
            .checked_add(1)
            .ok_or(PerpError::MathOverflow)?;
        pool.oi_version = pool.oi_version.wrapping_add(1);
    }
    market.collateral_usd = market
        .collateral_usd
        .checked_add(net_collateral)
        .ok_or(PerpError::MathOverflow)?;

    if !position.is_open() {
        position.bump = position_bump;
        position.owner = owner;
        position.market = market_key;
        position.open_ts = now;
    }
    position.is_long = is_long;
    position.size_usd = new_size;
    position.collateral_usd = new_collateral;
    position.entry_price = new_entry;
    position.entry_price_factor = market.price_factor;
    position.entry_funding = new_entry_funding;
    position.q_epoch = if tracked { market.q_tag() } else { 0 };
    position.locked_usd = position
        .locked_usd
        .checked_add(extra_lock)
        .ok_or(PerpError::MathOverflow)?;
    position.last_update_ts = now;

    Ok(to_backers)
}

/*
 * `open_position` was here.
 *
 * It filled at the oracle index plus a spread, against the pool, the moment it
 * was called — which is the architecture the whole venue moved away from.
 * There is no market order any more: an order is a limit into a batch, and the
 * price is whatever that batch crosses at. `submit_order` replaces it.
 *
 * Closing still prices off the oracle. That is the remaining asymmetry and it
 * is deliberate for now: an exit that has to find a counterparty is an exit
 * that can be denied, and leaving a trader unable to reduce risk is worse than
 * pricing their exit off the index. It is also the next thing to fix.
 */


/// Result of unwinding `close_size` of a position at `fill`.
pub struct Settlement {
    pub collateral_share: u64,
    pub locked_release: u64,
    pub pnl_usd: i64,
    pub funding_usd: i64,
    pub equity_usd: u64,
}

pub fn settle(
    position: &Position,
    market: &Market,
    close_size: u64,
    fill: u64,
) -> Result<Settlement> {
    let collateral_share = mul_div_u64(
        position.collateral_usd,
        close_size as u128,
        position.size_usd as u128,
    )?;
    let locked_release = mul_div_u64(
        position.locked_usd,
        close_size as u128,
        position.size_usd as u128,
    )?;
    let entry = market.adjust_entry_price(position.entry_price, position.entry_price_factor)?;
    let pnl_usd = position_pnl_usd(position.is_long, close_size, entry, fill)?;
    let funding_usd = funding_owed_usd(
        close_size,
        position.entry_funding,
        market.cumulative_funding(position.is_long),
    )?;
    let equity_usd = position_equity_usd(collateral_share, pnl_usd, funding_usd)?;
    Ok(Settlement {
        collateral_share,
        locked_release,
        pnl_usd,
        funding_usd,
        equity_usd,
    })
}

/// The most a forced close may pay its owner: their own collateral back, and
/// as much profit on top as their market's remaining budget still covers.
///
/// Deleveraging and liquidation used to pay full equity past the budget, on
/// the theory that a forced close is what runs when the budget is gone. That
/// made the budget a suggestion: once a market had spent it, its winners were
/// paid from the shared pool and the insurance fund, which is capital put up
/// for every other market. So one market can pay out no more than it was
/// underwritten for, and profit past that is not paid: a gain is only as good
/// as the backing on the other side of it.
pub fn payable_usd(market: &Market, settlement: &Settlement) -> u64 {
    settlement
        .equity_usd
        .min(settlement.collateral_share.saturating_add(market.remaining_budget_usd()))
}

/// The part of `owed_usd`, a winner's profit past its collateral, that its
/// market can pay at `price`.
///
/// A fair share rather than first come: when the market cannot pay every
/// winner in full, each is paid the same fraction of what it is owed,
/// `available / winners`, where `available` is what the market's budget and
/// the vault can still cover and `winners` is the profit every winning side
/// holds at this price. The rest is not paid. Nothing is reserved when a
/// position opens, so this is what stands between open interest and the
/// LPs: no close is ever paid more than its market was underwritten for, and
/// no winner can beat another to the money by closing first.
///
/// `winners` must not be netted: a loser's loss is not money the market holds
/// until that loser closes, while `available` counts only money it holds. So
/// each side counts at an upper bound on its gross winners, from its moment
/// sums (`Market::side_winners_bound_usd`), and a winner hidden behind a loser
/// on either side is still counted. A side holding a position opened before
/// those sums existed counts at its net profit instead, the old rule, until
/// that position is gone. The closer's own side is never counted below
/// `owed_usd`, the profit this close alone proves is on it. See
/// docs/loss-budget.md.
pub fn haircut_profit_usd(
    pool: &Pool,
    market: &Market,
    owed_usd: u64,
    price: u64,
    is_long: bool,
) -> Result<u64> {
    if owed_usd == 0 {
        return Ok(0);
    }
    let available = market.remaining_budget_usd().min(
        market
            .backing_usd
            .saturating_add(pool.liquidity_usd)
            .saturating_add(pool.insurance_usd),
    );
    let winners = market
        .side_winners_usd(is_long, price)?
        .max(owed_usd)
        .checked_add(market.side_winners_usd(!is_long, price)?)
        .ok_or(PerpError::MathOverflow)?;
    if winners <= available {
        return Ok(owed_usd);
    }
    mul_div_u64(owed_usd, available as u128, winners as u128)
}

/// Moves the settled amounts between the pool's books and pays the trader.
///
/// `payout` has already had every fee taken out of it. Whatever the trader does
/// not take out of `collateral_share` is the pool's, which is what makes the LP
/// the counterparty to the trade.

#[allow(clippy::too_many_arguments)]
/// Moves the protocol, chain and insurance cuts of `fee_usd` out of LP
/// liquidity and onto their own lines, in that order, and returns how much it
/// took. Each cut is clamped to what liquidity holds, because a settlement must
/// never fail on a fee. For fees that reached the pool as part of a trader's
/// loss or a smaller gain, which is how close and liquidation fees arrive.
pub fn take_fee_cuts(pool: &mut Pool, fee_usd: u64) -> Result<u64> {
    let protocol_fee = bps_of(fee_usd, pool.protocol_fee_share_bps)?.min(pool.liquidity_usd);
    pool.liquidity_usd -= protocol_fee;
    pool.protocol_fees_usd = pool
        .protocol_fees_usd
        .checked_add(protocol_fee)
        .ok_or(PerpError::MathOverflow)?;

    // The fund is paid out of fees, so it refills from the same flow it
    // protects: more trading, more buffer.
    let chain_fee = bps_of(fee_usd, CHAIN_FEE_SHARE_BPS)?.min(pool.liquidity_usd);
    pool.liquidity_usd -= chain_fee;
    pool.chain_fees_usd = pool
        .chain_fees_usd
        .checked_add(chain_fee)
        .ok_or(PerpError::MathOverflow)?;

    let insurance_fee = bps_of(fee_usd, pool.insurance_fee_share_bps)?.min(pool.liquidity_usd);
    pool.liquidity_usd -= insurance_fee;
    pool.insurance_usd = pool
        .insurance_usd
        .checked_add(insurance_fee)
        .ok_or(PerpError::MathOverflow)?;

    Ok(protocol_fee + chain_fee + insurance_fee)
}

/// The protocol, chain and insurance cuts a fee of `fee_usd` carries before
/// any clamping: the part of it that belongs to lines other than the LPs.
pub fn fee_cuts_usd(pool: &Pool, fee_usd: u64) -> Result<u64> {
    Ok(bps_of(fee_usd, pool.protocol_fee_share_bps)?
        + bps_of(fee_usd, CHAIN_FEE_SHARE_BPS)?
        + bps_of(fee_usd, pool.insurance_fee_share_bps)?)
}

pub fn apply_settlement_to_pool(
    pool: &mut Pool,
    market: &mut Market,
    position: &Position,
    settlement: &Settlement,
    payout: u64,
    fee_usd: u64,
    close_size: u64,
    is_long: bool,
) -> Result<u64> {
    pool.unlock(settlement.locked_release);
    market.unlock(settlement.locked_release);
    pool.trader_collateral_usd = pool
        .trader_collateral_usd
        .saturating_sub(settlement.collateral_share);

    let mut from_insurance = 0u64;
    if payout >= settlement.collateral_share {
        let loss = payout - settlement.collateral_share;
        // Charged before anything moves, so a market that has spent its budget
        // fails the whole close rather than paying part of it. There is no
        // override: every path that pays profit caps it first (see
        // `payable_usd`), so one market's winners are never paid out of
        // capital that was put up for the others.
        market.charge_loss(loss)?;
        // Whoever underwrote this market pays before the LPs do. The draw is
        // taken here rather than inside `pay_out` because it is per market and
        // the pool's balances are not.
        let from_backing = market.draw_backing(loss);
        pool.backing_usd = pool.backing_usd.saturating_sub(from_backing);
        from_insurance = pool.pay_out(loss - from_backing)?;
    } else {
        let gain = settlement.collateral_share - payout;
        market.credit_gain(gain)?;
        // Backing is repaid before the pool books a profit, and only up to
        // what this market's losses took out of it.
        let to_backing = market.restore_backing(gain);
        pool.backing_usd = pool
            .backing_usd
            .checked_add(to_backing)
            .ok_or(PerpError::MathOverflow)?;
        pool.liquidity_usd = pool
            .liquidity_usd
            .checked_add(gain - to_backing)
            .ok_or(PerpError::MathOverflow)?;
    }

    let cuts = take_fee_cuts(pool, fee_usd)?;

    // The close fee reached the LPs as part of the gain or as a smaller loss,
    // so it is already inside `liquidity_usd` by this point. The backers' cut
    // is moved out of it after every other cut has been, which puts them
    // behind the protocol, the chain and the fund and ahead of the LPs, the
    // same order as on the open. Clamped to what liquidity holds for the same
    // reason the cuts above are: a settlement must not fail on a fee.
    let lp_fee = fee_usd - cuts;
    let to_backers = market
        .credit_backer_fee(lp_fee.min(pool.liquidity_usd))?;
    pool.liquidity_usd -= to_backers;
    pool.backing_usd = pool
        .backing_usd
        .checked_add(to_backers)
        .ok_or(PerpError::MathOverflow)?;

    if from_insurance > 0 {
        emit!(InsuranceDrawn {
            amount_usd: from_insurance,
            remaining_usd: pool.insurance_usd,
        });
    }

    let had_open_interest = market.has_open_interest();
    // Size, moment sums and average entry come off the side together, here
    // and nowhere else on a close (`Market::close_side`).
    market.close_side(is_long, position, close_size)?;
    if had_open_interest && !market.has_open_interest() {
        pool.markets_with_oi = pool.markets_with_oi.saturating_sub(1);
        pool.oi_version = pool.oi_version.wrapping_add(1);
    }
    market.collateral_usd = market
        .collateral_usd
        .saturating_sub(settlement.collateral_share);
    Ok(to_backers)
}

/// What closing `close_size` at `fill` would cost the market's budget: the
/// payout past the collateral it releases, after the close fee.
fn close_loss_usd(
    position: &Position,
    market: &Market,
    close_size: u64,
    fill: u64,
    discount_bps: u16,
) -> Result<u64> {
    let s = settle(position, market, close_size, fill)?;
    let fee_usd = close_fee_usd(market, close_size, discount_bps)?.min(s.equity_usd);
    Ok((s.equity_usd - fee_usd).saturating_sub(s.collateral_share))
}

/// The most of `close_size` that can be closed at `fill` without the market
/// paying out past its remaining loss budget, or past what there is to pay
/// with.
///
/// A reduce-only order is settled against the market's budget, and a close
/// the budget cannot pay used to fail -- which, from inside a sealed batch,
/// held every other order in it and every order after it. Now the order fills
/// as far as the budget reaches and the rest of it goes home, the same as an
/// order the auction only partly filled. A close that costs the pool nothing,
/// which is any losing or flat one, always fills in full.
///
/// The money is the second ceiling. A loss is paid from the market's backing,
/// then LP liquidity, then the insurance fund, and `Pool::pay_out` fails when
/// all three together fall short. That failure would hold the batch the same
/// way, so the fill is capped at what the three can cover.
///
/// Loss is linear in size up to rounding, so the proportional answer is right
/// or a few units high; it is checked, shrunk and checked again rather than
/// trusted, and anything still over after that gets nothing.
pub fn close_within_budget(
    pool: &Pool,
    position: &Position,
    market: &Market,
    close_size: u64,
    fill: u64,
) -> Result<u64> {
    close_within_budget_at(pool, position, market, close_size, fill, 0)
}

/// `close_within_budget` for a trader whose close fee is discounted by
/// `discount_bps`. A smaller fee is a larger payout, so the budget has to be
/// checked against the fee actually charged.
pub fn close_within_budget_at(
    pool: &Pool,
    position: &Position,
    market: &Market,
    close_size: u64,
    fill: u64,
    discount_bps: u16,
) -> Result<u64> {
    if close_size == 0 {
        return Ok(0);
    }
    let payable = market
        .backing_usd
        .saturating_add(pool.liquidity_usd)
        .saturating_add(pool.insurance_usd);
    let budget = market.remaining_budget_usd().min(payable);
    let full = close_loss_usd(position, market, close_size, fill, discount_bps)?;
    if full <= budget {
        return Ok(close_size);
    }
    let mut size = mul_div_u64(close_size, budget as u128, full as u128)?;
    for _ in 0..4 {
        if size == 0 {
            return Ok(0);
        }
        let loss = close_loss_usd(position, market, size, fill, discount_bps)?;
        if loss <= budget {
            return Ok(size);
        }
        // Over by rounding: take the proportional step again from here, and
        // at least one unit, so the loop always moves.
        let next = mul_div_u64(size, budget as u128, loss as u128)?;
        size = next.min(size - 1);
    }
    Ok(0)
}

/// What unwinding `close_size` of a position left behind.
pub struct Close {
    pub payout_usd: u64,
    pub fee_usd: u64,
    pub pnl_usd: i64,
    pub funding_usd: i64,
    /// Size still open afterwards, so the caller can tell a reduce from an exit.
    pub remaining_usd: u64,
    /// Part of `fee_usd` paid to the market's backers rather than its LPs.
    pub backer_fee_usd: u64,
    /// Profit owed and not paid, because the market could not cover it.
    pub haircut_usd: u64,
}

/// Unwinds `close_size` of a position at `fill` and leaves the payout owing.
///
/// The counterpart to `book_open`, and split out of the old `close_position`
/// instruction for the same reason: the price no longer arrives with the
/// caller. It comes from a batch that has already cleared, so everything here
/// has to be callable from a settlement that holds no oracle and takes no
/// discretion.
///
/// Moving the money is the caller's job -- this function has no token accounts
/// -- but by the time it returns the pool's books already say the payout is
/// owed, so a caller that does not transfer it has stranded it.
#[allow(clippy::too_many_arguments)]
pub fn book_close(
    pool: &mut Pool,
    market: &mut Market,
    position: &mut Position,
    close_size: u64,
    fill: u64,
    now: i64,
) -> Result<Close> {
    book_close_at(pool, market, position, close_size, fill, now, 0)
}

/// The close fee on `close_size`, less `discount_bps` of it.
pub fn close_fee_usd(market: &Market, close_size: u64, discount_bps: u16) -> Result<u64> {
    let fee = bps_of(close_size, market.close_fee_bps)?;
    Ok(fee - bps_of(fee, discount_bps)?)
}

/// `book_close` with the close fee discounted by `discount_bps`, for a
/// referee or a market's own deployer.
#[allow(clippy::too_many_arguments)]
pub fn book_close_at(
    pool: &mut Pool,
    market: &mut Market,
    position: &mut Position,
    close_size: u64,
    fill: u64,
    now: i64,
    discount_bps: u16,
) -> Result<Close> {
    require!(position.is_open(), PerpError::PositionEmpty);
    require!(close_size > 0, PerpError::ZeroAmount);
    require!(close_size <= position.size_usd, PerpError::PositionTooSmall);

    let is_long = position.is_long;
    let remaining = position.size_usd - close_size;
    // No minimum on what is left. The old instruction refused to leave a
    // position under `min_position_usd`, which was safe when the caller was a
    // trader who could simply be told no. The caller is now a settlement that
    // cannot fail: the batch is sealed, the order can no longer be cancelled,
    // and an error here would strand it with nobody able to clear it. A dust
    // remainder is the lesser problem, and it is one the trader can always
    // close, since a closing order has no floor either.

    let settlement = settle(position, market, close_size, fill)?;
    let fee_usd = close_fee_usd(market, close_size, discount_bps)?.min(settlement.equity_usd);
    // Profit past the collateral is paid at the market's fair-share rate,
    // read before this close leaves the side aggregates it is counted in.
    let gross = settlement.equity_usd - fee_usd;
    let owed = gross.saturating_sub(settlement.collateral_share);
    let haircut_usd = owed - haircut_profit_usd(pool, market, owed, fill, is_long)?;
    let payout = gross - haircut_usd;

    let backer_fee_usd = apply_settlement_to_pool(
        pool, market, position, &settlement, payout, fee_usd, close_size, is_long,
    )?;

    position.size_usd = remaining;
    position.collateral_usd = position
        .collateral_usd
        .saturating_sub(settlement.collateral_share);
    position.locked_usd = position.locked_usd.saturating_sub(settlement.locked_release);
    position.last_update_ts = now;
    if remaining == 0 {
        position.entry_price = 0;
        position.entry_price_factor = 0;
        position.entry_funding = 0;
        position.collateral_usd = 0;
        position.locked_usd = 0;
        position.open_ts = 0;
    } else {
        // Roll the surviving size onto today's price factor, so the next
        // settlement starts from a clean baseline. The funding index stays:
        // only the closed part's funding was settled, and resetting the index
        // wiped what the rest owed. A one-dollar reduce-only order was enough
        // to erase a position's whole accrued funding, paid for by the pool.
        // Funding is linear in size, so the surviving size keeps owing from
        // where it started.
        position.entry_price = market.adjust_entry_price(position.entry_price, position.entry_price_factor)?;
        position.entry_price_factor = market.price_factor;
    }

    Ok(Close {
        payout_usd: payout,
        fee_usd,
        pnl_usd: settlement.pnl_usd,
        funding_usd: settlement.funding_usd,
        remaining_usd: remaining,
        backer_fee_usd,
        haircut_usd,
    })
}

/*
 * `close_position` was here.
 *
 * It read the oracle, took the index plus a spread, and paid out against the
 * pool on the spot -- the same shape as the `open_position` above it, and the
 * same objection. A venue whose entries are set by two-sided flow and whose
 * exits are set by an index is only half a venue, and the half that is left is
 * the half an LP eats. A reduce-only order into the batch is now the only way
 * out, which makes the exit price a thing the market decides rather than a
 * thing the oracle hands over.
 *
 * What this cost is immediacy: an exit waits for the next clearing, up to
 * `BATCH_INTERVAL_SEC`. The worry that kept this instruction alive was that an
 * exit needing a counterparty is an exit that can be denied -- but the pool
 * still quotes into every batch, so an order priced to cross it always finds
 * one. It is `book_close` below, called from settlement, that does the work
 * this used to.
 */

/// The pool could not cover a payout from LP capital alone.
#[event]
pub struct InsuranceDrawn {
    pub amount_usd: u64,
    pub remaining_usd: u64,
}

/// Emitted by settlement when a reduce-only order unwinds size.
///
/// `index_price` is gone from it: there is no index in a close any more. The
/// price is the batch's, and `fill_price` is it.
#[event]
pub struct PositionClosed {
    pub position: Pubkey,
    pub owner: Pubkey,
    pub market: Pubkey,
    pub is_long: bool,
    pub size_usd: u64,
    pub fill_price: u64,
    pub pnl_usd: i64,
    pub funding_usd: i64,
    pub fee_usd: u64,
    pub payout_usd: u64,
}

/// Profit a close was owed and not paid, because its market could not cover
/// every winner in full (`haircut_profit_usd`).
#[event]
pub struct ProfitHaircut {
    pub position: Pubkey,
    pub owner: Pubkey,
    pub market: Pubkey,
    pub haircut_usd: u64,
    pub payout_usd: u64,
}

/// Part of a trading fee paid to a market's backers rather than its LPs.
///
/// Emitted by settlement whenever a backed market earns a fee, open or close.
/// Summing these is how anyone tells what backing a market has earned, since
/// the payment itself is only a rise in what each share is worth and leaves
/// nothing else behind on the account.
#[event]
pub struct BackerFeePaid {
    pub market: Pubkey,
    pub amount_usd: u64,
    /// The market's backing after the payment, and the shares it is split
    /// across, so a share's new value can be read off the event alone.
    pub backing_usd: u64,
    pub backing_shares: u64,
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::instructions::adl::deleverage_due;
    use crate::instructions::batch::{open_fill, pool_quote_ceiling};

    /// `book_open` is the one place a position comes into existence, and it is
    /// reached from three callers — a batch settlement, a triggered order, and
    /// nothing else now that market orders are gone. These cover it directly
    /// rather than through any of them.
    pub(crate) fn pool() -> Pool {
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
            liquidity_usd: 10_000_000_000_000, // $10m
            locked_usd: 0,
            trader_collateral_usd: 0,
            protocol_fees_usd: 0,
            insurance_usd: 0,
            insurance_fee_share_bps: 1_000,
            escrow_usd: 0,
            chain_fee_destination: Pubkey::default(),
            chain_fees_usd: 0,
            pyth_receiver: crate::oracle::PYTH_RECEIVER_ID,
            add_liquidity_fee_bps: 0,
            remove_liquidity_fee_bps: 0,
            protocol_fee_share_bps: 2_000,
            max_utilization_bps: 8_000,
            paused: false,
            backing_usd: 0,
            num_custodies: 0,
            markets_with_oi: 0,
            rewards_usd: 0,
            oi_version: 0,
            _reserved: [0; 1],
        }
    }

    pub(crate) fn market() -> Market {
        let mut m = Market {
            bump: 0,
            pool: Pubkey::default(),
            symbol: [0; 16],
            feed_id: [0; 32],
            max_price_age_sec: 60,
            max_conf_bps: 500,
            max_leverage_bps: 100_000, // 10x
            maintenance_margin_bps: 500,
            liquidation_fee_bps: 100,
            open_fee_bps: 0,
            close_fee_bps: 0,
            min_position_usd: 1_000_000,
            max_oi_long_usd: 1_000_000_000_000,
            max_oi_short_usd: 1_000_000_000_000,
            pnl_reserve_bps: 10_000,
            base_spread_bps: 4,
            conf_spread_mult_bps: 10_000,
            max_spread_bps: 500,
            session: Session::Regular as u8,
            closed_session_leverage_bps: 20_000,
            closed_session_oi_mult_bps: 2_500,
            cumulative_long_funding: 0,
            cumulative_short_funding: 0,
            last_funding_ts: 0,
            max_funding_rate_bps_per_hour: 100,
            funding_k_bps: 8_000,
            borrow_rate_bps_per_hour: 1,
            long_size_usd: 0,
            long_avg_entry_price: 0,
            short_size_usd: 0,
            short_avg_entry_price: 0,
            collateral_usd: 0,
            price_factor: PRICE_FACTOR_ONE,
            split_epoch: 0,
            last_multiplier: MULTIPLIER_SCALE as u64,
            paused: false,
            price_source: PriceSource::Pyth as u8,
            observation: Pubkey::default(),
            deployer: Pubkey::default(),
            backing_usd: 0,
            backing_shares: 0,
            backing_drawn_usd: 0,
            loss_budget_usd: 1_000_000_000_000, // $1m
            net_loss_usd: 0,
            locked_usd: 0,
            last_price_ts: 0,
            depth_leverage_x: 0,
            volume_usd: 0,
            deployer_synced_volume_usd: 0,
            deployer_rewards_usd: 0,
            deployer_earned_usd: 0,
            risk_step_rem: 0,
            last_price: 0,
            risk_price: 0,
            risk_slot: 0,
            generation: 0,
            _reserved: [0; 28],
            long_moments: SideMoments::default(),
            short_moments: SideMoments::default(),
        };
        m.last_funding_ts = 0;
        m
    }

    pub(crate) fn position() -> Position {
        Position {
            bump: 0,
            owner: Pubkey::default(),
            market: Pubkey::default(),
            is_long: false,
            size_usd: 0,
            collateral_usd: 0,
            entry_price: 0,
            entry_price_factor: 0,
            entry_funding: 0,
            locked_usd: 0,
            open_ts: 0,
            last_update_ts: 0,
            closing_usd: 0,
            q_epoch: 0,
            _reserved: [0; 20],
        }
    }

    pub(crate) const PX: u64 = 100_000_000; // $100

    #[test]
    fn a_fresh_position_records_the_fill_it_was_opened_at() {
        let (mut p, mut m, mut pos) = (pool(), market(), position());
        let owner = Pubkey::new_unique();
        let market_key = Pubkey::new_unique();

        book_open(&mut p, &mut m, &mut pos, owner, 7, true,
                  1_000_000_000, 0, market_key, 5_000_000_000, PX, 42).unwrap();

        assert_eq!(pos.owner, owner);
        assert_eq!(pos.market, market_key);
        assert_eq!(pos.bump, 7);
        assert!(pos.is_long);
        assert_eq!(pos.size_usd, 5_000_000_000);
        assert_eq!(pos.collateral_usd, 1_000_000_000);
        assert_eq!(pos.entry_price, PX);
        assert_eq!(pos.entry_price_factor, m.price_factor);
        assert_eq!(pos.open_ts, 42);

        // The market's aggregate has to move with it, or `trader_pnl_usd`
        // prices a book that does not exist.
        assert_eq!(m.long_size_usd, 5_000_000_000);
        assert_eq!(m.long_avg_entry_price, PX);
        assert_eq!(m.collateral_usd, 1_000_000_000);
        // Collateral is the trader's, never the LPs'.
        assert_eq!(p.trader_collateral_usd, 1_000_000_000);
    }

    #[test]
    fn adding_to_a_position_blends_the_entry_price() {
        let (mut p, mut m, mut pos) = (pool(), market(), position());
        let owner = Pubkey::new_unique();
        let key = Pubkey::new_unique();

        book_open(&mut p, &mut m, &mut pos, owner, 1, true,
                  1_000_000_000, 0, key, 5_000_000_000, PX, 0).unwrap();
        // The same notional again at twice the price buys half the units:
        // 75 units for $10,000 is an entry of $133.33, not the $150 halfway.
        book_open(&mut p, &mut m, &mut pos, owner, 1, true,
                  1_000_000_000, 0, key, 5_000_000_000, PX * 2, 1).unwrap();

        assert_eq!(pos.size_usd, 10_000_000_000);
        assert_eq!(pos.entry_price, PX * 4 / 3);
        assert_eq!(pos.collateral_usd, 2_000_000_000);
        assert_eq!(m.long_avg_entry_price, PX * 4 / 3);
    }

    #[test]
    fn a_position_cannot_be_opened_against_itself() {
        let (mut p, mut m, mut pos) = (pool(), market(), position());
        let key = Pubkey::new_unique();
        book_open(&mut p, &mut m, &mut pos, Pubkey::default(), 1, true,
                  1_000_000_000, 0, key, 5_000_000_000, PX, 0).unwrap();
        // Shorting into a long is not a smaller long, it is a different
        // position, and silently netting them would lose the entry price.
        assert!(book_open(&mut p, &mut m, &mut pos, Pubkey::default(), 1, false,
                          1_000_000_000, 0, key, 1_000_000_000, PX, 1).is_err());
    }

    #[test]
    fn leverage_past_the_market_cap_is_refused() {
        let (mut p, mut m, mut pos) = (pool(), market(), position());
        // 10x is the cap; $900 of collateral against $10,000 is over it.
        assert!(book_open(&mut p, &mut m, &mut pos, Pubkey::default(), 1, true,
                          900_000_000, 0, Pubkey::default(), 10_000_000_000, PX, 0).is_err());
        assert_eq!(pos.size_usd, 0, "a refused open books nothing");
        assert_eq!(m.long_size_usd, 0);
    }

    #[test]
    fn open_interest_past_the_cap_is_refused() {
        let (mut p, mut m, mut pos) = (pool(), market(), position());
        m.max_oi_long_usd = 4_000_000_000;
        assert!(book_open(&mut p, &mut m, &mut pos, Pubkey::default(), 1, true,
                          1_000_000_000, 0, Pubkey::default(), 5_000_000_000, PX, 0).is_err());
    }

    #[test]
    fn an_open_holds_nothing_back_and_the_pool_keeps_quoting() {
        let (mut p, mut m, mut pos) = (pool(), market(), position());
        // A market underwritten for $100 takes a $5,000 open without setting
        // anything aside: what limits it is what a winner can be paid, which
        // the haircut at close holds to the budget.
        m.loss_budget_usd = 100_000_000;
        book_open(&mut p, &mut m, &mut pos, Pubkey::default(), 1, true,
                  1_000_000_000, 0, Pubkey::default(), 5_000_000_000, PX, 0).unwrap();
        assert_eq!(pos.size_usd, 5_000_000_000);
        assert_eq!((pos.locked_usd, m.locked_usd, p.locked_usd), (0, 0, 0));
        assert_eq!(pool_quote_ceiling(&p, &m).unwrap(), u64::MAX);
    }

    #[test]
    fn a_refused_open_is_refused_before_anything_is_written() {
        let (p, mut m, pos) = (pool(), market(), position());
        m.max_oi_long_usd = 4_000_000_000;
        let before = (p.locked_usd, p.liquidity_usd, m.locked_usd, m.long_size_usd);
        assert!(check_open(&p, &m, &pos, true, 1_000_000_000, 5_000_000_000, PX).is_err());
        assert_eq!(before, (p.locked_usd, p.liquidity_usd, m.locked_usd, m.long_size_usd));
    }

    #[test]
    fn a_lock_left_from_before_does_not_refuse_an_open() {
        let (mut p, m, pos) = (pool(), market(), position());
        // Positions opened before reserves were retired still hold theirs,
        // even past the cap; a new open adds nothing and is not refused.
        p.locked_usd = 9_000_000_000_000;
        assert!(check_open(&p, &m, &pos, true, 1_000_000_000, 5_000_000_000, PX).is_ok());
    }

    fn batch_order(owner: Pubkey, is_bid: bool, size: u64, collateral: u64, filled: u64,
                   reduce_only: bool) -> BatchOrder {
        BatchOrder {
            owner,
            price: PX,
            size_usd: size,
            collateral_usd: collateral,
            is_bid: is_bid as u8,
            filled_usd: filled,
            active: 1,
            reduce_only: reduce_only as u8,
            is_maker: 0,
            _pad: [0; 4],
        }
    }

    /// The freeze seen on localnet on 2026-09-23: imbalanced flow had filled a
    /// market's reservation to its cap, and the next sealed batch contained a
    /// long and a short that crossed each other. Settling the long reverted
    /// in `Market::lock` with `MarketBudgetExhausted`, the batch could never
    /// finish settling, and every order after it -- closes included -- was
    /// refused as "batch is sealed".
    ///
    /// This walks the same settlement over the pure halves of `settle_order`
    /// and requires that every order in the batch settles.
    #[test]
    fn a_market_with_its_budget_spent_still_settles_every_order() {
        let (mut p, mut m) = (pool(), market());
        m.loss_budget_usd = 100_000_000_000; // $100k

        // A trader already long and well in profit, closing.
        let winner = Pubkey::new_unique();
        let mut winner_pos = position();
        book_open(&mut p, &mut m, &mut winner_pos, winner, 1, true,
                  1_000_000_000, 0, Pubkey::default(), 5_000_000_000, PX, 0).unwrap();
        // ...and a market that has since spent every dollar of its budget.
        m.charge_loss(m.remaining_budget_usd()).unwrap();
        assert_eq!(m.remaining_budget_usd(), 0);

        // The batch as it sealed: a fresh long and a fresh short crossing each
        // other at $110, and the winner's close selling into the long.
        let fill = PX + PX / 10;
        let (long_owner, short_owner) = (Pubkey::new_unique(), Pubkey::new_unique());
        let mut long_pos = position();
        let mut short_pos = position();
        let orders = [
            (batch_order(long_owner, true, 10_000_000_000, 2_000_000_000, 10_000_000_000, false),
             &mut long_pos),
            (batch_order(short_owner, false, 5_000_000_000, 1_000_000_000, 5_000_000_000, false),
             &mut short_pos),
        ];

        // Trader-against-trader opens book in full, past the budget cap.
        for (order, pos) in orders {
            let (filled, used, fee) = open_fill(&p, &m, pos, &order, fill, 0).unwrap();
            assert_eq!(filled, order.filled_usd, "a crossing open fills in full");
            book_open(&mut p, &mut m, pos, order.owner, 1, order.bid(),
                      used - fee, fee, Pubkey::default(), filled, fill, 1).unwrap();
        }
        assert_eq!(long_pos.size_usd, 10_000_000_000);
        assert_eq!(short_pos.size_usd, 5_000_000_000);

        // The close fills in full rather than reverting or sitting unfilled.
        // A spent budget pays no profit: the winner gets its collateral back
        // (less the fee), the profit is cut to nothing, and the market never
        // costs the pool more than it was underwritten for.
        let whole = settle(&winner_pos, &m, winner_pos.size_usd, fill).unwrap();
        let closed = book_close(&mut p, &mut m, &mut winner_pos, 5_000_000_000, fill, 1).unwrap();
        assert_eq!(winner_pos.size_usd, 0);
        assert!(closed.payout_usd <= whole.collateral_share);
        assert!(closed.haircut_usd > 0);
        assert_eq!(m.remaining_budget_usd(), 0);
        assert!(m.net_loss_usd as u64 <= m.loss_budget_usd, "never past the budget");
    }

    #[test]
    fn deleveraging_is_never_due() {
        let (mut p, mut m, mut pos) = (pool(), market(), position());
        book_open(&mut p, &mut m, &mut pos, Pubkey::new_unique(), 1, true,
                  1_000_000_000, 0, Pubkey::default(), 5_000_000_000, PX, 0).unwrap();
        // Not with budget to spare, not with none, not up, not down: a winner
        // the market cannot pay is haircut at close instead.
        for spend in [0, 1] {
            if spend == 1 {
                m.charge_loss(m.remaining_budget_usd()).unwrap();
            }
            for price in [PX + PX / 10, PX * 3, PX - PX / 10] {
                let s = settle(&pos, &m, pos.size_usd, price).unwrap();
                assert!(!deleverage_due(&pos, &m, &s));
            }
        }
    }

    #[test]
    fn a_winning_close_is_paid_only_what_the_pool_holds() {
        let (mut p, mut m, mut pos) = (pool(), market(), position());
        book_open(&mut p, &mut m, &mut pos, Pubkey::new_unique(), 1, true,
                  1_000_000_000, 0, Pubkey::default(), 5_000_000_000, PX, 0).unwrap();
        // Budget to spare, but $300 between LP liquidity and insurance against
        // $500 owed. Paying it all would fail in `Pool::pay_out`.
        p.liquidity_usd = 200_000_000;
        p.insurance_usd = 100_000_000;
        let up = PX + PX / 10;
        let closed = book_close(&mut p, &mut m, &mut pos, 5_000_000_000, up, 1).unwrap();
        assert_eq!(pos.size_usd, 0, "fills in full");
        // To within the few micro-dollars the winners' bound rounds up by.
        assert!(closed.haircut_usd.abs_diff(200_000_000) <= 5);
        assert!(p.liquidity_usd + p.insurance_usd <= 5);
    }

    #[test]
    fn a_losing_close_fills_in_full_with_no_budget_left() {
        let (mut p, mut m, mut pos) = (pool(), market(), position());
        book_open(&mut p, &mut m, &mut pos, Pubkey::new_unique(), 1, true,
                  1_000_000_000, 0, Pubkey::default(), 5_000_000_000, PX, 0).unwrap();
        m.charge_loss(m.remaining_budget_usd()).unwrap();
        // Down 10%: the pool gains on this close, so the budget has no say.
        let down = PX - PX / 10;
        assert_eq!(close_within_budget(&p, &pos, &m, 5_000_000_000, down).unwrap(), 5_000_000_000);
        book_close(&mut p, &mut m, &mut pos, 5_000_000_000, down, 1).unwrap();
        assert_eq!(pos.size_usd, 0);
    }

    #[test]
    fn a_winning_close_past_the_budget_fills_in_full_at_a_haircut() {
        let (mut p, mut m, mut pos) = (pool(), market(), position());
        m.close_fee_bps = 10;
        book_open(&mut p, &mut m, &mut pos, Pubkey::new_unique(), 1, true,
                  1_000_000_000, 0, Pubkey::default(), 5_000_000_000, PX, 0).unwrap();
        // Up 10% on $5,000 is $500 owed past collateral, less the fee. Leave
        // $200 of budget: under half of that.
        m.charge_loss(m.remaining_budget_usd() - 200_000_000).unwrap();
        let up = PX + PX / 10;
        let closed = book_close(&mut p, &mut m, &mut pos, 5_000_000_000, up, 1).unwrap();
        assert_eq!(closed.remaining_usd, 0);
        // Paid exactly what was left, and the rest of the profit cut. The
        // close fee's share comes back to the market, so a little budget is
        // left afterwards: never more than the fee.
        assert!(m.remaining_budget_usd() <= closed.fee_usd);
        // $495 owed after the fee, paid at $200 / $500, the winners' share.
        let owed = 500_000_000 - closed.fee_usd;
        // To within the few micro-dollars the winners' bound rounds up by.
        assert!(closed.payout_usd.abs_diff(1_000_000_000 + owed * 2 / 5) <= 5);
        assert!(closed.haircut_usd.abs_diff(owed - owed * 2 / 5) <= 5);
    }

    #[test]
    fn winners_are_paid_the_same_share_whoever_closes_first() {
        // Two equal longs, $500 of profit each at +10%, and $400 of budget
        // between them: each is owed 40% of its profit, in either order.
        for first_is_a in [true, false] {
            let (mut p, mut m) = (pool(), market());
            let (mut a, mut b) = (position(), position());
            for pos in [&mut a, &mut b] {
                book_open(&mut p, &mut m, pos, Pubkey::new_unique(), 1, true,
                          1_000_000_000, 0, Pubkey::default(), 5_000_000_000, PX, 0).unwrap();
            }
            m.charge_loss(m.remaining_budget_usd() - 400_000_000).unwrap();
            let up = PX + PX / 10;
            let (x, y) = if first_is_a { (&mut a, &mut b) } else { (&mut b, &mut a) };
            let one = book_close(&mut p, &mut m, x, 5_000_000_000, up, 1).unwrap();
            let two = book_close(&mut p, &mut m, y, 5_000_000_000, up, 1).unwrap();
            for c in [&one, &two] {
                let paid = c.payout_usd - 1_000_000_000;
                assert!(paid.abs_diff(200_000_000) <= 1, "paid {paid}");
            }
            assert!(m.net_loss_usd as u64 <= m.loss_budget_usd);
        }
    }

    /// At $110: long A (entry $100, $5,000) is up $500; long B (entry $120,
    /// $6,000) is down $500, so the long side nets to zero; short C (entry
    /// $120, $6,000) is up $500. $500 of budget. B's loss is not money the
    /// market holds until B closes, so A and C are owed $1,000 between them
    /// against $500. Returns what A and C are paid past their collateral.
    fn a_and_c_paid_behind_a_netted_loser(a_first: bool) -> (u64, u64) {
        let entry_hi = PX + PX / 5;
        let up = PX + PX / 10;
        let (mut p, mut m) = (pool(), market());
        let (mut a, mut b, mut c) = (position(), position(), position());
        book_open(&mut p, &mut m, &mut a, Pubkey::new_unique(), 1, true,
                  1_000_000_000, 0, Pubkey::default(), 5_000_000_000, PX, 0).unwrap();
        book_open(&mut p, &mut m, &mut b, Pubkey::new_unique(), 1, true,
                  1_000_000_000, 0, Pubkey::default(), 6_000_000_000, entry_hi, 0).unwrap();
        book_open(&mut p, &mut m, &mut c, Pubkey::new_unique(), 1, false,
                  1_000_000_000, 0, Pubkey::default(), 6_000_000_000, entry_hi, 0).unwrap();
        m.charge_loss(m.remaining_budget_usd() - 500_000_000).unwrap();
        let mut close = |pos: &mut Position| {
            let size = pos.size_usd;
            book_close(&mut p, &mut m, pos, size, up, 1).unwrap().payout_usd - 1_000_000_000
        };
        let (paid_a, paid_c) = if a_first {
            let a_paid = close(&mut a);
            (a_paid, close(&mut c))
        } else {
            let c_paid = close(&mut c);
            (close(&mut a), c_paid)
        };
        assert!(m.net_loss_usd as u64 <= m.loss_budget_usd);
        (paid_a, paid_c)
    }

    #[test]
    fn a_winner_netted_against_its_own_sides_loser_is_paid_only_its_share() {
        // A's side nets to zero, so the aggregates alone said the only winner
        // was C, and A closing first was paid all $500 and C nothing. The
        // long side now counts at its moment bound, $502.08 against a true
        // $500: A is paid $249.48 and C what is left, $250.52.
        let (a, c) = a_and_c_paid_behind_a_netted_loser(true);
        assert!(a.abs_diff(250_000_000) <= 1_000_000, "A paid {a}");
        assert!(c.abs_diff(250_000_000) <= 1_000_000, "C paid {c}");
        assert!(a <= 250_000_000, "never past the fair share");
        assert!(a + c <= 500_000_000);
    }

    #[test]
    fn a_winner_hidden_on_the_other_side_is_paid_its_share_too() {
        // C closes first, with A hidden behind B in the long aggregate. The
        // net rule paid C all $500 and A nothing. The long side's moment
        // bound still sees A: C is paid $249.48, and so is A.
        let (a, c) = a_and_c_paid_behind_a_netted_loser(false);
        assert!(a.abs_diff(250_000_000) <= 1_000_000, "A paid {a}");
        assert!(c.abs_diff(250_000_000) <= 1_000_000, "C paid {c}");
        assert!(c <= 250_000_000, "never past the fair share");
        assert!(a + c <= 500_000_000);
    }

    #[test]
    fn the_open_fee_is_split_four_ways() {
        let (mut p, mut m, mut pos) = (pool(), market(), position());
        let before = p.liquidity_usd;
        let fee = 1_000_000; // $1

        book_open(&mut p, &mut m, &mut pos, Pubkey::default(), 1, true,
                  1_000_000_000, fee, Pubkey::default(), 5_000_000_000, PX, 0).unwrap();

        // docs/fees.md: 20% protocol, 10% insurance, 10% chain, the rest LPs.
        let protocol = fee as u128 * 2_000 / 10_000;
        let chain = fee as u128 * CHAIN_FEE_SHARE_BPS as u128 / 10_000;
        let insurance = fee as u128 * 1_000 / 10_000;
        assert_eq!(p.protocol_fees_usd as u128, protocol);
        assert_eq!(p.chain_fees_usd as u128, chain);
        assert_eq!(p.insurance_usd as u128, insurance);
        // Whatever is left of the fee belongs to the LPs, and nothing is lost
        // between the four.
        assert_eq!(p.liquidity_usd as u128,
                   before as u128 + fee as u128 - protocol - chain - insurance);
    }

    /// Every balance the vault has to reconcile against, summed. A fee may
    /// move between these lines; it must never appear or vanish.
    fn vault_books(p: &Pool) -> u128 {
        [p.liquidity_usd, p.backing_usd, p.protocol_fees_usd, p.chain_fees_usd,
         p.insurance_usd, p.trader_collateral_usd, p.escrow_usd]
            .iter()
            .map(|&v| v as u128)
            .sum()
    }

    fn backed(p: &mut Pool, m: &mut Market, usd: u64) {
        m.backing_usd = usd;
        m.backing_shares = usd;
        p.backing_usd = usd;
    }

    #[test]
    fn a_market_is_counted_while_anyone_holds_a_position_in_it() {
        let (mut p, mut m) = (pool(), market());
        p.markets_with_oi = 0;
        let (mut a, mut b) = (position(), position());
        let size = 5_000_000_000;

        // The first position brings the market in; a second one, on the other
        // side, does not count it twice.
        book_open(&mut p, &mut m, &mut a, Pubkey::default(), 1, true,
                  1_000_000_000, 0, Pubkey::default(), size, PX, 0).unwrap();
        assert_eq!(p.markets_with_oi, 1);
        book_open(&mut p, &mut m, &mut b, Pubkey::default(), 1, false,
                  1_000_000_000, 0, Pubkey::default(), size, PX, 0).unwrap();
        assert_eq!(p.markets_with_oi, 1);

        // Emptying one side leaves the market in; emptying both takes it out.
        book_close(&mut p, &mut m, &mut a, size, PX, 1).unwrap();
        assert_eq!(p.markets_with_oi, 1);
        book_close(&mut p, &mut m, &mut b, size, PX, 1).unwrap();
        assert_eq!(p.markets_with_oi, 0);
        assert!(!m.has_open_interest());
    }

    #[test]
    fn a_partial_close_keeps_the_market_counted() {
        let (mut p, mut m, mut pos) = (pool(), market(), position());
        p.markets_with_oi = 0;
        book_open(&mut p, &mut m, &mut pos, Pubkey::default(), 1, true,
                  1_000_000_000, 0, Pubkey::default(), 5_000_000_000, PX, 0).unwrap();
        book_close(&mut p, &mut m, &mut pos, 2_000_000_000, PX, 1)
            .unwrap();
        assert_eq!(p.markets_with_oi, 1);
    }

    #[test]
    fn adding_to_a_position_keeps_each_part_owing_its_own_funding() {
        let (mut p, mut m, mut pos) = (pool(), market(), position());
        let first = 5_000_000_000;
        book_open(&mut p, &mut m, &mut pos, Pubkey::default(), 1, true,
                  1_000_000_000, 0, Pubkey::default(), first, PX, 0).unwrap();
        let (books_before, collateral_before) = (p.trader_collateral_usd, pos.collateral_usd);

        m.cumulative_long_funding += 1_000_000_000_000;
        let owed_on_first = settle(&pos, &m, first, PX).unwrap().funding_usd;

        // Add as much again. Nothing is settled: the collateral is what was
        // posted, and the pool's books did not move.
        let second = 5_000_000_000;
        book_open(&mut p, &mut m, &mut pos, Pubkey::default(), 1, true,
                  1_000_000_000, 0, Pubkey::default(), second, PX, 1).unwrap();
        assert_eq!(pos.collateral_usd, collateral_before + 1_000_000_000);
        assert_eq!(p.trader_collateral_usd, books_before + 1_000_000_000);

        // Later: the first part owes from its entry, the second from the add.
        m.cumulative_long_funding += 1_000_000_000_000;
        let owed = settle(&pos, &m, pos.size_usd, PX).unwrap().funding_usd;
        // Two steps on the first part, one on the second, each the same size.
        let expected = 3 * owed_on_first;
        assert!((owed - expected).abs() <= 2, "{owed} vs {expected}");
    }

    #[test]
    fn a_partial_close_leaves_the_rest_owing_its_funding() {
        let (mut p, mut m, mut pos) = (pool(), market(), position());
        let size = 5_000_000_000;
        book_open(&mut p, &mut m, &mut pos, Pubkey::default(), 1, true,
                  1_000_000_000, 0, Pubkey::default(), size, PX, 0).unwrap();
        // Longs have accrued funding since the open.
        m.cumulative_long_funding += 1_000_000_000_000;
        let owed_before = settle(&pos, &m, pos.size_usd, PX).unwrap().funding_usd;
        assert!(owed_before > 0);

        // Close one dollar of it.
        book_close(&mut p, &mut m, &mut pos, 1_000_000, PX, 1).unwrap();
        let owed_after = settle(&pos, &m, pos.size_usd, PX).unwrap().funding_usd;
        // The remaining size still owes its share, not nothing.
        let expected = (owed_before as i128 * (size - 1_000_000) as i128 / size as i128) as i64;
        assert!((owed_after - expected).abs() <= 1, "{owed_after} vs {expected}");
    }

    #[test]
    fn a_liquidation_fee_is_split_like_every_other_fee() {
        // The same steps `liquidate` takes, on the pure functions.
        let (mut p, mut m, mut pos) = (pool(), market(), position());
        let size = 5_000_000_000; // $5,000 long, $1,000 margin, at $100
        book_open(&mut p, &mut m, &mut pos, Pubkey::default(), 1, true,
                  1_000_000_000, 0, Pubkey::default(), size, PX, 0).unwrap();

        // Down 18%: $900 lost, $100 of equity, under the 5% maintenance line.
        let settlement = settle(&pos, &m, size, 82_000_000).unwrap();
        let equity = settlement.equity_usd;
        assert!(equity > 0 && equity < bps_of(size, m.maintenance_margin_bps).unwrap());

        let fee = bps_of(size, m.liquidation_fee_bps).unwrap().min(equity);
        let cuts = fee_cuts_usd(&p, fee).unwrap();
        let (bounty, to_owner) = (fee - cuts, equity - fee);
        let before = vault_books(&p);

        apply_settlement_to_pool(&mut p, &mut m, &pos, &settlement, equity - cuts, 0, size, true).unwrap();
        take_fee_cuts(&mut p, fee).unwrap();

        // docs/fees.md: 20% protocol, 10% chain, 10% insurance. The liquidator
        // takes the 60% the LPs would otherwise have had.
        assert_eq!(fee, 50_000_000);
        assert_eq!(p.protocol_fees_usd, 10_000_000);
        assert_eq!(p.chain_fees_usd, 5_000_000);
        assert_eq!(p.insurance_usd, 5_000_000);
        assert_eq!(bounty, 30_000_000);
        // Only the owner's remainder and the liquidator's share left the vault.
        assert_eq!(vault_books(&p), before - (to_owner + bounty) as u128);
    }

    #[test]
    fn a_backed_market_pays_its_backers_half_the_lps_open_fee() {
        let (mut p, mut m, mut pos) = (pool(), market(), position());
        backed(&mut p, &mut m, 1_000_000_000);
        let (liq, books) = (p.liquidity_usd, vault_books(&p));
        let budget = m.loss_budget_usd;
        let fee = 1_000_000;

        let paid = book_open(&mut p, &mut m, &mut pos, Pubkey::default(), 1, true,
                             1_000_000_000, fee, Pubkey::default(), 5_000_000_000, PX, 0)
            .unwrap();

        // $1 of fee: 20% protocol, 10% chain, 10% insurance, and the $0.60
        // left split between the backers and the LPs.
        let lp_fee = fee - 200_000 - 100_000 - 100_000;
        assert_eq!(paid as u128, lp_fee as u128 * BACKER_FEE_SHARE_BPS as u128 / BPS);
        assert_eq!(paid, 300_000);
        assert_eq!(p.liquidity_usd, liq + lp_fee - paid, "the LPs keep the remainder");
        assert_eq!(p.backing_usd, 1_000_000_000 + paid);
        assert_eq!(m.backing_usd, 1_000_000_000 + paid);
        // A share is worth more, and there are no more of them.
        assert_eq!(m.backing_value(1_000_000_000), 1_000_000_000 + paid);
        // Fee income is not new rope.
        assert_eq!(m.loss_budget_usd, budget);
        // The vault still reconciles: the fee and the margin arrived, nothing else.
        assert_eq!(vault_books(&p), books + fee as u128 + 1_000_000_000);
    }

    #[test]
    fn an_unbacked_market_pays_its_whole_lp_fee_to_the_lps() {
        let (mut p, mut m, mut pos) = (pool(), market(), position());
        let liq = p.liquidity_usd;
        let paid = book_open(&mut p, &mut m, &mut pos, Pubkey::default(), 1, true,
                             1_000_000_000, 1_000_000, Pubkey::default(), 5_000_000_000, PX, 0)
            .unwrap();
        assert_eq!(paid, 0);
        assert_eq!(p.liquidity_usd, liq + 600_000);
        assert_eq!(p.backing_usd, 0);
        assert_eq!(m.backing_usd, 0);
    }

    #[test]
    fn a_backed_market_pays_its_backers_half_the_lps_close_fee() {
        let (mut p, mut m, mut pos) = long_at(PX, 5_000_000_000, 1_000_000_000);
        backed(&mut p, &mut m, 1_000_000_000);
        m.close_fee_bps = 10;
        let (liq, books) = (p.liquidity_usd, vault_books(&p));

        // Out flat, so the only thing the pool gains is the fee.
        let c = book_close(&mut p, &mut m, &mut pos, 5_000_000_000, PX, 100).unwrap();

        // $5 of fee on $5,000: $1 protocol, $0.50 chain, $0.50 insurance, and
        // $3 for the LPs, half of which goes to the backers.
        assert_eq!(c.fee_usd, 5_000_000);
        assert_eq!(c.backer_fee_usd, 1_500_000);
        assert_eq!(m.backing_usd, 1_000_000_000 + 1_500_000);
        assert_eq!(p.backing_usd, 1_000_000_000 + 1_500_000);
        assert_eq!(p.liquidity_usd, liq + 1_500_000);
        assert_eq!(m.backing_drawn_usd, 0, "a fee is not a repayment");
        // Only the payout left the books.
        assert_eq!(vault_books(&p), books - c.payout_usd as u128);
    }

    #[test]
    fn an_unbacked_close_is_unchanged() {
        let (mut p, mut m, mut pos) = long_at(PX, 5_000_000_000, 1_000_000_000);
        m.close_fee_bps = 10;
        let liq = p.liquidity_usd;
        let c = book_close(&mut p, &mut m, &mut pos, 5_000_000_000, PX, 100).unwrap();
        assert_eq!(c.backer_fee_usd, 0);
        assert_eq!(p.liquidity_usd, liq + 3_000_000);
        assert_eq!(p.backing_usd, 0);
    }

    /// `book_close` is the other half, and the one that pays people. These go
    /// at it directly rather than through a settlement, because the settlement
    /// needs a sealed batch and a vault and these need neither.
    pub(crate) fn long_at(px: u64, size: u64, collateral: u64) -> (Pool, Market, Position) {
        let (mut p, mut m, mut pos) = (pool(), market(), position());
        book_open(&mut p, &mut m, &mut pos, Pubkey::new_unique(), 1, true,
                  collateral, 0, Pubkey::new_unique(), size, px, 0).unwrap();
        (p, m, pos)
    }

    #[test]
    fn closing_a_long_in_profit_pays_collateral_plus_the_gain() {
        // $5,000 of size at $100, on $1,000 of margin. Out at $110: a 10% move
        // on five thousand dollars of notional is five hundred dollars.
        let (mut p, mut m, mut pos) = long_at(PX, 5_000_000_000, 1_000_000_000);
        let c = book_close(&mut p, &mut m, &mut pos, 5_000_000_000,
                           PX + PX / 10, 100).unwrap();

        assert_eq!(c.pnl_usd, 500_000_000);
        let fee = bps_of(5_000_000_000, m.close_fee_bps).unwrap();
        assert_eq!(c.fee_usd, fee);
        assert_eq!(c.payout_usd, 1_000_000_000 + 500_000_000 - fee);
        assert_eq!(c.remaining_usd, 0);

        // Nothing of the position survives, including the accounting behind it.
        assert!(!pos.is_open());
        assert_eq!(pos.collateral_usd, 0);
        assert_eq!(pos.locked_usd, 0);
        assert_eq!(pos.open_ts, 0);
        assert_eq!(m.long_size_usd, 0);
        assert_eq!(m.collateral_usd, 0);
        assert_eq!(p.trader_collateral_usd, 0);
    }

    #[test]
    fn a_loss_stays_with_the_pool_rather_than_the_trader() {
        let (mut p, mut m, mut pos) = long_at(PX, 5_000_000_000, 1_000_000_000);
        let before = p.liquidity_usd;
        let c = book_close(&mut p, &mut m, &mut pos, 5_000_000_000,
                           PX - PX / 10, 100).unwrap();

        assert_eq!(c.pnl_usd, -500_000_000);
        // The half of the margin the trader did not lose is what comes back.
        assert_eq!(c.payout_usd, 1_000_000_000 - 500_000_000 - c.fee_usd);
        // And the half they did is the LPs', which is what makes them the
        // counterparty rather than a spectator.
        assert!(p.liquidity_usd > before);
    }

    #[test]
    fn a_partial_close_pro_rates_the_collateral_and_leaves_the_entry() {
        let (mut p, mut m, mut pos) = long_at(PX, 5_000_000_000, 1_000_000_000);
        let c = book_close(&mut p, &mut m, &mut pos, 2_000_000_000, PX, 100).unwrap();

        assert_eq!(c.remaining_usd, 3_000_000_000);
        assert_eq!(pos.size_usd, 3_000_000_000);
        // Two fifths of the size took two fifths of the margin with it.
        assert_eq!(pos.collateral_usd, 600_000_000);
        assert_eq!(pos.entry_price, PX, "the rest is still the same trade");
        assert_eq!(m.long_size_usd, 3_000_000_000);
    }

    #[test]
    fn a_fee_cannot_push_a_payout_below_zero() {
        // Out at a price that wipes the margin exactly. There is nothing left
        // to take a fee from, and the close still has to complete: a
        // settlement that errors here strands an order in a sealed batch.
        let (mut p, mut m, mut pos) = long_at(PX, 5_000_000_000, 1_000_000_000);
        let c = book_close(&mut p, &mut m, &mut pos, 5_000_000_000,
                           PX - PX / 5, 100).unwrap();
        assert_eq!(c.payout_usd, 0);
        assert_eq!(c.fee_usd, 0);
    }

    #[test]
    fn closing_more_than_is_open_is_refused() {
        let (mut p, mut m, mut pos) = long_at(PX, 5_000_000_000, 1_000_000_000);
        assert!(book_close(&mut p, &mut m, &mut pos, 5_000_000_001, PX, 100).is_err());
    }

    #[test]
    fn a_close_may_leave_a_remainder_under_the_minimum() {
        // Deliberate. The floor stops dust being opened; applying it to what a
        // close leaves behind would mean a settlement that cannot complete,
        // and the order it belongs to can no longer be cancelled by then.
        let (mut p, mut m, mut pos) = long_at(PX, 5_000_000_000, 1_000_000_000);
        let leaving = m.min_position_usd / 2;
        book_close(&mut p, &mut m, &mut pos, 5_000_000_000 - leaving, PX, 100).unwrap();
        assert_eq!(pos.size_usd, leaving);
    }

    #[test]
    fn a_position_cannot_promise_more_size_than_it_has() {
        let mut pos = position();
        pos.size_usd = 1_000;
        pos.reserve_close(600).unwrap();
        assert_eq!(pos.closable_usd(), 400);
        // Without this a trader submits the same size to close twice and each
        // settlement unwinds a position that only ever covered the first.
        assert!(pos.reserve_close(401).is_err());
        pos.reserve_close(400).unwrap();
        assert_eq!(pos.closable_usd(), 0);
    }

    #[test]
    fn a_release_past_what_was_reserved_does_not_wrap() {
        // A liquidation empties a position without consulting the orders
        // resting against it, so settlement can legitimately hand back size
        // that is no longer promised to anything.
        let mut pos = position();
        pos.size_usd = 1_000;
        pos.reserve_close(300).unwrap();
        pos.release_close(900);
        assert_eq!(pos.closing_usd, 0);
    }

    pub(crate) fn settlement(collateral_share: u64, equity_usd: u64) -> Settlement {
        Settlement {
            collateral_share,
            locked_release: 0,
            pnl_usd: equity_usd as i64 - collateral_share as i64,
            funding_usd: 0,
            equity_usd,
        }
    }

    #[test]
    fn a_forced_close_pays_a_loser_everything_it_has_left() {
        let mut m = market();
        m.charge_loss(m.remaining_budget_usd()).unwrap();
        // No budget at all, and $600 of the $1,000 margin left: all of it back.
        assert_eq!(payable_usd(&m, &settlement(1_000_000_000, 600_000_000)), 600_000_000);
    }

    #[test]
    fn a_forced_close_pays_profit_only_as_far_as_the_budget() {
        let mut m = market();
        m.charge_loss(m.remaining_budget_usd() - 200_000_000).unwrap();
        // $500 of profit owed, $200 of budget left: collateral plus $200.
        let s = settlement(1_000_000_000, 1_500_000_000);
        assert_eq!(payable_usd(&m, &s), 1_200_000_000);
        // With the budget intact, the whole of it.
        assert_eq!(payable_usd(&market(), &s), 1_500_000_000);
    }

    #[test]
    fn the_fee_cuts_are_the_documented_forty_percent() {
        // docs/fees.md: 10 USDC of fee is 2 protocol, 1 insurance, 1 chain.
        assert_eq!(fee_cuts_usd(&pool(), 10_000_000).unwrap(), 4_000_000);
    }

    #[test]
    fn fee_cuts_stop_at_what_liquidity_holds() {
        let mut p = pool();
        p.liquidity_usd = 150;
        let books = vault_books(&p);
        // The protocol's 200 is clamped to the 150 there is; nothing is left
        // for the chain or the fund, and nothing is invented for them.
        assert_eq!(take_fee_cuts(&mut p, 1_000).unwrap(), 150);
        assert_eq!((p.protocol_fees_usd, p.chain_fees_usd, p.insurance_usd), (150, 0, 0));
        assert_eq!(p.liquidity_usd, 0);
        assert_eq!(vault_books(&p), books);
    }

    #[test]
    fn a_loss_is_paid_by_backers_then_lps_then_the_fund() {
        let (mut p, mut m) = (pool(), market());
        backed(&mut p, &mut m, 100);
        p.liquidity_usd = 50;
        p.insurance_usd = 1_000;
        p.trader_collateral_usd = 1_000;
        let books = vault_books(&p);
        // $300 owed past $1,000 of collateral.
        apply_settlement_to_pool(&mut p, &mut m, &position(), &settlement(1_000, 1_300), 1_300, 0, 0, true)
            .unwrap();
        assert_eq!((m.backing_usd, p.backing_usd, m.backing_drawn_usd), (0, 0, 100));
        assert_eq!(p.liquidity_usd, 0);
        assert_eq!(p.insurance_usd, 850);
        assert_eq!(m.net_loss_usd, 300);
        assert_eq!(vault_books(&p), books - 1_300);
    }

    #[test]
    fn a_gain_repays_the_backers_only_what_losses_took() {
        let (mut p, mut m) = (pool(), market());
        backed(&mut p, &mut m, 100);
        m.backing_drawn_usd = 100;
        p.trader_collateral_usd = 1_000;
        let liq = p.liquidity_usd;
        // The trader leaves $300 of their $1,000 behind.
        apply_settlement_to_pool(&mut p, &mut m, &position(), &settlement(1_000, 700), 700, 0, 0, true)
            .unwrap();
        assert_eq!((m.backing_usd, p.backing_usd, m.backing_drawn_usd), (200, 200, 0));
        assert_eq!(p.liquidity_usd, liq + 200, "the rest is the LPs'");
        assert_eq!(m.net_loss_usd, -300);
    }

    #[test]
    fn a_payout_past_the_budget_is_refused_whole() {
        let (mut p, mut m) = (pool(), market());
        m.charge_loss(m.remaining_budget_usd() - 100).unwrap();
        p.trader_collateral_usd = 1_000;
        let liq = p.liquidity_usd;
        let r = apply_settlement_to_pool(&mut p, &mut m, &position(), &settlement(1_000, 1_101), 1_101, 0, 0, true);
        assert!(r.is_err());
        assert_eq!(p.liquidity_usd, liq, "nothing was paid");
    }

    // Found by the Kani harness `a_winner_the_budget_holds_back_can_be_deleveraged`,
    // when a spent budget left a close unfilled: a position whose gain is
    // funding received rather than price could neither leave by the batch
    // nor be deleveraged. A close now always fills, so it leaves with its
    // collateral and the unpayable funding is cut.
    #[test]
    fn a_winner_by_funding_leaves_with_its_collateral_when_the_budget_is_spent() {
        let (mut p, mut m, mut pos) = long_at(PX, 5_000_000_000, 1_000_000_000);
        // Flat price, and longs have received $100 of funding since the open.
        m.cumulative_long_funding -= FUNDING_SCALE / 50;
        m.charge_loss(m.remaining_budget_usd()).unwrap();
        let size = pos.size_usd;
        let closed = book_close(&mut p, &mut m, &mut pos, size, PX, 1).unwrap();
        assert_eq!(pos.size_usd, 0);
        assert_eq!(closed.payout_usd, 1_000_000_000);
        assert_eq!(closed.haircut_usd, 100_000_000);
    }

    #[test]
    fn closing_nothing_fills_nothing() {
        let (p, m, pos) = long_at(PX, 5_000_000_000, 1_000_000_000);
        assert_eq!(close_within_budget(&p, &pos, &m, 0, PX).unwrap(), 0);
    }

    #[test]
    fn a_closed_session_tightens_the_leverage_an_open_may_take() {
        let (p, mut m, pos) = (pool(), market(), position());
        // 5x on $1,000 is inside the listed 10x.
        assert!(check_open(&p, &m, &pos, true, 1_000_000_000, 5_000_000_000, PX).is_ok());
        // With the underlying closed the cap is 2x, and the same open is over it.
        m.session = Session::Closed as u8;
        assert!(check_open(&p, &m, &pos, true, 1_000_000_000, 5_000_000_000, PX).is_err());
        assert!(check_open(&p, &m, &pos, true, 1_000_000_000, 2_000_000_000, PX).is_ok());
    }

    #[test]
    fn a_closed_session_tightens_the_open_interest_cap() {
        let (p, mut m, pos) = (pool(), market(), position());
        m.max_oi_long_usd = 8_000_000_000;
        m.session = Session::Closed as u8;
        // A quarter of $8,000 while closed: $2,000 fits, a unit more does not.
        let plan = check_open(&p, &m, &pos, true, 1_000_000_000, 2_000_000_000, PX).unwrap();
        assert_eq!(plan.side_oi, 2_000_000_000);
        assert!(check_open(&p, &m, &pos, true, 1_000_000_000, 2_000_000_001, PX).is_err());
        // The short side has its own cap and is untouched by the long one.
        m.long_size_usd = 2_000_000_000;
        assert!(check_open(&p, &m, &pos, false, 1_000_000_000, 1_000_000_000, PX).is_ok());
    }

    #[test]
    fn an_open_locks_nothing_whatever_its_reserve_setting() {
        let (mut p, mut m, mut pos) = (pool(), market(), position());
        m.pnl_reserve_bps = 5_000;
        book_open(&mut p, &mut m, &mut pos, Pubkey::default(), 1, true,
                  1_000_000_000, 0, Pubkey::default(), 5_000_000_000, PX, 0).unwrap();
        assert_eq!((pos.locked_usd, p.locked_usd, m.locked_usd), (0, 0, 0));
    }

    #[test]
    fn funding_owed_counts_against_the_margin_of_an_add() {
        let (mut p, mut m, mut pos) = (pool(), market(), position());
        book_open(&mut p, &mut m, &mut pos, Pubkey::default(), 1, true,
                  1_000_000_000, 0, Pubkey::default(), 5_000_000_000, PX, 0).unwrap();
        // Longs now owe a tenth of their notional: $500 of the $1,000.
        m.cumulative_long_funding += FUNDING_SCALE / 10;
        // $400 more against $5,000 more would be 7x on gross collateral, but
        // 11x on the $900 actually left, so it is refused.
        assert!(check_open(&p, &m, &pos, true, 400_000_000, 5_000_000_000, PX).is_err());
        // $500 more makes it exactly 10x on what is left.
        assert!(check_open(&p, &m, &pos, true, 500_000_000, 5_000_000_000, PX).is_ok());
    }

    #[test]
    fn an_add_keeps_the_funding_the_old_size_already_owed() {
        let (mut p, mut m, mut pos) = (pool(), market(), position());
        book_open(&mut p, &mut m, &mut pos, Pubkey::default(), 1, true,
                  2_000_000_000, 0, Pubkey::default(), 5_000_000_000, PX, 0).unwrap();
        m.cumulative_long_funding += FUNDING_SCALE / 10;
        book_open(&mut p, &mut m, &mut pos, Pubkey::default(), 1, true,
                  1_000_000_000, 0, Pubkey::default(), 5_000_000_000, PX, 1).unwrap();
        // The blended index sits halfway, so the whole position still owes the
        // $500 the first half ran up and nothing for the second.
        assert_eq!(pos.entry_funding, FUNDING_SCALE / 20);
        let s = settle(&pos, &m, pos.size_usd, PX).unwrap();
        assert_eq!(s.funding_usd, 500_000_000);
    }

    #[test]
    fn two_closes_release_a_lock_left_from_before_however_it_rounds() {
        let (mut p, mut m, mut pos) = (pool(), market(), position());
        book_open(&mut p, &mut m, &mut pos, Pubkey::default(), 1, true,
                  1_000, 0, Pubkey::default(), 3_000, PX, 0).unwrap();
        // A position opened while reserves were still taken carries one.
        (pos.locked_usd, p.locked_usd, m.locked_usd) = (999, 999, 999);
        // A third of the size takes a third of the lock, rounded down...
        book_close(&mut p, &mut m, &mut pos, 1_000, PX, 1).unwrap();
        assert_eq!(p.locked_usd, 666);
        // ...and the rest takes the rest, so no unit is stranded in the pool.
        book_close(&mut p, &mut m, &mut pos, 2_000, PX, 2).unwrap();
        assert_eq!((p.locked_usd, m.locked_usd, pos.locked_usd), (0, 0, 0));
        assert_eq!(p.trader_collateral_usd, 0);
    }

    #[test]
    fn a_round_trip_at_one_price_costs_the_pool_nothing() {
        let (mut p, mut m, mut pos) = (pool(), market(), position());
        m.close_fee_bps = 10;
        let lines = |p: &Pool| {
            p.liquidity_usd + p.backing_usd + p.insurance_usd + p.protocol_fees_usd + p.chain_fees_usd
        };
        let before = lines(&p);
        book_open(&mut p, &mut m, &mut pos, Pubkey::default(), 1, false,
                  1_000_000_000, 0, Pubkey::default(), 5_000_000_000, PX, 0).unwrap();
        let c = book_close(&mut p, &mut m, &mut pos, 5_000_000_000, PX, 1).unwrap();
        // The trader leaves with their margin less the close fee, and the fee
        // is what the pool's lines gained.
        assert_eq!(c.payout_usd, 1_000_000_000 - 5_000_000);
        assert_eq!(lines(&p), before + 5_000_000);
        assert_eq!((p.locked_usd, p.trader_collateral_usd, m.net_loss_usd), (0, 0, -5_000_000));
    }

    /// A cross between two traders costs the pool nothing only while both legs
    /// book. A short adding at the leverage cap, whose funding owed tips the
    /// add over it once the batch has sealed, used to go home unfilled while
    /// the taker it crossed booked a position at the band's edge with the pool
    /// as the only counterparty. An open that cleared books.
    #[test]
    fn a_cleared_open_is_not_dropped_for_leverage_at_settlement() {
        let (mut p, mut m, mut pos) = (pool(), market(), position());
        book_open(&mut p, &mut m, &mut pos, Pubkey::default(), 1, false,
                  1_000_000_000, 0, Pubkey::default(), 10_000_000_000, PX, 0).unwrap();
        // Shorts now owe a tenth of a percent: the position sits past 10x.
        m.cumulative_short_funding += FUNDING_SCALE / 1_000;
        let order = BatchOrder {
            is_maker: 1,
            ..batch_order(Pubkey::new_unique(), false, 1_000_000_000, 100_000_000,
                          1_000_000_000, false)
        };
        let (filled, used, fee) = open_fill(&p, &m, &pos, &order, PX, 0).unwrap();
        assert_eq!(filled, 1_000_000_000, "the maker leg books in full");
        assert_eq!((used, fee), (100_000_000, 0));
    }

    #[test]
    fn a_cleared_open_is_not_dropped_for_open_interest_at_settlement() {
        // Other opens in the same batch settled first and took the side's cap.
        let (p, mut m, pos) = (pool(), market(), position());
        m.max_oi_short_usd = 500_000_000;
        let order = batch_order(Pubkey::new_unique(), false, 1_000_000_000, 100_000_000,
                                1_000_000_000, false);
        let (filled, _, _) = open_fill(&p, &m, &pos, &order, PX, 0).unwrap();
        assert_eq!(filled, 1_000_000_000);
    }

    /// Settlement accrues funding between `open_fill` and booking. An add at
    /// the cap passed the first and failed the second, and the revert held
    /// the batch sealed until someone ran the funding crank.
    #[test]
    fn funding_accrued_after_the_fill_is_found_does_not_revert_the_booking() {
        let (mut p, mut m, mut pos) = (pool(), market(), position());
        book_open(&mut p, &mut m, &mut pos, Pubkey::default(), 1, true,
                  1_000_000_000, 0, Pubkey::default(), 10_000_000_000, PX, 0).unwrap();
        let order = batch_order(Pubkey::new_unique(), true, 1_000_000_000, 100_000_000,
                                1_000_000_000, false);
        let (filled, used, fee) = open_fill(&p, &m, &pos, &order, PX, 0).unwrap();
        assert_eq!(filled, 1_000_000_000);
        m.cumulative_long_funding += FUNDING_SCALE / 1_000;
        // The capped booking would now refuse it; settlement's does not.
        assert!(check_open(&p, &m, &pos, true, used - fee, filled, PX).is_err());
        book_cleared_open(&mut p, &mut m, &mut pos, order.owner, 1, true, used - fee, fee,
                          Pubkey::default(), filled, PX, 1).unwrap();
        assert_eq!(pos.size_usd, 11_000_000_000);
    }
}

/// The side moment sums and the haircut that reads them, across random
/// sequences of opens, top-ups, partial and full closes, liquidations and
/// price moves.
#[cfg(test)]
mod moment_tests {
    use super::tests::{market, pool, position, PX};
    use super::*;

    struct Rng(u64);
    impl Rng {
        fn next(&mut self) -> u64 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            self.0
        }
        fn below(&mut self, n: u64) -> u64 {
            self.next() % n
        }
    }

    /// The sums recomputed from the positions, side by side.
    fn recompute(m: &Market, positions: &[Position]) -> [SideMoments; 2] {
        let mut out = [SideMoments::default(); 2];
        for pos in positions {
            if let Some((size, entry)) = m.tracked_term(pos) {
                let (u, q) = moment_terms(size, entry).unwrap();
                let side = &mut out[usize::from(!pos.is_long)];
                side.tracked_usd += size;
                side.inv_entry += u;
                side.inv_entry_sq += q;
            }
        }
        out
    }

    /// Gross profit the winners on one side hold at `price`, position by
    /// position: what the bound has to stay above.
    fn gross_winners(m: &Market, positions: &[Position], is_long: bool, price: u64) -> u64 {
        positions
            .iter()
            .filter(|p| p.is_open() && p.is_long == is_long)
            .map(|p| {
                let e = m.adjust_entry_price(p.entry_price, p.entry_price_factor).unwrap();
                position_pnl_usd(is_long, p.size_usd, e, price).unwrap().max(0) as u64
            })
            .sum()
    }

    fn available(p: &Pool, m: &Market) -> u64 {
        m.remaining_budget_usd()
            .min(m.backing_usd.saturating_add(p.liquidity_usd).saturating_add(p.insurance_usd))
    }

    #[test]
    fn the_sums_match_the_positions_and_no_winner_is_paid_past_its_share() {
        let mut winning_closes = 0;
        for seed in 1..=60u64 {
            let mut rng = Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1);
            let (mut p, mut m) = (pool(), market());
            let budget = 200_000_000 + rng.below(3_000_000_000);
            m.charge_loss(m.remaining_budget_usd() - budget).unwrap();
            let mut positions: Vec<Position> = (0..6).map(|_| position()).collect();
            let mut price = PX;
            for _ in 0..250 {
                let i = rng.below(positions.len() as u64) as usize;
                match rng.below(10) {
                    0..=1 => {
                        // The price walks between $40 and $250.
                        let step = (price / 20).max(1);
                        price = if rng.below(2) == 0 { price + step } else { price - step };
                        price = price.clamp(40 * PX / 100, 250 * PX / 100);
                    }
                    2..=4 => {
                        let is_long = if positions[i].is_open() {
                            positions[i].is_long
                        } else {
                            rng.below(2) == 0
                        };
                        let size = 10_000_000 + rng.below(5_000_000_000);
                        let pos = &mut positions[i];
                        let _ = book_open(&mut p, &mut m, pos, Pubkey::default(), 1, is_long,
                                          size / 2 + 1, 0, Pubkey::default(), size, price, 0);
                    }
                    5..=7 => {
                        if !positions[i].is_open() {
                            continue;
                        }
                        let is_long = positions[i].is_long;
                        let full = positions[i].size_usd;
                        let size = if rng.below(2) == 0 { full } else { 1 + rng.below(full) };
                        let s = settle(&positions[i], &m, size, price).unwrap();
                        let owed = s.equity_usd.saturating_sub(s.collateral_share);
                        let others = gross_winners(&m, &positions, !is_long, price)
                            + gross_winners(&m, &positions, is_long, price);
                        let whole = {
                            let e = m.adjust_entry_price(positions[i].entry_price,
                                                         positions[i].entry_price_factor).unwrap();
                            position_pnl_usd(is_long, full, e, price).unwrap().max(0) as u64
                        };
                        // The true gross winners, counting this close at no
                        // less than what it is owed.
                        let true_winners = others - whole + whole.max(owed);
                        let cash = available(&p, &m);
                        let closed = book_close(&mut p, &mut m, &mut positions[i], size, price, 1)
                            .unwrap();
                        let paid = closed.payout_usd.saturating_sub(s.collateral_share);
                        if owed > 0 && true_winners > cash {
                            winning_closes += 1;
                            let fair = (owed as u128 * cash as u128 / true_winners as u128) as u64;
                            assert!(paid <= fair + 1, "seed {seed}: paid {paid} past fair {fair}");
                        }
                    }
                    8 => {
                        // A forced close, the way `liquidate` and ADL book it.
                        if !positions[i].is_open() {
                            continue;
                        }
                        let pos = positions[i].clone();
                        let s = settle(&pos, &m, pos.size_usd, price).unwrap();
                        let payout = payable_usd(&m, &s);
                        apply_settlement_to_pool(&mut p, &mut m, &pos, &s, payout, 0,
                                                 pos.size_usd, pos.is_long).unwrap();
                        let pos = &mut positions[i];
                        pos.size_usd = 0;
                        pos.collateral_usd = 0;
                        pos.entry_price = 0;
                        pos.entry_price_factor = 0;
                    }
                    _ => {
                        let _ = m.charge_loss(m.remaining_budget_usd() / 3);
                    }
                }
                // Never one-sided: the sums are exactly the positions'.
                let [long, short] = recompute(&m, &positions);
                assert_eq!(long, m.long_moments, "seed {seed}: long sums drifted");
                assert_eq!(short, m.short_moments, "seed {seed}: short sums drifted");
                assert_eq!(m.long_moments.tracked_usd, m.long_size_usd);
                assert_eq!(m.short_moments.tracked_usd, m.short_size_usd);
                // Size, average entry and the sums agree: the side's average
                // is the positions' harmonic mean, so its net PnL is theirs.
                for is_long in [true, false] {
                    let open: Vec<&Position> = positions.iter()
                        .filter(|q| q.is_open() && q.is_long == is_long).collect();
                    let size: u64 = open.iter().map(|q| q.size_usd).sum();
                    let (side_size, avg) = if is_long {
                        (m.long_size_usd, m.long_avg_entry_price)
                    } else {
                        (m.short_size_usd, m.short_avg_entry_price)
                    };
                    assert_eq!(side_size, size, "seed {seed}: side size");
                    if size == 0 {
                        continue;
                    }
                    let units: u128 = open.iter()
                        .map(|q| q.size_usd as u128 * MOMENT_U_SCALE / q.entry_price as u128).sum();
                    let harmonic = (size as u128 * MOMENT_U_SCALE / units) as u64;
                    assert!(avg.abs_diff(harmonic) <= 1, "seed {seed}: avg {avg} vs {harmonic}");
                    let pnl: i64 = open.iter()
                        .map(|q| position_pnl_usd(is_long, q.size_usd, q.entry_price, price).unwrap())
                        .sum();
                    let agg = position_pnl_usd(is_long, size, avg, price).unwrap();
                    // One unit of entry is size / entry of PnL at most.
                    let tol = (size as u128 * price as u128 / (avg as u128 * avg as u128)) as i64
                        + open.len() as i64 + 1;
                    assert!((agg - pnl).abs() <= tol, "seed {seed}: side pnl {agg} vs {pnl}");
                }
                // The bound is a bound.
                for is_long in [true, false] {
                    let bound = m.side_winners_bound_usd(is_long, price).unwrap();
                    assert!(bound >= gross_winners(&m, &positions, is_long, price),
                            "seed {seed}: bound under the winners");
                }
                // And nothing paid past the budget, in any order.
                assert!(m.net_loss_usd <= m.loss_budget_usd as i64, "seed {seed}");
            }
        }
        assert!(winning_closes > 50, "the haircut bound in only {winning_closes} closes");
    }

    #[test]
    fn the_bound_is_exact_with_one_entry_and_close_on_the_repro() {
        let mut m = market();
        // Three longs at one entry: the bound is the side's profit.
        for _ in 0..3 {
            m.long_size_usd += 1_000_000_000;
            assert!(m.retrack(true, None, 1_000_000_000, PX));
        }
        let up = PX + PX / 10;
        let b = m.side_winners_bound_usd(true, up).unwrap();
        assert!((300_000_000..=300_000_005).contains(&b), "bound {b}");
        assert!(m.side_winners_bound_usd(true, PX - PX / 10).unwrap() <= 5);

        // The repro's long side: A $5,000 at $100, B $6,000 at $120, at $110.
        // Gross winners $500, net zero; the bound reads $502.08.
        let mut m = market();
        m.long_size_usd = 11_000_000_000;
        assert!(m.retrack(true, None, 5_000_000_000, PX));
        assert!(m.retrack(true, None, 6_000_000_000, PX + PX / 5));
        let b = m.side_winners_bound_usd(true, up).unwrap();
        assert!((502_000_000..=502_100_000).contains(&b), "bound {b}");
    }

    #[test]
    fn a_side_holding_an_untracked_position_counts_net_until_it_is_gone() {
        // Long L was opened before the sums existed: its term is not in them
        // and it carries no tag.
        let (mut p, mut m) = (pool(), market());
        let (mut legacy, mut fresh) = (position(), position());
        book_open(&mut p, &mut m, &mut legacy, Pubkey::default(), 1, true,
                  1_000_000_000, 0, Pubkey::default(), 5_000_000_000, PX, 0).unwrap();
        m.long_moments = SideMoments::default();
        legacy.q_epoch = 0;

        book_open(&mut p, &mut m, &mut fresh, Pubkey::default(), 1, true,
                  1_000_000_000, 0, Pubkey::default(), 6_000_000_000, PX + PX / 5, 0).unwrap();
        assert_eq!(fresh.q_epoch, m.q_tag());
        let up = PX + PX / 10;
        assert_eq!(m.side_winners_bound_usd(true, up), None, "incomplete");
        // So the side counts net, the old rule.
        let net = position_pnl_usd(true, m.long_size_usd, m.long_avg_entry_price, up)
            .unwrap().max(0) as u64;
        assert_eq!(m.side_winners_usd(true, up).unwrap(), net);

        // A partial close of the legacy position leaves the sums alone.
        let before = m.long_moments;
        book_close(&mut p, &mut m, &mut legacy, 1_000_000_000, up, 1).unwrap();
        assert_eq!(m.long_moments, before);
        assert_eq!(m.side_winners_bound_usd(true, up), None);

        // Topping it up brings the whole of it in.
        book_open(&mut p, &mut m, &mut legacy, Pubkey::default(), 1, true,
                  1_000_000_000, 0, Pubkey::default(), 1_000_000_000, up, 0).unwrap();
        assert_eq!(legacy.q_epoch, m.q_tag());
        assert_eq!(m.long_moments.tracked_usd, m.long_size_usd);
        assert!(m.side_winners_bound_usd(true, up).is_some());

        // And a corporate action forgets every term: the next split epoch
        // untracks everything open, and the side counts net again until
        // those positions are gone.
        m.split_epoch += 1;
        m.reset_moments();
        assert_eq!(m.side_winners_bound_usd(true, up), None);
        let size = legacy.size_usd;
        book_close(&mut p, &mut m, &mut legacy, size, up, 1).unwrap();
        let size = fresh.size_usd;
        book_close(&mut p, &mut m, &mut fresh, size, up, 1).unwrap();
        assert_eq!(m.long_moments, SideMoments::default());
        assert_eq!(m.side_winners_bound_usd(true, up), Some(0));
    }

    #[test]
    fn a_close_takes_its_own_entry_off_the_side_average() {
        // Long A $100k from $100 closes at $200 next to long B $100k opened
        // at $200. The side used to stay at $100k from $133.33, up $50,000
        // at $200 when B alone is flat.
        let two = 2 * PX;
        for legacy in [false, true] {
            let (mut p, mut m) = (pool(), market());
            let (mut a, mut b) = (position(), position());
            book_open(&mut p, &mut m, &mut a, Pubkey::default(), 1, true,
                      50_000_000_000, 0, Pubkey::default(), 100_000_000_000, PX, 0).unwrap();
            if legacy {
                // Opened before the sums: the stored average does the work.
                m.long_moments = SideMoments::default();
                a.q_epoch = 0;
            }
            book_open(&mut p, &mut m, &mut b, Pubkey::default(), 1, true,
                      50_000_000_000, 0, Pubkey::default(), 100_000_000_000, two, 0).unwrap();
            assert_eq!(m.long_avg_entry_price, PX * 4 / 3);
            book_close(&mut p, &mut m, &mut a, 100_000_000_000, two, 1).unwrap();
            assert_eq!(m.long_size_usd, 100_000_000_000);
            assert!(m.long_avg_entry_price.abs_diff(two) <= 1, "legacy {legacy}: {}",
                    m.long_avg_entry_price);
            assert!(m.trader_pnl_usd(two).unwrap().abs() <= 10_000, "a cent at most");
        }
    }

    #[test]
    fn isqrt_ceil_is_the_smallest_root() {
        for x in (0u128..5_000).chain([u64::MAX as u128, u128::MAX, u128::MAX - 1, 1 << 127]) {
            let r = crate::state::market::isqrt_ceil(x);
            assert!(r.checked_mul(r).map_or(true, |rr| rr >= x), "{x}");
            assert!(r == 0 || (r - 1) * (r - 1) < x, "{x}");
        }
    }
}
