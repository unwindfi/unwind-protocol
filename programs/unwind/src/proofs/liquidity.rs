//! LP deposits and withdrawals: what a deposit mints, what a withdrawal pays,
//! and what either does to the LPs who stay. Also the in-kind valuation that
//! AUM adds on top of USDC liquidity.
//!
//! `add_liquidity` and `remove_liquidity` are Anchor handlers, so their share
//! arithmetic cannot be called on its own. The helpers below repeat it line
//! for line, built from the program's own `mul_div_u64`, `bps_of`,
//! `Pool::aum_usd` and `Pool::free_liquidity_usd`, and each one names the
//! lines of `instructions/liquidity.rs` it mirrors. A change to those lines
//! has to be carried here too. AUM is what `pool_aum_usd` returns,
//! `pool.aum_usd(pnl) + in_kind`, with the market PnL and the custody value
//! taken as unknowns rather than read from accounts.
//!
//! How the round trip is split. A deposit followed by a withdrawal is two
//! divisions by symbolic values in a row, and the checker does not finish
//! that chain in five minutes even at four bits. So each harness takes one
//! division and states its result cross-multiplied, which is exact: the
//! shares a deposit mints satisfy `lp * aum <= net * supply`, and a
//! withdrawal pays `gross` with `gross * supply <= lp * aum`. The composed
//! claims (a round trip returns at most the deposit, the share price never
//! falls) are then stated on those products, which is the same claim without
//! the second floor. The unit tests in `instructions/liquidity.rs` run the
//! actual two-step round trip, exhaustively over small pools and at
//! realistic sizes.
//!
//! The bounds: where a harness divides, balances, in-kind value, share
//! supplies and deposits are 0 to 31 and PnL is -32 to 31 (so it can
//! exceed liquidity and put the pool under water), and fee rates come from a
//! fixed list (see `any_fee_bps`). The properties are about rounding
//! direction and the order of operations, which small values exercise fully
//! (remainders, exact divisions, zero, an underwater pool). Harnesses that
//! only add, subtract or compare run over the full range of their types, and
//! say so.

use crate::constants::*;
use crate::errors::PerpError;
use crate::instructions::liquidity::lp_out_for_deposit;
use crate::math::{bps_of, mul_div_u64};
use crate::state::custody::token_value_usd;
use crate::state::Pool;
use anchor_lang::prelude::{Pubkey, Result};

// Stand-ins for the text of an error, as in `budget.rs` and `settlement.rs`.
// `require!` builds an Anchor error carrying the variant's name and message
// as `String`s, and the checker would unroll that formatting on every
// failing path. No harness here reads an error's text, only whether a call
// failed, so both builders return empty text.
fn no_name(_: &PerpError) -> String {
    String::new()
}

fn no_message(_: &PerpError, _: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
    Ok(())
}

/// 0 to 31. Every harness that divides by a symbolic value draws from here:
/// a share division, a fee division and the products of three unknowns that
/// state the result take minutes at eight bits.
fn small() -> u64 {
    (kani::any::<u8>() & 0x1f) as u64
}

fn small_positive() -> u64 {
    let v = small();
    kani::assume(v > 0);
    v
}

/// -32 to 31, enough to put a pool of up to 31 under water.
fn small_pnl() -> i64 {
    (kani::any::<i8>() >> 2) as i64
}

/// A fee rate from a fixed list: none, one bp, the documented 5 bps remove
/// fee, rates that leave a remainder, and 100 percent. A fully symbolic rate
/// adds one more unknown to every product.
fn any_fee_bps() -> u16 {
    const RATES: [u16; 7] = [0, 1, 5, 30, 3_333, 9_999, 10_000];
    let i: usize = kani::any();
    kani::assume(i < RATES.len());
    RATES[i]
}

/// A pool with every field zero except its USDC liquidity.
fn pool_with(liquidity_usd: u64) -> Pool {
    Pool {
        bump: 0,
        vault_bump: 0,
        lp_mint_bump: 0,
        authority: Pubkey::default(),
        pending_authority: Pubkey::default(),
        usdc_mint: Pubkey::default(),
        usdc_vault: Pubkey::default(),
        lp_mint: Pubkey::default(),
        num_markets: 0,
        liquidity_usd,
        locked_usd: 0,
        trader_collateral_usd: 0,
        protocol_fees_usd: 0,
        add_liquidity_fee_bps: 0,
        remove_liquidity_fee_bps: 0,
        protocol_fee_share_bps: 0,
        max_utilization_bps: 0,
        insurance_usd: 0,
        insurance_fee_share_bps: 0,
        pyth_receiver: Pubkey::default(),
        escrow_usd: 0,
        chain_fee_destination: Pubkey::default(),
        chain_fees_usd: 0,
        rewards_usd: 0,
        paused: false,
        backing_usd: 0,
        num_custodies: 0,
        markets_with_oi: 0,
        _reserved: [0; 3],
    }
}

/// `pool_aum_usd` with its two account reads replaced by their results, in
/// u128 so the full-range harnesses need no overflow assumption.
fn aum(pool: &Pool, pnl: i64, in_kind: u64) -> u128 {
    pool.aum_with_in_kind_usd(pnl, in_kind) as u128
}

/// Shares minted for a deposit, as `(net, lp_out)`: the fee as
/// `add_liquidity` takes it, then the real `lp_out_for_deposit`.
fn shares_for_deposit(amount: u64, fee_bps: u16, lp_supply: u64, aum_before: u64) -> Result<(u64, u64)> {
    let fee = bps_of(amount, fee_bps)?;
    let net = amount.checked_sub(fee).unwrap();
    if net == 0 {
        return Err(PerpError::ZeroAmount.into());
    }
    Ok((net, lp_out_for_deposit(net, lp_supply, aum_before)?))
}

/// What burning `lp_amount` pays, as `(gross, net)`. Mirrors
/// `remove_liquidity`, from `let gross = mul_div_u64(...)` to the
/// `net > 0` check.
fn value_of_withdrawal(lp_amount: u64, aum: u64, lp_supply: u64, fee_bps: u16) -> Result<(u64, u64)> {
    let gross = mul_div_u64(lp_amount, aum as u128, lp_supply as u128)?;
    let fee = bps_of(gross, fee_bps)?;
    let net = gross.checked_sub(fee).unwrap();
    if net == 0 {
        return Err(PerpError::ZeroAmount.into());
    }
    Ok((gross, net))
}

/// The liquidity checks on a withdrawal. Mirrors the block in
/// `remove_liquidity` that starts `let pool = &ctx.accounts.pool;`.
fn withdrawal_allowed(pool: &Pool, gross: u64) -> bool {
    if gross > pool.free_liquidity_usd() {
        return false;
    }
    let remaining = pool.liquidity_usd.saturating_sub(gross);
    if remaining < pool.locked_usd {
        return false;
    }
    if pool.locked_usd > 0 && remaining < MIN_POOL_LIQUIDITY_USD {
        return false;
    }
    true
}

/// A pool with shares outstanding and a positive AUM, a deposit into it, and
/// the shares that deposit mints: the state every deposit harness starts
/// from. Returns `(pool after, pnl, in_kind, supply, amount, net, lp,
/// aum_before)`, or `None` where `add_liquidity` would refuse the deposit.
fn a_deposit(fee_bps: u16) -> Option<(Pool, i64, u64, u64, u64, u64, u64, u64)> {
    let mut pool = pool_with(small());
    let pnl = small_pnl();
    let in_kind = small();
    let supply = small_positive();
    let amount = small_positive();

    let aum_before = aum(&pool, pnl, in_kind) as u64;
    kani::assume(aum_before > 0);
    let (net, lp) = shares_for_deposit(amount, fee_bps, supply, aum_before).ok()?;
    // Mirrors `pool.liquidity_usd = pool.liquidity_usd.checked_add(amount_usd)`.
    pool.liquidity_usd += amount;
    Some((pool, pnl, in_kind, supply, amount, net, lp, aum_before))
}

// ------------------------------------------------------------ deposits

/// A deposit's shares are rounded down, and by less than one share: the
/// shares cost at most what the depositor paid after the fee at the
/// pre-deposit price, and one more share would have cost more. Rounding
/// goes to the LPs already in, never against them, and never takes more
/// than one share from the depositor.
///
/// Bounds: liquidity, in-kind value, supply and deposit 0 to 31, PnL from
/// -32 to 31, add fee from `any_fee_bps`.
#[kani::proof]
#[kani::stub(PerpError::name, no_name)]
#[kani::stub(<PerpError as core::fmt::Display>::fmt, no_message)]
#[kani::solver(cadical)]
fn a_deposit_mints_every_whole_share_it_paid_for_and_no_more() {
    let fee = any_fee_bps();
    let Some((_, _, _, supply, amount, net, lp, aum_before)) = a_deposit(fee) else {
        return;
    };
    assert!(net <= amount);
    assert!(lp * aum_before <= net * supply);
    assert!((lp + 1) * aum_before > net * supply);
}

/// A deposit followed at once by a withdrawal of the shares it minted never
/// returns more than was deposited, whatever the fee, whatever traders are
/// up or down (including a pool under water in USDC), and whatever the
/// in-kind holdings, as long as shares already exist. Stated as: the new
/// shares, priced at the AUM and supply after the deposit, are worth at
/// most the deposit (`lp * aum_after <= amount * (supply + lp)`); with
/// `a_withdrawal_pays_at_most_its_share` that bounds what
/// `remove_liquidity` pays for them. This is the round trip a depositor
/// would use to pull value out of the LPs already in.
///
/// Bounds: liquidity, in-kind value, supply and deposit 0 to 31, PnL from
/// -32 to 31, add fee from `any_fee_bps`.
#[kani::proof]
#[kani::stub(PerpError::name, no_name)]
#[kani::stub(<PerpError as core::fmt::Display>::fmt, no_message)]
#[kani::solver(cadical)]
fn a_deposit_then_withdrawal_returns_at_most_the_deposit() {
    let fee = any_fee_bps();
    let Some((pool, pnl, in_kind, supply, amount, _, lp, _)) = a_deposit(fee) else {
        return;
    };
    let aum_after = aum(&pool, pnl, in_kind) as u64;
    assert!(lp * aum_after <= amount * (supply + lp));
}

/// A deposit never lowers the price of a share: AUM per share after is at
/// least AUM per share before, compared by cross-multiplication. The LPs
/// already in cannot be diluted by a deposit, and the add fee, which mints
/// nothing, goes to them. Holds while USDC liquidity covers what traders
/// are up; see `a_deposit_into_an_underwater_pool_is_not_diluted` for the
/// case where it does not.
///
/// Bounds: liquidity, in-kind value, supply and deposit 0 to 31, PnL from
/// -32 to 31 but at most the liquidity, add fee from `any_fee_bps`.
#[kani::proof]
#[kani::stub(PerpError::name, no_name)]
#[kani::stub(<PerpError as core::fmt::Display>::fmt, no_message)]
#[kani::solver(cadical)]
fn a_deposit_never_lowers_the_share_price() {
    let fee = any_fee_bps();
    let Some((pool, pnl, in_kind, supply, amount, _, lp, aum_before)) = a_deposit(fee) else {
        return;
    };
    kani::assume(pnl <= (pool.liquidity_usd - amount) as i64);
    let aum_after = aum(&pool, pnl, in_kind) as u64;
    assert!(aum_after * supply >= aum_before * (supply + lp));
}

/// With no fees, a depositor's new shares are worth more than the deposit
/// less one share's price (AUM over supply, before the deposit). So the
/// most a pool of few, expensive shares (the setup of a share inflation
/// attack) can take from a depositor is one of those shares, and
/// `min_lp_out` lets the depositor refuse even that. Stated
/// cross-multiplied: `lp * aum_after * supply + aum_before * (supply + lp) >
/// amount * supply * (supply + lp)`.
///
/// Bounds: liquidity, in-kind value, supply and deposit 0 to 31, PnL from
/// -32 to 31 but at most the liquidity, both fees zero.
#[kani::proof]
#[kani::stub(PerpError::name, no_name)]
#[kani::stub(<PerpError as core::fmt::Display>::fmt, no_message)]
#[kani::solver(cadical)]
fn a_depositor_loses_less_than_one_share_to_rounding() {
    let Some((pool, pnl, in_kind, supply, amount, _, lp, aum_before)) = a_deposit(0) else {
        return;
    };
    kani::assume(pnl <= (pool.liquidity_usd - amount) as i64);
    let aum_after = aum(&pool, pnl, in_kind) as u64;
    assert!(lp * aum_after * supply + aum_before * (supply + lp) > amount * supply * (supply + lp));
}

/// DISABLED: fails. When USDC liquidity does not cover what traders are up,
/// A deposit into a pool whose traders are up more than its USDC is either
/// refused or priced fairly: its new shares are worth what was paid.
///
/// This failed before the fix. `Pool::aum_usd` floored `liquidity - pnl` at
/// zero before `pool_aum_usd` added the in-kind value, so AUM counted the
/// in-kind tokens in full and ignored the part of the trader profit they had
/// to cover. Liquidity 0, traders up 10, in-kind 10, supply 10: AUM read 10,
/// a deposit of 10 minted 10 shares, and they withdrew for 5. With no
/// in-kind, AUM floored to zero and the deposit minted one share per dollar
/// beside the old shares (liquidity 0, traders up 5, supply 1,000,000: a
/// 1,000,000 deposit withdrew for 499,997). Profit is now taken from USDC
/// and in-kind together, and a pool worth nothing with shares out refuses.
///
/// Bounds: as `a_depositor_loses_less_than_one_share_to_rounding`, without
/// the solvency assumption.
#[kani::proof]
#[kani::stub(PerpError::name, no_name)]
#[kani::stub(<PerpError as core::fmt::Display>::fmt, no_message)]
#[kani::solver(cadical)]
fn a_deposit_into_an_underwater_pool_is_not_diluted() {
    let Some((pool, pnl, in_kind, supply, amount, _, lp, aum_before)) = a_deposit(0) else {
        return;
    };
    let aum_after = aum(&pool, pnl, in_kind) as u64;
    assert!(lp * aum_after * supply + aum_before * (supply + lp) > amount * supply * (supply + lp));
}

/// A first deposit into a pool with no shares gets back at most what it paid:
/// USDC left behind with no owner is swept to the insurance fund first.
///
/// This failed before the fix: the last LP out left the withdrawal fee in
/// `liquidity_usd` with no shares to own it, and the next deposit took the
/// first-depositor path and owned all of it (supply 0, liquidity 5, a
/// deposit of 1,000,000 withdrew for 1,000,005). In-kind tokens left with no
/// shares are not swept (the fund is kept in USD), so they are held at zero
/// here; they can only arrive through a backing sync while LPs are in.
///
/// Bounds: leftover liquidity 0 to 31, traders flat, deposit 1,000,000 to
/// 1,000,031, no fees.
#[kani::proof]
#[kani::stub(PerpError::name, no_name)]
#[kani::stub(<PerpError as core::fmt::Display>::fmt, no_message)]
#[kani::solver(cadical)]
fn the_first_depositor_gets_only_what_they_paid_for() {
    let mut pool = pool_with(small());
    let in_kind = 0;
    let amount = MIN_POOL_LIQUIDITY_USD + small();

    pool.sweep_ownerless_liquidity().unwrap();
    let aum_before = aum(&pool, 0, in_kind) as u64;
    let (_, lp) = shares_for_deposit(amount, 0, 0, aum_before).unwrap();
    pool.liquidity_usd += amount;
    let aum_after = aum(&pool, 0, in_kind) as u64;
    let (gross, _) = value_of_withdrawal(lp, aum_after, lp, 0).unwrap();
    assert!(gross <= amount);
}

/// The first deposit, into a pool with no shares or no value, mints exactly
/// one share per dollar paid after the fee, and refuses anything under
/// `MIN_POOL_LIQUIDITY_USD`. The minimum is what keeps a first depositor
/// from starting the pool with a single share whose price a donation can
/// then inflate.
///
/// Bounds: deposit from 990,000 to 1,055,535 (2^16 values around the
/// minimum, so at the low rates the net lands on both sides of it), add fee
/// from `any_fee_bps`, supply and AUM any u64 with at least one of them
/// zero. A full-width deposit runs past ten minutes.
#[kani::proof]
#[kani::stub(PerpError::name, no_name)]
#[kani::stub(<PerpError as core::fmt::Display>::fmt, no_message)]
#[kani::solver(cadical)]
fn the_first_deposit_mints_one_share_per_dollar_above_the_minimum() {
    let amount = 990_000 + kani::any::<u16>() as u64;
    let fee_bps = any_fee_bps();
    let supply: u64 = kani::any();
    let aum_before: u64 = kani::any();
    kani::assume(supply == 0 || aum_before == 0);

    // Shares outstanding in a pool worth nothing: refused outright, never
    // joined at one share per dollar (`a_deposit_into_an_underwater_pool_is_not_diluted`).
    if supply > 0 {
        assert!(shares_for_deposit(amount, fee_bps, supply, aum_before).is_err());
        return;
    }
    match shares_for_deposit(amount, fee_bps, supply, aum_before) {
        Ok((net, lp)) => {
            assert!(net <= amount);
            assert_eq!(lp, net);
            assert!(lp >= MIN_POOL_LIQUIDITY_USD);
        }
        Err(_) => {
            let net = amount - bps_of(amount, fee_bps).unwrap();
            assert!(net < MIN_POOL_LIQUIDITY_USD);
        }
    }
}

/// A deposit raises AUM by at most the deposit, never lowers it, and by
/// exactly the deposit while USDC liquidity covers what traders are up. The
/// deposit harnesses above lean on the first two; the third is what fails
/// under water (see `a_deposit_into_an_underwater_pool_is_not_diluted`).
///
/// Bounds: full `u64` liquidity, deposit and in-kind value (liquidity plus
/// deposit not overflowing, as `checked_add` in `add_liquidity` requires),
/// full `i64` PnL.
#[kani::proof]
fn a_deposit_raises_aum_by_at_most_itself() {
    let mut pool = pool_with(kani::any());
    let pnl: i64 = kani::any();
    let in_kind: u64 = kani::any();
    let amount: u64 = kani::any();
    kani::assume(pool.liquidity_usd.checked_add(amount).is_some());

    let before = aum(&pool, pnl, in_kind);
    let solvent = pnl <= 0 || pnl as u64 <= pool.liquidity_usd;
    pool.liquidity_usd += amount;
    let after = aum(&pool, pnl, in_kind);
    assert!(after >= before);
    assert!(after <= before + amount as u128);
    if solvent {
        assert!(after == before + amount as u128 || pool.aum_with_in_kind_usd(pnl, in_kind) == u64::MAX);
    }
}

// ------------------------------------------------------------ withdrawals

/// A withdrawal pays at most its pro rata share of AUM, and withdrawing
/// every share pays exactly AUM, so the last LP out is not shorted either.
/// This is the `gross` of `remove_liquidity`, before the fee. That the fee
/// only lowers it is `mul_div_by_at_most_one_never_grows` in `money.rs`
/// (`bps_of` of at most 10,000 bps never exceeds the amount), and that the
/// share is short by less than one unit is `mul_div_is_floor_and_never_panics`.
/// With the fee list folded in, this harness ran from three minutes to past
/// eight depending on load.
///
/// Bounds: AUM, supply and shares burned 1 to 31, no fee.
#[kani::proof]
#[kani::stub(PerpError::name, no_name)]
#[kani::stub(<PerpError as core::fmt::Display>::fmt, no_message)]
#[kani::solver(cadical)]
fn a_withdrawal_pays_at_most_its_share() {
    let a = small_positive();
    let supply = small_positive();
    let lp = small_positive();
    kani::assume(lp <= supply);

    let (gross, net) = value_of_withdrawal(lp, a, supply, 0).unwrap_or((0, 0));
    assert_eq!(net, gross);
    assert!(gross * supply <= lp * a);
    if lp == supply {
        assert_eq!(gross, a);
    }
}

/// A withdrawal lowers AUM by at most what it pays out, and by exactly that
/// while USDC liquidity covers what traders are up. Together with
/// `a_withdrawal_pays_at_most_its_share` this is why an exit never lowers
/// the price of the shares left behind: the pool gives up at most the
/// exiting shares' pro rata value, and the fee stays behind.
///
/// Bounds: full `u64` liquidity, payout and in-kind value, payout at most
/// liquidity (the allowed-withdrawal harness below shows it always is),
/// full `i64` PnL.
#[kani::proof]
fn a_withdrawal_lowers_aum_by_at_most_what_it_pays() {
    let mut pool = pool_with(kani::any());
    let pnl: i64 = kani::any();
    let in_kind: u64 = kani::any();
    let net: u64 = kani::any();
    kani::assume(net <= pool.liquidity_usd);

    let before = aum(&pool, pnl, in_kind);
    pool.liquidity_usd = pool.liquidity_usd.saturating_sub(net);
    let after = aum(&pool, pnl, in_kind);
    assert!(after <= before);
    assert!(after + net as u128 >= before);
    let solvent = pnl <= 0 || pnl as u64 <= pool.liquidity_usd;
    // Exact unless the value before was clamped at u64::MAX.
    if solvent && before < u64::MAX as u128 {
        assert_eq!(after + net as u128, before);
    }
}

/// A withdrawal never lowers the price of the shares left behind: AUM per
/// share after is at least AUM per share before. This is what stops one
/// LP's exit from being paid out of the others.
///
/// The payout is taken as unknown, constrained only by what
/// `a_withdrawal_pays_at_most_its_share` proves of `remove_liquidity`'s
/// arithmetic (`gross * supply <= lp * aum`, `net <= gross`). Running the
/// division here as well took over eight minutes.
///
/// Bounds: liquidity, locked, in-kind value, supply and shares burned 0 to
/// 31, PnL -32 to 31, gross and net below 2^11 (wider than any payout the
/// premise allows at these sizes).
#[kani::proof]
#[kani::solver(cadical)]
fn a_withdrawal_never_lowers_the_share_price() {
    let mut pool = pool_with(small());
    pool.locked_usd = small();
    let pnl = small_pnl();
    let in_kind = small();
    let supply = small_positive();
    let lp = small();
    kani::assume(lp <= supply);
    // Wider than any payout the premise allows, which is at most AUM (94).
    let gross = (kani::any::<u16>() & 0x7ff) as u64;
    let net = (kani::any::<u16>() & 0x7ff) as u64;

    let aum_before = aum(&pool, pnl, in_kind) as u64;
    kani::assume(gross * supply <= lp * aum_before);
    kani::assume(net <= gross);
    if !withdrawal_allowed(&pool, gross) {
        return;
    }
    // Mirrors `pool.liquidity_usd = pool.liquidity_usd.saturating_sub(net)`.
    pool.liquidity_usd = pool.liquidity_usd.saturating_sub(net);
    let aum_after = aum(&pool, pnl, in_kind) as u64;
    assert!(aum_after * supply >= aum_before * (supply - lp));
}

/// A withdrawal the checks allow is paid entirely out of free LP liquidity:
/// what is paid never exceeds `liquidity_usd`, so trader collateral, order
/// escrow, backing, the insurance fund and accrued fees in the same vault
/// are never touched; locked capital stays in place with the fee on top;
/// and while anything is locked the pool keeps at least
/// `MIN_POOL_LIQUIDITY_USD`. This holds even when a payout that drew on the
/// insurance fund has left `locked_usd` above `liquidity_usd`: free
/// liquidity is then zero and nothing can be withdrawn.
///
/// Bounds: full `u64` liquidity, locked and gross, any net up to gross.
#[kani::proof]
fn an_allowed_withdrawal_leaves_locked_capital_and_other_money_in_place() {
    let mut pool = pool_with(kani::any());
    pool.locked_usd = kani::any();
    let gross: u64 = kani::any();
    let net: u64 = kani::any();
    kani::assume(net <= gross);

    if !withdrawal_allowed(&pool, gross) {
        return;
    }
    assert!(pool.locked_usd <= pool.liquidity_usd);
    let before = pool.liquidity_usd;
    assert!(net <= before);
    pool.liquidity_usd = pool.liquidity_usd.saturating_sub(net);
    assert_eq!(pool.liquidity_usd, before - net);
    assert!(pool.liquidity_usd - pool.locked_usd >= gross - net);
    if pool.locked_usd > 0 {
        assert!(pool.liquidity_usd >= MIN_POOL_LIQUIDITY_USD);
    }
}

/// The same shares withdraw for no more when traders are further up. A
/// withdrawal is priced after trader profit, so an LP cannot exit ahead of
/// a loss the pool has already taken and leave it to the LPs who stay.
///
/// Bounds: liquidity, in-kind value, supply and shares burned 0 to 31,
/// both PnLs from -32 to 31, remove fee from `any_fee_bps`.
#[kani::proof]
#[kani::stub(PerpError::name, no_name)]
#[kani::stub(<PerpError as core::fmt::Display>::fmt, no_message)]
#[kani::solver(cadical)]
fn a_withdrawal_is_worth_less_when_traders_are_further_up() {
    let pool = pool_with(small());
    let in_kind = small();
    let supply = small_positive();
    let lp = small_positive();
    kani::assume(lp <= supply);
    let fee = any_fee_bps();
    let a = small_pnl();
    let b = small_pnl();
    kani::assume(a <= b);

    let at_a = mul_div_u64(lp, aum(&pool, a, in_kind), supply as u128).unwrap();
    let at_b = mul_div_u64(lp, aum(&pool, b, in_kind), supply as u128).unwrap();
    assert!(at_b <= at_a);
    assert!(at_b - bps_of(at_b, fee).unwrap() <= at_a - bps_of(at_a, fee).unwrap());
}

// ------------------------------------------------------------ in-kind AUM

/// `lp_in_kind_usd` values each custody with `token_value_usd`, and that
/// value is the holding times the price, rounded down: never more than the
/// tokens are worth at the oracle, and short by less than one USD unit. It
/// never rises when the price falls. AUM therefore never counts more
/// in-kind value than the LPs hold, so shares are never sold against
/// tokens that are not there.
///
/// Bounds: holdings and prices 0 to 31, every decimals from 0 to 9 (each
/// checked with the power of ten as a constant, as in `money.rs`).
#[kani::proof]
#[kani::stub(PerpError::name, no_name)]
#[kani::stub(<PerpError as core::fmt::Display>::fmt, no_message)]
#[kani::unwind(11)]
#[kani::solver(cadical)]
fn in_kind_value_is_holdings_times_price_rounded_down() {
    let amount = small();
    let price = small();
    let lower_price = small();
    kani::assume(lower_price <= price);
    for d in 0..=9u8 {
        let scale = 10u64.pow(d as u32);
        let v = token_value_usd(amount, price, d).unwrap();
        let exact = amount * price;
        assert!(v * scale <= exact);
        assert!(exact < (v + 1) * scale);
        assert!(token_value_usd(amount, lower_price, d).unwrap() <= v);
    }
}
