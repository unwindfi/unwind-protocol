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
        // One step of the risk price is at most `RISK_PRICE_STEP_BPS_PER_SLOT`
        // x `RISK_PRICE_MAX_GAP_SLOTS`. A position healthy before a step must
        // still have its liquidation fee left after it, or a liquidation would
        // be paid out of LP capital.
        require!(
            self.maintenance_margin_bps as u64
                >= RISK_PRICE_STEP_BPS_PER_SLOT * RISK_PRICE_MAX_GAP_SLOTS
                    + self.liquidation_fee_bps as u64,
            PerpError::MarginEnvelope
        );
        Ok(())
    }

    /// Where the mark comes from, checked against the market being listed.
    /// Both are fixed for the market's life, so a listing whose source can
    /// never be read (an observed market pointed at any account but its own
    /// observation, or a source that is neither) would be dead from the
    /// start. It no longer blocks the feed (the next listing takes the next
    /// generation), but there is no reason to let it land.
    pub fn validate_source(&self, market: &Pubkey) -> Result<()> {
        match PriceSource::from_u8(self.price_source)? {
            PriceSource::Pyth => require_keys_eq!(
                self.observation,
                Pubkey::default(),
                PerpError::InvalidParameter
            ),
            PriceSource::Observed => {
                let (want, _) =
                    Pubkey::find_program_address(&[OBSERVATION_SEED, market.as_ref()], &crate::ID);
                require_keys_eq!(self.observation, want, PerpError::WrongOracleFeed);
            }
        }
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

    /// This program's data account, read for its upgrade authority: only
    /// whoever can upgrade the program may create a pool. The pool PDA is
    /// keyed by mint alone, so an open `initialize_pool` let anyone take a
    /// mint's pool first and name its oracle.
    #[account(
        seeds = [crate::ID.as_ref()],
        bump,
        seeds::program = anchor_lang::solana_program::bpf_loader_upgradeable::ID,
    )]
    pub program_data: Account<'info, ProgramData>,
}

/// Who may create a pool: the program's upgrade authority, and nobody once
/// the program is immutable. Open on a `devnet` build, whose test clusters
/// load the program without an upgrade authority and bootstrap pools from
/// fresh keys; there the instructions that pay out are bound to their own
/// pool instead.
pub fn check_pool_creator(upgrade_authority: Option<Pubkey>, signer: &Pubkey, pinned: bool) -> Result<()> {
    if pinned {
        require!(upgrade_authority == Some(*signer), PerpError::Unauthorized);
    }
    Ok(())
}

/// The oracle program a pool may trust. Pinned to Pyth's receiver unless the
/// program is built with the `devnet` feature, which runs a stand-in oracle
/// (`mock-pyth`) on clusters where Pyth's receiver does not publish.
pub fn check_pyth_receiver(receiver: &Pubkey, pinned: bool) -> Result<()> {
    if pinned {
        require_keys_eq!(*receiver, crate::oracle::PYTH_RECEIVER_ID, PerpError::WrongOracleOwner);
    }
    Ok(())
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
    let pinned = !cfg!(feature = "devnet");
    check_pool_creator(
        ctx.accounts.program_data.upgrade_authority_address,
        &ctx.accounts.authority.key(),
        pinned,
    )?;
    check_pyth_receiver(&params.pyth_receiver, pinned)?;

    let pool = &mut ctx.accounts.pool;
    // Only a devnet build lets anyone else create a pool; theirs earns no
    // points (see `Pool::no_points`).
    pool.no_points =
        ctx.accounts.program_data.upgrade_authority_address != Some(ctx.accounts.authority.key());
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
#[instruction(params: MarketParams, generation: u32)]
pub struct AddMarket<'info> {
    /// Anyone. Listing a market costs its rent and earns the lister nothing
    /// until somebody funds it, which is the whole of the spam defence.
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(mut)]
    pub pool: Account<'info, Pool>,

    /// How many times this feed has been listed in this pool. The first
    /// listing creates it.
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + MarketGenerations::INIT_SPACE,
        seeds = [MARKET_GENERATION_SEED, pool.key().as_ref(), params.feed_id.as_ref()],
        bump
    )]
    pub generations: Account<'info, MarketGenerations>,

    /// At `generation`, which must be the feed's next one. A feed is never
    /// held by whoever listed it first: a market listed with a bad source or
    /// bad parameters keeps its own address, and the next listing of the same
    /// feed takes the generation after it.
    #[account(
        init,
        payer = payer,
        space = 8 + Market::INIT_SPACE,
        seeds = [MARKET_SEED, pool.key().as_ref(), params.feed_id.as_ref(), generation.to_le_bytes().as_ref()],
        bump
    )]
    pub market: Account<'info, Market>,

    pub system_program: Program<'info, System>,
}

pub fn add_market(ctx: Context<AddMarket>, params: MarketParams, generation: u32) -> Result<()> {
    // The authority lists with any parameters `validate` accepts; anyone else
    // lists inside the bounds the site itself uses.
    if ctx.accounts.payer.key() == ctx.accounts.pool.authority {
        params.validate()?;
    } else {
        params.validate_listing()?;
    }
    params.validate_source(&ctx.accounts.market.key())?;
    let generations = &mut ctx.accounts.generations;
    generations.bump = ctx.bumps.generations;
    generations.pool = ctx.accounts.pool.key();
    generations.feed_id = params.feed_id;
    generations.take(generation)?;
    let clock = Clock::get()?;
    let market = &mut ctx.accounts.market;

    market.bump = ctx.bumps.market;
    market.generation = generation;
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
    /// Mutable for `set_market_budget`, which books AUM drift on it.
    #[account(mut)]
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
    let owed_before = crate::aum::lp_owed_now(market)?;
    market.loss_budget_usd = loss_budget_usd;
    crate::aum::book_lp_drift(&mut ctx.accounts.pool, market, owed_before)?;
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

/// Accounts for a corporate action: the market, and everything else that holds
/// a price in the token's terms (S2-04).
#[derive(Accounts)]
pub struct CorporateAction<'info> {
    #[account(address = pool.authority @ PerpError::Unauthorized)]
    pub authority: Signer<'info>,
    pub pool: Account<'info, Pool>,
    #[account(mut, has_one = pool @ PerpError::MarketPoolMismatch)]
    pub market: Account<'info, Market>,
    /// Its resting limits are prices too.
    #[account(mut, seeds = [BATCH_SEED, market.key().as_ref()], bump)]
    pub batch: AccountLoader<'info, Batch>,
    /// Required when the market is observed: the mark is a price.
    #[account(mut, address = market.observation @ PerpError::WrongOracleFeed)]
    pub observation: Option<Account<'info, Observation>>,
}

/// Applies a split or other price-discontinuous corporate action.
///
/// `numerator / denominator` is the factor the *price* is multiplied by: a 4-for-1
/// split passes 1/4. Every entry price in the market is rebased through
/// `price_factor`, so open positions keep their economic exposure across the
/// action instead of being liquidated by an arithmetic artefact.
///
/// Every other price in the token's terms moves in the same instruction, so no
/// two of them disagree for a single reading: the risk price and last price
/// (`rescale_market`), the limits resting in the open batch (`rescale_batch`),
/// an observed mark (`rescale_observation`). Trigger orders rebase lazily
/// through the factor they were placed under (`Order::trigger_at`).
///
/// The market must be paused first. An action applied while fills are landing
/// would mark some positions pre-split and some post-split against one index.
pub fn apply_corporate_action(
    ctx: Context<CorporateAction>,
    numerator: u64,
    denominator: u64,
    new_multiplier: u64,
) -> Result<()> {
    require!(numerator > 0 && denominator > 0, PerpError::InvalidParameter);
    require!(ctx.accounts.market.paused, PerpError::MarketPaused);

    rescale_batch(&mut *ctx.accounts.batch.load_mut()?, numerator, denominator)?;
    if PriceSource::from_u8(ctx.accounts.market.price_source)? == PriceSource::Observed {
        let o = ctx
            .accounts
            .observation
            .as_mut()
            .ok_or(PerpError::WrongOracleFeed)?;
        rescale_observation(o, numerator, denominator)?;
    }

    let market = &mut ctx.accounts.market;
    rescale_market(market, numerator, denominator)?;
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

/// `price * numerator / denominator`, never below one unit: zero reads as
/// "unset" for most of these fields.
fn rescale_price(price: u64, numerator: u64, denominator: u64, round_up: bool) -> Result<u64> {
    if price == 0 {
        return Ok(0);
    }
    let n = (price as u128)
        .checked_mul(numerator as u128)
        .ok_or(PerpError::MathOverflow)?;
    let d = denominator as u128;
    let q = n / d + u128::from(round_up && n % d != 0);
    Ok(u64::try_from(q).map_err(|_| PerpError::MathOverflow)?.max(1))
}

/// Moves every price the market stores into the new terms at once.
///
/// The risk price matters most. Left at the old level it would walk to the
/// new one at `RISK_PRICE_STEP_BPS_PER_SLOT` a slot, and liquidation reads it
/// (also while paused): after a 4-for-1 split every short would read 300%
/// down for over a hundred readings.
pub fn rescale_market(market: &mut Market, numerator: u64, denominator: u64) -> Result<()> {
    market.price_factor = market
        .price_factor
        .checked_mul(numerator as u128)
        .ok_or(PerpError::MathOverflow)?
        .checked_div(denominator as u128)
        .ok_or(PerpError::MathOverflow)?;
    require!(market.price_factor > 0, PerpError::MathOverflow);

    // Aggregates are stored in current-factor terms, so they adjust immediately;
    // individual positions adjust lazily via `adjust_entry_price`.
    // Floored at one unit like every other price here (`rescale_price`), and
    // like a position's own rebased entry (`Market::adjust_entry_price`): a
    // side average of zero is one `position_pnl_usd` refuses.
    market.long_avg_entry_price =
        rescale_price(market.long_avg_entry_price, numerator, denominator, false)?;
    market.short_avg_entry_price =
        rescale_price(market.short_avg_entry_price, numerator, denominator, false)?;
    // The step remainder belongs to the old walk; the new risk price starts
    // where the old one stood, in the new terms.
    market.risk_price = rescale_price(market.risk_price, numerator, denominator, false)?;
    market.risk_step_rem = 0;
    // Kept rescaled rather than cleared: a reading under the same publish time
    // must still match it, and an old-terms price under that time does not.
    market.last_price = rescale_price(market.last_price, numerator, denominator, false)?;
    market.split_epoch = market
        .split_epoch
        .checked_add(1)
        .ok_or(PerpError::MathOverflow)?;
    // The side moment sums are not rescaled: they would pick up rounding the
    // positions' own lazy rebase does not, and then stop matching them. They
    // are emptied instead, and the new `split_epoch` untracks every position
    // they held, so the market counts winners by the old net rule until those
    // positions close or are topped up (`Market::side_winners_usd`).
    market.reset_moments();
    Ok(())
}

/// Rescales the limits resting in an open batch, or refuses a sealed one.
///
/// A sealed batch has cleared at a price in the old terms and settles every
/// fill at it; settled after the action, those fills would book old prices
/// against new factors. It is settled first (permissionless), then the action
/// lands. A buy's ceiling rounds down and a sell's floor up, so no limit is
/// loosened.
pub fn rescale_batch(batch: &mut Batch, numerator: u64, denominator: u64) -> Result<()> {
    require!(batch.is_open() && batch.unsettled == 0, PerpError::BatchSealed);
    for o in batch.orders.iter_mut().filter(|o| o.active != 0) {
        o.price = rescale_price(o.price, numerator, denominator, o.is_bid == 0)?;
    }
    Ok(())
}

/// Moves an observed mark with the split. Left alone, the mark would walk to
/// the pool's new price at `max_move_bps` a reading while entries had already
/// moved.
pub fn rescale_observation(o: &mut Observation, numerator: u64, denominator: u64) -> Result<()> {
    o.ewma_price = rescale_price(o.ewma_price, numerator, denominator, false)?;
    o.last_spot = rescale_price(o.last_spot, numerator, denominator, false)?;
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

#[derive(Accounts)]
pub struct SetPoolPoints<'info> {
    /// The program's upgrade authority, checked against `program_data`.
    pub upgrade_authority: Signer<'info>,
    #[account(mut)]
    pub pool: Account<'info, Pool>,
    #[account(
        seeds = [crate::ID.as_ref()],
        bump,
        seeds::program = anchor_lang::solana_program::bpf_loader_upgradeable::ID,
    )]
    pub program_data: Account<'info, ProgramData>,
}

/// Who may switch a pool's points on or off: the program's upgrade authority,
/// on every build, and nobody once the program is immutable. A devnet pool
/// created from a fresh key starts with no points; this is how the deployer
/// vouches for it.
pub fn check_points_switch(upgrade_authority: Option<Pubkey>, signer: &Pubkey) -> Result<()> {
    check_pool_creator(upgrade_authority, signer, true)
}

pub fn set_pool_points(ctx: Context<SetPoolPoints>, enabled: bool) -> Result<()> {
    check_points_switch(
        ctx.accounts.program_data.upgrade_authority_address,
        &ctx.accounts.upgrade_authority.key(),
    )?;
    ctx.accounts.pool.no_points = !enabled;
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

#[derive(Accounts)]
pub struct ResizeMarket<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: Owned by this program and carrying `Market`'s discriminator,
    /// both checked in the handler. Not an `Account<Market>`: a market listed
    /// before the account grew is too short to deserialise, which is the
    /// whole reason this instruction exists.
    #[account(mut, owner = crate::ID)]
    pub market: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

/// Grows a market listed before `Market` gained its newer fields to the
/// current size, zero-filling the new bytes; the payer covers the rent.
///
/// Permissionless: it writes nothing but zeroes, and each new field reads
/// zero as "nothing recorded yet". A market already at the current size is
/// left alone.
pub fn resize_market(ctx: Context<ResizeMarket>) -> Result<()> {
    grow_account(
        &ctx.accounts.market.to_account_info(),
        &ctx.accounts.payer.to_account_info(),
        &ctx.accounts.system_program.to_account_info(),
        Market::DISCRIMINATOR,
        8 + Market::INIT_SPACE,
    )
}

#[derive(Accounts)]
pub struct ResizePool<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: Owned by this program and carrying `Pool`'s discriminator, both
    /// checked in the handler. Not an `Account<Pool>`, for the reason
    /// `ResizeMarket` gives.
    #[account(mut, owner = crate::ID)]
    pub pool: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

/// Grows a pool created before `Pool` gained `aum_drift_usd` to the current
/// size, zero-filling the new bytes; the payer covers the rent.
///
/// Permissionless for the same reason `resize_market` is. Zero is the right
/// drift for an existing pool: every market's drift starts at zero too, and
/// the pool's drift only has to equal the sum of theirs.
pub fn resize_pool(ctx: Context<ResizePool>) -> Result<()> {
    grow_account(
        &ctx.accounts.pool.to_account_info(),
        &ctx.accounts.payer.to_account_info(),
        &ctx.accounts.system_program.to_account_info(),
        Pool::DISCRIMINATOR,
        8 + Pool::INIT_SPACE,
    )
}

#[derive(Accounts)]
pub struct ResizeTrader<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: Owned by this program and carrying `Trader`'s discriminator,
    /// both checked in the handler. Not an `Account<Trader>`, for the reason
    /// `ResizeMarket` gives.
    #[account(mut, owner = crate::ID)]
    pub trader: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

/// Grows a wallet's `Trader` from before it gained the daily points cap, the
/// held volume and the points breakdown to the current size, zero-filling the
/// new bytes; the payer covers the rent.
///
/// Permissionless for the same reason `resize_market` is. Zero is right for
/// each new field: no points counted today, no held volume yet, and nothing
/// in the breakdown, which counts from here on.
pub fn resize_trader(ctx: Context<ResizeTrader>) -> Result<()> {
    grow_account(
        &ctx.accounts.trader.to_account_info(),
        &ctx.accounts.payer.to_account_info(),
        &ctx.accounts.system_program.to_account_info(),
        Trader::DISCRIMINATOR,
        8 + Trader::INIT_SPACE,
    )
}

/// Grows `account`, which must carry `discriminator`, to `target` bytes,
/// topping its rent up from `payer`. Leaves an account already that size
/// alone.
fn grow_account<'info>(
    account: &AccountInfo<'info>,
    payer: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    discriminator: &[u8],
    target: usize,
) -> Result<()> {
    {
        let data = account.try_borrow_data()?;
        require!(
            data.len() >= 8 && data[..8] == *discriminator,
            PerpError::InvalidParameter
        );
        if data.len() >= target {
            return Ok(());
        }
    }
    let need = Rent::get()?
        .minimum_balance(target)
        .saturating_sub(account.lamports());
    if need > 0 {
        anchor_lang::system_program::transfer(
            CpiContext::new(
                system_program.clone(),
                anchor_lang::system_program::Transfer {
                    from: payer.clone(),
                    to: account.clone(),
                },
            ),
            need,
        )?;
    }
    account.resize(target)?;
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
    fn maintenance_must_cover_the_risk_price_envelope_and_the_fee() {
        let envelope = (RISK_PRICE_STEP_BPS_PER_SLOT * RISK_PRICE_MAX_GAP_SLOTS) as u16;
        let mut p = site_listing();
        p.max_leverage_bps = 200_000; // 20x, so maintenance can sit low
        p.liquidation_fee_bps = 100;
        p.maintenance_margin_bps = envelope + 100;
        p.validate().unwrap();
        p.maintenance_margin_bps = envelope + 99;
        assert!(p.validate().is_err(), "one bp short of the envelope is refused");
        // The 20x market the authority lists (scripts/markets.ts) still fits.
        p.maintenance_margin_bps = 250;
        p.validate().unwrap();
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

    #[test]
    fn only_the_upgrade_authority_creates_a_pool() {
        let admin = Pubkey::new_unique();
        assert!(check_pool_creator(Some(admin), &admin, true).is_ok());
        assert!(check_pool_creator(Some(admin), &Pubkey::new_unique(), true).is_err());
        // An immutable program creates no more pools.
        assert!(check_pool_creator(None, &admin, true).is_err());
        assert!(check_pool_creator(None, &admin, false).is_ok());
    }

    #[test]
    fn only_the_upgrade_authority_switches_points() {
        let admin = Pubkey::new_unique();
        assert!(check_points_switch(Some(admin), &admin).is_ok());
        // A pool's own authority is not enough, on any build.
        assert!(check_points_switch(Some(admin), &Pubkey::new_unique()).is_err());
        assert!(check_points_switch(None, &admin).is_err());
    }

    #[test]
    fn a_pinned_build_trusts_only_pyths_receiver() {
        let mock = Pubkey::new_unique();
        assert!(check_pyth_receiver(&crate::oracle::PYTH_RECEIVER_ID, true).is_ok());
        assert!(check_pyth_receiver(&mock, true).is_err());
        assert!(check_pyth_receiver(&mock, false).is_ok());
    }

    #[test]
    fn a_listing_names_a_source_it_can_be_read_from() {
        let market = Pubkey::new_unique();
        let (obs, _) = Pubkey::find_program_address(&[OBSERVATION_SEED, market.as_ref()], &crate::ID);
        let p = |price_source: u8, observation: Pubkey| {
            let mut m = site_listing();
            m.price_source = price_source;
            m.observation = observation;
            m
        };
        assert!(p(PriceSource::Pyth as u8, Pubkey::default()).validate_source(&market).is_ok());
        assert!(p(PriceSource::Observed as u8, obs).validate_source(&market).is_ok());
        // An observed market pointed anywhere but its own observation could
        // never be priced, and would hold its pool's market address for good.
        assert!(p(PriceSource::Observed as u8, Pubkey::default()).validate_source(&market).is_err());
        assert!(p(PriceSource::Observed as u8, Pubkey::new_unique()).validate_source(&market).is_err());
        assert!(p(PriceSource::Pyth as u8, obs).validate_source(&market).is_err());
        assert!(p(7, Pubkey::default()).validate_source(&market).is_err());
    }
}

/// S2-04: a split has to move every price the market stores, not only entries.
#[cfg(test)]
mod corporate_action_tests {
    use super::*;
    use crate::instructions::liquidate::{below_maintenance, liquidation_fills};
    use crate::instructions::trade::settle;
    use crate::instructions::trade::tests::{market, position};
    use crate::oracle::OraclePrice;

    const OLD: u64 = 200_000_000; // $200 before a 4-for-1 split
    const NEW: u64 = 50_000_000; // $50 after it

    fn px(price: u64, ts: i64) -> OraclePrice {
        OraclePrice { price, conf: 0, published_ts: ts }
    }

    /// A market at `at` with one $10,000 position at 10x, risk price caught up.
    fn one_position(is_long: bool, at: u64) -> (Market, Position) {
        let mut m = market();
        if is_long {
            m.long_size_usd = 10_000_000_000;
            m.long_avg_entry_price = at;
        } else {
            m.short_size_usd = 10_000_000_000;
            m.short_avg_entry_price = at;
        }
        m.accept_price(&px(at, 1_000), 10).unwrap();
        let mut p = position();
        p.is_long = is_long;
        p.size_usd = 10_000_000_000;
        p.collateral_usd = 1_000_000_000;
        p.entry_price = at;
        p.entry_price_factor = m.price_factor;
        (m, p)
    }

    #[test]
    fn a_split_rescales_every_price_the_market_stores() {
        let (mut m, _) = one_position(false, OLD);
        m.risk_step_rem = 7;
        let factor = m.price_factor;
        rescale_market(&mut m, 1, 4).unwrap();
        assert_eq!(m.price_factor, factor / 4);
        assert_eq!(m.short_avg_entry_price, NEW);
        assert_eq!(m.risk_price, NEW, "liquidation reads this; it must not lag the split");
        assert_eq!(m.last_price, NEW);
        assert_eq!(m.risk_step_rem, 0);
        assert_eq!(m.split_epoch, 1);
    }

    #[test]
    fn a_split_floors_entries_at_one_unit_and_the_position_still_settles() {
        // Five units, then 1-for-10: every entry would rebase to half a unit.
        let (mut m, p) = one_position(true, 5);
        let mut short = m.clone();
        short.long_size_usd = 0;
        short.long_avg_entry_price = 0;
        short.short_size_usd = 10_000_000_000;
        short.short_avg_entry_price = 5;
        rescale_market(&mut m, 1, 10).unwrap();
        rescale_market(&mut short, 1, 10).unwrap();
        assert_eq!(m.long_avg_entry_price, 1);
        assert_eq!(short.short_avg_entry_price, 1);
        // An empty side stays empty rather than gaining a price.
        assert_eq!(m.short_avg_entry_price, 0);
        assert_eq!(short.long_avg_entry_price, 0);
        assert_eq!(m.adjust_entry_price(p.entry_price, p.entry_price_factor).unwrap(), 1);
        // The close and the side's PnL both read, at any price.
        assert!(settle(&p, &m, p.size_usd, 1).is_ok());
        assert!(m.trader_pnl_usd(1).is_ok());
        assert!(short.trader_pnl_usd(2).is_ok());
    }

    #[test]
    fn a_healthy_short_stays_healthy_across_a_split() {
        let (mut m, p) = one_position(false, OLD);
        rescale_market(&mut m, 1, 4).unwrap();
        // The first post-split reading, one slot on: the oracle has the new
        // price, and the risk price must already be there.
        let oracle = px(NEW, 1_001);
        let risk = m.accept_price(&oracle, 11).unwrap();
        assert_eq!(risk, NEW);
        let (trigger, close) = liquidation_fills(&m, &oracle, risk, false).unwrap();
        let at_risk = settle(&p, &m, p.size_usd, trigger).unwrap();
        assert!(!below_maintenance(&m, &at_risk, p.size_usd).unwrap());
        // And a close now is flat but for the spread, not a wipe-out.
        let s = settle(&p, &m, p.size_usd, close).unwrap();
        assert!(s.equity_usd > 990_000_000, "equity {}", s.equity_usd);
    }

    #[test]
    fn a_reverse_split_leaves_a_healthy_long_healthy() {
        let (mut m, p) = one_position(true, NEW);
        rescale_market(&mut m, 4, 1).unwrap();
        let oracle = px(OLD, 1_001);
        let risk = m.accept_price(&oracle, 11).unwrap();
        assert_eq!(risk, OLD);
        let (trigger, _) = liquidation_fills(&m, &oracle, risk, true).unwrap();
        let at_risk = settle(&p, &m, p.size_usd, trigger).unwrap();
        assert!(!below_maintenance(&m, &at_risk, p.size_usd).unwrap());
    }

    #[test]
    fn a_stop_placed_before_a_split_fires_at_its_rebased_price() {
        let (mut m, _) = one_position(true, OLD);
        let mut o: Order =
            AnchorDeserialize::deserialize(&mut &[0u8; Order::INIT_SPACE][..]).unwrap();
        // A long's stop at $180, placed before the split.
        o.trigger_price = 180_000_000;
        o.trigger_above = false;
        o.trigger_factor = m.price_factor;
        rescale_market(&mut m, 1, 4).unwrap();
        assert_eq!(o.trigger_at(m.price_factor).unwrap(), 45_000_000);
        assert!(!o.is_triggered_at(NEW, m.price_factor).unwrap(), "$50 is above a $45 stop");
        assert!(o.is_triggered_at(45_000_000, m.price_factor).unwrap());
        // An order placed before orders carried a factor reads as placed
        // under the neutral one.
        o.trigger_factor = 0;
        assert_eq!(o.trigger_at(m.price_factor).unwrap(), 45_000_000);
    }

    #[test]
    fn an_open_batch_has_its_limits_rescaled_and_a_sealed_one_refuses() {
        let mut b: Box<Batch> = Box::new(bytemuck::Zeroable::zeroed());
        b.orders[0].price = OLD;
        b.orders[0].is_bid = 1;
        b.orders[0].active = 1;
        b.orders[1].price = OLD + 1;
        b.orders[1].is_bid = 0;
        b.orders[1].active = 1;
        b.order_count = 2;
        rescale_batch(&mut b, 1, 4).unwrap();
        assert_eq!(b.orders[0].price, NEW);
        // A sell's floor rounds up, a buy's ceiling down: neither is loosened.
        assert_eq!(b.orders[1].price, NEW + 1);
        b.cleared_ts = 1;
        b.unsettled = 1;
        assert!(rescale_batch(&mut b, 1, 4).is_err(), "cleared at the old price; settle it first");
    }

    #[test]
    fn an_observed_mark_moves_with_the_split() {
        let mut o: Observation =
            AnchorDeserialize::deserialize(&mut &[0u8; Observation::INIT_SPACE][..]).unwrap();
        o.ewma_price = OLD;
        o.last_spot = OLD;
        rescale_observation(&mut o, 1, 4).unwrap();
        assert_eq!((o.ewma_price, o.last_spot), (NEW, NEW));
    }

    #[test]
    fn an_unset_price_stays_unset_through_a_split() {
        assert_eq!(rescale_price(0, 1, 4, false).unwrap(), 0);
        assert_eq!(rescale_price(0, 4, 1, true).unwrap(), 0);
        let mut o = crate::state::observation::tests::obs();
        o.ewma_price = 0;
        o.last_spot = 0;
        rescale_observation(&mut o, 1, 4).unwrap();
        assert_eq!((o.ewma_price, o.last_spot), (0, 0), "a mark never read is not given one");
    }

    #[test]
    fn a_rescaled_price_rounds_the_way_asked_and_never_to_zero() {
        assert_eq!(rescale_price(10, 1, 4, false).unwrap(), 2);
        assert_eq!(rescale_price(10, 1, 4, true).unwrap(), 3);
        assert_eq!(rescale_price(12, 1, 4, true).unwrap(), 3, "exact needs no rounding");
        assert_eq!(rescale_price(1, 1, 1_000, false).unwrap(), 1, "floored at one unit");
        assert_eq!(rescale_price(u64::MAX, 2, 1, false).unwrap_err(), PerpError::MathOverflow.into());
    }

    #[test]
    fn a_split_that_would_zero_the_factor_is_refused() {
        let mut m = market();
        let f = m.price_factor;
        assert_eq!(rescale_market(&mut m, 1, u64::MAX).unwrap_err(), PerpError::MathOverflow.into());
        let mut m = market();
        m.price_factor = u128::MAX;
        assert_eq!(rescale_market(&mut m, 2, 1).unwrap_err(), PerpError::MathOverflow.into());
        // A reverse split multiplies the factor.
        let mut m = market();
        rescale_market(&mut m, 4, 1).unwrap();
        assert_eq!(m.price_factor, f * 4);
        assert_eq!(m.split_epoch, 1);
    }
}
