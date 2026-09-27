//! Uniform-price clearing for a batch of orders.
//!
//! Every order in a batch that trades at all trades at the same price: the one
//! that crosses the most volume. Nobody is filled better for having arrived
//! first, which is the point — inside the batch window, being earlier is worth
//! nothing, so there is no race to be earlier.
//!
//! This is the whole of price formation. The pool quotes into the batch like
//! any other participant and the clearing price is whatever the book crosses
//! at; no part of this function knows the oracle except as a tie-break of last
//! resort.
//!
//! A batch is two of these auctions, not one: a dual flow batch auction. Every
//! order is a maker or a taker, and takers only ever trade with makers. Taker
//! bids meet maker asks in the buy flow; taker asks meet maker bids in the sell
//! flow. Each flow clears at its own uniform price. See `clear_dual`.

use crate::errors::PerpError;

/// Why a clearing could not be computed.
///
/// Its own type rather than the program's, so this module is plain arithmetic
/// with no framework in it: that is what lets the Kani proofs in `proofs/auction.rs`
/// reason about it without also exploring how an Anchor error formats itself.
/// Converted to the program's errors at the boundary, by `?`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AuctionError {
    TooManyOrders,
    Overflow,
}

impl From<AuctionError> for anchor_lang::error::Error {
    fn from(e: AuctionError) -> Self {
        match e {
            AuctionError::TooManyOrders => PerpError::InvalidParameter.into(),
            AuctionError::Overflow => PerpError::MathOverflow.into(),
        }
    }
}

pub type Result<T> = core::result::Result<T, AuctionError>;

/// The most orders one batch will clear.
///
/// Two ceilings meet here and the lower one wins.
///
/// Clearing is quadratic in the number of orders — every distinct limit price
/// is a candidate, and each candidate sums the book — so a large batch is a
/// batch that cannot be cleared inside the compute budget, which is worse than
/// one that never accepted the orders.
///
/// The stack is no longer the binding limit — `Batch` is zero-copy, so the
/// array is cast in place rather than deserialised through a 4KB frame — which
/// leaves the compute budget as the only ceiling. Overflow goes to the next
/// batch, five seconds later.
pub const MAX_BATCH_ORDERS: usize = 64;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AuctionOrder {
    /// Limit price, `PRICE_SCALE`. A bid will not pay above it; an ask will
    /// not sell below it.
    pub price: u64,
    /// Notional in USD.
    pub size: u64,
    pub is_bid: bool,
    /// Resting liquidity rather than demand for it. Decides which of the two
    /// flows the order clears in; see `Flow`.
    pub is_maker: bool,
}

/// Which of a batch's two auctions an order clears in.
///
/// Named for what the taker is doing. A taker buying meets makers selling in
/// the buy flow; a taker selling meets makers buying in the sell flow. Two
/// takers never meet at all, which is what lets a maker quote a price knowing
/// it will only ever trade against flow that came to it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Flow {
    Buy,
    Sell,
}

impl Flow {
    pub fn of(is_bid: bool, is_maker: bool) -> Flow {
        if is_bid != is_maker {
            Flow::Buy
        } else {
            Flow::Sell
        }
    }

    /// Which side of this flow the takers are on, and so the only side the
    /// pool will fill.
    pub fn takers_bid(self) -> bool {
        self == Flow::Buy
    }
}

impl AuctionOrder {
    pub fn flow(&self) -> Flow {
        Flow::of(self.is_bid, self.is_maker)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Clearing {
    pub price: u64,
    /// Notional that trades, counted once rather than per side.
    pub matched: u64,
}

/// Demand and supply standing at a price.
fn depth_at(orders: &[AuctionOrder], price: u64) -> (u128, u128) {
    let mut demand: u128 = 0;
    let mut supply: u128 = 0;
    for o in orders {
        if o.is_bid {
            // A bid at or above the clearing price is willing to pay it.
            if o.price >= price {
                demand += o.size as u128;
            }
        } else if o.price <= price {
            supply += o.size as u128;
        }
    }
    (demand, supply)
}

/// Finds the price that crosses the most volume.
///
/// Ties are broken the way an opening auction breaks them, in order:
///
/// 1. **Most volume.** The point of the exercise.
/// 2. **Least imbalance.** Between two prices that trade the same amount, the
///    one leaving less unfilled is the better description of where the book
///    actually is.
/// 3. **Closest to the reference.** Only reached when the book is genuinely
///    indifferent across a range, which happens on a thin market with a wide
///    gap. The oracle mark decides it rather than an arbitrary edge of the
///    range — otherwise the clearing price jumps between the top and bottom of
///    the spread from batch to batch on no information at all.
/// 4. **The lower price.** Only reached at an exact tie: two prices the same
///    distance either side of the reference, trading the same volume with the
///    same imbalance. Without a fixed rule here the price went to whichever
///    order sat earlier in the batch, so submission order decided it, which
///    is the one thing a batch auction promises it does not. Taking the least
///    candidate by this full ranking makes the result the same for every
///    ordering of the book.
///
/// Returns `None` when nothing crosses, which is a batch that simply does not
/// trade. That is a normal outcome and not an error.
pub fn clear(orders: &[AuctionOrder], reference: u64) -> Result<Option<Clearing>> {
    if orders.len() > MAX_BATCH_ORDERS {
        return Err(AuctionError::TooManyOrders);
    }

    let mut best: Option<(Clearing, u128, u64)> = None; // (clearing, imbalance, distance)

    for candidate in orders.iter().map(|o| o.price) {
        if candidate == 0 {
            continue;
        }
        let (demand, supply) = depth_at(orders, candidate);
        let matched = demand.min(supply);
        if matched == 0 {
            continue;
        }
        let imbalance = demand.abs_diff(supply);
        let distance = candidate.abs_diff(reference);

        let better = match &best {
            None => true,
            Some((b, b_imbalance, b_distance)) => {
                let m = matched > b.matched as u128;
                let same_volume = matched == b.matched as u128;
                m || (same_volume && imbalance < *b_imbalance)
                    || (same_volume && imbalance == *b_imbalance && distance < *b_distance)
                    || (same_volume
                        && imbalance == *b_imbalance
                        && distance == *b_distance
                        && candidate < b.price)
            }
        };

        if better {
            best = Some((
                Clearing {
                    price: candidate,
                    matched: u64::try_from(matched).map_err(|_| AuctionError::Overflow)?,
                },
                imbalance,
                distance,
            ));
        }
    }

    Ok(best.map(|(c, _, _)| c))
}

/// How much of `order` fills at `clearing`.
///
/// Price priority first — an order that named a better price is filled before
/// one that did not — and pro-rata across everything resting at the marginal
/// price. Pro-rata rather than first-come at the margin for the same reason
/// the auction exists: with time priority at the clearing price, submitting
/// earlier is worth something again, and the race comes back.
pub fn fill_for(
    order: &AuctionOrder,
    orders: &[AuctionOrder],
    clearing: &Clearing,
) -> Result<u64> {
    let qualifies = if order.is_bid {
        order.price >= clearing.price
    } else {
        order.price <= clearing.price
    };
    if !qualifies || order.size == 0 {
        return Ok(0);
    }

    // Everything on this side that beats the clearing price outright.
    let mut ahead: u128 = 0;
    let mut at_margin: u128 = 0;
    for o in orders.iter().filter(|o| o.is_bid == order.is_bid) {
        let strictly_better = if o.is_bid {
            o.price > clearing.price
        } else {
            o.price < clearing.price
        };
        if strictly_better {
            ahead += o.size as u128;
        } else if o.price == clearing.price {
            at_margin += o.size as u128;
        }
    }

    let matched = clearing.matched as u128;
    let strictly_better = if order.is_bid {
        order.price > clearing.price
    } else {
        order.price < clearing.price
    };

    if strictly_better {
        // Filled in full unless this side's aggressive orders alone overflow
        // what trades, in which case they share it pro-rata among themselves.
        if ahead <= matched {
            return Ok(order.size);
        }
        let share = (order.size as u128)
            .checked_mul(matched)
            .ok_or(AuctionError::Overflow)?
            / ahead;
        return Ok(u64::try_from(share).map_err(|_| AuctionError::Overflow)?);
    }

    // Resting exactly at the clearing price: whatever the aggressive orders
    // left behind, shared pro-rata.
    let remaining = matched.saturating_sub(ahead);
    if remaining == 0 || at_margin == 0 {
        return Ok(0);
    }
    let share = (order.size as u128)
        .checked_mul(remaining)
        .ok_or(AuctionError::Overflow)?
        / at_margin;
    // Never more than the order asked for, whatever `clearing` claims trades.
    // A caller that over-states it would otherwise over-fill the margin.
    let share = share.min(order.size as u128);
    Ok(u64::try_from(share).map_err(|_| AuctionError::Overflow)?)
}

/// Holds every order inside `[lo, hi]` around the oracle.
///
/// The book alone decides the clearing price, and nothing stopped two accounts
/// owned by one person from crossing at a price nowhere near the market: long
/// against short at a dollar while the oracle read a hundred. The loser gave
/// up its collateral, the winner was marked at the oracle, and the pool paid
/// the difference. A clearing price outside the band is therefore not one this
/// program can accept, whoever is on the other side.
///
/// Only the side that would trade through the band moves: a bid above `hi`
/// bids `hi`, an ask below `lo` asks `lo`. That never costs an order anything
/// it named, because a bid willing to pay more is willing to pay `hi`, and an
/// ask willing to take less is willing to take `lo`. A bid below `lo` or an
/// ask above `hi` is left where it is, and simply does not cross, so every
/// price that trades any volume lands inside the band.
pub fn band(orders: &mut [AuctionOrder], lo: u64, hi: u64) {
    for o in orders.iter_mut() {
        if o.is_bid {
            o.price = o.price.min(hi);
        } else {
            o.price = o.price.max(lo);
        }
    }
}

/// What the pool is willing to show this batch.
#[derive(Clone, Copy, Debug)]
pub struct PoolQuote {
    /// Highest it will buy at, and lowest it will sell at.
    pub bid: u64,
    pub ask: u64,
    /// Most it will take on either side, out of the market's loss budget.
    pub size: u64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Outcome {
    pub price: u64,
    /// Total notional trading, the pool's share included.
    pub matched: u64,
    pub pool_bought: u64,
    pub pool_sold: u64,
}

impl Outcome {
    /// What one side of the book trades, to allocate across that side's orders.
    ///
    /// Not `matched`. The pool fills only the heavy side, so the heavy side
    /// trades the book's crossing plus the pool's share and the light side
    /// trades the crossing alone. Handing the light side the grossed-up total
    /// shared out more than it had: an ask of 100 resting at the clearing price
    /// against 300 of bids, with the pool selling the other 200, was allocated
    /// all 300, and settlement booked three times the collateral it escrowed,
    /// paid for out of the vault.
    pub fn side(&self, is_bid: bool) -> Clearing {
        let pool = self.pool_sold.max(self.pool_bought);
        let book = self.matched - pool;
        // The pool selling means buyers were left over: it is the bids it fills.
        let theirs = if is_bid { self.pool_sold } else { self.pool_bought };
        Clearing { price: self.price, matched: book + theirs }
    }
}

/// Clears a batch with the pool as the counterparty of last resort.
///
/// The pool does not bid against the people it is supposed to be serving. It
/// was a participant in the first version of this and the consequence showed
/// up on the first live batch: quoting at the oracle minus a spread, for a
/// size drawn from a market's whole budget, it outbid a real trader by a
/// dollar and took the entire fill. The price was the pool's price again — the
/// auction had just made it take a longer route to get there.
///
/// So: real orders clear against each other first, and that crossing is the
/// price. Only then does the pool absorb whatever is left standing on the
/// heavy side, at the price the humans arrived at, bounded by its own quote
/// and its budget. A batch with genuine two-sided flow never touches it.
///
/// The exception is a market nobody is making yet, where there is no crossing
/// to find. There the pool is the only counterparty available, and it fills at
/// its own quote — capped, because that is the one case where the criticism of
/// pool pricing is simply true and the honest answer is to bound it rather
/// than to pretend otherwise.
pub fn clear_with_pool(
    orders: &[AuctionOrder],
    quote: &PoolQuote,
    reference: u64,
) -> Result<Option<Outcome>> {
    clear_with_pool_on(orders, quote, reference, true, true)
}

/// `clear_with_pool` with the pool allowed onto only the sides named.
///
/// In a dual flow batch the pool fills takers and nobody else: it is liquidity
/// for flow that arrived wanting it, not a counterparty for a maker whose
/// quote went unanswered. A maker left standing simply does not trade.
pub(crate) fn clear_with_pool_on(
    orders: &[AuctionOrder],
    quote: &PoolQuote,
    reference: u64,
    may_buy: bool,
    may_sell: bool,
) -> Result<Option<Outcome>> {
    if let Some(c) = clear(orders, reference)? {
        let (demand, supply) = depth_at(orders, c.price);
        let mut out = Outcome {
            price: c.price,
            matched: c.matched,
            pool_bought: 0,
            pool_sold: 0,
        };

        if may_sell && demand > supply && c.price >= quote.ask {
            // Buyers left over, and the price is at or above what the pool
            // will sell for.
            let take = (demand - supply).min(quote.size as u128);
            out.pool_sold = u64::try_from(take).map_err(|_| AuctionError::Overflow)?;
        } else if may_buy && supply > demand && c.price <= quote.bid {
            let take = (supply - demand).min(quote.size as u128);
            out.pool_bought = u64::try_from(take).map_err(|_| AuctionError::Overflow)?;
        }

        out.matched = out
            .matched
            .checked_add(out.pool_sold.max(out.pool_bought))
            .ok_or(AuctionError::Overflow)?;
        return Ok(Some(out));
    }

    if quote.size == 0 {
        return Ok(None);
    }

    // Nothing crossed. If one side is standing alone, the pool is the only
    // counterparty there is.
    let (demand_at_ask, _) = depth_at(orders, quote.ask);
    if may_sell && demand_at_ask > 0 {
        let take = demand_at_ask.min(quote.size as u128);
        let sold = u64::try_from(take).map_err(|_| AuctionError::Overflow)?;
        return Ok(Some(Outcome {
            price: quote.ask,
            matched: sold,
            pool_bought: 0,
            pool_sold: sold,
        }));
    }

    let (_, supply_at_bid) = depth_at(orders, quote.bid);
    if may_buy && supply_at_bid > 0 {
        let take = supply_at_bid.min(quote.size as u128);
        let bought = u64::try_from(take).map_err(|_| AuctionError::Overflow)?;
        return Ok(Some(Outcome {
            price: quote.bid,
            matched: bought,
            pool_bought: bought,
            pool_sold: 0,
        }));
    }

    Ok(None)
}

/// A batch's two clearings. Either may be `None`: a flow with no takers, or
/// with nothing that crosses and no pool to meet it, simply does not trade.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct DualOutcome {
    pub buy: Option<Outcome>,
    pub sell: Option<Outcome>,
}

impl DualOutcome {
    pub fn of(&self, flow: Flow) -> Option<Outcome> {
        match flow {
            Flow::Buy => self.buy,
            Flow::Sell => self.sell,
        }
    }

    pub fn traded(&self) -> bool {
        self.buy.is_some() || self.sell.is_some()
    }
}

/// A batch's orders split into its two flows, each in the order the orders
/// appear in the batch.
///
/// Built once per clearing and shared by every fill computed from it. Solana's
/// heap is a bump allocator that never frees, so rebuilding a flow per order
/// ran a full batch of sixty-four out of memory mid-clear.
#[derive(Clone, Debug, Default)]
pub struct DualBook {
    pub buy: Vec<AuctionOrder>,
    pub sell: Vec<AuctionOrder>,
}

impl DualBook {
    pub fn split(orders: &[AuctionOrder]) -> DualBook {
        let mut book = DualBook {
            buy: Vec::with_capacity(orders.len()),
            sell: Vec::with_capacity(orders.len()),
        };
        for o in orders {
            match o.flow() {
                Flow::Buy => book.buy.push(*o),
                Flow::Sell => book.sell.push(*o),
            }
        }
        book
    }

    pub fn of(&self, flow: Flow) -> &[AuctionOrder] {
        match flow {
            Flow::Buy => &self.buy,
            Flow::Sell => &self.sell,
        }
    }
}

/// Clears a batch as two independent auctions.
///
/// One uniform price put every order in a single book, so a taker's price was
/// set as much by other takers as by anyone offering liquidity, and a maker
/// could be filled by another maker who had simply crossed further. Splitting
/// the flows fixes both: a taker only ever pays a price some maker asked for,
/// and a maker only ever trades against a taker who came to it. Within each
/// flow nothing else changes -- the price is the one that crosses the most,
/// every order that trades trades at it, and nobody's limit is breached.
///
/// Each flow may use the pool's whole quote size. The pool sells in the buy
/// flow and buys in the sell flow, so what it takes in one offsets what it
/// takes in the other, and its net position from a batch is never more than
/// the size it quoted.
pub fn clear_dual(book: &DualBook, quote: &PoolQuote, reference: u64) -> Result<DualOutcome> {
    Ok(DualOutcome {
        // The takers in the buy flow are bidding, so the pool may only sell.
        buy: clear_with_pool_on(&book.buy, quote, reference, false, true)?,
        sell: clear_with_pool_on(&book.sell, quote, reference, true, false)?,
    })
}

/// What `order` fills in a dual flow batch: its share of its own flow.
pub fn dual_fill_for(order: &AuctionOrder, book: &DualBook, out: &DualOutcome) -> Result<u64> {
    let flow = order.flow();
    match out.of(flow) {
        Some(o) => fill_for(order, book.of(flow), &o.side(order.is_bid)),
        None => Ok(0),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Single-flow tests exercise one auction on its own, where who is making
    // does not enter into it.
    fn bid(price: u64, size: u64) -> AuctionOrder {
        AuctionOrder { price, size, is_bid: true, is_maker: false }
    }
    fn ask(price: u64, size: u64) -> AuctionOrder {
        AuctionOrder { price, size, is_bid: false, is_maker: false }
    }
    fn maker(o: AuctionOrder) -> AuctionOrder {
        AuctionOrder { is_maker: true, ..o }
    }

    const REF: u64 = 100_000_000; // $100

    #[test]
    fn a_self_cross_far_from_the_oracle_clears_inside_the_band() {
        // Long against short at $1 with the oracle at $100: the attack that
        // used to be paid by the pool. Both limits are willing to trade at the
        // band's edge, so they do, and nowhere else.
        let (lo, hi) = (97_500_000, 102_500_000);
        let mut book = [bid(1_000_000, 500), ask(1_000_000, 500)];
        band(&mut book, lo, hi);
        // The ask below the band is lifted to it; the bid at $1 is left alone
        // and no longer crosses anything.
        assert_eq!(clear(&book, REF).unwrap(), None);

        let mut book = [bid(500_000_000, 500), ask(1_000_000, 500)];
        band(&mut book, lo, hi);
        let c = clear(&book, REF).unwrap().unwrap();
        assert!(c.price >= lo && c.price <= hi);
        assert_eq!(c.matched, 500);
    }

    #[test]
    fn the_pools_share_goes_only_to_the_side_it_fills() {
        // 300 of bids against one ask of 100 resting at the clearing price;
        // the pool sells the 200 left over. The ask trades its 100, not 300.
        let book = [bid(110_000_000, 300), ask(100_000_000, 100)];
        let quote = PoolQuote { bid: 99_000_000, ask: 100_000_000, size: 1_000 };
        let out = clear_with_pool(&book, &quote, REF).unwrap().unwrap();
        assert_eq!(out.pool_sold, 200);
        assert_eq!(fill_for(&book[0], &book, &out.side(true)).unwrap(), 300);
        assert_eq!(fill_for(&book[1], &book, &out.side(false)).unwrap(), 100);
    }

    #[test]
    fn no_order_fills_past_its_size_whatever_the_allocation_says() {
        let book = [bid(110_000_000, 300), ask(100_000_000, 100)];
        let overstated = Clearing { price: 100_000_000, matched: 300 };
        assert_eq!(fill_for(&book[1], &book, &overstated).unwrap(), 100);
    }

    #[test]
    fn a_book_that_does_not_cross_does_not_trade() {
        let book = [bid(99_000_000, 1_000), ask(101_000_000, 1_000)];
        assert_eq!(clear(&book, REF).unwrap(), None);
    }

    #[test]
    fn the_clearing_price_is_the_one_that_trades_the_most() {
        // Bids stacked at 102/101/100, asks at 98/99/100. The deepest crossing
        // is at 100, where everything on both sides is willing.
        let book = [
            bid(102_000_000, 100),
            bid(101_000_000, 100),
            bid(100_000_000, 100),
            ask(98_000_000, 100),
            ask(99_000_000, 100),
            ask(100_000_000, 100),
        ];
        let c = clear(&book, REF).unwrap().unwrap();
        assert_eq!(c.price, 100_000_000);
        assert_eq!(c.matched, 300);
    }

    #[test]
    fn everyone_who_trades_trades_at_the_same_price() {
        // The 105 bid named a price far above where the book cleared and is
        // filled at the clearing price anyway. That is the whole promise:
        // arriving keen does not mean paying more.
        let book = [bid(105_000_000, 50), ask(100_000_000, 50)];
        let c = clear(&book, REF).unwrap().unwrap();
        assert_eq!(c.matched, 50);
        assert_eq!(fill_for(&book[0], &book, &c).unwrap(), 50);
        assert_eq!(fill_for(&book[1], &book, &c).unwrap(), 50);
    }

    #[test]
    fn a_tie_on_volume_is_broken_by_the_smaller_imbalance() {
        // Both 100 and 101 cross 100 units; 101 leaves less standing.
        let book = [
            bid(101_000_000, 100),
            bid(100_000_000, 500),
            ask(100_000_000, 100),
        ];
        let c = clear(&book, REF).unwrap().unwrap();
        assert_eq!(c.matched, 100);
        assert_eq!(c.price, 101_000_000, "101 leaves 0 behind, 100 leaves 500");
    }

    #[test]
    fn a_book_indifferent_across_a_range_defers_to_the_oracle() {
        // Two prices, same volume, same imbalance. Without the reference this
        // would flip between them batch to batch on no new information.
        let book = [
            bid(101_000_000, 100),
            bid(99_000_000, 100),
            ask(99_000_000, 100),
            ask(101_000_000, 100),
        ];
        let near_low = clear(&book, 99_100_000).unwrap().unwrap();
        let near_high = clear(&book, 100_900_000).unwrap().unwrap();
        assert_eq!(near_low.price, 99_000_000);
        assert_eq!(near_high.price, 101_000_000);
    }

    #[test]
    fn price_priority_fills_the_keener_order_first() {
        // 150 of demand against 100 of supply: the 102 bid is filled whole and
        // the 100 bid takes what is left.
        let book = [
            bid(102_000_000, 100),
            bid(100_000_000, 50),
            ask(100_000_000, 100),
        ];
        let c = clear(&book, REF).unwrap().unwrap();
        assert_eq!(c.matched, 100);
        assert_eq!(fill_for(&book[0], &book, &c).unwrap(), 100);
        assert_eq!(fill_for(&book[1], &book, &c).unwrap(), 0);
    }

    #[test]
    fn orders_at_the_clearing_price_share_what_is_left_pro_rata() {
        // 60 of supply meets 30 already ahead of them, so two equal bids at
        // the margin split the remaining 30.
        let book = [
            bid(102_000_000, 30),
            bid(100_000_000, 100),
            bid(100_000_000, 100),
            ask(100_000_000, 60),
        ];
        let c = clear(&book, REF).unwrap().unwrap();
        assert_eq!(c.matched, 60);
        assert_eq!(fill_for(&book[0], &book, &c).unwrap(), 30);
        assert_eq!(fill_for(&book[1], &book, &c).unwrap(), 15);
        assert_eq!(fill_for(&book[2], &book, &c).unwrap(), 15);
    }

    #[test]
    fn splitting_an_order_wins_nothing_at_the_margin() {
        // Pro-rata is what makes this true: one order of 100 and two of 50
        // take the same share, so there is no edge in shredding an order.
        let whole = [bid(100_000_000, 100), bid(100_000_000, 100), ask(100_000_000, 100)];
        let c = clear(&whole, REF).unwrap().unwrap();
        let single = fill_for(&whole[0], &whole, &c).unwrap();

        let split = [
            bid(100_000_000, 50),
            bid(100_000_000, 50),
            bid(100_000_000, 100),
            ask(100_000_000, 100),
        ];
        let c2 = clear(&split, REF).unwrap().unwrap();
        let halves = fill_for(&split[0], &split, &c2).unwrap()
            + fill_for(&split[1], &split, &c2).unwrap();
        assert_eq!(single, halves);
    }

    #[test]
    fn the_two_sides_always_fill_the_same_amount() {
        let book = [
            bid(103_000_000, 40),
            bid(101_000_000, 90),
            bid(100_000_000, 25),
            ask(98_000_000, 70),
            ask(100_000_000, 30),
            ask(104_000_000, 500),
        ];
        let c = clear(&book, REF).unwrap().unwrap();
        let bids: u64 = book.iter().filter(|o| o.is_bid)
            .map(|o| fill_for(o, &book, &c).unwrap()).sum();
        let asks: u64 = book.iter().filter(|o| !o.is_bid)
            .map(|o| fill_for(o, &book, &c).unwrap()).sum();
        assert_eq!(bids, asks, "a fill on one side is a fill on the other");
        assert_eq!(bids, c.matched);
    }

    fn quote(bid: u64, ask: u64, size: u64) -> PoolQuote {
        PoolQuote { bid, ask, size }
    }

    #[test]
    fn the_pool_does_not_outbid_the_people_it_serves() {
        // The first live batch, exactly: a trader bid $760, a maker asked
        // $740, and the pool's own bid sat at $761.25 for a size drawn from
        // the whole budget. As a participant it won the lot and the trader
        // filled nothing. As a backstop it does not get to.
        let book = [bid(760_000_000, 1_000), ask(740_000_000, 1_000)];
        let q = quote(761_247_600, 768_752_400, 12_500);
        let out = clear_with_pool(&book, &q, 765_000_000).unwrap().unwrap();

        assert_eq!(out.pool_bought, 0);
        assert_eq!(out.pool_sold, 0);
        assert!(
            (740_000_000..=760_000_000).contains(&out.price),
            "price came from the two humans, not the pool: {}",
            out.price
        );
        // And the trader is filled, which is the whole point.
        let c = Clearing { price: out.price, matched: out.matched };
        assert_eq!(fill_for(&book[0], &book, &c).unwrap(), 1_000);
    }

    #[test]
    fn the_pool_takes_only_what_is_left_standing() {
        // 1,500 of demand against 500 of supply. The humans set the price and
        // the pool absorbs the 1,000 nobody else would.
        let book = [
            bid(100_000_000, 1_000),
            bid(100_000_000, 500),
            ask(100_000_000, 500),
        ];
        let q = quote(99_000_000, 100_000_000, 10_000);
        let out = clear_with_pool(&book, &q, 100_000_000).unwrap().unwrap();
        assert_eq!(out.price, 100_000_000);
        assert_eq!(out.pool_sold, 1_000);
        assert_eq!(out.matched, 1_500);
    }

    #[test]
    fn the_pool_will_not_sell_below_its_own_ask() {
        // Imbalance on the buy side, but the crossing is under what the pool
        // is prepared to sell at, so it stands aside and the batch is simply
        // smaller.
        let book = [bid(90_000_000, 1_000), ask(90_000_000, 100)];
        let q = quote(99_000_000, 101_000_000, 10_000);
        let out = clear_with_pool(&book, &q, 100_000_000).unwrap().unwrap();
        assert_eq!(out.pool_sold, 0);
        assert_eq!(out.matched, 100);
    }

    #[test]
    fn the_budget_caps_what_the_pool_will_absorb() {
        let book = [bid(100_000_000, 50_000), ask(100_000_000, 1_000)];
        let q = quote(99_000_000, 100_000_000, 7_000);
        let out = clear_with_pool(&book, &q, 100_000_000).unwrap().unwrap();
        assert_eq!(out.pool_sold, 7_000, "capped, not the full 49,000 imbalance");
    }

    #[test]
    fn a_market_nobody_is_making_still_trades_against_the_pool() {
        // One-sided book: no crossing to find, so the pool is the only
        // counterparty and fills at its own quote.
        let book = [bid(105_000_000, 3_000)];
        let q = quote(99_000_000, 101_000_000, 2_000);
        let out = clear_with_pool(&book, &q, 100_000_000).unwrap().unwrap();
        assert_eq!(out.price, 101_000_000, "the pool's ask, since nothing else exists");
        assert_eq!(out.pool_sold, 2_000, "and capped");
    }

    #[test]
    fn an_unfunded_market_with_no_flow_does_not_trade() {
        let book = [bid(105_000_000, 3_000)];
        let q = quote(99_000_000, 101_000_000, 0);
        assert_eq!(clear_with_pool(&book, &q, 100_000_000).unwrap(), None);
    }

    #[test]
    fn a_batch_past_the_cap_is_refused_rather_than_half_cleared() {
        let book = vec![bid(100_000_000, 1); MAX_BATCH_ORDERS + 1];
        assert!(clear(&book, REF).is_err());
    }

    #[test]
    fn an_order_clears_in_the_flow_of_the_taker_it_meets() {
        assert_eq!(bid(1, 1).flow(), Flow::Buy);
        assert_eq!(maker(ask(1, 1)).flow(), Flow::Buy);
        assert_eq!(ask(1, 1).flow(), Flow::Sell);
        assert_eq!(maker(bid(1, 1)).flow(), Flow::Sell);
    }

    #[test]
    fn two_takers_never_trade_with_each_other() {
        // Crossed by twenty dollars, and neither is making. With no makers and
        // no pool, nothing trades in either flow.
        let book = [bid(110_000_000, 500), ask(90_000_000, 500)];
        let out = clear_dual(&DualBook::split(&book), &quote(99_000_000, 101_000_000, 0), REF).unwrap();
        assert_eq!(out, DualOutcome::default());
    }

    #[test]
    fn two_makers_never_trade_with_each_other() {
        let book = [maker(bid(110_000_000, 500)), maker(ask(90_000_000, 500))];
        let out = clear_dual(&DualBook::split(&book), &quote(99_000_000, 101_000_000, 10_000), REF).unwrap();
        assert!(!out.traded(), "the pool does not fill makers either");
    }

    #[test]
    fn each_flow_clears_at_its_own_price() {
        // A taker buying meets a maker asking 101; a taker selling meets a
        // maker bidding 99. One book would have put everyone at a single
        // price. Two flows give each taker the price a maker actually named.
        let book = [
            bid(105_000_000, 100),
            maker(ask(101_000_000, 100)),
            ask(95_000_000, 100),
            maker(bid(99_000_000, 100)),
        ];
        let out = clear_dual(&DualBook::split(&book), &quote(0, u64::MAX, 0), REF).unwrap();
        let (buy, sell) = (out.buy.unwrap(), out.sell.unwrap());
        assert_eq!(buy.price, 101_000_000);
        assert_eq!(sell.price, 99_000_000);
        for o in &book {
            assert_eq!(dual_fill_for(o, &DualBook::split(&book), &out).unwrap(), 100);
        }
    }

    #[test]
    fn no_order_trades_past_its_limit_in_either_flow() {
        let book = [
            bid(104_000_000, 70),
            bid(101_000_000, 50),
            maker(ask(100_000_000, 60)),
            maker(ask(103_000_000, 80)),
            ask(97_000_000, 40),
            maker(bid(98_000_000, 90)),
        ];
        let out = clear_dual(&DualBook::split(&book), &quote(96_000_000, 105_000_000, 1_000), REF).unwrap();
        for o in &book {
            if dual_fill_for(o, &DualBook::split(&book), &out).unwrap() == 0 {
                continue;
            }
            let price = out.of(o.flow()).unwrap().price;
            if o.is_bid {
                assert!(price <= o.price, "a bid paid past its limit");
            } else {
                assert!(price >= o.price, "an ask sold under its limit");
            }
        }
    }

    #[test]
    fn the_pool_fills_takers_and_never_a_maker() {
        // A maker asking at the pool's bid would happily sell to it, and in
        // one book it could have. Here it is left standing.
        let book = [maker(ask(99_000_000, 500))];
        let out = clear_dual(&DualBook::split(&book), &quote(99_000_000, 101_000_000, 10_000), REF).unwrap();
        assert!(!out.traded());

        // A taker with no maker opposite is filled by the pool, at its quote.
        let book = [bid(102_000_000, 500), ask(98_000_000, 300)];
        let out = clear_dual(&DualBook::split(&book), &quote(99_000_000, 101_000_000, 10_000), REF).unwrap();
        let (buy, sell) = (out.buy.unwrap(), out.sell.unwrap());
        assert_eq!((buy.price, buy.pool_sold, buy.pool_bought), (101_000_000, 500, 0));
        assert_eq!((sell.price, sell.pool_bought, sell.pool_sold), (99_000_000, 300, 0));
    }

    #[test]
    fn the_pool_tops_up_a_flow_the_makers_could_not_fill() {
        // 300 of taker demand against 100 from a maker. The maker's price is
        // the flow's price, and the pool sells the other 200 at it.
        let book = [bid(102_000_000, 300), maker(ask(100_000_000, 100))];
        let out = clear_dual(&DualBook::split(&book), &quote(99_000_000, 100_000_000, 10_000), REF).unwrap();
        let buy = out.buy.unwrap();
        assert_eq!(buy.price, 100_000_000);
        assert_eq!(buy.pool_sold, 200);
        assert_eq!(dual_fill_for(&book[0], &DualBook::split(&book), &out).unwrap(), 300);
        assert_eq!(dual_fill_for(&book[1], &DualBook::split(&book), &out).unwrap(), 100);
    }

    #[test]
    fn the_pools_net_take_from_a_batch_stays_inside_its_quote() {
        let book = [bid(105_000_000, 9_000), ask(95_000_000, 4_000)];
        let q = quote(99_000_000, 101_000_000, 7_000);
        let out = clear_dual(&DualBook::split(&book), &q, REF).unwrap();
        let sold = out.buy.map_or(0, |o| o.pool_sold);
        let bought = out.sell.map_or(0, |o| o.pool_bought);
        assert!(sold.abs_diff(bought) <= q.size);
    }

    #[test]
    fn within_a_flow_both_sides_fill_the_same_amount() {
        let book = [
            bid(103_000_000, 40),
            bid(101_000_000, 90),
            maker(ask(98_000_000, 70)),
            maker(ask(100_000_000, 30)),
            ask(90_000_000, 55),
            maker(bid(99_000_000, 20)),
        ];
        let out = clear_dual(&DualBook::split(&book), &quote(0, u64::MAX, 0), REF).unwrap();
        for flow in [Flow::Buy, Flow::Sell] {
            let (b, a): (u64, u64) = book.iter().filter(|o| o.flow() == flow).fold((0, 0), |(b, a), o| {
                let f = dual_fill_for(o, &DualBook::split(&book), &out).unwrap();
                if o.is_bid { (b + f, a) } else { (b, a + f) }
            });
            // Pro-rata shares round down, so a side split across several
            // orders can come up a unit per order short. Never over.
            let orders = book.iter().filter(|o| o.flow() == flow).count() as u64;
            assert!(b.abs_diff(a) < orders, "{flow:?}: {b} bought against {a} sold");
        }
    }

    /// Every ordering of `book`, by Heap's algorithm.
    fn permutations(book: &[AuctionOrder]) -> Vec<Vec<AuctionOrder>> {
        fn go(k: usize, v: &mut Vec<AuctionOrder>, out: &mut Vec<Vec<AuctionOrder>>) {
            if k <= 1 {
                out.push(v.clone());
                return;
            }
            for i in 0..k {
                go(k - 1, v, out);
                if k % 2 == 0 { v.swap(i, k - 1) } else { v.swap(0, k - 1) }
            }
        }
        let mut out = Vec::new();
        go(book.len(), &mut book.to_vec(), &mut out);
        out
    }

    #[test]
    fn arriving_first_changes_nothing_away_from_an_exact_tie() {
        // Five orders in all 120 orderings: one price, one volume, one pool
        // take, and the same fill for every order.
        let book = [
            bid(103_000_000, 40),
            bid(101_000_000, 90),
            ask(98_000_000, 70),
            ask(100_000_000, 30),
            ask(100_000_000, 45),
        ];
        let q = quote(99_000_000, 100_000_000, 1_000);
        let first = clear_with_pool(&book, &q, REF).unwrap().unwrap();
        for p in permutations(&book) {
            let out = clear_with_pool(&p, &q, REF).unwrap().unwrap();
            assert_eq!(out, first);
            for o in &book {
                assert_eq!(
                    fill_for(o, &p, &out.side(o.is_bid)).unwrap(),
                    fill_for(o, &book, &first.side(o.is_bid)).unwrap()
                );
            }
        }
    }

    // Found by the Kani harness `the_clearing_is_independent_of_submission_order`.
    // When two candidate prices tied on volume, on imbalance and on distance
    // from the reference, `clear` kept whichever it met first, the price of
    // the order earlier in the array. The band is symmetric around the
    // oracle, so a bid through its top against an ask through its bottom
    // always landed here: 102.5 one way round and 97.5 the other. Now the
    // lower price wins the tie either way.
    #[test]
    fn submission_order_decides_an_exact_tie() {
        let (lo, hi) = (97_500_000, 102_500_000);
        let mut first = [bid(500_000_000, 500), ask(1_000_000, 500)];
        let mut second = [ask(1_000_000, 500), bid(500_000_000, 500)];
        band(&mut first, lo, hi);
        band(&mut second, lo, hi);
        let a = clear(&first, REF).unwrap().unwrap();
        let b = clear(&second, REF).unwrap().unwrap();
        assert_eq!(a.price, b.price, "{} against {}", a.price, b.price);
        assert_eq!(a.price, lo);
    }

    #[test]
    fn when_the_pool_buys_the_leftover_both_sides_still_add_up() {
        // 300 of asks against 100 of bids. The asks sell 300: 100 to the bid
        // and 200 to the pool. The bid buys its 100 and not a unit more.
        let book = [bid(100_000_000, 100), ask(100_000_000, 120), ask(100_000_000, 180)];
        let q = quote(100_000_000, 101_000_000, 1_000);
        let out = clear_with_pool(&book, &q, REF).unwrap().unwrap();
        assert_eq!(out.pool_bought, 200);
        assert_eq!(out.matched, 300);
        let asks: u64 = book[1..].iter().map(|o| fill_for(o, &book, &out.side(false)).unwrap()).sum();
        assert_eq!(asks, 300);
        assert_eq!(fill_for(&book[0], &book, &out.side(true)).unwrap(), 100);
    }

    #[test]
    fn a_split_order_never_fills_more_than_the_whole() {
        // 10 left at the margin for 33 resting there. Whole, an order of 11
        // takes floor(110 / 33) = 3; split 5 + 6 it takes 1 + 1. Rounding
        // can cost a split order, never pay it.
        let whole = [bid(100_000_000, 11), bid(100_000_000, 22), ask(100_000_000, 10)];
        let split = [
            bid(100_000_000, 5),
            bid(100_000_000, 6),
            bid(100_000_000, 22),
            ask(100_000_000, 10),
        ];
        let c = clear(&whole, REF).unwrap().unwrap();
        assert_eq!(clear(&split, REF).unwrap().unwrap(), c);
        let w = fill_for(&whole[0], &whole, &c).unwrap();
        let s = fill_for(&split[0], &split, &c).unwrap() + fill_for(&split[1], &split, &c).unwrap();
        assert_eq!((w, s), (3, 2));
    }

    #[test]
    fn a_keener_order_fills_in_full_before_the_margin_sees_anything() {
        let book = [
            bid(101_000_000, 40),
            bid(100_000_000, 60),
            ask(100_000_000, 50),
        ];
        let c = clear(&book, REF).unwrap().unwrap();
        assert_eq!(c.price, 100_000_000);
        assert_eq!(fill_for(&book[0], &book, &c).unwrap(), 40);
        assert_eq!(fill_for(&book[1], &book, &c).unwrap(), 10);
    }

    #[test]
    fn with_no_pool_a_one_sided_book_does_not_trade() {
        let book = [bid(105_000_000, 3_000), bid(104_000_000, 1_000)];
        assert_eq!(clear_with_pool(&book, &quote(99_000_000, 101_000_000, 0), REF).unwrap(), None);
    }
}

