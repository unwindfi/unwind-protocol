use crate::constants::*;
use crate::errors::PerpError;
use anchor_lang::prelude::*;

pub fn mul_div_u64(a: u64, b: u128, denom: u128) -> Result<u64> {
    require!(denom != 0, PerpError::MathOverflow);
    let r = (a as u128)
        .checked_mul(b)
        .ok_or(PerpError::MathOverflow)?
        .checked_div(denom)
        .ok_or(PerpError::MathOverflow)?;
    u64::try_from(r).map_err(|_| PerpError::MathOverflow.into())
}

pub fn bps_of(amount: u64, bps: u16) -> Result<u64> {
    mul_div_u64(amount, bps as u128, BPS)
}

/// Adds a signed delta to an unsigned balance, saturating at zero.
///
/// Used where the protocol has already guaranteed solvency by other means (a
/// trader's loss is capped at their collateral, a pool payout is capped at free
/// liquidity) and the remaining rounding dust must not panic the instruction.
pub fn apply_signed(base: u64, delta: i64) -> Result<u64> {
    if delta >= 0 {
        base.checked_add(delta as u64)
            .ok_or_else(|| PerpError::MathOverflow.into())
    } else {
        Ok(base.saturating_sub(delta.unsigned_abs()))
    }
}

/// Unrealized PnL in USD for a position, from the perspective of the trader.
///
/// `size_usd` is notional at entry, so PnL is the notional scaled by the return
/// on the underlying: size * (exit - entry) / entry.
pub fn position_pnl_usd(is_long: bool, size_usd: u64, entry_price: u64, exit_price: u64) -> Result<i64> {
    require!(entry_price > 0, PerpError::InvalidOraclePrice);
    let (hi, lo, positive) = if exit_price >= entry_price {
        (exit_price, entry_price, is_long)
    } else {
        (entry_price, exit_price, !is_long)
    };
    let delta = (hi - lo) as u128;
    let magnitude = (size_usd as u128)
        .checked_mul(delta)
        .ok_or(PerpError::MathOverflow)?
        .checked_div(entry_price as u128)
        .ok_or(PerpError::MathOverflow)?;
    let magnitude = i64::try_from(magnitude).map_err(|_| PerpError::MathOverflow)?;
    Ok(if positive { magnitude } else { -magnitude })
}

/// Funding owed by a position since it was opened, in USD.
///
/// Positive means the trader pays, negative means the trader receives.
///
/// The cumulative index is dimensionless -- USD owed per 1 USD of notional --
/// carried at `FUNDING_SCALE` precision, so the notional's own scale cancels and
/// the result comes back in `USD_SCALE` like every other USD amount.
pub fn funding_owed_usd(size_usd: u64, entry_index: i128, current_index: i128) -> Result<i64> {
    let delta = current_index
        .checked_sub(entry_index)
        .ok_or(PerpError::MathOverflow)?;
    let owed = delta
        .checked_mul(size_usd as i128)
        .ok_or(PerpError::MathOverflow)?
        .checked_div(FUNDING_SCALE)
        .ok_or(PerpError::MathOverflow)?;
    i64::try_from(owed).map_err(|_| PerpError::MathOverflow.into())
}

/// Equity of a position: collateral, marked to market, net of funding.
/// Saturates at zero -- a trader can lose their collateral but never owe more.
pub fn position_equity_usd(
    collateral_usd: u64,
    pnl_usd: i64,
    funding_owed_usd: i64,
) -> Result<u64> {
    let net = (collateral_usd as i128)
        .checked_add(pnl_usd as i128)
        .ok_or(PerpError::MathOverflow)?
        .checked_sub(funding_owed_usd as i128)
        .ok_or(PerpError::MathOverflow)?;
    if net <= 0 {
        return Ok(0);
    }
    u64::try_from(net).map_err(|_| PerpError::MathOverflow.into())
}

/// Size-weighted average entry price when adding `add_size` at `add_price` to an
/// existing `size` at `avg_price`.
pub fn blend_entry_price(size: u64, avg_price: u64, add_size: u64, add_price: u64) -> Result<u64> {
    let total = (size as u128)
        .checked_add(add_size as u128)
        .ok_or(PerpError::MathOverflow)?;
    if total == 0 {
        return Ok(0);
    }
    let weighted = (size as u128)
        .checked_mul(avg_price as u128)
        .ok_or(PerpError::MathOverflow)?
        .checked_add(
            (add_size as u128)
                .checked_mul(add_price as u128)
                .ok_or(PerpError::MathOverflow)?,
        )
        .ok_or(PerpError::MathOverflow)?;
    u64::try_from(weighted / total).map_err(|_| PerpError::MathOverflow.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    const P: u64 = 1_000_000; // $1.00 in PRICE_SCALE

    #[test]
    fn long_profits_when_price_rises() {
        // $1000 notional, entry $100, exit $110 -> +$100
        let pnl = position_pnl_usd(true, 1_000_000_000, 100 * P, 110 * P).unwrap();
        assert_eq!(pnl, 100_000_000);
    }

    #[test]
    fn short_profits_when_price_falls() {
        let pnl = position_pnl_usd(false, 1_000_000_000, 100 * P, 90 * P).unwrap();
        assert_eq!(pnl, 100_000_000);
    }

    #[test]
    fn long_loses_when_price_falls() {
        let pnl = position_pnl_usd(true, 1_000_000_000, 100 * P, 90 * P).unwrap();
        assert_eq!(pnl, -100_000_000);
    }

    #[test]
    fn equity_floors_at_zero_rather_than_going_negative() {
        // $100 collateral, -$150 pnl: the trader is wiped out, not in debt.
        assert_eq!(position_equity_usd(100_000_000, -150_000_000, 0).unwrap(), 0);
    }

    #[test]
    fn funding_index_delta_prices_per_usd_of_size() {
        // 1e-4 per USD of size (1bp), on $1000 of size -> $0.10
        let idx = FUNDING_SCALE / 10_000;
        let owed = funding_owed_usd(1_000_000_000, 0, idx).unwrap();
        assert_eq!(owed, 100_000);
    }

    #[test]
    fn blended_entry_is_size_weighted() {
        // $1000 @ $100 + $1000 @ $200 -> $150
        let p = blend_entry_price(1_000_000_000, 100 * P, 1_000_000_000, 200 * P).unwrap();
        assert_eq!(p, 150 * P);
    }

    #[test]
    fn mul_div_errors_instead_of_dividing_by_zero_or_wrapping() {
        assert!(mul_div_u64(1, 1, 0).is_err());
        // u64::MAX * u128::MAX overflows u128: an error, not a wrap.
        assert!(mul_div_u64(u64::MAX, u128::MAX, 1).is_err());
        // Fits u128 but not u64 after the divide: also an error.
        assert!(mul_div_u64(u64::MAX, 2, 1).is_err());
    }

    #[test]
    fn mul_div_rounds_down() {
        // 10 * 1 / 3 is 3.33: the third of a unit stays with the protocol.
        assert_eq!(mul_div_u64(10, 1, 3).unwrap(), 3);
        assert_eq!(mul_div_u64(2, 1, 3).unwrap(), 0);
    }

    #[test]
    fn a_full_bps_rate_is_the_whole_amount_even_at_the_top_of_u64() {
        assert_eq!(bps_of(u64::MAX, 10_000).unwrap(), u64::MAX);
        assert_eq!(bps_of(u64::MAX, 0).unwrap(), 0);
        // One bp of 9_999 units is under one unit, and rounds to nothing.
        assert_eq!(bps_of(9_999, 1).unwrap(), 0);
    }

    #[test]
    fn apply_signed_saturates_debits_and_refuses_overflowing_credits() {
        assert_eq!(apply_signed(5, -10).unwrap(), 0);
        assert_eq!(apply_signed(5, i64::MIN).unwrap(), 0);
        assert_eq!(apply_signed(5, -5).unwrap(), 0);
        assert_eq!(apply_signed(5, 3).unwrap(), 8);
        assert!(apply_signed(u64::MAX, 1).is_err());
    }

    #[test]
    fn pnl_is_zero_at_entry_and_a_zero_entry_is_refused() {
        assert_eq!(position_pnl_usd(true, 1_000_000_000, 100 * P, 100 * P).unwrap(), 0);
        assert_eq!(position_pnl_usd(false, 1_000_000_000, 100 * P, 100 * P).unwrap(), 0);
        assert!(position_pnl_usd(true, 1_000_000_000, 0, 100 * P).is_err());
    }

    #[test]
    fn a_long_at_zero_loses_exactly_its_notional() {
        assert_eq!(position_pnl_usd(true, 1_000_000_000, 100 * P, 0).unwrap(), -1_000_000_000);
    }

    #[test]
    fn a_pnl_too_large_for_i64_is_an_error() {
        // $u64::MAX notional doubling: more than i64 can hold.
        assert!(position_pnl_usd(true, u64::MAX, P, 2 * P).is_err());
    }

    #[test]
    fn funding_flips_sign_when_the_index_does() {
        let idx = FUNDING_SCALE / 10_000;
        assert_eq!(funding_owed_usd(1_000_000_000, idx, 0).unwrap(), -100_000);
        assert_eq!(funding_owed_usd(1_000_000_000, idx, idx).unwrap(), 0);
        // A third of a unit either way truncates toward zero, not toward
        // whoever pays.
        let third = FUNDING_SCALE / 3;
        assert_eq!(funding_owed_usd(1, 0, third).unwrap(), 0);
        assert_eq!(funding_owed_usd(1, third, 0).unwrap(), 0);
    }

    #[test]
    fn equity_nets_pnl_and_funding_and_never_errors_on_i64_extremes() {
        assert_eq!(position_equity_usd(100, 50, 20).unwrap(), 130);
        assert_eq!(position_equity_usd(100, -50, -20).unwrap(), 70);
        assert_eq!(position_equity_usd(0, i64::MIN, i64::MAX).unwrap(), 0);
        assert!(position_equity_usd(u64::MAX, i64::MAX, i64::MIN).is_err());
    }

    #[test]
    fn blending_nothing_changes_nothing() {
        assert_eq!(blend_entry_price(1_000, 100 * P, 0, 999 * P).unwrap(), 100 * P);
        assert_eq!(blend_entry_price(0, 999 * P, 1_000, 100 * P).unwrap(), 100 * P);
        assert_eq!(blend_entry_price(0, 100 * P, 0, 200 * P).unwrap(), 0);
    }

    #[test]
    fn a_blend_stays_between_the_two_prices_at_extreme_sizes() {
        let p = blend_entry_price(u64::MAX, 100 * P, 1, 200 * P).unwrap();
        assert!((100 * P..=200 * P).contains(&p));
        let p = blend_entry_price(1, 100 * P, u64::MAX, 200 * P).unwrap();
        assert!((100 * P..=200 * P).contains(&p));
    }
}
