/// Fixed-point scale for every USD-denominated quantity (matches USDC decimals).
pub const USD_SCALE: u128 = 1_000_000;

/// Fixed-point scale for oracle prices, in USD per share.
pub const PRICE_SCALE: u128 = 1_000_000;

/// Basis points denominator.
pub const BPS: u128 = 10_000;

/// Precision of the cumulative funding / borrow indices. These are stored per
/// 1 USD of position size, so they need far more precision than the USD amounts
/// themselves: an hourly rate of 1bp on 1 USD is 1e-4 USD.
pub const FUNDING_SCALE: i128 = 1_000_000_000_000;

/// Precision of the Token-2022 `ScaledUiAmount` multiplier that xStocks use to
/// express dividends and splits.
pub const MULTIPLIER_SCALE: u128 = 1_000_000_000;

pub const SECONDS_PER_HOUR: i64 = 3_600;

/// Ceiling on a single funding accrual, so a crank that has not been called for
/// a long time (or a clock that jumps) cannot wipe out positions in one step.
pub const MAX_FUNDING_ACCRUAL_SECONDS: i64 = 8 * 3_600;

pub const LP_DECIMALS: u8 = 6;

/// Seeds
pub const POOL_SEED: &[u8] = b"pool";
pub const POOL_VAULT_SEED: &[u8] = b"pool_vault";
pub const LP_MINT_SEED: &[u8] = b"lp_mint";
pub const MARKET_SEED: &[u8] = b"market";
pub const POSITION_SEED: &[u8] = b"position";
pub const ORDER_SEED: &[u8] = b"order";
pub const OBSERVATION_SEED: &[u8] = b"observation";
pub const MARK_KEEPER_SEED: &[u8] = b"mark_keeper";
pub const BACKING_SEED: &[u8] = b"backing";
pub const BATCH_SEED: &[u8] = b"batch";
pub const CUSTODY_SEED: &[u8] = b"custody";
pub const CUSTODY_VAULT_SEED: &[u8] = b"custody_vault";
pub const BACKING_BOOK_SEED: &[u8] = b"backing_book";
pub const TRADER_SEED: &[u8] = b"trader";
pub const REFERRAL_CODE_SEED: &[u8] = b"referral_code";

/// Share of every trading fee routed back to the chain.
///
/// A constant with no setter, deliberately. The Foundation's ask is that
/// application revenue is "structurally routed back to the chain, preferably
/// set at protocol level from launch" — a governance-adjustable share is
/// neither structural nor set at launch, because the first thing a protocol
/// under pressure does is turn it down. Changing this requires a new program
/// build, which is a thing anyone can see coming.
pub const CHAIN_FEE_SHARE_BPS: u16 = 1_000; // 10% of fees

/// Share of a backed market's trading fees paid to its backers, in bps.
///
/// Taken from the LPs' part of each fee, after the protocol, chain and
/// insurance cuts, and only while the market has backers at all. Backing
/// stands in front of LP capital on every loss the market makes, so it is
/// paid in front of LP capital on the fees the market earns; without this a
/// backer is selling first-loss protection for nothing, and nobody does that
/// for long.
///
/// Paid by crediting `Market::backing_usd` rather than to any account, so the
/// fee raises what every backing share is worth and compounds until the
/// backer leaves through `unback_market`. It does not raise the market's loss
/// budget: fee income is the backers' to withdraw, and letting it widen the
/// allowance would let a busy market underwrite itself with money nobody
/// decided to put at risk.
///
/// Mirrored in `scripts/listing-policy.ts` as `BACKER_FEE_SHARE_BPS`.
pub const BACKER_FEE_SHARE_BPS: u16 = 5_000; // half of what the LPs would take

/// Confidence a pool holding exactly `DEPTH_REF_USD` of depth is quoted at.
///
/// The anchor for the depth-derived confidence interval: a pool that can
/// absorb the reference size gets this band, and one a tenth as deep gets ten
/// times it. Everything downstream — the spread, the halt — already keys off
/// confidence, so this is the single number that maps liquidity onto risk.
pub const DEPTH_CONF_REFERENCE_BPS: u16 = 50;

/// Liquidity below this leaves the pool in a degenerate state where LP share
/// pricing is meaningless, so the first deposit must clear it and withdrawals
/// may not cross back under it while any position is open.
pub const MIN_POOL_LIQUIDITY_USD: u64 = 1_000_000; // 1 USDC

/// How far through the index a fired stop or take-profit will reach for a
/// clearing price.
///
/// A trigger says when to leave, not at what price, so the order it becomes
/// still needs a limit. Setting that limit at the trigger itself would be the
/// strictest reading and the least useful one: a stop exists for the gap it is
/// meant to catch, and an order that refuses to fill below its own trigger is
/// an order that misses exactly the move it was placed for. Wide enough to
/// cross the pool's quote in an ordinary market, narrow enough that a trader
/// who is stopped out during a dislocation is not filled at an arbitrary
/// price.
pub const TRIGGER_SLIPPAGE_BPS: u128 = 100; // 1%

/// Bounds on a market listed by anyone other than the pool's authority.
///
/// Listing is permissionless, so the listing's parameters are the lister's
/// choice, and several of them are not a matter of taste: a long staleness
/// window lets a position be opened against a price that has already moved, a
/// wide confidence tolerance does the same through a noisy feed, a thin PnL
/// reserve lets winners out-run what the pool locked for them, and a spread or
/// fee of zero hands the pool's edge to whoever trades first. These are the
/// values the site lists with, enforced here so that a transaction built by
/// hand gets no more than the site would give it. The authority can still
/// tune any market afterwards through `update_market_params`.
/// The most any listed market may carry, reached only on depth: see
/// `DEPTH_LEVERAGE_TIERS`. A market priced off an AMM gets what its pool's
/// sustained depth supports, never more than this and never more than the
/// market's own `max_leverage_bps`.
pub const LISTING_MAX_LEVERAGE_BPS: u32 = 50_000; // 5x

/// Leverage a pool's sustained depth supports: `(depth_usd at least, x)`.
///
/// Depth is what it costs to move the tracked pool one percent. Higher
/// leverage means a smaller move reaches a liquidation, and the move is what
/// an attacker pays for, so the cheaper a pool is to push the less leverage a
/// market on it may carry. The lowest tier applies from the first reading.
pub const DEPTH_LEVERAGE_TIERS: [(u64, u8); 4] = [
    (0, 2),
    (10_000 * USD_SCALE as u64, 3),
    (50_000 * USD_SCALE as u64, 4),
    (250_000 * USD_SCALE as u64, 5),
];

/// How far sustained depth closes the gap to a higher reading, bps.
pub const DEPTH_RISE_BPS: u64 = 1_000; // 10%
/// Least time between two rises in sustained depth.
///
/// `observe` is permissionless and can be cranked as often as anyone likes, so
/// a rise per reading would let a burst of cranks count one slot of parked
/// liquidity thirty times. Rising at most this often makes a tier cost depth
/// held for minutes; a fall still lands on the very next reading.
pub const DEPTH_RISE_MIN_INTERVAL_SEC: i64 = 20;

/// The lowest tier floor above `depth_usd`, or `None` past the top tier.
pub fn next_depth_floor(depth_usd: u64) -> Option<u64> {
    DEPTH_LEVERAGE_TIERS
        .iter()
        .map(|&(floor, _)| floor)
        .find(|&floor| floor > depth_usd)
}

/// The leverage, in x, that `depth_usd` of sustained depth supports.
pub fn leverage_for_depth(depth_usd: u64) -> u8 {
    let mut x = DEPTH_LEVERAGE_TIERS[0].1;
    for (floor, tier) in DEPTH_LEVERAGE_TIERS {
        if depth_usd >= floor {
            x = tier;
        }
    }
    x
}
pub const LISTING_MAX_OI_USD: u64 = 50_000 * USD_SCALE as u64;
pub const LISTING_MIN_OI_USD: u64 = 1_000 * USD_SCALE as u64;
pub const LISTING_MAX_PRICE_AGE_SEC: u32 = 120;
pub const LISTING_MAX_CONF_BPS: u16 = 5_000;
pub const LISTING_MIN_FEE_BPS: u16 = 10;
pub const LISTING_MAX_FEE_BPS: u16 = 100;
pub const LISTING_MIN_MAINTENANCE_BPS: u16 = 500;
pub const LISTING_MIN_PNL_RESERVE_BPS: u16 = 10_000;
pub const LISTING_MIN_BASE_SPREAD_BPS: u16 = 10;
pub const LISTING_MIN_POSITION_USD: u64 = 10 * USD_SCALE as u64;
pub const LISTING_MAX_FUNDING_RATE_BPS_PER_HOUR: u16 = 200;

/// Resting orders one wallet may hold in a market's batch at once.
pub const MAX_ORDERS_PER_OWNER: usize = 4;

// --- referrals and points ---
//
// Every reward below is paid out of the protocol's share of a fee, never out
// of the LPs', the chain's or the insurance fund's. A referral or a listing
// can cost the protocol its cut; it cannot cost anyone else a cent. When the
// protocol's cut of a fee is smaller than the rewards on it, the rewards are
// cut down to fit: the referrer is paid first, the deployer takes what is left.

/// Off a trader's open and close fees once they have a referrer.
pub const REFEREE_DISCOUNT_BPS: u16 = 1_000; // 10%

/// Off the open and close fees of a market's own deployer, trading that market.
///
/// Only on the market they listed. A discount on every market would make
/// listing a junk market the cheapest way to trade everything else.
pub const DEPLOYER_DISCOUNT_BPS: u16 = 5_000; // 50%

/// Of every fee a referee pays, to their referrer, in USDC.
pub const REFERRER_FEE_SHARE_BPS: u16 = 1_000; // 10%

/// Of every fee paid on a market, to whoever listed it, in USDC. Not paid on
/// the deployer's own trades, which get `DEPLOYER_DISCOUNT_BPS` instead.
pub const DEPLOYER_FEE_SHARE_BPS: u16 = 1_000; // 10%

/// Points are fixed point at this scale, the same as USD: one point per
/// dollar of notional is a one-to-one copy of the fill.
pub const POINTS_SCALE: u128 = 1_000_000;

/// Of a referee's trading points, also credited to their referrer. The
/// referee keeps all of theirs.
pub const REFERRER_POINTS_BPS: u16 = 1_000; // 10%

/// Of every dollar traded on a market, credited as points to its deployer.
pub const DEPLOYER_POINTS_BPS: u16 = 1_000; // 10%

/// Points a dollar of market backing earns per day. Backing takes first loss,
/// so it earns twice what LP capital does.
pub const BACKING_POINTS_PER_USD_DAY: u128 = 2;

/// Points a dollar of pool liquidity earns per day.
pub const LP_POINTS_PER_USD_DAY: u128 = 1;

pub const SECONDS_PER_DAY: u128 = 86_400;

/// Referral codes are 3 to 16 characters of `a-z`, `0-9`, `_` and `-`.
pub const REFERRAL_CODE_LEN: usize = 16;
pub const REFERRAL_CODE_MIN_LEN: usize = 3;
