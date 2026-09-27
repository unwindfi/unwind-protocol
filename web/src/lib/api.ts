import { useEffect, useRef, useState } from "react";

export interface Market {
  symbol: string; name: string; color: string; mono: string;
  /// The SPL mint this market is priced on, when there is one to name. Null
  /// for a market listed against a pool, whose identity is the pool rather
  /// than a token this venue knows the mint of.
  mint: string | null;
  price: number; bid: number; ask: number; spreadBps: number;
  change: number; changePct: number; high: number; low: number;
  maxLeverage: number; session: number; oi: number; longShare: number;
  fundingLong: number; fundingShort: number;
  /// What each side pays now, in bps an hour, positive to pay. Absent on a
  /// static deploy, which has no program to read.
  fundingRateLongBps?: number; fundingRateShortBps?: number;
  lastFundingTs?: number;
  maintenanceMarginBps: number; openFeeBps: number;
  freeLiquidity: number; capLong: number; capShort: number;
  longSize: number; shortSize: number; volume24h: number;
  /// First-loss capital behind this market, and the budget it is held to.
  /// Any market can be backed, whatever prices it.
  backingUsd: number; lossBudgetUsd: number;
  sparkline: number[];
  /// Age of the price this market last posted on chain, and the age at which
  /// the program starts rejecting orders against it.
  priceAgeMs: number | null;
  maxPriceAgeSec: number;
  feedError: string | null;
  /// Null for a market with a feed behind it. Present for one listed against
  /// an AMM pool, where it is the market's whole status: what it watches, how
  /// far through seasoning it is, and whether anyone has underwritten it.
  observed: Observed | null;
}

export interface Observed {
  source: string;
  readings: number; readingsNeeded: number;
  spanSec: number; spanNeededSec: number;
  seasoned: boolean;
  /// USD to move the source pool one percent — the ceiling on what this
  /// market is ever allowed to cost the LPs.
  depthUsd: number;
  budgetUsd: number;
  /// What backers have posted. A market is tradeable once this is non-zero
  /// and the mark has seasoned.
  backingUsd: number;
  /// Seasoned *and* underwritten. A market can be watched long before it is
  /// either, and saying which is missing is the difference between a market
  /// that is waiting and one that looks broken.
  tradeable: boolean;
}

/// A pool as the program would read it, fetched before anything is signed.
export interface PoolPreview {
  address: string; dex: "raydium-clmm" | "meteora-dlmm";
  base: string; quote: string; quoteIsToken0: boolean;
  /// What the market will be listed as, derived the way the listing derives
  /// it: the token's own symbol, prefixed with its unit when it has one.
  symbol: string; name: string; icon?: string | null;
  /// USD per single token, at full precision, and per unit as the market
  /// will quote it. `unitExp` is the power of ten a unit is (6 is 1M).
  price: number; unitExp: number; unitLabel: string; unitPrice: number;
  depthUsd: number; budgetUsd: number;
  /// The parameters this pool would actually get, resolved from the same
  /// policy the listing uses so the preview and the listing cannot disagree.
  maxOiUsd: number; minOiUsd?: number; maxLeverage: number;
  seasonSec: number; readingsNeeded: number;
  /// A Raydium pool whose own recorded history already spans the seasoning
  /// window: the market opens at listing, at the pool's fifteen-minute average.
  opensAtListing?: boolean;
  backerFeeShareBps: number;
  /// Set when the pool was read by the deployed site's preview function,
  /// which can describe a listing but has no chain to send one to.
  readOnly?: boolean;
}

export interface Position {
  isLong: boolean; size: number; collateral: number; entry: number; mark: number;
  leverage: number; pnl: number; pnlPct: number; funding: number;
  equity: number; maintenance: number; liqPrice: number; liquidatable: boolean;
}

export interface Account {
  /// Which chain this pool lives on — the status bar should never claim one
  /// cluster while serving another.
  cluster: string;
  address: string; usdc: number; margin: number; unrealized: number; equity: number;
  positions: Record<string, Position>;
  liquidations: { t: number; symbol: string; isLong: boolean; size: number; price: number; returned: number }[];
  /// Closed because profit outgrew the pool's reserve, not because the trader
  /// ran out of margin.
  deleverages: { t: number; symbol: string; owner: string; size: number; price: number }[];
  /// Standing take-profits and stops.
  orders: { address: string; symbol: string; slot: number; kind: number;
            sizeUsd: number; collateralUsd: number; isLong: boolean;
            triggerPrice: number; triggerAbove: boolean; expiryTs: number }[];
  orderFills: { t: number; symbol: string; owner: string; trigger: number;
                price: number; above: boolean; expired: boolean }[];
  lp: { held: number; price: number; value: number };
  pool: { aum: number; liquidity: number; locked: number; free: number;
          utilization: number; maxUtilization: number; traderPnl: number;
          lpSupply: number; lpPrice: number;
          /// Capital standing between a gap and the LPs.
          insurance: number;
          /// Collateral held against unfilled limit orders.
          escrow: number;
          /// Entry and exit fees, in percent. Kept by the LPs who stay.
          addFeePct: number; removeFeePct: number };
}

/// One order resting in the collecting batch.
///
/// This is a real book, unlike the ladder the depth column used to show: the
/// auction matches these against each other, and the pool only takes what they
/// leave standing. Makers rest as liquidity and trade only with takers; see
/// `FlowCross`.
export interface RestingOrder {
  price: number; size: number; isBid: boolean; isMaker: boolean; reduceOnly: boolean;
}

/// One of a batch's two auctions. The buy flow is takers buying from makers,
/// the sell flow takers selling to makers. Null price when it does not cross.
export interface FlowCross { price: number | null; matched: number }

export interface Batch {
  exists: boolean;
  seq: number;
  /// When the window is up. Already past, on a screen that is counting down,
  /// means the crank has not landed yet — a real state, not a stuck clock.
  clearsAtMs: number;
  sealed: boolean;
  /// Set while a listed market is still seasoning: its opening auction.
  /// Orders rest until the mark is ready and then all clear in one batch.
  opening: { opensAtMs: number; readings: number; readingsNeeded: number } | null;
  /// Where each flow's resting orders would cross right now, before the pool
  /// fills leftover takers.
  indicative: { buy: FlowCross; sell: FlowCross; bidUsd: number; askUsd: number };
  resting: RestingOrder[];
  /// The last clear: one price per flow, null for a flow that did not trade.
  last: {
    buyPrice: number | null; sellPrice: number | null;
    matched: number; poolUsd: number; orders: number; t: number;
  } | null;
  /// Share of all volume the pool has been the counterparty to. Null until
  /// something has traded — "no data yet" is not "the pool took none".
  poolSharePct: number | null;
}

export interface Trade {
  t: number; symbol: string; side: "buy" | "sell"; size: number; price: number; kind: string;
}

/*
 * Where the venue's API lives.
 *
 * In production the browser calls the server directly. Going through the
 * site's own /api proxy sent every request to a Vercel function in
 * Washington and on to the server, which cost about a second a call from
 * anywhere else. In dev the page stays on its own origin, where Vite
 * proxies /api. `VITE_API_URL` overrides either. Only the venue's routes
 * move: /api/me, /api/code, /api/x and /api/pool are Vercel's own.
 */
export const API = ((import.meta.env.VITE_API_URL as string | undefined)
  ?? (import.meta.env.PROD ? "https://api.unwindfi.xyz" : "")).replace(/\/$/, "");
export const apiUrl = (path: string) => API + path;

/*
 * The last answer to each read, kept in the browser.
 *
 * A page draws from it the instant it opens and replaces it when the fresh
 * answer lands, so a return visit is never a blank wait on the network. Only
 * reads worth drawing early are kept, and nothing is trusted from it that a
 * trade depends on: the ticket's figures come from the fresh poll.
 */
const CACHE = "unwind.c:";
const CACHEABLE = /^\/api\/(markets|candles\/|account|trades\/|batch\/)/;
export function peek<T>(path: string): T | null {
  try {
    const raw = localStorage.getItem(CACHE + path);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch { return null; }
}
function keep(path: string, body: string) {
  if (!CACHEABLE.test(path) || body.length > 200_000) return;
  try { localStorage.setItem(CACHE + path, body); } catch { /* full or blocked */ }
}

const get = async <T,>(path: string): Promise<T> => {
  const r = await fetch(apiUrl(path));
  if (!r.ok) throw new Error(String(r.status));
  const text = await r.text();
  keep(path, text);
  return JSON.parse(text) as T;
};

/*
 * Two ways to get data, chosen once at startup.
 *
 * Locally the Express server is there: it posts prices on chain, settles orders
 * against the validator and serves this page, so every call goes to it and the
 * app is fully live. A static deploy has no server to call — but the pricing
 * sources it reads (Jupiter, Pyth) serve the browser directly, so the page can
 * show the real market on its own. What it cannot do without a chain is trade,
 * and `readOnly` says so rather than leaving dead buttons.
 *
 * Probed rather than configured, so the same build runs in both places and
 * there is no env var to get wrong.
 */
let backend: Promise<boolean> | null = null;
/// Three tries, a beat apart. The answer is kept for the whole visit, so one
/// slow or dropped request on the testnet (the server shares a rate-limited
/// RPC) would otherwise turn the app read-only until a reload.
/// The probe's own answer, handed to the first `getMarkets` so the page's
/// first paint does not wait on a second round trip for the same list.
let firstMarkets: Market[] | null = null;
const probe = async () => {
  for (let i = 0; i < 3; i++) {
    if (i) await new Promise((r) => setTimeout(r, 1500));
    try { firstMarkets = await get<Market[]>("/api/markets"); return true; } catch { /* again */ }
  }
  return false;
};
const hasBackend = () => (backend ??= probe());

/// True once a probe has come back without a server. Read after the first poll.
export let readOnly = false;

export const getMarkets = async () => {
  if (await hasBackend()) {
    if (firstMarkets) { const m = firstMarkets; firstMarkets = null; return m; }
    return get<Market[]>("/api/markets");
  }
  readOnly = true;
  return (await import("./live")).liveMarkets();
};

export const getAccount = async (owner?: string) => {
  if (await hasBackend()) {
    return get<Account>("/api/account" + (owner ? `?owner=${owner}` : ""));
  }
  return (await import("./live")).liveAccount();
};

/// A testnet pool a tester can list a market on. Only the testnet has any:
/// every real pool is on mainnet, and a market can only watch a pool on its
/// own chain.
export interface TestnetPool { symbol: string; name: string; pool: string; listed: boolean }
export const getTestnetPools = async () =>
  (await hasBackend()) ? get<TestnetPool[]>("/api/testnet-pools").catch(() => []) : [];

/// One owner's backing, by market. Worth what the market's first-loss pot
/// holds per share now, which moves as that market pays out and earns.
export interface Backing {
  symbol: string; shares: number;
  /// What the shares are worth now, in dollars, at the last prices.
  value: number;
  /// Posted, in dollars at the time of each deposit.
  deposited: number;
  /// The tokens the shares are a claim on, whole units by symbol. Withdrawing
  /// pays this mix.
  held: Record<string, number>;
  budgetUsd: number;
  tradeable: boolean;
  /// Still seasoning: orders are resting in its opening auction.
  opening: boolean;
}

/// Empty without a backend: backing is a chain position and there is no chain.
export const getBackings = async (owner?: string) => {
  if (!(await hasBackend()) || !owner) return [] as Backing[];
  return get<Backing[]>(`/api/backings?owner=${owner}`);
};

/// A wallet's referral standing and points, as the program keeps them.
export interface Rewards {
  exists: boolean;
  /// The wallet's `Trader` account, for checking every figure on an explorer.
  account: string;
  /// When the server read it, unix seconds. The page ticks points on from here.
  asOf: number;
  code: string | null;
  referrer: string | null;
  referrerCode?: string | null;
  referralCount: number;
  points: number;
  /// Points a day from what is staked now. Only these accrue continuously.
  perDay: { backing: number; lp: number };
  breakdown: { trading: number; referrals: number; listing: number; stakes: number };
  volume: number;
  referredVolume: number;
  feesSaved: number;
  /// USDC from referrals and listings, ready to claim.
  claimable: number;
  claimed: number;
  earned: { referrals: number; listing: number };
  backing: number;
  lp: number;
  canSetReferrer?: boolean;
  listed: { symbol: string; volume: number; earned: number; pending: number }[];
  listingVolume: number;
  referees: { wallet: string; code: string | null; volume: number; points: number;
              usdc: number; since: number }[];
}

/// Null without a backend or a wallet: points are a chain record.
export const getRewards = async (owner?: string) => {
  if (!(await hasBackend()) || !owner) return null;
  return get<Rewards>(`/api/rewards?owner=${owner}`);
};

export interface LeaderRow {
  rank: number; wallet: string; short: string; code: string | null;
  points: number; week: number; volume: number;
}
export interface Leaderboard {
  period: "all" | "week";
  weekStart: number;
  /// USDC the program has paid referrers and market deployers, claimed or not.
  paidUsd: number;
  /// Every wallet's points, house wallets included.
  allPoints: number;
  wallets: number;
  total: number;
  /// Share of the period's points the top twenty wallets hold.
  concentration: number;
  top: LeaderRow[];
  me: (LeaderRow & { percentile: number }) | null;
}

export const getLeaderboard = async (period: "all" | "week", owner?: string) => {
  if (!(await hasBackend())) return null;
  return get<Leaderboard>(`/api/leaderboard?period=${period}${owner ? `&owner=${owner}` : ""}`);
};

/// Whether a referral code is free (`owner` null) or whose it is.
export const checkCode = (code: string) =>
  get<{ valid: boolean; owner: string | null }>(`/api/referral-code/${encodeURIComponent(code)}`);

/// A vault's APY over the window the server has watched it for. `apy` is null
/// until that window is long enough to scale to a year from.
export interface Apy { apy: number | null; hours: number }

/// Nothing without a backend: an APY is a history of a chain position, and
/// there is no chain here to have one.
export const getApy = async () => {
  if (!(await hasBackend())) return { pool: null, markets: {} } as
    { pool: Apy | null; markets: Record<string, Apy> };
  return get<{ pool: Apy | null; markets: Record<string, Apy> }>("/api/apy");
};

export const getTrades = async (symbol: string) => {
  if (await hasBackend()) return get<Trade[]>(`/api/trades/${symbol}`);
  return (await import("./live")).liveTrades();
};

/// Null without a backend: a static deploy has no chain, so there is no batch
/// to report and the panel says so rather than counting down to nothing.
export const getBatch = async (symbol: string) => {
  if (!(await hasBackend())) return null;
  return get<Batch>(`/api/batch/${symbol}`);
};

/// Reads a pool the way the program would. Null without a backend: there is
/// no chain to read it from, and a made-up preview is the one thing a page
/// about listing real markets must not show.
/// A pool as the market it would list as. Answered by the local server, or on
/// the deployed site by a function that reads mainnet, at the same path.
export const getPool = async (address: string) => {
  const r = await fetch(`/api/pool/${address}`);
  const body = await r.json().catch(() => null);
  if (!r.ok) throw new Error(body?.error ?? "Could not read that pool.");
  return body as PoolPreview;
};

/// Whether this deploy has a chain behind it to sign against.
export const canSign = () => hasBackend();

/// Whether a chain is behind this deploy: null until the probe answers, so a
/// page can say nothing rather than guess and then change its mind.
export function useHasBackend() {
  const [has, setHas] = useState<boolean | null>(null);
  useEffect(() => { void hasBackend().then(setHas); }, []);
  return has;
}

export const getCandles = async (symbol: string, tf: number) => {
  if (await hasBackend()) {
    return get<{ time: number; open: number; high: number; low: number; close: number }[]>(
      `/api/candles/${symbol}?tf=${tf}`);
  }
  return (await import("./live")).liveCandles(symbol, tf);
};

export async function post(path: string, body: unknown) {
  if (!(await hasBackend())) {
    return { ok: false, error: "Read-only deploy — no chain connected" };
  }
  const r = await fetch(apiUrl("/api" + path), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return r.json() as Promise<{ ok: boolean; error?: string }>;
}

/// Polls `fn` on an interval and keeps the last good value.
///
/// A failed poll is swallowed rather than blanking the screen: on a local
/// validator a request can lose a race with a restart, and flashing the whole
/// UI to empty for one tick is worse than showing a value a second old.
export function usePoll<T>(
  fn: () => Promise<T>, ms: number, deps: unknown[] = [],
  /// What to show before the first answer, usually `peek` of the same read.
  seed?: () => T | null,
) {
  const [data, setData] = useState<T | null>(() => seed?.() ?? null);
  const first = useRef(true);
  useEffect(() => {
    // Each run of the effect gets its own flag. A shared one was set back to
    // true by the next run before the previous run's fetch had landed, so
    // switching markets left the old market's loop polling forever and
    // writing its answers over the new one's.
    let alive = true;
    let timer: number | undefined;
    // What was fetched for the old inputs is not an answer for the new ones.
    if (!first.current) setData(seed?.() ?? null);
    first.current = false;
    const run = async () => {
      try {
        const v = await fn();
        if (alive) setData(v);
      } catch { /* keep the previous value */ }
      if (alive) timer = window.setTimeout(run, ms);
    };
    run();
    return () => { alive = false; clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return data;
}

/// One wallet's fills, newest first. Only what the server has settled since
/// it last started; the chain keeps positions, not a history of fills.
export const getFills = async (owner?: string) => {
  if (!(await hasBackend()) || !owner) return [] as Trade[];
  return get<Trade[]>(`/api/fills?owner=${owner}`);
};
