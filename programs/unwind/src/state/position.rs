use crate::errors::PerpError;
use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct Position {
    pub bump: u8,
    pub owner: Pubkey,
    pub market: Pubkey,
    pub is_long: bool,

    /// Notional at entry, in `USD_SCALE`.
    pub size_usd: u64,
    /// Margin posted, in `USD_SCALE`. Held in the pool vault but owned by the
    /// trader and excluded from LP AUM.
    pub collateral_usd: u64,
    /// Size-weighted entry price, in the `price_factor` in force when written.
    pub entry_price: u64,
    /// `Market::price_factor` at the last write, so corporate actions can be
    /// applied lazily instead of iterating every open position.
    pub entry_price_factor: u128,
    /// Funding index snapshot for this side at the last settlement.
    pub entry_funding: i128,
    /// Liquidity locked in the pool against this position's potential profit.
    pub locked_usd: u64,

    /// Notional already promised to reduce-only orders resting in the batch.
    ///
    /// A close does not escrow anything -- the collateral behind it is already
    /// in the vault -- so without this a trader could submit the same size to
    /// close five times over and settle each one against a position that only
    /// covers the first. Reserving at submission is the cheap half of that
    /// problem; the expensive half is that a reservation must never be able to
    /// block a liquidation, which is why nothing reads this except
    /// `reserve_close` and settlement.
    pub closing_usd: u64,

    pub open_ts: i64,
    pub last_update_ts: i64,
    /// `Market::q_tag` when this position's size and entry are counted in its
    /// side's `SideMoments`, zero when they are not, which is every position
    /// opened before those sums existed. Was the first four bytes of
    /// `_reserved`.
    pub q_epoch: u32,
    /// `Market::q_tag` when this position's funding term is counted in its
    /// side's `SideFunding`, zero when it is not, which is every position
    /// written before those sums existed. Was the next four bytes of
    /// `_reserved`.
    pub f_epoch: u32,
    /// When the size now open counts as held from, for `MIN_HOLD_SECS`: the
    /// open's time, moved forward on every add in proportion to the size
    /// added. Untouched by a partial close. Zero on a position written before
    /// it existed, which reads `open_ts` instead. Was the first eight bytes
    /// of `_reserved`.
    pub held_ts: i64,
    pub _reserved: [u8; 8],
}

impl Position {
    pub fn is_open(&self) -> bool {
        self.size_usd > 0
    }

    /// When the open size counts as held from.
    pub fn held_since(&self) -> i64 {
        if self.held_ts != 0 {
            self.held_ts
        } else {
            self.open_ts
        }
    }

    /// Seconds the open size has been held at `now`.
    pub fn held_secs(&self, now: i64) -> i64 {
        now.saturating_sub(self.held_since()).max(0)
    }

    /// Moves the held clock for `add_usd` more size filled at `now`. Called
    /// before the size changes. An empty position starts the clock at `now`;
    /// an open one takes the size-weighted time, rounded up, so adding to an
    /// old position cannot lend the new size its age.
    pub fn add_held(&mut self, add_usd: u64, now: i64) {
        if !self.is_open() {
            self.held_ts = now;
            return;
        }
        let old = self.size_usd as i128;
        let add = add_usd as i128;
        let total = old + add;
        if total == 0 {
            return;
        }
        let num = (self.held_since() as i128) * old + (now as i128) * add;
        // Rounded up: a second's doubt goes against the points, not for them.
        self.held_ts = num.div_euclid(total) as i64 + i64::from(num.rem_euclid(total) != 0);
    }

    /// Size this position could still promise to a new closing order.
    pub fn closable_usd(&self) -> u64 {
        self.size_usd.saturating_sub(self.closing_usd)
    }

    /// The size a fired close trigger puts into the batch: `requested`, or
    /// all that is still closable when it asks for zero or for more. The same
    /// floor as a hand-submitted reduce-only order: no smaller than an open
    /// may be, unless it is everything left.
    pub fn trigger_close_size(&self, requested: u64, min_position_usd: u64) -> Result<u64> {
        let closable = self.closable_usd();
        let size = if requested == 0 || requested > closable { closable } else { requested };
        require!(size > 0, PerpError::PositionEmpty);
        require!(
            size >= min_position_usd || size == closable,
            PerpError::PositionTooSmall
        );
        Ok(size)
    }

    pub fn reserve_close(&mut self, size_usd: u64) -> Result<()> {
        require!(size_usd <= self.closable_usd(), PerpError::PositionTooSmall);
        self.closing_usd = self
            .closing_usd
            .checked_add(size_usd)
            .ok_or(PerpError::MathOverflow)?;
        Ok(())
    }

    /// Gives back a reservation when its order is cancelled, settled, or
    /// overtaken by a liquidation. Saturating on purpose: a liquidation empties
    /// the position without consulting the orders resting against it, so a
    /// release can legitimately arrive for size that is no longer there.
    pub fn release_close(&mut self, size_usd: u64) {
        self.closing_usd = self.closing_usd.saturating_sub(size_usd);
    }

    /// How much of a filled reduce-only order this position can take.
    ///
    /// Submission checks the order's side against the position, but the
    /// position can change under a resting order: a liquidation empties it,
    /// and an open in the same batch can put it back on the other side. A
    /// sell that was placed to close a long must not then reduce the short
    /// that replaced it, so the side is checked again here, at settlement.
    pub fn closable_by(&self, order_is_bid: bool, filled_usd: u64) -> u64 {
        if !self.is_open() || order_is_bid == self.is_long {
            return 0;
        }
        filled_usd.min(self.size_usd)
    }

    /// `closable_by` for an order in a batch that opened at `batch_opened_ts`.
    ///
    /// A position opened after that was opened by a settlement of this same
    /// batch, after a liquidation emptied the one the order was placed to
    /// close: positions only open at settlement, and the batch an order sits
    /// in opens after the settlement that rolled the last one. The order is
    /// not for it, even on the same side, so it closes nothing.
    pub fn closable_in(&self, order_is_bid: bool, filled_usd: u64, batch_opened_ts: i64) -> u64 {
        if self.open_ts > batch_opened_ts {
            return 0;
        }
        self.closable_by(order_is_bid, filled_usd)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn position(is_long: bool, size_usd: u64) -> Position {
        Position {
            bump: 0,
            owner: Pubkey::default(),
            market: Pubkey::default(),
            is_long,
            size_usd,
            collateral_usd: 0,
            entry_price: 0,
            entry_price_factor: 0,
            entry_funding: 0,
            locked_usd: 0,
            closing_usd: 0,
            open_ts: 0,
            last_update_ts: 0,
            q_epoch: 0,
            f_epoch: 0,
            held_ts: 0,
            _reserved: [0; 8],
        }
    }

    /// SP-5. A sell placed to close a long, which is then liquidated and
    /// opened again on the same side by the owner's buy in the same batch,
    /// must not close the new long.
    #[test]
    fn a_close_order_skips_a_position_opened_after_its_batch() {
        let mut p = position(true, 1_000);
        p.open_ts = 100;
        assert_eq!(p.closable_in(false, 600, 200), 600, "the long it was placed against");
        p.open_ts = 260;
        assert_eq!(p.closable_in(false, 600, 200), 0, "a long opened at this batch's settlement");
    }

    #[test]
    fn an_add_moves_the_held_clock_by_the_size_it_adds() {
        let mut p = position(true, 0);
        p.add_held(1_000, 1_000);
        assert_eq!(p.held_ts, 1_000, "a new position starts its clock at the fill");
        p.size_usd = 1_000;
        // As much again, 600 seconds later: held from halfway between.
        p.add_held(1_000, 1_600);
        assert_eq!(p.held_ts, 1_300);
        p.size_usd = 2_000;
        assert_eq!(p.held_secs(1_600), 300, "the add is not ten minutes old");
        assert_eq!(p.held_secs(1_900), 600);
        // A small add to a large old position moves it a little, rounded up.
        p.add_held(1, 1_900);
        assert_eq!(p.held_ts, 1_301);
        // A partial close leaves the clock alone; an empty position restarts it.
        p.size_usd = 0;
        p.add_held(500, 5_000);
        assert_eq!(p.held_ts, 5_000);
    }

    #[test]
    fn a_position_from_before_the_held_clock_reads_its_open_time() {
        let mut p = position(true, 1_000);
        p.open_ts = 100;
        assert_eq!(p.held_since(), 100);
        assert_eq!(p.held_secs(700), 600);
        p.add_held(1_000, 700);
        assert_eq!(p.held_ts, 400);
        assert_eq!(p.held_secs(50), 0, "never negative");
    }

    #[test]
    fn a_triggered_close_keeps_the_reduce_only_floor() {
        let p = position(true, 1_000);
        assert_eq!(p.trigger_close_size(0, 100).unwrap(), 1_000, "zero means all of it");
        assert_eq!(p.trigger_close_size(5_000, 100).unwrap(), 1_000);
        assert_eq!(p.trigger_close_size(100, 100).unwrap(), 100);
        assert!(p.trigger_close_size(1, 100).is_err(), "dust under the floor is refused");
        // What is left may always go, however small.
        let mut small = position(true, 1_000);
        small.closing_usd = 950;
        assert_eq!(small.trigger_close_size(0, 100).unwrap(), 50);
        assert_eq!(small.trigger_close_size(50, 100).unwrap(), 50);
        assert!(small.trigger_close_size(10, 100).is_err());
        small.closing_usd = 1_000;
        assert!(small.trigger_close_size(0, 100).is_err(), "all of it already promised");
    }

    #[test]
    fn a_close_reduces_the_side_it_was_placed_against() {
        // Selling closes a long; buying closes a short.
        assert_eq!(position(true, 500).closable_by(false, 200), 200);
        assert_eq!(position(false, 500).closable_by(true, 200), 200);
    }

    #[test]
    fn a_close_never_takes_more_than_is_there() {
        assert_eq!(position(true, 150).closable_by(false, 200), 150);
    }

    #[test]
    fn a_stale_close_does_not_touch_a_position_that_flipped() {
        // A sell placed against a long, which was liquidated and reopened short
        // in the same batch, must not reduce the short.
        assert_eq!(position(false, 500).closable_by(false, 200), 0);
        assert_eq!(position(true, 500).closable_by(true, 200), 0);
    }

    #[test]
    fn a_close_against_an_empty_position_is_nothing() {
        assert_eq!(position(true, 0).closable_by(false, 200), 0);
    }

    #[test]
    fn releasing_a_reservation_frees_the_same_size_again() {
        let mut pos = position(true, 1_000);
        pos.reserve_close(700).unwrap();
        pos.release_close(700);
        assert_eq!(pos.closable_usd(), 1_000);
        pos.reserve_close(1_000).unwrap();
    }

    #[test]
    fn a_reservation_left_over_a_liquidation_promises_nothing_more() {
        // A liquidation empties the size but not the orders resting against it.
        let mut pos = position(true, 1_000);
        pos.reserve_close(600).unwrap();
        pos.size_usd = 200;
        assert_eq!(pos.closable_usd(), 0, "saturates rather than wrapping");
        assert!(pos.reserve_close(1).is_err());
    }

    #[test]
    fn a_close_that_filled_nothing_takes_nothing() {
        assert_eq!(position(true, 500).closable_by(false, 0), 0);
    }
}
