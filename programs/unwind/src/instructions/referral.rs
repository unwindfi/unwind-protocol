//! Referrals, listing rewards and points.
//!
//! A wallet names its referrer once, by code, before its first fill. From then
//! on it pays `REFEREE_DISCOUNT_BPS` less on every open and close, and its
//! referrer is owed `REFERRER_FEE_SHARE_BPS` of every fee it does pay, in
//! USDC, plus `REFERRER_POINTS_BPS` of its points. Whoever listed a market is
//! owed `DEPLOYER_FEE_SHARE_BPS` of every fee paid on it and points on its
//! volume, and trades it at `DEPLOYER_DISCOUNT_BPS` off.
//!
//! Settlement never touches a referrer's or a deployer's account. What they
//! are owed is left on the referee's `Trader` and on the `Market`, and the
//! permissionless syncs here move it across. That keeps settlement's account
//! list as it was, which is what decides how many orders fit in a
//! transaction.
use crate::constants::*;
use crate::errors::PerpError;
use crate::instructions::batch::open_trader;
use crate::state::*;
use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};

#[derive(Accounts)]
pub struct CreateTrader<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        init_if_needed,
        payer = owner,
        space = 8 + Trader::INIT_SPACE,
        seeds = [TRADER_SEED, owner.key().as_ref()],
        bump,
    )]
    pub trader: Box<Account<'info, Trader>>,

    pub system_program: Program<'info, System>,
}

/// Makes a wallet's `Trader`, for a wallet that has not traded, backed or
/// provided liquidity yet but wants a code, or is a deployer collecting.
pub fn create_trader(ctx: Context<CreateTrader>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    open_trader(&mut ctx.accounts.trader, ctx.accounts.owner.key(), ctx.bumps.trader, now);
    Ok(())
}

#[derive(Accounts)]
#[instruction(code: [u8; REFERRAL_CODE_LEN])]
pub struct ClaimReferralCode<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        init_if_needed,
        payer = owner,
        space = 8 + Trader::INIT_SPACE,
        seeds = [TRADER_SEED, owner.key().as_ref()],
        bump,
    )]
    pub trader: Box<Account<'info, Trader>>,

    /// `init`, not `init_if_needed`: a code somebody already holds fails here.
    #[account(
        init,
        payer = owner,
        space = 8 + ReferralCode::INIT_SPACE,
        seeds = [REFERRAL_CODE_SEED, code.as_ref()],
        bump,
    )]
    pub referral_code: Box<Account<'info, ReferralCode>>,

    pub system_program: Program<'info, System>,
}

/// Takes a referral code. First come, one per wallet, and permanent.
pub fn claim_referral_code(
    ctx: Context<ClaimReferralCode>,
    code: [u8; REFERRAL_CODE_LEN],
) -> Result<()> {
    let code = parse_code(&code)?;
    let now = Clock::get()?.unix_timestamp;
    let owner = ctx.accounts.owner.key();
    let trader = &mut ctx.accounts.trader;
    open_trader(trader, owner, ctx.bumps.trader, now);
    require!(!trader.has_code(), PerpError::ReferralCodeTaken);
    trader.code = code;

    let rc = &mut ctx.accounts.referral_code;
    rc.bump = ctx.bumps.referral_code;
    rc.owner = owner;
    rc.code = code;

    emit!(ReferralCodeClaimed { owner, code });
    Ok(())
}

#[derive(Accounts)]
#[instruction(code: [u8; REFERRAL_CODE_LEN])]
pub struct SetReferrer<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        init_if_needed,
        payer = owner,
        space = 8 + Trader::INIT_SPACE,
        seeds = [TRADER_SEED, owner.key().as_ref()],
        bump,
    )]
    pub trader: Box<Account<'info, Trader>>,

    #[account(seeds = [REFERRAL_CODE_SEED, code.as_ref()], bump = referral_code.bump)]
    pub referral_code: Box<Account<'info, ReferralCode>>,

    /// The code holder's `Trader`, which always exists: claiming a code makes it.
    #[account(
        mut,
        seeds = [TRADER_SEED, referral_code.owner.as_ref()],
        bump = referrer_trader.bump,
    )]
    pub referrer_trader: Box<Account<'info, Trader>>,

    pub system_program: Program<'info, System>,
}

/// Names the wallet that referred this one.
///
/// Once, and only before the first fill. Allowing it later would let a wallet
/// shop its referral to whoever pays the largest kickback, which makes the
/// referrer a bidder rather than the person who brought them.
pub fn set_referrer(ctx: Context<SetReferrer>, _code: [u8; REFERRAL_CODE_LEN]) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let owner = ctx.accounts.owner.key();
    let referrer = ctx.accounts.referral_code.owner;
    require_keys_neq!(referrer, owner, PerpError::SelfReferral);

    let trader = &mut ctx.accounts.trader;
    open_trader(trader, owner, ctx.bumps.trader, now);
    require!(
        !trader.has_referrer() && trader.volume_usd == 0,
        PerpError::ReferrerLocked
    );
    trader.referrer = referrer;

    let r = &mut ctx.accounts.referrer_trader;
    r.referral_count = r.referral_count.saturating_add(1);

    emit!(ReferrerSet { owner, referrer });
    Ok(())
}

#[derive(Accounts)]
pub struct SyncReferral<'info> {
    #[account(mut, seeds = [TRADER_SEED, referee.owner.as_ref()], bump = referee.bump)]
    pub referee: Box<Account<'info, Trader>>,

    #[account(
        mut,
        seeds = [TRADER_SEED, referee.referrer.as_ref()],
        bump = referrer.bump,
    )]
    pub referrer: Box<Account<'info, Trader>>,
}

/// Moves what a referee's trading has earned their referrer across to them.
/// Permissionless: it can only pay the referrer the referee named.
pub fn sync_referral(ctx: Context<SyncReferral>) -> Result<()> {
    let referee = &mut ctx.accounts.referee;
    let referrer = &mut ctx.accounts.referrer;
    referrer.points = referrer
        .points
        .checked_add(referee.referrer_points_owed)
        .ok_or(PerpError::MathOverflow)?;
    referrer.rewards_usd = referrer
        .rewards_usd
        .checked_add(referee.referrer_rewards_owed)
        .ok_or(PerpError::MathOverflow)?;
    referrer.referral_earned_usd = referrer
        .referral_earned_usd
        .saturating_add(referee.referrer_rewards_owed);
    referrer.referred_volume_usd = referrer
        .referred_volume_usd
        .saturating_add(referee.referrer_volume_owed);
    referee.referrer_points_owed = 0;
    referee.referrer_rewards_owed = 0;
    referee.referrer_volume_owed = 0;
    Ok(())
}

#[derive(Accounts)]
pub struct SyncDeployer<'info> {
    #[account(mut)]
    pub market: Box<Account<'info, Market>>,

    #[account(
        mut,
        seeds = [TRADER_SEED, market.deployer.as_ref()],
        bump = deployer.bump,
    )]
    pub deployer: Box<Account<'info, Trader>>,
}

/// Moves a market's listing rewards to whoever listed it: their share of its
/// fees and points on its volume since the last sync. Permissionless: it can
/// only pay the market's own deployer.
pub fn sync_deployer(ctx: Context<SyncDeployer>) -> Result<()> {
    let market = &mut ctx.accounts.market;
    let deployer = &mut ctx.accounts.deployer;
    let new_volume = market.volume_usd.saturating_sub(market.deployer_synced_volume_usd);
    let points = crate::math::bps_of(volume_points(new_volume), DEPLOYER_POINTS_BPS)?;
    deployer.points = deployer.points.checked_add(points).ok_or(PerpError::MathOverflow)?;
    deployer.rewards_usd = deployer
        .rewards_usd
        .checked_add(market.deployer_rewards_usd)
        .ok_or(PerpError::MathOverflow)?;
    deployer.listing_earned_usd = deployer
        .listing_earned_usd
        .saturating_add(market.deployer_rewards_usd);
    market.deployer_synced_volume_usd = market.volume_usd;
    market.deployer_rewards_usd = 0;
    Ok(())
}

#[derive(Accounts)]
pub struct ClaimRewards<'info> {
    pub owner: Signer<'info>,

    #[account(mut, seeds = [POOL_SEED, pool.usdc_mint.as_ref()], bump = pool.bump)]
    pub pool: Box<Account<'info, Pool>>,

    #[account(
        mut,
        seeds = [TRADER_SEED, owner.key().as_ref()],
        bump = trader.bump,
    )]
    pub trader: Box<Account<'info, Trader>>,

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

/// Pays out everything this wallet has earned from referrals and listings.
pub fn claim_rewards(ctx: Context<ClaimRewards>) -> Result<()> {
    let amount = ctx.accounts.trader.rewards_usd;
    require!(amount > 0, PerpError::NothingToClaim);
    // Always true while the books reconcile; checked so a bug elsewhere
    // cannot turn this into a way to take LP money.
    require!(amount <= ctx.accounts.pool.rewards_usd, PerpError::InsufficientLiquidity);

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
        amount,
        ctx.accounts.usdc_mint.decimals,
    )?;

    ctx.accounts.pool.rewards_usd -= amount;
    let trader = &mut ctx.accounts.trader;
    trader.rewards_usd = 0;
    trader.rewards_claimed_usd = trader.rewards_claimed_usd.saturating_add(amount);

    emit!(RewardsClaimed { owner: trader.owner, amount_usd: amount });
    Ok(())
}

#[derive(Accounts)]
pub struct AccruePoints<'info> {
    #[account(mut, seeds = [TRADER_SEED, trader.owner.as_ref()], bump = trader.bump)]
    pub trader: Box<Account<'info, Trader>>,

    #[account(seeds = [POOL_SEED, pool.usdc_mint.as_ref()], bump = pool.bump)]
    pub pool: Box<Account<'info, Pool>>,

    /// The trader's LP token account, so LP points are paid only on what is
    /// still held. Omit it for a wallet with none; its LP stake then counts
    /// as zero from here on, which only ever errs against it.
    #[account(
        constraint = owner_lp.mint == pool.lp_mint,
        constraint = owner_lp.owner == trader.owner,
    )]
    pub owner_lp: Option<Box<InterfaceAccount<'info, TokenAccount>>>,
}

/// Brings a wallet's backing and LP points up to now. Permissionless, since
/// all it does is count time that has already passed.
pub fn accrue_points(ctx: Context<AccruePoints>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let balance = ctx.accounts.owner_lp.as_ref().map(|a| a.amount).unwrap_or(0);
    let trader = &mut ctx.accounts.trader;
    trader.accrue_backing(now)?;
    trader.accrue_lp(balance, now)?;
    Ok(())
}

#[event]
pub struct ReferralCodeClaimed {
    pub owner: Pubkey,
    pub code: [u8; REFERRAL_CODE_LEN],
}

#[event]
pub struct ReferrerSet {
    pub owner: Pubkey,
    pub referrer: Pubkey,
}

#[event]
pub struct RewardsClaimed {
    pub owner: Pubkey,
    pub amount_usd: u64,
}
