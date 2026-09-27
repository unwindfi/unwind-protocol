/*
 * What a market listed from the site is allowed to be.
 *
 * One file, read by three things that must agree: the local server that
 * builds the listing transaction, the function that previews a pool on the
 * deployed site, and the page that draws the preview. A preview that quoted
 * different limits from the listing would be a quote for a market that does
 * not exist, so none of them keep their own copy of these numbers.
 *
 * No imports, on purpose: the Vercel functions are built without the repo's
 * dependencies, and the page pulls this in through the `@scripts` alias.
 */

/// Most open interest a listed market may carry per side.
///
/// A ceiling on top of the depth-derived cap, not instead of it: depth is
/// measured off a pool and a pool can be made temporarily deep, so the
/// arithmetic is allowed to make a market smaller and never to make it large.
export const LISTING_OI_CEILING_USD = 50_000;

/// Smallest size a lister may pick. Below this a market is not worth the rent.
export const LISTING_OI_FLOOR_USD = 1_000;

/// Leverage ceiling for anything priced off an AMM, in bps (5x). Reached only
/// on depth: the program caps every observed market by `DEPTH_LEVERAGE_TIERS`.
export const LISTING_LEVERAGE_CEILING_BPS = 50_000;
/// Mirrored from `DEPTH_LEVERAGE_TIERS` in the program's constants: the
/// leverage a pool's sustained depth (USD to move it 1%) supports. A market
/// starts at the lowest tier and rises as the depth holds; a thinning pool
/// lowers it on the next reading.
export const DEPTH_LEVERAGE_TIERS: [number, number][] = [
  [0, 2], [10_000, 3], [50_000, 4], [250_000, 5],
];
export function leverageForDepth(depthUsd: number): number {
  let x = DEPTH_LEVERAGE_TIERS[0][1];
  for (const [floor, tier] of DEPTH_LEVERAGE_TIERS) if (depthUsd >= floor) x = tier;
  return x;
}

/// Seasoning, mirrored from `state/observation.rs`: a listed market quotes
/// after this many readings spread over at least this long.
export const MIN_OBSERVATIONS = 30;
export const MIN_OBSERVATION_WINDOW_SEC = 900;

/// A Raydium pool whose own history spans that window opens at listing, at
/// its fifteen-minute average, if its spot is within this of the average.
/// Mirrored from `SEED_MAX_GAP_BPS` in `state/observation.rs`.
export const SEED_MAX_GAP_BPS = 300;

/// Share of a market's trading fees paid to its backers, in bps, mirrored
/// from `BACKER_FEE_SHARE_BPS` in the program's constants. Taken from the
/// LPs' part of the fee, after the protocol's cut: backers stand in front of
/// the LPs on losses, so they are paid in front of them on fees.
export const BACKER_FEE_SHARE_BPS = 5_000;

/// Least a lister posts behind their own market, in USD, from the site.
///
/// Listing and backing are one transaction there, because a listed market
/// nobody backed cannot take a position, and a listing page that ends on a
/// dead market is a page that ends badly. The program itself still lets a
/// market list unbacked; this is where the site draws its own line. Small on
/// purpose: the budget is capped by what the pool costs to move anyway, so a
/// small backing makes a small market, not an unsafe one.
export const MIN_LISTING_BACKING_USD = 100;

/// Where the testnet's list page starts the backing instead. Test USDC is free
/// and a market's pool fills a twentieth of its budget per batch, so the
/// mainnet minimum would leave a tester's first orders filling $5 at a time.
export const TESTNET_LISTING_BACKING_USD = 2_000;

/// Share of a market's remaining loss budget the pool quotes into each batch,
/// in bps. Mirrored from `POOL_QUOTE_BUDGET_BPS` in `state/batch.rs`.
export const POOL_QUOTE_BUDGET_BPS = 500;

/// Open plus close, in bps of notional, as listed markets are created with.
export const LISTING_ROUND_TRIP_FEE_BPS = 20;

/// Stablecoins a pool may be quoted in. A pool with neither side in one of
/// these cannot price a USD market.
export const QUOTE_MINTS: Record<string, string> = {
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: "USDC",
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: "USDT",
};

/// Largest unit a market may be quoted in: a billion tokens.
export const MAX_UNIT_EXP = 9;

/// How many tokens one unit of a listed market is, as a power of ten.
///
/// Only as big as it has to be. Six decimals of dollars keep four significant
/// figures for anything worth a cent or more, so those trade one token at a
/// time; below a cent the unit steps up by thousands (1K, 1M, 1B) until a
/// unit is worth a cent again. Bonk at $0.0000038 becomes $3.81 per 1M;
/// WIF at $0.25 stays WIF.
export function unitExpFor(usdPrice: number): number {
  let e = 0;
  while (e < MAX_UNIT_EXP && usdPrice * 10 ** e < 0.01) e += 3;
  return e;
}

/// `1M` for six, and so on. Empty for a token quoted one at a time.
export const unitLabel = (unitExp: number) => ["", "1K", "1M", "1B"][unitExp / 3] ?? `1e${unitExp}`;

/// The limits a pool of this depth gets, with the lister's choices clamped
/// into them. Unset choices take the most the pool allows.
export function listingLimits(depthUsd: number, choice: { leverage?: number; oiUsd?: number } = {}) {
  const ceiling = Math.max(0, Math.min(depthUsd, LISTING_OI_CEILING_USD));
  const floor = Math.min(LISTING_OI_FLOOR_USD, ceiling);
  const maxLeverage = LISTING_LEVERAGE_CEILING_BPS / 10_000;
  const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
  return {
    maxLeverage,
    /// What this pool's depth supports once it has held; a new market starts
    /// at the lowest tier. See `DEPTH_LEVERAGE_TIERS`.
    depthLeverage: leverageForDepth(depthUsd),
    startLeverage: DEPTH_LEVERAGE_TIERS[0][1],
    maxOiUsd: ceiling,
    minOiUsd: floor,
    leverage: clamp(Number.isFinite(choice.leverage) ? choice.leverage! : maxLeverage, 1, maxLeverage),
    oiUsd: clamp(Number.isFinite(choice.oiUsd) ? choice.oiUsd! : ceiling, floor, ceiling),
  };
}
