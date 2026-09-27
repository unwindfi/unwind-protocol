use crate::constants::*;
use crate::errors::PerpError;
use crate::instructions::trade::{
    apply_settlement_to_pool, fee_cuts_usd, payable_usd, settle, take_fee_cuts, Settlement,
};
use crate::math::*;
use crate::instructions::batch::market_price;
use crate::state::*;
use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};

#[derive(Accounts)]
pub struct Liquidate<'info> {
    pub liquidator: Signer<'info>,

    #[account(
        mut,
        seeds = [POOL_SEED, pool.usdc_mint.as_ref()],
        bump = pool.bump,
    )]
    pub pool: Box<Account<'info, Pool>>,

    #[account(
        mut,
        has_one = pool @ PerpError::MarketPoolMismatch,
        seeds = [MARKET_SEED, pool.key().as_ref(), market.feed_id.as_ref()],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, Market>>,

    #[account(
        mut,
        has_one = market @ PerpError::MarketPoolMismatch,
        has_one = owner @ PerpError::Unauthorized,
        seeds = [POSITION_SEED, market.key().as_ref(), owner.key().as_ref()],
        bump = position.bump,
    )]
    pub position: Box<Account<'info, Position>>,

    /// CHECK: The position's owner, checked against `position.owner` by the
    /// `has_one` above. Passed explicitly rather than read back out of
    /// `position` so the seeds constraint does not reference the very account
    /// it is validating.
    pub owner: UncheckedAccount<'info>,

    /// CHECK: Validated by `market_price`. For a Pyth market that is ownership
    /// by the Pyth receiver, the discriminator, `Full` Wormhole verification, a
    /// matching feed id and staleness; for an observed market it is the
    /// market's own seasoned observation account.
    pub price_update: UncheckedAccount<'info>,

    #[account(address = pool.usdc_mint)]
    pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(mut, address = pool.usdc_vault)]
    pub usdc_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = owner_usdc.mint == pool.usdc_mint,
        constraint = owner_usdc.owner == owner.key() @ PerpError::Unauthorized,
    )]
    pub owner_usdc: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = liquidator_usdc.mint == pool.usdc_mint,
        constraint = liquidator_usdc.owner == liquidator.key(),
    )]
    pub liquidator_usdc: Box<InterfaceAccount<'info, TokenAccount>>,

    pub token_program: Interface<'info, TokenInterface>,
}

/// Closes an undercollateralized position at the index price.
///
/// Permissionless, and deliberately still callable while the market is paused:
/// a pause stops new risk, it must not trap a position that is already through
/// its maintenance margin and bleeding into LP capital.
pub fn liquidate(ctx: Context<Liquidate>) -> Result<()> {
    require!(ctx.accounts.position.is_open(), PerpError::PositionEmpty);

    let clock = Clock::get()?;
    let utilization = ctx.accounts.pool.utilization_bps();
    ctx.accounts
        .market
        .accrue_funding(clock.unix_timestamp, utilization)?;

    let oracle = market_price(
        &ctx.accounts.price_update.to_account_info(),
        &ctx.accounts.pool,
        &ctx.accounts.market,
        &ctx.accounts.market.key(),
    )?;

    ctx.accounts.market.accept_price(&oracle)?;

    let is_long = ctx.accounts.position.is_long;
    let close_size = ctx.accounts.position.size_usd;
    let fill = ctx.accounts.market.fill_price(&oracle, !is_long)?;

    let settlement = settle(
        &ctx.accounts.position,
        &ctx.accounts.market,
        close_size,
        fill,
    )?;

    let Liquidation {
        fee,
        bounty,
        to_owner,
        payout,
    } = liquidation(&ctx.accounts.pool, &ctx.accounts.market, &settlement, close_size)?;

    let position_key = ctx.accounts.position.key();
    let market_key = ctx.accounts.market.key();
    let owner = ctx.accounts.position.owner;

    apply_settlement_to_pool(
        &mut ctx.accounts.pool,
        &mut ctx.accounts.market,
        &settlement,
        payout,
        0,
        close_size,
        is_long,
    )?;
    take_fee_cuts(&mut ctx.accounts.pool, fee)?;

    let usdc_mint_key = ctx.accounts.pool.usdc_mint;
    let bump = ctx.accounts.pool.bump;
    let signer_seeds: &[&[&[u8]]] = &[&[POOL_SEED, usdc_mint_key.as_ref(), &[bump]]];

    if bounty > 0 {
        transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.usdc_vault.to_account_info(),
                    mint: ctx.accounts.usdc_mint.to_account_info(),
                    to: ctx.accounts.liquidator_usdc.to_account_info(),
                    authority: ctx.accounts.pool.to_account_info(),
                },
                signer_seeds,
            ),
            bounty,
            ctx.accounts.usdc_mint.decimals,
        )?;
    }
    if to_owner > 0 {
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
            to_owner,
            ctx.accounts.usdc_mint.decimals,
        )?;
    }

    let position = &mut ctx.accounts.position;
    position.size_usd = 0;
    position.collateral_usd = 0;
    position.locked_usd = 0;
    position.entry_price = 0;
    position.entry_price_factor = 0;
    position.entry_funding = 0;
    position.open_ts = 0;
    position.last_update_ts = clock.unix_timestamp;

    emit!(PositionLiquidated {
        position: position_key,
        owner,
        market: market_key,
        liquidator: ctx.accounts.liquidator.key(),
        is_long,
        size_usd: close_size,
        fill_price: fill,
        index_price: oracle.price,
        pnl_usd: settlement.pnl_usd,
        funding_usd: settlement.funding_usd,
        bounty_usd: bounty,
        returned_usd: to_owner,
    });
    Ok(())
}

/// How a liquidation splits what a position has left.
pub struct Liquidation {
    /// The liquidation fee, before its cuts.
    pub fee: u64,
    /// What the liquidator takes: the fee less the protocol, chain and
    /// insurance cuts.
    pub bounty: u64,
    /// What goes back to the position's owner.
    pub to_owner: u64,
    /// What leaves the vault: the bounty and the owner's remainder. The cuts
    /// stay behind in the pool.
    pub payout: u64,
}

/// Decides whether a settled position may be liquidated, and if it may, who
/// gets what. Refuses a position whose equity reaches its maintenance margin.
///
/// Split out of `liquidate` so the arithmetic can be checked on its own: the
/// instruction only adds the oracle read before it and the transfers after.
pub fn liquidation(
    pool: &Pool,
    market: &Market,
    settlement: &Settlement,
    close_size: u64,
) -> Result<Liquidation> {
    let maintenance_req = bps_of(close_size, market.maintenance_margin_bps)?;
    require!(
        settlement.equity_usd < maintenance_req,
        PerpError::PositionHealthy
    );

    // The fee is paid out of whatever equity is left, never out of LP
    // capital, so a position that is already through zero costs the pool
    // nothing extra to clear. It is split like every other fee: the protocol,
    // chain and insurance cuts stay in the pool, and the liquidator takes the
    // rest -- the share the LPs would have had -- as the reward for doing it.
    // Equity past collateral is profit, and a liquidation pays profit no
    // further than the market's budget reaches, the same as deleveraging.
    // Only reachable at leverage high enough that maintenance exceeds the
    // collateral a position posted.
    let equity = payable_usd(market, settlement);
    let fee = bps_of(close_size, market.liquidation_fee_bps)?.min(equity);
    let cuts = fee_cuts_usd(pool, fee)?;
    let bounty = fee - cuts;
    let to_owner = equity - fee;
    // What leaves the vault: the owner's remainder and the liquidator's share.
    // The cuts stay behind, reaching liquidity as a smaller payout, and are
    // moved onto their own lines by the caller.
    let payout = equity - cuts;
    Ok(Liquidation {
        fee,
        bounty,
        to_owner,
        payout,
    })
}

#[event]
pub struct PositionLiquidated {
    pub position: Pubkey,
    pub owner: Pubkey,
    pub market: Pubkey,
    pub liquidator: Pubkey,
    pub is_long: bool,
    pub size_usd: u64,
    pub fill_price: u64,
    pub index_price: u64,
    pub pnl_usd: i64,
    pub funding_usd: i64,
    pub bounty_usd: u64,
    pub returned_usd: u64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::instructions::trade::tests::{market, pool, settlement};

    const SIZE: u64 = 5_000_000_000; // $5,000, so the 5% maintenance is $250

    #[test]
    fn a_position_at_its_maintenance_margin_is_healthy() {
        let (p, m) = (pool(), market());
        assert!(liquidation(&p, &m, &settlement(1_000_000_000, 250_000_000), SIZE).is_err());
        assert!(liquidation(&p, &m, &settlement(1_000_000_000, 249_999_999), SIZE).is_ok());
    }

    #[test]
    fn the_liquidator_takes_the_fee_less_its_cuts() {
        let (p, m) = (pool(), market());
        let l = liquidation(&p, &m, &settlement(1_000_000_000, 200_000_000), SIZE).unwrap();
        // 1% of $5,000 is $50, of which 40% is the protocol's, the chain's
        // and the fund's, and the rest is the liquidator's.
        assert_eq!(l.fee, 50_000_000);
        assert_eq!(l.bounty, 30_000_000);
        assert_eq!(l.to_owner, 150_000_000);
        assert_eq!(l.payout, 180_000_000);
    }

    #[test]
    fn the_fee_is_only_what_equity_is_left() {
        let (p, m) = (pool(), market());
        let l = liquidation(&p, &m, &settlement(1_000_000_000, 10_000_000), SIZE).unwrap();
        assert_eq!((l.fee, l.bounty, l.to_owner, l.payout), (10_000_000, 6_000_000, 0, 6_000_000));
        // Through zero there is nothing to pay anyone, and the pool keeps the
        // whole of the collateral.
        let l = liquidation(&p, &m, &settlement(1_000_000_000, 0), SIZE).unwrap();
        assert_eq!((l.fee, l.bounty, l.to_owner, l.payout), (0, 0, 0, 0));
    }

    #[test]
    fn a_liquidation_pays_profit_only_as_far_as_the_budget() {
        let (p, mut m) = (pool(), market());
        // $100 posted, $200 of equity, still under the $250 maintenance.
        // With $50 of budget left the position may be paid $150.
        m.loss_budget_usd = 50_000_000;
        let l = liquidation(&p, &m, &settlement(100_000_000, 200_000_000), SIZE).unwrap();
        assert_eq!(l.fee + l.to_owner, 150_000_000);
        assert!(l.payout - 100_000_000 <= 50_000_000);
    }
}
