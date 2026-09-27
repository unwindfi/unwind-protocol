use crate::aum::pool_aum_usd;
use crate::constants::*;
use crate::errors::PerpError;
use crate::instructions::batch::open_trader;
use crate::math::*;
use crate::state::*;
use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    burn, mint_to, transfer_checked, Burn, Mint, MintTo, TokenAccount, TokenInterface,
    TransferChecked,
};

#[derive(Accounts)]
pub struct ManageLiquidity<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        mut,
        seeds = [POOL_SEED, pool.usdc_mint.as_ref()],
        bump = pool.bump,
    )]
    pub pool: Box<Account<'info, Pool>>,

    #[account(address = pool.usdc_mint)]
    pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(mut, address = pool.usdc_vault)]
    pub usdc_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(mut, address = pool.lp_mint)]
    pub lp_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        mut,
        constraint = owner_usdc.mint == pool.usdc_mint,
        constraint = owner_usdc.owner == owner.key(),
    )]
    pub owner_usdc: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = owner_lp.mint == pool.lp_mint,
        constraint = owner_lp.owner == owner.key(),
    )]
    pub owner_lp: Box<InterfaceAccount<'info, TokenAccount>>,

    /// The depositor's points record: liquidity earns points while it stays.
    #[account(
        init_if_needed,
        payer = owner,
        space = 8 + Trader::INIT_SPACE,
        seeds = [TRADER_SEED, owner.key().as_ref()],
        bump,
    )]
    pub trader: Box<Account<'info, Trader>>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

/// LP shares a deposit of `net` USD (after the fee) mints.
///
/// The first deposit into a pool with no shares mints one per dollar and
/// must clear `MIN_POOL_LIQUIDITY_USD`, which keeps a first depositor from
/// starting the pool with a single share a donation could inflate. After
/// that, shares are priced against the pool's value. A pool worth nothing
/// while shares are held is refused: there is no price at which new money
/// can join shares worth zero without paying for the hole under them.
pub fn lp_out_for_deposit(net: u64, lp_supply: u64, aum_before: u64) -> Result<u64> {
    let lp_out = if lp_supply == 0 {
        require!(net >= MIN_POOL_LIQUIDITY_USD, PerpError::BelowMinimumLiquidity);
        net
    } else {
        require!(aum_before > 0, PerpError::PoolUnderwater);
        mul_div_u64(net, lp_supply as u128, aum_before as u128)?
    };
    require!(lp_out > 0, PerpError::ZeroAmount);
    Ok(lp_out)
}

pub fn add_liquidity<'info>(
    ctx: Context<'_, '_, 'info, 'info, ManageLiquidity<'info>>,
    amount_usd: u64,
    min_lp_out: u64,
) -> Result<()> {
    require!(amount_usd > 0, PerpError::ZeroAmount);
    require!(!ctx.accounts.pool.paused, PerpError::PoolPaused);

    let aum_before = pool_aum_usd(&ctx.accounts.pool, ctx.remaining_accounts)?;
    let lp_supply = ctx.accounts.lp_mint.supply;

    let fee = bps_of(amount_usd, ctx.accounts.pool.add_liquidity_fee_bps)?;
    let net = amount_usd.checked_sub(fee).ok_or(PerpError::MathOverflow)?;
    require!(net > 0, PerpError::ZeroAmount);

    // The fee is not minted against, so it accrues to the LPs already in.
    let lp_out = lp_out_for_deposit(net, lp_supply, aum_before)?;
    require!(lp_out >= min_lp_out, PerpError::SlippageExceeded);

    transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.owner_usdc.to_account_info(),
                mint: ctx.accounts.usdc_mint.to_account_info(),
                to: ctx.accounts.usdc_vault.to_account_info(),
                authority: ctx.accounts.owner.to_account_info(),
            },
        ),
        amount_usd,
        ctx.accounts.usdc_mint.decimals,
    )?;

    let pool_key = ctx.accounts.pool.key();
    let usdc_mint_key = ctx.accounts.pool.usdc_mint;
    let bump = ctx.accounts.pool.bump;
    let signer_seeds: &[&[&[u8]]] = &[&[POOL_SEED, usdc_mint_key.as_ref(), &[bump]]];

    mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            MintTo {
                mint: ctx.accounts.lp_mint.to_account_info(),
                to: ctx.accounts.owner_lp.to_account_info(),
                authority: ctx.accounts.pool.to_account_info(),
            },
            signer_seeds,
        ),
        lp_out,
    )?;

    let pool = &mut ctx.accounts.pool;
    if lp_supply == 0 {
        pool.sweep_ownerless_liquidity()?;
    }
    pool.liquidity_usd = pool
        .liquidity_usd
        .checked_add(amount_usd)
        .ok_or(PerpError::MathOverflow)?;

    // Points up to now on what was held before this deposit landed.
    let now = Clock::get()?.unix_timestamp;
    let owner = ctx.accounts.owner.key();
    let held = ctx.accounts.owner_lp.amount;
    let trader = &mut ctx.accounts.trader;
    open_trader(trader, owner, ctx.bumps.trader, now);
    trader.accrue_lp(held, now)?;
    trader.add_lp(lp_out, net)?;

    emit!(LiquidityAdded {
        pool: pool_key,
        owner: ctx.accounts.owner.key(),
        amount_usd,
        lp_minted: lp_out,
        aum_before,
    });
    Ok(())
}

pub fn remove_liquidity<'info>(
    ctx: Context<'_, '_, 'info, 'info, ManageLiquidity<'info>>,
    lp_amount: u64,
    min_usd_out: u64,
) -> Result<()> {
    require!(lp_amount > 0, PerpError::ZeroAmount);
    require!(!ctx.accounts.pool.paused, PerpError::PoolPaused);

    let aum = pool_aum_usd(&ctx.accounts.pool, ctx.remaining_accounts)?;
    let lp_supply = ctx.accounts.lp_mint.supply;
    require!(lp_supply > 0 && aum > 0, PerpError::InsufficientLiquidity);

    let gross = mul_div_u64(lp_amount, aum as u128, lp_supply as u128)?;
    let fee = bps_of(gross, ctx.accounts.pool.remove_liquidity_fee_bps)?;
    let net = gross.checked_sub(fee).ok_or(PerpError::MathOverflow)?;
    require!(net > 0, PerpError::ZeroAmount);
    require!(net >= min_usd_out, PerpError::SlippageExceeded);

    {
        let pool = &ctx.accounts.pool;
        // Withdraw only against unlocked LP capital. `locked_usd` is already
        // promised to open positions and trader collateral is not LP money at
        // all, so neither may be paid out here.
        require!(gross <= pool.free_liquidity_usd(), PerpError::InsufficientLiquidity);
        let remaining = pool.liquidity_usd.saturating_sub(gross);
        require!(remaining >= pool.locked_usd, PerpError::InsufficientLiquidity);
        if pool.locked_usd > 0 {
            require!(
                remaining >= MIN_POOL_LIQUIDITY_USD,
                PerpError::BelowMinimumLiquidity
            );
        }
    }

    let now = Clock::get()?.unix_timestamp;
    let owner = ctx.accounts.owner.key();
    let held = ctx.accounts.owner_lp.amount;
    let trader = &mut ctx.accounts.trader;
    open_trader(trader, owner, ctx.bumps.trader, now);
    trader.accrue_lp(held, now)?;
    trader.remove_lp(lp_amount);

    burn(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Burn {
                mint: ctx.accounts.lp_mint.to_account_info(),
                from: ctx.accounts.owner_lp.to_account_info(),
                authority: ctx.accounts.owner.to_account_info(),
            },
        ),
        lp_amount,
    )?;

    let usdc_mint_key = ctx.accounts.pool.usdc_mint;
    let bump = ctx.accounts.pool.bump;
    let signer_seeds: &[&[&[u8]]] = &[&[POOL_SEED, usdc_mint_key.as_ref(), &[bump]]];

    transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.usdc_vault.to_account_info(),
                mint: ctx.accounts.usdc_mint.to_account_info(),
                to: ctx.accounts.owner_usdc.to_account_info(),
                authority: ctx.accounts.pool.to_account_info(),
            },
            signer_seeds,
        ),
        net,
        ctx.accounts.usdc_mint.decimals,
    )?;

    let pool = &mut ctx.accounts.pool;
    // The withdrawal fee stays behind with the remaining LPs.
    pool.liquidity_usd = pool.liquidity_usd.saturating_sub(net);

    emit!(LiquidityRemoved {
        pool: pool.key(),
        owner: ctx.accounts.owner.key(),
        lp_burned: lp_amount,
        amount_usd: net,
        aum_before: aum,
    });
    Ok(())
}

#[event]
pub struct LiquidityAdded {
    pub pool: Pubkey,
    pub owner: Pubkey,
    pub amount_usd: u64,
    pub lp_minted: u64,
    pub aum_before: u64,
}

#[event]
pub struct LiquidityRemoved {
    pub pool: Pubkey,
    pub owner: Pubkey,
    pub lp_burned: u64,
    pub amount_usd: u64,
    pub aum_before: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    // The handlers take accounts, so these put their share arithmetic onto
    // plain numbers. `deposit` takes the fee as `add_liquidity` does and calls
    // the real `lp_out_for_deposit`; `withdraw` mirrors
    // `remove_liquidity` from `let gross = mul_div_u64(...)` to the `net > 0`
    // check; `allowed` mirrors the block that checks free liquidity. Keep
    // them in step with the handlers (and with src/proofs/liquidity.rs,
    // which proves the same lines).

    fn deposit(amount: u64, fee_bps: u16, supply: u64, aum: u64) -> Option<u64> {
        let fee = bps_of(amount, fee_bps).ok()?;
        let net = amount.checked_sub(fee)?;
        if net == 0 {
            return None;
        }
        lp_out_for_deposit(net, supply, aum).ok()
    }

    fn withdraw(lp: u64, aum: u64, supply: u64, fee_bps: u16) -> Option<(u64, u64)> {
        if supply == 0 || aum == 0 {
            return None;
        }
        let gross = mul_div_u64(lp, aum as u128, supply as u128).ok()?;
        let net = gross - bps_of(gross, fee_bps).ok()?;
        (net > 0).then_some((gross, net))
    }

    fn allowed(p: &Pool, gross: u64) -> bool {
        let remaining = p.liquidity_usd.saturating_sub(gross);
        gross <= p.free_liquidity_usd()
            && remaining >= p.locked_usd
            && (p.locked_usd == 0 || remaining >= MIN_POOL_LIQUIDITY_USD)
    }

    fn pool(liquidity_usd: u64) -> Pool {
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

    /// `pool_aum_usd` with the market PnL and the in-kind value given.
    fn aum(liquidity: u64, pnl: i64, in_kind: u64) -> u64 {
        pool(liquidity).aum_with_in_kind_usd(pnl, in_kind)
    }

    const USD: u64 = 1_000_000;
    const FEES: [u16; 4] = [0, 5, 30, 9_999];

    #[test]
    fn a_round_trip_never_returns_more_than_the_deposit_on_any_small_pool() {
        // Every pool up to 20 of liquidity, traders from 10 up to 10 down
        // (so some pools are under water), 0 to 3 of in-kind, 1 to 10 shares,
        // every deposit up to 20, and every pair of fees: the two-step round
        // trip the proofs split in half.
        for liq in 0..=20u64 {
            for pnl in -10..=10i64 {
                for in_kind in 0..=3u64 {
                    let a = aum(liq, pnl, in_kind);
                    if a == 0 {
                        continue;
                    }
                    for supply in 1..=10u64 {
                        for amount in 1..=20u64 {
                            for add_fee in FEES {
                                let Some(lp) = deposit(amount, add_fee, supply, a) else {
                                    continue;
                                };
                                let after = aum(liq + amount, pnl, in_kind);
                                if pnl <= liq as i64 {
                                    // Solvent: the LPs already in are not diluted.
                                    assert!(after as u128 * supply as u128 >= a as u128 * (supply + lp) as u128);
                                }
                                for remove_fee in FEES {
                                    if let Some((gross, net)) = withdraw(lp, after, supply + lp, remove_fee) {
                                        assert!(net <= gross && gross <= amount,
                                            "liq {liq} pnl {pnl} in_kind {in_kind} supply {supply} amount {amount}");
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn at_a_fair_price_a_round_trip_costs_exactly_the_fees() {
        // $1m pool, one share per dollar, $10k in and straight back out.
        let (liq, supply) = (1_000_000 * USD, 1_000_000 * USD);
        let lp = deposit(10_000 * USD, 0, supply, aum(liq, 0, 0)).unwrap();
        assert_eq!(lp, 10_000 * USD);
        let (gross, net) = withdraw(lp, aum(liq + 10_000 * USD, 0, 0), supply + lp, 5).unwrap();
        assert_eq!(gross, 10_000 * USD);
        assert_eq!(net, 10_000 * USD - 5 * USD, "5 bps of $10k is $5");
    }

    #[test]
    fn a_deposit_is_priced_after_trader_profit() {
        // Traders up $100k on a $1m pool: a dollar buys 1/0.9 of a share, and
        // those shares are worth the dollar, not more.
        let (liq, supply) = (1_000_000 * USD, 1_000_000 * USD);
        let before = aum(liq, 100_000 * USD as i64, 0);
        assert_eq!(before, 900_000 * USD);
        let lp = deposit(9 * USD, 0, supply, before).unwrap();
        assert_eq!(lp, 10 * USD);
        let (gross, _) = withdraw(lp, aum(liq + 9 * USD, 100_000 * USD as i64, 0), supply + lp, 0).unwrap();
        assert_eq!(gross, 9 * USD);
    }

    #[test]
    fn an_inflated_share_costs_a_depositor_less_than_one_share() {
        // The share-inflation setup: the pool is left with a single share
        // (possible while nothing is locked, since the minimum only binds
        // then), and trader losses push that share to $1. A $1.50 deposit
        // mints one share, and the depositor can take back $1.25. The loss
        // is under one share's price, and `min_lp_out` is how a depositor
        // quoting at the old price refuses it.
        let supply = 1;
        let a = USD + 1;
        let lp = deposit(3 * USD / 2, 0, supply, a).unwrap();
        assert_eq!(lp, 1);
        let (gross, _) = withdraw(lp, a + 3 * USD / 2, supply + lp, 0).unwrap();
        assert_eq!(gross, 1_250_000);
        assert!(3 * USD / 2 - gross < a / supply);
    }

    #[test]
    fn the_first_deposit_needs_the_minimum_and_mints_one_share_per_dollar() {
        assert_eq!(deposit(MIN_POOL_LIQUIDITY_USD - 1, 0, 0, 0), None);
        assert_eq!(deposit(MIN_POOL_LIQUIDITY_USD, 0, 0, 0), Some(MIN_POOL_LIQUIDITY_USD));
        // The fee counts against the minimum.
        assert_eq!(deposit(MIN_POOL_LIQUIDITY_USD, 5, 0, 0), None);
        // Shares with no value behind them are refused, not joined at one
        // share per dollar (see `a_deposit_into_an_underwater_pool_is_refused`).
        assert_eq!(deposit(2 * USD, 0, 7, 0), None);
    }

    #[test]
    fn the_first_depositor_after_the_last_exit_does_not_collect_what_was_left() {
        // Found by `the_first_depositor_gets_only_what_they_paid_for` in
        // src/proofs/liquidity.rs: the last LP out left the 5 bps fee in a
        // pool with no shares, and the next depositor owned it. It is swept
        // into the insurance fund before a first deposit lands now.
        let (liq, supply) = (1_000 * USD, 1_000 * USD);
        let (gross, net) = withdraw(supply, aum(liq, 0, 0), supply, 5).unwrap();
        assert_eq!(gross, liq);
        let mut p = pool(liq - net);
        assert_eq!(p.sweep_ownerless_liquidity().unwrap(), 500_000);
        assert_eq!((p.liquidity_usd, p.insurance_usd), (0, 500_000));
        let lp = deposit(USD, 0, 0, p.aum_usd(0)).unwrap();
        p.liquidity_usd += USD;
        let (back, _) = withdraw(lp, p.aum_usd(0), lp, 0).unwrap();
        assert_eq!(back, USD);
    }

    #[test]
    fn a_deposit_into_an_underwater_pool_is_refused() {
        // Found by `a_deposit_into_an_underwater_pool_is_not_diluted` in
        // src/proofs/liquidity.rs. Traders up 10 on no liquidity, 10 of
        // in-kind, 10 shares: AUM read 10, so a deposit of 10 minted 10
        // shares that withdrew for 5. Trader profit is taken from USDC and
        // in-kind together now, so that pool is worth nothing and refuses.
        assert_eq!(aum(0, 10, 10), 0);
        assert!(deposit(10, 0, 10, aum(0, 10, 10)).is_none());
        // With no in-kind, AUM floored to zero and the deposit minted one
        // share per dollar next to the old shares, withdrawing 499,997 of
        // 1,000,000. Refused too.
        assert!(deposit(USD, 0, USD, aum(0, 5, 0)).is_none());
        // A pool that is merely thin still takes money at a fair price.
        let lp = deposit(USD, 0, 10, aum(20, 10, 0)).unwrap();
        let (back, _) = withdraw(lp, aum(20 + USD, 10, 0), 10 + lp, 0).unwrap();
        assert!(back <= USD && back + 1 >= USD);
    }

    #[test]
    fn a_withdrawal_leaves_locked_capital_and_the_minimum() {
        let mut p = pool(1_000_000 * USD);
        p.locked_usd = 800_000 * USD;
        assert!(allowed(&p, 200_000 * USD));
        assert!(!allowed(&p, 200_000 * USD + 1));

        // While anything is locked the pool keeps at least the minimum.
        let mut p = pool(3 * USD / 2);
        p.locked_usd = 1;
        assert!(!allowed(&p, 3 * USD / 2 - 1));
        assert!(allowed(&p, USD / 2));
        // With nothing locked it can be emptied.
        p.locked_usd = 0;
        assert!(allowed(&p, 3 * USD / 2));

        // A payout that drew on the insurance fund can leave more locked
        // than there is liquidity. Then nothing can leave.
        let mut p = pool(USD);
        p.locked_usd = 2 * USD;
        assert!(!allowed(&p, 1));
    }

    #[test]
    fn the_same_shares_are_worth_less_when_traders_are_further_up() {
        let (liq, supply, lp) = (1_000_000 * USD, 1_000_000 * USD, 50_000 * USD);
        let mut last = u64::MAX;
        for pnl in [-200_000i64, -1, 0, 1, 100_000, 999_999, 1_000_000, 2_000_000] {
            let at = aum(liq, pnl * USD as i64, 0);
            let (_, net) = withdraw(lp, at, supply, 5).unwrap_or((0, 0));
            assert!(net <= last, "traders up {pnl}");
            last = net;
        }
        assert_eq!(last, 0, "a pool whose traders are owed all of it pays nothing out");
    }
}
