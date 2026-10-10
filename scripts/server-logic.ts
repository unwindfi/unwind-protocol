/*
 * The server's arithmetic, kept apart from it so it can be tested without
 * starting it: `scripts/server.ts` runs a chain connection and an HTTP server
 * on import. Moved here unchanged; the tests are `scripts/server-logic.test.ts`
 * (`npm run test:server`).
 */

/// A season's baseline: every wallet's totals when it began. See `seasonReady`
/// in server.ts.
export type SeasonBase = {
  points: number; trading: number; referrals: number; listing: number;
  volume: number; given: number; backingUsd: number; lpUsd: number;
};
export type Season = { season: number; pool: string; start: number; base: Record<string, SeasonBase> };

export const num = (v: any) => (v == null ? 0 : Number(v.toString()));


/// The hourly funding each side pays at the current open interest and pool
/// utilization, mirroring `Market::accrue_funding`: both sides pay a borrow
/// rate scaled by utilization, the heavier side pays a skew rate capped at the
/// market's maximum, and the lighter side receives that payment spread over
/// its smaller size. Positive is paid, negative received, both in bps an hour.
export function fundingRates(ma: any, longSize: number, shortSize: number, utilizationBps: number) {
  // Whole bps an hour, rounded down at each step, exactly as the program
  // does: shown as a fraction, a rate the chain truncates to zero read as a
  // charge nobody was paying.
  const B = 10_000n;
  const borrow = Number((BigInt(ma.borrowRateBpsPerHour) * BigInt(Math.trunc(utilizationBps))) / B);
  let long = borrow, short = borrow;
  if (longSize > 0 && shortSize > 0) {
    const longsHeavy = longSize >= shortSize;
    const heavy = BigInt(Math.round((longsHeavy ? longSize : shortSize) * 1e6));
    const light = BigInt(Math.round((longsHeavy ? shortSize : longSize) * 1e6));
    const skewBps = ((heavy - light) * B) / (heavy + light);
    const capped = (BigInt(ma.fundingKBps) * skewBps) / B;
    const rate = Number(capped < BigInt(ma.maxFundingRateBpsPerHour) ? capped : BigInt(ma.maxFundingRateBpsPerHour));
    const recv = (rate * Number(heavy)) / Number(light);
    if (longsHeavy) { long += rate; short -= recv; } else { short += rate; long -= recv; }
  }
  return { fundingRateLongBps: long, fundingRateShortBps: short };
}


/// Points a stake has earned since it was last brought up to date, so the
/// page shows a figure that moves rather than one that jumps at each sync.
/// Mirrors `stake_points` in the program.
export const pendingStakePoints = (usd: number, perDay: number, since: number, now: number) =>
  since > 0 && now > since ? (usd * perDay * (now - since)) / 86_400 : 0;


/// Whether an observed market takes orders now: its mark has seasoned, it has
/// a budget, and the mark is no older than the market's `maxPriceAgeSec`.
/// Past that the program refuses every order as stale, so the market is
/// paused in all but name; saying `tradeable` there sent the site's ticket
/// and the tester fleet at orders that could only bounce. `ageMs` is null
/// before the first reading.
export function observedTradeable(
  seasoned: boolean, budgetUsd: number, ageMs: number | null, maxAgeSec: number,
): boolean {
  return seasoned && budgetUsd > 0 && !markStale(ageMs, maxAgeSec);
}

/// A mark older than the market accepts. A market with no age limit on
/// record (zero) is never stale here; the program has its own floor.
export const markStale = (ageMs: number | null, maxAgeSec: number) =>
  ageMs != null && maxAgeSec > 0 && ageMs / 1000 > maxAgeSec;

/// Mirrors `haircut_profit_usd`: the fraction of winners' profit the market
/// can pay, as a percentage. Each side counts at `Market::side_winners_usd`:
/// the bound on its gross winners from its moment sums when every position on
/// it is tracked, and its net profit from the aggregates when not.
export function payoutPct(ma: any, p: any, price: number): number {
  const side = (isLong: boolean, sizeRaw: number, entryRaw: number, mo: any) => {
    const tracked = num(mo?.trackedUsd);
    if (mo && tracked === sizeRaw) {
      if (sizeRaw === 0) return 0;
      // In raw units: size and price both at 1e6, sums at 1e18 and 1e24.
      const P = price * 1e6;
      const pu = (P * num(mo.invEntry)) / 1e18;
      const m2 = Math.max(0, (P * P * num(mo.invEntrySq)) / 1e24 - 2 * pu + sizeRaw);
      const net = isLong ? pu - sizeRaw : sizeRaw - pu;
      return Math.max(0, (net + Math.sqrt(sizeRaw * m2)) / 2) / 1e6;
    }
    const size = sizeRaw / 1e6, entry = entryRaw / 1e6;
    return entry > 0 ? Math.max(0, size * ((price - entry) / entry) * (isLong ? 1 : -1)) : 0;
  };
  const winners =
    side(true, num(ma.longSizeUsd), num(ma.longAvgEntryPrice), ma.longMoments) +
    side(false, num(ma.shortSizeUsd), num(ma.shortAvgEntryPrice), ma.shortMoments);
  const remaining = Math.max(0, num(ma.lossBudgetUsd) / 1e6 - Math.max(0, num(ma.netLossUsd) / 1e6));
  const cash = (num(ma.backingUsd) + num(p.liquidityUsd) + num(p.insuranceUsd)) / 1e6;
  const available = Math.min(remaining, cash);
  return winners <= available ? 100 : (available / winners) * 100;
}


/*
 * How far the batches clear from the mark, averaged by volume over the last
 * hour, in bps: positive when buyers paid above it.
 *
 * Reported, not charged. Funding is driven by skew alone today; this is the
 * figure a premium leg would be built on, collected first so there is a
 * record of how it behaves before anything is charged off it.
 */
export const PREMIUM_WINDOW_MS = 60 * 60 * 1000;
const premiumSamples: Record<string, { t: number; bps: number; usd: number }[]> = {};

export function notePremium(symbol: string, clearPrice: number | null, matchedUsd: number, mark: number) {
  if (!clearPrice || matchedUsd <= 0 || !(mark > 0)) return;
  const list = (premiumSamples[symbol] ??= []);
  list.push({ t: Date.now(), bps: ((clearPrice - mark) / mark) * 10_000, usd: matchedUsd });
}

export const premiumOf = (symbol: string) => {
  const since = Date.now() - PREMIUM_WINDOW_MS;
  const list = (premiumSamples[symbol] ?? []).filter((x) => x.t >= since);
  premiumSamples[symbol] = list;
  const usd = list.reduce((s, x) => s + x.usd, 0);
  return usd > 0 ? list.reduce((s, x) => s + x.bps * x.usd, 0) / usd : null;
};

export type BookOrder = { price: number; size: number; isBid: boolean; isMaker: boolean };

/// Which of a batch's two auctions an order clears in, named for what the
/// taker in it is doing. Mirrors `auction::Flow` in the program.
export const flowOf = (o: { isBid: boolean; isMaker: boolean }) =>
  o.isBid !== o.isMaker ? "buy" : "sell";

/// Where one flow's resting orders would cross right now, before the pool
/// fills any takers left over. The same rule the program clears by: the price
/// that matches the most volume, then the one that leaves the least standing.
export function crossOf(orders: BookOrder[]) {
  const prices = [...new Set(orders.map((o) => o.price))].sort((a, b) => a - b);
  let best: { price: number; matched: number; imbalance: number } | null = null;
  for (const p of prices) {
    const demand = orders.filter((o) => o.isBid && o.price >= p).reduce((s, o) => s + o.size, 0);
    const supply = orders.filter((o) => !o.isBid && o.price <= p).reduce((s, o) => s + o.size, 0);
    const matched = Math.min(demand, supply);
    const imbalance = Math.abs(demand - supply);
    if (matched > 0 && (!best || matched > best.matched
        || (matched === best.matched && imbalance < best.imbalance))) {
      best = { price: p, matched, imbalance };
    }
  }
  return { price: best?.price ?? null, matched: best?.matched ?? 0 };
}

/// Where each flow of the collecting batch would cross right now. Indicative
/// only: the pool fills leftover takers at clearing, and orders can still
/// arrive.
export function indicativeCross(orders: BookOrder[]) {
  const bid = orders.filter((o) => o.isBid).reduce((s, o) => s + o.size, 0);
  const ask = orders.filter((o) => !o.isBid).reduce((s, o) => s + o.size, 0);
  return {
    buy: crossOf(orders.filter((o) => flowOf(o) === "buy")),
    sell: crossOf(orders.filter((o) => flowOf(o) === "sell")),
    bidUsd: bid, askUsd: ask,
  };
}


/*
 * A circuit breaker on what the keeper pushes.
 *
 * A mark more than BREAKER_PCT from the one on chain is held for one pass
 * (re-pushed, so the market stays fresh rather than going stale): one bad
 * reading from a price source would otherwise move the mark at once and
 * liquidate positions on it. If the next pass still sees the move, the mark
 * walks toward it by at most BREAKER_PCT a pass until it arrives.
 *
 * It used to hold for three passes and then take the whole move at once. A
 * real crash then skipped every liquidation price on the way down: positions
 * were closed past zero equity, the keeper earned no fee and the backers took
 * the rest. Stepping liquidates them on the way, while there is margin left.
 * Measured against the mark on chain, so a restart does not forget it.
 */
export const BREAKER_PCT = 10;
const breakerSeen = new Set<string>();
export function breaker(key: string, symbol: string, onChain: number, next: number): number {
  if (!(onChain > 0)) return next;
  const move = Math.abs(next / onChain - 1) * 100;
  if (move <= BREAKER_PCT) { breakerSeen.delete(key); return next; }
  if (!breakerSeen.has(key)) {
    breakerSeen.add(key);
    console.warn(`mark ${symbol}: ${move.toFixed(1)}% move held for a pass`);
    return onChain;
  }
  const step = Math.round(onChain * (1 + (next > onChain ? 1 : -1) * BREAKER_PCT / 100));
  console.warn(`mark ${symbol}: ${move.toFixed(1)}% move, stepped ${BREAKER_PCT}%`);
  return step;
}


/// A wallet's points as of now: what the program has counted, plus what its
/// backing and pool stakes have earned since they were last brought up to
/// date. Mirrors `stake_points` in the program.
export const livePoints = (t: any, now = Math.floor(Date.now() / 1000)) =>
  num(t.points) / 1e6 +
  pendingStakePoints(num(t.backingUsd) / 1e6, 2, num(t.backingTs), now) +
  pendingStakePoints(num(t.lpUsd) / 1e6, 1, num(t.lpTs), now);

/// A wallet's standing this season. Backing and LP placed before the season
/// keep earning on chain (in pools this server no longer serves), so what
/// that stake has earned since the season began is taken off as well, at the
/// smaller of the stake then and now.
export function seasonStanding(t: any, season: Season | null, now = Math.floor(Date.now() / 1000)) {
  const b = season?.base[t.owner.toBase58()];
  const live = livePoints(t, now);
  const raw = {
    trading: num(t.tradingPoints) / 1e6,
    referrals: num(t.referralPoints) / 1e6,
    listing: num(t.listingPoints) / 1e6,
    volume: num(t.volumeUsd) / 1e6,
    given: num(t.givenToReferrerPoints) / 1e6,
  };
  if (!b || !season) return { points: live, ...raw };
  const since = Math.max(0, now - season.start);
  const carried = (Math.min(b.backingUsd, num(t.backingUsd) / 1e6) * 2
    + Math.min(b.lpUsd, num(t.lpUsd) / 1e6)) * since / 86_400;
  // Below a millionth is float residue from the subtraction, not a point.
  const over = (x: number) => (x > 1e-6 ? x : 0);
  return {
    points: over(live - b.points - carried),
    trading: over(raw.trading - b.trading),
    referrals: over(raw.referrals - b.referrals),
    listing: over(raw.listing - b.listing),
    volume: over(raw.volume - b.volume),
    given: over(raw.given - b.given),
  };
}


/// The Monday 00:00 UTC that starts the week holding `ms`, in seconds.
export const weekStart = (ms = Date.now()) => {
  const d = new Date(ms);
  const day = (d.getUTCDay() + 6) % 7; // Monday is 0
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day) / 1000;
};

/// The wallets that count toward a market's creator score, from what each
/// has filled there: each once, at `minUsd` or more, never the deployer or
/// the server's own wallets.
export function countTraders(
  volumes: Record<string, number>, deployer: string, house: Set<string>, minUsd: number,
): number {
  let n = 0;
  for (const [w, usd] of Object.entries(volumes)) {
    if (usd >= minUsd && w !== deployer && !house.has(w)) n++;
  }
  return n;
}

/// One faucet claim, kept for a day.
export type Claim = { owner: string; ip: string; t: number; sol: number; usdc?: number };

const DAY_MS = 86_400_000;

/// Why the faucet refuses `owner` at `ip` now, or null when it may claim:
/// one claim per wallet a day, `perIpPerDay` per address, and no more than
/// `usdcPerDay` of test USDC across every claim in the last day. `claims` is
/// already trimmed to the last day.
export function faucetRefusal(
  claims: Claim[], owner: string, ip: string, now: number,
  limits: { usdc: number; usdcPerDay: number; perIpPerDay: number },
): string | null {
  const mine = claims.find((c) => c.owner === owner);
  if (mine) {
    const hours = Math.ceil((mine.t + DAY_MS - now) / 3_600_000);
    return `this wallet was funded today; try again in ${hours}h`;
  }
  if (claims.filter((c) => c.ip === ip).length >= limits.perIpPerDay) {
    return "too many claims from this address today";
  }
  const minted = claims.reduce((a, c) => a + (c.usdc ?? limits.usdc), 0);
  if (minted + limits.usdc > limits.usdcPerDay) {
    const oldest = Math.min(...claims.map((c) => c.t));
    const hours = Math.max(1, Math.ceil((oldest + DAY_MS - now) / 3_600_000));
    return `the faucet has given out its ${limits.usdcPerDay.toLocaleString("en-US")} test USDC `
      + `for today; try again in ${hours}h`;
  }
  return null;
}
