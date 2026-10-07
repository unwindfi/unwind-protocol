//! Shared pieces for the harness files added after the first nine: blank
//! accounts to fill in, and the stand-ins for error text and the event log.
//!
//! The older files each carry their own copy of these, and keep them.

use crate::errors::PerpError;
use crate::state::{Market, Pool, Position, PriceSource, Session, SideFunding, SideMoments};
use crate::state::market::PRICE_FACTOR_ONE;
use anchor_lang::prelude::Pubkey;

// Stand-ins for the text of an error and the event log.
//
// `require!` builds an Anchor error carrying the variant's name and message as
// `String`s, and `?` on a `PerpError` goes through anchor's `From`, which
// formats the same text. No harness reads either, only whether a call failed,
// so all three return nothing; the error code and the control flow are kept.
// The log call is what `emit!` reaches, and Kani's compiler cannot follow the
// host logging path behind it. An event moves no money.
pub fn no_name(_: &PerpError) -> String {
    String::new()
}

pub fn no_message(_: &PerpError, _: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
    Ok(())
}

pub fn no_log(_: &[&[u8]]) {}

pub fn cheap_error(e: PerpError) -> anchor_lang::error::Error {
    anchor_lang::error::Error::from(
        anchor_lang::solana_program::program_error::ProgramError::Custom(u32::from(e)),
    )
}

/// A symbolic amount from 0 to 255, widened so the high bits are constant.
pub fn byte() -> u64 {
    kani::any::<u8>() as u64
}

/// A symbolic amount from 0 to 31.
pub fn five_bits() -> u64 {
    (kani::any::<u8>() & 0x1f) as u64
}

/// A symbolic amount from 0 to 15.
pub fn nibble() -> u64 {
    (kani::any::<u8>() & 0x0f) as u64
}

/// A market with every field zero except the price factor, which is the one
/// positions are written under, so no corporate action is in play.
pub fn blank_market() -> Market {
    Market {
        bump: 0,
        pool: Pubkey::default(),
        symbol: [0; 16],
        feed_id: [0; 32],
        max_price_age_sec: 0,
        max_conf_bps: 0,
        max_leverage_bps: 0,
        maintenance_margin_bps: 0,
        liquidation_fee_bps: 0,
        open_fee_bps: 0,
        close_fee_bps: 0,
        min_position_usd: 0,
        max_oi_long_usd: 0,
        max_oi_short_usd: 0,
        pnl_reserve_bps: 0,
        base_spread_bps: 0,
        conf_spread_mult_bps: 0,
        max_spread_bps: 0,
        session: Session::Regular as u8,
        closed_session_leverage_bps: 0,
        closed_session_oi_mult_bps: 0,
        cumulative_long_funding: 0,
        cumulative_short_funding: 0,
        last_funding_ts: 0,
        max_funding_rate_bps_per_hour: 0,
        funding_k_bps: 0,
        borrow_rate_bps_per_hour: 0,
        long_size_usd: 0,
        long_avg_entry_price: 0,
        short_size_usd: 0,
        short_avg_entry_price: 0,
        collateral_usd: 0,
        price_factor: PRICE_FACTOR_ONE,
        split_epoch: 0,
        last_multiplier: 0,
        paused: false,
        loss_budget_usd: 0,
        net_loss_usd: 0,
        locked_usd: 0,
        price_source: PriceSource::Pyth as u8,
        observation: Pubkey::default(),
        deployer: Pubkey::default(),
        backing_usd: 0,
        backing_shares: 0,
        backing_drawn_usd: 0,
        last_price_ts: 0,
        depth_leverage_x: 0,
        risk_step_rem: 0,
        last_price: 0,
        risk_price: 0,
        risk_slot: 0,
        generation: 0,
        aum_drift_usd: 0,
        deployer_points_owed: 0,
        insurance_drawn_usd: 0,
        _reserved: [0; 4],
        batch_net_usd: 0,
        batch_backing_usd: 0,
        batch_insurance_usd: 0,
        batch_backer_fees_usd: 0,
        long_moments: SideMoments::default(),
        short_moments: SideMoments::default(),
        long_funding: SideFunding::default(),
        short_funding: SideFunding::default(),
        volume_usd: 0,
        deployer_synced_volume_usd: 0,
        deployer_rewards_usd: 0,
        deployer_earned_usd: 0,
    }
}

/// A pool with every field zero, on the documented fee split (docs/fees.md:
/// 20 percent protocol, 10 percent insurance; the chain's 10 is a constant).
pub fn blank_pool() -> Pool {
    Pool {
        bump: 0,
        vault_bump: 0,
        lp_mint_bump: 0,
        authority: Pubkey::default(),
        pending_authority: Pubkey::default(),
        usdc_mint: Pubkey::default(),
        usdc_vault: Pubkey::default(),
        lp_mint: Pubkey::default(),
        num_markets: 1,
        liquidity_usd: 0,
        locked_usd: 0,
        trader_collateral_usd: 0,
        protocol_fees_usd: 0,
        add_liquidity_fee_bps: 0,
        remove_liquidity_fee_bps: 0,
        protocol_fee_share_bps: 2_000,
        max_utilization_bps: 0,
        insurance_usd: 0,
        insurance_fee_share_bps: 1_000,
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
        no_points: false,
        aum_drift_usd: 0,
    }
}

/// An empty position on `is_long`'s side, under the blank market's factor.
pub fn blank_position(is_long: bool) -> Position {
    Position {
        bump: 0,
        owner: Pubkey::default(),
        market: Pubkey::default(),
        is_long,
        size_usd: 0,
        collateral_usd: 0,
        entry_price: 0,
        entry_price_factor: PRICE_FACTOR_ONE,
        entry_funding: 0,
        locked_usd: 0,
        closing_usd: 0,
        open_ts: 0,
        last_update_ts: 0,
        q_epoch: 0,
        f_epoch: 0,
        held_ts: 0,
        _reserved: [0; 8],
    }
}
