use crate::constants::*;
use crate::errors::PerpError;
use crate::state::*;
use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};

#[derive(Accounts)]
pub struct AccrueFunding<'info> {
    #[account(seeds = [POOL_SEED, pool.usdc_mint.as_ref()], bump = pool.bump)]
    pub pool: Account<'info, Pool>,

    #[account(
        mut,
        has_one = pool @ PerpError::MarketPoolMismatch,
        seeds = [MARKET_SEED, pool.key().as_ref(), market.feed_id.as_ref()],
        bump = market.bump,
    )]
    pub market: Account<'info, Market>,
}

/// Permissionless crank so the funding index keeps moving in a quiet market.
///
/// Every trading instruction accrues first, so this only matters when nobody is
/// trading -- which is precisely the overnight and weekend case this market has
/// to price, and where an unaccrued index would let a position sit through a
/// long one-sided stretch without ever paying for it.
pub fn accrue_funding(ctx: Context<AccrueFunding>) -> Result<()> {
    let clock = Clock::get()?;
    let utilization = ctx.accounts.pool.utilization_bps();
    ctx.accounts
        .market
        .accrue_funding(clock.unix_timestamp, utilization)?;
    Ok(())
}

#[derive(Accounts)]
pub struct CollectProtocolFees<'info> {
    #[account(address = pool.authority @ PerpError::Unauthorized)]
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [POOL_SEED, pool.usdc_mint.as_ref()],
        bump = pool.bump,
    )]
    pub pool: Account<'info, Pool>,

    #[account(address = pool.usdc_mint)]
    pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(mut, address = pool.usdc_vault)]
    pub usdc_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(mut, constraint = destination.mint == pool.usdc_mint)]
    pub destination: Box<InterfaceAccount<'info, TokenAccount>>,

    pub token_program: Interface<'info, TokenInterface>,
}

pub fn collect_protocol_fees(ctx: Context<CollectProtocolFees>, amount: u64) -> Result<()> {
    let amount = if amount == 0 {
        ctx.accounts.pool.protocol_fees_usd
    } else {
        amount
    };
    require!(amount > 0, PerpError::ZeroAmount);
    require!(
        amount <= ctx.accounts.pool.protocol_fees_usd,
        PerpError::InsufficientLiquidity
    );

    let usdc_mint_key = ctx.accounts.pool.usdc_mint;
    let bump = ctx.accounts.pool.bump;
    let signer_seeds: &[&[&[u8]]] = &[&[POOL_SEED, usdc_mint_key.as_ref(), &[bump]]];

    transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.usdc_vault.to_account_info(),
                mint: ctx.accounts.usdc_mint.to_account_info(),
                to: ctx.accounts.destination.to_account_info(),
                authority: ctx.accounts.pool.to_account_info(),
            },
            signer_seeds,
        ),
        amount,
        ctx.accounts.usdc_mint.decimals,
    )?;

    ctx.accounts.pool.protocol_fees_usd -= amount;
    Ok(())
}

#[derive(Accounts)]
pub struct FundInsurance<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        mut,
        seeds = [POOL_SEED, pool.usdc_mint.as_ref()],
        bump = pool.bump,
    )]
    pub pool: Account<'info, Pool>,

    #[account(address = pool.usdc_mint)]
    pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(mut, address = pool.usdc_vault)]
    pub usdc_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = payer_usdc.mint == pool.usdc_mint,
        constraint = payer_usdc.owner == payer.key(),
    )]
    pub payer_usdc: Box<InterfaceAccount<'info, TokenAccount>>,

    pub token_program: Interface<'info, TokenInterface>,
}

/// Adds capital to the insurance fund.
///
/// Permissionless on purpose: the fund exists to stand between a gap and the
/// LPs, and anyone with a reason to want that buffer deeper — the protocol, an
/// LP, a market maker — should be able to deepen it without asking. It buys no
/// claim on the pool; the capital is given, not deposited.
pub fn fund_insurance(ctx: Context<FundInsurance>, amount: u64) -> Result<()> {
    require!(amount > 0, PerpError::ZeroAmount);

    transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.payer_usdc.to_account_info(),
                mint: ctx.accounts.usdc_mint.to_account_info(),
                to: ctx.accounts.usdc_vault.to_account_info(),
                authority: ctx.accounts.payer.to_account_info(),
            },
        ),
        amount,
        ctx.accounts.usdc_mint.decimals,
    )?;

    let pool = &mut ctx.accounts.pool;
    pool.insurance_usd = pool
        .insurance_usd
        .checked_add(amount)
        .ok_or(PerpError::MathOverflow)?;

    emit!(InsuranceFunded {
        pool: pool.key(),
        payer: ctx.accounts.payer.key(),
        amount_usd: amount,
        total_usd: pool.insurance_usd,
    });
    Ok(())
}

#[event]
pub struct InsuranceFunded {
    pub pool: Pubkey,
    pub payer: Pubkey,
    pub amount_usd: u64,
    pub total_usd: u64,
}

#[derive(Accounts)]
pub struct CollectChainFees<'info> {
    #[account(mut, seeds = [POOL_SEED, pool.usdc_mint.as_ref()], bump = pool.bump)]
    pub pool: Box<Account<'info, Pool>>,

    #[account(address = pool.usdc_mint)]
    pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, address = pool.usdc_vault)]
    pub usdc_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    /// The only account this revenue can reach. Constrained to the owner fixed
    /// when the pool was created, so there is no version of this instruction
    /// that pays anybody else — including whoever calls it.
    #[account(
        mut,
        constraint = destination_usdc.mint == pool.usdc_mint,
        constraint = destination_usdc.owner == pool.chain_fee_destination
            @ PerpError::Unauthorized,
    )]
    pub destination_usdc: Box<InterfaceAccount<'info, TokenAccount>>,

    pub token_program: Interface<'info, TokenInterface>,
}

/// Sweeps the chain's accrued share to its fixed destination.
///
/// Permissionless and unsigned by the authority on purpose. Revenue that only
/// moves when the team chooses to move it is revenue the team controls; this
/// way anybody can push it, and the only place it can go was decided when the
/// pool was created.
pub fn collect_chain_fees(ctx: Context<CollectChainFees>) -> Result<()> {
    let amount = ctx.accounts.pool.chain_fees_usd;
    require!(amount > 0, PerpError::ZeroAmount);

    let usdc_mint_key = ctx.accounts.pool.usdc_mint;
    let bump = ctx.accounts.pool.bump;
    let signer_seeds: &[&[&[u8]]] = &[&[POOL_SEED, usdc_mint_key.as_ref(), &[bump]]];

    transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.usdc_vault.to_account_info(),
                mint: ctx.accounts.usdc_mint.to_account_info(),
                to: ctx.accounts.destination_usdc.to_account_info(),
                authority: ctx.accounts.pool.to_account_info(),
            },
            signer_seeds,
        ),
        amount,
        ctx.accounts.usdc_mint.decimals,
    )?;

    ctx.accounts.pool.chain_fees_usd = 0;
    emit!(ChainFeesCollected {
        destination: ctx.accounts.pool.chain_fee_destination,
        amount_usd: amount,
    });
    Ok(())
}

#[event]
pub struct ChainFeesCollected {
    pub destination: Pubkey,
    pub amount_usd: u64,
}
