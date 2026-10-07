use crate::constants::*;
use crate::errors::PerpError;
use crate::math::*;
use crate::oracle::OraclePrice;
use super::position::Position;
use anchor_lang::prelude::*;

/// Neutral value of `Market::price_factor`.
pub const PRICE_FACTOR_ONE: u128 = 1_000_000_000_000;

/// Which trading session the underlying equity is in.
///
/// This is not cosmetic. When NYSE is closed the only arbitrage keeping the
/// index honest is against the xStock spot pool on Solana, which is thin, so
/// both leverage and open interest have to come down.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u8)]
pub enum Session {
    Regular = 0,
    Extended = 1,
    Closed = 2,
}

impl Session {
    pub fn from_u8(v: u8) -> Result<Self> {
        match v {
            0 => Ok(Session::Regular),
            1 => Ok(Session::Extended),
            2 => Ok(Session::Closed),
            _ => Err(PerpError::InvalidParameter.into()),
        }
    }
}

#[account]
#[derive(InitSpace)]
pub struct Market {
    pub bump: u8,
    pub pool: Pubkey,
    /// Display symbol, e.g. "AAPLx".
    pub symbol: [u8; 16],
    /// Pyth price feed id for the 24/7 equity index.
    pub feed_id: [u8; 32],

    pub max_price_age_sec: u32,
    /// Halt threshold on the oracle confidence interval, as bps of price.
    pub max_conf_bps: u16,

    pub max_leverage_bps: u32,
    pub maintenance_margin_bps: u16,
    pub liquidation_fee_bps: u16,
    pub open_fee_bps: u16,
    pub close_fee_bps: u16,
    pub min_position_usd: u64,
    pub max_oi_long_usd: u64,
    pub max_oi_short_usd: u64,
    /// Liquidity reserved against each USD of notional, to back trader profit.
    /// 10_000 reserves the full notional, which covers a 100% adverse move.
    pub pnl_reserve_bps: u16,

    /// Spread floor charged on every fill, in bps of the index.
    pub base_spread_bps: u16,
    /// How hard the spread widens with oracle confidence.
    pub conf_spread_mult_bps: u16,
    pub max_spread_bps: u16,

    pub session: u8,
    /// Leverage ceiling that replaces `max_leverage_bps` while closed.
    pub closed_session_leverage_bps: u32,
    /// Fraction of the OI caps that applies while closed, in bps.
    pub closed_session_oi_mult_bps: u16,

    /// Cumulative funding + borrow paid per 1 USD of notional, `FUNDING_SCALE`.
    pub cumulative_long_funding: i128,
    pub cumulative_short_funding: i128,
    pub last_funding_ts: i64,
    pub max_funding_rate_bps_per_hour: u16,
    /// Sensitivity of funding to OI skew.
    pub funding_k_bps: u16,
    /// Borrow rate at 100% utilization; scaled linearly below that.
    pub borrow_rate_bps_per_hour: u16,

    pub long_size_usd: u64,
    pub long_avg_entry_price: u64,
    pub short_size_usd: u64,
    pub short_avg_entry_price: u64,
    pub collateral_usd: u64,

    /// Cumulative corporate-action price adjustment, `PRICE_FACTOR_ONE` base.
    /// Every stored entry price is expressed in the factor that was current when
    /// it was written, so a split never has to rewrite individual positions.
    pub price_factor: u128,
    pub split_epoch: u32,
    /// Last observed Token-2022 ScaledUiAmount multiplier on the xStock, kept so
    /// an unannounced rebase can be detected off-chain and reconciled.
    pub last_multiplier: u64,

    pub paused: bool,

    /// The most this market may ever cost the LPs, net, in USD.
    ///
    /// This is the whole of what makes open listing survivable. Every market in
    /// the pool draws on one balance sheet, so without a per-market ceiling the
    /// worst market decides what the pool is worth: a feed someone can move for
    /// $20k, listed at 20x, is a licence to drain every LP in every other
    /// market. The budget is an allowance rather than a separate balance — the
    /// money still lives in the one vault and the accounting is unchanged —
    /// and what it buys is a hard answer to "how much can this listing lose".
    ///
    /// Zero means unfunded: the market can be listed and quoted, but it cannot
    /// open a position, which is the safe state for a market nobody has
    /// underwritten yet.
    pub loss_budget_usd: u64,
    /// Cumulative realised PnL this market has taken from the pool, signed.
    /// Positive is LPs down. Checked against `loss_budget_usd` on every payout.
    pub net_loss_usd: i64,
    /// This market's share of `Pool::locked_usd`, reserved against the profit
    /// its open positions could make. Tracked per market so a market can be
    /// wound down — or blown up — without unpicking the global figure.
    pub locked_usd: u64,

    /// Where this market's mark comes from. A market with no Pyth feed points
    /// at an `Observation` instead, which is what lets anything with a
    /// Raydium pool be listed alongside anything with an oracle.
    pub price_source: u8,
    /// The `Observation` account, when `price_source` is `Observed`. Fixed at
    /// listing: a market that could be repointed at a different mark is a
    /// market whose positions can be revalued by whoever repoints it.
    pub observation: Pubkey,

    /// Who listed it. Owed `DEPLOYER_FEE_SHARE_BPS` of the market's fees and
    /// points on its volume, and trades it at `DEPLOYER_DISCOUNT_BPS` off.
    pub deployer: Pubkey,

    /// USDC posted by this market's backers. Real money, sitting in the same
    /// vault as everything else and accounted apart from LP capital.
    ///
    /// This is what lets open listing finish rather than stall. Underwriting
    /// used to be the pool authority's decision, which meant a stranger could
    /// list a market and then wait on us forever. Backing lets whoever wants
    /// the market to exist post the allowance themselves, and it is strictly
    /// safer than an authority granting one: the allowance becomes collateral
    /// somebody put up rather than a number somebody typed.
    pub backing_usd: u64,
    /// Claims on `backing_usd`. A share is worth `backing_usd / backing_shares`,
    /// so a backer arriving after a drawdown buys in at the reduced price and
    /// one leaving after a recovery takes their part of it.
    pub backing_shares: u64,
    /// How much backing this market's losses have consumed, cumulative.
    ///
    /// Tracked so a later gain can put the money back where it came from.
    /// Without it a market that lost and then won would have taken from the
    /// backers and paid the LPs, which is the wrong way round for both.
    pub backing_drawn_usd: u64,

    /// Publish time of the newest price this market has acted on, in unix
    /// seconds. A price older than this is refused (see `accept_price`).
    pub last_price_ts: u32,
    /// Leverage, in x, the tracked pool's sustained depth supports, written
    /// by every `observe`. Zero on a market with no observation, which is not
    /// capped by depth at all; an observed market reads zero as the lowest
    /// tier until its first reading lands. See `DEPTH_LEVERAGE_TIERS`.
    pub depth_leverage_x: u8,

    /// Notional filled on this market, opens and closes, in `USD_SCALE`.
    pub volume_usd: u64,
    /// How much of `volume_usd` has already earned the deployer points.
    pub deployer_synced_volume_usd: u64,
    /// The deployer's share of this market's fees, not yet moved to their
    /// `Trader`. Held in the vault under `Pool::rewards_usd`.
    pub deployer_rewards_usd: u64,
    /// Everything the deployer has been owed from this market, synced or not.
    pub deployer_earned_usd: u64,
    /// What the last risk price step's division left over, in bps of a unit.
    /// See `oracle::risk_step`. Was the last two bytes of `_reserved`.
    pub risk_step_rem: u16,

    // Everything below was added after the first markets were listed, which
    // grew the account. `resize_market` grows an older one; the new fields
    // start at zero, which each of them reads as "nothing recorded yet".

    /// The price published at `last_price_ts`, so a second, different price
    /// under the same publish time is refused. Zero when not yet recorded.
    pub last_price: u64,
    /// The price liquidation reads: the oracle, followed at no more than
    /// `RISK_PRICE_STEP_BPS_PER_SLOT` a slot. See `accept_price`.
    pub risk_price: u64,
    /// Slot `risk_price` was last stepped in.
    pub risk_slot: u64,
    /// Which listing of this feed in this pool it is, from 1; part of the
    /// address (see `market_generations::market_seeds`). Zero on a market
    /// listed before generations, which sits at the old address. Was the
    /// first four bytes of `_reserved`.
    pub generation: u32,
    /// This market's part of `Pool::aum_drift_usd`: how much what it owes the
    /// LPs has moved, wrapping, since it last gained open interest. Zero while
    /// it has none. Was eight bytes of `_reserved`.
    pub aum_drift_usd: i64,
    /// Points owed to the deployer and not yet moved to their `Trader`:
    /// `DEPLOYER_POINTS_BPS` of the trading points this market's traders are
    /// credited, the deployer's own excluded. Was eight bytes of `_reserved`.
    pub deployer_points_owed: u64,
    /// What the insurance fund has paid toward this market's losses and has
    /// not been repaid. The fund ranks after the backers, in kind included,
    /// so this is the first thing in-kind backing repays (`backing::sync`).
    /// Was eight bytes of `_reserved`.
    pub insurance_drawn_usd: u64,
    pub _reserved: [u8; 4],

    // Added after `_reserved`, which grew the account again; run
    // `resize_market` on a market listed before. Zero reads as "no position
    // tracked yet", which is what every existing position is.

    /// Each side's moment sums over the positions it tracks, which bound the
    /// profit winners hold on it however that side's losers net against them.
    /// See `side_winners_bound_usd`.
    pub long_moments: SideMoments,
    pub short_moments: SideMoments,

    // Added after the moments, which grew the account again; run
    // `resize_market` on a market listed before. Zero reads as "no position
    // tracked yet". A position is in these when its `Position::f_epoch` is
    // `q_tag`, which no position written before them carries.

    /// Each side's funding sums over the positions it tracks, which let the
    /// pool count the funding and borrow its open positions owe it before
    /// they close (`funding_owed_usd`), and bound the bad debt a side can
    /// hold (`side_bad_debt_bound_usd`).
    pub long_funding: SideFunding,
    pub short_funding: SideFunding,

    // Added after the funding sums, which grew the account again; run
    // `resize_market` on a market listed before. Zero is "no sealed batch
    // being settled", which is what an older market is between batches.

    /// What the closes settled so far out of this market's sealed batch have
    /// cost the pool, net: positive when the pool paid. See
    /// `settle_backing_in_batch`.
    pub batch_net_usd: i64,
    /// What those closes have drawn from the backing, net of what they put
    /// back: negative when they restored more than they drew.
    pub batch_backing_usd: i64,
    /// What those closes have drawn from the insurance fund and not put back.
    pub batch_insurance_usd: u64,
    /// Fees the batch's settlements have paid the backers. Not drawn on by
    /// the batch's own closes, so that whether a fee lands before or after a
    /// draw that empties the backing does not decide who keeps it.
    pub batch_backer_fees_usd: u64,
}

/// Sums over one side's tracked positions, each held at its entry in today's
/// price factor. A position is tracked when its `Position::q_epoch` is this
/// market's `q_tag`; one opened before these sums existed is not, and its side
/// reads incomplete (`tracked_usd` short of the side's size) until it is gone.
///
/// Every write replaces one position's whole term (`Market::retrack`), so the
/// sums always equal a fresh recomputation from the tracked positions.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, PartialEq, Eq, Debug, InitSpace)]
pub struct SideMoments {
    /// Sum of tracked sizes, `USD_SCALE`.
    pub tracked_usd: u64,
    /// Sum of `floor(size * MOMENT_U_SCALE / entry)`.
    pub inv_entry: u128,
    /// Sum of `ceil(ceil(size * MOMENT_Q_STEP / entry) * MOMENT_Q_STEP / entry)`.
    pub inv_entry_sq: u128,
}

/// Funding sums over one side's tracked positions. Membership is the
/// moments' (`q_tag`), carried in `Position::f_epoch` so a position tracked
/// in the moments before these sums existed is not counted as if it were in
/// them. `tracked_usd` and `size_entry_funding` are replaced a position's
/// whole term at a time (`Market::retrack_funding`), so they always equal a
/// fresh recomputation; `min_cover` and `worst_entry` only ever move toward
/// the worse value while anything is tracked, and start again from the next
/// position once nothing is.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, PartialEq, Eq, Debug, InitSpace)]
pub struct SideFunding {
    /// Sum of tracked sizes, `USD_SCALE`.
    pub tracked_usd: u64,
    /// Sum of `size * entry_funding`, wrapping: only `tracked_usd * index`
    /// less this is read, and that difference is exact whenever it fits.
    pub size_entry_funding: i128,
    /// The least, over every position tracked since the side last held none,
    /// of `floor(collateral * FUNDING_SCALE / size) + entry_funding`: the
    /// funding index at which that position's collateral is used up by
    /// funding alone. A partial close never lowers a position's value, so
    /// it stays at or under every tracked position's.
    pub min_cover: i128,
    /// The worst entry tracked since the side last held none, in today's
    /// price factor: the highest on the long side, the lowest on the short.
    pub worst_entry: u64,
}

/// One position's term in its side's `SideFunding`.
#[derive(Clone, Copy, Debug)]
pub struct FundingTerm {
    pub size: u64,
    pub entry_funding: i128,
    pub collateral: u64,
    /// Entry in today's price factor.
    pub entry: u64,
}

impl FundingTerm {
    /// `floor(collateral * FUNDING_SCALE / size) + entry_funding`. None when
    /// it does not fit, in which case the position is simply not tracked.
    pub fn cover(&self) -> Option<i128> {
        if self.size == 0 {
            return None;
        }
        let ratio = (self.collateral as i128).checked_mul(FUNDING_SCALE)? / self.size as i128;
        ratio.checked_add(self.entry_funding)
    }
}

/// Fixed point of `SideMoments::inv_entry`.
pub const MOMENT_U_SCALE: u128 = 1_000_000_000_000_000_000;
/// Applied twice to `SideMoments::inv_entry_sq`, which is in units of 1e-24.
pub const MOMENT_Q_STEP: u128 = 1_000_000_000_000;

/// One position's terms in its side's `SideMoments`: `size / entry` rounded
/// down and `size / entry^2` rounded up. None when they do not fit, in which
/// case the position is simply not tracked.
pub fn moment_terms(size: u64, entry: u64) -> Option<(u128, u128)> {
    if entry == 0 {
        return None;
    }
    let (s, e) = (size as u128, entry as u128);
    let u = s.checked_mul(MOMENT_U_SCALE)? / e;
    let a = div_ceil_u128(s.checked_mul(MOMENT_Q_STEP)?, e);
    let q = div_ceil_u128(a.checked_mul(MOMENT_Q_STEP)?, e);
    Some((u, q))
}

fn div_ceil_u128(x: u128, d: u128) -> u128 {
    x / d + u128::from(x % d != 0)
}

/// Where a market's mark comes from.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum PriceSource {
    /// A Pyth push feed, keyed by `feed_id`.
    Pyth,
    /// An `Observation` built by repeated readings of an AMM pool.
    Observed,
}

impl PriceSource {
    pub fn from_u8(v: u8) -> Result<Self> {
        match v {
            0 => Ok(PriceSource::Pyth),
            1 => Ok(PriceSource::Observed),
            _ => err!(PerpError::InvalidParameter),
        }
    }
}

impl Market {
    /// Whether `key` is this market's own address, from its stored pool,
    /// feed, generation and bump. No search, so cheap enough for any check.
    pub fn is_at(&self, key: &Pubkey) -> bool {
        let g = self.generation.to_le_bytes();
        let mut seeds = super::market_seeds(self.pool.as_ref(), &self.feed_id, &g);
        let bump = [self.bump];
        seeds.push(&bump);
        Pubkey::create_program_address(&seeds, &crate::ID).map_or(false, |a| a == *key)
    }

    /// What is left of this market's loss allowance.
    pub fn remaining_budget_usd(&self) -> u64 {
        if self.net_loss_usd <= 0 {
            // Already net positive for LPs: the whole budget is intact and the
            // gains on top are not extra rope — a market cannot bank profit
            // into a larger allowance than it was underwritten for.
            return self.loss_budget_usd;
        }
        self.loss_budget_usd.saturating_sub(self.net_loss_usd as u64)
    }

    /// Books `amount` of realised loss against the budget, or fails.
    ///
    /// Failing is the point, and it is why this returns a `Result` rather than
    /// saturating: a market that has spent its allowance must stop paying out
    /// rather than quietly continue onto the next market's capital. The close
    /// that trips this is the one ADL exists to handle.
    pub fn charge_loss(&mut self, amount: u64) -> Result<()> {
        if amount == 0 {
            return Ok(());
        }
        require!(
            amount <= self.remaining_budget_usd(),
            PerpError::MarketBudgetExhausted
        );
        self.net_loss_usd = self
            .net_loss_usd
            .checked_add(i64::try_from(amount).map_err(|_| PerpError::MathOverflow)?)
            .ok_or(PerpError::MathOverflow)?;
        Ok(())
    }

    /// Takes as much of `amount` as this market's backers can cover.
    ///
    /// Backing is drawn before LP capital, which is the entire deal: a market
    /// somebody else opened spends their money first and the LPs' only after.
    /// Returns what was taken, so the caller pays the remainder from the pool.
    pub fn draw_backing(&mut self, amount: u64) -> u64 {
        let taken = amount.min(self.backing_usd);
        self.backing_usd -= taken;
        self.backing_drawn_usd = self.backing_drawn_usd.saturating_add(taken);
        taken
    }

    /// Puts a gain back into backing, up to what losses took out of it.
    ///
    /// Only up to: backers underwrite this market, they do not own its upside.
    /// Anything past what was drawn is the pool's, which is what keeps a
    /// backer from using a market as a leveraged claim on LP profits.
    ///
    /// Nothing is restored while nobody holds a share: the backers who were
    /// drawn on have left, and money put back into an unowned pot would go to
    /// whoever backed the market next. The gain stays with the pool, as a
    /// backer fee does in the same case (`credit_backer_fee`).
    pub fn restore_backing(&mut self, amount: u64) -> u64 {
        if self.backing_shares == 0 {
            return 0;
        }
        let owed = amount.min(self.backing_drawn_usd);
        self.backing_usd = self.backing_usd.saturating_add(owed);
        self.backing_drawn_usd -= owed;
        owed
    }

    /// Draws on or restores the backing for one close settled out of a sealed
    /// batch, `loss` being what the close costs the pool (negative: what it
    /// leaves it). Returns what was drawn, negative for what was restored.
    ///
    /// Closed one at a time, a batch's winner draws the backing and a loser
    /// repays it only up to what has been drawn so far, so the order the
    /// batch is settled in, which whoever settles it chooses, moved value
    /// between the backers and the LPs. Here the backing follows the batch's
    /// running net instead: after every close it stands where the net so far
    /// would leave it if it were one close (drawn up to what the backing held
    /// when the batch began, or restored up to what had been drawn before
    /// it), so once every close has settled it is the same in any order.
    ///
    /// Never moved against the close's own direction or by more than it: a
    /// winner is never paid by restoring backing, nor a loser's gain spent on
    /// a draw.
    pub fn settle_backing_in_batch(&mut self, loss: i64) -> Result<i64> {
        let net = self
            .batch_net_usd
            .checked_add(loss)
            .ok_or(PerpError::MathOverflow)?;
        let done = self.batch_backing_usd as i128;
        let target: i128 = if net >= 0 {
            // Drawable: the backing as the batch found it, without the fees
            // the batch has paid into it since.
            (net as i128).min((self.backing_usd as i128 + done - self.batch_backer_fees_usd as i128).max(0))
        } else {
            // Restorable: what was drawn before the batch.
            -(net.unsigned_abs() as i128).min((self.backing_drawn_usd as i128 - done).max(0))
        };
        let step = if loss >= 0 {
            (target - done).clamp(0, loss as i128)
        } else {
            (target - done).clamp(loss as i128, 0)
        };
        let moved = if step >= 0 {
            self.draw_backing(step as u64) as i64
        } else {
            -(self.restore_backing(step.unsigned_abs() as u64) as i64)
        };
        self.batch_net_usd = net;
        self.batch_backing_usd = self
            .batch_backing_usd
            .checked_add(moved)
            .ok_or(PerpError::MathOverflow)?;
        Ok(moved)
    }

    /// Forgets the batch netting: when a batch seals and when its last order
    /// settles.
    pub fn end_batch_netting(&mut self) {
        self.batch_net_usd = 0;
        self.batch_backing_usd = 0;
        self.batch_insurance_usd = 0;
        self.batch_backer_fees_usd = 0;
    }

    /// Pays this market's backers their cut of `lp_fee`, the LPs' part of a
    /// trading fee, and returns what was paid so the caller can take the same
    /// amount out of pool liquidity.
    ///
    /// Only when there are shares for it to accrue to. A market nobody backs
    /// pays its fees to the LPs exactly as before. One whose backing has been
    /// drawn to zero but still has shares outstanding pays them, so a backer
    /// who stayed through a drawdown earns back into it.
    ///
    /// `backing_drawn_usd` is left alone: fee income is not a repayment of a
    /// loss, and counting it as one would let a later gain skip the backers.
    pub fn credit_backer_fee(&mut self, lp_fee: u64) -> Result<u64> {
        if self.backing_shares == 0 || lp_fee == 0 {
            return Ok(0);
        }
        let share = ((lp_fee as u128) * (BACKER_FEE_SHARE_BPS as u128) / BPS) as u64;
        self.backing_usd = self
            .backing_usd
            .checked_add(share)
            .ok_or(PerpError::MathOverflow)?;
        Ok(share)
    }

    /// What one backer's shares are worth right now.
    ///
    /// Rounds down, so the last backer out cannot take more than is there.
    /// What this market's backing would pay its traders if every position
    /// closed at `price` now: their PnL net across both sides, where they are
    /// up, at most the remaining budget. Held back from a backer who leaves,
    /// so a loss already visible is not left to the winners alone.
    pub fn backing_owed_usd(&self, price: u64) -> Result<u64> {
        let pnl = self.trader_pnl_usd(price)?;
        if pnl <= 0 {
            return Ok(0);
        }
        Ok((pnl as u64).min(self.remaining_budget_usd()))
    }

    pub fn backing_value(&self, shares: u64) -> u64 {
        if self.backing_shares == 0 {
            return 0;
        }
        ((shares as u128) * (self.backing_usd as u128) / (self.backing_shares as u128)) as u64
    }

    /// Shares `amount` of fresh USDC backing buys, as `back_market` prices it
    /// (`backing::entry_pot_usd`).
    ///
    /// The first backer sets the price at one. Everyone after buys against
    /// the pot plus what a later gain owes back to it (`backing_drawn_usd`),
    /// so a repayment of an earlier draw goes to the shares that were drawn
    /// on rather than being split with whoever bought in just before it. A
    /// pot with nothing in it and nothing owed back, with shares still held,
    /// refuses the deposit, as `shares_for` does.
    pub fn backing_shares_for(&self, amount: u64) -> Result<u64> {
        if self.backing_shares == 0 {
            return Ok(amount);
        }
        let pot = (self.backing_usd as u128) + (self.backing_drawn_usd as u128);
        require!(pot > 0, PerpError::BackingWipedOut);
        Ok((((amount as u128) * (self.backing_shares as u128)) / pot)
            .try_into()
            .map_err(|_| PerpError::MathOverflow)?)
    }

    /// Books a loss the protocol had no choice about, budget or not.
    ///
    /// Used by liquidation and deleveraging. The overrun is recorded rather
    /// than hidden: `net_loss_usd` past `loss_budget_usd` is the number that
    /// says this market was underwritten wrongly, and it is what should stop
    /// it being topped up again.
    pub fn charge_loss_unchecked(&mut self, amount: u64) -> Result<()> {
        self.net_loss_usd = self
            .net_loss_usd
            .checked_add(i64::try_from(amount).map_err(|_| PerpError::MathOverflow)?)
            .ok_or(PerpError::MathOverflow)?;
        Ok(())
    }

    /// Books realised profit for the pool, unwinding earlier losses first.
    pub fn credit_gain(&mut self, amount: u64) -> Result<()> {
        self.net_loss_usd = self
            .net_loss_usd
            .checked_sub(i64::try_from(amount).map_err(|_| PerpError::MathOverflow)?)
            .ok_or(PerpError::MathOverflow)?;
        Ok(())
    }

    /// How much more of this market's budget may be reserved against open
    /// profit before it reaches its cap.
    ///
    /// Bounded by the budget rather than by pool liquidity: the pool's own cap
    /// still applies on top, so a market is limited by whichever of the two
    /// binds first. `max_utilization_bps` comes from the pool so the two stay
    /// on one policy. Rounds down, so truncation never lets the cap be passed.
    pub fn lock_headroom_usd(&self, max_utilization_bps: u16) -> u64 {
        let allowed = (max_utilization_bps as u128) * (self.remaining_budget_usd() as u128) / BPS;
        u64::try_from(allowed)
            .unwrap_or(u64::MAX)
            .saturating_sub(self.locked_usd)
    }

    /// Reserves `amount` of this market's budget against open profit, whether
    /// or not it fits under the cap.
    ///
    /// The cap is enforced where the market takes on new net exposure, which
    /// is the pool's share of a batch: `clear_batch` sizes that share out of
    /// `lock_headroom_usd`. By settlement the batch is sealed and the fill is
    /// owed. Refusing it here is what used to freeze a market for good, since
    /// a sealed batch takes no new orders, closes included, until every order
    /// in it has settled. Fills that crossed another trader add gross
    /// reservation without adding net exposure, so they may carry `locked_usd`
    /// past the cap, and while it is past the cap the pool does not quote.
    pub fn lock_admitted(&mut self, amount: u64) -> Result<()> {
        self.locked_usd = self
            .locked_usd
            .checked_add(amount)
            .ok_or(PerpError::MathOverflow)?;
        Ok(())
    }

    pub fn unlock(&mut self, amount: u64) {
        self.locked_usd = self.locked_usd.saturating_sub(amount);
    }

    pub fn session(&self) -> Result<Session> {
        Session::from_u8(self.session)
    }

    pub fn effective_max_leverage_bps(&self) -> Result<u32> {
        let set = match self.session()? {
            Session::Closed => self.closed_session_leverage_bps.min(self.max_leverage_bps),
            _ => self.max_leverage_bps,
        };
        Ok(set.min(self.depth_leverage_cap_bps()?))
    }

    /// What the tracked pool's depth allows, in bps. Unbounded for a market
    /// priced off a feed, which has no pool to push.
    pub fn depth_leverage_cap_bps(&self) -> Result<u32> {
        if PriceSource::from_u8(self.price_source)? != PriceSource::Observed {
            return Ok(u32::MAX);
        }
        let x = self.depth_leverage_x.max(DEPTH_LEVERAGE_TIERS[0].1);
        Ok(x as u32 * BPS as u32)
    }

    pub fn effective_oi_cap_usd(&self, is_long: bool) -> Result<u64> {
        let base = if is_long { self.max_oi_long_usd } else { self.max_oi_short_usd };
        Ok(match self.session()? {
            Session::Closed => mul_div_u64(base, self.closed_session_oi_mult_bps as u128, BPS)?,
            _ => base,
        })
    }

    /// Spread charged on a fill, widening with oracle confidence.
    ///
    /// The index is the mark here, so the spread is the LP's only compensation
    /// for adverse selection. Tying it to confidence means the pool quotes wide
    /// exactly when it cannot see the underlying clearly -- overnight, on a
    /// halt, or into an earnings gap -- instead of quoting a stale tight price.
    pub fn spread_bps(&self, oracle: &OraclePrice) -> Result<u16> {
        let conf_component = (oracle.conf_bps()? as u128)
            .checked_mul(self.conf_spread_mult_bps as u128)
            .ok_or(PerpError::MathOverflow)?
            / BPS;
        let total = (self.base_spread_bps as u128)
            .checked_add(conf_component)
            .ok_or(PerpError::MathOverflow)?;
        Ok(total.min(self.max_spread_bps as u128) as u16)
    }

    /// Fill price for a trade. `is_buy` is from the trader's perspective:
    /// opening a long or closing a short buys, and pays the offer.
    /// Takes `oracle` as this market's price, refusing one older than the
    /// newest it has already acted on.
    ///
    /// A price is valid for `max_price_age_sec` after it is published, and any
    /// verified update inside that window used to be accepted. So whoever sent
    /// the instruction chose which one: a liquidator, or a trader deleveraging
    /// themselves, could hand over the most favourable price of the last two
    /// minutes. Holding each market to prices that only move forward in time
    /// leaves the newest one as the only choice there is.
    ///
    /// Two different prices under one publish time are a choice as well, so
    /// the second is refused: the same price may be used again, a different
    /// one waits for the next publish time.
    ///
    /// An accepted price then steps the market's risk price toward it, by at
    /// most `RISK_PRICE_STEP_BPS_PER_SLOT` per slot since the last step, and
    /// counting no more than `RISK_PRICE_MAX_GAP_SLOTS` of them. Returns the
    /// risk price. A market nobody holds a position in follows the oracle at
    /// once: there is nobody a jump could liquidate.
    pub fn accept_price(&mut self, oracle: &OraclePrice, slot: u64) -> Result<u64> {
        let ts = u32::try_from(oracle.published_ts.max(0)).unwrap_or(u32::MAX);
        require!(ts >= self.last_price_ts, PerpError::OraclePriceRegressed);
        require!(
            ts > self.last_price_ts || self.last_price == 0 || self.last_price == oracle.price,
            PerpError::OraclePriceConflict
        );
        self.last_price_ts = ts;
        self.last_price = oracle.price;

        if self.risk_price == 0 || !self.has_open_interest() {
            self.risk_price = oracle.price;
            self.risk_step_rem = 0;
        } else {
            let slots = slot.saturating_sub(self.risk_slot).min(RISK_PRICE_MAX_GAP_SLOTS);
            let (next, rem) = crate::oracle::risk_step(
                self.risk_price,
                oracle.price,
                RISK_PRICE_STEP_BPS_PER_SLOT * slots,
                self.risk_step_rem,
            )?;
            self.risk_price = next;
            self.risk_step_rem = rem;
        }
        self.risk_slot = self.risk_slot.max(slot);
        Ok(self.risk_price)
    }

    /// The part of `accept_price` a read-only caller can apply: a price older
    /// than the newest this market has acted on is refused. Used where the
    /// market is read but not written, such as valuing the pool for an LP.
    pub fn check_price_floor(&self, oracle: &OraclePrice) -> Result<()> {
        let ts = u32::try_from(oracle.published_ts.max(0)).unwrap_or(u32::MAX);
        require!(ts >= self.last_price_ts, PerpError::OraclePriceRegressed);
        Ok(())
    }

    /// The prices a batch may clear inside, around `mark`.
    ///
    /// Half the maintenance margin at most, so a position opened at either edge
    /// starts with at least half its maintenance margin still standing; and no
    /// wider than the widest spread the market would ever quote.
    pub fn price_band(&self, mark: u64) -> Result<(u64, u64)> {
        let band_bps = (self.max_spread_bps as u64).min(self.maintenance_margin_bps as u64 / 2);
        let width = bps_of(mark, band_bps as u16)?;
        Ok((mark.saturating_sub(width), mark.checked_add(width).ok_or(PerpError::MathOverflow)?))
    }

    pub fn fill_price(&self, oracle: &OraclePrice, is_buy: bool) -> Result<u64> {
        let spread = self.spread_bps(oracle)?;
        let adj = bps_of(oracle.price, spread)?;
        Ok(if is_buy {
            oracle.price.checked_add(adj).ok_or(PerpError::MathOverflow)?
        } else {
            oracle.price.saturating_sub(adj)
        })
    }

    /// Converts an entry price recorded under `entry_factor` into today's terms.
    ///
    /// Never below one unit for a set entry, as `rescale_price` floors the
    /// market's own prices: a split can take an entry under a unit, and zero
    /// is an entry `position_pnl_usd` refuses, which would leave the position
    /// unsettleable and its sealed batch unable to roll.
    pub fn adjust_entry_price(&self, entry_price: u64, entry_factor: u128) -> Result<u64> {
        if entry_factor == self.price_factor {
            return Ok(entry_price);
        }
        require!(entry_factor > 0, PerpError::InvalidParameter);
        let adjusted = (entry_price as u128)
            .checked_mul(self.price_factor)
            .ok_or(PerpError::MathOverflow)?
            .checked_div(entry_factor)
            .ok_or(PerpError::MathOverflow)?;
        let adjusted = u64::try_from(adjusted).map_err(|_| PerpError::MathOverflow)?;
        Ok(if entry_price > 0 { adjusted.max(1) } else { 0 })
    }

    /// Aggregate unrealized trader PnL in this market, which is the pool's
    /// liability. Positive means traders are up and the pool is down.
    pub fn trader_pnl_usd(&self, price: u64) -> Result<i64> {
        let long = if self.long_size_usd > 0 {
            position_pnl_usd(true, self.long_size_usd, self.long_avg_entry_price, price)?
        } else {
            0
        };
        let short = if self.short_size_usd > 0 {
            position_pnl_usd(false, self.short_size_usd, self.short_avg_entry_price, price)?
        } else {
            0
        };
        long.checked_add(short).ok_or_else(|| PerpError::MathOverflow.into())
    }

    /// The profit every winning side holds at `price`: each side's PnL where
    /// it is positive, the losing side counted as zero rather than netted
    /// against it. What a fair-share payout divides by.
    pub fn winning_pnl_usd(&self, price: u64) -> Result<u64> {
        let side = |is_long: bool, size: u64, entry: u64| -> Result<u64> {
            if size == 0 {
                return Ok(0);
            }
            Ok(position_pnl_usd(is_long, size, entry, price)?.max(0) as u64)
        };
        let long = side(true, self.long_size_usd, self.long_avg_entry_price)?;
        let short = side(false, self.short_size_usd, self.short_avg_entry_price)?;
        long.checked_add(short).ok_or_else(|| PerpError::MathOverflow.into())
    }

    /// What this market's open positions are worth to the LPs at `price`,
    /// signed the way `trader_pnl_usd` is: positive is LPs down. What LP
    /// shares are priced against, rather than the PnL itself.
    ///
    /// Only what can actually change hands counts. Traders down can lose no
    /// more than the collateral they posted, and the part of that a close
    /// hands back to backers drawn on earlier (`restore_backing`) is theirs.
    /// Traders up are paid no more than the market's remaining budget
    /// (`haircut_profit_usd`), and its backing pays that before the LPs do
    /// (`draw_backing`). Counting a short's loss past its collateral let
    /// whoever could move the mark price LP shares at a value the pool would
    /// never collect.
    pub fn lp_pnl_usd(&self, price: u64) -> Result<i64> {
        Ok(self.lp_from_net(self.trader_net_usd(price)?))
    }

    /// What traders are owed net at `price`: their PnL less the funding and
    /// borrow they owe (`funding_owed_usd`), which a close takes out of their
    /// equity and leaves with the pool. Funding counts only while both sides
    /// are tracked: skew funding is paid by one side to the other, and one
    /// side's half alone would count a payment the pool passes straight on.
    pub fn trader_net_usd(&self, price: u64) -> Result<i64> {
        let pnl = self.trader_pnl_usd(price)?;
        let owed = self.funding_owed_usd().unwrap_or(0);
        pnl.checked_sub(owed).ok_or_else(|| PerpError::MathOverflow.into())
    }

    /// `lp_pnl_usd` as a claim reads it: never counting more of the losers'
    /// loss than the pool can collect from each of them. Traders are taken
    /// to be owed `side_bad_debt_bound_usd` more on each side, an upper
    /// bound on what losers there owe past their own collateral, which
    /// `lp_pnl_usd` nets against everybody else's collateral. So a claim is
    /// paid at most what the book is worth, and while any position could be
    /// past its collateral, somewhat less. A side whose positions are not
    /// all tracked adds nothing, the old rule, until they are gone.
    pub fn lp_claim_pnl_usd(&self, price: u64) -> Result<i64> {
        let net = self.trader_net_usd(price)? as i128;
        let bad = [true, false]
            .iter()
            .map(|&l| self.side_bad_debt_bound_usd(l, price).unwrap_or(0) as i128)
            .sum::<i128>();
        let owed = net.saturating_add(bad).min(i64::MAX as i128) as i64;
        Ok(self.lp_from_net(owed))
    }

    /// What the LPs owe on a net trader claim of `pnl`, after the caps (see
    /// `lp_pnl_usd`). Never decreases as `pnl` grows.
    fn lp_from_net(&self, pnl: i64) -> i64 {
        if pnl >= 0 {
            let paid = (pnl as u64).min(self.remaining_budget_usd());
            // At most `pnl`, so it fits.
            return paid.saturating_sub(self.backing_usd) as i64;
        }
        let collected = pnl.unsigned_abs().min(self.collateral_usd);
        let restored = if self.backing_shares == 0 {
            0
        } else {
            collected.min(self.backing_drawn_usd)
        };
        -((collected - restored) as i64)
    }

    /// The most `lp_pnl_usd` can be at any price: winners paid everything
    /// the remaining budget allows, less what backing pays first. What an
    /// LP withdrawal counts a market at when its price cannot be read.
    pub fn lp_worst_pnl_usd(&self) -> i64 {
        i64::try_from(self.remaining_budget_usd().saturating_sub(self.backing_usd))
            .unwrap_or(i64::MAX)
    }

    /// How much of the pool this market's book leans on, for the borrow rate:
    /// the imbalance between its sides as a share of the pool's liquidity.
    ///
    /// It used to be the liquidity reserved against open positions, and
    /// nothing is reserved any more. A balanced book costs the pool nothing,
    /// so it borrows nothing; what the pool is exposed to is the side it is
    /// left holding.
    pub fn utilization_bps(&self, pool_liquidity_usd: u64) -> u16 {
        let net = self.long_size_usd.abs_diff(self.short_size_usd);
        if net == 0 {
            return 0;
        }
        if pool_liquidity_usd == 0 {
            return BPS as u16;
        }
        ((net as u128) * BPS / (pool_liquidity_usd as u128)).min(BPS) as u16
    }

    fn rate_to_index_delta(rate_bps_per_hour: u128, elapsed: i64) -> Result<i128> {
        let numer = rate_bps_per_hour
            .checked_mul(FUNDING_SCALE as u128)
            .ok_or(PerpError::MathOverflow)?
            .checked_mul(elapsed as u128)
            .ok_or(PerpError::MathOverflow)?;
        let denom = BPS
            .checked_mul(SECONDS_PER_HOUR as u128)
            .ok_or(PerpError::MathOverflow)?;
        i128::try_from(numer / denom).map_err(|_| PerpError::MathOverflow.into())
    }

    /// Advances the funding and borrow indices to `now`.
    ///
    /// Two separate charges are folded into one index per side:
    ///
    /// * borrow -- both sides pay the pool, scaled by utilization, because both
    ///   sides are renting the pool's balance sheet.
    /// * skew funding -- the heavier side pays the lighter side, to pull open
    ///   interest back to balance so the pool is not left holding delta. With an
    ///   oracle mark there is no perp-vs-index basis to arbitrage, so this is
    ///   the only lever that keeps the LP from becoming a directional fund.
    ///
    /// When one side is empty there is nobody to receive, so skew funding is
    /// skipped; utilization is necessarily high in that state and the borrow
    /// leg is already charging for the risk.
    pub fn accrue_funding(&mut self, now: i64, utilization_bps: u16) -> Result<()> {
        let elapsed = now
            .saturating_sub(self.last_funding_ts)
            .clamp(0, MAX_FUNDING_ACCRUAL_SECONDS);
        self.last_funding_ts = now;
        if elapsed == 0 {
            return Ok(());
        }

        let borrow_rate = (self.borrow_rate_bps_per_hour as u128)
            .checked_mul(utilization_bps as u128)
            .ok_or(PerpError::MathOverflow)?
            / BPS;
        let borrow_delta = Self::rate_to_index_delta(borrow_rate, elapsed)?;

        let mut long_delta = borrow_delta;
        let mut short_delta = borrow_delta;

        let total = (self.long_size_usd as u128) + (self.short_size_usd as u128);
        if total > 0 && self.long_size_usd > 0 && self.short_size_usd > 0 {
            let longs_heavy = self.long_size_usd >= self.short_size_usd;
            let (heavy, light) = if longs_heavy {
                (self.long_size_usd as u128, self.short_size_usd as u128)
            } else {
                (self.short_size_usd as u128, self.long_size_usd as u128)
            };
            let skew_bps = (heavy - light) * BPS / total;
            let rate = ((self.funding_k_bps as u128) * skew_bps / BPS)
                .min(self.max_funding_rate_bps_per_hour as u128);
            if rate > 0 {
                let pay = Self::rate_to_index_delta(rate, elapsed)?;
                // The light side receives exactly what the heavy side pays, so
                // its per-USD credit scales up by the size ratio.
                let recv = pay
                    .checked_mul(i128::try_from(heavy).map_err(|_| PerpError::MathOverflow)?)
                    .ok_or(PerpError::MathOverflow)?
                    .checked_div(i128::try_from(light).map_err(|_| PerpError::MathOverflow)?)
                    .ok_or(PerpError::MathOverflow)?;
                if longs_heavy {
                    long_delta = long_delta.checked_add(pay).ok_or(PerpError::MathOverflow)?;
                    short_delta = short_delta.checked_sub(recv).ok_or(PerpError::MathOverflow)?;
                } else {
                    short_delta = short_delta.checked_add(pay).ok_or(PerpError::MathOverflow)?;
                    long_delta = long_delta.checked_sub(recv).ok_or(PerpError::MathOverflow)?;
                }
            }
        }

        self.cumulative_long_funding = self
            .cumulative_long_funding
            .checked_add(long_delta)
            .ok_or(PerpError::MathOverflow)?;
        self.cumulative_short_funding = self
            .cumulative_short_funding
            .checked_add(short_delta)
            .ok_or(PerpError::MathOverflow)?;
        Ok(())
    }

    /// Whether anybody holds a position here, on either side.
    pub fn has_open_interest(&self) -> bool {
        self.long_size_usd > 0 || self.short_size_usd > 0
    }

    pub fn cumulative_funding(&self, is_long: bool) -> i128 {
        if is_long {
            self.cumulative_long_funding
        } else {
            self.cumulative_short_funding
        }
    }

    /// What a tracked position carries in `Position::q_epoch`. Moves with
    /// every corporate action, which is what untracks every open position at
    /// once (`reset_moments`). Never zero short of `split_epoch` wrapping.
    pub fn q_tag(&self) -> u32 {
        self.split_epoch.wrapping_add(1)
    }

    /// The size and entry `position` put into its side's sums, when it did.
    /// A tracked position's entry is in today's price factor already: the
    /// factor only moves with `split_epoch`, which untracks it.
    pub fn tracked_term(&self, position: &Position) -> Option<(u64, u64)> {
        (position.is_open() && position.q_epoch == self.q_tag())
            .then_some((position.size_usd, position.entry_price))
    }

    /// Replaces one position's term in its side's sums: takes out `old`, what
    /// `tracked_term` said it put in, and puts in `new_size` at `new_entry`.
    /// Returns whether the new term went in, which is what the position's
    /// `q_epoch` must then say. A term that does not fit is left out, and its
    /// side reads incomplete; settlement never fails on it.
    pub fn retrack(
        &mut self,
        is_long: bool,
        old: Option<(u64, u64)>,
        new_size: u64,
        new_entry: u64,
    ) -> bool {
        let side = if is_long { &mut self.long_moments } else { &mut self.short_moments };
        if let Some((size, entry)) = old {
            if let Some((u, q)) = moment_terms(size, entry) {
                side.tracked_usd = side.tracked_usd.saturating_sub(size);
                side.inv_entry = side.inv_entry.saturating_sub(u);
                side.inv_entry_sq = side.inv_entry_sq.saturating_sub(q);
            }
        }
        if new_size == 0 {
            return false;
        }
        let Some((u, q)) = moment_terms(new_size, new_entry) else {
            return false;
        };
        match (
            side.tracked_usd.checked_add(new_size),
            side.inv_entry.checked_add(u),
            side.inv_entry_sq.checked_add(q),
        ) {
            (Some(t), Some(a), Some(b)) => {
                side.tracked_usd = t;
                side.inv_entry = a;
                side.inv_entry_sq = b;
                true
            }
            _ => false,
        }
    }

    /// The size and entry funding `position` put into its side's
    /// `SideFunding`, when it did.
    pub fn tracked_funding_term(&self, position: &Position) -> Option<(u64, i128)> {
        (position.is_open() && position.f_epoch == self.q_tag())
            .then_some((position.size_usd, position.entry_funding))
    }

    /// Replaces one position's term in its side's funding sums: takes out
    /// `old`, what `tracked_funding_term` said it put in, and puts in `new`.
    /// Returns whether `new` went in, which is what the position's `f_epoch`
    /// must then say. Never fails: a term that does not fit is left out.
    pub fn retrack_funding(
        &mut self,
        is_long: bool,
        old: Option<(u64, i128)>,
        new: Option<FundingTerm>,
    ) -> bool {
        let side = if is_long { &mut self.long_funding } else { &mut self.short_funding };
        if let Some((size, e)) = old {
            side.tracked_usd = side.tracked_usd.saturating_sub(size);
            side.size_entry_funding =
                side.size_entry_funding.wrapping_sub((size as i128).wrapping_mul(e));
        }
        let Some(t) = new.filter(|t| t.size > 0 && t.entry > 0) else {
            return false;
        };
        let (Some(cover), Some(tracked)) = (t.cover(), side.tracked_usd.checked_add(t.size)) else {
            return false;
        };
        if side.tracked_usd == 0 {
            side.min_cover = cover;
            side.worst_entry = t.entry;
        } else {
            side.min_cover = side.min_cover.min(cover);
            side.worst_entry = if is_long {
                side.worst_entry.max(t.entry)
            } else {
                side.worst_entry.min(t.entry)
            };
        }
        side.tracked_usd = tracked;
        side.size_entry_funding =
            side.size_entry_funding.wrapping_add((t.size as i128).wrapping_mul(t.entry_funding));
        true
    }

    /// Funding and borrow every open position owes at the current index,
    /// signed as `math::funding_owed_usd`: positive is owed to the pool. A
    /// close takes it from the trader's equity and leaves it with the pool,
    /// so it is the pool's before then. Skew funding nets to about zero
    /// across the sides; borrow, which both sides pay, does not.
    ///
    /// None unless both sides are tracked in full. The sum is rounded once
    /// rather than per position, so it may differ from what the closes pay
    /// by a unit a position.
    pub fn funding_owed_usd(&self) -> Option<i64> {
        let mut total: i128 = 0;
        for (size, f, index) in [
            (self.long_size_usd, &self.long_funding, self.cumulative_long_funding),
            (self.short_size_usd, &self.short_funding, self.cumulative_short_funding),
        ] {
            if f.tracked_usd != size {
                return None;
            }
            // Exact whenever the true value fits, however the sums wrapped.
            total = total.wrapping_add(
                (size as i128).wrapping_mul(index).wrapping_sub(f.size_entry_funding),
            );
        }
        i64::try_from(total / FUNDING_SCALE).ok()
    }

    /// An upper bound on what the positions on one side owe at `price` past
    /// their own collateral: `sum max(loss + funding owed - collateral, 0)`,
    /// the bad debt a close or liquidation could not collect. None while the
    /// side holds a position its sums do not track.
    ///
    /// Per USD of size, a position with entry e is short of its collateral
    /// by t = z - (cover - I), with z its loss return (1 - p/e on a long,
    /// p/e - 1 on a short), cover its `FundingTerm::cover` and I the index
    /// now. Every tracked position has cover >= `min_cover` and an entry no
    /// better than `worst_entry`, so with k = min_cover - I, t <= z - k and
    /// t <= t_max = z(worst_entry) - k. When t_max <= 0 nobody can be short,
    /// and the bound is zero. Otherwise it is the smaller of S * t_max and
    /// the moment bound on `sum s max(z - k, 0)`: on a long side that is
    /// (1 - k) times the gross profit a short would hold over the same sums
    /// at p / (1 - k) (`winners_bound`), on a short side (1 + k) times a
    /// long's at p / (1 + k). Every piece is rounded up, and anything that
    /// does not fit is the largest bound there is.
    pub fn side_bad_debt_bound_usd(&self, is_long: bool, price: u64) -> Option<u64> {
        let (size, m, f, index) = if is_long {
            (self.long_size_usd, &self.long_moments, &self.long_funding, self.cumulative_long_funding)
        } else {
            (self.short_size_usd, &self.short_moments, &self.short_funding, self.cumulative_short_funding)
        };
        if m.tracked_usd != size || f.tracked_usd != size {
            return None;
        }
        if size == 0 {
            return Some(0);
        }
        Some(bad_debt_bound(size, m, f, index, price, is_long).unwrap_or(u64::MAX))
    }

    /// A side's average entry from its moment sums, when they track every
    /// position on it: `size / sum(size / entry)`, the same harmonic mean
    /// `blend_entry_price` keeps, but recomputed rather than carried.
    pub fn side_avg_from_moments(&self, is_long: bool) -> Option<u64> {
        let (size, m) = if is_long {
            (self.long_size_usd, &self.long_moments)
        } else {
            (self.short_size_usd, &self.short_moments)
        };
        if size == 0 || m.tracked_usd != size || m.inv_entry == 0 {
            return None;
        }
        let avg = mul_div_u128(size as u128, MOMENT_U_SCALE, m.inv_entry).ok()?;
        u64::try_from(avg).ok().filter(|a| *a > 0)
    }

    /// Takes `close_size` of `position` off its side: the size, the moment
    /// sums and the average entry, together. `position` is as it was before
    /// the close.
    ///
    /// The average used to be left where it was, so `size / avg` stopped being
    /// the sum of `size / entry` over the positions still open, and the side
    /// reported profit nobody held (or hid profit somebody did). Closing a
    /// $1m long from $100 at $200 next to a $1m long opened at $200 left the
    /// side at $1m from $133.33, up $500,000 at $200 when it was flat. Now the
    /// closed size's own `size / entry` comes out: exactly, from the sums, when
    /// the side is fully tracked, and from the stored average otherwise.
    pub fn close_side(&mut self, is_long: bool, position: &Position, close_size: u64) -> Result<()> {
        let old_size = if is_long { self.long_size_usd } else { self.short_size_usd };
        let old_avg = if is_long { self.long_avg_entry_price } else { self.short_avg_entry_price };
        let new_size = old_size.saturating_sub(close_size);
        let mut new_avg = old_avg;
        if close_size > 0 && position.is_open() {
            let entry = self.adjust_entry_price(position.entry_price, position.entry_price_factor)?;
            let left = position.size_usd.saturating_sub(close_size);
            let mut kept = false;
            if let Some(old_term) = self.tracked_term(position) {
                // A smaller size at the same entry always fits where the
                // larger did.
                kept = self.retrack(is_long, Some(old_term), left, entry);
                debug_assert!(kept == (left > 0));
            }
            // The funding term goes the same way, with the collateral the
            // close leaves behind, as `settle` takes it.
            if let Some(old_f) = self.tracked_funding_term(position) {
                let taken = mul_div_u64(
                    position.collateral_usd,
                    close_size.min(position.size_usd) as u128,
                    position.size_usd as u128,
                )?;
                let rest = FundingTerm {
                    size: left,
                    entry_funding: position.entry_funding,
                    collateral: position.collateral_usd - taken,
                    entry,
                };
                self.retrack_funding(is_long, Some(old_f), kept.then_some(rest));
            }
            if new_size > 0 && old_avg > 0 && entry > 0 {
                let removed = close_size.min(position.size_usd) as u128;
                let units = mul_div_u128(old_size as u128, MOMENT_U_SCALE, old_avg as u128)?
                    .saturating_sub(mul_div_u128(removed, MOMENT_U_SCALE, entry as u128)?);
                if units > 0 {
                    if let Ok(a) = u64::try_from(mul_div_u128(new_size as u128, MOMENT_U_SCALE, units)?) {
                        if a > 0 {
                            new_avg = a;
                        }
                    }
                }
            }
        }
        if is_long {
            self.long_size_usd = new_size;
            self.long_avg_entry_price = new_avg;
        } else {
            self.short_size_usd = new_size;
            self.short_avg_entry_price = new_avg;
        }
        // Exact when every position on the side is tracked.
        if let Some(a) = self.side_avg_from_moments(is_long) {
            if is_long {
                self.long_avg_entry_price = a;
            } else {
                self.short_avg_entry_price = a;
            }
        }
        Ok(())
    }

    /// Forgets every tracked term, for a corporate action: entries rebase by
    /// a factor the sums could only follow with rounding. Every open position
    /// stops matching `q_tag` with the same `split_epoch` step.
    pub fn reset_moments(&mut self) {
        self.long_moments = SideMoments::default();
        self.short_moments = SideMoments::default();
        self.long_funding = SideFunding::default();
        self.short_funding = SideFunding::default();
    }

    /// An upper bound on the profit the winners on one side hold at `price`,
    /// counted gross: a loser on the same side does not offset it. None while
    /// the side holds a position its sums do not track.
    ///
    /// With sizes s, entries e, return y = p/e - 1 for a long (1 - p/e for a
    /// short), S = sum s, net = sum s y and M2 = sum s y^2 = p^2 sum s/e^2 -
    /// 2p sum s/e + S, the winners hold W = sum s max(y, 0) = (net + sum s |y|) / 2,
    /// and by Cauchy-Schwarz sum s |y| <= sqrt(S M2). So W <= (net + sqrt(S M2)) / 2,
    /// which is exact when every entry on the side is the same. Each piece is
    /// rounded so the result is never below that.
    pub fn side_winners_bound_usd(&self, is_long: bool, price: u64) -> Option<u64> {
        let (size, m) = if is_long {
            (self.long_size_usd, &self.long_moments)
        } else {
            (self.short_size_usd, &self.short_moments)
        };
        if m.tracked_usd != size {
            return None;
        }
        if size == 0 {
            return Some(0);
        }
        // Anything that does not fit is a bound past any u64.
        Some(winners_bound(size as u128, m.inv_entry, m.inv_entry_sq, price as u128, is_long)
            .unwrap_or(u64::MAX))
    }

    /// What `haircut_profit_usd` counts one side's winners at: the bound when
    /// the side is fully tracked, and the side's net profit from its
    /// aggregates when it is not, which is how every side was counted before.
    pub fn side_winners_usd(&self, is_long: bool, price: u64) -> Result<u64> {
        if let Some(bound) = self.side_winners_bound_usd(is_long, price) {
            return Ok(bound);
        }
        let (size, entry) = if is_long {
            (self.long_size_usd, self.long_avg_entry_price)
        } else {
            (self.short_size_usd, self.short_avg_entry_price)
        };
        if size == 0 {
            return Ok(0);
        }
        Ok(position_pnl_usd(is_long, size, entry, price)?.max(0) as u64)
    }
}

/// See `Market::side_bad_debt_bound_usd`. None on overflow.
fn bad_debt_bound(
    size: u64,
    m: &SideMoments,
    f: &SideFunding,
    index: i128,
    price: u64,
    is_long: bool,
) -> Option<u64> {
    let fs = FUNDING_SCALE;
    let fsu = fs as u128;
    let (s, p, e) = (size as u128, price as u128, f.worst_entry as u128);
    if e == 0 {
        return None;
    }
    let k = f.min_cover.checked_sub(index)?;
    // Per-USD loss of the worst entry, rounded up, in FUNDING_SCALE.
    let z = if is_long {
        fs.checked_sub(i128::try_from(mul_div_u128(p, fsu, e).ok()?).ok()?)?
    } else {
        i128::try_from(div_ceil_u128(p.checked_mul(fsu)?, e)).ok()?.checked_sub(fs)?
    };
    let t_max = z.checked_sub(k)?;
    if t_max <= 0 {
        return Some(0);
    }
    let cap = div_ceil_u128(s.checked_mul(t_max as u128)?, fsu);
    // The scale (1 - k) or (1 + k), positive on a long since it exceeds t_max.
    let scale = if is_long { fs.checked_sub(k)? } else { fs.checked_add(k)? };
    let moments = if scale <= 0 {
        None
    } else {
        let scale = scale as u128;
        // A long's bound falls as the price rises, a short's rises with it.
        let shifted = if is_long {
            mul_div_u128(p, fsu, scale).ok()?
        } else {
            div_ceil_u128(p.checked_mul(fsu)?, scale)
        };
        winners_bound(s, m.inv_entry, m.inv_entry_sq, shifted, !is_long)
            .and_then(|w| (w as u128).checked_mul(scale))
            .map(|x| div_ceil_u128(x, fsu))
    };
    let bound = moments.map_or(cap, |b| b.min(cap));
    u64::try_from(bound).ok()
}

/// `(net + sqrt(S * M2)) / 2` from a side's sums, rounded up throughout.
/// `u` and `q` are `SideMoments::inv_entry` and `inv_entry_sq`. None on
/// overflow.
fn winners_bound(s: u128, u: u128, q: u128, p: u128, is_long: bool) -> Option<u64> {
    // p^2 q / 1e24, up. `q` is at least the true sum, so this is too.
    let pq = mul_div_u128(p, q, MOMENT_Q_STEP).ok()?.checked_add(1)?;
    let ppq = mul_div_u128(p, pq, MOMENT_Q_STEP).ok()?.checked_add(1)?;
    // `u` is at most the true sum and at least it less one unit a position,
    // and every tracked position has a size of at least one, so the true
    // p * sum s/e lies in [pu_lo, pu_hi].
    let pu_lo = mul_div_u128(p, u, MOMENT_U_SCALE).ok()?;
    let pu_hi = mul_div_u128(p, u.checked_add(s)?, MOMENT_U_SCALE).ok()?.checked_add(1)?;
    // M2 = p^2 q - 2 p u + S, high: the 2pu term is taken low.
    let m2 = ppq.checked_add(s)?.saturating_sub(pu_lo.checked_mul(2)?);
    let root = match s.checked_mul(m2) {
        Some(x) => isqrt_ceil(x),
        None => isqrt_ceil(s).checked_mul(isqrt_ceil(m2))?,
    };
    // 2W <= net + root, with net = pu - S on a long and S - pu on a short.
    let twice = if is_long {
        pu_hi.checked_add(root)?.saturating_sub(s)
    } else {
        s.checked_add(root)?.saturating_sub(pu_lo)
    };
    u64::try_from(div_ceil_u128(twice, 2)).ok()
}

/// The smallest r with r * r >= x.
pub(crate) fn isqrt_ceil(x: u128) -> u128 {
    if x < 2 {
        return x;
    }
    // Newton from above, which settles on floor(sqrt(x)).
    let mut r = 1u128 << (128 - x.leading_zeros()).div_ceil(2);
    loop {
        let next = (r + x / r) / 2;
        if next >= r {
            break;
        }
        r = next;
    }
    if r * r < x {
        r + 1
    } else {
        r
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn market() -> Market {
        Market {
            bump: 0,
            pool: Pubkey::default(),
            symbol: [0; 16],
            feed_id: [0; 32],
            max_price_age_sec: 60,
            max_conf_bps: 200,
            max_leverage_bps: 100_000,
            maintenance_margin_bps: 500,
            liquidation_fee_bps: 100,
            open_fee_bps: 10,
            close_fee_bps: 10,
            min_position_usd: 10_000_000,
            max_oi_long_usd: u64::MAX / 4,
            max_oi_short_usd: u64::MAX / 4,
            pnl_reserve_bps: 10_000,
            base_spread_bps: 5,
            conf_spread_mult_bps: 10_000,
            max_spread_bps: 500,
            session: Session::Regular as u8,
            closed_session_leverage_bps: 20_000,
            closed_session_oi_mult_bps: 2_500,
            cumulative_long_funding: 0,
            cumulative_short_funding: 0,
            last_funding_ts: 0,
            max_funding_rate_bps_per_hour: 100,
            funding_k_bps: 10_000,
            borrow_rate_bps_per_hour: 0,
            long_size_usd: 0,
            long_avg_entry_price: 0,
            short_size_usd: 0,
            short_avg_entry_price: 0,
            collateral_usd: 0,
            price_factor: PRICE_FACTOR_ONE,
            split_epoch: 0,
            last_multiplier: MULTIPLIER_SCALE as u64,
            paused: false,
            price_source: PriceSource::Pyth as u8,
            observation: Pubkey::default(),
            deployer: Pubkey::default(),
            loss_budget_usd: 1_000_000_000_000, // $1,000,000
            net_loss_usd: 0,
            locked_usd: 0,
            backing_usd: 0,
            backing_shares: 0,
            backing_drawn_usd: 0,
            last_price_ts: 0,
            depth_leverage_x: 0,
            volume_usd: 0,
            deployer_synced_volume_usd: 0,
            deployer_rewards_usd: 0,
            deployer_earned_usd: 0,
            risk_step_rem: 0,
            last_price: 0,
            risk_price: 0,
            risk_slot: 0,
            generation: 0,
            aum_drift_usd: 0,
            deployer_points_owed: 0,
            insurance_drawn_usd: 0,
            _reserved: [0; 4],
            long_moments: SideMoments::default(),
            short_moments: SideMoments::default(),
            long_funding: SideFunding::default(),
            short_funding: SideFunding::default(),
            batch_net_usd: 0,
            batch_backing_usd: 0,
            batch_insurance_usd: 0,
            batch_backer_fees_usd: 0,
        }
    }

    #[test]
    fn the_lps_count_no_loss_past_collateral_and_no_profit_past_the_budget() {
        const K: u64 = 1_000_000_000; // $1,000
        let price = 1_000_000;
        // $50k short, posted $5k. The mark doubles: the short is down $50k,
        // but only its $5k of collateral can ever reach the pool.
        let mut m = market();
        m.short_size_usd = 50 * K;
        m.short_avg_entry_price = price;
        m.collateral_usd = 5 * K;
        assert_eq!(m.trader_pnl_usd(2 * price).unwrap(), -50 * K as i64);
        assert_eq!(m.lp_pnl_usd(2 * price).unwrap(), -5 * K as i64);
        // Of what it can pay, what goes back to the backers drawn on first
        // is not the LPs'.
        m.backing_shares = 1;
        m.backing_drawn_usd = 2 * K;
        assert_eq!(m.lp_pnl_usd(2 * price).unwrap(), -3 * K as i64);
        // With nobody holding a share, nothing is restored and it is all
        // the LPs'.
        m.backing_shares = 0;
        assert_eq!(m.lp_pnl_usd(2 * price).unwrap(), -5 * K as i64);

        // $50k long up $50k, on a market with $8k of budget left: winners are
        // paid at most that, and its $3k of backing pays first.
        let mut m = market();
        m.long_size_usd = 50 * K;
        m.long_avg_entry_price = price;
        m.collateral_usd = 5 * K;
        m.loss_budget_usd = 8 * K;
        assert_eq!(m.lp_pnl_usd(2 * price).unwrap(), 8 * K as i64);
        m.backing_usd = 3 * K;
        assert_eq!(m.lp_pnl_usd(2 * price).unwrap(), 5 * K as i64);
        // Backing bigger than what winners can be paid leaves the LPs owing
        // nothing.
        m.backing_usd = 20 * K;
        assert_eq!(m.lp_pnl_usd(2 * price).unwrap(), 0);
        // Inside every cap, it is the PnL itself.
        m.backing_usd = 0;
        m.loss_budget_usd = 100 * K;
        assert_eq!(m.lp_pnl_usd(price + price / 10).unwrap(), 5 * K as i64);
    }

    #[test]
    fn backing_is_spent_before_lp_capital() {
        let mut m = market();
        m.backing_usd = 300;
        m.backing_shares = 300;

        // A loss larger than the backing takes all of it and leaves the rest
        // for the pool to pay.
        assert_eq!(m.draw_backing(500), 300);
        assert_eq!(m.backing_usd, 0);
        assert_eq!(m.backing_drawn_usd, 300);

        // And a loss on a market nobody backed takes nothing, rather than
        // silently underflowing into a credit.
        let mut bare = market();
        assert_eq!(bare.draw_backing(500), 0);
        assert_eq!(bare.backing_usd, 0);
    }

    #[test]
    fn a_gain_repays_backing_first_and_only_what_it_took() {
        let mut m = market();
        m.backing_usd = 300;
        m.backing_shares = 300;
        m.draw_backing(200);

        // The first 200 of profit is the backers' money coming back.
        assert_eq!(m.restore_backing(500), 200);
        assert_eq!(m.backing_usd, 300);
        assert_eq!(m.backing_drawn_usd, 0);

        // Past that the market is simply profitable, and that is the pool's.
        assert_eq!(m.restore_backing(500), 0);
        assert_eq!(m.backing_usd, 300, "backers do not own the upside");
    }

    #[test]
    fn a_backer_after_a_drawdown_buys_the_claim_on_its_repayment_at_face() {
        let mut m = market();
        m.backing_usd = 1_000;
        m.backing_shares = 1_000;

        // Half the backing is consumed by a loss.
        m.draw_backing(500);
        assert_eq!(m.backing_value(1_000), 500, "the first backer wears it");

        // Someone arriving now pays for the 500 a gain owes back as well as
        // the 500 left: 500 USD buys 500 shares, not 1,000.
        let fresh = m.backing_shares_for(500).unwrap();
        assert_eq!(fresh, 500);
        m.backing_usd += 500;
        m.backing_shares += fresh;

        // When the gain comes, each is made whole and neither is paid the
        // other's money.
        assert_eq!(m.restore_backing(500), 500);
        assert_eq!(m.backing_value(1_000), 1_000);
        assert_eq!(m.backing_value(fresh), 500);
    }

    #[test]
    fn a_repayment_never_pays_a_later_backer_past_what_they_posted() {
        for held in 0..=N {
            for drawn in 0..=N {
                if held + drawn == 0 {
                    continue;
                }
                for amount in 0..=N {
                    let mut m = market();
                    m.backing_usd = held;
                    m.backing_shares = held + drawn;
                    m.backing_drawn_usd = drawn;
                    let fresh = m.backing_shares_for(amount).unwrap();
                    m.backing_usd += amount;
                    m.backing_shares += fresh;
                    m.restore_backing(drawn);
                    assert!(m.backing_value(fresh) <= amount, "{held} {drawn} {amount}");
                }
            }
        }
    }

    #[test]
    fn an_unbacked_market_pays_its_backers_nothing() {
        let mut m = market();
        // No shares, no backers: the whole LP fee stays with the LPs.
        assert_eq!(m.credit_backer_fee(1_000_000).unwrap(), 0);
        assert_eq!(m.backing_usd, 0);
    }

    #[test]
    fn fees_raise_what_a_backing_share_is_worth() {
        let mut m = market();
        m.backing_usd = 1_000_000_000;
        m.backing_shares = 1_000_000_000;
        let before = m.backing_value(1_000_000_000);

        let paid = m.credit_backer_fee(2_000_000).unwrap();
        assert_eq!(paid as u128, 2_000_000 * BACKER_FEE_SHARE_BPS as u128 / BPS);
        assert_eq!(m.backing_usd, 1_000_000_000 + paid);
        // Same shares, more behind them: the backer is paid by the price.
        assert_eq!(m.backing_shares, 1_000_000_000);
        assert_eq!(m.backing_value(1_000_000_000), before + paid);
        // A fee is not a repayment, and it is not a larger allowance.
        assert_eq!(m.backing_drawn_usd, 0);
        assert_eq!(m.loss_budget_usd, market().loss_budget_usd);
    }

    #[test]
    fn a_backer_who_stayed_through_a_drawdown_earns_back_into_it() {
        let mut m = market();
        m.backing_usd = 500;
        m.backing_shares = 500;
        m.draw_backing(500);
        assert_eq!(m.backing_value(500), 0);
        // Shares are still outstanding, so the fee still has somewhere to go.
        assert_eq!(m.credit_backer_fee(1_000).unwrap(), 500);
        assert_eq!(m.backing_value(500), 500);
        // And the loss is still owed back separately.
        assert_eq!(m.backing_drawn_usd, 500);
    }

    #[test]
    fn the_first_backer_sets_the_share_price_at_one() {
        let m = market();
        assert_eq!(m.backing_shares_for(1_234).unwrap(), 1_234);
        assert_eq!(m.backing_value(1_234), 0, "worth nothing until it is posted");
    }

    #[test]
    fn backing_value_rounds_down_so_the_last_backer_out_cannot_overdraw() {
        let mut m = market();
        m.backing_usd = 10;
        m.backing_shares = 3;
        // 3 shares against 10 USD: each is worth 3, not 3.33, and the three
        // of them together cannot claim 11.
        assert_eq!(m.backing_value(1), 3);
        assert_eq!(m.backing_value(1) * 3, 9);
        assert_eq!(m.backing_value(3), 10);
    }

    fn oracle(price: u64, conf: u64) -> OraclePrice {
        OraclePrice {
            price,
            conf,
            published_ts: 0,
        }
    }

    #[test]
    fn spread_widens_with_oracle_confidence() {
        let m = market();
        // 0.1% confidence at a 1.0x multiplier adds 10bps on top of the 5bp floor.
        let tight = m.spread_bps(&oracle(100_000_000, 0)).unwrap();
        let wide = m.spread_bps(&oracle(100_000_000, 100_000)).unwrap();
        assert_eq!(tight, 5);
        assert_eq!(wide, 15);
    }

    #[test]
    fn spread_is_capped() {
        let m = market();
        // A 50% confidence interval would imply a 5000bp spread; the cap holds.
        let s = m.spread_bps(&oracle(100_000_000, 50_000_000)).unwrap();
        assert_eq!(s, m.max_spread_bps);
    }

    #[test]
    fn buys_pay_the_offer_and_sells_hit_the_bid() {
        let m = market();
        let o = oracle(100_000_000, 0);
        assert_eq!(m.fill_price(&o, true).unwrap(), 100_050_000);
        assert_eq!(m.fill_price(&o, false).unwrap(), 99_950_000);
    }

    #[test]
    fn closed_session_tightens_leverage_and_open_interest() {
        let mut m = market();
        m.session = Session::Closed as u8;
        assert_eq!(m.effective_max_leverage_bps().unwrap(), 20_000);
        assert_eq!(
            m.effective_oi_cap_usd(true).unwrap(),
            m.max_oi_long_usd / 4
        );
    }

    #[test]
    fn funding_is_conserved_between_the_two_sides() {
        let mut m = market();
        // Longs are 3x the shorts, so longs pay and shorts receive.
        m.long_size_usd = 3_000_000_000;
        m.short_size_usd = 1_000_000_000;
        m.accrue_funding(SECONDS_PER_HOUR, 0).unwrap();

        let long_paid = funding_owed_usd(m.long_size_usd, 0, m.cumulative_long_funding).unwrap();
        let short_paid = funding_owed_usd(m.short_size_usd, 0, m.cumulative_short_funding).unwrap();
        assert!(long_paid > 0, "heavy side must pay");
        assert!(short_paid < 0, "light side must receive");
        // What the longs pay is what the shorts receive, modulo integer dust.
        assert!((long_paid + short_paid).abs() <= 2, "leak of {}", long_paid + short_paid);
    }

    #[test]
    fn funding_rate_is_capped_per_hour() {
        let mut m = market();
        m.long_size_usd = 1_000_000_000;
        m.short_size_usd = 1; // maximal skew
        m.accrue_funding(SECONDS_PER_HOUR, 0).unwrap();
        // $1000 of longs at the 100bp/hr cap pays at most $10 in an hour.
        let paid = funding_owed_usd(m.long_size_usd, 0, m.cumulative_long_funding).unwrap();
        assert!(paid <= 10_000_000, "paid {}", paid);
    }

    #[test]
    fn one_sided_book_pays_borrow_but_not_skew_funding() {
        let mut m = market();
        m.borrow_rate_bps_per_hour = 10;
        m.long_size_usd = 1_000_000_000;
        m.short_size_usd = 0;
        m.accrue_funding(SECONDS_PER_HOUR, BPS as u16).unwrap();
        // Both indices move by the borrow leg only, so nothing is created out of
        // thin air for a counterparty that does not exist.
        assert_eq!(m.cumulative_long_funding, m.cumulative_short_funding);
        assert!(m.cumulative_long_funding > 0);
    }

    #[test]
    fn borrow_scales_with_utilization() {
        let mut m1 = market();
        m1.borrow_rate_bps_per_hour = 10;
        m1.accrue_funding(SECONDS_PER_HOUR, BPS as u16).unwrap();

        let mut m2 = market();
        m2.borrow_rate_bps_per_hour = 10;
        m2.accrue_funding(SECONDS_PER_HOUR, (BPS / 2) as u16).unwrap();

        assert_eq!(m1.cumulative_long_funding, m2.cumulative_long_funding * 2);
    }

    #[test]
    fn a_long_gap_in_the_crank_cannot_accrue_unbounded_funding() {
        let mut m = market();
        m.borrow_rate_bps_per_hour = 100;
        // Nobody cranked for 30 days.
        m.accrue_funding(30 * 24 * SECONDS_PER_HOUR, BPS as u16).unwrap();
        let capped = m.cumulative_long_funding;

        let mut reference = market();
        reference.borrow_rate_bps_per_hour = 100;
        reference
            .accrue_funding(MAX_FUNDING_ACCRUAL_SECONDS, BPS as u16)
            .unwrap();
        assert_eq!(capped, reference.cumulative_long_funding);
    }

    #[test]
    fn a_position_opened_after_accrual_owes_nothing_for_before_it_existed() {
        use crate::math::funding_owed_usd;
        let size = 1_000_000_000; // $1,000
        let (opened, later) = (SECONDS_PER_HOUR, SECONDS_PER_HOUR + 60);

        // Settlement accrues at the open, then snapshots: the next accrual
        // charges only the minute since.
        let mut fresh = market();
        fresh.borrow_rate_bps_per_hour = 100;
        fresh.accrue_funding(opened, BPS as u16).unwrap();
        let entry = fresh.cumulative_funding(true);
        fresh.accrue_funding(later, BPS as u16).unwrap();
        let owed_fresh = funding_owed_usd(size, entry, fresh.cumulative_funding(true)).unwrap();

        // Snapshotting the index the last accrual left (at t=0) charges the
        // hour before the position was opened as well.
        let mut stale = market();
        stale.borrow_rate_bps_per_hour = 100;
        let entry = stale.cumulative_funding(true);
        stale.accrue_funding(later, BPS as u16).unwrap();
        let owed_stale = funding_owed_usd(size, entry, stale.cumulative_funding(true)).unwrap();

        assert!(owed_fresh > 0);
        assert!(owed_stale > owed_fresh * 50, "stale {owed_stale} vs fresh {owed_fresh}");
    }

    #[test]
    fn a_split_preserves_position_value() {
        let mut m = market();
        let entry = 400_000_000; // $400
        let entry_factor = m.price_factor;

        // 4-for-1 split: price is multiplied by 1/4.
        m.price_factor = m.price_factor / 4;

        let adjusted = m.adjust_entry_price(entry, entry_factor).unwrap();
        assert_eq!(adjusted, 100_000_000);

        // A holder who was flat at $400 pre-split is still flat at $100 post-split.
        let pnl = position_pnl_usd(true, 1_000_000_000, adjusted, 100_000_000).unwrap();
        assert_eq!(pnl, 0);
    }

    #[test]
    fn batch_backing_follows_the_running_net() {
        let mut m = market();
        m.backing_usd = 100;
        m.backing_shares = 100;
        m.end_batch_netting();
        // A loser first: nothing was drawn before the batch, nothing restored.
        assert_eq!(m.settle_backing_in_batch(-150).unwrap(), 0);
        // A winner then: the net is zero, so the backing is not drawn.
        assert_eq!(m.settle_backing_in_batch(150).unwrap(), 0);
        // A second winner draws for the net, up to what the backing held.
        assert_eq!(m.settle_backing_in_batch(130).unwrap(), 100);
        assert_eq!((m.backing_usd, m.backing_drawn_usd, m.batch_backing_usd), (0, 100, 100));
        // A loser puts back what the net no longer needs.
        assert_eq!(m.settle_backing_in_batch(-80).unwrap(), -50);
        assert_eq!((m.backing_usd, m.backing_drawn_usd, m.batch_net_usd), (50, 50, 50));
        // A loser's step never draws, nor a winner's restores.
        m.end_batch_netting();
        m.backing_usd = 10;
        m.batch_backing_usd = 0;
        m.batch_net_usd = 500;
        assert_eq!(m.settle_backing_in_batch(-20).unwrap(), 0);
        m.end_batch_netting();
        assert_eq!((m.batch_net_usd, m.batch_backing_usd, m.batch_insurance_usd, m.batch_backer_fees_usd), (0, 0, 0, 0));
    }

    #[test]
    fn a_split_never_rebases_an_entry_to_zero() {
        let mut m = market();
        let entry_factor = m.price_factor;
        // 1-for-10: an entry of five units would rebase to half a unit.
        m.price_factor /= 10;
        assert_eq!(m.adjust_entry_price(5, entry_factor).unwrap(), 1);
        assert_eq!(m.adjust_entry_price(1, entry_factor).unwrap(), 1);
        // Above a unit it is the plain quotient, rounded down.
        assert_eq!(m.adjust_entry_price(25, entry_factor).unwrap(), 2);
        // Nothing recorded stays nothing.
        assert_eq!(m.adjust_entry_price(0, entry_factor).unwrap(), 0);
        // And a floored entry still prices the position.
        assert!(position_pnl_usd(true, 10_000_000, 1, 1).is_ok());
    }

    #[test]
    fn aggregate_pnl_is_the_pools_liability() {
        let mut m = market();
        m.long_size_usd = 1_000_000_000;
        m.long_avg_entry_price = 100_000_000;
        m.short_size_usd = 1_000_000_000;
        m.short_avg_entry_price = 100_000_000;
        // Balanced book: the pool has no directional exposure at any price.
        assert_eq!(m.trader_pnl_usd(120_000_000).unwrap(), 0);
        assert_eq!(m.trader_pnl_usd(80_000_000).unwrap(), 0);

        // Net long book: a rally is a loss for the pool.
        m.short_size_usd = 0;
        assert!(m.trader_pnl_usd(120_000_000).unwrap() > 0);
    }

    #[test]
    fn a_market_cannot_cost_more_than_it_was_underwritten_for() {
        let mut m = market();
        m.loss_budget_usd = 100_000_000; // $100
        // Spending it is fine, in any number of pieces.
        m.charge_loss(60_000_000).unwrap();
        m.charge_loss(40_000_000).unwrap();
        assert_eq!(m.remaining_budget_usd(), 0);
        // One cent past it is not. This is the whole guarantee open listing
        // rests on: the worst market in the pool cannot reach the others.
        assert!(m.charge_loss(10_000).is_err());
        assert_eq!(m.net_loss_usd, 100_000_000, "a refused charge books nothing");
    }

    #[test]
    fn gains_unwind_losses_but_do_not_enlarge_the_budget() {
        let mut m = market();
        m.loss_budget_usd = 100_000_000;
        m.charge_loss(80_000_000).unwrap();
        m.credit_gain(80_000_000).unwrap();
        assert_eq!(m.remaining_budget_usd(), 100_000_000);

        // Now run it net positive. A market that has made money for the pool
        // has not thereby earned permission to lose more than it was listed
        // with -- otherwise a market could farm profit into rope.
        m.credit_gain(500_000_000).unwrap();
        assert!(m.net_loss_usd < 0);
        assert_eq!(m.remaining_budget_usd(), 100_000_000);
    }

    #[test]
    fn liquidation_and_adl_are_not_blocked_by_an_exhausted_budget() {
        let mut m = market();
        m.loss_budget_usd = 100_000_000;
        m.charge_loss(100_000_000).unwrap();
        assert!(m.charge_loss(50_000_000).is_err());
        // The forced paths still settle, and the overrun is recorded rather
        // than hidden -- a position that cannot be closed is worse for the
        // pool than one that breaches the budget on the way out.
        m.charge_loss_unchecked(50_000_000).unwrap();
        assert_eq!(m.net_loss_usd, 150_000_000);
        assert_eq!(m.remaining_budget_usd(), 0);
    }

    #[test]
    fn reserving_is_bounded_by_the_budget_not_the_pool() {
        let mut m = market();
        m.loss_budget_usd = 100_000_000; // $100
        m.locked_usd = 0;
        // 80% of $100 at an 8,000bps cap.
        assert_eq!(m.lock_headroom_usd(8_000), 80_000_000);
        m.lock_admitted(80_000_000).unwrap();
        assert_eq!(m.lock_headroom_usd(8_000), 0);
    }

    #[test]
    fn losses_already_taken_shrink_what_can_be_reserved() {
        let mut m = market();
        m.loss_budget_usd = 100_000_000;
        m.charge_loss(50_000_000).unwrap();
        // Half the budget is spent, so the cap applies to the half that is
        // left: 80% of $50, not of $100.
        assert_eq!(m.lock_headroom_usd(8_000), 40_000_000);
    }

    #[test]
    fn a_reservation_past_the_cap_is_booked_and_leaves_no_headroom() {
        let mut m = market();
        m.loss_budget_usd = 100_000_000;
        // A crossing fill settles past the cap rather than failing, and the
        // overrun shows up as zero headroom rather than a negative one.
        m.lock_admitted(120_000_000).unwrap();
        assert_eq!(m.locked_usd, 120_000_000);
        assert_eq!(m.lock_headroom_usd(8_000), 0);
    }

    #[test]
    fn an_unfunded_market_cannot_open_anything() {
        let mut m = market();
        m.loss_budget_usd = 0;
        // Listing a market and underwriting it are separate acts. Until the
        // second one happens the market quotes and does nothing else.
        assert_eq!(m.lock_headroom_usd(8_000), 0);
        assert!(m.charge_loss(1).is_err());
    }

    #[test]
    fn unlock_is_saturating() {
        let mut m = market();
        m.lock_admitted(1_000_000).unwrap();
        m.unlock(5_000_000);
        assert_eq!(m.locked_usd, 0);
    }
    #[test]
    fn a_market_never_goes_back_to_an_older_price() {
        let mut m = market();
        let at = |published_ts| OraclePrice { price: 100_000_000, conf: 0, published_ts };
        m.accept_price(&at(1_000), 1).unwrap();
        m.accept_price(&at(1_000), 2).unwrap(); // the same price twice is fine
        assert!(m.accept_price(&at(999), 3).is_err(), "an older one is refused");
        m.accept_price(&at(1_060), 4).unwrap();
        assert_eq!(m.last_price_ts, 1_060);
    }

    #[test]
    fn two_prices_with_one_publish_time_are_not_a_choice() {
        let mut m = market();
        let at = |price| OraclePrice { price, conf: 0, published_ts: 1_000 };
        m.accept_price(&at(100_000_000), 1).unwrap();
        assert!(
            m.accept_price(&at(100_100_000), 2).is_err(),
            "a second price under the same publish time is refused"
        );
        assert_eq!(m.last_price, 100_000_000, "a refused price is not recorded");
        m.accept_price(&at(100_000_000), 3).unwrap();
    }

    #[test]
    fn a_market_grown_from_the_old_layout_accepts_its_next_price() {
        // A resized account has the publish time but no price on record.
        let mut m = market();
        m.last_price_ts = 1_000;
        m.last_price = 0;
        m.accept_price(&OraclePrice { price: 5, conf: 0, published_ts: 1_000 }, 1).unwrap();
        assert_eq!(m.last_price, 5);
    }

    #[test]
    fn a_read_only_price_is_held_to_the_newest_time_used() {
        let mut m = market();
        let at = |published_ts| OraclePrice { price: 100_000_000, conf: 0, published_ts };
        m.accept_price(&at(1_000), 1).unwrap();
        assert!(m.check_price_floor(&at(1_000)).is_ok());
        assert!(m.check_price_floor(&at(1_001)).is_ok());
        assert!(m.check_price_floor(&at(999)).is_err());
    }

    fn with_open_interest() -> Market {
        let mut m = market();
        m.long_size_usd = 1_000_000_000;
        m
    }

    #[test]
    fn the_risk_price_follows_an_empty_market_at_once() {
        let mut m = market();
        let at = |price, published_ts| OraclePrice { price, conf: 0, published_ts };
        assert_eq!(m.accept_price(&at(100_000_000, 1), 10).unwrap(), 100_000_000);
        // Nobody holds a position, so nobody can be hurt by a jump.
        assert_eq!(m.accept_price(&at(150_000_000, 2), 11).unwrap(), 150_000_000);
        assert_eq!(m.risk_price, 150_000_000);
    }

    #[test]
    fn the_risk_price_walks_toward_a_jump_at_the_per_slot_cap() {
        let mut m = with_open_interest();
        let at = |price, published_ts| OraclePrice { price, conf: 0, published_ts };
        assert_eq!(m.accept_price(&at(100_000_000, 1), 10).unwrap(), 100_000_000);
        // A 20% jump, one slot later: the risk price moves one slot's cap.
        let step = 100_000_000 * RISK_PRICE_STEP_BPS_PER_SLOT / 10_000;
        assert_eq!(m.accept_price(&at(120_000_000, 2), 11).unwrap(), 100_000_000 + step);
        // A second reading in the same slot moves it no further.
        assert_eq!(m.accept_price(&at(120_000_000, 2), 11).unwrap(), 100_000_000 + step);
        assert_eq!(m.risk_slot, 11);
    }

    #[test]
    fn a_long_gap_moves_the_risk_price_no_more_than_the_max_gap_allows() {
        let mut m = with_open_interest();
        let at = |price, published_ts| OraclePrice { price, conf: 0, published_ts };
        m.accept_price(&at(100_000_000, 1), 10).unwrap();
        // A thousand slots unattended and then a 50% drop: one reading moves
        // the risk price by at most the envelope maintenance was sized for.
        let r = m.accept_price(&at(50_000_000, 2), 1_010).unwrap();
        let most = RISK_PRICE_STEP_BPS_PER_SLOT * RISK_PRICE_MAX_GAP_SLOTS;
        assert_eq!(r, 100_000_000 - 100_000_000 * most / 10_000);
        assert!(m.risk_price >= 50_000_000);
    }

    #[test]
    fn a_refused_price_does_not_move_the_risk_price() {
        let mut m = with_open_interest();
        let at = |price, published_ts| OraclePrice { price, conf: 0, published_ts };
        m.accept_price(&at(100_000_000, 100), 10).unwrap();
        assert!(m.accept_price(&at(50_000_000, 99), 20).is_err());
        assert_eq!((m.risk_price, m.risk_slot), (100_000_000, 10));
    }


    #[test]
    fn leverage_follows_the_tiers() {
        let k = 1_000 * USD_SCALE as u64;
        assert_eq!(leverage_for_depth(0), 2);
        assert_eq!(leverage_for_depth(10 * k - 1), 2);
        assert_eq!(leverage_for_depth(10 * k), 3);
        assert_eq!(leverage_for_depth(50 * k), 4);
        assert_eq!(leverage_for_depth(250 * k), 5);
        assert_eq!(leverage_for_depth(u64::MAX), 5);
    }

    #[test]
    fn an_observed_market_is_capped_by_its_pools_depth() {
        let mut m = market();
        m.price_source = PriceSource::Observed as u8;
        m.max_leverage_bps = 50_000;
        // No reading yet: the lowest tier, not the market's own ceiling.
        assert_eq!(m.effective_max_leverage_bps().unwrap(), 20_000);
        m.depth_leverage_x = 4;
        assert_eq!(m.effective_max_leverage_bps().unwrap(), 40_000);
        // Depth never lifts a market past what it was listed with.
        m.max_leverage_bps = 30_000;
        m.depth_leverage_x = 5;
        assert_eq!(m.effective_max_leverage_bps().unwrap(), 30_000);
    }

    #[test]
    fn a_feed_market_is_not_capped_by_depth() {
        let mut m = market();
        m.depth_leverage_x = 2;
        assert_eq!(m.effective_max_leverage_bps().unwrap(), m.max_leverage_bps);
    }

    #[test]
    fn a_market_in_profit_still_costs_the_pool_at_most_its_budget() {
        let mut m = market();
        m.loss_budget_usd = 100;
        m.credit_gain(500).unwrap();
        // However the losses are split, the market's net cost to the pool
        // stops at its budget.
        while m.charge_loss(100).is_ok() {}
        assert_eq!(m.net_loss_usd, 100);
        assert_eq!(m.remaining_budget_usd(), 0);
    }

    #[test]
    fn backing_held_plus_drawn_is_conserved_through_a_loss_and_a_gain() {
        let mut m = market();
        m.backing_usd = 1_000;
        m.backing_shares = 1_000;
        let taken = m.draw_backing(700);
        assert_eq!(m.backing_usd + m.backing_drawn_usd, 1_000);
        let owed = m.restore_backing(250);
        assert_eq!(m.backing_usd + m.backing_drawn_usd, 1_000);
        assert_eq!((taken, owed), (700, 250));
        assert_eq!(m.backing_usd, 550);
    }

    #[test]
    fn two_backers_leaving_cannot_overdraw_the_pot() {
        let mut m = market();
        m.backing_usd = 10;
        m.backing_shares = 3;
        // 10 / 3 per share, rounded down for each: 3 and 6, one unit left.
        assert_eq!(m.backing_value(1), 3);
        assert_eq!(m.backing_value(2), 6);
        assert!(m.backing_value(1) + m.backing_value(2) <= m.backing_usd);
        assert_eq!(m.backing_value(3), 10, "all the shares are all the pot");
    }

    #[test]
    fn a_backer_fee_is_at_most_half_the_fee_even_when_odd() {
        let mut m = market();
        m.backing_usd = 100;
        m.backing_shares = 100;
        assert_eq!(m.credit_backer_fee(3).unwrap(), 1);
        assert_eq!(m.credit_backer_fee(1).unwrap(), 0);
        assert_eq!(m.backing_usd, 101);
    }

    #[test]
    fn the_band_is_the_tighter_of_half_maintenance_and_the_spread_cap() {
        let mut m = market();
        // Maintenance 5% gives 2.5%, and the 5% spread cap does not bind.
        assert_eq!(m.price_band(100_000_000).unwrap(), (97_500_000, 102_500_000));
        // A 1% spread cap binds before half the maintenance margin does.
        m.max_spread_bps = 100;
        assert_eq!(m.price_band(100_000_000).unwrap(), (99_000_000, 101_000_000));
    }

    #[test]
    fn the_same_price_may_be_used_twice_but_not_an_older_one() {
        let mut m = market();
        let at = |ts| OraclePrice { price: 1, conf: 0, published_ts: ts };
        m.accept_price(&at(100), 1).unwrap();
        m.accept_price(&at(100), 2).unwrap();
        assert!(m.accept_price(&at(99), 3).is_err());
        assert_eq!(m.last_price_ts, 100, "a refused price is not recorded");
    }

    #[test]
    fn a_sell_fill_stops_at_zero_when_the_spread_exceeds_the_price() {
        let mut m = market();
        m.base_spread_bps = 20_000;
        m.max_spread_bps = 20_000;
        let o = oracle(100, 0);
        assert_eq!(m.fill_price(&o, true).unwrap(), 300);
        assert_eq!(m.fill_price(&o, false).unwrap(), 0);
    }

    #[test]
    fn uneven_skew_funding_rounds_in_the_pools_favour() {
        let mut m = market();
        m.long_size_usd = 7;
        m.short_size_usd = 3;
        m.accrue_funding(3_600, 0).unwrap();
        let (l, s) = (m.cumulative_long_funding, m.cumulative_short_funding);
        assert!(l > 0 && s < 0);
        // What the shorts receive in total never exceeds what the longs pay,
        // and the rounding kept back is under one unit per short dollar.
        let net = l * 7 + s * 3;
        assert!((0..3).contains(&net), "net {net}");
    }

    // The share arithmetic is `x * y / z` in three unknowns, which a model
    // checker cannot get through in reasonable time (see `proofs/budget.rs`).
    // These check it for every value up to `N` instead.
    const N: u64 = 40;

    #[test]
    fn every_new_backer_neither_gains_nor_dilutes() {
        for held in 1..=N {
            for shares in 1..=N {
                for amount in 0..=N {
                    let mut m = market();
                    m.backing_usd = held;
                    m.backing_shares = shares;
                    let fresh = m.backing_shares_for(amount).unwrap();
                    m.backing_usd += amount;
                    m.backing_shares += fresh;
                    assert!(m.backing_value(fresh) <= amount, "{held} {shares} {amount}");
                    assert!(m.backing_value(shares) >= held, "{held} {shares} {amount}");
                }
            }
        }
    }

    #[test]
    fn backers_together_never_withdraw_more_than_is_held() {
        for held in 0..=N {
            for shares in 1..=N {
                let mut m = market();
                m.backing_usd = held;
                m.backing_shares = shares;
                assert_eq!(m.backing_value(shares), held, "all the shares are all the pot");
                for mine in 0..=shares {
                    let (a, b) = (m.backing_value(mine), m.backing_value(shares - mine));
                    assert!(a + b <= held, "{held} {shares} {mine}");
                }
            }
        }
    }

    #[test]
    fn a_fee_never_lowers_any_backers_share() {
        for held in 0..=N {
            for shares in 1..=N {
                for fee in 0..=N {
                    let mut m = market();
                    m.backing_usd = held;
                    m.backing_shares = shares;
                    let before: Vec<u64> = (0..=shares).map(|x| m.backing_value(x)).collect();
                    m.credit_backer_fee(fee).unwrap();
                    for x in 0..=shares {
                        assert!(m.backing_value(x) >= before[x as usize]);
                    }
                }
            }
        }
    }

    /// A backer into a market whose backing was drawn to zero, with shares
    /// still outstanding, is refused. Before the fix they bought at one share
    /// per dollar and handed half of a 1,000 deposit to 1,000 wiped-out
    /// shares. `custody::shares_for`, which `back_market` calls, refuses too.
    #[test]
    fn a_backer_into_a_wiped_out_market_is_not_diluted() {
        let mut m = market();
        m.backing_usd = 0;
        m.backing_shares = 1_000;
        assert!(m.backing_shares_for(1_000).is_err());
        assert!(crate::state::custody::shares_for(1_000, 1_000, 0).is_err());
    }

    /// A gain arriving after every backer has left stays with the pool rather
    /// than sitting in an unowned pot for the next backer to claim.
    #[test]
    fn a_gain_with_no_backers_left_is_not_restored() {
        let mut m = market();
        m.backing_usd = 0;
        m.backing_shares = 0;
        m.backing_drawn_usd = 500;
        assert_eq!(m.restore_backing(300), 0);
        assert_eq!((m.backing_usd, m.backing_drawn_usd), (0, 500));
    }

    // Caps and spreads for the bounded sweeps below: zero, the extremes, the
    // values the tests use, and ones that do not divide evenly.
    const CAPS: [u16; 6] = [0, 1, 3_333, 8_000, 9_999, 10_000];

    #[test]
    fn every_market_lock_within_headroom_stays_under_the_cap() {
        for budget in 0..=30u64 {
            for net in -5..=budget as i64 {
                for cap in CAPS {
                    let mut m = market();
                    m.loss_budget_usd = budget;
                    m.net_loss_usd = net;
                    let limit = cap as u128 * m.remaining_budget_usd() as u128;
                    for locked in (0..=30u64).filter(|&l| l as u128 * BPS <= limit) {
                        m.locked_usd = locked;
                        let room = m.lock_headroom_usd(cap);
                        assert!(locked + room <= m.remaining_budget_usd());
                        for amount in 0..=room {
                            let mut n = market();
                            n.loss_budget_usd = budget;
                            n.net_loss_usd = net;
                            n.locked_usd = locked;
                            n.lock_admitted(amount).unwrap();
                            assert!(n.locked_usd as u128 * BPS <= limit);
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn every_backer_fee_is_at_most_half_the_fee() {
        let mut m = market();
        m.backing_shares = 1;
        for fee in 0..=2_000u64 {
            let before = m.backing_usd;
            let paid = m.credit_backer_fee(fee).unwrap();
            assert_eq!(paid, fee / 2);
            assert_eq!(m.backing_usd, before + paid);
        }
    }

    #[test]
    fn every_fill_straddles_the_oracle_within_the_spread_cap() {
        const SPREADS: [u16; 6] = [0, 1, 5, 333, 10_000, 20_000];
        for base in SPREADS {
            for max in SPREADS.into_iter().filter(|&x| x >= base) {
                for mult in [0u16, 1, 10_000, 65_535] {
                    let mut m = market();
                    m.base_spread_bps = base;
                    m.max_spread_bps = max;
                    m.conf_spread_mult_bps = mult;
                    for price in 1..=60u64 {
                        for conf in 0..=60u64 {
                            let o = oracle(price, conf);
                            let buy = m.fill_price(&o, true).unwrap();
                            let sell = m.fill_price(&o, false).unwrap();
                            let cap = price as u128 * max as u128 / BPS;
                            assert!(sell <= price && price <= buy);
                            assert!((buy - price) as u128 <= cap);
                            assert_eq!(price - sell, (buy - price).min(price));
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn every_band_holds_the_mark_and_half_the_maintenance_margin() {
        for mm in [0u16, 1, 2, 3, 500, 999, 9_999] {
            for spread in [0u16, 1, 100, 250, 20_000] {
                let mut m = market();
                m.maintenance_margin_bps = mm;
                m.max_spread_bps = spread;
                for mark in 0..=500u64 {
                    let (lo, hi) = m.price_band(mark).unwrap();
                    assert!(lo <= mark && mark <= hi);
                    for edge in [(hi - mark) as u128, (mark - lo) as u128] {
                        assert!(edge * BPS <= mark as u128 * (mm / 2) as u128);
                        assert!(edge * BPS <= mark as u128 * spread as u128);
                    }
                }
            }
        }
    }

    #[test]
    fn the_oi_cap_never_exceeds_what_was_configured() {
        for session in [Session::Regular, Session::Extended, Session::Closed] {
            for base in [0u64, 1, 3, 999, 1_000_000_007, u64::MAX] {
                for mult in (0..=10_000u16).step_by(7).chain([10_000]) {
                    let mut m = market();
                    m.session = session as u8;
                    m.max_oi_long_usd = base;
                    m.max_oi_short_usd = base;
                    m.closed_session_oi_mult_bps = mult;
                    for is_long in [true, false] {
                        assert!(m.effective_oi_cap_usd(is_long).unwrap() <= base);
                    }
                }
            }
        }
    }

    // ---- Gaps found by coverage: the money helpers' edges and refusals. ----

    #[test]
    fn only_the_winning_side_counts_toward_winning_pnl() {
        let mut m = market();
        assert_eq!(m.winning_pnl_usd(100_000_000).unwrap(), 0, "no positions, nothing won");
        m.long_size_usd = 1_000_000_000; // $1,000 long at $100
        m.long_avg_entry_price = 100_000_000;
        m.short_size_usd = 500_000_000; // $500 short at $100
        m.short_avg_entry_price = 100_000_000;
        // At $110 the long is up $100 and the short down $50: not netted.
        assert_eq!(m.winning_pnl_usd(110_000_000).unwrap(), 100_000_000);
        assert_eq!(m.trader_pnl_usd(110_000_000).unwrap(), 50_000_000);
        // At $90 the short is up $50, the long's loss counts as zero.
        assert_eq!(m.winning_pnl_usd(90_000_000).unwrap(), 50_000_000);
        // At entry nobody is up.
        assert_eq!(m.winning_pnl_usd(100_000_000).unwrap(), 0);
    }

    #[test]
    fn winning_pnl_refuses_a_side_with_no_entry() {
        let mut m = market();
        m.long_size_usd = 1;
        m.long_avg_entry_price = 0;
        assert_eq!(m.winning_pnl_usd(1).unwrap_err(), PerpError::InvalidOraclePrice.into());
    }

    #[test]
    fn the_worst_lp_pnl_is_the_budget_left_less_backing() {
        let mut m = market();
        m.loss_budget_usd = 1_000_000_000;
        m.net_loss_usd = 0;
        m.backing_usd = 0;
        assert_eq!(m.lp_worst_pnl_usd(), 1_000_000_000);
        m.net_loss_usd = 400_000_000;
        assert_eq!(m.lp_worst_pnl_usd(), 600_000_000);
        m.backing_usd = 100_000_000;
        assert_eq!(m.lp_worst_pnl_usd(), 500_000_000);
        // Backing past the budget leaves the LPs nothing to lose, not a gain.
        m.backing_usd = u64::MAX;
        assert_eq!(m.lp_worst_pnl_usd(), 0);
        // A budget past i64 saturates rather than wrapping negative.
        m.loss_budget_usd = u64::MAX;
        m.net_loss_usd = 0;
        m.backing_usd = 0;
        assert_eq!(m.lp_worst_pnl_usd(), i64::MAX);
    }

    #[test]
    fn an_entry_under_its_own_factor_is_returned_unchanged() {
        let m = market();
        assert_eq!(m.adjust_entry_price(123, m.price_factor).unwrap(), 123);
    }

    #[test]
    fn an_entry_under_a_zero_factor_is_refused() {
        let m = market();
        assert_eq!(m.adjust_entry_price(100, 0).unwrap_err(), PerpError::InvalidParameter.into());
    }

    #[test]
    fn an_entry_rebased_past_u64_is_refused() {
        let mut m = market();
        let before = m.price_factor;
        // A 1-for-4 reverse split of an entry already near the top.
        m.price_factor = before * 4;
        assert_eq!(m.adjust_entry_price(u64::MAX, before).unwrap_err(), PerpError::MathOverflow.into());
        m.price_factor = u128::MAX;
        assert_eq!(m.adjust_entry_price(2, 1).unwrap_err(), PerpError::MathOverflow.into());
    }

    #[test]
    fn a_rebased_entry_rounds_down() {
        let mut m = market();
        let before = m.price_factor;
        m.price_factor = before / 3; // 3-for-1
        assert_eq!(m.adjust_entry_price(100, before).unwrap(), 33);
    }

    #[test]
    fn utilization_is_the_imbalance_against_the_pool() {
        let mut m = market();
        assert_eq!(m.utilization_bps(0), 0, "an empty book borrows nothing, even from an empty pool");
        m.long_size_usd = 500;
        m.short_size_usd = 500;
        assert_eq!(m.utilization_bps(1_000), 0, "a balanced book borrows nothing");
        m.long_size_usd = 750;
        assert_eq!(m.utilization_bps(1_000), 2_500);
        assert_eq!(m.utilization_bps(0), BPS as u16, "an imbalance against no pool is full");
        m.long_size_usd = 1_000_000;
        assert_eq!(m.utilization_bps(1_000), BPS as u16, "capped at the whole pool");
        m.long_size_usd = 500;
        m.short_size_usd = 1_500;
        assert_eq!(m.utilization_bps(10_000), 1_000, "a heavy short side counts the same");
    }

    #[test]
    fn funding_does_not_move_when_no_time_has_passed() {
        let mut m = market();
        m.long_size_usd = 1_000_000_000;
        m.last_funding_ts = 1_000;
        let (l, s) = (m.cumulative_long_funding, m.cumulative_short_funding);
        m.accrue_funding(1_000, BPS as u16).unwrap();
        assert_eq!((m.cumulative_long_funding, m.cumulative_short_funding), (l, s));
        // A clock that went backwards accrues nothing and does not run in reverse.
        m.accrue_funding(500, BPS as u16).unwrap();
        assert_eq!((m.cumulative_long_funding, m.cumulative_short_funding), (l, s));
        assert_eq!(m.last_funding_ts, 500);
    }

    #[test]
    fn an_untrackable_position_has_no_moment_or_funding_terms() {
        assert_eq!(moment_terms(1_000, 0), None, "no entry, no terms");
        assert!(moment_terms(1_000, 1).is_some());
        let t = FundingTerm { size: 0, entry_funding: 0, collateral: 10, entry: 1 };
        assert_eq!(t.cover(), None, "a zero-size position has no cover");
        let t = FundingTerm { size: 4, entry_funding: 7, collateral: 1, entry: 1 };
        assert_eq!(t.cover(), Some(FUNDING_SCALE / 4 + 7));
        let t = FundingTerm { size: 1, entry_funding: i128::MAX, collateral: 1, entry: 1 };
        assert_eq!(t.cover(), None, "a cover that overflows is not tracked");
    }

    #[test]
    fn moment_terms_round_inverse_entry_down_and_its_square_up() {
        let (u, q) = moment_terms(1, 3).unwrap();
        assert_eq!(u, MOMENT_U_SCALE / 3);
        // ceil(ceil(1e12 / 3) * 1e12 / 3)
        let a = MOMENT_Q_STEP / 3 + 1;
        assert_eq!(q, (a * MOMENT_Q_STEP) / 3 + 1);
    }
}
