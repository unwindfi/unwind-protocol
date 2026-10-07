use anchor_lang::prelude::*;

use super::market::PRICE_FACTOR_ONE;
use crate::errors::PerpError;

/// What a trigger does when it fires.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u8)]
pub enum OrderKind {
    /// Close an existing position — a take-profit or stop-loss.
    Close = 0,
    /// Open one — a limit order.
    Open = 1,
}

impl OrderKind {
    pub fn from_u8(v: u8) -> Result<Self> {
        match v {
            0 => Ok(OrderKind::Close),
            1 => Ok(OrderKind::Open),
            _ => Err(crate::errors::PerpError::InvalidParameter.into()),
        }
    }
}

/// A price trigger, executed by whoever is watching.
///
/// Take-profit, stop-loss and limit orders are the same object: a price, a
/// direction to cross it from, and what to do on the other side. Splitting them
/// into separate accounts would triple the surface for one behaviour.
#[account]
#[derive(InitSpace)]
pub struct Order {
    pub bump: u8,
    pub owner: Pubkey,
    pub market: Pubkey,
    /// Caller-chosen, so one trader can hold several orders on one market — a
    /// take-profit and a stop-loss are the ordinary case.
    pub slot: u8,
    pub kind: u8,
    pub is_long: bool,

    /// Notional to open, or to close. Zero on a close order means the whole
    /// position, which is what a stop-loss almost always is.
    pub size_usd: u64,
    /// Collateral escrowed for an open order; zero for a close.
    pub collateral_usd: u64,

    pub trigger_price: u64,
    /// Fire when the index is at or above `trigger_price`; otherwise at or
    /// below. A take-profit on a long is `true`, its stop-loss `false`.
    pub trigger_above: bool,

    pub created_ts: i64,
    /// Zero never expires.
    pub expiry_ts: i64,
    /// `Market::price_factor` when the order was placed, so a corporate action
    /// rebases `trigger_price` the way it rebases an entry (see `trigger_at`).
    /// Zero on an order placed before this was recorded, read as
    /// `PRICE_FACTOR_ONE`. Carved from the first 16 bytes of `_reserved`.
    pub trigger_factor: u128,
    pub _reserved: [u8; 16],
}

impl Order {
    pub fn kind(&self) -> Result<OrderKind> {
        OrderKind::from_u8(self.kind)
    }

    /// Whether `price` is on the firing side of the trigger.
    pub fn is_triggered(&self, price: u64) -> bool {
        if self.trigger_above { price >= self.trigger_price } else { price <= self.trigger_price }
    }

    /// `trigger_price` in the terms of `market_factor`. A stop placed at $180
    /// before a 4-for-1 split fires at $45, the same economic level.
    pub fn trigger_at(&self, market_factor: u128) -> Result<u64> {
        let placed = if self.trigger_factor == 0 { PRICE_FACTOR_ONE } else { self.trigger_factor };
        if placed == market_factor {
            return Ok(self.trigger_price);
        }
        let p = (self.trigger_price as u128)
            .checked_mul(market_factor)
            .ok_or(PerpError::MathOverflow)?
            / placed;
        Ok(u64::try_from(p).map_err(|_| PerpError::MathOverflow)?.max(1))
    }

    /// `is_triggered` against the trigger rebased to `market_factor`.
    pub fn is_triggered_at(&self, price: u64, market_factor: u128) -> Result<bool> {
        let t = self.trigger_at(market_factor)?;
        Ok(if self.trigger_above { price >= t } else { price <= t })
    }

    pub fn is_expired(&self, now: i64) -> bool {
        self.expiry_ts != 0 && now >= self.expiry_ts
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn order(trigger: u64, above: bool) -> Order {
        Order {
            bump: 0, owner: Pubkey::default(), market: Pubkey::default(),
            slot: 0, kind: OrderKind::Close as u8, is_long: true,
            size_usd: 0, collateral_usd: 0,
            trigger_price: trigger, trigger_above: above,
            created_ts: 0, expiry_ts: 0, trigger_factor: 0, _reserved: [0; 16],
        }
    }

    #[test]
    fn a_take_profit_fires_at_or_above_its_price() {
        let o = order(120_000_000, true);
        assert!(!o.is_triggered(119_999_999));
        assert!(o.is_triggered(120_000_000), "at the trigger counts as through it");
        assert!(o.is_triggered(130_000_000));
    }

    #[test]
    fn a_stop_loss_fires_at_or_below_its_price() {
        let o = order(90_000_000, false);
        assert!(!o.is_triggered(90_000_001));
        assert!(o.is_triggered(90_000_000));
        assert!(o.is_triggered(80_000_000));
    }

    #[test]
    fn an_order_without_an_expiry_never_expires() {
        let o = order(100, true);
        assert!(!o.is_expired(i64::MAX));
    }

    #[test]
    fn an_expiry_is_inclusive() {
        let mut o = order(100, true);
        o.expiry_ts = 1_000;
        assert!(!o.is_expired(999));
        assert!(o.is_expired(1_000));
    }

    #[test]
    fn a_kind_reads_back_from_its_byte_and_refuses_any_other() {
        assert_eq!(OrderKind::from_u8(0).unwrap(), OrderKind::Close);
        assert_eq!(OrderKind::from_u8(1).unwrap(), OrderKind::Open);
        for v in [2u8, 7, u8::MAX] {
            assert_eq!(OrderKind::from_u8(v).unwrap_err(), PerpError::InvalidParameter.into());
        }
        let mut o = order(1, true);
        assert_eq!(o.kind().unwrap(), OrderKind::Close);
        o.kind = OrderKind::Open as u8;
        assert_eq!(o.kind().unwrap(), OrderKind::Open);
        o.kind = 9;
        assert!(o.kind().is_err(), "a stored kind nobody wrote is refused, not guessed");
    }

    #[test]
    fn a_trigger_rebased_past_u64_is_refused() {
        // A reverse split so large the rebased trigger no longer fits.
        let mut o = order(u64::MAX, true);
        o.trigger_factor = PRICE_FACTOR_ONE;
        assert_eq!(o.trigger_at(PRICE_FACTOR_ONE * 2).unwrap_err(), PerpError::MathOverflow.into());
        // And one whose product overflows u128 before the division.
        assert_eq!(o.trigger_at(u128::MAX).unwrap_err(), PerpError::MathOverflow.into());
    }

    #[test]
    fn a_trigger_rebased_toward_zero_stays_at_one_unit() {
        let mut o = order(3, false);
        o.trigger_factor = PRICE_FACTOR_ONE * 100;
        assert_eq!(o.trigger_at(PRICE_FACTOR_ONE).unwrap(), 1, "never a zero trigger");
    }
}
