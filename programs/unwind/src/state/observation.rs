use crate::constants::*;
use crate::errors::PerpError;
use anchor_lang::prelude::*;

/// Minimum number of folds before the mark is served at all.
///
/// A fresh observation account holds one reading, and one reading is a spot
/// price — which is a number anybody can set for the length of a transaction.
/// The history is what makes it a mark.
pub const MIN_OBSERVATIONS: u32 = 30;

/// Minimum wall-clock span those observations must cover.
///
/// Without it the count is satisfiable in a single block by cranking thirty
/// times in one transaction, which observes nothing.
pub const MIN_OBSERVATION_WINDOW_SEC: i64 = 900;

/// Widest a pool's spot may sit from its own fifteen-minute average for that
/// average to open a market at listing.
///
/// History is only evidence of the price if the price is still there. A spot
/// well away from its own average is a pool being moved right now, or just
/// moved, and a listing that opened on the average would open on a number the
/// pool has already left. Past this the market waits and watches like one on a
/// pool with no history at all.
pub const SEED_MAX_GAP_BPS: u128 = 300;

/// Notional the depth figure is quoted against: the cost to move the pool by
/// `DEPTH_REF_BPS` is measured for this much size.
pub const DEPTH_REF_USD: u128 = 10_000_000_000; // $10,000

/// Which AMM a mark is observed from. Stored rather than inferred so the
/// parser cannot be pointed at an account of a different shape.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum SourceKind {
    RaydiumClmm,
    /// Reserved and not read: no reader exists, so an observation created
    /// against one is refused rather than left to fail on its first crank.
    OrcaWhirlpool,
    MeteoraDlmm,
}

impl SourceKind {
    pub fn from_u8(v: u8) -> Result<Self> {
        match v {
            0 => Ok(SourceKind::RaydiumClmm),
            1 => Ok(SourceKind::OrcaWhirlpool),
            2 => Ok(SourceKind::MeteoraDlmm),
            _ => err!(PerpError::InvalidParameter),
        }
    }
}

/// A mark for an asset with no Pyth feed, built by repeated observation of an
/// on-chain pool.
///
/// The threat this is shaped against: a spot price read from an AMM is worth
/// exactly what it costs to move that AMM for one transaction, which on a thin
/// pool is nothing. Three things answer it, and none of them work alone.
///
/// **The fold.** The published mark is an EWMA, so a spike contributes a
/// fraction of itself and decays out.
///
/// **The clamp.** The mark may move at most `max_move_bps` per update no
/// matter what the pool says. This is the part that turns the economics
/// around: to walk the mark somewhere, an attacker has to hold the pool there
/// across many updates rather than one, and pay the spread back to the pool
/// every time it decays. Cost stops being "move the pool once" and becomes
/// "move the pool and keep it moved".
///
/// **The depth.** Confidence is derived from what it costs to move the pool,
/// so a thin market quotes wide and, past `max_conf_bps`, stops quoting. The
/// existing spread and halt logic then applies unchanged — a memecoin with a
/// $40k pool is not a special case, it is a market with an enormous
/// confidence interval.
#[account]
#[derive(InitSpace)]
pub struct Observation {
    pub bump: u8,
    pub market: Pubkey,
    /// The AMM pool account this reads. Fixed at creation.
    pub source: Pubkey,
    pub source_kind: u8,
    /// Whether readings need inverting; see `ObservationParams`.
    pub quote_is_token_0: bool,

    /// The published mark, `PRICE_SCALE`.
    pub ewma_price: u64,
    /// The last raw spot read, kept so the gap between mark and pool is
    /// visible on-chain — a persistent gap is what manipulation looks like
    /// while it is happening.
    pub last_spot: u64,
    pub last_update_ts: i64,
    pub first_update_ts: i64,
    pub observations: u32,

    /// Weight of each new reading in the fold, bps. 500 is a ~20-sample mean.
    pub alpha_bps: u16,
    /// Ceiling on how far the mark may move in one update, bps.
    pub max_move_bps: u16,
    /// USD it takes to move this pool `DEPTH_REF_BPS`, from the last
    /// observation. Zero means unmeasured, which reads as maximally uncertain.
    pub depth_usd: u64,

    /// Decimals of the pool's token 0 (X) and token 1 (Y), for sources whose
    /// pool account does not carry them. Meteora's `LbPair` has no decimals
    /// field, so they are read off the two mints once, at creation, and kept
    /// here rather than asking every crank to pass the mints again. Zero for
    /// Raydium, which stores its own and is read from those.
    pub dec_x: u8,
    pub dec_y: u8,
    /// The mark is USD for `10^unit_exp` of the asset rather than for one.
    ///
    /// Prices are six decimals of dollars, which reads a token under a
    /// millionth of a dollar as zero and Bonk as $0.000003. A unit of a
    /// million keeps the digits. Everything else is in USD of notional, so
    /// sizes, margin and PnL never see the unit; only the number a price is
    /// quoted as does. Fixed at creation, because changing it would rescale a
    /// live mark and every entry price booked against it.
    pub unit_exp: u8,

    /// Depth the pool has held, as opposed to what it showed on one reading.
    ///
    /// Falls to any lower reading at once and rises toward a higher one only
    /// slowly (see `track_depth`), because depth is temporarily purchasable:
    /// liquidity parked in a pool for a slot must not buy a market leverage.
    pub sustained_depth_usd: u64,
    /// When `sustained_depth_usd` last rose.
    pub depth_rise_ts: i64,

    /// Whether the mark is pushed by the pool's mark keeper (`push_mark`)
    /// rather than folded from the pool by the permissionless crank.
    ///
    /// Set on the first push and never cleared. Once a keeper prices a
    /// market, `observe` keeps reading the pool for depth but leaves the
    /// price alone, so two sources never fight over one mark.
    pub keeper_priced: bool,

    // Carved from, so the account is the same size it always was.
    pub _reserved: [u8; 11],
}

impl Observation {
    /// Whether the mark has enough history behind it to be traded against.
    pub fn is_seasoned(&self) -> bool {
        self.observations >= MIN_OBSERVATIONS
            && self.last_update_ts - self.first_update_ts >= MIN_OBSERVATION_WINDOW_SEC
    }

    /// Sets the mark to a price the mark keeper pushed.
    ///
    /// The keeper reads the pool off-chain, smooths it
    /// there, and the program takes the result as the mark. The first push
    /// meets the bar `is_seasoned` sets, the same way `seed_from_history`
    /// does, so a market the keeper prices is tradeable from its first price
    /// rather than after fifteen minutes of readings. What that trades away
    /// is trustlessness: the mark is whatever the keeper key says, bounded
    /// only by staleness and the confidence its pool's depth allows.
    pub fn set_by_keeper(&mut self, price: u64, spot: u64, now: i64) -> Result<()> {
        require!(price > 0, PerpError::InvalidOraclePrice);
        if self.is_seasoned() {
            self.observations = self.observations.saturating_add(1);
        } else {
            self.observations = MIN_OBSERVATIONS;
            self.first_update_ts = now - MIN_OBSERVATION_WINDOW_SEC;
        }
        self.ewma_price = price;
        self.last_spot = spot;
        self.last_update_ts = now;
        self.keeper_priced = true;
        Ok(())
    }

    /// Folds a fresh spot reading into the mark.
    ///
    /// The clamp is applied to the *result* of the fold rather than to the
    /// input. Clamping the input would let a sustained spike walk the mark at
    /// full speed once the reading sat inside the band; clamping the output
    /// bounds the mark's velocity regardless of what the pool does.
    /// Folds one depth reading into `sustained_depth_usd`.
    ///
    /// Down at once, up by `DEPTH_RISE_BPS` of the gap at most once per
    /// `DEPTH_RISE_MIN_INTERVAL_SEC`. The asymmetry is the point: a market's
    /// leverage may fall the moment its pool thins, and may only rise on depth
    /// that stayed.
    pub fn track_depth(&mut self, depth: u64, now: i64) {
        if depth <= self.sustained_depth_usd {
            self.sustained_depth_usd = depth;
            return;
        }
        if now < self.depth_rise_ts.saturating_add(DEPTH_RISE_MIN_INTERVAL_SEC) {
            return;
        }
        let gap = (depth - self.sustained_depth_usd) as u128;
        // At least one unit, so a rise always moves.
        let step = (gap * DEPTH_RISE_BPS as u128 / BPS).max(1) as u64;
        // And never past the next tier's floor. A tenth of an unbounded gap
        // let one reading ten times a floor clear it: liquidity parked for a
        // single crank (a flash loan is enough) lifted a new market from 2x
        // to 5x at once. Capped, a crank buys at most one tier, and the next
        // honest reading takes it back.
        let raised = self.sustained_depth_usd.saturating_add(step);
        self.sustained_depth_usd = match next_depth_floor(self.sustained_depth_usd) {
            Some(floor) => raised.min(floor),
            None => raised,
        };
        self.depth_rise_ts = now;
    }

    pub fn fold(&mut self, spot: u64, now: i64) -> Result<()> {
        require!(spot > 0, PerpError::InvalidOraclePrice);

        if self.observations == 0 {
            self.ewma_price = spot;
            self.first_update_ts = now;
        } else {
            let prev = self.ewma_price as u128;
            let a = self.alpha_bps as u128;
            let folded = (prev * (BPS - a) + (spot as u128) * a) / BPS;

            // At least one unit, so a mark below `BPS / max_move_bps` units
            // (under 100 at a 1% clamp), whose step would round to zero, still
            // follows the pool instead of freezing where it is.
            let max_step = (prev
                .checked_mul(self.max_move_bps as u128)
                .ok_or(PerpError::MathOverflow)?
                / BPS)
                .max(1);
            let clamped = folded.clamp(prev.saturating_sub(max_step), prev + max_step);
            self.ewma_price = u64::try_from(clamped).map_err(|_| PerpError::MathOverflow)?;
        }

        self.last_spot = spot;
        self.last_update_ts = now;
        self.observations = self.observations.saturating_add(1);
        Ok(())
    }

    /// Confidence interval implied by how cheap the pool is to move.
    ///
    /// The shape: confidence is the fraction of `DEPTH_REF_USD` the pool
    /// *cannot* absorb. A pool deep enough to take the reference size without
    /// moving quotes near zero; a pool a tenth that size quotes ten times the
    /// reference band. Unmeasured depth is treated as no depth, which halts
    /// the market rather than quoting into the dark.
    pub fn conf_usd(&self, reference_bps: u16) -> Result<u64> {
        let price = self.ewma_price as u128;
        require!(price > 0, PerpError::InvalidOraclePrice);

        if self.depth_usd == 0 {
            // Wider than any sane `max_conf_bps`, so the market halts.
            return Ok(u64::try_from(price).map_err(|_| PerpError::MathOverflow)?);
        }

        let ratio = DEPTH_REF_USD
            .checked_mul(BPS)
            .ok_or(PerpError::MathOverflow)?
            / (self.depth_usd as u128);
        let conf_bps = ratio
            .checked_mul(reference_bps as u128)
            .ok_or(PerpError::MathOverflow)?
            / BPS;
        let conf = price
            .checked_mul(conf_bps)
            .ok_or(PerpError::MathOverflow)?
            / BPS;
        Ok(u64::try_from(conf.min(price)).map_err(|_| PerpError::MathOverflow)?)
    }
}

/// Who may push marks for a pool's keeper-priced markets. One per pool,
/// written by the pool authority with `set_mark_keeper`.
///
/// Its own account rather than a field on `Pool`, so the pool's layout does
/// not change and a live pool does not have to be recreated to get one.
#[account]
#[derive(InitSpace)]
pub struct MarkKeeper {
    pub bump: u8,
    pub pool: Pubkey,
    /// The key whose `push_mark` is taken as the mark. Default (all zeros)
    /// means no keeper, and every push is refused.
    pub keeper: Pubkey,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn obs() -> Observation {
        Observation {
            bump: 0,
            market: Pubkey::default(),
            source: Pubkey::default(),
            source_kind: SourceKind::RaydiumClmm as u8,
            quote_is_token_0: false,
            ewma_price: 0,
            last_spot: 0,
            last_update_ts: 0,
            first_update_ts: 0,
            observations: 0,
            alpha_bps: 500,
            max_move_bps: 100, // 1% per update
            depth_usd: 0,
            dec_x: 0,
            dec_y: 0,
            unit_exp: 0,
            sustained_depth_usd: 0,
            depth_rise_ts: 0,
            keeper_priced: false,
            _reserved: [0; 11],
        }
    }

    #[test]
    fn a_keeper_push_opens_the_market_at_once() {
        let mut o = obs();
        assert!(!o.is_seasoned());
        o.set_by_keeper(2_000_000, 1_990_000, 5_000).unwrap();
        assert!(o.is_seasoned(), "tradeable from the first push");
        assert!(o.keeper_priced);
        assert_eq!(o.ewma_price, 2_000_000);
        assert_eq!(o.last_spot, 1_990_000);
        assert_eq!(o.last_update_ts, 5_000);
    }

    #[test]
    fn a_keeper_push_takes_the_price_as_given() {
        // No fold and no clamp: the keeper already smoothed it off-chain, and
        // a 1% clamp would leave a real 30% move half an hour behind.
        let mut o = obs();
        o.set_by_keeper(1_000_000, 1_000_000, 0).unwrap();
        o.set_by_keeper(700_000, 700_000, 25).unwrap();
        assert_eq!(o.ewma_price, 700_000);
        assert_eq!(o.observations, MIN_OBSERVATIONS + 1);
        assert!(o.is_seasoned());
    }

    #[test]
    fn a_keeper_push_of_zero_is_refused() {
        let mut o = obs();
        assert!(o.set_by_keeper(0, 1, 0).is_err());
        assert!(!o.keeper_priced);
        assert!(!o.is_seasoned());
    }

    #[test]
    fn the_first_reading_seeds_the_mark() {
        let mut o = obs();
        o.fold(1_000_000, 100).unwrap();
        assert_eq!(o.ewma_price, 1_000_000);
        assert_eq!(o.first_update_ts, 100);
    }

    #[test]
    fn a_single_spike_barely_moves_the_mark() {
        let mut o = obs();
        o.fold(1_000_000, 0).unwrap();
        // Someone buys the pool to 10x for one transaction.
        o.fold(10_000_000, 1).unwrap();
        // The fold alone would put this at 1.45x; the clamp holds it to 1%.
        assert_eq!(o.ewma_price, 1_010_000);
        // And the pool price it disagrees with is on the account for anyone
        // to see while it is happening.
        assert_eq!(o.last_spot, 10_000_000);
    }

    #[test]
    fn walking_the_mark_requires_holding_the_pool_there() {
        let mut o = obs();
        o.fold(1_000_000, 0).unwrap();
        // Hold the pool at 10x and crank repeatedly. Even sustained, the mark
        // compounds at 1% a step -- ~70 updates to double, each one paying the
        // spread back into the pool being manipulated.
        for i in 1..=70 {
            o.fold(10_000_000, i).unwrap();
        }
        assert!(o.ewma_price >= 1_900_000 && o.ewma_price <= 2_100_000,
                "got {}", o.ewma_price);
    }

    #[test]
    fn the_clamp_is_symmetric() {
        let mut o = obs();
        o.fold(1_000_000, 0).unwrap();
        o.fold(1, 1).unwrap();
        assert_eq!(o.ewma_price, 990_000);
    }

    #[test]
    fn a_mark_needs_both_a_count_and_a_window() {
        let mut o = obs();
        // Thirty folds in the same block observes nothing, and the window
        // check is what says so.
        for _ in 0..MIN_OBSERVATIONS {
            o.fold(1_000_000, 0).unwrap();
        }
        assert!(!o.is_seasoned());

        let mut o = obs();
        o.fold(1_000_000, 0).unwrap();
        o.fold(1_000_000, MIN_OBSERVATION_WINDOW_SEC).unwrap();
        assert!(!o.is_seasoned(), "a long window with two readings is not history");

        let mut o = obs();
        for i in 0..MIN_OBSERVATIONS as i64 {
            o.fold(1_000_000, i * 60).unwrap();
        }
        assert!(o.is_seasoned());
    }

    #[test]
    fn a_deep_pool_quotes_tight_and_a_thin_one_quotes_wide() {
        let mut o = obs();
        o.fold(1_000_000, 0).unwrap();

        // Ten times the reference size: a tenth of the reference band.
        o.depth_usd = 100_000_000_000;
        let deep = o.conf_usd(50).unwrap();

        // A tenth of it: ten times the band.
        o.depth_usd = 1_000_000_000;
        let thin = o.conf_usd(50).unwrap();

        assert!(thin > deep * 50, "thin {thin} deep {deep}");
    }

    #[test]
    fn unmeasured_depth_halts_rather_than_quoting_into_the_dark() {
        let mut o = obs();
        o.fold(1_000_000, 0).unwrap();
        o.depth_usd = 0;
        // Confidence equal to the price is far past any sane `max_conf_bps`,
        // so the market stops quoting — which is the right answer when nobody
        // has measured what moving it costs.
        assert_eq!(o.conf_usd(50).unwrap(), o.ewma_price);
    }

    const K: u64 = 1_000 * USD_SCALE as u64; // $1k

    #[test]
    fn sustained_depth_falls_on_the_next_reading() {
        let mut o = obs();
        o.sustained_depth_usd = 100 * K;
        o.track_depth(20 * K, 1);
        assert_eq!(o.sustained_depth_usd, 20 * K, "a thinned pool is thin at once");
    }

    #[test]
    fn sustained_depth_rises_a_tenth_of_the_gap_per_interval() {
        let mut o = obs();
        o.track_depth(100 * K, DEPTH_RISE_MIN_INTERVAL_SEC);
        assert_eq!(o.sustained_depth_usd, 10 * K);
        o.track_depth(100 * K, 2 * DEPTH_RISE_MIN_INTERVAL_SEC);
        assert_eq!(o.sustained_depth_usd, 19 * K);
    }

    #[test]
    fn a_burst_of_cranks_counts_once() {
        // Parked liquidity cranked thirty times inside one interval: the
        // depth it bought counts as a single rise, not thirty, and that rise
        // stops at the next tier's floor however large the reading.
        let mut o = obs();
        let t = DEPTH_RISE_MIN_INTERVAL_SEC;
        for _ in 0..30 {
            o.track_depth(1_000 * K, t);
        }
        assert_eq!(o.sustained_depth_usd, 10 * K);
        assert_eq!(leverage_for_depth(o.sustained_depth_usd), 3);
    }

    #[test]
    fn a_tier_takes_minutes_of_held_depth() {
        let mut o = obs();
        let mut t = 0;
        while leverage_for_depth(o.sustained_depth_usd) < 5 {
            t += DEPTH_RISE_MIN_INTERVAL_SEC;
            o.track_depth(300 * K, t);
        }
        // $300k held against the $250k tier: about seventeen rises.
        assert!(t >= 5 * 60, "5x reached after only {t}s");
    }

    #[test]
    fn a_zero_reading_is_refused_and_does_not_count() {
        let mut o = obs();
        o.fold(1_000_000, 0).unwrap();
        assert!(o.fold(0, 60).is_err());
        assert_eq!(o.observations, 1);
        assert_eq!(o.last_update_ts, 0);
        assert_eq!(o.ewma_price, 1_000_000);
    }

    #[test]
    fn a_later_reading_never_moves_the_start_of_the_window() {
        let mut o = obs();
        o.fold(1_000_000, 100).unwrap();
        o.fold(1_000_000, 700).unwrap();
        o.fold(1_000_000, 1_300).unwrap();
        assert_eq!(o.first_update_ts, 100);
        assert_eq!(o.observations, 3);
    }

    #[test]
    fn a_seeded_mark_never_folds_to_zero() {
        // Folding a mark of 3 toward a reading of 1 rounds down at every step,
        // and still stops at 1 rather than 0.
        let mut o = obs();
        o.max_move_bps = 10_000;
        o.fold(3, 0).unwrap();
        for i in 1..=50 {
            o.fold(1, i).unwrap();
            assert!(o.ewma_price > 0);
        }
        assert_eq!(o.ewma_price, 1);
    }

    #[test]
    fn confidence_at_the_extremes_does_not_overflow() {
        let mut o = obs();
        o.ewma_price = u64::MAX;
        o.depth_usd = 1;
        assert_eq!(o.conf_usd(u16::MAX).unwrap(), u64::MAX, "capped at the price");
        o.depth_usd = u64::MAX;
        assert!(o.conf_usd(u16::MAX).unwrap() < o.ewma_price);
    }

    #[test]
    fn a_deeper_pool_never_quotes_wider() {
        // A sweep, standing in for a Kani harness that did not finish: across
        // marks, reference bands and depths from unmeasured to far past the
        // reference size, confidence never widens as depth grows and never
        // exceeds the mark.
        for price in [1u64, 999, 1_000_000, 190_123_456, u64::MAX] {
            for reference_bps in [0u16, 1, 50, 10_000, u16::MAX] {
                let mut o = obs();
                o.ewma_price = price;
                let mut last = u64::MAX;
                let mut depth = 0u64;
                loop {
                    o.depth_usd = depth;
                    let conf = o.conf_usd(reference_bps).unwrap();
                    assert!(conf <= price && conf <= last, "{price} {reference_bps} {depth}");
                    last = conf;
                    if depth > u64::MAX / 3 {
                        break;
                    }
                    depth = depth * 3 + 1;
                }
            }
        }
    }

    #[test]
    fn depth_does_not_rise_a_second_before_the_interval() {
        let mut o = obs();
        o.track_depth(100 * K, DEPTH_RISE_MIN_INTERVAL_SEC);
        let held = o.sustained_depth_usd;
        o.track_depth(100 * K, 2 * DEPTH_RISE_MIN_INTERVAL_SEC - 1);
        assert_eq!(o.sustained_depth_usd, held);
        o.track_depth(100 * K, 2 * DEPTH_RISE_MIN_INTERVAL_SEC);
        assert!(o.sustained_depth_usd > held);
    }

    // Found while writing the clamp proof: the clamp's step was
    // `prev * max_move_bps / BPS`, rounded down, so a mark below
    // `BPS / max_move_bps` units (under 100 units at a 1% clamp) had a step
    // of zero and could never move again, whatever the pool read. The step
    // is at least one unit now.
    #[test]
    fn a_tiny_mark_still_follows_the_pool() {
        let mut o = obs();
        o.fold(99, 0).unwrap();
        for i in 1..=100 {
            o.fold(1_000, i).unwrap();
        }
        assert!(o.ewma_price > 99, "stuck at {}", o.ewma_price);
    }
}
