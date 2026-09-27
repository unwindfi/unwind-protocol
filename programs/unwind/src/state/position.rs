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
    pub _reserved: [u8; 24],
}

impl Position {
    pub fn is_open(&self) -> bool {
        self.size_usd > 0
    }

    /// Size this position could still promise to a new closing order.
    pub fn closable_usd(&self) -> u64 {
        self.size_usd.saturating_sub(self.closing_usd)
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
            _reserved: [0; 24],
        }
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
