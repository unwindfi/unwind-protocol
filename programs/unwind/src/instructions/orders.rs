use crate::constants::*;
use crate::errors::PerpError;
use crate::math::*;
use crate::instructions::batch::market_price;
use crate::state::*;
use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct OrderParams {
    pub slot: u8,
    pub kind: u8,
    pub is_long: bool,
    pub size_usd: u64,
    pub collateral_usd: u64,
    pub trigger_price: u64,
    pub trigger_above: bool,
    pub expiry_ts: i64,
}

#[derive(Accounts)]
#[instruction(params: OrderParams)]
pub struct PlaceOrder<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(mut, seeds = [POOL_SEED, pool.usdc_mint.as_ref()], bump = pool.bump)]
    pub pool: Box<Account<'info, Pool>>,

    #[account(
        has_one = pool @ PerpError::MarketPoolMismatch,
        seeds = [MARKET_SEED, pool.key().as_ref(), market.feed_id.as_ref()],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, Market>>,

    #[account(
        init,
        payer = owner,
        space = 8 + Order::INIT_SPACE,
        seeds = [ORDER_SEED, market.key().as_ref(), owner.key().as_ref(), &[params.slot]],
        bump,
    )]
    pub order: Box<Account<'info, Order>>,

    /// Created here rather than at execution: the keeper has no claim on the
    /// trader's lamports, and this is the moment the trader is signing anyway.
    #[account(
        init_if_needed,
        payer = owner,
        space = 8 + Position::INIT_SPACE,
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

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

/// Records a price trigger. Nothing is reserved and nothing is charged: the
/// order is a standing instruction, and it is only worth anything if the
/// position it refers to still exists when the price gets there.
pub fn place_order(ctx: Context<PlaceOrder>, params: OrderParams) -> Result<()> {
    let kind = OrderKind::from_u8(params.kind)?;
    require!(params.trigger_price > 0, PerpError::InvalidParameter);

    let clock = Clock::get()?;
    require!(
        params.expiry_ts == 0 || params.expiry_ts > clock.unix_timestamp,
        PerpError::InvalidParameter
    );

    // An open order's collateral is taken now. Execution is permissionless, so
    // there is no signature at that point to pull funds with — the money has to
    // already be here, or the order is one the keeper can never fill.
    let mut escrow = 0u64;
    if kind == OrderKind::Open {
        require!(
            params.size_usd >= ctx.accounts.market.min_position_usd,
            PerpError::PositionTooSmall
        );
        let fee = bps_of(params.size_usd, ctx.accounts.market.open_fee_bps)?;
        require!(params.collateral_usd > fee, PerpError::ZeroAmount);

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
            params.collateral_usd,
            ctx.accounts.usdc_mint.decimals,
        )?;
        escrow = params.collateral_usd;
        ctx.accounts.pool.escrow_usd = ctx
            .accounts
            .pool
            .escrow_usd
            .checked_add(escrow)
            .ok_or(PerpError::MathOverflow)?;
    }

    // `init_if_needed` allocates the position but writes none of its identity,
    // and execution derives the account from `position.bump`. Left at zero that
    // fails the seeds check — the order escrows fine, looks live, and can never
    // fill. Stamp it here, on the one path that creates it.
    {
        let position = &mut ctx.accounts.position;
        if position.owner == Pubkey::default() {
            position.bump = ctx.bumps.position;
            position.owner = ctx.accounts.owner.key();
            position.market = ctx.accounts.market.key();
        }
    }

    let order = &mut ctx.accounts.order;
    order.bump = ctx.bumps.order;
    order.owner = ctx.accounts.owner.key();
    order.market = ctx.accounts.market.key();
    order.slot = params.slot;
    order.kind = params.kind;
    order.is_long = params.is_long;
    order.size_usd = params.size_usd;
    order.collateral_usd = escrow;
    order.trigger_price = params.trigger_price;
    order.trigger_above = params.trigger_above;
    order.created_ts = clock.unix_timestamp;
    order.expiry_ts = params.expiry_ts;

    emit!(OrderPlaced {
        order: order.key(),
        owner: order.owner,
        market: order.market,
        slot: order.slot,
        kind: order.kind,
        trigger_price: order.trigger_price,
        trigger_above: order.trigger_above,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct CancelOrder<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(mut, seeds = [POOL_SEED, pool.usdc_mint.as_ref()], bump = pool.bump)]
    pub pool: Box<Account<'info, Pool>>,

    #[account(
        mut,
        close = owner,
        has_one = owner @ PerpError::Unauthorized,
        seeds = [ORDER_SEED, order.market.as_ref(), owner.key().as_ref(), &[order.slot]],
        bump = order.bump,
    )]
    pub order: Box<Account<'info, Order>>,

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

    pub token_program: Interface<'info, TokenInterface>,
}

/// Cancels an order and returns anything escrowed against it.
pub fn cancel_order(ctx: Context<CancelOrder>) -> Result<()> {
    let refund = ctx.accounts.order.collateral_usd;
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
        ctx.accounts.pool.escrow_usd = ctx.accounts.pool.escrow_usd.saturating_sub(refund);
    }

    emit!(OrderCancelled {
        order: ctx.accounts.order.key(),
        owner: ctx.accounts.owner.key(),
        refunded_usd: refund,
    });
    Ok(())
}

/// Returns escrowed collateral from the vault to its owner.
fn refund_escrow<'info>(
    pool: &Account<'info, Pool>,
    usdc_mint: &InterfaceAccount<'info, Mint>,
    usdc_vault: &InterfaceAccount<'info, TokenAccount>,
    owner_usdc: &InterfaceAccount<'info, TokenAccount>,
    token_program: &Interface<'info, TokenInterface>,
    amount: u64,
) -> Result<()> {
    let usdc_mint_key = pool.usdc_mint;
    let bump = pool.bump;
    let signer_seeds: &[&[&[u8]]] = &[&[POOL_SEED, usdc_mint_key.as_ref(), &[bump]]];
    transfer_checked(
        CpiContext::new_with_signer(
            token_program.to_account_info(),
            TransferChecked {
                from: usdc_vault.to_account_info(),
                mint: usdc_mint.to_account_info(),
                to: owner_usdc.to_account_info(),
                authority: pool.to_account_info(),
            },
            signer_seeds,
        ),
        amount,
        usdc_mint.decimals,
    )
}

#[derive(Accounts)]
pub struct ExecuteOrder<'info> {
    pub keeper: Signer<'info>,

    #[account(mut, seeds = [POOL_SEED, pool.usdc_mint.as_ref()], bump = pool.bump)]
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
        close = owner,
        has_one = owner @ PerpError::Unauthorized,
        has_one = market @ PerpError::MarketPoolMismatch,
        seeds = [ORDER_SEED, market.key().as_ref(), owner.key().as_ref(), &[order.slot]],
        bump = order.bump,
    )]
    pub order: Box<Account<'info, Order>>,

    #[account(
        mut,
        has_one = market @ PerpError::MarketPoolMismatch,
        has_one = owner @ PerpError::Unauthorized,
        seeds = [POSITION_SEED, market.key().as_ref(), owner.key().as_ref()],
        bump = position.bump,
    )]
    pub position: Box<Account<'info, Position>>,

    /// CHECK: matched against `order.owner` and `position.owner` above. Rent
    /// from the closed order account returns here, not to the keeper.
    #[account(mut)]
    pub owner: UncheckedAccount<'info>,

    /// CHECK: Validated by `market_price`: a Pyth update or the market's
    /// observation, whichever its price source says.
    pub price_update: UncheckedAccount<'info>,

    /// Where a fired trigger goes. It is not filled here any more -- see
    /// `execute_order`.
    #[account(mut, seeds = [BATCH_SEED, market.key().as_ref()], bump)]
    pub batch: AccountLoader<'info, Batch>,

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

/// Fires a triggered order. Permissionless, because an order nobody can execute
/// is not an order — it is a promise the trader has to keep watching.
///
/// The account is closed either way: a trigger that has been reached is spent,
/// and an expired one is dead. Leaving either behind would have the keeper
/// re-reading it forever.
pub fn execute_order(ctx: Context<ExecuteOrder>) -> Result<()> {
    let clock = Clock::get()?;

    if ctx.accounts.order.is_expired(clock.unix_timestamp) {
        let refund = ctx.accounts.order.collateral_usd;
        if refund > 0 {
            refund_escrow(
                &ctx.accounts.pool,
                &ctx.accounts.usdc_mint,
                &ctx.accounts.usdc_vault,
                &ctx.accounts.owner_usdc,
                &ctx.accounts.token_program,
                refund,
            )?;
            ctx.accounts.pool.escrow_usd =
                ctx.accounts.pool.escrow_usd.saturating_sub(refund);
        }
        emit!(OrderExpired {
            order: ctx.accounts.order.key(),
            owner: ctx.accounts.order.owner,
            refunded_usd: refund,
        });
        return Ok(());
    }

    require!(!ctx.accounts.pool.paused, PerpError::PoolPaused);
    require!(!ctx.accounts.market.paused, PerpError::MarketPaused);

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

    // The trigger is measured against the index, not the fill price. A stop is
    // a statement about the market, not about the spread the pool happens to
    // be quoting when the keeper gets there.
    require!(
        ctx.accounts.order.is_triggered(oracle.price),
        PerpError::OrderNotTriggered
    );

    // What a fired trigger becomes is an order in the market's batch, not a
    // fill. The trigger decided *when*; the auction decides at what price, the
    // same as it does for an order a trader submits by hand. Filling here
    // against the index -- which this did until closes moved to the auction --
    // would have left a standing way to trade at the oracle: place a stop a
    // tick away, have a keeper fire it, and the batch is bypassed entirely.
    let seq = {
        let batch = ctx.accounts.batch.load()?;
        require!(batch.is_open(), PerpError::BatchSealed);
        batch.seq
    };

    let (index, size_usd, price, is_bid) = if ctx.accounts.order.kind()? == OrderKind::Open {
        let order = &ctx.accounts.order;
        let is_long = order.is_long;
        let size_usd = order.size_usd;
        require!(
            size_usd >= ctx.accounts.market.min_position_usd,
            PerpError::PositionTooSmall
        );
        let open_fee = bps_of(size_usd, ctx.accounts.market.open_fee_bps)?;
        require!(order.collateral_usd > open_fee, PerpError::ZeroAmount);

        // The trigger price is the limit. For an open that is what a limit
        // order already meant, so nothing has to be invented here.
        let index = ctx.accounts.batch.load_mut()?.insert(BatchOrder {
            owner: order.owner,
            price: order.trigger_price,
            size_usd,
            collateral_usd: order.collateral_usd,
            is_bid: is_long as u8,
            filled_usd: 0,
            active: 1,
            reduce_only: 0,
            // A fired trigger wants a fill now: it takes liquidity.
            is_maker: 0,
            _pad: [0; 4],
        })?;
        // The escrow does not move: `place_order` put it in the vault and
        // counted it, and the batch order is now what it stands behind.
        (index, size_usd, order.trigger_price, is_long)
    } else {
        require!(ctx.accounts.position.is_open(), PerpError::PositionEmpty);
        let is_long = ctx.accounts.position.is_long;
        let requested = ctx.accounts.order.size_usd;
        let closable = ctx.accounts.position.closable_usd();
        let close_size = if requested == 0 || requested > closable {
            closable
        } else {
            requested
        };
        // Zero here means the position is already promised to other closing
        // orders. Nothing is wrong and nothing is owed -- the trigger is spent
        // and the account closes -- but there is no order to make of it.
        require!(close_size > 0, PerpError::PositionEmpty);

        // A close needs a limit the trigger never carried, so it is taken from
        // the index that fired it. See `TRIGGER_SLIPPAGE_BPS`.
        let slip = mul_div_u64(oracle.price, TRIGGER_SLIPPAGE_BPS, BPS)?;
        let price = if is_long {
            oracle.price.saturating_sub(slip).max(1)
        } else {
            oracle.price.checked_add(slip).ok_or(PerpError::MathOverflow)?
        };

        ctx.accounts.position.reserve_close(close_size)?;
        let index = ctx.accounts.batch.load_mut()?.insert(BatchOrder {
            owner: ctx.accounts.order.owner,
            price,
            size_usd: close_size,
            collateral_usd: 0,
            is_bid: !is_long as u8,
            filled_usd: 0,
            active: 1,
            reduce_only: 1,
            is_maker: 0,
            _pad: [0; 4],
        })?;
        (index, close_size, price, !is_long)
    };

    emit!(OrderTriggered {
        order: ctx.accounts.order.key(),
        owner: ctx.accounts.order.owner,
        market: ctx.accounts.market.key(),
        keeper: ctx.accounts.keeper.key(),
        seq,
        index,
        size_usd,
        index_price: oracle.price,
        limit_price: price,
        is_bid,
    });
    Ok(())
}

#[event]
pub struct OrderPlaced {
    pub order: Pubkey,
    pub owner: Pubkey,
    pub market: Pubkey,
    pub slot: u8,
    pub kind: u8,
    pub trigger_price: u64,
    pub trigger_above: bool,
}

#[event]
pub struct OrderCancelled {
    pub order: Pubkey,
    pub owner: Pubkey,
    pub refunded_usd: u64,
}

#[event]
pub struct OrderExpired {
    pub order: Pubkey,
    pub owner: Pubkey,
    pub refunded_usd: u64,
}

#[event]
/// A trigger fired and became an order in the batch.
///
/// This replaced `OrderExecuted`, and the rename is the substance: the trigger
/// no longer executes anything. There is no fill price here because no fill
/// has happened -- `limit_price` is what the resulting order will accept, and
/// `BatchCleared` and `OrderSettled` say what it actually got.
pub struct OrderTriggered {
    pub order: Pubkey,
    pub owner: Pubkey,
    pub market: Pubkey,
    pub keeper: Pubkey,
    /// The batch the order landed in, and its slot in it.
    pub seq: u64,
    pub index: u8,
    pub size_usd: u64,
    pub index_price: u64,
    pub limit_price: u64,
    pub is_bid: bool,
}
