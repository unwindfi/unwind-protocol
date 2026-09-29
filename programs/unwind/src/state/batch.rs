use crate::auction::{Flow, MAX_BATCH_ORDERS};
use crate::constants::*;
use crate::errors::PerpError;
use anchor_lang::prelude::*;
use bytemuck::Zeroable;

/// How long a batch collects orders before it can be cleared.
///
/// The number is the whole argument. Long enough that arriving a slot or two
/// sooner than someone else is worth nothing — which is what
/// removes the incentive to race, and with it most of the reason to co-locate
/// or pay for priority. Short enough that a trader managing a position in a
/// fast market is not parked watching it move.
pub const BATCH_INTERVAL_SEC: i64 = 1;

/// Share of a market's remaining loss budget the pool will quote in one batch.
///
/// The pool is a participant here, not the market. Capping what it will show
/// per batch is what stops it becoming the de-facto price for anything large:
/// flow past this size has to find a real counterparty or wait. It also means
/// a market whose budget is spent stops quoting rather than quoting into a
/// hole it cannot fund.
pub const POOL_QUOTE_BUDGET_BPS: u128 = 500; // 5%

/// Laid out by hand, `repr(C)`, with the padding written down.
///
/// The batch is held zero-copy — see `Batch` — and bytemuck will only accept a
/// type with no implicit gaps in it, so the trailing pad is load-bearing
/// rather than decorative. `is_bid` and `active` are `u8` for the same reason:
/// `bool` is not a plain-old-data type.
#[zero_copy]
#[repr(C)]
pub struct BatchOrder {
    pub owner: Pubkey,
    /// Limit price, `PRICE_SCALE`. The worst price this order will accept;
    /// it fills at the batch's clearing price, which is never worse.
    pub price: u64,
    pub size_usd: u64,
    /// Escrowed on submission and returned on cancellation or on the unfilled
    /// remainder. An order nobody has funded is an order that cannot settle.
    pub collateral_usd: u64,
    /// How much of `size_usd` the clearing found for this order.
    ///
    /// Computed once, when the batch is sealed, and stored rather than
    /// recomputed per settlement. Settlement marks orders done as it goes, so
    /// a fill derived at settlement time would be derived from a book that had
    /// already changed — every order after the first would price against a
    /// different auction than the one that actually cleared.
    pub filled_usd: u64,

    // The single-byte fields come last, together, with the slack written out.
    // Ordering is not cosmetic here: put `filled_usd` after `is_bid` and the
    // compiler inserts seven bytes to realign it, which bytemuck rejects
    // outright — a Pod type may not contain padding it did not declare.
    pub is_bid: u8,
    /// Cleared in place on cancellation rather than compacting the array,
    /// which would move every other order's index out from under its owner.
    pub active: u8,
    /// Set when this order unwinds an existing position instead of opening
    /// one. It changes nothing about how the order clears -- the auction sees
    /// size on a side and nothing else, which is the point -- only what
    /// settlement does with the fill.
    pub reduce_only: u8,
    /// Set when this order rests as liquidity rather than taking it. Decides
    /// which of the batch's two auctions it clears in: see `auction::Flow`.
    pub is_maker: u8,
    pub _pad: [u8; 4],
}


impl BatchOrder {
    pub fn is_active(&self) -> bool {
        self.active != 0
    }
    pub fn bid(&self) -> bool {
        self.is_bid != 0
    }
    pub fn reduces(&self) -> bool {
        self.reduce_only != 0
    }
    pub fn maker(&self) -> bool {
        self.is_maker != 0
    }
    pub fn flow(&self) -> Flow {
        Flow::of(self.bid(), self.maker())
    }
}

/// One market's collecting batch.
///
/// Orders accumulate here and nothing about them is privileged by arrival
/// time: the array is an unordered set, and the clearing price is a function
/// of its contents, not of their sequence.
/// Held zero-copy, which is what lets the array be worth having.
///
/// Anchor's ordinary `Account<T>` deserialises through a 4KB stack frame, and
/// an inline array of orders is past that almost immediately — at 64 orders it
/// overflowed the frame by 664 bytes and the program would not link, which is
/// why this was capped at 24 for a while. `AccountLoader` casts the account's
/// bytes in place instead: nothing is copied, nothing lands on the stack, and
/// the ceiling becomes the compute budget rather than the frame.
#[account(zero_copy)]
#[repr(C)]
pub struct Batch {
    pub market: Pubkey,
    /// Increments on every clear, so a settlement can prove which batch's
    /// price it is settling at.
    pub seq: u64,
    pub opened_ts: i64,

    /// The two clearings, one per flow. A price of zero is a flow that did
    /// not trade this batch, which says nothing about whether the other did.
    pub buy_price: u64,
    pub buy_matched_usd: u64,
    pub sell_price: u64,
    pub sell_matched_usd: u64,
    /// Set when the batch is sealed. Zero means still collecting: with two
    /// flows, neither price on its own can say whether the batch cleared.
    pub cleared_ts: i64,

    pub bump: u8,
    /// Orders still owed a settlement at their flow's price.
    pub unsettled: u8,
    pub order_count: u8,
    pub _pad: [u8; 5],

    pub orders: [BatchOrder; MAX_BATCH_ORDERS],
}

impl Batch {
    pub fn is_open(&self) -> bool {
        self.cleared_ts == 0
    }

    /// The price an order settles at: its own flow's.
    pub fn price_for(&self, order: &BatchOrder) -> u64 {
        match order.flow() {
            Flow::Buy => self.buy_price,
            Flow::Sell => self.sell_price,
        }
    }

    fn clear_prices(&mut self) {
        self.buy_price = 0;
        self.buy_matched_usd = 0;
        self.sell_price = 0;
        self.sell_matched_usd = 0;
        self.cleared_ts = 0;
    }

    pub fn is_due(&self, now: i64) -> bool {
        now >= self.opened_ts.saturating_add(BATCH_INTERVAL_SEC)
    }

    /// Adds an order, returning its index.
    pub fn insert(&mut self, order: BatchOrder) -> Result<u8> {
        require!(self.is_open(), PerpError::BatchSealed);
        // A batch holds sixty-four orders for everyone; one wallet may hold
        // only a few of them, so filling it takes many funded wallets rather
        // than one.
        let mine = self
            .orders
            .iter()
            .filter(|o| o.is_active() && o.owner == order.owner)
            .count();
        require!(mine < MAX_ORDERS_PER_OWNER, PerpError::TooManyOrders);
        // Reuse a cancelled slot before growing, so a market that churns
        // orders does not fill the batch with holes.
        for (i, slot) in self.orders.iter_mut().enumerate() {
            if slot.active == 0 {
                *slot = order;
                if i as u8 >= self.order_count {
                    self.order_count = (i as u8).saturating_add(1);
                }
                return Ok(i as u8);
            }
        }
        err!(PerpError::BatchFull)
    }

    /// Starts a new collection window with the standing orders left in place.
    ///
    /// For a batch that found no crossing. Nothing was decided: nobody filled,
    /// nobody should have paid, and the orders are exactly as valid as they
    /// were a second ago. Rolling them away instead — which this did until an
    /// integration test caught it — dropped every unfilled order along with
    /// the collateral escrowed behind it, because a cleared slot can no longer
    /// be cancelled or settled. The money simply stayed in the vault with
    /// nobody able to claim it.
    pub fn reopen(&mut self, now: i64) {
        self.seq = self.seq.saturating_add(1);
        self.opened_ts = now;
        self.clear_prices();
        self.unsettled = 0;
    }

    /// Opens the next batch, discarding the array. Only safe once every order
    /// in it has been settled — settlement is what returns the collateral.
    pub fn roll(&mut self, now: i64) {
        self.seq = self.seq.saturating_add(1);
        self.opened_ts = now;
        self.clear_prices();
        self.unsettled = 0;
        self.order_count = 0;
        self.orders = [BatchOrder::zeroed(); MAX_BATCH_ORDERS];
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn batch() -> Batch {
        Batch {
            bump: 0,
            market: Pubkey::default(),
            seq: 0,
            opened_ts: 0,
            buy_price: 0,
            buy_matched_usd: 0,
            sell_price: 0,
            sell_matched_usd: 0,
            cleared_ts: 0,
            unsettled: 0,
            order_count: 0,
            _pad: [0; 5],
            orders: [BatchOrder::zeroed(); MAX_BATCH_ORDERS],
        }
    }

    fn order(price: u64) -> BatchOrder {
        // A different owner per order, so the per-wallet limit is not what a
        // test about something else runs into.
        let mut key = [0u8; 32];
        key[..8].copy_from_slice(&price.to_le_bytes());
        BatchOrder {
            owner: Pubkey::new_from_array(key),
            price,
            size_usd: 1_000,
            collateral_usd: 100,
            is_bid: 1,
            filled_usd: 0,
            active: 1,
            reduce_only: 0,
            is_maker: 0,
            _pad: [0; 4],
        }
    }

    #[test]
    fn a_batch_collects_until_the_interval_has_passed() {
        let b = batch();
        assert!(b.is_open());
        assert!(!b.is_due(BATCH_INTERVAL_SEC - 1));
        assert!(b.is_due(BATCH_INTERVAL_SEC));
    }

    #[test]
    fn a_sealed_batch_takes_no_more_orders() {
        let mut b = batch();
        b.cleared_ts = 1;
        assert!(b.insert(order(1)).is_err());
    }

    #[test]
    fn a_cancelled_slot_is_reused_rather_than_leaving_a_hole() {
        let mut b = batch();
        let first = b.insert(order(1)).unwrap();
        b.insert(order(2)).unwrap();
        b.orders[first as usize].active = 0;
        // The next order takes the freed slot, so churn cannot exhaust the
        // batch while it is mostly empty.
        assert_eq!(b.insert(order(3)).unwrap(), first);
        assert_eq!(b.order_count, 2);
    }

    #[test]
    fn cancelling_does_not_move_anyone_elses_index() {
        let mut b = batch();
        let a = b.insert(order(1)).unwrap();
        let c = b.insert(order(2)).unwrap();
        b.orders[a as usize].active = 0;
        // `c` still refers to the same order it did before, which is what
        // lets an owner hold on to an index across other people's activity.
        assert_eq!(b.orders[c as usize].price, 2);
    }

    #[test]
    fn one_wallet_may_hold_only_a_few_orders() {
        let mut b = batch();
        let mine = |price| BatchOrder { owner: Pubkey::new_from_array([7; 32]), ..order(price) };
        for i in 0..MAX_ORDERS_PER_OWNER {
            b.insert(mine(i as u64 + 1)).unwrap();
        }
        assert!(b.insert(mine(999)).is_err(), "the fifth is refused");
        // Somebody else is not affected.
        assert!(b.insert(order(1_000)).is_ok());
    }

    #[test]
    fn a_full_batch_is_refused_rather_than_overwriting() {
        let mut b = batch();
        for i in 0..MAX_BATCH_ORDERS {
            b.insert(order(i as u64 + 1)).unwrap();
        }
        assert!(b.insert(order(999)).is_err());
    }

    #[test]
    fn a_batch_that_found_no_crossing_keeps_its_orders() {
        let mut b = batch();
        b.insert(order(1)).unwrap();
        b.insert(order(2)).unwrap();
        b.reopen(500);

        // The window restarts and the orders stand. Dropping them here would
        // strand their collateral: the slot is gone, so nobody can cancel it
        // and no settlement will ever refund it.
        assert_eq!(b.seq, 1);
        assert_eq!(b.opened_ts, 500);
        assert!(b.is_open());
        assert!(b.orders[0].is_active());
        assert!(b.orders[1].is_active());
        assert_eq!(b.order_count, 2);
    }

    #[test]
    fn rolling_clears_everything_and_advances_the_sequence() {
        let mut b = batch();
        b.insert(order(1)).unwrap();
        b.buy_price = 100;
        b.buy_matched_usd = 50;
        b.cleared_ts = 900;
        b.roll(1_000);
        assert_eq!(b.seq, 1);
        assert_eq!(b.opened_ts, 1_000);
        assert!(b.is_open());
        assert_eq!(b.order_count, 0);
        assert_eq!(b.orders[0].active, 0);
    }

    #[test]
    fn a_reopened_batch_takes_orders_again() {
        let mut b = batch();
        b.insert(order(1)).unwrap();
        b.cleared_ts = 10;
        assert!(b.insert(order(2)).is_err());
        b.reopen(20);
        assert_eq!(b.insert(order(2)).unwrap(), 1);
    }

    #[test]
    fn the_lowest_free_slot_is_taken_first() {
        let mut b = batch();
        for i in 0..5 {
            b.insert(order(i + 1)).unwrap();
        }
        b.orders[3].active = 0;
        b.orders[1].active = 0;
        assert_eq!(b.insert(order(10)).unwrap(), 1);
        assert_eq!(b.insert(order(11)).unwrap(), 3);
        assert_eq!(b.insert(order(12)).unwrap(), 5);
        assert_eq!(b.order_count, 6);
    }

    #[test]
    fn a_refused_order_leaves_the_batch_untouched() {
        let mut b = batch();
        for i in 0..MAX_BATCH_ORDERS {
            b.insert(order(i as u64 + 1)).unwrap();
        }
        let before = b;
        assert!(b.insert(order(999)).is_err());
        assert_eq!(bytemuck::bytes_of(&b), bytemuck::bytes_of(&before));
    }

    #[test]
    fn a_cancelled_order_gives_its_wallet_the_slot_back() {
        let mut b = batch();
        let mine = |price| BatchOrder { owner: Pubkey::new_from_array([7; 32]), ..order(price) };
        for i in 0..MAX_ORDERS_PER_OWNER {
            b.insert(mine(i as u64 + 1)).unwrap();
        }
        assert!(b.insert(mine(50)).is_err());
        b.orders[2].active = 0;
        assert_eq!(b.insert(mine(50)).unwrap(), 2);
    }

    #[test]
    fn inserting_writes_only_its_own_slot_owner_included() {
        let mut b = batch();
        for i in 0..6 {
            b.insert(order(i + 1)).unwrap();
        }
        b.orders[2].active = 0;
        let before = b;
        let new = BatchOrder { owner: Pubkey::new_from_array([9; 32]), ..order(50) };
        assert_eq!(b.insert(new).unwrap(), 2);
        assert_eq!(bytemuck::bytes_of(&b.orders[2]), bytemuck::bytes_of(&new));
        for j in (0..MAX_BATCH_ORDERS).filter(|j| *j != 2) {
            assert_eq!(bytemuck::bytes_of(&b.orders[j]), bytemuck::bytes_of(&before.orders[j]));
        }
    }

    #[test]
    fn a_rolled_batch_is_not_due_until_a_full_interval_later() {
        let mut b = batch();
        b.cleared_ts = 1;
        b.roll(1_000);
        assert!(!b.is_due(1_000 + BATCH_INTERVAL_SEC - 1));
        assert!(b.is_due(1_000 + BATCH_INTERVAL_SEC));
    }
}
