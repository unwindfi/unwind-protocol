use crate::constants::*;
use crate::errors::PerpError;
use crate::instructions::trade::{apply_settlement_to_pool, payable_usd, settle, Settlement};
use crate::math::*;
use crate::instructions::batch::market_price;
use crate::state::*;
use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};

#[derive(Accounts)]
pub struct AutoDeleverage<'info> {
    pub keeper: Signer<'info>,

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

    /// CHECK: matched against `position.owner` by the `has_one` above.
    pub owner: UncheckedAccount<'info>,

    /// CHECK: Validated by `market_price`: a Pyth update or the market's
    /// observation, whichever its price source says.
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

    pub token_program: Interface<'info, TokenInterface>,
}

/// Whether a position, settled in full as `settlement`, may be deleveraged.
///
/// Two triggers, both local to the position, which is what makes this cheap
/// enough to run per position:
///
/// 1. Its profit has outgrown the reserve locked against it. The pool's
///    uncovered exposure *is* the sum of these breaches, so acting on each one
///    caps the total without a global scan inside the instruction.
/// 2. Its market's loss budget can no longer pay it out. A reduce-only order
///    fills only as far as the budget reaches, so without this a winner in a
///    market that has spent its budget could neither leave by the batch nor be
///    deleveraged, and would sit there until somebody backed the market again.
///    This closes it at the oracle mark rather than at a batch price, which is
///    what makes paying past the budget safe: the price is not one a trader
///    can walk.
///
/// The second trigger reads what the position is owed past its collateral,
/// not its price PnL, because funding received counts too: a position up
/// only on funding, at a flat price, is just as stuck when the budget is
/// spent (the batch fills none of it) and is not liquidatable, being healthy.
pub fn deleverage_due(position: &Position, market: &Market, settlement: &Settlement) -> bool {
    let breached = settlement.pnl_usd > 0 && (settlement.pnl_usd as u64) > position.locked_usd;
    let owed_past_collateral = settlement
        .equity_usd
        .saturating_sub(settlement.collateral_share);
    let unpayable = owed_past_collateral > 0 && owed_past_collateral > market.remaining_budget_usd();
    breached || unpayable
}

/// Force-closes a position whose profit has outgrown the liquidity reserved
/// against it, or that its market's budget can no longer pay.
///
/// Each position locks `size * pnl_reserve_bps` of pool capital to back the
/// profit it might make. Past that the pool is carrying exposure it never set
/// aside for, and the shortfall lands on LPs and then on the insurance fund —
/// and if both run out, the close reverts and the trader is stuck in a position
/// they have won. Closing at the mark while the pool can still pay is what
/// keeps that from happening, so this fires at the point the reserve is
/// breached rather than at the point the money runs out.
///
/// The trader is made whole: full equity at the current mark, no penalty and no
/// keeper bounty taken from it. Being deleveraged is not their fault, and a fee
/// here would be charging them for the pool's risk limit. That leaves the keeper
/// uncompensated, which is correct while the protocol runs it and a gap to close
/// before anyone else is expected to.
pub fn auto_deleverage(ctx: Context<AutoDeleverage>) -> Result<()> {
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

    require!(
        deleverage_due(&ctx.accounts.position, &ctx.accounts.market, &settlement),
        PerpError::PositionCovered
    );

    // Full equity when the budget covers it; otherwise collateral back and as
    // much profit as the budget still has, and the rest is not paid.
    let payout = payable_usd(&ctx.accounts.market, &settlement);
    let haircut = settlement.equity_usd - payout;
    let position_key = ctx.accounts.position.key();
    let market_key = ctx.accounts.market.key();
    let owner = ctx.accounts.position.owner;
    let reserved = ctx.accounts.position.locked_usd;

    apply_settlement_to_pool(
        &mut ctx.accounts.pool,
        &mut ctx.accounts.market,
        &settlement,
        payout,
        0,
        close_size,
        is_long,
    )?;

    if payout > 0 {
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
            payout,
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

    emit!(PositionDeleveraged {
        position: position_key,
        owner,
        market: market_key,
        keeper: ctx.accounts.keeper.key(),
        is_long,
        size_usd: close_size,
        fill_price: fill,
        pnl_usd: settlement.pnl_usd,
        reserved_usd: reserved,
        payout_usd: payout,
        haircut_usd: haircut,
    });
    Ok(())
}

#[event]
pub struct PositionDeleveraged {
    pub position: Pubkey,
    pub owner: Pubkey,
    pub market: Pubkey,
    pub keeper: Pubkey,
    pub is_long: bool,
    pub size_usd: u64,
    pub fill_price: u64,
    pub pnl_usd: i64,
    /// What the pool had locked against this position when it was closed.
    pub reserved_usd: u64,
    pub payout_usd: u64,
    /// Profit the market's budget could not cover, and which was not paid.
    pub haircut_usd: u64,
}
