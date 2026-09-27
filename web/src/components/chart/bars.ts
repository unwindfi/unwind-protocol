import { getCandles, peek } from "@/lib/api";

export type Bar = { time: number; open: number; high: number; low: number; close: number };

/// What the candle source itself publishes. Jupiter carries 1m, 5m and 15m and
/// nothing else; the server passes those through and fills below a minute from
/// its own tape.
const SOURCE_TFS = [60, 300, 900];

/// Every timeframe the chart offers. The hour frames are built here out of real
/// 15m bars, so they cover what the source returned (about three days) and no
/// more. A daily frame would be three candles, so it is not offered.
export const CHART_TFS = [
  { v: 60, l: "1m" }, { v: 300, l: "5m" }, { v: 900, l: "15m" },
  { v: 3600, l: "1h" }, { v: 14400, l: "4h" },
];

/// Rolls finer bars up into `tf`-second buckets.
///
/// The first bucket is dropped when the finer bars start partway into it: its
/// open would be whatever the window happened to begin on, which is not the
/// bucket's open.
export function aggregate(bars: Bar[], tf: number): Bar[] {
  const out: Bar[] = [];
  for (const b of bars) {
    const t = Math.floor(b.time / tf) * tf;
    const cur = out[out.length - 1];
    if (!cur || cur.time !== t) {
      out.push({ time: t, open: b.open, high: b.high, low: b.low, close: b.close });
    } else {
      cur.high = Math.max(cur.high, b.high);
      cur.low = Math.min(cur.low, b.low);
      cur.close = b.close;
    }
  }
  if (bars.length && out.length > 1 && bars[0].time !== out[0].time) out.shift();
  return out;
}

/// The bars last seen for this chart, from the browser's cache, so it can
/// draw before the network answers. Null when there are none.
export function peekBars(symbol: string, tf: number): Bar[] | null {
  const read = (t: number) => peek<Bar[]>(`/api/candles/${symbol}?tf=${t}`);
  if (tf < 60 || SOURCE_TFS.includes(tf)) return read(tf);
  const base = [...SOURCE_TFS].reverse().find((s) => tf % s === 0);
  const bars = read(base ?? tf);
  return bars && base ? aggregate(bars, tf) : bars;
}

export async function loadBars(symbol: string, tf: number): Promise<Bar[]> {
  if (tf < 60 || SOURCE_TFS.includes(tf)) return (await getCandles(symbol, tf)) as Bar[];
  const base = [...SOURCE_TFS].reverse().find((s) => tf % s === 0);
  if (!base) return (await getCandles(symbol, tf)) as Bar[];
  return aggregate((await getCandles(symbol, base)) as Bar[], tf);
}

/// A bar with no range carries no information a candle can draw.
///
/// Jupiter publishes no intra-minute range for these mints, so a 1m candlestick
/// is 300 dojis in a row, which reads as a broken chart rather than as the
/// "we only know the close" that it actually is. Decided from the data rather
/// than hardcoded per timeframe, so the chart upgrades itself if the source
/// ever starts carrying range.
const FLAT_RATIO = 0.7;
export const isFlat = (bars: Bar[]) =>
  bars.length > 0 &&
  bars.filter((b) => b.high === b.low).length / bars.length > FLAT_RATIO;

export type Point = { time: number; value: number };

export function sma(bars: Bar[], n: number): Point[] {
  const out: Point[] = [];
  let sum = 0;
  bars.forEach((b, i) => {
    sum += b.close;
    if (i >= n) sum -= bars[i - n].close;
    if (i >= n - 1) out.push({ time: b.time, value: sum / n });
  });
  return out;
}

/// Seeded with the simple average of the first `n` closes, the usual start.
export function ema(bars: Bar[], n: number): Point[] {
  if (bars.length < n) return [];
  const k = 2 / (n + 1);
  let v = bars.slice(0, n).reduce((s, b) => s + b.close, 0) / n;
  const out: Point[] = [{ time: bars[n - 1].time, value: v }];
  for (let i = n; i < bars.length; i++) {
    v = bars[i].close * k + v * (1 - k);
    out.push({ time: bars[i].time, value: v });
  }
  return out;
}

/*
 * The longest wick a trimmed bar may show, as a multiple of the median range.
 *
 * A pool-priced market's tape is its pool's fills, and one thin fill can print
 * a wick ten times the size of every bar around it, squashing the rest of the
 * chart into a line. Trimming is a display choice the viewer turns on, the
 * chart says it is on, and only wicks are touched: opens and closes are drawn
 * as they are.
 */
const WICK_CAP = 3;

export function wickCap(bars: Bar[]): number | null {
  const ranges = bars.map((b) => b.high - b.low).filter((r) => r > 0).sort((a, b) => a - b);
  if (ranges.length === 0) return null;
  return ranges[Math.floor(ranges.length / 2)] * WICK_CAP;
}

export function trimBar(b: Bar, cap: number | null): Bar {
  if (cap == null) return b;
  const top = Math.max(b.open, b.close), bottom = Math.min(b.open, b.close);
  return { ...b, high: Math.min(b.high, top + cap), low: Math.max(b.low, bottom - cap) };
}
