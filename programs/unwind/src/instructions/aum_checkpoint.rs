use crate::aum::fold_checkpoint;
use crate::constants::*;
use crate::state::*;
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct CheckpointAum<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(seeds = [POOL_SEED, pool.usdc_mint.as_ref()], bump = pool.bump)]
    pub pool: Box<Account<'info, Pool>>,

    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + AumCheckpoint::INIT_SPACE,
        seeds = [AUM_SEED, pool.key().as_ref()],
        bump,
    )]
    pub checkpoint: Box<Account<'info, AumCheckpoint>>,

    pub system_program: Program<'info, System>,
}

/// Adds markets to the pool's AUM checkpoint pass (see `AumCheckpoint`).
/// Permissionless: it reads prices and sums PnL, and moves no money.
/// `remaining_accounts` are `(market, price_update)` pairs in increasing
/// market address order, continuing from where the pass left off.
pub fn checkpoint_aum<'info>(
    ctx: Context<'_, '_, 'info, 'info, CheckpointAum<'info>>,
    restart: bool,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let pool = &ctx.accounts.pool;
    let c = &mut ctx.accounts.checkpoint;
    if c.pool == Pubkey::default() {
        c.pool = pool.key();
        c.bump = ctx.bumps.checkpoint;
    }
    fold_checkpoint(pool, c, restart, now, ctx.remaining_accounts)
}
