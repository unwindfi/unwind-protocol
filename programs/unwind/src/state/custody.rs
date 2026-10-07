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
    /// Taken off `lp_amount` by withdrawal claims and not yet pulled by their
    /// owners (`LpTokenClaim`). Still in the vault, no longer the pool's.
    pub lp_owed_amount: u64,
    /// Owned by the insurance fund: what backing has repaid it in kind for
    /// losses it covered. The LPs buy these for USDC at the oracle as free
    /// liquidity allows (`backing::sync`), which puts the USDC back in the
    /// fund. Not part of the LPs' AUM. Was eight bytes of `_reserved`.
    pub insurance_amount: u64,
    pub _reserved: [u8; 16],
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
    /// The part of `reimbursed_usd` that went on to the insurance fund: the
    /// LPs took the tokens and paid the fund the same in USDC. Refunded to
    /// the backers like the rest of `reimbursed_usd` if the market wins it
    /// back. Was eight bytes of `_reserved`.
    pub fund_reimbursed_usd: u64,
    pub _reserved: [u8; 24],
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
    plan_toward(owed.min(available), reimbursed, held, lp_liquidity)
}

/// What `sync` should do, the insurance fund included.
#[derive(Debug, PartialEq)]
pub struct FundSync {
    /// Tokens worth `fund_in_kind_usd`, `fund_taken[i]` from each custody,
    /// move from the backing to the insurance fund (`Custody::insurance_amount`).
    pub fund_in_kind_usd: u64,
    pub fund_taken: [u64; MAX_CUSTODIES],
    /// USDC the LPs pass from their liquidity to the fund, out of tokens they
    /// were handed for a loss they no longer bear (a gain has since come to
    /// them). It counts as the tokens repaying the fund.
    pub fund_usdc: u64,
    /// The most of `BackingBook::reimbursed_usd` that is the fund's, after
    /// this sync; a refund takes the fund's part down to it first (see
    /// `fund_after_refund`).
    pub fund_target: u64,
    /// What happens between the backing and the LPs once the fund is paid.
    pub sync: Sync,
}

/// `plan_sync` with the insurance fund in the order the docs give it.
///
/// A loss runs through the USDC backing, then LP liquidity, then the fund,
/// and in-kind backing ranks with the backing, ahead of both. Of what the
/// tokens owe past the USDC backing, the fund is repaid first and the LPs
/// after it: the reverse of the order those two were drawn. Before this the
/// whole of it went to the LPs, who were repaid for what the fund paid.
///
/// `fund_unrepaid` is what the fund has paid toward this market and not been
/// repaid (`Market::insurance_drawn_usd`); `fund_reimbursed` is the part of
/// `reimbursed` that went to the fund and could still be refunded
/// (`BackingBook::fund_reimbursed_usd`). Their sum is the fund's claim, and
/// it is met in tokens, which the fund then holds.
pub fn plan_sync_with_fund(
    lp_borne: i64,
    baseline: i64,
    reimbursed: u64,
    fund_reimbursed: u64,
    fund_unrepaid: u64,
    held: &[Held],
    lp_liquidity: u64,
) -> Result<FundSync> {
    let owed = lp_borne.saturating_sub(baseline).max(0) as u64;
    let available = reimbursed.saturating_add(in_kind_value(held)?);
    let target = owed.min(available);
    let fund_target = fund_reimbursed.saturating_add(fund_unrepaid).min(target);
    let claim = fund_target.saturating_sub(fund_reimbursed);

    // The fund first, in tokens, stables first.
    let (fund_in_kind_usd, fund_taken) = take_usd(claim, held)?;
    let rest: Vec<Held> = held
        .iter()
        .enumerate()
        .map(|(i, h)| Held { amount: h.amount - fund_taken[i], ..*h })
        .collect();
    let unpaid = claim - fund_in_kind_usd;

    // What the LPs hold past their own part (all of it but the fund's) goes
    // back: to the fund while it is still owed, then to the backers. Their
    // own part is what they are paid up to, in tokens.
    let lps_hold = reimbursed as i128 - fund_reimbursed as i128;
    let lps_part = target as i128 - fund_target as i128;
    let excess = (lps_hold - lps_part).max(0) as u64;
    let fund_usdc = excess.min(unpaid).min(lp_liquidity);
    let sync = plan_toward(
        target - unpaid + fund_usdc,
        reimbursed + fund_in_kind_usd,
        &rest,
        lp_liquidity - fund_usdc,
    )?;
    Ok(FundSync { fund_in_kind_usd, fund_taken, fund_usdc, fund_target, sync })
}

/// Where `BackingBook::fund_reimbursed_usd` lands after a refund of
/// `refunded` to the backers: the refund takes the fund's part above
/// `target` first, and never takes it below `target`.
pub fn fund_after_refund(fund_reimbursed: u64, target: u64, refunded: u64) -> u64 {
    if fund_reimbursed <= target {
        return fund_reimbursed;
    }
    fund_reimbursed - (fund_reimbursed - target).min(refunded)
}

/// Tokens worth `usd` out of `held`, stables first: they are worth what they
/// are worth, and the backers keep the part of their pot that might recover.
/// Returns what was taken, which is less than `usd` only when `held` is.
fn take_usd(usd: u64, held: &[Held]) -> Result<(u64, [u64; MAX_CUSTODIES])> {
    let mut need = usd;
    let mut paid = 0u64;
    let mut taken = [0u64; MAX_CUSTODIES];
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
    Ok((paid, taken))
}

/// Pays or refunds until the backing has reimbursed `target` in all.
fn plan_toward(target: u64, reimbursed: u64, held: &[Held], lp_liquidity: u64) -> Result<Sync> {
    if target > reimbursed {
        let (paid, taken) = take_usd(target - reimbursed, held)?;
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

/// Fund-held tokens the LPs buy at the oracle with `free_liquidity` USDC:
/// `(tokens, usd)`, the USD rounded down so the LPs never pay past what the
/// tokens are worth.
///
/// Settlement pays only in USDC, so tokens the fund was repaid in are worth
/// nothing to it until they are sold. The LPs are the buyer the pool has:
/// at the oracle it costs them nothing, and the USDC that pays a winner
/// once the LPs' runs out (`Pool::pay_out`) is back in the fund.
pub fn fund_tokens_bought(held: &Held, free_liquidity: u64) -> Result<(u64, u64)> {
    let value = held.value()?;
    if value == 0 || free_liquidity == 0 {
        return Ok((0, 0));
    }
    let tokens = if value <= free_liquidity {
        held.amount
    } else {
        // Rounded down: the tokens free liquidity pays for in full.
        let t = (free_liquidity as u128)
            .checked_mul(10u128.pow(held.decimals as u32))
            .ok_or(PerpError::MathOverflow)?
            / (held.price as u128);
        (t as u64).min(held.amount)
    };
    let usd = token_value_usd(tokens, held.price, held.decimals)?;
    Ok((tokens, usd))
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

    const D: u64 = 1_000_000; // $1

    fn plan(owed: i64, reimbursed: u64, fund_reimbursed: u64, unrepaid: u64, held: &[Held], liq: u64) -> FundSync {
        plan_sync_with_fund(owed, 0, reimbursed, fund_reimbursed, unrepaid, held, liq).unwrap()
    }

    #[test]
    fn the_fund_is_repaid_in_kind_before_the_lps() {
        // The fuzzer's case: $4,001 owed past the USDC backing, $4,998 of it
        // paid by the fund, $10,000 of tokens, no LP liquidity left. All of
        // what the tokens owe goes to the fund and none to the LPs.
        let held = [sol(0), usdt(10_000 * D)];
        let p = plan(4_001 * D as i64, 0, 0, 4_998 * D, &held, 0);
        assert_eq!(p.fund_in_kind_usd, 4_001 * D);
        assert_eq!(p.fund_taken, [0, 4_001 * D, 0, 0]);
        assert_eq!((p.fund_usdc, p.fund_target), (0, 4_001 * D));
        assert_eq!(p.sync, Sync::Nothing, "nothing is left for the LPs");
    }

    #[test]
    fn the_lps_are_repaid_what_is_left_after_the_fund() {
        let held = [usdt(1_000 * D)];
        let p = plan(300 * D as i64, 0, 0, 100 * D, &held, 0);
        assert_eq!((p.fund_in_kind_usd, p.fund_target), (100 * D, 100 * D));
        assert!(matches!(p.sync, Sync::PayLps { usd, taken } if usd == 200 * D && taken[0] == 200 * D));
        // A second sync finds nothing more to do.
        let held = [usdt(700 * D)];
        let p = plan(300 * D as i64, 300 * D, 100 * D, 0, &held, 0);
        assert_eq!((p.fund_in_kind_usd, p.fund_usdc, p.sync), (0, 0, Sync::Nothing));
    }

    #[test]
    fn the_fund_takes_what_there_is_when_the_tokens_fall_short() {
        let held = [usdt(60 * D)];
        let p = plan(300 * D as i64, 0, 0, 100 * D, &held, 1_000 * D);
        assert_eq!(p.fund_in_kind_usd, 60 * D);
        assert_eq!(p.sync, Sync::Nothing);
    }

    #[test]
    fn a_recovery_refunds_the_funds_part_like_the_rest() {
        let held = [usdt(0)];
        let p = plan(0, 100 * D, 100 * D, 0, &held, 1_000 * D);
        assert_eq!((p.fund_in_kind_usd, p.fund_usdc, p.fund_target), (0, 0, 0));
        assert_eq!(p.sync, Sync::Refund { usd: 100 * D });
        assert_eq!(fund_after_refund(100 * D, 0, 100 * D), 0);
        // A refund liquidity cuts short takes the fund's part down first.
        assert_eq!(fund_after_refund(100 * D, 0, 30 * D), 70 * D);
        assert_eq!(fund_after_refund(100 * D, 80 * D, 30 * D), 80 * D);
        // A part at or under its target is left alone.
        assert_eq!(fund_after_refund(50 * D, 80 * D, 30 * D), 50 * D);
    }

    #[test]
    fn lps_repaid_past_their_own_loss_pass_the_excess_to_the_fund() {
        // The LPs were handed $50 for a loss of their own. Since then the fund
        // has paid $100 and a gain to the LPs has brought the market's loss
        // past the USDC to $90: the LPs are net up, the fund down $100, and
        // there are no tokens left to repay it with.
        let held = [usdt(0)];
        let p = plan(90 * D as i64, 50 * D, 0, 100 * D, &held, 1_000 * D);
        assert_eq!(p.fund_usdc, 50 * D, "the $50 the LPs hold for nothing goes to the fund");
        assert_eq!(p.sync, Sync::Nothing);
        // Past what the fund is owed, the rest goes back to the backers.
        let p = plan(10 * D as i64, 50 * D, 0, 5 * D, &held, 1_000 * D);
        assert_eq!(p.fund_usdc, 5 * D);
        assert_eq!(p.sync, Sync::Refund { usd: 40 * D }, "the LPs keep their own $5");
        // Only as far as liquidity reaches.
        let p = plan(10 * D as i64, 50 * D, 0, 5 * D, &held, 3 * D);
        assert_eq!((p.fund_usdc, p.sync), (3 * D, Sync::Nothing));
    }

    #[test]
    fn with_no_fund_drawn_it_is_the_old_sync() {
        let held = [sol(1_000_000_000), usdt(50 * D)];
        for owed in [-5i64, 0, 30, 80, 200, 1_000] {
            for reimbursed in [0u64, 40, 120, 500] {
                for liq in [0u64, 10, 1_000_000] {
                    let (owed, reimbursed) = (owed * D as i64, reimbursed * D);
                    let p = plan(owed, reimbursed, 0, 0, &held, liq * D);
                    assert_eq!((p.fund_in_kind_usd, p.fund_usdc), (0, 0));
                    assert_eq!(p.sync, plan_sync(owed, 0, reimbursed, &held, liq * D).unwrap());
                }
            }
        }
    }

    #[test]
    fn the_lps_never_keep_more_than_their_own_loss() {
        // Over a grid: after the plan is carried out, what the LPs hold net of
        // what went to the fund is at most their own part of the loss past
        // the USDC backing (owed, less the fund's claim), unless liquidity ran
        // out before a refund was whole.
        for tokens in [0u64, 40, 200] {
            let held = [usdt(tokens * D)];
            for owed in [0u64, 50, 150, 400] {
                for reimbursed in [0u64, 60, 150] {
                    for fund_r in [0u64, 30, 60] {
                        if fund_r > reimbursed {
                            continue;
                        }
                        for unrepaid in [0u64, 40, 300] {
                            for liq in [0u64, 25, 10_000] {
                                let d = |x: u64| x * D;
                                let p = plan(d(owed) as i64, d(reimbursed), d(fund_r), d(unrepaid), &held, d(liq));
                                assert!(p.fund_in_kind_usd + p.fund_usdc <= d(unrepaid));
                                let mut r = d(reimbursed) + p.fund_in_kind_usd;
                                let mut f = d(fund_r) + p.fund_in_kind_usd + p.fund_usdc;
                                let mut refunded = 0;
                                match p.sync {
                                    Sync::PayLps { usd, .. } => {
                                        assert!(p.fund_in_kind_usd + usd <= d(tokens));
                                        r += usd
                                    }
                                    Sync::Refund { usd } => {
                                        refunded = usd;
                                        r -= usd;
                                        f = fund_after_refund(f, p.fund_target, usd);
                                    }
                                    Sync::Nothing => {}
                                }
                                assert!(refunded + p.fund_usdc <= d(liq));
                                assert!(f <= r, "the fund's part is part of what was reimbursed");
                                let lp = r - f;
                                let own = d(owed).saturating_sub(d(fund_r) + d(unrepaid));
                                let short = refunded + p.fund_usdc == d(liq);
                                assert!(lp <= own || short,
                                    "tokens {tokens} owed {owed} r {reimbursed} f {fund_r} u {unrepaid} liq {liq}: LPs keep {lp}, own {own}");
                            }
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn the_lps_buy_the_funds_tokens_at_the_oracle() {
        // $1,500 of SOL in the fund.
        let h = sol(10_000_000_000);
        assert_eq!(fund_tokens_bought(&h, 0).unwrap(), (0, 0));
        // All of it when liquidity covers it.
        assert_eq!(fund_tokens_bought(&h, 2_000 * D).unwrap(), (10_000_000_000, 1_500 * D));
        // Otherwise what the liquidity pays for in full, never more than it.
        let (t, usd) = fund_tokens_bought(&h, 100 * D + 7).unwrap();
        assert!(usd <= 100 * D + 7);
        assert!(token_value_usd(t, SOL, 9).unwrap() == usd);
        assert!(usd + 1 >= 100 * D, "within a unit of what liquidity can pay: {usd}");
    }

    #[test]
    fn the_budget_counts_every_custody_at_its_weight() {
        let held = [sol(2_000_000_000), usdt(50_000_000), usdt(0), usdt(0)];
        // 2 SOL at $150 weighted 80% is $240; $50 of USDT at 100% is $50.
        assert_eq!(in_kind_value(&held).unwrap(), 350_000_000);
        assert_eq!(in_kind_weighted(&held).unwrap(), 290_000_000);
        assert_eq!(in_kind_weighted(&[]).unwrap(), 0);
        let zero_weight = Held { weight_bps: 0, ..sol(1_000_000_000) };
        assert_eq!(zero_weight.weighted().unwrap(), 0, "an unweighted custody counts nothing");
    }

    #[test]
    fn a_weighted_sum_past_u64_is_refused() {
        let big = Held { amount: u64::MAX, price: 1_000_000, decimals: 6, is_stable: true, weight_bps: 10_000 };
        assert_eq!(in_kind_weighted(&[big, big]).unwrap_err(), PerpError::MathOverflow.into());
        assert_eq!(in_kind_value(&[big, big]).unwrap_err(), PerpError::MathOverflow.into());
    }

    #[test]
    fn a_stable_that_covers_the_debt_leaves_the_volatile_token_alone() {
        let held = [sol(1_000_000_000), usdt(200_000_000), usdt(0), usdt(0)];
        match plan_sync(50_000_000, 0, 0, &held, 0).unwrap() {
            Sync::PayLps { usd, taken } => {
                assert_eq!(usd, 50_000_000);
                assert_eq!(taken, [0, 50_000_000, 0, 0]);
            }
            s => panic!("{s:?}"),
        }
    }

    #[test]
    fn a_refund_waits_for_the_pool_to_hold_something() {
        // The market won back what the LPs were reimbursed, but the pool has
        // no free liquidity to return it from yet.
        let held = [sol(0), usdt(0), usdt(0), usdt(0)];
        assert_eq!(plan_sync(0, 0, 100, &held, 0).unwrap(), Sync::Nothing);
        assert_eq!(plan_sync(0, 0, 100, &held, 40).unwrap(), Sync::Refund { usd: 40 });
    }

    #[test]
    fn shares_refuse_a_pot_worth_nothing_while_shares_are_held() {
        assert_eq!(shares_for(100, 0, 0).unwrap(), 100, "the first deposit is one share per dollar");
        assert_eq!(shares_for(100, 10, 0).unwrap_err(), PerpError::BackingWipedOut.into());
        assert_eq!(shares_for(100, 10, 1_000).unwrap(), 1, "rounded down, against the depositor");
        assert_eq!(shares_for(u64::MAX, u64::MAX, 1).unwrap_err(), PerpError::MathOverflow.into());
    }

    #[test]
    fn tokens_for_usd_refuses_a_zero_price() {
        assert_eq!(tokens_for_usd(1, 0, 6).unwrap_err(), PerpError::InvalidOraclePrice.into());
        assert_eq!(tokens_for_usd(0, 1, 6).unwrap(), 0);
    }
}
