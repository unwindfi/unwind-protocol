use crate::auction::{
    band, clear_dual, dual_fill_for, AuctionOrder, DualBook, MAX_BATCH_ORDERS, PoolQuote,
};
use crate::constants::*;
use crate::errors::PerpError;
use crate::instructions::trade::{
    book_cleared_open, book_close_at, check_open, plan_open, BackerFeePaid, ProfitHaircut,
    PositionClosed,
};
use crate::math::*;
use crate::oracle::{read_observed_price, read_price, OraclePrice};
use crate::state::*;
use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};

/// Reads whichever mark this market is priced from.
///
/// The two sources return the same type and are checked the same way —
/// staleness, positive price, confidence against the market's ceiling — so
/// nothing downstream branches on it. A memecoin observed off a Raydium pool
/// and a tokenized equity read from Pyth are the same kind of thing by the
/// time they reach the clearing.
///
/// The account slot is shared. Which account is expected is decided by the
/// market, not by the caller, so handing it the wrong kind of account fails
/// the source's own validation rather than pricing against something else.
pub fn market_price(
    account: &AccountInfo,
    pool: &Pool,
    market: &Market,
    market_key: &Pubkey,
) -> Result<OraclePrice> {
    let price = match PriceSource::from_u8(market.price_source)? {
        PriceSource::Pyth => read_price(
            account,
            &pool.pyth_receiver,
            &market.feed_id,
            market.max_price_age_sec,
            market.max_conf_bps,
        )?,
        PriceSource::Observed => {
            require_keys_eq!(*account.key, market.observation, PerpError::WrongOracleFeed);
            // Deserialised by hand rather than through `Account::try_from`,
            // which would thread the account's lifetime through this signature
            // and out into every caller. `try_deserialize` checks the
            // discriminator; the owner check is the one it cannot do.
            require_keys_eq!(*account.owner, crate::ID, PerpError::WrongOracleOwner);
            let data = account.try_borrow_data()?;
            let observation = Observation::try_deserialize(&mut &data[..])?;
            read_observed_price(
                &observation,
                market_key,
                market.max_price_age_sec,
                market.max_conf_bps,
                DEPTH_CONF_REFERENCE_BPS,
            )?
        }
    };
    // Never older than a price the market has already acted on, even where
    // the caller only reads the market (valuing the pool for an LP) and so
    // cannot record this one. Writers go on to `Market::accept_price`.
    market.check_price_floor(&price)?;
    Ok(price)
}

#[derive(Accounts)]
pub struct CreateBatch<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(seeds = [POOL_SEED, pool.usdc_mint.as_ref()], bump = pool.bump)]
    pub pool: Box<Account<'info, Pool>>,

    #[account(has_one = pool @ PerpError::MarketPoolMismatch)]
    pub market: Box<Account<'info, Market>>,

    #[account(
        init,
        payer = payer,
        space = 8 + std::mem::size_of::<Batch>(),
        seeds = [BATCH_SEED, market.key().as_ref()],
        bump,
    )]
    pub batch: AccountLoader<'info, Batch>,

    pub system_program: Program<'info, System>,
}

/// Opens a market's first batch. Permissionless — it starts a clock and
/// nothing else, and a market without one simply cannot be traded.
pub fn create_batch(ctx: Context<CreateBatch>) -> Result<()> {
    let batch = &mut ctx.accounts.batch.load_init()?;
    batch.bump = ctx.bumps.batch;
    batch.market = ctx.accounts.market.key();
    batch.seq = 0;
    batch.opened_ts = Clock::get()?.unix_timestamp;
    batch.buy_price = 0;
    batch.buy_matched_usd = 0;
    batch.sell_price = 0;
    batch.sell_matched_usd = 0;
    batch.cleared_ts = 0;
    batch.unsettled = 0;
    batch.order_count = 0;
    Ok(())
}

#[derive(Accounts)]
pub struct SubmitOrder<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(mut, seeds = [POOL_SEED, pool.usdc_mint.as_ref()], bump = pool.bump)]
    pub pool: Box<Account<'info, Pool>>,

    #[account(has_one = pool @ PerpError::MarketPoolMismatch)]
    pub market: Box<Account<'info, Market>>,

    // Seeds are re-derived rather than checked against a stored bump: a
    // zero-copy account cannot be read inside a constraint, and deriving from
    // the market is the same guarantee by a shorter route.
    #[account(mut, seeds = [BATCH_SEED, market.key().as_ref()], bump)]
    pub batch: AccountLoader<'info, Batch>,

    #[account(address = pool.usdc_mint)]
    pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, address = pool.usdc_vault)]
    pub usdc_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        constraint = owner_usdc.mint == pool.usdc_mint,
        constraint = owner_usdc.owner == owner.key(),
    )]
    pub owner_usdc: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Created here rather than at settlement: settlement is permissionless,
    /// and a keeper has no claim on the trader's lamports to pay rent with.
    /// This is the moment the trader is signing anyway.
    #[account(
        init_if_needed,
        payer = owner,
        space = 8 + Position::INIT_SPACE,
        seeds = [POSITION_SEED, market.key().as_ref(), owner.key().as_ref()],
        bump,
    )]
    pub position: Box<Account<'info, Position>>,

    /// The wallet's referral and points record, made on its first order for
    /// the same reason the position is: this is when the owner is signing.
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

/// Puts an order into the market's collecting batch.
///
/// The collateral moves now rather than at settlement. Settlement is
/// permissionless and happens after the price is fixed, so there is no
/// signature available at that point to pull funds with — an order nobody has
/// funded is an order that cannot settle, and a batch full of those is a
/// clearing price that means nothing.
///
/// `price` is a limit, and it is the worst price the order will accept. It
/// fills at its flow's clearing price, which by construction is never worse.
///
/// `is_maker` puts the order on the resting side of the batch: it trades only
/// against takers, in the flow opposite its own side, and never against the
/// pool. A maker left unfilled when the batch seals is refunded like any other
/// order and quotes again into the next one.
pub fn submit_order(
    ctx: Context<SubmitOrder>,
    price: u64,
    size_usd: u64,
    collateral_usd: u64,
    is_bid: bool,
    reduce_only: bool,
    is_maker: bool,
) -> Result<()> {
    require!(!ctx.accounts.pool.paused, PerpError::PoolPaused);
    require!(price > 0, PerpError::InvalidParameter);
    let now = Clock::get()?.unix_timestamp;
    let trader_bump = ctx.bumps.trader;
    open_trader(&mut ctx.accounts.trader, ctx.accounts.owner.key(), trader_bump, now);

    // A paused market still lets people out. Pausing is for a listing that
    // should stop taking risk, and refusing exits while the index keeps moving
    // turns that into a trap for whoever was already in it.
    require!(
        !ctx.accounts.market.paused || reduce_only,
        PerpError::MarketPaused
    );

    if reduce_only {
        return submit_close(ctx, price, size_usd, is_bid, is_maker);
    }

    require!(
        size_usd >= ctx.accounts.market.min_position_usd,
        PerpError::PositionTooSmall
    );
    // Positions do not flip. An open against the side already held can never
    // be booked, so it is refused here, where the trader can be told, rather
    // than at settlement, where it used to fail and hold the whole batch.
    if ctx.accounts.position.is_open() {
        require!(
            ctx.accounts.position.is_long == is_bid,
            PerpError::PositionAlreadyOpen
        );
    }

    let route = FeeRoute::for_trade(
        &ctx.accounts.trader,
        &ctx.accounts.owner.key(),
        &ctx.accounts.market.deployer,
    );
    let open_fee = route.apply(bps_of(size_usd, ctx.accounts.market.open_fee_bps)?)?;
    require!(collateral_usd > open_fee, PerpError::ZeroAmount);

    let leverage_bps = (size_usd as u128)
        .checked_mul(BPS)
        .ok_or(PerpError::MathOverflow)?
        / (collateral_usd - open_fee) as u128;
    require!(
        leverage_bps <= ctx.accounts.market.effective_max_leverage_bps()? as u128,
        PerpError::LeverageTooHigh
    );
    admit_open(
        &ctx.accounts.pool,
        &ctx.accounts.market,
        &ctx.accounts.position,
        &*ctx.accounts.batch.load()?,
        is_bid,
        collateral_usd - open_fee,
        size_usd,
        price,
    )?;

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
        collateral_usd,
        ctx.accounts.usdc_mint.decimals,
    )?;

    let (index, seq) = {
        let batch = &mut ctx.accounts.batch.load_mut()?;
        let index = batch.insert(BatchOrder {
            owner: ctx.accounts.owner.key(),
            price,
            size_usd,
            collateral_usd,
            is_bid: is_bid as u8,
            filled_usd: 0,
            active: 1,
            reduce_only: 0,
            is_maker: is_maker as u8,
            _pad: [0; 4],
        })?;
        (index, batch.seq)
    };

    let pool = &mut ctx.accounts.pool;
    pool.escrow_usd = pool
        .escrow_usd
        .checked_add(collateral_usd)
        .ok_or(PerpError::MathOverflow)?;

    emit!(OrderSubmitted {
        market: ctx.accounts.market.key(),
        seq,
        index,
        owner: ctx.accounts.owner.key(),
        price,
        size_usd,
        is_bid,
        reduce_only: false,
        is_maker,
    });
    Ok(())
}

/// Every cap an open has to fit, asked as it enters a batch.
///
/// Settlement books whatever the clearing filled without asking again (see
/// `open_fill`), so this is where leverage and open interest are held. Leverage
/// is that of the position the open grows, net of funding it already owes.
/// Open interest counts every open already resting on the same side of this
/// batch, since all of them may fill: the side can end a batch at its cap and
/// never past it, unless the cap itself tightens before the batch settles.
#[allow(clippy::too_many_arguments)]
pub fn admit_open(
    pool: &Pool,
    market: &Market,
    position: &Position,
    batch: &Batch,
    is_long: bool,
    net_collateral: u64,
    size_usd: u64,
    price: u64,
) -> Result<()> {
    check_open(pool, market, position, is_long, net_collateral, size_usd, price)?;
    let side = if is_long { market.long_size_usd } else { market.short_size_usd };
    let pending = batch.pending_open_usd(is_long);
    let side_oi = (side as u128)
        .checked_add(pending)
        .and_then(|v| v.checked_add(size_usd as u128))
        .ok_or(PerpError::MathOverflow)?;
    require!(
        side_oi <= market.effective_oi_cap_usd(is_long)? as u128,
        PerpError::OpenInterestCapExceeded
    );
    Ok(())
}

/// Puts a closing order into the batch.
///
/// The asymmetry with an opening order is that nothing is escrowed: the
/// collateral behind this size is already in the vault, posted when the
/// position was opened. What is taken instead is a reservation against the
/// position, because otherwise the same size could be promised to any number
/// of resting orders and each settlement would unwind a position that only
/// ever covered the first of them.
///
/// The minimum-size floor is not applied here. It exists to stop dust
/// positions being opened, and a trader holding size below it still has to be
/// able to get out of it -- `book_close` enforces the floor on what is *left*,
/// which is the part that matters.
fn submit_close(
    ctx: Context<SubmitOrder>,
    price: u64,
    size_usd: u64,
    is_bid: bool,
    is_maker: bool,
) -> Result<()> {
    let position = &mut ctx.accounts.position;
    require!(position.is_open(), PerpError::PositionEmpty);
    // Closing a long sells and closing a short buys. Anything else is an open
    // wearing a reduce-only flag.
    require!(is_bid != position.is_long, PerpError::InvalidParameter);
    require!(size_usd > 0, PerpError::ZeroAmount);
    // No smaller than an open may be, unless it is all that is left. A
    // reduce-only order posts no collateral, so without a floor sixty-four
    // one-unit orders priced never to cross would fill the batch and block
    // every exit behind them. Closing out whatever remains is always allowed,
    // so a small position can still leave.
    require!(
        size_usd >= ctx.accounts.market.min_position_usd || size_usd == position.closable_usd(),
        PerpError::PositionTooSmall
    );
    position.reserve_close(size_usd)?;

    let (index, seq) = {
        let batch = &mut ctx.accounts.batch.load_mut()?;
        let index = batch.insert(BatchOrder {
            owner: ctx.accounts.owner.key(),
            price,
            size_usd,
            collateral_usd: 0,
            is_bid: is_bid as u8,
            filled_usd: 0,
            active: 1,
            reduce_only: 1,
            is_maker: is_maker as u8,
            _pad: [0; 4],
        })?;
        (index, batch.seq)
    };

    emit!(OrderSubmitted {
        market: ctx.accounts.market.key(),
        seq,
        index,
        owner: ctx.accounts.owner.key(),
        price,
        size_usd,
        is_bid,
        reduce_only: true,
        is_maker,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct CancelBatchOrder<'info> {
    pub owner: Signer<'info>,

    #[account(mut, seeds = [POOL_SEED, pool.usdc_mint.as_ref()], bump = pool.bump)]
    pub pool: Box<Account<'info, Pool>>,

    #[account(has_one = pool @ PerpError::MarketPoolMismatch)]
    pub market: Box<Account<'info, Market>>,

    // Seeds are re-derived rather than checked against a stored bump: a
    // zero-copy account cannot be read inside a constraint, and deriving from
    // the market is the same guarantee by a shorter route.
    #[account(mut, seeds = [BATCH_SEED, market.key().as_ref()], bump)]
    pub batch: AccountLoader<'info, Batch>,

    #[account(address = pool.usdc_mint)]
    pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, address = pool.usdc_vault)]
    pub usdc_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        constraint = owner_usdc.mint == pool.usdc_mint,
        constraint = owner_usdc.owner == owner.key(),
    )]
    pub owner_usdc: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Required even for an opening order, which does not touch it: the caller
    /// names an index and the order behind it may be either kind, and an
    /// account list cannot depend on data the runtime has not loaded yet.
    #[account(
        mut,
        seeds = [POSITION_SEED, market.key().as_ref(), owner.key().as_ref()],
        bump,
    )]
    pub position: Box<Account<'info, Position>>,

    pub token_program: Interface<'info, TokenInterface>,
}

/// Withdraws an order from the collecting batch and returns its collateral.
///
/// Only while the batch is still open. Once it is sealed the clearing price
/// has been computed against this order's presence — pulling it afterwards
/// would mean settling everyone else at a price derived from a book that no
/// longer exists.
pub fn cancel_batch_order(ctx: Context<CancelBatchOrder>, index: u8) -> Result<()> {
    let i = index as usize;
    require!(i < MAX_BATCH_ORDERS, PerpError::InvalidParameter);
    let (order, seq) = {
        let batch = ctx.accounts.batch.load()?;
        require!(batch.is_open(), PerpError::BatchSealed);
        (batch.orders[i], batch.seq)
    };
    require!(order.is_active(), PerpError::InvalidParameter);
    require_keys_eq!(order.owner, ctx.accounts.owner.key(), PerpError::Unauthorized);

    if order.reduces() {
        // Nothing was escrowed, so nothing comes back. What is returned is the
        // size the order had promised, which the position can now offer to
        // another one.
        ctx.accounts.position.release_close(order.size_usd);
    } else {
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
            order.collateral_usd,
            ctx.accounts.usdc_mint.decimals,
        )?;
        let pool = &mut ctx.accounts.pool;
        pool.escrow_usd = pool.escrow_usd.saturating_sub(order.collateral_usd);
    }

    {
        let batch = &mut ctx.accounts.batch.load_mut()?;
        batch.orders[i].active = 0;
        batch.touch(Clock::get()?.slot);
    }

    emit!(BatchOrderCancelled {
        market: ctx.accounts.market.key(),
        seq,
        index,
        owner: order.owner,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct ClearBatch<'info> {
    #[account(seeds = [POOL_SEED, pool.usdc_mint.as_ref()], bump = pool.bump)]
    pub pool: Box<Account<'info, Pool>>,

    #[account(mut, has_one = pool @ PerpError::MarketPoolMismatch)]
    pub market: Box<Account<'info, Market>>,

    // Seeds are re-derived rather than checked against a stored bump: a
    // zero-copy account cannot be read inside a constraint, and deriving from
    // the market is the same guarantee by a shorter route.
    #[account(mut, seeds = [BATCH_SEED, market.key().as_ref()], bump)]
    pub batch: AccountLoader<'info, Batch>,

    /// CHECK: validated against `pool.pyth_receiver` and the market's feed id.
    pub price_update: AccountInfo<'info>,
}

/// The most notional the pool may take in one batch before the reserve behind
/// it would pass the market's budget cap or the pool's utilization cap.
///
/// This is where the market's loss budget is enforced. The pool's share is
/// the only part of a batch that adds net exposure -- two traders crossing
/// each other net to nothing for the pool -- so it is the part that has to fit
/// under what is left. Settlement then books every fill without asking again,
/// because a sealed batch that cannot settle is a market nobody can trade or
/// leave. With no headroom the ceiling is zero, and the pool stops quoting.
pub fn pool_quote_ceiling(_pool: &Pool, _market: &Market) -> Result<u64> {
    // Nothing is reserved against a fill any more, so no reserve can run out:
    // the pool's share of a batch is held to its slice of the remaining
    // budget alone, and what a winner is eventually paid is held to what the
    // market can cover by the haircut at close.
    Ok(u64::MAX)
}

/// Seals a batch as two auctions: the buy flow, where takers buying meet
/// makers selling, and the sell flow, where takers selling meet makers buying.
/// Each seals at the price that crosses the most volume in it.
///
/// Permissionless, and deliberately free of judgement: the caller supplies no
/// price and chooses nothing. Everything this instruction does is a function
/// of orders already on the account and an oracle reading, so two people
/// racing to call it produce the same batch — the first simply wins, and the
/// second's transaction is a no-op rather than a different outcome.
pub fn clear_batch(ctx: Context<ClearBatch>) -> Result<()> {
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;
    {
        let batch = ctx.accounts.batch.load()?;
        require!(batch.is_open(), PerpError::BatchSealed);
        require!(batch.is_due(now), PerpError::BatchNotDue);
        // Not in the slot an order last went in or came out: the clear may
        // not share a transaction with a change to the book it clears.
        require!(batch.clearable_at(clock.slot), PerpError::BatchNotDue);
    }

    let market_key = ctx.accounts.market.key();
    let oracle = market_price(
        &ctx.accounts.price_update,
        &ctx.accounts.pool,
        &ctx.accounts.market,
        &market_key,
    )?;
    ctx.accounts.market.accept_price(&oracle, clock.slot)?;

    // The pool fills takers the makers left standing. Its size is capped out
    // of the budget it was listed with, so it can seed a market nobody is
    // making yet without becoming the price for anything large. Each flow may
    // use all of it: see `auction::clear_dual`.
    let quote_size = u64::try_from(
        (ctx.accounts.market.remaining_budget_usd() as u128)
            .checked_mul(POOL_QUOTE_BUDGET_BPS)
            .ok_or(PerpError::MathOverflow)?
            / BPS,
    )
    .map_err(|_| PerpError::MathOverflow)?
    .min(pool_quote_ceiling(&ctx.accounts.pool, &ctx.accounts.market)?);

    // Real orders only. The pool is not in this book — it is the counterparty
    // to whatever the book leaves standing, and it is priced afterwards.
    let mut book: Vec<AuctionOrder> = Vec::with_capacity(MAX_BATCH_ORDERS);
    {
        let batch = ctx.accounts.batch.load()?;
        for o in batch.orders.iter().filter(|o| o.is_active()) {
            book.push(AuctionOrder {
                price: o.price,
                size: o.size_usd,
                is_bid: o.bid(),
                is_maker: o.maker(),
            });
        }
    }

    // Nothing trades outside this band around the oracle, the pool included:
    // see `auction::band`. Narrower of the market's widest spread and half its
    // maintenance margin, so that a position opened at the band's edge is
    // never already past its own liquidation.
    let (lo, hi) = ctx.accounts.market.price_band(oracle.price)?;
    band(&mut book, lo, hi);
    // Traders net long leave the pool net short, so the sell flow (where the
    // pool buys) shrinks it, by up to that imbalance; and the other way round.
    let (long_oi, short_oi) = (ctx.accounts.market.long_size_usd, ctx.accounts.market.short_size_usd);
    let quote = PoolQuote {
        bid: ctx.accounts.market.fill_price(&oracle, false)?.max(lo),
        ask: ctx.accounts.market.fill_price(&oracle, true)?.min(hi),
        size: quote_size,
        reducing_buy_flow: short_oi.saturating_sub(long_oi),
        reducing_sell_flow: long_oi.saturating_sub(short_oi),
    };
    let flows = DualBook::split(&book);
    let cleared = clear_dual(&flows, &quote, oracle.price)?;
    let batch = &mut ctx.accounts.batch.load_mut()?;

    if !cleared.traded() {
        // Nothing crossed in either flow. The batch seals all the same, with
        // every order unfilled: each settles and is refunded, and the next
        // batch opens when the last one has. See `Batch::seal_unfilled`.
        let seq = batch.seq;
        batch.seal_unfilled(now);
        emit!(BatchCleared {
            market: batch.market,
            seq,
            buy_price: 0,
            buy_matched_usd: 0,
            sell_price: 0,
            sell_matched_usd: 0,
            orders: batch.unsettled,
            pool_bought: 0,
            pool_sold: 0,
        });
        return Ok(());
    }

    // Fills are resolved here, against the book exactly as it cleared, each
    // order against its own flow. An order whose flow did not trade fills
    // nothing and is refunded at settlement.
    let mut cursor = 0usize;
    for slot in batch.orders.iter_mut() {
        if slot.active == 0 {
            continue;
        }
        slot.filled_usd = dual_fill_for(&book[cursor], &flows, &cleared)?;
        cursor += 1;
    }

    let (buy, sell) = (cleared.buy.unwrap_or_default(), cleared.sell.unwrap_or_default());
    batch.buy_price = buy.price;
    batch.buy_matched_usd = buy.matched;
    batch.sell_price = sell.price;
    batch.sell_matched_usd = sell.matched;
    batch.cleared_ts = now;
    batch.unsettled = batch.orders.iter().filter(|o| o.is_active()).count() as u8;
    emit!(BatchCleared {
        market: batch.market,
        seq: batch.seq,
        buy_price: buy.price,
        buy_matched_usd: buy.matched,
        sell_price: sell.price,
        sell_matched_usd: sell.matched,
        orders: batch.unsettled,
        // The pool's share of the fill, published every batch. This is the
        // number the whole design is judged on: if it does not fall as real
        // makers arrive, the price is still the pool's. It sells only in the
        // buy flow and buys only in the sell flow.
        pool_bought: sell.pool_bought,
        pool_sold: buy.pool_sold,
    });
    Ok(())
}

#[event]
pub struct OrderSubmitted {
    pub market: Pubkey,
    pub seq: u64,
    pub index: u8,
    pub owner: Pubkey,
    pub price: u64,
    pub size_usd: u64,
    pub is_bid: bool,
    pub reduce_only: bool,
    pub is_maker: bool,
}

#[event]
pub struct BatchOrderCancelled {
    pub market: Pubkey,
    pub seq: u64,
    pub index: u8,
    pub owner: Pubkey,
}

#[event]
pub struct BatchCleared {
    pub market: Pubkey,
    pub seq: u64,
    /// Zero for a flow that did not trade.
    pub buy_price: u64,
    pub buy_matched_usd: u64,
    pub sell_price: u64,
    pub sell_matched_usd: u64,
    pub orders: u8,
    pub pool_bought: u64,
    pub pool_sold: u64,
}

#[derive(Accounts)]
#[instruction(index: u8)]
pub struct SettleOrder<'info> {
    #[account(mut, seeds = [POOL_SEED, pool.usdc_mint.as_ref()], bump = pool.bump)]
    pub pool: Box<Account<'info, Pool>>,

    #[account(mut, has_one = pool @ PerpError::MarketPoolMismatch)]
    pub market: Box<Account<'info, Market>>,

    // Seeds are re-derived rather than checked against a stored bump: a
    // zero-copy account cannot be read inside a constraint, and deriving from
    // the market is the same guarantee by a shorter route.
    #[account(mut, seeds = [BATCH_SEED, market.key().as_ref()], bump)]
    pub batch: AccountLoader<'info, Batch>,

    /// CHECK: matched against the order's recorded owner, and the position
    /// this settles into is that owner's PDA — so a wrong account here fails
    /// the seed check rather than settling into someone else's position.
    pub owner: AccountInfo<'info>,

    #[account(
        mut,
        seeds = [POSITION_SEED, market.key().as_ref(), owner.key().as_ref()],
        bump,
    )]
    pub position: Box<Account<'info, Position>>,

    #[account(address = pool.usdc_mint)]
    pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, address = pool.usdc_vault)]
    pub usdc_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        constraint = owner_usdc.mint == pool.usdc_mint,
        constraint = owner_usdc.owner == owner.key(),
    )]
    pub owner_usdc: Box<InterfaceAccount<'info, TokenAccount>>,

    /// CHECK: the owner's `Trader`, by seed. Read and written by hand rather
    /// than as an `Account`, because it may not exist: a wallet whose only
    /// order came from a trigger has never signed for one, and a settlement
    /// that failed on a missing account would hold the whole batch. Without
    /// one the order settles at the full fee and earns nothing.
    #[account(mut, seeds = [TRADER_SEED, owner.key().as_ref()], bump)]
    pub trader: UncheckedAccount<'info>,

    pub token_program: Interface<'info, TokenInterface>,
}

/// Fills in a `Trader` the first time it is used.
pub fn open_trader(trader: &mut Trader, owner: Pubkey, bump: u8, now: i64) {
    if trader.owner == Pubkey::default() {
        trader.bump = bump;
        trader.owner = owner;
        trader.created_ts = now;
        trader.backing_ts = now;
        trader.lp_ts = now;
    }
}

/// The owner's `Trader`, if it exists.
///
/// One from before `Trader` grew, and not yet grown by `resize_trader`, is
/// treated as missing: it is too short to read or write back, and failing
/// here would hold the whole batch. Its order settles at the full fee and
/// earns nothing.
fn load_trader(info: &AccountInfo) -> Result<Option<Trader>> {
    if info.owner != &crate::ID || info.data_len() < 8 + Trader::INIT_SPACE {
        return Ok(None);
    }
    let data = info.try_borrow_data()?;
    Ok(Some(Trader::try_deserialize(&mut &data[..])?))
}

fn store_trader(info: &AccountInfo, trader: &Trader) -> Result<()> {
    let mut data = info.try_borrow_mut_data()?;
    trader.try_serialize(&mut &mut data[..])
}

/// Books the referral and listing side of one fill: the rewards carved out of
/// the protocol's cut, the points, and the market's volume.
///
/// `held_secs` is how long the size closed was held, for a close, and `None`
/// for an open, which earns no points. A close earns the trader points on both
/// legs if it was held `MIN_HOLD_SECS` (`Trader::credit_held_close`), and the
/// deployer `DEPLOYER_POINTS_BPS` of what the trader was credited, unless the
/// trader is the deployer.
#[allow(clippy::too_many_arguments)]
fn credit_fill(
    pool: &mut Pool,
    market: &mut Market,
    market_key: Pubkey,
    trader: Option<&mut Trader>,
    route: &FeeRoute,
    owner: Pubkey,
    filled_usd: u64,
    fee_usd: u64,
    full_fee_usd: u64,
    held_secs: Option<i64>,
    now: i64,
) -> Result<()> {
    if filled_usd == 0 {
        return Ok(());
    }
    let share = pool.protocol_fee_share_bps;
    let (to_referrer, to_deployer) = carve_rewards(
        &mut pool.protocol_fees_usd,
        &mut pool.rewards_usd,
        share,
        fee_usd,
        route,
    )?;
    market.volume_usd = market.volume_usd.saturating_add(filled_usd);
    // Counted as synced at once: the deployer's points come from
    // `deployer_points_owed` now, and the gap between the two is only what
    // was traded before that existed.
    market.deployer_synced_volume_usd =
        market.deployer_synced_volume_usd.saturating_add(filled_usd);
    market.deployer_rewards_usd = market
        .deployer_rewards_usd
        .checked_add(to_deployer)
        .ok_or(PerpError::MathOverflow)?;
    market.deployer_earned_usd = market.deployer_earned_usd.saturating_add(to_deployer);
    let saved = full_fee_usd.saturating_sub(fee_usd);
    if let Some(t) = trader {
        if !pool.no_points {
            t.credit_fill(filled_usd, saved)?;
            if let Some(held) = held_secs {
                let credited = t.credit_held_close(filled_usd, held, now)?;
                let deployer = market.deployer;
                if deployer != Pubkey::default() && owner != deployer {
                    market.deployer_points_owed = market
                        .deployer_points_owed
                        .checked_add(bps_of(credited, DEPLOYER_POINTS_BPS)?)
                        .ok_or(PerpError::MathOverflow)?;
                }
            }
        }
        t.referrer_rewards_owed = t
            .referrer_rewards_owed
            .checked_add(to_referrer)
            .ok_or(PerpError::MathOverflow)?;
        t.given_to_referrer_usd = t.given_to_referrer_usd.saturating_add(to_referrer);
    }
    if to_referrer > 0 || to_deployer > 0 || saved > 0 {
        emit!(FeeRewards {
            market: market_key,
            owner,
            fee_usd,
            discount_usd: saved,
            to_referrer_usd: to_referrer,
            to_deployer_usd: to_deployer,
        });
    }
    Ok(())
}

/// A fill's fee, and who it was split with besides the usual lines.
#[event]
pub struct FeeRewards {
    pub market: Pubkey,
    pub owner: Pubkey,
    pub fee_usd: u64,
    pub discount_usd: u64,
    pub to_referrer_usd: u64,
    pub to_deployer_usd: u64,
}

/// How much of an opening order actually lands: `(filled, collateral used,
/// open fee)`.
///
/// An open the clearing filled books. The leverage and open interest caps
/// were asked when it entered the batch (`admit_open`) and are not asked
/// again: a cross between two traders is net zero for the pool only while
/// both legs book, and a refusal here depended on which orders a caller chose
/// to settle first, so one leg could be sent home while the other booked at
/// the band's edge against the pool alone.
///
/// What is left goes home unfilled rather than failing, because a failed
/// settlement holds the whole batch: a fill too small for its collateral to
/// cover its fee (a unit or two of rounding), arithmetic that cannot be held,
/// and the same owner holding the other side, which `Batch::insert` keeps out
/// of a batch in the first place.
pub fn open_fill(
    pool: &Pool,
    market: &Market,
    position: &Position,
    order: &BatchOrder,
    clearing: u64,
    discount_bps: u16,
) -> Result<(u64, u64, u64)> {
    const UNFILLED: (u64, u64, u64) = (0, 0, 0);
    // Clearing never fills an order past its size; this makes that true here
    // too, because collateral is scaled by the fill and anything past the size
    // would be collateral nobody escrowed.
    let filled = order.filled_usd.min(order.size_usd);
    if filled == 0 || (position.is_open() && position.is_long != order.bid()) {
        return Ok(UNFILLED);
    }
    // Collateral follows the fill: an order half filled puts up half of what
    // it posted, and the rest goes home.
    let used = mul_div_u64(order.collateral_usd, filled as u128, order.size_usd as u128)?;
    let full_fee = bps_of(filled, market.open_fee_bps)?;
    let open_fee = full_fee - bps_of(full_fee, discount_bps)?;
    if used <= open_fee {
        return Ok(UNFILLED);
    }
    if plan_open(pool, market, position, order.bid(), used - open_fee, filled, clearing, false)
        .is_err()
    {
        return Ok(UNFILLED);
    }
    Ok((filled, used, open_fee))
}

/// Settles one order of a sealed batch at its flow's clearing price.
///
/// Permissionless. Anyone may settle anyone's order, because settlement has no
/// discretion in it: the price was fixed when the batch sealed and the fill
/// was computed against the book as it stood. The only question left is moving
/// the money, and letting a stranger do it is what keeps a trader's position
/// from depending on their own liveness.
///
/// Partial fills return the unused collateral immediately rather than rolling
/// it into the next batch. An order is a decision about one clearing price; if
/// the trader wants the remainder at the next one, that is a new decision.
pub fn settle_order(ctx: Context<SettleOrder>, index: u8) -> Result<()> {
    let i = index as usize;
    require!(i < MAX_BATCH_ORDERS, PerpError::InvalidParameter);
    let (order, clearing) = {
        let batch = ctx.accounts.batch.load()?;
        require!(!batch.is_open(), PerpError::BatchNotDue);
        // Each order settles at its own flow's price, not a batch-wide one.
        (batch.orders[i], batch.price_for(&batch.orders[i]))
    };
    require!(order.is_active(), PerpError::InvalidParameter);
    require_keys_eq!(order.owner, ctx.accounts.owner.key(), PerpError::Unauthorized);

    let trader_info = ctx.accounts.trader.to_account_info();
    let mut trader = load_trader(&trader_info)?;
    let pool_key = ctx.accounts.pool.key();
    let route = match trader.as_mut() {
        Some(t) => FeeRoute::for_trade_in(
            t,
            &order.owner,
            &ctx.accounts.market.deployer,
            pool_key,
            ctx.accounts.pool.no_points,
        ),
        None => FeeRoute {
            deployer: order.owner != ctx.accounts.market.deployer
                && ctx.accounts.market.deployer != Pubkey::default(),
            ..FeeRoute::default()
        },
    };

    if order.reduces() {
        settle_close(ctx, index, order, clearing, trader.as_mut(), &route)?;
        if let Some(t) = &trader {
            store_trader(&trader_info, t)?;
        }
        return Ok(());
    }

    let (filled, used, open_fee) = open_fill(
        &ctx.accounts.pool,
        &ctx.accounts.market,
        &ctx.accounts.position,
        &order,
        clearing,
        route.discount_bps,
    )?;
    let refund = order.collateral_usd.saturating_sub(used);

    if refund > 0 {
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
            refund,
            ctx.accounts.usdc_mint.decimals,
        )?;
    }
    ctx.accounts.pool.escrow_usd = ctx
        .accounts
        .pool
        .escrow_usd
        .saturating_sub(order.collateral_usd);

    if filled > 0 {
        let now = Clock::get()?.unix_timestamp;
        // Bring funding up to now before the position snapshots the index.
        // Without it the snapshot is whatever the last accrual left, and the
        // next accrual charges this size for time before it existed -- priced
        // off a skew it did not yet contribute to. A top-up has the mirror
        // problem: its existing size would settle funding short of now.
        let utilization = ctx.accounts.market.utilization_bps(ctx.accounts.pool.liquidity_usd);
        ctx.accounts.market.accrue_funding(now, utilization)?;
        let market_key = ctx.accounts.market.key();
        // `open_fill` only returns a fill whose collateral covers its fee.
        let net_collateral = used - open_fee;

        let position_bump = ctx.bumps.position;
        let to_backers = book_cleared_open(
            &mut ctx.accounts.pool,
            &mut ctx.accounts.market,
            &mut ctx.accounts.position,
            order.owner,
            position_bump,
            order.bid(),
            net_collateral,
            open_fee,
            market_key,
            filled,
            clearing,
            now,
        )?;
        if to_backers > 0 {
            emit!(BackerFeePaid {
                market: market_key,
                amount_usd: to_backers,
                backing_usd: ctx.accounts.market.backing_usd,
                backing_shares: ctx.accounts.market.backing_shares,
            });
        }
        let full_fee = bps_of(filled, ctx.accounts.market.open_fee_bps)?;
        credit_fill(
            &mut ctx.accounts.pool,
            &mut ctx.accounts.market,
            market_key,
            trader.as_mut(),
            &route,
            order.owner,
            filled,
            open_fee,
            full_fee,
            None,
            now,
        )?;
        if let Some(t) = &trader {
            store_trader(&trader_info, t)?;
        }
    }

    let batch = &mut ctx.accounts.batch.load_mut()?;
    batch.orders[i].active = 0;
    batch.unsettled = batch.unsettled.saturating_sub(1);

    emit!(OrderSettled {
        market: batch.market,
        seq: batch.seq,
        index,
        owner: order.owner,
        filled_usd: filled,
        price: clearing,
        refunded_usd: refund,
    });

    // The last settlement opens the next batch, so nothing external has to
    // decide when a market starts collecting again.
    if batch.unsettled == 0 {
        let now = Clock::get()?.unix_timestamp;
        batch.roll(now);
    }
    Ok(())
}

/// Settles a reduce-only order: unwinds position size at the batch's price.
///
/// Nothing is refunded, because nothing was escrowed -- the payout is the
/// position's own equity, which `book_close` computes. What always happens is
/// the release of the reservation this order took at submission, whether or
/// not it filled and whether or not the position is still there.
fn settle_close(
    ctx: Context<SettleOrder>,
    index: u8,
    order: BatchOrder,
    clearing: u64,
    trader: Option<&mut Trader>,
    route: &FeeRoute,
) -> Result<()> {
    let i = index as usize;
    ctx.accounts.position.release_close(order.size_usd);

    // A liquidation does not consult the orders resting against a position, so
    // by the time this runs the size may be smaller than the fill, gone
    // altogether, or reopened on the other side. Close what is actually there,
    // and only if it is still the side this order was placed to close.
    //
    // The counterparty is unaffected: positions are held against the pool, and
    // the auction sets the price rather than pairing traders off. An order that
    // informed the clearing and then delivered less leaves the pool's books
    // consistent -- it only means one of the prices in that batch came from
    // someone who had already been closed out.
    //
    // Reopened on the same side counts too: a long liquidated and bought
    // again by the owner's own order in this batch is not the long this sell
    // was placed to close (`Position::closable_in`).
    let opened_ts = ctx.accounts.batch.load()?.opened_ts;
    let close_size = ctx
        .accounts
        .position
        .closable_in(order.bid(), order.filled_usd, opened_ts);
    let now = Clock::get()?.unix_timestamp;

    if close_size > 0 {
        let utilization = ctx.accounts.market.utilization_bps(ctx.accounts.pool.liquidity_usd);
        ctx.accounts.market.accrue_funding(now, utilization)?;
        // A close always fills in full. The budget is kept by what it pays,
        // not by how much of it fills: profit past what the market can cover
        // is cut to a fair share in `book_close_at`. Filling only as far as
        // the budget reached left winners holding positions they could not
        // leave, and paid whoever closed first in full.
    }

    if close_size > 0 {
        // Read before the close, which resets the clock of a position it empties.
        let held_secs = ctx.accounts.position.held_secs(now);
        let closed = book_close_at(
            &mut ctx.accounts.pool,
            &mut ctx.accounts.market,
            &mut ctx.accounts.position,
            close_size,
            clearing,
            now,
            route.discount_bps,
        )?;
        let payout = closed.payout_usd;

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

        emit!(PositionClosed {
            position: ctx.accounts.position.key(),
            owner: order.owner,
            market: ctx.accounts.market.key(),
            is_long: !order.bid(),
            size_usd: close_size,
            fill_price: clearing,
            pnl_usd: closed.pnl_usd,
            funding_usd: closed.funding_usd,
            fee_usd: closed.fee_usd,
            payout_usd: payout,
        });
        if closed.haircut_usd > 0 {
            emit!(ProfitHaircut {
                position: ctx.accounts.position.key(),
                owner: order.owner,
                market: ctx.accounts.market.key(),
                haircut_usd: closed.haircut_usd,
                payout_usd: payout,
            });
        }
        if closed.backer_fee_usd > 0 {
            emit!(BackerFeePaid {
                market: ctx.accounts.market.key(),
                amount_usd: closed.backer_fee_usd,
                backing_usd: ctx.accounts.market.backing_usd,
                backing_shares: ctx.accounts.market.backing_shares,
            });
        }
        // The fee before any discount, capped the same way the charged one
        // was, so a fee swallowed by a wiped-out position reads as no saving.
        let full_fee = bps_of(close_size, ctx.accounts.market.close_fee_bps)?
            .min(closed.payout_usd.saturating_add(closed.fee_usd));
        let market_key = ctx.accounts.market.key();
        credit_fill(
            &mut ctx.accounts.pool,
            &mut ctx.accounts.market,
            market_key,
            trader,
            route,
            order.owner,
            close_size,
            closed.fee_usd,
            full_fee,
            Some(held_secs),
            now,
        )?;
    }

    let batch = &mut ctx.accounts.batch.load_mut()?;
    batch.orders[i].active = 0;
    batch.unsettled = batch.unsettled.saturating_sub(1);

    emit!(OrderSettled {
        market: batch.market,
        seq: batch.seq,
        index,
        owner: order.owner,
        filled_usd: close_size,
        price: clearing,
        refunded_usd: 0,
    });

    if batch.unsettled == 0 {
        let now = Clock::get()?.unix_timestamp;
        batch.roll(now);
    }
    Ok(())
}

#[event]
pub struct OrderSettled {
    pub market: Pubkey,
    pub seq: u64,
    pub index: u8,
    pub owner: Pubkey,
    pub filled_usd: u64,
    pub price: u64,
    pub refunded_usd: u64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::instructions::trade::tests as t;

    const FILL: u64 = 1_000_000_000_000; // $1m
    const NOON: i64 = 20_000 * 86_400 + 43_200;

    /// S2-05. A pool someone other than the upgrade authority created earns
    /// nobody points: not the trader's volume, not the referrer's cut of it,
    /// and not the deployer's on the market's volume.
    #[test]
    fn a_fill_in_a_pool_that_earns_no_points_earns_none() {
        let (mut p, mut m) = (t::pool(), t::market());
        let mut tr = crate::state::trader::tests::trader();
        tr.referrer = Pubkey::new_unique();
        tr.held_volume_usd = REFERRAL_MIN_HELD_VOLUME_USD;
        let owner = tr.owner;
        m.deployer = Pubkey::new_unique();
        let route = FeeRoute { referrer: false, deployer: true, discount_bps: 0 };
        p.no_points = true;
        credit_fill(&mut p, &mut m, Pubkey::new_unique(), Some(&mut tr), &route,
                    owner, FILL, 0, 0, Some(3_600), NOON).unwrap();
        assert_eq!((tr.points, tr.referrer_points_owed), (0, 0));
        assert_eq!(m.volume_usd, FILL, "the market's volume is still counted");
        assert_eq!(m.deployer_synced_volume_usd, m.volume_usd, "but owes its deployer no points");
        assert_eq!(m.deployer_points_owed, 0);

        // The same close in a pool that earns pays them all.
        p.no_points = false;
        credit_fill(&mut p, &mut m, Pubkey::new_unique(), Some(&mut tr), &route,
                    owner, 100_000_000, 0, 0, Some(3_600), NOON).unwrap();
        assert!(tr.points > 0 && tr.referrer_points_owed > 0);
        assert_eq!(m.deployer_points_owed, tr.points / 10);
    }

    #[test]
    fn an_open_earns_nobody_points() {
        let (mut p, mut m) = (t::pool(), t::market());
        let mut tr = crate::state::trader::tests::trader();
        m.deployer = Pubkey::new_unique();
        let owner = tr.owner;
        let route = FeeRoute { referrer: false, deployer: true, discount_bps: 0 };
        credit_fill(&mut p, &mut m, Pubkey::new_unique(), Some(&mut tr), &route,
                    owner, FILL, 0, 0, None, NOON).unwrap();
        assert_eq!((tr.points, tr.volume_usd), (0, FILL));
        assert_eq!(m.deployer_points_owed, 0);
        assert_eq!(m.volume_usd, m.deployer_synced_volume_usd, "nothing for the deployer to sync");
    }

    #[test]
    fn a_deployer_earns_nothing_on_their_own_trades() {
        let (mut p, mut m) = (t::pool(), t::market());
        let mut tr = crate::state::trader::tests::trader();
        let owner = tr.owner;
        m.deployer = owner;
        let route = FeeRoute::for_trade(&tr, &owner, &m.deployer);
        assert!(!route.deployer, "no USDC share of their own fees");
        credit_fill(&mut p, &mut m, Pubkey::new_unique(), Some(&mut tr), &route,
                    owner, 1_000_000_000, 1_000_000, 2_000_000, Some(3_600), NOON).unwrap();
        assert_eq!(tr.points, 2_000_000_000, "the deployer still earns as a trader");
        assert_eq!(m.deployer_points_owed, 0, "and nothing as the deployer");
        assert_eq!(m.deployer_rewards_usd, 0);
        assert_eq!(m.volume_usd, 1_000_000_000, "the volume is still shown");

        // Somebody else's close on the same market pays the deployer a tenth.
        let mut other = crate::state::trader::tests::trader();
        let who = other.owner;
        let route = FeeRoute::for_trade(&other, &who, &m.deployer);
        credit_fill(&mut p, &mut m, Pubkey::new_unique(), Some(&mut other), &route,
                    who, 1_000_000_000, 1_000_000, 1_000_000, Some(3_600), NOON).unwrap();
        assert_eq!(m.deployer_points_owed, 200_000_000);
    }

    #[test]
    fn a_quick_close_earns_the_deployer_nothing_either() {
        let (mut p, mut m) = (t::pool(), t::market());
        let mut tr = crate::state::trader::tests::trader();
        m.deployer = Pubkey::new_unique();
        let owner = tr.owner;
        let route = FeeRoute::for_trade(&tr, &owner, &m.deployer);
        credit_fill(&mut p, &mut m, Pubkey::new_unique(), Some(&mut tr), &route,
                    owner, FILL, 0, 0, Some(MIN_HOLD_SECS - 1), NOON).unwrap();
        assert_eq!((tr.points, m.deployer_points_owed), (0, 0));
    }

    /// Opens through the booking a settlement uses, adds, and closes: the
    /// add moves the held clock, so the close earns only once the blended
    /// size has been held ten minutes.
    #[test]
    fn an_add_then_a_close_is_timed_from_the_weighted_open() {
        let (mut p, mut m) = (t::pool(), t::market());
        let mut pos = t::position();
        let owner = Pubkey::new_unique();
        let size = 1_000_000_000; // $1,000
        book_cleared_open(&mut p, &mut m, &mut pos, owner, 1, true, size / 2, 0,
                          Pubkey::new_unique(), size, t::PX, NOON).unwrap();
        assert_eq!(pos.held_ts, NOON);
        // As much again, ten minutes later: held five minutes on average.
        book_cleared_open(&mut p, &mut m, &mut pos, owner, 1, true, size / 2, 0,
                          Pubkey::new_unique(), size, t::PX, NOON + 600).unwrap();
        assert_eq!(pos.held_ts, NOON + 300);
        assert_eq!(pos.held_secs(NOON + 600), 300);

        let mut tr = crate::state::trader::tests::trader();
        let route = FeeRoute::default();
        credit_fill(&mut p, &mut m, Pubkey::new_unique(), Some(&mut tr), &route,
                    owner, size, 0, 0, Some(pos.held_secs(NOON + 600)), NOON + 600).unwrap();
        assert_eq!(tr.points, 0, "five minutes is not ten");
        credit_fill(&mut p, &mut m, Pubkey::new_unique(), Some(&mut tr), &route,
                    owner, size, 0, 0, Some(pos.held_secs(NOON + 900)), NOON + 900).unwrap();
        assert_eq!(tr.points, 2 * size, "ten minutes on the blended clock");
    }
}
