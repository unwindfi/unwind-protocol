use crate::aum::{checkpoint_pnl_usd, lp_in_kind, pool_aum_usd, Unpriced};
use crate::constants::*;
use crate::errors::PerpError;
use crate::instructions::batch::open_trader;
use crate::math::*;
use crate::state::*;
use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    burn, close_account, mint_to, transfer_checked, Burn, CloseAccount, Mint, MintTo,
    TokenAccount, TokenInterface, TransferChecked,
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

    /// What traders are up across every market with open interest, summed
    /// by `checkpoint_aum` so this instruction does not have to carry them.
    #[account(seeds = [AUM_SEED, pool.key().as_ref()], bump = checkpoint.bump)]
    pub checkpoint: Box<Account<'info, AumCheckpoint>>,

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

    let aum_before = pool_aum_usd(
        &ctx.accounts.pool, &ctx.accounts.checkpoint, Clock::get()?.unix_timestamp,
        ctx.remaining_accounts, Unpriced::Refuse,
    )?;
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

/// What burning `lp_amount` of `lp_supply` shares pays out of a pool worth
/// `aum`, as `(gross, net)`: their part of the pool, then less the
/// withdrawal fee. Refuses a pool worth nothing, no shares, and a payout that
/// rounds to nothing.
pub fn withdrawal_value(lp_amount: u64, aum: u64, lp_supply: u64, fee_bps: u16) -> Result<(u64, u64)> {
    require!(lp_amount > 0, PerpError::ZeroAmount);
    require!(lp_supply > 0 && aum > 0, PerpError::InsufficientLiquidity);
    let gross = mul_div_u64(lp_amount, aum as u128, lp_supply as u128)?;
    let fee = bps_of(gross, fee_bps)?;
    let net = gross.checked_sub(fee).ok_or(PerpError::MathOverflow)?;
    require!(net > 0, PerpError::ZeroAmount);
    Ok((gross, net))
}

/// What a claim of `shares` of `supply` takes out of the pool.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ClaimSplit {
    /// USDC, before and after the withdrawal fee.
    pub gross_usd: u64,
    pub net_usd: u64,
    /// LP-held tokens owed from each custody, by `Custody::index`, after the
    /// fee. Taken off `Custody::lp_amount` at the claim and pulled with
    /// `claim_withdraw_tokens`.
    pub tokens: [u64; MAX_CUSTODIES],
}

/// Splits a claim into USDC and tokens in kind.
///
/// The LPs own USDC and, once backing has paid them for losses they covered,
/// tokens (`Custody::lp_amount`). Paying a leaver their whole share in USDC
/// sold the stayers' USDC for tokens nobody could take out, until the last
/// LPs held nothing else. So a claim takes its part of each: USDC from the
/// pool's value without the tokens (`liquidity - pnl`), and the same part of
/// every custody's LP tokens. `held` is `(lp_amount, value_usd)` per custody
/// in index order.
///
/// The part is `shares / supply` against the supply this claim burns, and
/// the tokens leave `lp_amount` with it, so the next claim is priced against
/// smaller holdings and a smaller supply in the same proportion. Each part
/// rounds down: the sum owed can never pass what the LPs hold, and the dust
/// stays with the LPs who remain. The last claim (all of the supply) takes
/// every token, since tokens with no shares behind them would belong to the
/// next first depositor.
///
/// Traders up by more than the USDC hold a claim on the tokens too. The
/// tokens owed are then cut to what the pool is worth after that profit, so a
/// leaver takes no more than their part of the pool's whole value.
///
/// The withdrawal fee comes off both parts and stays with the LPs. Refuses a
/// claim that would pay nothing at all.
pub fn split_claim(
    shares: u64,
    supply: u64,
    fee_bps: u16,
    liquidity_usd: u64,
    pnl_usd: i64,
    held: &[(u64, u64)],
) -> Result<ClaimSplit> {
    require!(shares > 0, PerpError::ZeroAmount);
    require!(supply > 0 && shares <= supply, PerpError::InsufficientLiquidity);
    require!(held.len() <= MAX_CUSTODIES, PerpError::IncompleteCustodyList);
    let last = shares == supply;

    let usdc_value = (liquidity_usd as i128 - pnl_usd as i128).clamp(0, u64::MAX as i128) as u64;
    let gross_usd = mul_div_u64(shares, usdc_value as u128, supply as u128)?;
    let net_usd = gross_usd
        .checked_sub(bps_of(gross_usd, fee_bps)?)
        .ok_or(PerpError::MathOverflow)?;

    // What traders are up past the USDC, taken from the tokens' value.
    let shortfall = (pnl_usd as i128 - liquidity_usd as i128).clamp(0, u64::MAX as i128) as u64;
    let in_kind = held.iter().try_fold(0u64, |a, &(_, v)| a.checked_add(v).ok_or(PerpError::MathOverflow))?;
    let keep = in_kind.saturating_sub(shortfall);

    let mut tokens = [0u64; MAX_CUSTODIES];
    for (i, &(amount, _)) in held.iter().enumerate() {
        tokens[i] = if last {
            amount
        } else {
            let mut t = mul_div_u64(amount, shares as u128, supply as u128)?;
            if shortfall > 0 && in_kind > 0 {
                t = mul_div_u64(t, keep as u128, in_kind as u128)?;
            }
            t.checked_sub(bps_of(t, fee_bps)?).ok_or(PerpError::MathOverflow)?
        };
    }
    require!(net_usd > 0 || tokens.iter().any(|&t| t > 0), PerpError::ZeroAmount);
    Ok(ClaimSplit { gross_usd, net_usd, tokens })
}

/// Whether the pool can pay `gross` out to a leaving LP.
///
/// Only against unlocked LP capital. `locked_usd` is already promised to open
/// positions, and trader collateral is not LP money at all, so neither may be
/// paid out. While anything is locked the pool keeps at least
/// `MIN_POOL_LIQUIDITY_USD`.
pub fn check_withdrawal_allowed(pool: &Pool, gross: u64) -> Result<()> {
    require!(gross <= pool.free_liquidity_usd(), PerpError::InsufficientLiquidity);
    let remaining = pool.liquidity_usd.saturating_sub(gross);
    require!(remaining >= pool.locked_usd, PerpError::InsufficientLiquidity);
    if pool.locked_usd > 0 {
        require!(
            remaining >= MIN_POOL_LIQUIDITY_USD,
            PerpError::BelowMinimumLiquidity
        );
    }
    Ok(())
}

// There is no instant withdrawal. `remove_liquidity` burned shares and paid at
// the price of the moment, so an LP who could see a loss coming (a mark about
// to catch up, a feed about to update) could leave at the old value and hand
// the loss to everyone who stayed, or deposit and leave around the move.
// Leaving now takes `request_withdraw`, `WITHDRAW_COOLDOWN_SLOTS`, then
// `claim_withdraw` at the value at that time.

#[derive(Accounts)]
pub struct RequestWithdraw<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(seeds = [POOL_SEED, pool.usdc_mint.as_ref()], bump = pool.bump)]
    pub pool: Box<Account<'info, Pool>>,

    #[account(address = pool.lp_mint)]
    pub lp_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        mut,
        constraint = owner_lp.mint == pool.lp_mint,
        constraint = owner_lp.owner == owner.key(),
    )]
    pub owner_lp: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        init_if_needed,
        payer = owner,
        space = 8 + WithdrawRequest::INIT_SPACE,
        seeds = [WITHDRAW_REQUEST_SEED, pool.key().as_ref(), owner.key().as_ref()],
        bump,
    )]
    pub request: Box<Account<'info, WithdrawRequest>>,

    /// Holds the escrowed shares. Owned by the pool, so only a claim or a
    /// cancel can move them.
    #[account(
        init_if_needed,
        payer = owner,
        seeds = [WITHDRAW_ESCROW_SEED, request.key().as_ref()],
        bump,
        token::mint = lp_mint,
        token::authority = pool,
        token::token_program = token_program,
    )]
    pub escrow_lp: Box<InterfaceAccount<'info, TokenAccount>>,

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

/// Moves `lp_amount` shares into escrow and starts the cooldown. They are not
/// burned, so they keep their part of every gain and loss until claimed.
pub fn request_withdraw(ctx: Context<RequestWithdraw>, lp_amount: u64) -> Result<()> {
    require!(lp_amount > 0, PerpError::ZeroAmount);

    let now = Clock::get()?.unix_timestamp;
    let owner = ctx.accounts.owner.key();
    let held = ctx.accounts.owner_lp.amount;
    let trader = &mut ctx.accounts.trader;
    open_trader(trader, owner, ctx.bumps.trader, now);
    trader.accrue_lp(held, now)?;
    let before = trader.lp_usd;
    trader.remove_lp(lp_amount);
    let points_usd = before - trader.lp_usd;

    transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.owner_lp.to_account_info(),
                mint: ctx.accounts.lp_mint.to_account_info(),
                to: ctx.accounts.escrow_lp.to_account_info(),
                authority: ctx.accounts.owner.to_account_info(),
            },
        ),
        lp_amount,
        ctx.accounts.lp_mint.decimals,
    )?;

    let slot = Clock::get()?.slot;
    let pool = ctx.accounts.pool.key();
    let r = &mut ctx.accounts.request;
    if r.shares == 0 {
        r.bump = ctx.bumps.request;
        r.escrow_bump = ctx.bumps.escrow_lp;
        r.pool = pool;
        r.owner = owner;
        r.points_usd = 0;
    }
    r.escrow(lp_amount, points_usd, slot)?;

    emit!(WithdrawRequested {
        pool,
        owner,
        lp_amount,
        escrowed: r.shares,
        ready_slot: r.ready_slot(),
    });
    Ok(())
}

#[derive(Accounts)]
pub struct CancelWithdraw<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(seeds = [POOL_SEED, pool.usdc_mint.as_ref()], bump = pool.bump)]
    pub pool: Box<Account<'info, Pool>>,

    #[account(address = pool.lp_mint)]
    pub lp_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        mut,
        constraint = owner_lp.mint == pool.lp_mint,
        constraint = owner_lp.owner == owner.key(),
    )]
    pub owner_lp: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        close = owner,
        seeds = [WITHDRAW_REQUEST_SEED, pool.key().as_ref(), owner.key().as_ref()],
        bump = request.bump,
        has_one = owner,
        has_one = pool,
    )]
    pub request: Box<Account<'info, WithdrawRequest>>,

    #[account(
        mut,
        seeds = [WITHDRAW_ESCROW_SEED, request.key().as_ref()],
        bump = request.escrow_bump,
    )]
    pub escrow_lp: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        seeds = [TRADER_SEED, owner.key().as_ref()],
        bump = trader.bump,
    )]
    pub trader: Box<Account<'info, Trader>>,

    pub token_program: Interface<'info, TokenInterface>,
}

/// Returns every escrowed share to the owner and closes the request.
/// Allowed at any time, paused or not: it moves no value.
pub fn cancel_withdraw(ctx: Context<CancelWithdraw>) -> Result<()> {
    let shares = ctx.accounts.request.shares;
    let points_usd = ctx.accounts.request.points_usd;

    let now = Clock::get()?.unix_timestamp;
    let held = ctx.accounts.owner_lp.amount;
    let trader = &mut ctx.accounts.trader;
    trader.accrue_lp(held, now)?;
    trader.add_lp(shares, points_usd)?;

    let usdc_mint_key = ctx.accounts.pool.usdc_mint;
    let bump = ctx.accounts.pool.bump;
    let signer_seeds: &[&[&[u8]]] = &[&[POOL_SEED, usdc_mint_key.as_ref(), &[bump]]];

    // The whole balance, not `shares`: anyone can send xLP into the escrow
    // account, and a unit left behind made the close below fail, so the
    // request could never be cancelled. What was sent goes to the owner.
    let balance = ctx.accounts.escrow_lp.amount;
    if balance > 0 {
        transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.escrow_lp.to_account_info(),
                    mint: ctx.accounts.lp_mint.to_account_info(),
                    to: ctx.accounts.owner_lp.to_account_info(),
                    authority: ctx.accounts.pool.to_account_info(),
                },
                signer_seeds,
            ),
            balance,
            ctx.accounts.lp_mint.decimals,
        )?;
    }
    close_escrow(
        &ctx.accounts.token_program,
        &ctx.accounts.escrow_lp,
        &ctx.accounts.owner,
        &ctx.accounts.pool,
        signer_seeds,
    )?;

    emit!(WithdrawCancelled {
        pool: ctx.accounts.pool.key(),
        owner: ctx.accounts.owner.key(),
        lp_amount: shares,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct ClaimWithdraw<'info> {
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
        seeds = [WITHDRAW_REQUEST_SEED, pool.key().as_ref(), owner.key().as_ref()],
        bump = request.bump,
        has_one = owner,
        has_one = pool,
    )]
    pub request: Box<Account<'info, WithdrawRequest>>,

    #[account(
        mut,
        seeds = [WITHDRAW_ESCROW_SEED, request.key().as_ref()],
        bump = request.escrow_bump,
    )]
    pub escrow_lp: Box<InterfaceAccount<'info, TokenAccount>>,

    /// What traders are up across every market with open interest, summed
    /// by `checkpoint_aum`, as for `add_liquidity`.
    #[account(seeds = [AUM_SEED, pool.key().as_ref()], bump = checkpoint.bump)]
    pub checkpoint: Box<Account<'info, AumCheckpoint>>,

    /// The LP-held tokens this claim is owed, pulled afterwards with
    /// `claim_withdraw_tokens`. Closed again here if it is owed none.
    #[account(
        init_if_needed,
        payer = owner,
        space = 8 + LpTokenClaim::INIT_SPACE,
        seeds = [LP_TOKEN_CLAIM_SEED, pool.key().as_ref(), owner.key().as_ref()],
        bump,
    )]
    pub token_claim: Box<Account<'info, LpTokenClaim>>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

/// Burns `lp_amount` escrowed shares once the cooldown is over and pays them
/// their part of the pool now (see `split_claim`): USDC from the pool's value
/// without its LP-held tokens, and the same part of those tokens, recorded on
/// the owner's `LpTokenClaim`. What is left in escrow stays claimable; the
/// request closes when the last share is claimed.
///
/// `remaining_accounts` as for `add_liquidity`; a custody the LPs hold
/// tokens in must be writable.
pub fn claim_withdraw<'info>(
    ctx: Context<'_, '_, 'info, 'info, ClaimWithdraw<'info>>,
    lp_amount: u64,
    min_usd_out: u64,
) -> Result<()> {
    require!(lp_amount > 0, PerpError::ZeroAmount);
    require!(!ctx.accounts.pool.paused, PerpError::PoolPaused);
    require!(
        ctx.accounts.request.is_ready(Clock::get()?.slot),
        PerpError::WithdrawCooling
    );

    // Priced now, not at the request: the escrowed shares are still in the
    // mint's supply, so whatever the pool lost while they waited is theirs too.
    //
    // A market whose price could not be read when the checkpoint was taken
    // is counted at the most it could cost the LPs rather than refusing: one
    // stalled feed or emptied pool must not lock every LP's capital in the
    // pool.
    let pool_info = &ctx.accounts.pool;
    let pnl = checkpoint_pnl_usd(
        pool_info.key(), pool_info.oi_version, pool_info.markets_with_oi,
        &ctx.accounts.checkpoint, Clock::get()?.unix_timestamp, Unpriced::AtWorst,
    )?;
    let mut custodies = lp_in_kind(pool_info, ctx.remaining_accounts)?;
    let held: Vec<(u64, u64)> = custodies.iter().map(|(c, v)| (c.lp_amount, *v)).collect();
    let in_kind_usd = held.iter().fold(0u64, |a, &(_, v)| a.saturating_add(v));
    let aum = pool_info.aum_with_in_kind_usd(pnl, in_kind_usd);
    let lp_supply = ctx.accounts.lp_mint.supply;
    let split = split_claim(
        lp_amount,
        lp_supply,
        pool_info.remove_liquidity_fee_bps,
        pool_info.liquidity_usd,
        pnl,
        &held,
    )?;
    let (gross, net) = (split.gross_usd, split.net_usd);
    require!(net >= min_usd_out, PerpError::SlippageExceeded);
    check_withdrawal_allowed(&ctx.accounts.pool, gross)?;

    ctx.accounts.request.release(lp_amount)?;

    // The tokens leave the LPs' holdings at the burn, against the supply the
    // burn reduces, so no later claim can change what this one is owed.
    let pool_key = ctx.accounts.pool.key();
    let owner_key = ctx.accounts.owner.key();
    let tc = &mut ctx.accounts.token_claim;
    if tc.pool == Pubkey::default() {
        tc.bump = ctx.bumps.token_claim;
        tc.pool = pool_key;
        tc.owner = owner_key;
    }
    for ((c, _), info) in custodies.iter_mut().zip(ctx.remaining_accounts.chunks(2)) {
        let t = split.tokens[c.index as usize];
        if t == 0 {
            continue;
        }
        require!(info[0].is_writable, PerpError::IncompleteCustodyList);
        c.lp_amount = c.lp_amount.checked_sub(t).ok_or(PerpError::MathOverflow)?;
        c.lp_owed_amount = c.lp_owed_amount.checked_add(t).ok_or(PerpError::MathOverflow)?;
        let i = c.index as usize;
        tc.owed[i] = tc.owed[i].checked_add(t).ok_or(PerpError::MathOverflow)?;
        c.exit(&crate::ID)?;
    }
    if !split.tokens.iter().all(|&t| t == 0) {
        emit!(LiquidityOwedInKind { pool: pool_key, owner: owner_key, tokens: split.tokens });
    }

    let usdc_mint_key = ctx.accounts.pool.usdc_mint;
    let bump = ctx.accounts.pool.bump;
    let signer_seeds: &[&[&[u8]]] = &[&[POOL_SEED, usdc_mint_key.as_ref(), &[bump]]];

    burn(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Burn {
                mint: ctx.accounts.lp_mint.to_account_info(),
                from: ctx.accounts.escrow_lp.to_account_info(),
                authority: ctx.accounts.pool.to_account_info(),
            },
            signer_seeds,
        ),
        escrow_burn(lp_amount, ctx.accounts.request.shares, ctx.accounts.escrow_lp.amount),
    )?;

    if net > 0 {
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
    }

    if ctx.accounts.request.shares == 0 {
        close_escrow(
            &ctx.accounts.token_program,
            &ctx.accounts.escrow_lp,
            &ctx.accounts.owner,
            &ctx.accounts.pool,
            signer_seeds,
        )?;
        ctx.accounts
            .request
            .close(ctx.accounts.owner.to_account_info())?;
    }
    if ctx.accounts.token_claim.is_empty() {
        ctx.accounts
            .token_claim
            .close(ctx.accounts.owner.to_account_info())?;
    }

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

#[derive(Accounts)]
pub struct ClaimWithdrawTokens<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(seeds = [POOL_SEED, pool.usdc_mint.as_ref()], bump = pool.bump)]
    pub pool: Box<Account<'info, Pool>>,

    #[account(
        mut,
        seeds = [CUSTODY_SEED, pool.key().as_ref(), mint.key().as_ref()],
        bump = custody.bump,
        has_one = pool @ PerpError::MarketPoolMismatch,
        has_one = mint,
        has_one = vault,
    )]
    pub custody: Box<Account<'info, Custody>>,

    pub mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(mut)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = owner_token.mint == custody.mint,
        constraint = owner_token.owner == owner.key(),
    )]
    pub owner_token: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        seeds = [LP_TOKEN_CLAIM_SEED, pool.key().as_ref(), owner.key().as_ref()],
        bump = token_claim.bump,
        has_one = owner,
        has_one = pool,
    )]
    pub token_claim: Box<Account<'info, LpTokenClaim>>,

    pub token_program: Interface<'info, TokenInterface>,
}

/// Sends the owner the tokens a withdrawal claim is owed from one custody,
/// and closes their `LpTokenClaim` once nothing is owed from any. The amount
/// was fixed at the claim and is already off the LPs' holdings, so this moves
/// no value between LPs and needs no price.
pub fn claim_withdraw_tokens(ctx: Context<ClaimWithdrawTokens>) -> Result<()> {
    require!(!ctx.accounts.pool.paused, PerpError::PoolPaused);
    let i = ctx.accounts.custody.index as usize;
    let amount = ctx.accounts.token_claim.owed[i];
    require!(amount > 0, PerpError::ZeroAmount);

    let usdc_mint_key = ctx.accounts.pool.usdc_mint;
    let bump = ctx.accounts.pool.bump;
    let signer_seeds: &[&[&[u8]]] = &[&[POOL_SEED, usdc_mint_key.as_ref(), &[bump]]];
    transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.vault.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.owner_token.to_account_info(),
                authority: ctx.accounts.pool.to_account_info(),
            },
            signer_seeds,
        ),
        amount,
        ctx.accounts.mint.decimals,
    )?;

    let c = &mut ctx.accounts.custody;
    c.lp_owed_amount = c.lp_owed_amount.checked_sub(amount).ok_or(PerpError::MathOverflow)?;
    ctx.accounts.token_claim.owed[i] = 0;
    if ctx.accounts.token_claim.is_empty() {
        ctx.accounts
            .token_claim
            .close(ctx.accounts.owner.to_account_info())?;
    }

    emit!(LiquidityTokensClaimed {
        pool: ctx.accounts.pool.key(),
        owner: ctx.accounts.owner.key(),
        mint: ctx.accounts.mint.key(),
        amount,
    });
    Ok(())
}

/// xLP a claim of `lp_amount` burns from an escrow holding `balance`, with
/// `remaining` shares left on the request after it. The last claim burns
/// whatever else somebody sent into the escrow too: the account must be empty
/// to close, and a unit left in it kept the request open for good.
pub fn escrow_burn(lp_amount: u64, remaining: u64, balance: u64) -> u64 {
    if remaining == 0 {
        balance.max(lp_amount)
    } else {
        lp_amount
    }
}

/// Closes an emptied escrow account, rent to the owner.
fn close_escrow<'info>(
    token_program: &Interface<'info, TokenInterface>,
    escrow: &InterfaceAccount<'info, TokenAccount>,
    owner: &Signer<'info>,
    pool: &Account<'info, Pool>,
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    close_account(CpiContext::new_with_signer(
        token_program.to_account_info(),
        CloseAccount {
            account: escrow.to_account_info(),
            destination: owner.to_account_info(),
            authority: pool.to_account_info(),
        },
        signer_seeds,
    ))
}

#[event]
pub struct WithdrawRequested {
    pub pool: Pubkey,
    pub owner: Pubkey,
    pub lp_amount: u64,
    /// Everything now in escrow, this request included.
    pub escrowed: u64,
    pub ready_slot: u64,
}

#[event]
pub struct WithdrawCancelled {
    pub pool: Pubkey,
    pub owner: Pubkey,
    pub lp_amount: u64,
}

#[event]
pub struct LiquidityAdded {
    pub pool: Pubkey,
    pub owner: Pubkey,
    pub amount_usd: u64,
    pub lp_minted: u64,
    pub aum_before: u64,
}

/// LP-held tokens a claim is owed in kind, by `Custody::index`.
#[event]
pub struct LiquidityOwedInKind {
    pub pool: Pubkey,
    pub owner: Pubkey,
    pub tokens: [u64; MAX_CUSTODIES],
}

#[event]
pub struct LiquidityTokensClaimed {
    pub pool: Pubkey,
    pub owner: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
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
    // the real `lp_out_for_deposit`; `withdraw` and `allowed` call the real
    // `withdrawal_value` and `check_withdrawal_allowed` that `claim_withdraw`
    // uses. src/proofs/liquidity.rs proves the same lines.

    fn deposit(amount: u64, fee_bps: u16, supply: u64, aum: u64) -> Option<u64> {
        let fee = bps_of(amount, fee_bps).ok()?;
        let net = amount.checked_sub(fee)?;
        if net == 0 {
            return None;
        }
        lp_out_for_deposit(net, supply, aum).ok()
    }

    fn withdraw(lp: u64, aum: u64, supply: u64, fee_bps: u16) -> Option<(u64, u64)> {
        withdrawal_value(lp, aum, supply, fee_bps).ok()
    }

    fn allowed(p: &Pool, gross: u64) -> bool {
        check_withdrawal_allowed(p, gross).is_ok()
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
            oi_version: 0,
            _reserved: [0; 1],
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

    #[test]
    fn a_claim_is_priced_when_it_is_claimed_not_when_it_was_requested() {
        // 50k of 1m shares escrowed while the pool is worth 1m. Traders go up
        // 100k during the cooldown: the escrowed shares are still in supply,
        // so the claim pays their 5% of the 900k left, not of the 1m.
        let (liq, supply, lp) = (1_000_000 * USD, 1_000_000 * USD, 50_000 * USD);
        let (at_request, _) = withdraw(lp, aum(liq, 0, 0), supply, 0).unwrap();
        let (at_claim, _) = withdraw(lp, aum(liq, 100_000 * USD as i64, 0), supply, 0).unwrap();
        assert_eq!(at_request, 50_000 * USD);
        assert_eq!(at_claim, 45_000 * USD);
        // And the LPs who stay lose exactly their share, no more.
        let left = aum(liq, 100_000 * USD as i64, 0) - at_claim;
        assert_eq!(left, 855_000 * USD);
        assert_eq!(left as u128 * supply as u128, 900_000 * USD as u128 * (supply - lp) as u128);
    }

    // In-kind redemption (F1P-07). `split_claim` is what `claim_withdraw`
    // pays: USDC from the pool's value without the LP tokens, and the claim's
    // part of each custody's LP tokens, taken off `lp_amount` at the burn.

    /// A pool whose LPs hold `lp` tokens in one custody (a dollar a unit),
    /// left in sequence. `claim` applies a claim as `claim_withdraw` does.
    struct Lps {
        liq: u64,
        pnl: i64,
        lp: u64,
        supply: u64,
    }

    impl Lps {
        fn claim(&mut self, shares: u64, fee_bps: u16) -> Result<ClaimSplit> {
            let s = split_claim(shares, self.supply, fee_bps, self.liq, self.pnl, &[(self.lp, self.lp)])?;
            check_withdrawal_allowed(&pool(self.liq), s.gross_usd)?;
            self.lp -= s.tokens[0];
            self.supply -= shares;
            self.liq -= s.net_usd;
            Ok(s)
        }
    }

    #[test]
    fn usdc_paid_on_a_claim_leaves_the_lp_tokens_out() {
        // $1,000 USDC and $1,000 of tokens, 2,000 shares. Half the shares used
        // to take $1,000 in USDC: every dollar of USDC there was. Now they
        // take $500 and half the tokens.
        let s = split_claim(1_000, 2_000, 0, 1_000, 0, &[(1_000, 1_000)]).unwrap();
        assert_eq!((s.gross_usd, s.net_usd), (500, 500));
        assert_eq!(s.tokens[0], 500);
        // Traders up $200 come off the USDC part only.
        let s = split_claim(1_000, 2_000, 0, 1_000, 200, &[(1_000, 1_000)]).unwrap();
        assert_eq!((s.net_usd, s.tokens[0]), (400, 500));
    }

    #[test]
    fn the_token_fraction_is_taken_against_the_supply_the_claim_burns() {
        // 25 of 100 shares: a quarter of each custody, rounded down.
        let s = split_claim(25, 100, 0, 0, 0, &[(1_000, 10), (7, 7), (0, 0)]).unwrap();
        assert_eq!(&s.tokens[..3], &[250, 1, 0]);
        // A later claim against the smaller supply and holdings is owed the
        // same per share: the first claim's tokens left with it.
        let mut p = Lps { liq: 0, pnl: 0, lp: 1_000, supply: 100 };
        let a = p.claim(25, 0).unwrap();
        let b = p.claim(25, 0).unwrap();
        assert_eq!((a.tokens[0], b.tokens[0]), (250, 250));
        assert_eq!((p.lp, p.supply), (500, 50));
    }

    #[test]
    fn two_lps_leaving_in_sequence_get_the_same_tokens_per_share() {
        // Two LPs with the same shares leave one after the other. The second
        // is owed what the first was, or one unit more where the first one's
        // rounding left dust behind; never less.
        for lp in [0u64, 1, 2, 7, 999, 1_000, 123_456_789, u64::MAX / 3] {
            for supply in 2..=20u64 {
                for s in 1..=supply / 2 {
                    let mut p = Lps { liq: 0, pnl: 0, lp, supply };
                    let a = p.claim(s, 0).map(|c| c.tokens[0]).unwrap_or(0);
                    let b = p.claim(s, 0).map(|c| c.tokens[0]).unwrap_or(0);
                    assert!(b >= a && b <= a + 1, "lp {lp} supply {supply} s {s}: {a} then {b}");
                }
            }
        }
    }

    #[test]
    fn what_leavers_are_owed_never_sums_past_what_the_lps_hold() {
        // Every pool of up to 40 tokens and 12 shares, emptied by claims of
        // 1 to 4 shares, with and without fees. `Lps::claim` takes each claim
        // off what is held, so a sum past it would underflow; and the last
        // leaver takes the remainder, so no tokens are left behind no shares.
        for lp in 0..=40u64 {
            for supply in 1..=12u64 {
                for size in 1..=4u64 {
                    for fee in [0u16, 30, 5_000] {
                        let mut p = Lps { liq: 100, pnl: 0, lp, supply };
                        let mut owed = 0u64;
                        while p.supply > 0 {
                            let shares = size.min(p.supply);
                            match p.claim(shares, fee) {
                                Ok(s) => owed += s.tokens[0],
                                Err(_) => p.supply -= shares,
                            }
                        }
                        assert_eq!(owed + p.lp, lp);
                        assert_eq!(p.lp, 0, "lp {lp} supply {supply} size {size} fee {fee}");
                    }
                }
            }
        }
    }

    #[test]
    fn the_fee_is_taken_from_the_tokens_too_and_stays_with_the_lps() {
        let s = split_claim(50, 100, 1_000, 1_000, 0, &[(1_000, 1_000)]).unwrap();
        assert_eq!((s.gross_usd, s.net_usd), (500, 450));
        assert_eq!(s.tokens[0], 450);
        // The last leaver has nobody to leave a fee to in tokens; they take
        // all of them. Their USDC fee is swept to insurance as before.
        let s = split_claim(100, 100, 1_000, 1_000, 0, &[(1_000, 1_000)]).unwrap();
        assert_eq!((s.net_usd, s.tokens[0]), (900, 1_000));
    }

    #[test]
    fn trader_profit_past_the_usdc_comes_off_the_tokens() {
        // $100 USDC, $300 of tokens, traders up $200: the pool is worth $200,
        // and half of it is $100, all of it in tokens. Without the scaling a
        // leaver took half the tokens ($150) and left the whole hole with the
        // LPs who stayed.
        let s = split_claim(50, 100, 0, 100, 200, &[(300, 300)]).unwrap();
        assert_eq!(s.net_usd, 0);
        assert_eq!(s.tokens[0], 100);
        // Under water altogether: nothing to take, refused.
        assert!(split_claim(50, 100, 0, 100, 400, &[(300, 300)]).is_err());
    }

    #[test]
    fn a_claim_that_pays_no_usdc_still_pays_its_tokens() {
        // All of the pool's value is in tokens: the claim is not refused.
        let s = split_claim(10, 100, 0, 0, 0, &[(1_000, 5_000)]).unwrap();
        assert_eq!((s.net_usd, s.tokens[0]), (0, 100));
        // Nothing at all is refused, as before.
        assert!(split_claim(1, 100, 0, 1, 0, &[(1, 1)]).is_err());
        assert!(split_claim(0, 100, 0, 1_000, 0, &[]).is_err());
        assert!(split_claim(101, 100, 0, 1_000, 0, &[]).is_err());
    }

    #[test]
    fn a_deposit_still_buys_the_tokens_at_their_price() {
        // $1,000 USDC and $1,000 of tokens behind 2,000 shares. A deposit is
        // priced on both: $1,000 buys 1,000 shares, not 2,000. Valuing it on
        // the USDC alone would hand the depositor a share of the tokens free.
        let (liq, tokens, supply) = (1_000 * USD, 1_000 * USD, 2_000 * USD);
        let lp = deposit(1_000 * USD, 0, supply, aum(liq, 0, tokens)).unwrap();
        assert_eq!(lp, 1_000 * USD);
        // Straight back out it takes a third of each: $666.67 of USDC and
        // $333.33 of tokens, no more than the $1,000 it paid.
        let s = split_claim(lp, supply + lp, 0, liq + 1_000 * USD, 0, &[(tokens, tokens)]).unwrap();
        assert!(s.net_usd + s.tokens[0] <= 1_000 * USD);
        assert!(s.net_usd + s.tokens[0] + 2 >= 1_000 * USD);
        // At every small size, with fees and traders either way, a deposit
        // and a claim of its shares return at most what was paid.
        for liq in 0..=12u64 {
            for tok in 0..=6u64 {
                for pnl in -4..=8i64 {
                    let a = aum(liq, pnl, tok);
                    for supply in 1..=6u64 {
                        for amount in 1..=12u64 {
                            for fee in [0u16, 30] {
                                let Some(lp) = deposit(amount, fee, supply, a) else { continue };
                                if let Ok(s) = split_claim(lp, supply + lp, fee, liq + amount, pnl, &[(tok, tok)]) {
                                    assert!(s.net_usd + s.tokens[0] <= amount,
                                        "liq {liq} tok {tok} pnl {pnl} supply {supply} amount {amount}");
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn a_claim_never_lowers_what_a_remaining_share_holds() {
        // Pool value and tokens per share each hold or rise for the LPs who
        // stay, 667 of 1,000 shares.
        for liq in [0u64, 1, 999, 10_000] {
            for tok in [0u64, 1, 333, 10_000] {
                for pnl in [-500i64, 0, 400, 20_000] {
                    for fee in [0u16, 5, 30] {
                        let mut p = Lps { liq, pnl, lp: tok, supply: 1_000 };
                        let before = aum(liq, pnl, tok) as u128;
                        if p.claim(333, fee).is_err() {
                            continue;
                        }
                        let after = aum(p.liq, pnl, p.lp) as u128;
                        assert!(after * 1_000 >= before * 667, "liq {liq} tok {tok} pnl {pnl} fee {fee}");
                        assert!(p.lp as u128 * 1_000 >= tok as u128 * 667);
                    }
                }
            }
        }
    }

    #[test]
    fn the_last_claim_empties_an_escrow_somebody_sent_extra_into() {
        // S2-02: 100 escrowed, one unit sent in by someone else. A partial
        // claim burns only its own shares; the last one burns everything so
        // the escrow can close.
        assert_eq!(escrow_burn(40, 60, 101), 40);
        assert_eq!(escrow_burn(60, 0, 61), 61);
        assert_eq!(escrow_burn(100, 0, 100), 100);
    }

    #[test]
    fn a_claim_against_a_worthless_pool_or_no_supply_pays_nothing() {
        assert!(withdrawal_value(1, 0, 10, 0).is_err());
        assert!(withdrawal_value(1, 10, 0, 0).is_err());
        assert!(withdrawal_value(0, 10, 10, 0).is_err());
        // Worth less than a unit: refused rather than burned for nothing.
        assert!(withdrawal_value(1, 1, 2, 0).is_err());
    }
}
