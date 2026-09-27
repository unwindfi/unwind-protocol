//! The batch auction: fills, limits, the pool's quote, the band and the
//! maker/taker split.
//!
//! The bounds: three orders, four price levels, sizes up to 15.

use crate::auction::{
    band, clear_with_pool, clear_with_pool_on, fill_for, AuctionOrder, DualBook, Flow, PoolQuote,
};

const N: usize = 3;
const MAX_SIZE: u64 = 15;
const MAX_PRICE: u64 = 4;

fn any_order() -> AuctionOrder {
    let o = AuctionOrder {
        price: kani::any(),
        size: kani::any(),
        is_bid: kani::any(),
        is_maker: kani::any(),
    };
    // A few price levels is enough to cover every ordering of the book.
    kani::assume(o.price >= 1 && o.price <= MAX_PRICE);
    kani::assume(o.size <= MAX_SIZE);
    o
}

fn any_book() -> [AuctionOrder; N] {
    [any_order(), any_order(), any_order()]
}

fn any_quote() -> PoolQuote {
    let q = PoolQuote { bid: kani::any(), ask: kani::any(), size: kani::any() };
    kani::assume(q.bid >= 1 && q.bid <= q.ask && q.ask <= MAX_PRICE);
    kani::assume(q.size <= MAX_SIZE);
    q
}

/// The bug a unit test found by accident: no order fills past its size, on
/// either side, whatever the pool absorbs.
#[kani::proof]
#[kani::unwind(5)]
#[kani::solver(cadical)]
fn no_order_fills_past_its_size() {
    let book = any_book();
    let quote = any_quote();
    let reference: u64 = kani::any();
    kani::assume(reference >= 1 && reference <= MAX_PRICE);
    if let Ok(Some(out)) = clear_with_pool(&book, &quote, reference) {
        for o in book.iter() {
            let fill = fill_for(o, &book, &out.side(o.is_bid)).unwrap();
            assert!(fill <= o.size);
        }
    }
}

/// Everybody trades at one price, and it is never worse than their limit.
#[kani::proof]
#[kani::unwind(5)]
#[kani::solver(cadical)]
fn fills_respect_every_limit() {
    let book = any_book();
    let quote = any_quote();
    let reference: u64 = kani::any();
    kani::assume(reference >= 1 && reference <= MAX_PRICE);
    if let Ok(Some(out)) = clear_with_pool(&book, &quote, reference) {
        for o in book.iter() {
            let fill = fill_for(o, &book, &out.side(o.is_bid)).unwrap();
            if fill > 0 {
                assert!(if o.is_bid { o.price >= out.price } else { o.price <= out.price });
            }
        }
    }
}

/// Neither side is allocated more than it trades, and the light side trades
/// no more than the book's own crossing: the pool's share goes only to the
/// side it fills.
#[kani::proof]
#[kani::unwind(5)]
#[kani::solver(cadical)]
fn each_side_fills_at_most_what_it_trades() {
    let book = any_book();
    let quote = any_quote();
    let reference: u64 = kani::any();
    kani::assume(reference >= 1 && reference <= MAX_PRICE);
    if let Ok(Some(out)) = clear_with_pool(&book, &quote, reference) {
        let (mut bids, mut asks) = (0u128, 0u128);
        for o in book.iter() {
            let fill = fill_for(o, &book, &out.side(o.is_bid)).unwrap() as u128;
            if o.is_bid { bids += fill } else { asks += fill }
        }
        assert!(bids <= out.side(true).matched as u128);
        assert!(asks <= out.side(false).matched as u128);
        // What the book crossed, before the pool: bids and asks fill against
        // each other up to it, and the pool covers only the difference.
        let book_matched = (out.matched - out.pool_sold.max(out.pool_bought)) as u128;
        assert!(bids <= book_matched + out.pool_sold as u128);
        assert!(asks <= book_matched + out.pool_bought as u128);
    }
}

/// The pool never takes more than its quote, and never both sides at once.
#[kani::proof]
#[kani::unwind(5)]
#[kani::solver(cadical)]
fn the_pool_stays_inside_its_quote() {
    let book = any_book();
    let quote = any_quote();
    let reference: u64 = kani::any();
    kani::assume(reference >= 1 && reference <= MAX_PRICE);
    if let Ok(Some(out)) = clear_with_pool(&book, &quote, reference) {
        assert!(out.pool_sold <= quote.size && out.pool_bought <= quote.size);
        assert!(out.pool_sold == 0 || out.pool_bought == 0);
        // It sells no cheaper than its ask and buys no dearer than its bid.
        if out.pool_sold > 0 { assert!(out.price >= quote.ask); }
        if out.pool_bought > 0 { assert!(out.price <= quote.bid); }
    }
}

/// Whatever the book says, a banded batch clears inside the band, and nobody
/// trades worse than the limit they actually named.
#[kani::proof]
#[kani::unwind(5)]
#[kani::solver(cadical)]
fn a_banded_batch_clears_inside_the_band() {
    let named = any_book();
    let (lo, hi): (u64, u64) = (kani::any(), kani::any());
    kani::assume(lo >= 1 && lo <= hi && hi <= MAX_PRICE);
    let mut book = named;
    band(&mut book, lo, hi);
    let mut quote = any_quote();
    quote.bid = quote.bid.max(lo);
    quote.ask = quote.ask.min(hi);
    kani::assume(quote.bid <= quote.ask);
    let reference: u64 = kani::any();
    kani::assume(reference >= lo && reference <= hi);
    if let Ok(Some(out)) = clear_with_pool(&book, &quote, reference) {
        assert!(out.price >= lo && out.price <= hi);
        for (o, n) in book.iter().zip(named.iter()) {
            let fill = fill_for(o, &book, &out.side(o.is_bid)).unwrap();
            if fill > 0 {
                assert!(if n.is_bid { n.price >= out.price } else { n.price <= out.price });
            }
        }
    }
}

// The batch as it actually clears: two flows, takers buying against makers
// selling and takers selling against makers buying, the pool filling takers
// only. `clear_dual` is `DualBook::split` followed by one `clear_with_pool_on`
// per flow, and `dual_fill_for` is `fill_for` against the order's own flow.
// Proving the dual clearing whole ran the model checker out of memory (it
// has to track the growable lists `split` builds), so it is proved in the two
// pieces it is made of: the split is a partition, and each flow, on its own
// book, keeps every promise.

/// Every order lands in exactly its own flow, and nothing is lost or added.
#[kani::proof]
#[kani::unwind(5)]
fn the_split_puts_every_order_in_its_own_flow() {
    let book = any_book();
    let dual = DualBook::split(&book);
    assert!(dual.buy.len() + dual.sell.len() == N);
    for o in dual.buy.iter() { assert!(o.flow() == Flow::Buy); }
    for o in dual.sell.iter() { assert!(o.flow() == Flow::Sell); }
    let buys = book.iter().filter(|o| o.flow() == Flow::Buy).count();
    assert!(dual.buy.len() == buys);
}

/// One flow's book: every order in it belongs to `flow`, all banded.
fn any_flow_batch(flow: Flow) -> ([AuctionOrder; N], [AuctionOrder; N], PoolQuote, u64, u64, u64) {
    let mut named = any_book();
    for o in named.iter_mut() {
        // Its role follows from its side and the flow it is in.
        o.is_maker = o.is_bid == (flow == Flow::Sell);
        kani::assume(o.flow() == flow);
    }
    let (lo, hi): (u64, u64) = (kani::any(), kani::any());
    kani::assume(lo >= 1 && lo <= hi && hi <= MAX_PRICE);
    let mut book = named;
    band(&mut book, lo, hi);
    let mut quote = any_quote();
    quote.bid = quote.bid.max(lo);
    quote.ask = quote.ask.min(hi);
    kani::assume(quote.bid <= quote.ask);
    let reference: u64 = kani::any();
    kani::assume(reference >= lo && reference <= hi);
    (named, book, quote, lo, hi, reference)
}

fn any_flow() -> Flow {
    if kani::any() { Flow::Buy } else { Flow::Sell }
}

/// The pool's permissions in a flow, exactly as `clear_dual` sets them: it
/// sells into the buy flow and buys in the sell flow, nothing else.
fn clear_flow(flow: Flow, book: &[AuctionOrder], quote: &PoolQuote, reference: u64)
    -> Option<crate::auction::Outcome> {
    let (may_buy, may_sell) = (flow == Flow::Sell, flow == Flow::Buy);
    clear_with_pool_on(book, quote, reference, may_buy, may_sell).ok().flatten()
}

/// In a flow, no order fills past its size, trades outside the band, or
/// trades worse than the limit it named.
#[kani::proof]
#[kani::unwind(5)]
#[kani::solver(cadical)]
fn a_flow_fills_every_order_within_its_size_limit_and_band() {
    let flow = any_flow();
    let (named, book, quote, lo, hi, reference) = any_flow_batch(flow);
    if let Some(out) = clear_flow(flow, &book, &quote, reference) {
        assert!(out.price >= lo && out.price <= hi);
        for (o, n) in book.iter().zip(named.iter()) {
            let fill = fill_for(o, &book, &out.side(o.is_bid)).unwrap();
            assert!(fill <= o.size);
            if fill > 0 {
                assert!(if n.is_bid { n.price >= out.price } else { n.price <= out.price });
            }
        }
    }
}

/// The pool fills takers and nobody else, within its quote: it only sells in
/// the buy flow and only buys in the sell flow, so its net position from a
/// batch never exceeds the size it quoted.
#[kani::proof]
#[kani::unwind(5)]
#[kani::solver(cadical)]
fn the_pool_fills_only_takers_within_its_quote() {
    let flow = any_flow();
    let (_, book, quote, _, _, reference) = any_flow_batch(flow);
    if let Some(out) = clear_flow(flow, &book, &quote, reference) {
        match flow {
            Flow::Buy => assert!(out.pool_bought == 0 && out.pool_sold <= quote.size),
            Flow::Sell => assert!(out.pool_sold == 0 && out.pool_bought <= quote.size),
        }
        if out.pool_sold > 0 { assert!(out.price >= quote.ask); }
        if out.pool_bought > 0 { assert!(out.price <= quote.bid); }
    }
}

/// Neither side of a flow is allocated more than it trades.
#[kani::proof]
#[kani::unwind(5)]
#[kani::solver(cadical)]
fn each_side_of_a_flow_fills_at_most_what_it_trades() {
    let flow = any_flow();
    let (_, book, quote, _, _, reference) = any_flow_batch(flow);
    if let Some(out) = clear_flow(flow, &book, &quote, reference) {
        let (mut bids, mut asks) = (0u128, 0u128);
        for o in book.iter() {
            let fill = fill_for(o, &book, &out.side(o.is_bid)).unwrap() as u128;
            if o.is_bid { bids += fill } else { asks += fill }
        }
        assert!(bids <= out.side(true).matched as u128);
        assert!(asks <= out.side(false).matched as u128);
    }
}
