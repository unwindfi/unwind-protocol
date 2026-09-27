use anchor_lang::prelude::*;

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
    pub _reserved: [u8; 32],
}

impl Order {
    pub fn kind(&self) -> Result<OrderKind> {
        OrderKind::from_u8(self.kind)
    }

    /// Whether `price` is on the firing side of the trigger.
    pub fn is_triggered(&self, price: u64) -> bool {
        if self.trigger_above { price >= self.trigger_price } else { price <= self.trigger_price }
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
            created_ts: 0, expiry_ts: 0, _reserved: [0; 32],
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
}
