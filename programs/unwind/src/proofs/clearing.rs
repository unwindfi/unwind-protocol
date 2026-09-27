//! The auction's fairness and optimality claims: the clearing price is the
//! one the docs say it is, submission order does not decide it, fills add up
//! to what trades, and nobody gains by arriving first or by splitting.
//!
//! The bounds are the same as `auction.rs`: three orders (four where an order
//! is split in two), four price levels, sizes up to 15.

use crate::auction::{
    clear, clear_with_pool, clear_with_pool_on, fill_for, AuctionOrder, Clearing, PoolQuote,
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

fn any_reference() -> u64 {
    let r: u64 = kani::any();
    kani::assume(r >= 1 && r <= MAX_PRICE);
    r
}

/// Every ordering of three orders. The batch array is filled in arrival
/// order (a cancelled slot is reused, so it is close to it), and the clearing
/// reads the book in array order.
const PERMS: [[usize; N]; 6] = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];

fn any_permutation(book: &[AuctionOrder; N]) -> [AuctionOrder; N] {
    let k: usize = kani::any();
    kani::assume(k < PERMS.len());
    let p = PERMS[k];
    [book[p[0]], book[p[1]], book[p[2]]]
}

/// Demand and supply at `price`, written out independently of the program as
/// the docs define them: bids at or above it, asks at or below it.
fn spec_depth(book: &[AuctionOrder], price: u64) -> (u64, u64) {
    let (mut d, mut s) = (0u64, 0u64);
    for o in book {
        if o.is_bid && o.price >= price { d += o.size }
        if !o.is_bid && o.price <= price { s += o.size }
    }
    (d, s)
}

fn spec_volume(book: &[AuctionOrder], price: u64) -> u64 {
    let (d, s) = spec_depth(book, price);
    d.min(s)
}

// The fairness claim in its strongest form. This failed before `clear` got a
// fourth tie-break: a bid of 1 at 3 and an ask of 1 at 1, reference 2. Both 1
// and 3 cross 1 with no imbalance and both are 1 from the reference, so all
// three tie-breaks were equal and `clear` kept whichever candidate it met
// first. [bid, ask] cleared at 3, [ask, bid] at 1. Because the band is
// symmetric around the oracle, a bid through its top against an ask through
// its bottom was exactly this tie in production. The lower price now wins.
/// The clearing price and every order's fill do not depend on the order in
/// which orders were submitted.
#[kani::proof]
#[kani::unwind(5)]
#[kani::solver(cadical)]
fn the_clearing_is_independent_of_submission_order() {
    let book = any_book();
    let shuffled = any_permutation(&book);
    let quote = any_quote();
    let reference = any_reference();
    let a = clear_with_pool(&book, &quote, reference).unwrap();
    let b = clear_with_pool(&shuffled, &quote, reference).unwrap();
    assert!(a == b);
}

// What submission order can and cannot change, in three pieces (one harness
// running the whole clearing twice with fills did not finish in 13 minutes).
// Together: arriving earlier never changes whether a batch trades, how much
// trades, the price, the pool's take, or any order's fill.

/// Any two orderings of a book trade or not alike, cross the same volume, and
/// clear at the same price, exact ties included.
#[kani::proof]
#[kani::unwind(5)]
#[kani::solver(cadical)]
fn submission_order_never_changes_the_price() {
    let book = any_book();
    let shuffled = any_permutation(&book);
    let reference = any_reference();
    let a = clear(&book, reference).unwrap();
    let b = clear(&shuffled, reference).unwrap();
    assert!(a.is_some() == b.is_some());
    if let (Some(a), Some(b)) = (a, b) {
        assert!(a.matched == b.matched);
        assert!(a.price == b.price);
    }
}

/// With the pool in, any two orderings give the identical outcome: whether it
/// trades, the price, the volume, and what the pool bought or sold.
#[kani::proof]
#[kani::unwind(5)]
#[kani::solver(cadical)]
fn submission_order_does_not_change_the_pools_take() {
    let book = any_book();
    let shuffled = any_permutation(&book);
    let quote = any_quote();
    let reference = any_reference();
    let a = clear_with_pool(&book, &quote, reference).unwrap();
    let b = clear_with_pool(&shuffled, &quote, reference).unwrap();
    assert!(a == b);
}

/// At any clearing, every order is allocated the same fill whichever way the
/// book was ordered: allocation is pro-rata, never first come. The book is
/// arbitrary, so checking its first order checks every order.
#[kani::proof]
#[kani::unwind(5)]
#[kani::solver(cadical)]
fn submission_order_does_not_change_any_fill() {
    let book = any_book();
    let shuffled = any_permutation(&book);
    let c = Clearing { price: kani::any(), matched: kani::any() };
    kani::assume(c.price >= 1 && c.price <= MAX_PRICE);
    kani::assume(c.matched <= 3 * MAX_SIZE);
    let o = &book[0];
    assert!(fill_for(o, &book, &c).unwrap() == fill_for(o, &shuffled, &c).unwrap());
}

/// The clearing price is the one the docs specify: it crosses at least as
/// much volume as any price at all (not only the prices orders named), the
/// volume it reports is what actually crosses there, and among order prices
/// crossing that volume it has the least imbalance, then the least distance
/// from the reference. A book that clears nothing crosses nothing anywhere.
#[kani::proof]
#[kani::unwind(5)]
#[kani::solver(cadical)]
fn the_clearing_price_is_the_documented_argmax() {
    let book = any_book();
    let reference = any_reference();
    let p: u64 = kani::any();
    match clear(&book, reference).unwrap() {
        None => assert!(spec_volume(&book, p) == 0),
        Some(c) => {
            assert!(c.matched > 0);
            assert!(book.iter().any(|o| o.price == c.price));
            assert!(c.matched == spec_volume(&book, c.price));
            // Most volume, over every price.
            assert!(spec_volume(&book, p) <= c.matched);
            // Tie-breaks, over the candidate prices the code considers.
            let (d, s) = spec_depth(&book, c.price);
            for q in book.iter().map(|o| o.price) {
                let (qd, qs) = spec_depth(&book, q);
                if qd.min(qs) == c.matched {
                    assert!(d.abs_diff(s) <= qd.abs_diff(qs));
                    if d.abs_diff(s) == qd.abs_diff(qs) {
                        assert!(c.price.abs_diff(reference) <= q.abs_diff(reference));
                    }
                }
            }
        }
    }
}

/// With the pool out of it, a batch trades exactly when some bid is willing
/// to pay what some ask is willing to take. A book that does not cross clears
/// nothing, and one that does is never left untraded.
#[kani::proof]
#[kani::unwind(5)]
#[kani::solver(cadical)]
fn a_book_trades_on_its_own_exactly_when_it_crosses() {
    let book = any_book();
    let mut quote = any_quote();
    quote.size = 0;
    let reference = any_reference();
    let crosses = book.iter().any(|b| {
        b.is_bid && b.size > 0
            && book.iter().any(|a| !a.is_bid && a.size > 0 && b.price >= a.price)
    });
    let out = clear_with_pool(&book, &quote, reference).unwrap();
    assert!(out.is_some() == crosses);
    if let Some(out) = out {
        assert!(out.pool_bought == 0 && out.pool_sold == 0);
    }
}

/// Fills add up to what trades. Buyers receive what sellers deliver plus
/// whatever the pool sold them, less whatever the pool bought, with no more
/// than one unit of pro-rata rounding lost per order and nothing ever
/// allocated that did not trade. Holds whichever sides the pool may fill, so
/// it covers a single book and both flows of a dual batch.
#[kani::proof]
#[kani::unwind(5)]
#[kani::solver(cadical)]
fn fills_conserve_what_trades() {
    let book = any_book();
    let quote = any_quote();
    let reference = any_reference();
    let (may_buy, may_sell): (bool, bool) = (kani::any(), kani::any());
    if let Some(out) = clear_with_pool_on(&book, &quote, reference, may_buy, may_sell).unwrap() {
        let (mut bids, mut asks, mut nb, mut na) = (0u64, 0u64, 0u64, 0u64);
        for o in book.iter() {
            let f = fill_for(o, &book, &out.side(o.is_bid)).unwrap();
            if o.is_bid { bids += f; nb += 1 } else { asks += f; na += 1 }
        }
        // What each side trades, counted with the pool as a counterparty.
        let bought = bids + out.pool_bought;
        let sold = asks + out.pool_sold;
        assert!(bought <= out.matched && bought + nb >= out.matched);
        assert!(sold <= out.matched && sold + na >= out.matched);
    }
}

/// Price priority, and pro-rata that is monotone in size. On either side: if
/// any order resting exactly at the clearing price fills at all, every order
/// that named a strictly better price fills in full; and of two orders at the
/// same limit, the larger never fills less.
#[kani::proof]
#[kani::unwind(5)]
#[kani::solver(cadical)]
fn a_better_price_fills_first_and_size_never_hurts() {
    let book = any_book();
    let quote = any_quote();
    let reference = any_reference();
    if let Some(out) = clear_with_pool(&book, &quote, reference).unwrap() {
        let fills = [
            fill_for(&book[0], &book, &out.side(book[0].is_bid)).unwrap(),
            fill_for(&book[1], &book, &out.side(book[1].is_bid)).unwrap(),
            fill_for(&book[2], &book, &out.side(book[2].is_bid)).unwrap(),
        ];
        for i in 0..N {
            for j in 0..N {
                let (a, b) = (&book[i], &book[j]);
                if a.is_bid != b.is_bid { continue; }
                let a_through = if a.is_bid { a.price > out.price } else { a.price < out.price };
                if a_through && b.price == out.price && fills[j] > 0 {
                    assert!(fills[i] == a.size);
                }
                if a.price == b.price && a.size >= b.size {
                    assert!(fills[i] >= fills[j]);
                }
            }
        }
    }
}

/// Splitting an order in two wins nothing: the two halves together fill no
/// more than the whole order would have, and lose at most one unit to
/// rounding. Checked against any clearing at all, so it does not depend on
/// how the clearing was reached.
#[kani::proof]
#[kani::unwind(6)]
#[kani::solver(cadical)]
fn splitting_an_order_wins_nothing() {
    let whole = any_book();
    let first: u64 = kani::any();
    kani::assume(first <= whole[0].size);
    let half_a = AuctionOrder { size: first, ..whole[0] };
    let half_b = AuctionOrder { size: whole[0].size - first, ..whole[0] };
    let split = [half_a, half_b, whole[1], whole[2]];

    let c = Clearing { price: kani::any(), matched: kani::any() };
    kani::assume(c.price >= 1 && c.price <= MAX_PRICE);
    kani::assume(c.matched <= 3 * MAX_SIZE);

    let w = fill_for(&whole[0], &whole, &c).unwrap();
    let s = fill_for(&half_a, &split, &c).unwrap() + fill_for(&half_b, &split, &c).unwrap();
    assert!(s <= w && w <= s + 1);
}
