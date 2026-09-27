use crate::constants::*;
use crate::errors::PerpError;
use crate::math::bps_of;
use anchor_lang::prelude::*;

/// One wallet's standing with the venue: who referred it, what it is owed, and
/// the points it has earned.
///
/// Points are counted here, on chain, as they are earned, so the tally anyone
/// reads is the one the program kept. There is no off-chain ledger to trust
/// and no snapshot to argue over.
#[account]
#[derive(InitSpace)]
pub struct Trader {
    pub bump: u8,
    pub owner: Pubkey,

    /// Who referred this wallet. `Pubkey::default()` for nobody. Set once,
    /// and only before the wallet's first fill, so a referral cannot be sold
    /// on to whoever offers the best kickback afterwards.
    pub referrer: Pubkey,
    /// This wallet's own code, zero-padded. All zero for none.
    pub code: [u8; REFERRAL_CODE_LEN],
    /// Wallets that have named this one as their referrer.
    pub referral_count: u32,

    /// Everything earned, in `POINTS_SCALE`.
    pub points: u64,
    /// Notional filled, opens and closes both, in `USD_SCALE`.
    pub volume_usd: u64,
    /// Notional filled by this wallet's referees, as far as it has been synced.
    pub referred_volume_usd: u64,
    /// Fees this wallet did not pay because of a discount, for reporting.
    pub fees_saved_usd: u64,

    /// USDC earned from referrals and listings, waiting to be claimed. Held in
    /// the pool's vault under `Pool::rewards_usd`.
    pub rewards_usd: u64,
    pub rewards_claimed_usd: u64,

    /// What this wallet's trading has earned its referrer and not yet been
    /// moved across. Kept here rather than credited on the spot so settlement
    /// never needs the referrer's account: `sync_referral` moves it, and
    /// anybody may call that.
    pub referrer_points_owed: u64,
    pub referrer_rewards_owed: u64,
    pub referrer_volume_owed: u64,

    /// USD this wallet has behind markets, at what it was worth when posted.
    pub backing_usd: u64,
    /// When backing points were last brought up to date.
    pub backing_ts: i64,
    /// LP tokens this wallet minted and has not burned, and what they cost.
    pub lp_shares: u64,
    pub lp_usd: u64,
    pub lp_ts: i64,

    pub created_ts: i64,

    /// Running totals, for the page: never decrease, never paid from.
    /// USDC this wallet has been credited as a referrer and as a deployer.
    pub referral_earned_usd: u64,
    pub listing_earned_usd: u64,
    /// What this wallet's trading has earned its referrer, synced or not.
    pub given_to_referrer_usd: u64,
    pub given_to_referrer_points: u64,
    pub _reserved: [u8; 32],
}

/// The on-chain name behind a referral link: `unwindfi.xyz/?ref=<code>`.
#[account]
#[derive(InitSpace)]
pub struct ReferralCode {
    pub bump: u8,
    pub owner: Pubkey,
    pub code: [u8; REFERRAL_CODE_LEN],
}

/// Checks a code and zero-pads it.
pub fn parse_code(code: &[u8; REFERRAL_CODE_LEN]) -> Result<[u8; REFERRAL_CODE_LEN]> {
    let len = code.iter().position(|b| *b == 0).unwrap_or(REFERRAL_CODE_LEN);
    require!(len >= REFERRAL_CODE_MIN_LEN, PerpError::InvalidReferralCode);
    // Nothing after the first zero, so one name has one spelling and one PDA.
    require!(code[len..].iter().all(|b| *b == 0), PerpError::InvalidReferralCode);
    require!(
        code[..len]
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'_' || *b == b'-'),
        PerpError::InvalidReferralCode
    );
    Ok(*code)
}

/// Who gets a cut of one fee, besides the usual lines.
#[derive(Clone, Copy, Default, Debug, PartialEq, Eq)]
pub struct FeeRoute {
    /// The payer has a referrer.
    pub referrer: bool,
    /// The payer is not the market's deployer, so the deployer is paid.
    pub deployer: bool,
    /// Off the fee before anyone is paid, in bps.
    pub discount_bps: u16,
}

impl FeeRoute {
    /// The discount and the cuts for `owner` trading `market`.
    ///
    /// The deployer's discount and a referee's do not stack; the larger one
    /// applies. A deployer is not paid a share of their own fees, since that
    /// would just be a second discount.
    pub fn for_trade(trader: &Trader, owner: &Pubkey, deployer: &Pubkey) -> Self {
        let is_deployer = owner == deployer && *deployer != Pubkey::default();
        let referred = trader.has_referrer();
        let mut discount_bps = 0;
        if referred {
            discount_bps = REFEREE_DISCOUNT_BPS;
        }
        if is_deployer {
            discount_bps = discount_bps.max(DEPLOYER_DISCOUNT_BPS);
        }
        FeeRoute {
            referrer: referred,
            deployer: !is_deployer && *deployer != Pubkey::default(),
            discount_bps,
        }
    }

    /// `fee` after this route's discount.
    pub fn apply(&self, fee: u64) -> Result<u64> {
        Ok(fee - bps_of(fee, self.discount_bps)?)
    }
}

impl Trader {
    pub fn has_referrer(&self) -> bool {
        self.referrer != Pubkey::default()
    }

    pub fn has_code(&self) -> bool {
        self.code[0] != 0
    }

    /// Credits a fill: the trader's own points and volume, the fee they saved,
    /// and what their referrer is now owed in points.
    pub fn credit_fill(&mut self, filled_usd: u64, saved_usd: u64) -> Result<()> {
        let points = volume_points(filled_usd);
        self.points = self.points.checked_add(points).ok_or(PerpError::MathOverflow)?;
        self.volume_usd = self
            .volume_usd
            .checked_add(filled_usd)
            .ok_or(PerpError::MathOverflow)?;
        self.fees_saved_usd = self.fees_saved_usd.saturating_add(saved_usd);
        if self.has_referrer() {
            let to_referrer = bps_of(points, REFERRER_POINTS_BPS)?;
            self.referrer_points_owed = self
                .referrer_points_owed
                .checked_add(to_referrer)
                .ok_or(PerpError::MathOverflow)?;
            self.given_to_referrer_points = self.given_to_referrer_points.saturating_add(to_referrer);
            self.referrer_volume_owed = self
                .referrer_volume_owed
                .checked_add(filled_usd)
                .ok_or(PerpError::MathOverflow)?;
        }
        Ok(())
    }

    /// Brings backing points up to `now` at the backing held since the last
    /// update. Called before the backing changes, so each stretch of time is
    /// paid at the amount that was actually there.
    pub fn accrue_backing(&mut self, now: i64) -> Result<()> {
        let earned = stake_points(self.backing_usd, BACKING_POINTS_PER_USD_DAY, self.backing_ts, now);
        self.points = self.points.checked_add(earned).ok_or(PerpError::MathOverflow)?;
        self.backing_ts = now;
        Ok(())
    }

    /// Brings LP points up to `now`.
    ///
    /// LP tokens can be moved to another wallet without the program seeing it,
    /// so the stake paid on is what this wallet minted, cut down to what it
    /// still holds. Tokens sent away stop earning here at the next update, and
    /// tokens received from someone else never start.
    pub fn accrue_lp(&mut self, lp_balance: u64, now: i64) -> Result<()> {
        let held = self.lp_shares.min(lp_balance);
        let stake_usd = if self.lp_shares == 0 {
            0
        } else {
            ((self.lp_usd as u128) * (held as u128) / (self.lp_shares as u128)) as u64
        };
        let earned = stake_points(stake_usd, LP_POINTS_PER_USD_DAY, self.lp_ts, now);
        self.points = self.points.checked_add(earned).ok_or(PerpError::MathOverflow)?;
        self.lp_ts = now;
        // What left the wallet leaves the stake for good, so that sending
        // tokens away and back cannot restore it.
        if held < self.lp_shares {
            self.lp_usd = ((self.lp_usd as u128) * (held as u128) / (self.lp_shares as u128)) as u64;
            self.lp_shares = held;
        }
        Ok(())
    }

    pub fn add_lp(&mut self, shares: u64, usd: u64) -> Result<()> {
        self.lp_shares = self.lp_shares.checked_add(shares).ok_or(PerpError::MathOverflow)?;
        self.lp_usd = self.lp_usd.checked_add(usd).ok_or(PerpError::MathOverflow)?;
        Ok(())
    }

    /// Burns `shares` out of the stake, taking a proportional part of its cost.
    /// Tokens this wallet did not mint are not in the stake and take nothing.
    pub fn remove_lp(&mut self, shares: u64) {
        if self.lp_shares == 0 {
            return;
        }
        let out = shares.min(self.lp_shares);
        let usd = ((self.lp_usd as u128) * (out as u128) / (self.lp_shares as u128)) as u64;
        self.lp_usd -= usd;
        self.lp_shares -= out;
    }
}

/// Points for `filled_usd` of notional: one per dollar.
pub fn volume_points(filled_usd: u64) -> u64 {
    // `USD_SCALE` and `POINTS_SCALE` are the same, so this is the identity.
    ((filled_usd as u128) * POINTS_SCALE / USD_SCALE) as u64
}

/// Points for holding `usd` from `since` to `now` at `per_usd_day`.
pub fn stake_points(usd: u64, per_usd_day: u128, since: i64, now: i64) -> u64 {
    if since <= 0 || now <= since || usd == 0 {
        return 0;
    }
    let secs = (now - since) as u128;
    let p = (usd as u128) * per_usd_day * secs * POINTS_SCALE / USD_SCALE / SECONDS_PER_DAY;
    u64::try_from(p).unwrap_or(u64::MAX)
}

/// Moves the referral and listing cuts of a fee out of the protocol's line.
///
/// The fee has already been booked, with the protocol's share of it sitting in
/// `protocol_fees_usd`. This takes the rewards out of that and nothing else:
/// each is capped at the protocol's cut of this fee and at what the line
/// holds, so the LPs, the chain and the fund are paid exactly what they would
/// have been with no referral at all. Returns `(to_referrer, to_deployer)`.
pub fn carve_rewards(
    protocol_fees_usd: &mut u64,
    rewards_usd: &mut u64,
    protocol_share_bps: u16,
    fee_usd: u64,
    route: &FeeRoute,
) -> Result<(u64, u64)> {
    let mut room = bps_of(fee_usd, protocol_share_bps)?.min(*protocol_fees_usd);
    let to_referrer = if route.referrer {
        bps_of(fee_usd, REFERRER_FEE_SHARE_BPS)?.min(room)
    } else {
        0
    };
    room -= to_referrer;
    let to_deployer = if route.deployer {
        bps_of(fee_usd, DEPLOYER_FEE_SHARE_BPS)?.min(room)
    } else {
        0
    };
    let total = to_referrer + to_deployer;
    *protocol_fees_usd -= total;
    *rewards_usd = rewards_usd.checked_add(total).ok_or(PerpError::MathOverflow)?;
    Ok((to_referrer, to_deployer))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn trader() -> Trader {
        Trader {
            bump: 0,
            owner: Pubkey::new_unique(),
            referrer: Pubkey::default(),
            code: [0; REFERRAL_CODE_LEN],
            referral_count: 0,
            points: 0,
            volume_usd: 0,
            referred_volume_usd: 0,
            fees_saved_usd: 0,
            rewards_usd: 0,
            rewards_claimed_usd: 0,
            referrer_points_owed: 0,
            referrer_rewards_owed: 0,
            referrer_volume_owed: 0,
            backing_usd: 0,
            backing_ts: 0,
            lp_shares: 0,
            lp_usd: 0,
            lp_ts: 0,
            created_ts: 0,
            referral_earned_usd: 0,
            listing_earned_usd: 0,
            given_to_referrer_usd: 0,
            given_to_referrer_points: 0,
            _reserved: [0; 32],
        }
    }

    fn code(s: &str) -> [u8; REFERRAL_CODE_LEN] {
        let mut c = [0u8; REFERRAL_CODE_LEN];
        c[..s.len()].copy_from_slice(s.as_bytes());
        c
    }

    #[test]
    fn codes_are_short_lowercase_names() {
        assert!(parse_code(&code("pragyan")).is_ok());
        assert!(parse_code(&code("a_b-9")).is_ok());
        assert!(parse_code(&code("sixteen-chars-ok")).is_ok());
        assert!(parse_code(&code("ab")).is_err());
        assert!(parse_code(&code("Upper")).is_err());
        assert!(parse_code(&code("has space")).is_err());
        let mut gap = code("abc");
        gap[5] = b'x';
        assert!(parse_code(&gap).is_err(), "one name, one spelling");
    }

    #[test]
    fn nobody_referred_pays_full_fee_and_the_deployer_is_paid() {
        let t = trader();
        let r = FeeRoute::for_trade(&t, &t.owner, &Pubkey::new_unique());
        assert_eq!(r, FeeRoute { referrer: false, deployer: true, discount_bps: 0 });
        assert_eq!(r.apply(1_000).unwrap(), 1_000);
    }

    #[test]
    fn a_referee_pays_ten_percent_less() {
        let mut t = trader();
        t.referrer = Pubkey::new_unique();
        let r = FeeRoute::for_trade(&t, &t.owner, &Pubkey::new_unique());
        assert_eq!(r.apply(1_000).unwrap(), 900);
        assert!(r.referrer && r.deployer);
    }

    #[test]
    fn a_deployer_pays_half_on_their_own_market_and_takes_no_share_of_it() {
        let mut t = trader();
        t.referrer = Pubkey::new_unique();
        let owner = t.owner;
        let r = FeeRoute::for_trade(&t, &owner, &owner);
        // Discounts do not stack: the larger wins.
        assert_eq!(r.discount_bps, DEPLOYER_DISCOUNT_BPS);
        assert_eq!(r.apply(1_000).unwrap(), 500);
        assert!(!r.deployer);
        assert!(r.referrer);
    }

    #[test]
    fn rewards_come_only_out_of_the_protocol_cut() {
        let route = FeeRoute { referrer: true, deployer: true, discount_bps: 0 };
        let (mut protocol, mut rewards) = (200u64, 0u64);
        // A fee of 1,000 with a 20% protocol share: 200 to the protocol, of
        // which 100 goes to the referrer and 100 to the deployer.
        let (r, d) = carve_rewards(&mut protocol, &mut rewards, 2_000, 1_000, &route).unwrap();
        assert_eq!((r, d, protocol, rewards), (100, 100, 0, 200));

        // With a 10% protocol share there is only room for the referrer.
        let (mut protocol, mut rewards) = (100u64, 0u64);
        let (r, d) = carve_rewards(&mut protocol, &mut rewards, 1_000, 1_000, &route).unwrap();
        assert_eq!((r, d, protocol, rewards), (100, 0, 0, 100));

        // No protocol share, no rewards.
        let (mut protocol, mut rewards) = (0u64, 0u64);
        assert_eq!(carve_rewards(&mut protocol, &mut rewards, 0, 1_000, &route).unwrap(), (0, 0));
    }

    #[test]
    fn a_fill_credits_the_trader_and_owes_the_referrer_a_tenth() {
        let mut t = trader();
        t.credit_fill(1_000_000_000, 0).unwrap();
        assert_eq!(t.points, 1_000_000_000, "1,000 points for $1,000");
        assert_eq!(t.referrer_points_owed, 0);

        t.referrer = Pubkey::new_unique();
        t.credit_fill(1_000_000_000, 100_000).unwrap();
        assert_eq!(t.points, 2_000_000_000, "the referee keeps all of theirs");
        assert_eq!(t.referrer_points_owed, 100_000_000);
        assert_eq!(t.referrer_volume_owed, 1_000_000_000);
        assert_eq!(t.fees_saved_usd, 100_000);
    }

    #[test]
    fn backing_earns_two_points_a_dollar_a_day() {
        let mut t = trader();
        t.backing_ts = 1_000;
        t.backing_usd = 500_000_000; // $500
        t.accrue_backing(1_000 + 86_400).unwrap();
        assert_eq!(t.points, 1_000_000_000);
        assert_eq!(t.backing_ts, 1_000 + 86_400);
    }

    #[test]
    fn lp_tokens_sent_away_stop_earning_and_do_not_come_back() {
        let mut t = trader();
        t.lp_ts = 1;
        t.add_lp(1_000, 1_000_000_000).unwrap();
        // Half the tokens left the wallet before this update.
        t.accrue_lp(500, 1 + 86_400).unwrap();
        assert_eq!(t.points, 500_000_000, "paid on the half still held");
        assert_eq!((t.lp_shares, t.lp_usd), (500, 500_000_000));
        // Getting them back later does not restore the stake.
        t.accrue_lp(1_000, 1 + 2 * 86_400).unwrap();
        assert_eq!(t.points, 1_000_000_000);
        assert_eq!(t.lp_shares, 500);
    }

    #[test]
    fn burning_tokens_nobody_minted_here_takes_nothing() {
        let mut t = trader();
        t.add_lp(100, 1_000).unwrap();
        t.remove_lp(40);
        assert_eq!((t.lp_shares, t.lp_usd), (60, 600));
        t.remove_lp(1_000);
        assert_eq!((t.lp_shares, t.lp_usd), (0, 0));
        t.remove_lp(5);
        assert_eq!((t.lp_shares, t.lp_usd), (0, 0));
    }

    #[test]
    fn no_time_no_points() {
        assert_eq!(stake_points(1_000_000, 1, 0, 100), 0, "never started");
        assert_eq!(stake_points(1_000_000, 1, 100, 100), 0);
        assert_eq!(stake_points(1_000_000, 1, 100, 50), 0, "clock went backwards");
    }
}
