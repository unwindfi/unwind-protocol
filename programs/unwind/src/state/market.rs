use crate::constants::*;
use crate::errors::PerpError;
use crate::math::*;
use crate::oracle::OraclePrice;
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
    pub _reserved: [u8; 2],
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
    pub fn backing_value(&self, shares: u64) -> u64 {
        if self.backing_shares == 0 {
            return 0;
        }
        ((shares as u128) * (self.backing_usd as u128) / (self.backing_shares as u128)) as u64
    }

    /// Shares `amount` of fresh backing buys.
    ///
    /// The first backer sets the price at one, and everyone after buys at
    /// whatever the drawdown has left a share worth. A wiped-out pot with
    /// shares still held refuses the deposit, as `shares_for` does.
    pub fn backing_shares_for(&self, amount: u64) -> Result<u64> {
        if self.backing_shares == 0 {
            return Ok(amount);
        }
        require!(self.backing_usd > 0, PerpError::BackingWipedOut);
        Ok((((amount as u128) * (self.backing_shares as u128)) / (self.backing_usd as u128))
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
    pub fn accept_price(&mut self, oracle: &OraclePrice) -> Result<()> {
        let ts = u32::try_from(oracle.published_ts.max(0)).unwrap_or(u32::MAX);
        require!(ts >= self.last_price_ts, PerpError::OraclePriceRegressed);
        self.last_price_ts = ts;
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
        u64::try_from(adjusted).map_err(|_| PerpError::MathOverflow.into())
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
            _reserved: [0; 2],
        }
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
    fn a_drawdown_reprices_shares_rather_than_socialising_it() {
        let mut m = market();
        m.backing_usd = 1_000;
        m.backing_shares = 1_000;

        // Half the backing is consumed by a loss.
        m.draw_backing(500);
        assert_eq!(m.backing_value(1_000), 500, "the first backer wears it");

        // Someone arriving now buys at the marked-down price: 500 USD against
        // 500 of value buys the same 1,000 shares the first backer holds.
        let fresh = m.backing_shares_for(500).unwrap();
        assert_eq!(fresh, 1_000);

        m.backing_usd += 500;
        m.backing_shares += fresh;
        assert_eq!(m.backing_value(1_000), 500);
        assert_eq!(m.backing_value(fresh), 500, "and neither subsidises the other");
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
        m.accept_price(&at(1_000)).unwrap();
        m.accept_price(&at(1_000)).unwrap(); // the same price twice is fine
        assert!(m.accept_price(&at(999)).is_err(), "an older one is refused");
        m.accept_price(&at(1_060)).unwrap();
        assert_eq!(m.last_price_ts, 1_060);
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
        m.accept_price(&at(100)).unwrap();
        m.accept_price(&at(100)).unwrap();
        assert!(m.accept_price(&at(99)).is_err());
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
}
