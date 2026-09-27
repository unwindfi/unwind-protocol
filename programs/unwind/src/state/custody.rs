use crate::constants::*;
use crate::errors::PerpError;
use crate::oracle::read_price;
use anchor_lang::prelude::*;

/// Most tokens, besides USDC, that backing may be held in.
pub const MAX_CUSTODIES: usize = 4;

/// A token backing may be held in, other than USDC.
///
/// The same shape as a custody in Jupiter's JLP pool: a vault per token,
/// priced by oracle, so a backer who holds SOL posts SOL and it stays SOL.
/// Nothing is swapped on the way in. Where JLP pays a winning SOL long in SOL,
/// this program settles every market in USDC, so the one place a custody's
/// tokens change hands is when the backing behind a market has to cover a loss:
/// then tokens worth that loss, at the oracle, move from the backers to the
/// LPs, and the LPs hold them from there (`sync_backing`).
#[account]
#[derive(InitSpace)]
pub struct Custody {
    pub bump: u8,
    pub vault_bump: u8,
    pub pool: Pubkey,
    pub mint: Pubkey,
    pub vault: Pubkey,
    pub decimals: u8,
    /// Position in every `BackingBook::amounts`, fixed at creation.
    pub index: u8,
    /// Counted at a dollar rather than read from an oracle.
    pub is_stable: bool,
    /// Pyth feed pricing the token in USD. Unused for a stable.
    pub feed_id: [u8; 32],
    pub max_price_age_sec: u32,
    pub max_conf_bps: u16,
    /// How much of this token's value counts toward a market's loss budget.
    ///
    /// Value and budget are not the same thing for a token that can fall. A
    /// backer's share is priced at the oracle, which is what the tokens are
    /// worth; the budget they buy is the value the market can still rely on
    /// after a move, which for SOL is less. A stable counts in full.
    pub budget_weight_bps: u16,
    /// Held for backers, across every market.
    pub backing_amount: u64,
    /// Owned by the LPs: what backing has paid them for losses they covered.
    /// Part of the pool's AUM at the oracle price.
    pub lp_amount: u64,
    pub _reserved: [u8; 32],
}

impl Custody {
    /// USD per whole token, `PRICE_SCALE`.
    pub fn price(&self, price_ai: &AccountInfo, receiver: &Pubkey) -> Result<u64> {
        if self.is_stable {
            return Ok(PRICE_SCALE as u64);
        }
        Ok(read_price(
            price_ai,
            receiver,
            &self.feed_id,
            self.max_price_age_sec,
            self.max_conf_bps,
        )?
        .price)
    }
}

/// What one market's backing holds in each custody, in tokens.
///
/// USDC backing stays where it always was, in `Market::backing_usd` and the
/// pool's vault, so settlement never has to know this account exists.
#[account]
#[derive(InitSpace)]
pub struct BackingBook {
    pub bump: u8,
    pub market: Pubkey,
    /// Tokens held for this market's backers, by `Custody::index`.
    pub amounts: [u64; MAX_CUSTODIES],
    /// USD of tokens already handed to the LPs for losses they covered.
    pub reimbursed_usd: u64,
    /// LP-borne loss at the moment tokens first arrived. Losses the LPs took
    /// before then are not this backing's to repay: a backer arriving after a
    /// drawdown buys into the market as it is, the same as with USDC.
    pub baseline_usd: i64,
    pub _reserved: [u8; 32],
}

/// USD, `USD_SCALE`, of `amount` base units at `price`.
pub fn token_value_usd(amount: u64, price: u64, decimals: u8) -> Result<u64> {
    let v = (amount as u128)
        .checked_mul(price as u128)
        .ok_or(PerpError::MathOverflow)?
        / 10u128.pow(decimals as u32);
    u64::try_from(v).map_err(|_| PerpError::MathOverflow.into())
}

/// Base units worth `usd` at `price`, rounded up.
pub fn tokens_for_usd(usd: u64, price: u64, decimals: u8) -> Result<u64> {
    require!(price > 0, PerpError::InvalidOraclePrice);
    let num = (usd as u128)
        .checked_mul(10u128.pow(decimals as u32))
        .ok_or(PerpError::MathOverflow)?;
    let v = num.div_ceil(price as u128);
    u64::try_from(v).map_err(|_| PerpError::MathOverflow.into())
}

/// One custody's figures for a market, as `sync` and the pricing need them.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Held {
    pub amount: u64,
    pub price: u64,
    pub decimals: u8,
    pub is_stable: bool,
    pub weight_bps: u16,
}

impl Held {
    pub fn value(&self) -> Result<u64> {
        token_value_usd(self.amount, self.price, self.decimals)
    }
    pub fn weighted(&self) -> Result<u64> {
        Ok(((self.value()? as u128) * (self.weight_bps as u128) / BPS) as u64)
    }
}

pub fn in_kind_value(held: &[Held]) -> Result<u64> {
    held.iter().try_fold(0u64, |acc, h| {
        acc.checked_add(h.value()?).ok_or(PerpError::MathOverflow.into())
    })
}

pub fn in_kind_weighted(held: &[Held]) -> Result<u64> {
    held.iter().try_fold(0u64, |acc, h| {
        acc.checked_add(h.weighted()?).ok_or(PerpError::MathOverflow.into())
    })
}

/// Shares `usd` of fresh backing buys in a pot worth `pot_usd`.
///
/// A pot worth nothing while shares are still held refuses the deposit. There
/// is no price at which new money can join old shares worth zero without
/// either handing the old holders part of it or cancelling their claim on a
/// later restore, and both would take from somebody. The market takes backing
/// again once a gain restores some.
pub fn shares_for(usd: u64, total_shares: u64, pot_usd: u64) -> Result<u64> {
    if total_shares == 0 {
        return Ok(usd);
    }
    require!(pot_usd > 0, PerpError::BackingWipedOut);
    u64::try_from((usd as u128) * (total_shares as u128) / (pot_usd as u128))
        .map_err(|_| PerpError::MathOverflow.into())
}

/// Loss the LPs have paid for this market out of their own capital: what it
/// has cost the pool, less what its USDC backing already absorbed.
pub fn lp_borne_usd(net_loss_usd: i64, backing_drawn_usd: u64) -> i64 {
    // Drawn past i64::MAX (about $9.2 trillion) saturates rather than wrapping
    // negative, which would have shown the LPs as bearing everything.
    let drawn = i64::try_from(backing_drawn_usd).unwrap_or(i64::MAX);
    net_loss_usd.saturating_sub(drawn).max(0)
}

/// What `sync` should do.
#[derive(Debug, PartialEq)]
pub enum Sync {
    Nothing,
    /// Hand the LPs tokens worth this much, stables first; `taken[i]` tokens
    /// from each custody.
    PayLps { usd: u64, taken: [u64; MAX_CUSTODIES] },
    /// The market has earned back what the LPs were paid for; return this much
    /// USD to the backers out of LP liquidity.
    Refund { usd: u64 },
}

/// Reconciles in-kind backing against what the LPs have covered.
///
/// Settlement only ever touches USDC, so a loss past a market's USDC backing
/// is paid by the LPs on the spot. This is the other half: the in-kind backing
/// behind that market then owes the LPs the same amount, in tokens at the
/// oracle. If the market later wins it back, the LPs return it, in USDC, and
/// keep the tokens they were paid, which were worth exactly that when paid.
pub fn plan_sync(
    lp_borne: i64,
    baseline: i64,
    reimbursed: u64,
    held: &[Held],
    lp_liquidity: u64,
) -> Result<Sync> {
    let owed = lp_borne.saturating_sub(baseline).max(0) as u64;
    let available = reimbursed.saturating_add(in_kind_value(held)?);
    let target = owed.min(available);

    if target > reimbursed {
        let mut need = target - reimbursed;
        let mut paid = 0u64;
        let mut taken = [0u64; MAX_CUSTODIES];
        // Stables first: they are worth what they are worth, and the backers
        // keep the part of their pot that might recover.
        let mut order: Vec<usize> = (0..held.len()).collect();
        order.sort_by_key(|&i| !held[i].is_stable);
        for i in order {
            if need == 0 {
                break;
            }
            let h = &held[i];
            let value = h.value()?;
            if value == 0 {
                continue;
            }
            let (tokens, usd) = if value <= need {
                (h.amount, value)
            } else {
                (tokens_for_usd(need, h.price, h.decimals)?.min(h.amount), need)
            };
            taken[i] = tokens;
            paid += usd;
            need -= usd;
        }
        if paid == 0 {
            return Ok(Sync::Nothing);
        }
        return Ok(Sync::PayLps { usd: paid, taken });
    }
    if target < reimbursed {
        let usd = (reimbursed - target).min(lp_liquidity);
        if usd > 0 {
            return Ok(Sync::Refund { usd });
        }
    }
    Ok(Sync::Nothing)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SOL: u64 = 150_000_000; // $150
    fn sol(amount: u64) -> Held {
        Held { amount, price: SOL, decimals: 9, is_stable: false, weight_bps: 8_000 }
    }
    fn usdt(amount: u64) -> Held {
        Held { amount, price: 1_000_000, decimals: 6, is_stable: true, weight_bps: 10_000 }
    }

    #[test]
    fn values_a_token_at_its_price_and_weights_it_for_the_budget() {
        let h = sol(2_000_000_000); // 2 SOL
        assert_eq!(h.value().unwrap(), 300_000_000); // $300
        assert_eq!(h.weighted().unwrap(), 240_000_000); // counts $240
    }

    #[test]
    fn tokens_for_a_dollar_amount_round_up() {
        // $1 of SOL at $150 is 6_666_666.67 lamports: the LPs get the 67th.
        assert_eq!(tokens_for_usd(1_000_000, SOL, 9).unwrap(), 6_666_667);
    }

    #[test]
    fn nothing_moves_while_usdc_backing_covered_everything() {
        let held = [usdt(0), sol(1_000_000_000), usdt(0), usdt(0)];
        assert_eq!(plan_sync(lp_borne_usd(500, 500), 0, 0, &held, 0).unwrap(), Sync::Nothing);
    }

    #[test]
    fn the_lps_are_paid_stables_first_then_sol() {
        let held = [sol(1_000_000_000), usdt(50_000_000), usdt(0), usdt(0)]; // $150 + $50
        // LPs covered $80: $50 of USDT, then $30 of SOL.
        match plan_sync(80_000_000, 0, 0, &held, 0).unwrap() {
            Sync::PayLps { usd, taken } => {
                assert_eq!(usd, 80_000_000);
                assert_eq!(taken[1], 50_000_000);
                assert_eq!(taken[0], 200_000_000); // 0.2 SOL
            }
            s => panic!("{s:?}"),
        }
    }

    #[test]
    fn a_loss_past_the_whole_pot_takes_all_of_it_and_no_more() {
        let held = [sol(1_000_000_000), usdt(0), usdt(0), usdt(0)];
        match plan_sync(1_000_000_000, 0, 0, &held, 0).unwrap() {
            Sync::PayLps { usd, taken } => {
                assert_eq!(usd, 150_000_000);
                assert_eq!(taken[0], 1_000_000_000);
            }
            s => panic!("{s:?}"),
        }
    }

    #[test]
    fn losses_from_before_the_backing_arrived_are_not_its_to_repay() {
        let held = [sol(1_000_000_000), usdt(0), usdt(0), usdt(0)];
        // The LPs were already $100 down when the SOL was posted.
        assert_eq!(plan_sync(100_000_000, 100_000_000, 0, &held, 0).unwrap(), Sync::Nothing);
        match plan_sync(130_000_000, 100_000_000, 0, &held, 0).unwrap() {
            Sync::PayLps { usd, .. } => assert_eq!(usd, 30_000_000),
            s => panic!("{s:?}"),
        }
    }

    #[test]
    fn a_recovery_refunds_the_backers_in_usdc() {
        let held = [sol(0), usdt(0), usdt(0), usdt(0)];
        // LPs were paid $80; the market has since won $50 of it back.
        assert_eq!(
            plan_sync(30_000_000, 0, 80_000_000, &held, 1_000_000_000).unwrap(),
            Sync::Refund { usd: 50_000_000 }
        );
        // Never more than the LPs actually have.
        assert_eq!(
            plan_sync(0, 0, 80_000_000, &held, 10_000_000).unwrap(),
            Sync::Refund { usd: 10_000_000 }
        );
    }

    #[test]
    fn a_later_backer_buys_in_at_the_pot_value() {
        // $300 pot, 100 shares: $150 more buys 50.
        assert_eq!(shares_for(150, 100, 300).unwrap(), 50);
        assert_eq!(shares_for(150, 0, 0).unwrap(), 150);
    }

    #[test]
    fn a_token_value_rounds_down_and_tokens_for_it_round_up() {
        // 1 lamport at $150 is $0.00000015: nothing, in six decimals.
        assert_eq!(token_value_usd(1, SOL, 9).unwrap(), 0);
        // Whatever $1 buys in SOL is worth at least $1 at the same price.
        let t = tokens_for_usd(1_000_000, SOL, 9).unwrap();
        assert!(token_value_usd(t, SOL, 9).unwrap() >= 1_000_000);
        assert!(token_value_usd(t - 1, SOL, 9).unwrap() < 1_000_000);
    }

    #[test]
    fn a_zero_price_is_refused_and_an_overflow_is_an_error() {
        assert!(tokens_for_usd(1, 0, 9).is_err());
        assert!(token_value_usd(u64::MAX, u64::MAX, 0).is_err());
        assert!(tokens_for_usd(u64::MAX, 1, 9).is_err());
    }

    #[test]
    fn fresh_backing_never_dilutes_the_backers_already_in() {
        // $301 pot, 100 shares: $100 more buys 33 shares (33.2 rounded down),
        // and the pot per share rises from 3.01 to 3.0226 rather than falling.
        let s = shares_for(100, 100, 301).unwrap();
        assert_eq!(s, 33);
        assert!(401 * 100 >= 301 * (100 + s as u128));
    }

    #[test]
    fn a_first_backer_gets_a_share_per_dollar() {
        assert_eq!(shares_for(1_234, 0, 0).unwrap(), 1_234);
        assert_eq!(shares_for(1_234, 0, 5_000).unwrap(), 1_234);
    }

    #[test]
    fn lp_borne_loss_is_never_negative_or_above_the_net_loss() {
        assert_eq!(lp_borne_usd(100, 30), 70);
        assert_eq!(lp_borne_usd(100, 300), 0);
        assert_eq!(lp_borne_usd(-100, 0), 0);
        assert_eq!(lp_borne_usd(i64::MIN, 0), 0);
        assert_eq!(lp_borne_usd(i64::MAX, 0), i64::MAX);
    }

    #[test]
    fn a_partial_take_moves_exactly_what_is_owed() {
        // $150 of SOL, $1 owed: the USD booked is $1 and the SOL moved is
        // worth at least that.
        let held = [sol(1_000_000_000), usdt(0), usdt(0), usdt(0)];
        match plan_sync(1_000_000, 0, 0, &held, 0).unwrap() {
            Sync::PayLps { usd, taken } => {
                assert_eq!(usd, 1_000_000);
                assert!(taken[0] <= 1_000_000_000);
                assert!(token_value_usd(taken[0], SOL, 9).unwrap() >= usd);
            }
            s => panic!("{s:?}"),
        }
    }

    #[test]
    fn a_refund_never_takes_the_reimbursed_figure_below_what_is_owed() {
        let held = [sol(0), usdt(0), usdt(0), usdt(0)];
        match plan_sync(60, 0, 100, &held, u64::MAX).unwrap() {
            Sync::Refund { usd } => assert_eq!(100 - usd, 60),
            s => panic!("{s:?}"),
        }
    }
}
