use crate::constants::*;
use crate::errors::PerpError;
use anchor_lang::prelude::*;

/// The single LP pool that is the counterparty to every position in every
/// market. LPs deposit USDC and are short whatever the traders are net long.
#[account]
#[derive(InitSpace)]
pub struct Pool {
    pub bump: u8,
    pub vault_bump: u8,
    pub lp_mint_bump: u8,

    pub authority: Pubkey,
    pub pending_authority: Pubkey,
    pub usdc_mint: Pubkey,
    pub usdc_vault: Pubkey,
    pub lp_mint: Pubkey,

    pub num_markets: u16,

    /// LP-owned USDC. Grows with trader losses and fees, shrinks with payouts.
    pub liquidity_usd: u64,
    /// Portion of `liquidity_usd` earmarked against open positions' potential
    /// profit. LPs cannot withdraw it and new positions cannot reserve it twice.
    pub locked_usd: u64,
    /// Trader collateral sitting in the same vault. It is *not* LP money and is
    /// excluded from AUM; tracking it separately is what keeps a withdrawal from
    /// paying an LP out of a trader's margin.
    pub trader_collateral_usd: u64,
    /// Accrued protocol revenue, withdrawable only by the authority.
    pub protocol_fees_usd: u64,

    pub add_liquidity_fee_bps: u16,
    pub remove_liquidity_fee_bps: u16,
    /// Share of trading fees that goes to the protocol rather than to LPs.
    pub protocol_fee_share_bps: u16,
    /// Ceiling on `locked_usd / liquidity_usd`.
    pub max_utilization_bps: u16,

    /// Capital held against the pool falling short on a payout.
    ///
    /// The LPs are the counterparty to every trade, so a position that gaps
    /// further than `pnl_reserve_bps` covers leaves the pool owing more than it
    /// set aside. Without a buffer the whole shortfall lands on LPs — and worse,
    /// the close reverts, trapping a trader in a winning position. This is drawn
    /// down before either happens.
    pub insurance_usd: u64,
    /// Share of trading fees routed to the fund rather than to LPs.
    pub insurance_fee_share_bps: u16,

    /// The program whose accounts this pool will accept prices from.
    ///
    /// Written once, at `initialize_pool`, and deliberately given no setter.
    /// It was a compile-time constant, which made pointing at a different
    /// receiver a recompile rather than the configuration the code claimed it
    /// was — and left no way to run a stand-in oracle on a test cluster where
    /// the real receiver's address is already taken.
    ///
    /// Making it settable at all is a real loss: what was impossible for anyone
    /// is now fixed by whoever initialises the pool. Write-once is what keeps
    /// the rest — a live pool cannot be repointed at an oracle someone controls,
    /// and the address it trusts is on the account for anyone to read.
    pub pyth_receiver: Pubkey,

    /// Collateral sitting in the vault against unfilled limit orders.
    ///
    /// Held in the same vault as everything else but owned by neither the LPs
    /// nor any position yet, so it is tracked apart for the same reason
    /// `trader_collateral_usd` is: without it, an LP withdrawal could be paid
    /// out of money escrowed for an order that has not filled.
    pub escrow_usd: u64,

    /// Where the chain's share of revenue goes.
    ///
    /// Write-once at `initialize_pool`, like `pyth_receiver`, and for the same
    /// reason: a destination the authority can change is a destination the
    /// authority controls, and the point of this field is that they do not.
    pub chain_fee_destination: Pubkey,
    /// Accrued chain revenue, withdrawable by anyone but only to
    /// `chain_fee_destination`.
    pub chain_fees_usd: u64,

    pub paused: bool,
    // Shrunk as fields were taken from it, so the account layout and size are
    // unchanged and pools created before the fund existed still deserialise —
    // reserved bytes were zero, which is an empty fund.
    /// Backing posted across every market, held in the vault and owed back to
    /// the backers who posted it. Tracked here for the same reason
    /// `escrow_usd` is: the vault balance has to reconcile against something,
    /// and money belonging to somebody else must never read as liquidity.
    pub backing_usd: u64,

    /// Tokens other than USDC that backing may be held in, each a `Custody`
    /// numbered from zero in the order it was added.
    pub num_custodies: u8,

    /// Markets that currently carry open interest. An LP deposit or withdrawal
    /// has to price every one of them, and only them: a market nobody holds a
    /// position in owes nothing whatever its price. Counting them here, rather
    /// than asking for every listed market, is what keeps permissionless
    /// listing from growing the account list until those instructions no
    /// longer fit in a transaction. Moves only when a market's open interest
    /// crosses zero, in `book_open` and `apply_settlement_to_pool`.
    pub markets_with_oi: u16,

    /// USDC owed to referrers and market deployers, held in the vault until
    /// they claim it. Carved out of `protocol_fees_usd` as fees are paid (see
    /// `carve_rewards`), so it is never LP money and never reads as such.
    pub rewards_usd: u64,

    pub _reserved: [u8; 3],
    // Note: the account grew when the chain-fee fields were added. Pools are
    // recreated rather than migrated — there is no deployment this breaks.
}

impl Pool {
    pub fn free_liquidity_usd(&self) -> u64 {
        self.liquidity_usd.saturating_sub(self.locked_usd)
    }

    pub fn utilization_bps(&self) -> u16 {
        if self.liquidity_usd == 0 {
            return BPS as u16;
        }
        let u = (self.locked_usd as u128) * BPS / (self.liquidity_usd as u128);
        u.min(BPS) as u16
    }

    /// What the LPs own: their USDC and in-kind tokens together, less what
    /// traders are up. Trader profit is a claim on both, so it is taken from
    /// the sum. Flooring the USDC first and adding the tokens after counted
    /// the tokens in full while traders' profit went partly uncovered, and a
    /// deposit priced against that paid for a hole it then had to fill.
    pub fn aum_with_in_kind_usd(&self, global_trader_pnl_usd: i64, in_kind_usd: u64) -> u64 {
        // In i128, clamped once at the end: saturating the sum of USDC and
        // in-kind before taking the profit off would lose the part of a
        // deposit that went past u64::MAX.
        let value =
            self.liquidity_usd as i128 + in_kind_usd as i128 - global_trader_pnl_usd as i128;
        value.clamp(0, u64::MAX as i128) as u64
    }

    /// Moves USDC nobody owns out of reach of the next depositor. With no LP
    /// shares outstanding, what is left in liquidity beyond the capital
    /// reserved for open positions (a last withdrawal's fee, a trader's later
    /// loss) belongs to no one, and a first deposit would otherwise own it.
    /// It goes to the insurance fund, which exists for the pool as a whole.
    pub fn sweep_ownerless_liquidity(&mut self) -> Result<u64> {
        let free = self.liquidity_usd.saturating_sub(self.locked_usd);
        self.liquidity_usd -= free;
        self.insurance_usd = self
            .insurance_usd
            .checked_add(free)
            .ok_or(PerpError::MathOverflow)?;
        Ok(free)
    }

    /// Assets under management: LP capital less what traders are currently up.
    ///
    /// Trader profit is a liability of the pool the moment it exists, not when
    /// it is withdrawn, so LP shares must be priced against it. Otherwise a
    /// deposit made while traders are deep in profit buys into a loss that has
    /// already happened. LP shares are priced by `aum_with_in_kind_usd`, which
    /// counts the in-kind tokens too.
    pub fn aum_usd(&self, global_trader_pnl_usd: i64) -> u64 {
        if global_trader_pnl_usd >= 0 {
            self.liquidity_usd
                .saturating_sub(global_trader_pnl_usd as u64)
        } else {
            self.liquidity_usd
                .saturating_add(global_trader_pnl_usd.unsigned_abs())
        }
    }

    /// How much more the pool can lock before its utilization cap binds.
    ///
    /// Rounds down, the conservative way, so a quote sized from it can always
    /// be locked in full.
    pub fn lock_headroom_usd(&self) -> u64 {
        let allowed = (self.max_utilization_bps as u128) * (self.liquidity_usd as u128) / BPS;
        u64::try_from(allowed)
            .unwrap_or(u64::MAX)
            .min(self.liquidity_usd)
            .saturating_sub(self.locked_usd)
    }

    pub fn lock(&mut self, amount: u64) -> Result<()> {
        self.check_lock(amount)?;
        self.locked_usd += amount;
        Ok(())
    }

    /// `lock` without the write, so a settlement can find out whether an open
    /// fits before it has touched anything.
    pub fn check_lock(&self, amount: u64) -> Result<()> {
        let new_locked = self
            .locked_usd
            .checked_add(amount)
            .ok_or(PerpError::MathOverflow)?;
        require!(new_locked <= self.liquidity_usd, PerpError::InsufficientLiquidity);
        // Compared by cross-multiplication rather than by computing a bps ratio:
        // the division truncates, which would silently allow up to one part in
        // ten thousand of the pool to be locked past the cap.
        let locked_scaled = (new_locked as u128)
            .checked_mul(BPS)
            .ok_or(PerpError::MathOverflow)?;
        let allowed = (self.max_utilization_bps as u128)
            .checked_mul(self.liquidity_usd as u128)
            .ok_or(PerpError::MathOverflow)?;
        require!(locked_scaled <= allowed, PerpError::UtilizationCapExceeded);
        Ok(())
    }

    /// Pays `amount` out of LP liquidity, drawing on the insurance fund for
    /// whatever liquidity cannot cover.
    ///
    /// Returns what the fund had to contribute, which the caller records: a
    /// draw is the signal that the reserve was too thin for what the market
    /// actually did, and it should not pass silently.
    pub fn pay_out(&mut self, amount: u64) -> Result<u64> {
        if amount <= self.liquidity_usd {
            self.liquidity_usd -= amount;
            return Ok(0);
        }
        let shortfall = amount - self.liquidity_usd;
        require!(shortfall <= self.insurance_usd, PerpError::InsufficientLiquidity);
        self.liquidity_usd = 0;
        self.insurance_usd -= shortfall;
        Ok(shortfall)
    }

    pub fn unlock(&mut self, amount: u64) {
        self.locked_usd = self.locked_usd.saturating_sub(amount);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pool() -> Pool {
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
            liquidity_usd: 1_000_000_000_000, // $1,000,000
            locked_usd: 0,
            trader_collateral_usd: 0,
            protocol_fees_usd: 0,
            insurance_usd: 0,
            insurance_fee_share_bps: 1_000,
            escrow_usd: 0,
            chain_fee_destination: Pubkey::default(),
            chain_fees_usd: 0,
            pyth_receiver: crate::oracle::PYTH_RECEIVER_ID,
            add_liquidity_fee_bps: 0,
            remove_liquidity_fee_bps: 0,
            protocol_fee_share_bps: 2_000,
            max_utilization_bps: 8_000,
            paused: false,
            backing_usd: 0,
            num_custodies: 0,
            markets_with_oi: 0,
            rewards_usd: 0,
            _reserved: [0; 3],
        }
    }

    #[test]
    fn aum_nets_out_what_traders_are_owed() {
        let p = pool();
        // Traders up $100k: the pool is worth that much less right now.
        assert_eq!(p.aum_usd(100_000_000_000), 900_000_000_000);
        // Traders down $100k: the pool is worth that much more.
        assert_eq!(p.aum_usd(-100_000_000_000), 1_100_000_000_000);
    }

    #[test]
    fn locking_respects_the_utilization_cap() {
        let mut p = pool();
        // 80% of $1m is fine; one dollar past it is not. The cap is exact --
        // a truncating bps comparison would wave this second lock through.
        assert!(p.lock(800_000_000_000).is_ok());
        assert!(p.lock(1_000_000).is_err());
        assert_eq!(p.locked_usd, 800_000_000_000);
    }

    #[test]
    fn free_liquidity_excludes_locked_capital() {
        let mut p = pool();
        p.lock(400_000_000_000).unwrap();
        assert_eq!(p.free_liquidity_usd(), 600_000_000_000);
        assert_eq!(p.utilization_bps(), 4_000);
    }

    #[test]
    fn a_payout_within_liquidity_never_touches_the_fund() {
        let mut p = pool();
        p.insurance_usd = 50_000_000;
        assert_eq!(p.pay_out(400_000_000_000).unwrap(), 0);
        assert_eq!(p.insurance_usd, 50_000_000);
        assert_eq!(p.liquidity_usd, 600_000_000_000);
    }

    #[test]
    fn the_fund_covers_what_liquidity_cannot() {
        let mut p = pool();
        p.liquidity_usd = 1_000_000;   // $1
        p.insurance_usd = 10_000_000;  // $10
        // A $6 payout against $1 of liquidity: the fund covers the other $5.
        assert_eq!(p.pay_out(6_000_000).unwrap(), 5_000_000);
        assert_eq!(p.liquidity_usd, 0);
        assert_eq!(p.insurance_usd, 5_000_000);
    }

    #[test]
    fn a_payout_past_both_is_refused_rather_than_half_paid() {
        let mut p = pool();
        p.liquidity_usd = 1_000_000;
        p.insurance_usd = 1_000_000;
        // Better to fail the close than to hand a trader part of what they are
        // owed and call the position settled.
        assert!(p.pay_out(5_000_000).is_err());
        assert_eq!(p.liquidity_usd, 1_000_000, "a refused payout changes nothing");
        assert_eq!(p.insurance_usd, 1_000_000);
    }

    #[test]
    fn the_oracle_a_pool_trusts_is_readable_from_the_account() {
        // The point of moving this off a compile-time constant: what the pool
        // will accept prices from is now on the account, not in the binary.
        let mut p = pool();
        let mine = Pubkey::new_unique();
        p.pyth_receiver = mine;
        assert_eq!(p.pyth_receiver, mine);
    }

    #[test]
    fn escrow_is_not_lp_money() {
        let mut p = pool();
        p.escrow_usd = 250_000_000;
        // AUM is LP capital net of trader profit; escrow belongs to neither and
        // must not inflate it.
        assert_eq!(p.aum_usd(0), p.liquidity_usd);
    }

    #[test]
    fn unlock_is_saturating() {
        let mut p = pool();
        p.lock(1_000_000).unwrap();
        p.unlock(5_000_000);
        assert_eq!(p.locked_usd, 0);
    }

    #[test]
    fn a_pool_can_lock_exactly_its_headroom() {
        let mut p = pool();
        p.lock(1).unwrap();
        let room = p.lock_headroom_usd();
        assert_eq!(room, 800_000_000_000 - 1);
        p.lock(room).unwrap();
        assert!(p.lock(1).is_err());
        assert_eq!(p.lock_headroom_usd(), 0);
    }

    #[test]
    fn headroom_rounds_down_on_an_odd_pool() {
        let mut p = pool();
        p.liquidity_usd = 3;
        p.max_utilization_bps = 5_000;
        // Half of 3 is 1.5; only 1 can be locked, and the headroom says so.
        assert_eq!(p.lock_headroom_usd(), 1);
        p.lock(1).unwrap();
        assert!(p.lock(1).is_err());
    }

    #[test]
    fn check_lock_writes_nothing() {
        let p = pool();
        assert!(p.check_lock(1_000_000).is_ok());
        assert!(p.check_lock(900_000_000_000).is_err());
        assert_eq!(p.locked_usd, 0);
    }

    #[test]
    fn aum_saturates_rather_than_wrapping() {
        let mut p = pool();
        p.liquidity_usd = 5;
        assert_eq!(p.aum_usd(i64::MAX), 0);
        assert_eq!(p.aum_usd(i64::MIN), 5 + (i64::MAX as u64) + 1);
        p.liquidity_usd = u64::MAX;
        assert_eq!(p.aum_usd(-1), u64::MAX);
    }

    #[test]
    fn an_empty_pool_reads_fully_utilised() {
        let mut p = pool();
        p.liquidity_usd = 0;
        assert_eq!(p.utilization_bps(), 10_000);
        assert_eq!(p.lock_headroom_usd(), 0);
        assert!(p.lock(1).is_err());
    }

    #[test]
    fn a_payout_of_liquidity_plus_the_fund_empties_both() {
        let mut p = pool();
        p.liquidity_usd = 4;
        p.insurance_usd = 6;
        assert_eq!(p.pay_out(10).unwrap(), 6);
        assert_eq!((p.liquidity_usd, p.insurance_usd), (0, 0));
    }

    // Caps for the bounded sweeps below: zero, the extremes, the configured
    // 80%, and ones that do not divide evenly.
    const CAPS: [u16; 6] = [0, 1, 3_333, 8_000, 9_999, 10_000];

    #[test]
    fn every_lock_within_headroom_succeeds_and_stays_under_the_cap() {
        for cap in CAPS {
            for liq in 0..=60u64 {
                let limit = cap as u128 * liq as u128;
                for locked in (0..=liq).filter(|&l| l as u128 * BPS <= limit) {
                    let mut p = pool();
                    p.liquidity_usd = liq;
                    p.max_utilization_bps = cap;
                    p.locked_usd = locked;
                    let room = p.lock_headroom_usd();
                    for amount in 0..=room {
                        let mut q = pool();
                        q.liquidity_usd = liq;
                        q.max_utilization_bps = cap;
                        q.locked_usd = locked;
                        q.lock(amount).unwrap();
                        assert!(q.locked_usd <= liq);
                        assert!(q.locked_usd as u128 * BPS <= limit);
                    }
                }
            }
        }
    }

    #[test]
    fn every_lock_that_succeeds_stays_under_the_cap_and_check_agrees() {
        for cap in CAPS {
            for liq in 0..=40u64 {
                for locked in 0..=40u64 {
                    for amount in 0..=40u64 {
                        let mut p = pool();
                        p.liquidity_usd = liq;
                        p.max_utilization_bps = cap;
                        p.locked_usd = locked;
                        let asked = p.check_lock(amount).is_ok();
                        let done = p.lock(amount).is_ok();
                        assert_eq!(asked, done);
                        if done {
                            assert!(p.locked_usd <= liq);
                            assert!(p.locked_usd as u128 * BPS <= cap as u128 * liq as u128);
                            if liq > 0 {
                                assert!(p.utilization_bps() <= cap);
                            }
                        } else {
                            assert_eq!(p.locked_usd, locked);
                        }
                    }
                }
            }
        }
    }
}
