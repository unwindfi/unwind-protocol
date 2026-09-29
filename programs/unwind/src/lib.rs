//! # unwind
//!
//! Permissionless perpetual futures on Solana, cleared by dual flow batch auction.
//!
//! Anyone can open a market on an asset with an on-chain price: a Pyth feed,
//! or the asset's own Raydium CLMM or Meteora DLMM pool, observed until its
//! mark has a history. Orders collect for one second and clear as two
//! auctions, takers buying against makers selling and takers selling against
//! makers buying, each at one price (`auction`). The USDC pool fills only the
//! takers the makers leave standing.
//!
//! A new market trades only once someone posts backing, which absorbs its
//! losses before any liquidity provider's capital (`instructions::backing`),
//! and its loss budget is capped at what its source pool costs to move.
//!
//! Tokenized equities remain one market type: their underlying stops trading,
//! so sessions tighten caps while it is shut, and splits are applied through a
//! market-wide price factor so open positions keep their exposure.

use anchor_lang::prelude::*;

pub mod amm;
pub mod auction;
pub mod aum;
pub mod constants;
pub mod errors;
pub mod instructions;
pub mod math;
pub mod oracle;
pub mod state;

/// Kani model-checking harnesses. Compiled only by `cargo kani`, never into
/// the program.
#[cfg(kani)]
mod proofs;

use instructions::*;

declare_id!("E8pRnTEfPFCcCPw9SQyrygMpLKRavo9oBYrf8qWQufmw");

#[program]
pub mod unwind {
    use super::*;

    // --- admin ---

    pub fn initialize_pool(ctx: Context<InitializePool>, params: PoolParams) -> Result<()> {
        instructions::admin::initialize_pool(ctx, params)
    }

    pub fn add_market(ctx: Context<AddMarket>, params: MarketParams) -> Result<()> {
        instructions::admin::add_market(ctx, params)
    }

    pub fn update_market_params(ctx: Context<UpdateMarket>, params: MarketParams) -> Result<()> {
        instructions::admin::update_market_params(ctx, params)
    }

    /// 0 = regular hours, 1 = extended, 2 = closed.
    pub fn set_session(ctx: Context<UpdateMarket>, session: u8) -> Result<()> {
        instructions::admin::set_session(ctx, session)
    }

    /// Funds (or defunds) a market's loss budget. Zero stops it opening
    /// positions without unwinding the ones it has.
    /// Begins observing an AMM pool as the mark for a market with no Pyth
    /// feed. Permissionless: it starts a clock and nothing else.
    pub fn create_observation(
        ctx: Context<CreateObservation>,
        params: ObservationParams,
    ) -> Result<()> {
        instructions::observe::create_observation(ctx, params)
    }

    /// Cuts a market's loss budget to what its pool's depth supports.
    /// Permissionless downwards only; raising stays with the risk owner.
    pub fn derive_market_budget(ctx: Context<DeriveBudget>) -> Result<()> {
        instructions::observe::derive_market_budget(ctx)
    }

    /// Folds one reading of the pool into the mark. Permissionless.
    pub fn observe(ctx: Context<Observe>) -> Result<()> {
        instructions::observe::observe(ctx)
    }

    /// Names the key whose pushed prices mark keeper-priced markets.
    /// Pool authority only.
    pub fn set_mark_keeper(ctx: Context<SetMarkKeeper>, keeper: Pubkey) -> Result<()> {
        instructions::observe::set_mark_keeper(ctx, keeper)
    }

    /// Sets an observed market's mark to the keeper's price. The first push
    /// makes the market tradeable. Mark keeper only.
    pub fn push_mark(ctx: Context<PushMark>, price: u64) -> Result<()> {
        instructions::observe::push_mark(ctx, price)
    }

    /// Opens a market's first batch. Permissionless.
    pub fn create_batch(ctx: Context<CreateBatch>) -> Result<()> {
        instructions::batch::create_batch(ctx)
    }

    /// Puts an order into the market's collecting batch. It fills at its
    /// flow's clearing price, which is never worse than the limit given.
    ///
    /// `reduce_only` closes existing size instead of opening new size, and is
    /// the only way out of a position. It escrows nothing -- `collateral_usd`
    /// is ignored -- and reserves size against the position instead.
    ///
    /// `is_maker` rests the order as liquidity: it trades only against takers
    /// on the other side, in the batch's other flow, and never with the pool.
    pub fn submit_order(
        ctx: Context<SubmitOrder>,
        price: u64,
        size_usd: u64,
        collateral_usd: u64,
        is_bid: bool,
        reduce_only: bool,
        is_maker: bool,
    ) -> Result<()> {
        instructions::batch::submit_order(
            ctx, price, size_usd, collateral_usd, is_bid, reduce_only, is_maker,
        )
    }

    /// Withdraws an order and returns its collateral, while the batch is open.
    pub fn cancel_batch_order(ctx: Context<CancelBatchOrder>, index: u8) -> Result<()> {
        instructions::batch::cancel_batch_order(ctx, index)
    }

    /// Seals a batch at the price that crosses the most volume. Permissionless
    /// and deterministic: the caller supplies no price and chooses nothing.
    pub fn clear_batch(ctx: Context<ClearBatch>) -> Result<()> {
        instructions::batch::clear_batch(ctx)
    }

    /// Settles one order of a sealed batch at that batch's clearing price.
    /// Permissionless: the price and the fill were both fixed at sealing.
    pub fn settle_order(ctx: Context<SettleOrder>, index: u8) -> Result<()> {
        instructions::batch::settle_order(ctx, index)
    }

    /// Sweeps the chain's share of revenue to the destination fixed at pool
    /// creation. Permissionless, and it can pay nobody else.
    pub fn collect_chain_fees(ctx: Context<CollectChainFees>) -> Result<()> {
        instructions::crank::collect_chain_fees(ctx)
    }

    /// Underwrites a market with your own money, without asking anyone.
    /// `amount` is in the deposit token's base units: USDC, or any custody's.
    pub fn back_market<'info>(
        ctx: Context<'_, '_, 'info, 'info, BackMarket<'info>>,
        amount: u64,
    ) -> Result<()> {
        instructions::backing::back_market(ctx, amount)
    }

    /// Takes it back out, in the same mix it is held in, if the market's open
    /// positions still allow it.
    pub fn unback_market<'info>(
        ctx: Context<'_, '_, 'info, 'info, UnbackMarket<'info>>,
        shares: u64,
    ) -> Result<()> {
        instructions::backing::unback_market(ctx, shares)
    }

    /// Settles in-kind backing against losses the LPs covered. Permissionless.
    pub fn sync_backing<'info>(
        ctx: Context<'_, '_, 'info, 'info, SyncBacking<'info>>,
    ) -> Result<()> {
        instructions::backing::sync_backing(ctx)
    }

    /// Lets backing be held in another token, JLP-style.
    pub fn add_custody(ctx: Context<AddCustody>, params: CustodyParams) -> Result<()> {
        instructions::admin::add_custody(ctx, params)
    }

    pub fn set_market_budget(ctx: Context<UpdateMarket>, loss_budget_usd: u64) -> Result<()> {
        instructions::admin::set_market_budget(ctx, loss_budget_usd)
    }

    pub fn set_market_paused(ctx: Context<UpdateMarket>, paused: bool) -> Result<()> {
        instructions::admin::set_market_paused(ctx, paused)
    }

    /// `numerator / denominator` is what the price is multiplied by: a 4-for-1
    /// split passes `(1, 4)`. Requires the market to be paused.
    pub fn apply_corporate_action(
        ctx: Context<UpdateMarket>,
        numerator: u64,
        denominator: u64,
        new_multiplier: u64,
    ) -> Result<()> {
        instructions::admin::apply_corporate_action(ctx, numerator, denominator, new_multiplier)
    }

    pub fn set_pool_paused(ctx: Context<UpdatePool>, paused: bool) -> Result<()> {
        instructions::admin::set_pool_paused(ctx, paused)
    }

    pub fn nominate_authority(ctx: Context<UpdatePool>, new_authority: Pubkey) -> Result<()> {
        instructions::admin::nominate_authority(ctx, new_authority)
    }

    pub fn accept_authority(ctx: Context<AcceptAuthority>) -> Result<()> {
        instructions::admin::accept_authority(ctx)
    }

    pub fn collect_protocol_fees(ctx: Context<CollectProtocolFees>, amount: u64) -> Result<()> {
        instructions::crank::collect_protocol_fees(ctx, amount)
    }

    /// Adds capital to the insurance fund. Permissionless — see the handler.
    pub fn fund_insurance(ctx: Context<FundInsurance>, amount: u64) -> Result<()> {
        instructions::crank::fund_insurance(ctx, amount)
    }

    // --- liquidity ---

    /// `remaining_accounts` must be `(market, price_update)` pairs for every
    /// market in the pool, then `(custody, price_update)` for every custody, so
    /// LP shares price against the pool's full liability and everything it holds.
    pub fn add_liquidity<'info>(
        ctx: Context<'_, '_, 'info, 'info, ManageLiquidity<'info>>,
        amount_usd: u64,
        min_lp_out: u64,
    ) -> Result<()> {
        instructions::liquidity::add_liquidity(ctx, amount_usd, min_lp_out)
    }

    pub fn remove_liquidity<'info>(
        ctx: Context<'_, '_, 'info, 'info, ManageLiquidity<'info>>,
        lp_amount: u64,
        min_usd_out: u64,
    ) -> Result<()> {
        instructions::liquidity::remove_liquidity(ctx, lp_amount, min_usd_out)
    }

    // --- trading ---

    // `close_position` was here. Exits go through `submit_order` with
    // `reduce_only`, so that the price a trader leaves at is set by the same
    // auction as the price they arrived at.

    pub fn liquidate(ctx: Context<Liquidate>) -> Result<()> {
        instructions::liquidate::liquidate(ctx)
    }

    /// Force-closes a position whose profit has outgrown the liquidity reserved
    /// against it. Permissionless; the trader is paid full equity.
    pub fn auto_deleverage(ctx: Context<AutoDeleverage>) -> Result<()> {
        instructions::adl::auto_deleverage(ctx)
    }

    // --- trigger orders ---

    /// Records a take-profit or stop-loss. `size_usd` of 0 closes the lot.
    pub fn place_order(ctx: Context<PlaceOrder>, params: OrderParams) -> Result<()> {
        instructions::orders::place_order(ctx, params)
    }

    pub fn cancel_order(ctx: Context<CancelOrder>) -> Result<()> {
        instructions::orders::cancel_order(ctx)
    }

    /// Fires a triggered order, or clears an expired one. Permissionless.
    pub fn execute_order(ctx: Context<ExecuteOrder>) -> Result<()> {
        instructions::orders::execute_order(ctx)
    }

    pub fn accrue_funding(ctx: Context<AccrueFunding>) -> Result<()> {
        instructions::crank::accrue_funding(ctx)
    }

    // --- referrals and points ---

    /// Makes the wallet's points record. Trading, backing and providing
    /// liquidity make it too; this is for a wallet that has done none yet.
    pub fn create_trader(ctx: Context<CreateTrader>) -> Result<()> {
        instructions::referral::create_trader(ctx)
    }

    /// Takes a referral code: 3 to 16 of `a-z 0-9 _ -`, zero-padded. First
    /// come, one per wallet, permanent.
    pub fn claim_referral_code(
        ctx: Context<ClaimReferralCode>,
        code: [u8; constants::REFERRAL_CODE_LEN],
    ) -> Result<()> {
        instructions::referral::claim_referral_code(ctx, code)
    }

    /// Names the code of the wallet that referred this one. Once, before the
    /// first fill.
    pub fn set_referrer(
        ctx: Context<SetReferrer>,
        code: [u8; constants::REFERRAL_CODE_LEN],
    ) -> Result<()> {
        instructions::referral::set_referrer(ctx, code)
    }

    /// Moves what a referee has earned their referrer across. Permissionless.
    pub fn sync_referral(ctx: Context<SyncReferral>) -> Result<()> {
        instructions::referral::sync_referral(ctx)
    }

    /// Moves a market's listing rewards to its deployer. Permissionless.
    pub fn sync_deployer(ctx: Context<SyncDeployer>) -> Result<()> {
        instructions::referral::sync_deployer(ctx)
    }

    /// Pays out the wallet's referral and listing rewards in USDC.
    pub fn claim_rewards(ctx: Context<ClaimRewards>) -> Result<()> {
        instructions::referral::claim_rewards(ctx)
    }

    /// Brings a wallet's backing and LP points up to now. Permissionless.
    pub fn accrue_points(ctx: Context<AccruePoints>) -> Result<()> {
        instructions::referral::accrue_points(ctx)
    }
}
