/// The live price source.
///
/// Quotes come from Jupiter, which prices the xStock mints off the Solana
/// pools they actually trade in, and carries the underlying equity's last
/// print alongside. Trading calendars come from Pyth's feed metadata, which is
/// served without an API key (the price endpoints are not). Nothing here
/// invents a number: if a fetch fails the caller is told, and the last good
/// reading stands until it goes stale enough for the program to reject it.

import fs from "fs";
import path from "path";
import { MARKETS, MarketDef } from "./markets";

const JUP_PRICE = "https://lite-api.jup.ag/price/v3";
const JUP_CHARTS = "https://datapi.jup.ag/v2/charts";
const PYTH_META = "https://hermes.pyth.network/v2/price_feeds";

/// A quote is only worth as much as the pool behind it. At this depth the
/// liquidity term contributes `LIQ_REF_BPS`; thinner pools widen as 1/sqrt.
const LIQ_REF_USD = 1_000_000;
const LIQ_REF_BPS = 5;
/// Pyth's own equity feeds rarely publish inside a couple of basis points, so
/// neither should this.
const MIN_CONF_BPS = 2;

export interface LiveQuote {
  symbol: string;
  /// The xStock token's price in USD, which is what the market trades.
  price: number;
  /// Last print of the equity the token tracks, or null when unavailable.
  underlying: number | null;
  /// Absolute confidence in USD, at the same scale as `price`.
  conf: number;
  confBps: number;
  /// Depth of the pools backing the quote, USD.
  liquidity: number;
  /// Fraction, not percent.
  change24h: number;
  /// Seconds. The source's timestamp where it publishes one.
  publishTime: number;
}

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

/// Which trading session the *underlying* equity is in. The token trades
/// around the clock; the thing it references does not, and the program prices
/// that difference through `Market::session`.
export enum Session {
  Regular = 0,
  Extended = 1,
  Closed = 2,
}

/// The keyless endpoints are shared across every caller here — the price loop,
/// the bootstrap and the discovery scripts all draw on one budget — so a 429 is
/// routine rather than exceptional. Waiting one out is almost always right;
/// failing the call just pushes the same retry onto each caller separately.
async function getJson(url: string, timeoutMs = 8_000, tries = 4): Promise<any> {
  let wait = 2_000;
  for (let attempt = 0; ; attempt++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await fetch(url, { signal: ctl.signal });
      if (r.ok) return await r.json();
      if (r.status !== 429 || attempt >= tries - 1) {
        throw new Error(`${r.status} ${r.statusText} for ${url}`);
      }
    } finally {
      clearTimeout(timer);
    }
    await new Promise((r) => setTimeout(r, wait));
    wait = Math.min(20_000, wait * 2);
  }
}

/// How uncertain the price is, in basis points.
///
/// There is no published confidence interval for a DEX quote, so this is built
/// from the two things that genuinely make one uncertain. The first is basis:
/// the gap between what the token trades at and what the equity behind it last
/// printed, which is real disagreement and not noise. The second is depth,
/// because a price struck in a thin pool is a weaker claim about value than the
/// same price struck in a deep one.
///
/// It is deliberately not clamped. A market whose token has decoupled from its
/// underlying *should* trip `max_conf_bps` and halt -- that check exists for
/// exactly this, and capping the input to keep it quiet would disable it.
function confBpsFor(price: number, underlying: number | null, liquidity: number): number {
  const basisBps =
    underlying && underlying > 0 ? (Math.abs(price - underlying) / price) * 10_000 : 0;
  const liqBps =
    liquidity > 0 ? LIQ_REF_BPS * Math.sqrt(LIQ_REF_USD / liquidity) : LIQ_REF_BPS * 10;
  return Math.max(MIN_CONF_BPS, basisBps + liqBps);
}

/// Last good response, kept on disk.
///
/// The price source is a free public endpoint and it rate-limits, which on a
/// laptop means a failed bootstrap rather than a stale price — and a developer
/// who cannot start a validator because someone else's API is busy. The cache
/// is only ever a fallback: a live response always wins and always replaces
/// it, and the age is printed so nobody mistakes a cached quote for a current
/// one. It is not used by the running server, which needs live prices or none.
const CACHE_PATH = path.join(__dirname, "..", ".quote-cache.json");

function cacheQuotes(out: Record<string, LiveQuote>) {
  try {
    fs.writeFileSync(CACHE_PATH, JSON.stringify({ at: Date.now(), quotes: out }));
  } catch { /* a cache that cannot be written is not worth failing over */ }
}

function cachedQuotes(): Record<string, LiveQuote> | null {
  try {
    const { at, quotes } = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
    const mins = Math.round((Date.now() - at) / 60_000);
    console.warn(`  price source unavailable — using quotes from ${mins}m ago`);
    return quotes;
  } catch {
    return null;
  }
}

/// Current quotes for every market, in one request.
export async function fetchQuotes(
  markets: MarketDef[] = MARKETS
): Promise<Record<string, LiveQuote>> {
  let data: any;
  try {
    data = await getJson(`${JUP_PRICE}?ids=${markets.map((m) => m.mint).join(",")}`);
  } catch (e) {
    const fallback = cachedQuotes();
    if (fallback) return fallback;
    throw e;
  }
  const out: Record<string, LiveQuote> = {};

  for (const m of markets) {
    const d = data?.[m.mint];
    const price = Number(d?.usdPrice);
    if (!Number.isFinite(price) || price <= 0) continue;

    const underlying = Number(d?.stockData?.price);
    const liquidity = Number(d?.liquidity) || 0;
    const confBps = confBpsFor(price, Number.isFinite(underlying) ? underlying : null, liquidity);
    // Jupiter timestamps the equity print, not the pool quote; the pool quote
    // is current as of the block it names, so `now` is the honest reading.
    out[m.symbol] = {
      symbol: m.symbol,
      price,
      underlying: Number.isFinite(underlying) ? underlying : null,
      conf: (price * confBps) / 10_000,
      confBps,
      liquidity,
      change24h: Number(d?.priceChange24h) / 100 || 0,
      publishTime: Math.floor(Date.now() / 1000),
    };
  }
  cacheQuotes(out);
  return out;
}

const INTERVALS: Record<number, string> = {
  60: "1_MINUTE",
  300: "5_MINUTE",
  900: "15_MINUTE",
};

/// Real OHLC history for a market, where the source has it.
///
/// Jupiter publishes nothing finer than a minute, so the sub-minute chart
/// timeframes have no history to seed and fill from live ticks instead. That
/// is the honest answer: the alternative is a synthetic warm-up, which is what
/// this whole change exists to remove.
export async function fetchCandles(
  market: MarketDef,
  tfSeconds: number,
  count = 300
): Promise<Candle[]> {
  const interval = INTERVALS[tfSeconds];
  if (!interval) return [];
  const to = Math.floor(Date.now() / 1000) * 1000;
  const d = await getJson(
    `${JUP_CHARTS}/${market.mint}?interval=${interval}&to=${to}&candles=${count}&type=price`
  );
  return (d?.candles ?? [])
    .map((c: any) => ({
      time: Number(c.time),
      open: Number(c.open),
      high: Number(c.high),
      low: Number(c.low),
      close: Number(c.close),
    }))
    .filter((c: Candle) => Number.isFinite(c.time) && c.close > 0);
}

/// Trading calendar for each market's underlying equity, from Pyth's feed
/// metadata. Only the metadata endpoint is keyless, which is all this needs.
export async function fetchSessions(
  markets: MarketDef[] = MARKETS
): Promise<Record<string, Session>> {
  const out: Record<string, Session> = {};
  const ids = markets.map((m) => `ids[]=${m.underlyingFeedId}`).join("&");
  const feeds = await getJson(`${PYTH_META}?${ids}`);
  const byId: Record<string, any> = {};
  for (const f of feeds ?? []) byId[String(f.id).toLowerCase()] = f;

  for (const m of markets) {
    const f = byId[m.underlyingFeedId.toLowerCase()];
    if (!f?.market_hours) continue;
    out[m.symbol] = f.market_hours.is_open ? Session.Regular : Session.Closed;
  }
  return out;
}
