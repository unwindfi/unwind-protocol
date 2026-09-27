/// Live market data, read straight from the browser.
///
/// The Express server exists to post prices on chain and settle orders against
/// a validator, and neither of those can be hosted on a static deploy. But the
/// *pricing* layer needs nothing privileged: Jupiter and Pyth both serve the
/// browser with CORS, so a deployed page can read the same sources the server
/// reads and show the real market.
///
/// What it cannot do is trade. There is no pool, no position and no keeper
/// without a chain, so those arrive as zeroes and the UI marks itself
/// read-only rather than pretending otherwise.
import { MARKETS } from "@scripts/markets";
import type { Account, Market, Trade } from "./api";

const JUP_PRICE = "https://lite-api.jup.ag/price/v3";
const JUP_CHARTS = "https://datapi.jup.ag/v2/charts";
const PYTH_META = "https://hermes.pyth.network/v2/price_feeds";

/// Mirrors `scripts/prices.ts`. Kept in step by hand, because the server copy
/// runs in Node and this one has to run in a browser — but the formula is the
/// contract, so any change belongs in both.
const LIQ_REF_USD = 1_000_000;
const LIQ_REF_BPS = 5;
const MIN_CONF_BPS = 2;

function confBpsFor(price: number, underlying: number | null, liquidity: number) {
  const basisBps =
    underlying && underlying > 0 ? (Math.abs(price - underlying) / price) * 10_000 : 0;
  const liqBps =
    liquidity > 0 ? LIQ_REF_BPS * Math.sqrt(LIQ_REF_USD / liquidity) : LIQ_REF_BPS * 10;
  return Math.max(MIN_CONF_BPS, basisBps + liqBps);
}

/// The spread the program would charge, from `Market::spread_bps`. The defaults
/// match what `bootstrap-localnet.ts` writes on chain.
const BASE_SPREAD_BPS = 4;
const MAX_SPREAD_BPS = 500;
const OPEN_FEE_BPS = 6;

const json = async (url: string) => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.json();
};

let sessionCache: { at: number; bySymbol: Record<string, number> } | null = null;

/// Trading calendars for the underlying equities. Pyth's metadata endpoint is
/// the one that needs no API key, which is all this wants.
async function sessions(): Promise<Record<string, number>> {
  if (sessionCache && Date.now() - sessionCache.at < 60_000) return sessionCache.bySymbol;
  const bySymbol: Record<string, number> = {};
  try {
    const ids = MARKETS.map((m) => `ids[]=${m.underlyingFeedId}`).join("&");
    const feeds = await json(`${PYTH_META}?${ids}`);
    const byId: Record<string, any> = {};
    for (const f of feeds ?? []) byId[String(f.id).toLowerCase()] = f;
    for (const m of MARKETS) {
      const f = byId[m.underlyingFeedId.toLowerCase()];
      if (f?.market_hours) bySymbol[m.symbol] = f.market_hours.is_open ? 0 : 2;
    }
  } catch {
    /* A missing calendar is not worth failing the page over. */
  }
  sessionCache = { at: Date.now(), bySymbol };
  return bySymbol;
}

const spark: Record<string, number[]> = {};

export async function liveMarkets(): Promise<Market[]> {
  const [data, sess] = await Promise.all([
    json(`${JUP_PRICE}?ids=${MARKETS.map((m) => m.mint).join(",")}`),
    sessions(),
  ]);

  return MARKETS.flatMap((def) => {
    const d = data?.[def.mint];
    const price = Number(d?.usdPrice);
    if (!Number.isFinite(price) || price <= 0) return [];

    const underlying = Number(d?.stockData?.price);
    const liquidity = Number(d?.liquidity) || 0;
    const confBps = confBpsFor(price, Number.isFinite(underlying) ? underlying : null, liquidity);
    const spreadBps = Math.min(BASE_SPREAD_BPS + Math.floor(confBps), MAX_SPREAD_BPS);
    const changePct = Number(d?.priceChange24h) || 0;
    const open = changePct !== 0 ? price / (1 + changePct / 100) : price;
    const session = sess[def.symbol] ?? 0;

    // Keep a little shape for the ticker list without another request.
    const s = (spark[def.symbol] ??= []);
    if (s[s.length - 1] !== price) s.push(price);
    if (s.length > 120) s.shift();

    return [{
      symbol: def.symbol, name: def.name, color: def.color, mono: def.mono,
      mint: def.mint,
      // No chain, so nothing backed. Zero is the truth, not a placeholder.
      backingUsd: 0, lossBudgetUsd: 0,
      price,
      bid: price * (1 - spreadBps / 10_000),
      ask: price * (1 + spreadBps / 10_000),
      spreadBps,
      change: price - open,
      changePct,
      high: price, low: price,
      maxLeverage: (session === 2 ? 20_000 : def.maxLeverageBps) / 10_000,
      session,
      maintenanceMarginBps: def.maintenanceMarginBps,
      openFeeBps: OPEN_FEE_BPS,
      // Everything below lives on chain. Without one there is no honest number
      // to put here, so it is zero and the UI says why.
      oi: 0, longShare: 50, fundingLong: 0, fundingShort: 0,
      freeLiquidity: 0, capLong: 0, capShort: 0,
      longSize: 0, shortSize: 0, volume24h: 0,
      sparkline: s.slice(),
      priceAgeMs: 0,
      maxPriceAgeSec: 90,
      feedError: null,
      // These are the xStock mints, which have a Pyth feed behind them. Only a
      // market listed against an AMM pool observes one, so there is nothing to
      // report here.
      observed: null,
    } satisfies Market];
  });
}

const INTERVALS: Record<number, string> = {
  60: "1_MINUTE", 300: "5_MINUTE", 900: "15_MINUTE",
};

export async function liveCandles(symbol: string, tf: number) {
  const def = MARKETS.find((m) => m.symbol === symbol);
  const interval = INTERVALS[tf];
  if (!def || !interval) return [];
  const to = Math.floor(Date.now() / 1000) * 1000;
  const d = await json(
    `${JUP_CHARTS}/${def.mint}?interval=${interval}&to=${to}&candles=300&type=price`);
  return (d?.candles ?? [])
    .map((c: any) => ({
      time: Number(c.time), open: Number(c.open), high: Number(c.high),
      low: Number(c.low), close: Number(c.close),
    }))
    .filter((c: any) => Number.isFinite(c.time) && c.close > 0);
}

/// No chain, no fills. An empty tape is the truthful answer.
export const liveTrades = async (): Promise<Trade[]> => [];

/// No chain, no account. Zeroes, so the panels render their empty states
/// instead of the page failing to load.
export const liveAccount = async (): Promise<Account> => ({
  cluster: "offline", address: "", usdc: 0, margin: 0, unrealized: 0, equity: 0,
  positions: {}, liquidations: [], deleverages: [], orders: [], orderFills: [],
  lp: { held: 0, price: 1, value: 0 },
  pool: {
    aum: 0, liquidity: 0, locked: 0, free: 0, utilization: 0,
    maxUtilization: 80, traderPnl: 0, lpSupply: 0, lpPrice: 1, insurance: 0, escrow: 0,
    addFeePct: 0, removeFeePct: 0,
  },
});
