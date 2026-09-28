use crate::constants::*;
use crate::errors::PerpError;
use crate::state::*;
use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct PoolParams {
    /// The oracle program this pool will accept prices from. Fixed here for the
    /// life of the pool; there is deliberately no way to change it later.
    pub pyth_receiver: Pubkey,
    /// Where the chain's share of revenue goes. Fixed here for the life of the
    /// pool, for the same reason the receiver is.
    pub chain_fee_destination: Pubkey,
    pub add_liquidity_fee_bps: u16,
    pub remove_liquidity_fee_bps: u16,
    pub protocol_fee_share_bps: u16,
    pub insurance_fee_share_bps: u16,
    pub max_utilization_bps: u16,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct MarketParams {
    pub symbol: [u8; 16],
    pub feed_id: [u8; 32],
    pub max_price_age_sec: u32,
    pub max_conf_bps: u16,
    pub max_leverage_bps: u32,
    pub maintenance_margin_bps: u16,
    pub liquidation_fee_bps: u16,
    pub open_fee_bps: u16,
    pub close_fee_bps: u16,
    pub min_position_usd: u64,
    pub max_oi_long_usd: u64,
    pub max_oi_short_usd: u64,
    pub pnl_reserve_bps: u16,
    pub base_spread_bps: u16,
    pub conf_spread_mult_bps: u16,
    pub max_spread_bps: u16,
    pub closed_session_leverage_bps: u32,
    pub closed_session_oi_mult_bps: u16,
    pub max_funding_rate_bps_per_hour: u16,
    pub funding_k_bps: u16,
    pub borrow_rate_bps_per_hour: u16,
    /// Where the mark comes from: 0 Pyth, 1 an `Observation`.
    pub price_source: u8,
    /// The observation account, when the source is one. Fixed at listing.
    pub observation: Pubkey,
}

impl MarketParams {
    pub fn validate(&self) -> Result<()> {
        require!(self.max_leverage_bps > 0, PerpError::InvalidParameter);
        require!(self.max_price_age_sec > 0, PerpError::InvalidParameter);
        require!(self.pnl_reserve_bps > 0, PerpError::InvalidParameter);
        require!(
            self.maintenance_margin_bps > 0 && (self.maintenance_margin_bps as u128) < BPS,
            PerpError::InvalidParameter
        );
        // A position opened at max leverage must not already be liquidatable.
        let initial_margin_bps = BPS * BPS / (self.max_leverage_bps as u128);
        require!(
            initial_margin_bps > self.maintenance_margin_bps as u128,
            PerpError::InvalidParameter
        );
        require!(
            self.max_spread_bps >= self.base_spread_bps,
            PerpError::InvalidParameter
        );
        require!(
            (self.max_conf_bps as u128) < BPS,
            PerpError::InvalidParameter
        );
        require!(
            (self.closed_session_oi_mult_bps as u128) <= BPS,
            PerpError::InvalidParameter
        );
        require!(
            (self.liquidation_fee_bps as u128) < self.maintenance_margin_bps as u128,
            PerpError::InvalidParameter
        );
        Ok(())
    }

    /// The tighter bounds a market listed by anyone but the authority has to
    /// fit. See `LISTING_*` in `constants.rs` for why each one exists.
    pub fn validate_listing(&self) -> Result<()> {
        self.validate()?;
        let ok = self.max_leverage_bps <= LISTING_MAX_LEVERAGE_BPS
            && self.closed_session_leverage_bps <= self.max_leverage_bps
            && (LISTING_MIN_OI_USD..=LISTING_MAX_OI_USD).contains(&self.max_oi_long_usd)
            && (LISTING_MIN_OI_USD..=LISTING_MAX_OI_USD).contains(&self.max_oi_short_usd)
            && self.max_price_age_sec <= LISTING_MAX_PRICE_AGE_SEC
            && self.max_conf_bps <= LISTING_MAX_CONF_BPS
            && (LISTING_MIN_FEE_BPS..=LISTING_MAX_FEE_BPS).contains(&self.open_fee_bps)
            && (LISTING_MIN_FEE_BPS..=LISTING_MAX_FEE_BPS).contains(&self.close_fee_bps)
            && self.maintenance_margin_bps >= LISTING_MIN_MAINTENANCE_BPS
            && self.pnl_reserve_bps >= LISTING_MIN_PNL_RESERVE_BPS
            && self.base_spread_bps >= LISTING_MIN_BASE_SPREAD_BPS
            && self.min_position_usd >= LISTING_MIN_POSITION_USD
            && self.max_funding_rate_bps_per_hour <= LISTING_MAX_FUNDING_RATE_BPS_PER_HOUR;
        require!(ok, PerpError::ListingOutOfBounds);
        Ok(())
    }
}

#[derive(Accounts)]
pub struct InitializePool<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init,
        payer = authority,
        space = 8 + Pool::INIT_SPACE,
        seeds = [POOL_SEED, usdc_mint.key().as_ref()],
        bump
    )]
    pub pool: Account<'info, Pool>,

    pub usdc_mint: InterfaceAccount<'info, Mint>,

    #[account(
        init,
        payer = authority,
        seeds = [POOL_VAULT_SEED, pool.key().as_ref()],
        bump,
        token::mint = usdc_mint,
        token::authority = pool,
        token::token_program = token_program,
    )]
    pub usdc_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        init,
        payer = authority,
        seeds = [LP_MINT_SEED, pool.key().as_ref()],
        bump,
        mint::decimals = LP_DECIMALS,
        mint::authority = pool,
        mint::token_program = token_program,
    )]
    pub lp_mint: Box<InterfaceAccount<'info, Mint>>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

impl PoolParams {
    /// The fee shares, with the chain's, fit inside one fee; utilization is at
    /// most the whole pool; and a deposit or withdrawal fee leaves something
    /// of the amount it is charged on.
    pub fn validate(&self) -> Result<()> {
        require!(
            (self.protocol_fee_share_bps as u128
                + self.insurance_fee_share_bps as u128
                + CHAIN_FEE_SHARE_BPS as u128) <= BPS
                && (self.max_utilization_bps as u128) <= BPS
                && (self.add_liquidity_fee_bps as u128) < BPS
                && (self.remove_liquidity_fee_bps as u128) < BPS,
            PerpError::InvalidParameter
        );
        Ok(())
    }
}

pub fn initialize_pool(ctx: Context<InitializePool>, params: PoolParams) -> Result<()> {
    params.validate()?;

    let pool = &mut ctx.accounts.pool;
    pool.bump = ctx.bumps.pool;
    pool.vault_bump = ctx.bumps.usdc_vault;
    pool.lp_mint_bump = ctx.bumps.lp_mint;
    pool.authority = ctx.accounts.authority.key();
    pool.pending_authority = Pubkey::default();
    pool.pyth_receiver = params.pyth_receiver;
    pool.chain_fee_destination = params.chain_fee_destination;
    pool.chain_fees_usd = 0;
    pool.usdc_mint = ctx.accounts.usdc_mint.key();
    pool.usdc_vault = ctx.accounts.usdc_vault.key();
    pool.lp_mint = ctx.accounts.lp_mint.key();
    pool.num_markets = 0;
    pool.liquidity_usd = 0;
    pool.locked_usd = 0;
    pool.trader_collateral_usd = 0;
    pool.protocol_fees_usd = 0;
    pool.insurance_usd = 0;
    pool.escrow_usd = 0;
    pool.add_liquidity_fee_bps = params.add_liquidity_fee_bps;
    pool.remove_liquidity_fee_bps = params.remove_liquidity_fee_bps;
    pool.protocol_fee_share_bps = params.protocol_fee_share_bps;
    pool.insurance_fee_share_bps = params.insurance_fee_share_bps;
    pool.max_utilization_bps = params.max_utilization_bps;
    pool.paused = false;
    pool.markets_with_oi = 0;
    Ok(())
}

#[derive(Accounts)]
#[instruction(params: MarketParams)]
pub struct AddMarket<'info> {
    /// Anyone. Listing a market costs its rent and earns the lister nothing
    /// until somebody funds it, which is the whole of the spam defence.
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(mut)]
    pub pool: Account<'info, Pool>,

    #[account(
        init,
        payer = payer,
        space = 8 + Market::INIT_SPACE,
        seeds = [MARKET_SEED, pool.key().as_ref(), params.feed_id.as_ref()],
        bump
    )]
    pub market: Account<'info, Market>,

    pub system_program: Program<'info, System>,
}

pub fn add_market(ctx: Context<AddMarket>, params: MarketParams) -> Result<()> {
    // The authority lists with any parameters `validate` accepts; anyone else
    // lists inside the bounds the site itself uses.
    if ctx.accounts.payer.key() == ctx.accounts.pool.authority {
        params.validate()?;
    } else {
        params.validate_listing()?;
    }
    let clock = Clock::get()?;
    let market = &mut ctx.accounts.market;

    market.bump = ctx.bumps.market;
    market.pool = ctx.accounts.pool.key();
    market.symbol = params.symbol;
    market.feed_id = params.feed_id;
    market.max_price_age_sec = params.max_price_age_sec;
    market.max_conf_bps = params.max_conf_bps;
    market.max_leverage_bps = params.max_leverage_bps;
    market.maintenance_margin_bps = params.maintenance_margin_bps;
    market.liquidation_fee_bps = params.liquidation_fee_bps;
    market.open_fee_bps = params.open_fee_bps;
    market.close_fee_bps = params.close_fee_bps;
    market.min_position_usd = params.min_position_usd;
    market.max_oi_long_usd = params.max_oi_long_usd;
    market.max_oi_short_usd = params.max_oi_short_usd;
    market.pnl_reserve_bps = params.pnl_reserve_bps;
    market.base_spread_bps = params.base_spread_bps;
    market.conf_spread_mult_bps = params.conf_spread_mult_bps;
    market.max_spread_bps = params.max_spread_bps;
    market.session = Session::Regular as u8;
    market.closed_session_leverage_bps = params.closed_session_leverage_bps;
    market.closed_session_oi_mult_bps = params.closed_session_oi_mult_bps;
    market.cumulative_long_funding = 0;
    market.cumulative_short_funding = 0;
    market.last_funding_ts = clock.unix_timestamp;
    market.max_funding_rate_bps_per_hour = params.max_funding_rate_bps_per_hour;
    market.funding_k_bps = params.funding_k_bps;
    market.borrow_rate_bps_per_hour = params.borrow_rate_bps_per_hour;
    market.price_factor = PRICE_FACTOR_ONE;
    market.split_epoch = 0;
    market.last_multiplier = MULTIPLIER_SCALE as u64;
    market.paused = false;
    market.price_source = params.price_source;
    market.observation = params.observation;
    market.deployer = ctx.accounts.payer.key();
    // Listed unfunded, always, and deliberately not a parameter.
    //
    // Listing is permissionless; underwriting is not. A deployer who could
    // name their own loss budget could list a market against a price they
    // control and set the budget to the size of the pool, which is not a
    // listing, it is a withdrawal. The budget arrives afterwards, with
    // backing.
    market.loss_budget_usd = 0;
    market.net_loss_usd = 0;
    market.locked_usd = 0;

    ctx.accounts.pool.num_markets = ctx
        .accounts
        .pool
        .num_markets
        .checked_add(1)
        .ok_or(PerpError::MathOverflow)?;
    Ok(())
}

#[derive(Accounts)]
pub struct UpdateMarket<'info> {
    #[account(address = pool.authority @ PerpError::Unauthorized)]
    pub authority: Signer<'info>,
    pub pool: Account<'info, Pool>,
    #[account(mut, has_one = pool @ PerpError::MarketPoolMismatch)]
    pub market: Account<'info, Market>,
}

pub fn update_market_params(ctx: Context<UpdateMarket>, params: MarketParams) -> Result<()> {
    params.validate()?;
    let market = &mut ctx.accounts.market;
    // The feed id is part of the market PDA seeds, so it is deliberately not
    // updatable: repointing a live market at a different underlying would
    // silently reprice every open position.
    require!(market.feed_id == params.feed_id, PerpError::WrongOracleFeed);

    market.max_price_age_sec = params.max_price_age_sec;
    market.max_conf_bps = params.max_conf_bps;
    market.max_leverage_bps = params.max_leverage_bps;
    market.maintenance_margin_bps = params.maintenance_margin_bps;
    market.liquidation_fee_bps = params.liquidation_fee_bps;
    market.open_fee_bps = params.open_fee_bps;
    market.close_fee_bps = params.close_fee_bps;
    market.min_position_usd = params.min_position_usd;
    market.max_oi_long_usd = params.max_oi_long_usd;
    market.max_oi_short_usd = params.max_oi_short_usd;
    market.pnl_reserve_bps = params.pnl_reserve_bps;
    market.base_spread_bps = params.base_spread_bps;
    market.conf_spread_mult_bps = params.conf_spread_mult_bps;
    market.max_spread_bps = params.max_spread_bps;
    market.closed_session_leverage_bps = params.closed_session_leverage_bps;
    market.closed_session_oi_mult_bps = params.closed_session_oi_mult_bps;
    market.max_funding_rate_bps_per_hour = params.max_funding_rate_bps_per_hour;
    market.funding_k_bps = params.funding_k_bps;
    market.borrow_rate_bps_per_hour = params.borrow_rate_bps_per_hour;
    // The budget is not a risk parameter the authority re-sends: it rises
    // with backing, and `set_market_budget` can only lower it.
    Ok(())
}

pub fn set_session(ctx: Context<UpdateMarket>, session: u8) -> Result<()> {
    let s = Session::from_u8(session)?;
    ctx.accounts.market.session = s as u8;
    emit!(SessionChanged {
        market: ctx.accounts.market.key(),
        session,
    });
    Ok(())
}

/// Lowers the market's loss budget without touching any other parameter.
///
/// Only down. A budget rises when somebody posts backing, and no key can
/// raise one without it; this is the authority's brake on a market it no
/// longer trusts, not a way to fund one.
pub fn set_market_budget(ctx: Context<UpdateMarket>, loss_budget_usd: u64) -> Result<()> {
    let market = &mut ctx.accounts.market;
    require!(loss_budget_usd <= market.loss_budget_usd, PerpError::BudgetOnlyLowers);
    market.loss_budget_usd = loss_budget_usd;
    emit!(MarketBudgetSet {
        market: market.key(),
        loss_budget_usd,
        net_loss_usd: market.net_loss_usd,
    });
    Ok(())
}

pub fn set_market_paused(ctx: Context<UpdateMarket>, paused: bool) -> Result<()> {
    ctx.accounts.market.paused = paused;
    Ok(())
}

/// Applies a split or other price-discontinuous corporate action.
///
/// `numerator / denominator` is the factor the *price* is multiplied by: a 4-for-1
/// split passes 1/4. Every entry price in the market is rebased through
/// `price_factor`, so open positions keep their economic exposure across the
/// action instead of being liquidated by an arithmetic artefact.
///
/// The market must be paused first. An action applied while fills are landing
/// would mark some positions pre-split and some post-split against one index.
pub fn apply_corporate_action(
    ctx: Context<UpdateMarket>,
    numerator: u64,
    denominator: u64,
    new_multiplier: u64,
) -> Result<()> {
    require!(numerator > 0 && denominator > 0, PerpError::InvalidParameter);
    let market = &mut ctx.accounts.market;
    require!(market.paused, PerpError::MarketPaused);

    market.price_factor = market
        .price_factor
        .checked_mul(numerator as u128)
        .ok_or(PerpError::MathOverflow)?
        .checked_div(denominator as u128)
        .ok_or(PerpError::MathOverflow)?;
    require!(market.price_factor > 0, PerpError::MathOverflow);

    // Aggregates are stored in current-factor terms, so they adjust immediately;
    // individual positions adjust lazily via `adjust_entry_price`.
    market.long_avg_entry_price = crate::math::mul_div_u64(
        market.long_avg_entry_price,
        numerator as u128,
        denominator as u128,
    )?;
    market.short_avg_entry_price = crate::math::mul_div_u64(
        market.short_avg_entry_price,
        numerator as u128,
        denominator as u128,
    )?;
    market.split_epoch = market
        .split_epoch
        .checked_add(1)
        .ok_or(PerpError::MathOverflow)?;
    market.last_multiplier = new_multiplier;

    emit!(CorporateActionApplied {
        market: market.key(),
        numerator,
        denominator,
        split_epoch: market.split_epoch,
        new_multiplier,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct UpdatePool<'info> {
    #[account(address = pool.authority @ PerpError::Unauthorized)]
    pub authority: Signer<'info>,
    #[account(mut)]
    pub pool: Account<'info, Pool>,
}

pub fn set_pool_paused(ctx: Context<UpdatePool>, paused: bool) -> Result<()> {
    ctx.accounts.pool.paused = paused;
    Ok(())
}

pub fn nominate_authority(ctx: Context<UpdatePool>, new_authority: Pubkey) -> Result<()> {
    ctx.accounts.pool.pending_authority = new_authority;
    Ok(())
}

#[derive(Accounts)]
pub struct AcceptAuthority<'info> {
    #[account(address = pool.pending_authority @ PerpError::Unauthorized)]
    pub new_authority: Signer<'info>,
    #[account(mut)]
    pub pool: Account<'info, Pool>,
}

pub fn accept_authority(ctx: Context<AcceptAuthority>) -> Result<()> {
    let pool = &mut ctx.accounts.pool;
    pool.authority = pool.pending_authority;
    pool.pending_authority = Pubkey::default();
    Ok(())
}

#[event]
pub struct MarketBudgetSet {
    pub market: Pubkey,
    pub loss_budget_usd: u64,
    /// Emitted alongside so a top-up can be read against what the market has
    /// already cost — a budget raised on a market that is deep in the red is
    /// the event worth alerting on.
    pub net_loss_usd: i64,
}

#[event]
pub struct SessionChanged {
    pub market: Pubkey,
    pub session: u8,
}

#[event]
pub struct CorporateActionApplied {
    pub market: Pubkey,
    pub numerator: u64,
    pub denominator: u64,
    pub split_epoch: u32,
    pub new_multiplier: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct CustodyParams {
    /// Counted at a dollar, with no oracle behind it.
    pub is_stable: bool,
    /// Pyth feed pricing the token in USD; ignored for a stable.
    pub feed_id: [u8; 32],
    pub max_price_age_sec: u32,
    pub max_conf_bps: u16,
    /// How much of the token's value counts toward a market's budget.
    pub budget_weight_bps: u16,
}

impl CustodyParams {
    /// A token never counts for more than its value, and one priced by an
    /// oracle has a staleness and a confidence limit to be priced within.
    pub fn validate(&self) -> Result<()> {
        require!(
            self.budget_weight_bps as u128 <= BPS
                && (self.is_stable || (self.max_price_age_sec > 0 && self.max_conf_bps > 0)),
            PerpError::InvalidParameter
        );
        Ok(())
    }
}

#[derive(Accounts)]
pub struct AddCustody<'info> {
    #[account(mut, address = pool.authority @ PerpError::Unauthorized)]
    pub authority: Signer<'info>,

    #[account(mut, seeds = [POOL_SEED, pool.usdc_mint.as_ref()], bump = pool.bump)]
    pub pool: Box<Account<'info, Pool>>,

    #[account(constraint = mint.key() != pool.usdc_mint @ PerpError::InvalidParameter)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        init,
        payer = authority,
        space = 8 + Custody::INIT_SPACE,
        seeds = [CUSTODY_SEED, pool.key().as_ref(), mint.key().as_ref()],
        bump,
    )]
    pub custody: Box<Account<'info, Custody>>,

    #[account(
        init,
        payer = authority,
        seeds = [CUSTODY_VAULT_SEED, custody.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = pool,
        token::token_program = token_program,
    )]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

/// Lets backing be held in another token.
///
/// Which tokens is the authority's to decide, because each one is an oracle
/// the pool then trusts to value money it stands behind. What a custody may
/// not do is be changed afterwards: a weight or a feed that could be moved
/// under a market would revalue backing somebody already posted.
pub fn add_custody(ctx: Context<AddCustody>, params: CustodyParams) -> Result<()> {
    let n = ctx.accounts.pool.num_custodies;
    require!((n as usize) < MAX_CUSTODIES, PerpError::InvalidParameter);
    params.validate()?;

    let c = &mut ctx.accounts.custody;
    c.bump = ctx.bumps.custody;
    c.vault_bump = ctx.bumps.vault;
    c.pool = ctx.accounts.pool.key();
    c.mint = ctx.accounts.mint.key();
    c.vault = ctx.accounts.vault.key();
    c.decimals = ctx.accounts.mint.decimals;
    c.index = n;
    c.is_stable = params.is_stable;
    c.feed_id = params.feed_id;
    c.max_price_age_sec = params.max_price_age_sec;
    c.max_conf_bps = params.max_conf_bps;
    c.budget_weight_bps = params.budget_weight_bps;
    c.backing_amount = 0;
    c.lp_amount = 0;

    ctx.accounts.pool.num_custodies = n + 1;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// What the site lists an AMM market with (scripts/server.ts).
    fn site_listing() -> MarketParams {
        MarketParams {
            symbol: [0; 16],
            feed_id: [0; 32],
            max_price_age_sec: 120,
            max_conf_bps: 5_000,
            max_leverage_bps: 30_000,
            maintenance_margin_bps: 1_000,
            liquidation_fee_bps: 100,
            open_fee_bps: 10,
            close_fee_bps: 10,
            min_position_usd: 10_000_000,
            max_oi_long_usd: 50_000_000_000,
            max_oi_short_usd: 50_000_000_000,
            pnl_reserve_bps: 10_000,
            base_spread_bps: 20,
            conf_spread_mult_bps: 10_000,
            max_spread_bps: 2_000,
            closed_session_leverage_bps: 30_000,
            closed_session_oi_mult_bps: 10_000,
            max_funding_rate_bps_per_hour: 100,
            funding_k_bps: 8_000,
            borrow_rate_bps_per_hour: 1,
            price_source: 1,
            observation: Pubkey::default(),
        }
    }

    #[test]
    fn the_sites_own_listing_fits_the_bounds() {
        site_listing().validate_listing().unwrap();
    }

    #[test]
    fn a_hand_built_listing_cannot_reach_past_the_bounds() {
        let cases: [fn(&mut MarketParams); 10] = [
            |p| p.max_leverage_bps = 100_000,            // 10x
            |p| p.max_oi_long_usd = 1_000_000_000_000,   // $1m
            |p| p.max_oi_short_usd = 1,                  // below the floor
            |p| p.max_price_age_sec = 3_600,             // an hour-old price
            |p| p.max_conf_bps = 9_000,                  // a 90% band
            |p| p.open_fee_bps = 0,
            |p| p.close_fee_bps = 5_000,
            |p| p.pnl_reserve_bps = 1_000,               // locks a tenth of the upside
            |p| p.base_spread_bps = 0,
            |p| p.min_position_usd = 1,
        ];
        for (i, bend) in cases.iter().enumerate() {
            let mut p = site_listing();
            bend(&mut p);
            assert!(p.validate_listing().is_err(), "case {i} should be refused");
        }
    }

    #[test]
    fn listing_bounds_are_inclusive_at_both_ends() {
        let mut p = site_listing();
        p.max_leverage_bps = LISTING_MAX_LEVERAGE_BPS;
        p.closed_session_leverage_bps = LISTING_MAX_LEVERAGE_BPS;
        p.max_oi_long_usd = LISTING_MIN_OI_USD;
        p.max_oi_short_usd = LISTING_MAX_OI_USD;
        p.open_fee_bps = LISTING_MIN_FEE_BPS;
        p.close_fee_bps = LISTING_MAX_FEE_BPS;
        p.max_price_age_sec = LISTING_MAX_PRICE_AGE_SEC;
        p.max_conf_bps = LISTING_MAX_CONF_BPS;
        p.maintenance_margin_bps = LISTING_MIN_MAINTENANCE_BPS;
        p.liquidation_fee_bps = 100;
        p.base_spread_bps = LISTING_MIN_BASE_SPREAD_BPS;
        p.min_position_usd = LISTING_MIN_POSITION_USD;
        p.max_funding_rate_bps_per_hour = LISTING_MAX_FUNDING_RATE_BPS_PER_HOUR;
        p.validate_listing().unwrap();

        // One unit past each end is refused.
        let past: [fn(&mut MarketParams); 8] = [
            |p| p.max_leverage_bps = LISTING_MAX_LEVERAGE_BPS + 1,
            |p| p.max_oi_long_usd = LISTING_MIN_OI_USD - 1,
            |p| p.max_oi_short_usd = LISTING_MAX_OI_USD + 1,
            |p| p.open_fee_bps = LISTING_MIN_FEE_BPS - 1,
            |p| p.close_fee_bps = LISTING_MAX_FEE_BPS + 1,
            |p| p.max_price_age_sec = LISTING_MAX_PRICE_AGE_SEC + 1,
            |p| p.maintenance_margin_bps = LISTING_MIN_MAINTENANCE_BPS - 1,
            |p| p.max_funding_rate_bps_per_hour = LISTING_MAX_FUNDING_RATE_BPS_PER_HOUR + 1,
        ];
        for (i, bend) in past.iter().enumerate() {
            let mut q = p.clone();
            bend(&mut q);
            assert!(q.validate_listing().is_err(), "case {i} should be refused");
        }
    }

    #[test]
    fn a_listing_cannot_loosen_leverage_for_the_closed_session() {
        let mut p = site_listing();
        p.closed_session_leverage_bps = p.max_leverage_bps + 1;
        assert!(p.validate_listing().is_err());
        // The authority may: the closed-session cap is applied as a min.
        p.validate().unwrap();
    }

    #[test]
    fn maximum_leverage_must_leave_more_than_maintenance_at_open() {
        // 10x opens with exactly 10% margin, so a 10% maintenance would make
        // the position liquidatable the moment it opens.
        let mut p = site_listing();
        p.max_leverage_bps = 100_000;
        p.maintenance_margin_bps = 1_000;
        p.liquidation_fee_bps = 100;
        assert!(p.validate().is_err());
        p.maintenance_margin_bps = 999;
        p.validate().unwrap();
        // 3x rounds initial margin down to 3,333 bps.
        p.max_leverage_bps = 30_000;
        p.maintenance_margin_bps = 3_333;
        assert!(p.validate().is_err());
        p.maintenance_margin_bps = 3_332;
        p.validate().unwrap();
    }

    #[test]
    fn consistency_rules_bind_the_authority_too() {
        let cases: [fn(&mut MarketParams); 8] = [
            |p| p.max_leverage_bps = 0,
            |p| p.max_price_age_sec = 0,
            |p| p.pnl_reserve_bps = 0,
            |p| p.maintenance_margin_bps = 0,
            |p| p.liquidation_fee_bps = p.maintenance_margin_bps, // the whole margin
            |p| p.max_spread_bps = p.base_spread_bps - 1,
            |p| p.max_conf_bps = 10_000,
            |p| p.closed_session_oi_mult_bps = 10_001,
        ];
        for (i, bend) in cases.iter().enumerate() {
            let mut p = site_listing();
            bend(&mut p);
            assert!(p.validate().is_err(), "case {i} should be refused");
        }
    }

    fn pool_params() -> PoolParams {
        PoolParams {
            pyth_receiver: Pubkey::default(),
            chain_fee_destination: Pubkey::default(),
            add_liquidity_fee_bps: 10,
            remove_liquidity_fee_bps: 10,
            protocol_fee_share_bps: 2_000,
            insurance_fee_share_bps: 1_000,
            max_utilization_bps: 8_000,
        }
    }

    #[test]
    fn a_pool_split_must_leave_room_for_the_chains_share() {
        let mut p = pool_params();
        p.validate().unwrap();
        // With the chain's 10%, the other two may take 90% between them.
        p.protocol_fee_share_bps = 9_000 - p.insurance_fee_share_bps;
        p.validate().unwrap();
        p.protocol_fee_share_bps += 1;
        assert!(p.validate().is_err());
    }

    #[test]
    fn pool_fees_and_utilization_stay_fractions() {
        let cases: [fn(&mut PoolParams); 3] = [
            |p| p.max_utilization_bps = 10_001,
            |p| p.add_liquidity_fee_bps = 10_000,
            |p| p.remove_liquidity_fee_bps = 10_000,
        ];
        for (i, bend) in cases.iter().enumerate() {
            let mut p = pool_params();
            bend(&mut p);
            assert!(p.validate().is_err(), "case {i} should be refused");
        }
        let mut p = pool_params();
        p.max_utilization_bps = 10_000;
        p.add_liquidity_fee_bps = 9_999;
        p.validate().unwrap();
    }

    #[test]
    fn a_custody_counts_at_most_its_value_and_an_oracle_token_needs_limits() {
        let stable = CustodyParams {
            is_stable: true,
            feed_id: [0; 32],
            max_price_age_sec: 0,
            max_conf_bps: 0,
            budget_weight_bps: 10_000,
        };
        stable.validate().unwrap();
        let mut over = stable.clone();
        over.budget_weight_bps = 10_001;
        assert!(over.validate().is_err());

        let mut sol = stable.clone();
        sol.is_stable = false;
        sol.budget_weight_bps = 8_000;
        assert!(sol.validate().is_err(), "no staleness or confidence limit");
        sol.max_price_age_sec = 60;
        assert!(sol.validate().is_err(), "no confidence limit");
        sol.max_conf_bps = 200;
        sol.validate().unwrap();
    }

    #[test]
    fn the_authority_is_held_only_to_consistency() {
        // Past every listing bound, and still a coherent market.
        let mut p = site_listing();
        p.max_leverage_bps = 100_000;
        p.maintenance_margin_bps = 500; // under the 10% a 10x position starts with
        p.max_oi_long_usd = 10_000_000_000_000;
        p.max_oi_short_usd = 10_000_000_000_000;
        p.open_fee_bps = 6;
        p.close_fee_bps = 6;
        p.validate().unwrap();
        assert!(p.validate_listing().is_err());
    }
}
