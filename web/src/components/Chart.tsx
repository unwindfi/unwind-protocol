import { useEffect, useRef, useState } from "react";
import {
  CandlestickSeries, CrosshairMode, LineSeries, LineStyle, PriceScaleMode, createChart,
  type IChartApi, type IPriceLine, type ISeriesApi, type MouseEventParams,
} from "lightweight-charts";
import type { Position } from "@/lib/api";
import { useTheme } from "@/lib/theme";
import { ema, isFlat, loadBars, peekBars, sma, trimBar, wickCap, type Bar } from "@/components/chart/bars";
import { TITLES, positionLevels, type ChartLine } from "@/components/chart/lines";

const css = (n: string) => getComputedStyle(document.body).getPropertyValue(n).trim();

/*
 * How many bars to show at once.
 *
 * `fitContent` puts the whole series on screen, which on a 375px phone meant
 * ~300 candles at roughly one device pixel each: a field of noise with no
 * readable body or wick. Showing a window instead gives each candle real width;
 * the rest of the history is still loaded and a pinch or drag reaches it.
 */
const VISIBLE_BARS_MOBILE = 55;

/// `auto` is the old behaviour: candles when the bars carry a range, a line
/// of closes when they do not.
export type ChartKind = "auto" | "candles" | "line";
export interface ChartIndicators { ma20?: boolean; ema50?: boolean }

/// Indicator colours, as tokens so both themes read them. Neither is the up or
/// down colour, so an average is never mistaken for a candle.
export const INDICATOR_COLORS = { ma20: "--color-road-3", ema50: "--color-brand" } as const;

const LINE_STYLE: Record<ChartLine["kind"], { color: string; style: LineStyle }> = {
  entry: { color: "--color-brand", style: LineStyle.Dashed },
  liq: { color: "--color-down", style: LineStyle.Dotted },
  tp: { color: "--color-up", style: LineStyle.Dashed },
  sl: { color: "--color-down", style: LineStyle.Dashed },
  limit: { color: "--color-dim", style: LineStyle.Dashed },
  drawn: { color: "--color-dim", style: LineStyle.Solid },
};

export function Chart({
  symbol, price, tf, position, compact = false,
  kind = "auto", indicators, logScale = false, trimWicks = false,
  lines, drawings, drawMode = false, onDraw, onModeChange,
}: {
  symbol: string; price?: number; tf: number; position?: Position;
  /// Phone sizing: fewer bars on screen, smaller axis type, tighter margins.
  compact?: boolean;
  kind?: ChartKind;
  indicators?: ChartIndicators;
  logScale?: boolean;
  /// Caps each wick at a multiple of the median bar range. Display only; the
  /// caller is expected to say on screen that it is on.
  trimWicks?: boolean;
  /// Levels to draw. When given, these replace the entry and liquidation
  /// lines `position` would draw, so a caller can add TP, SL and limits.
  lines?: ChartLine[];
  /// Horizontal lines the viewer placed, and the click that places one.
  drawings?: number[];
  drawMode?: boolean;
  onDraw?: (price: number) => void;
  /// What `auto` resolved to, so a toolbar can show which one is on.
  onModeChange?: (mode: "candles" | "line") => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<ISeriesApi<"Candlestick" | "Line"> | null>(null);
  const mode = useRef<"candles" | "line" | null>(null);
  const studies = useRef<{ ma20?: ISeriesApi<"Line">; ema50?: ISeriesApi<"Line"> }>({});
  // Every bar loaded, with the live price folded into the last one.
  const raw = useRef<Bar[]>([]);
  const cap = useRef<number | null>(null);
  const fit = useRef(false);
  const priceLines = useRef<IPriceLine[]>([]);
  // Which market the series holds. Without it a poll can append one market's
  // price to another's bars during a switch and blow out the scale.
  const loaded = useRef<string | null>(null);
  const token = useRef(0);
  const [data, setData] = useState(0);
  const [seriesVersion, setSeriesVersion] = useState(0);
  // Read from the click handler, which is subscribed once per chart.
  const draw = useRef({ drawMode, onDraw, onModeChange });
  draw.current = { drawMode, onDraw, onModeChange };
  /*
   * The chart is a canvas, so it is the one surface a CSS variable cannot
   * reach on its own: every colour was read once at creation and painted in.
   * Re-reading them when the theme changes is cheaper and far less disruptive
   * than rebuilding the chart, which would drop the series, the loaded bars
   * and wherever the viewer had scrolled to.
   */
  const { theme } = useTheme();

  useEffect(() => {
    if (!box.current) return;
    const c = createChart(box.current, {
      autoSize: true,
      layout: { background: { color: "transparent" }, textColor: css("--color-dim"),
                fontFamily: css("--font-sans"), fontSize: compact ? 11 : 10,
                attributionLogo: false },
      /*
       * Only the horizontal rules, and no frame. The price levels are what a
       * reader tracks across; vertical rules and axis borders only box the
       * line in, and the page already gives the chart its edges.
       */
      grid: { vertLines: { visible: false },
              horzLines: { color: css("--color-linesoft") } },
      rightPriceScale: {
        borderVisible: false,
        scaleMargins: compact ? { top: .08, bottom: .08 } : { top: .12, bottom: .1 },
      },
      timeScale: {
        borderVisible: false, timeVisible: true,
        // A phone has room for far fewer date labels before they collide.
        ticksVisible: !compact,
      },
      // Kept on touch too: press-and-drag is the only way to read a candle's
      // values on a phone, since there is no hover and no room for a legend.
      crosshair: { mode: CrosshairMode.Normal,
                   vertLine: { color: css("--color-dim"), labelBackgroundColor: css("--color-panel3") },
                   horzLine: { color: css("--color-dim"), labelBackgroundColor: css("--color-panel3") } },
      /*
       * The wheel belongs to the page.
       *
       * The chart lives in a scrolling column now, and a chart that zooms on
       * wheel is a chart you cannot scroll past: the pointer crosses it on
       * the way down the page and the page stops dead while the candles
       * stretch. Dragging still pans, the axes still scale, and pinch still
       * zooms on a touch screen -- every gesture that was deliberate is
       * kept, and the one that was incidental is given back.
       */
      handleScroll: { mouseWheel: false, pressedMouseMove: true,
                      horzTouchDrag: true, vertTouchDrag: false },
      handleScale: { mouseWheel: false, pinch: true, axisPressedMouseMove: true },
      localization: { priceFormatter: (p: number) => p.toFixed(2) },
    });
    const click = (e: MouseEventParams) => {
      const { drawMode, onDraw } = draw.current;
      if (!drawMode || !onDraw || !e.point || !series.current) return;
      const p = series.current.coordinateToPrice(e.point.y);
      if (p != null && Number.isFinite(p)) onDraw(p);
    };
    c.subscribeClick(click);
    chart.current = c;
    return () => {
      c.unsubscribeClick(click);
      c.remove(); chart.current = null; series.current = null; mode.current = null;
      studies.current = {}; priceLines.current = [];
    };
  }, [compact]);

  useEffect(() => {
    let cancelled = false;
    const id = ++token.current;
    loaded.current = null;
    // Draw the last bars this browser saw at once, then the fresh ones. The
    // view is fitted to whichever lands first, so the fresh answer does not
    // yank a chart the trader has already started to read.
    const cached = peekBars(symbol, tf);
    if (cached?.length && chart.current) {
      raw.current = cached;
      fit.current = true;
      loaded.current = symbol;
      setData((d) => d + 1);
    }
    (async () => {
      const bars = await loadBars(symbol, tf);
      if (cancelled || id !== token.current || !chart.current) return;
      raw.current = bars;
      fit.current = !cached?.length;
      loaded.current = symbol;
      setData((d) => d + 1);
    })();
    return () => { cancelled = true; };
  }, [symbol, tf, compact]);

  // Draws what was loaded. Split from the fetch so switching candles to line,
  // or trimming wicks, redraws without going back to the server.
  useEffect(() => {
    const c = chart.current;
    if (!c || loaded.current !== symbol) return;
    const bars = raw.current;

    const want = kind === "auto" ? (isFlat(bars) ? "line" : "candles") : kind;
    if (mode.current !== want) {
      if (series.current) c.removeSeries(series.current);
      series.current = want === "candles"
        ? c.addSeries(CandlestickSeries, {
            upColor: css("--color-up"), downColor: css("--color-down"),
            borderUpColor: css("--color-up"), borderDownColor: css("--color-down"),
            wickUpColor: css("--color-up"), wickDownColor: css("--color-down"),
            priceLineColor: css("--color-brand"), priceLineStyle: LineStyle.Dotted,
          })
        : c.addSeries(LineSeries, { lineWidth: 2, priceLineStyle: LineStyle.Dotted,
                                    crosshairMarkerRadius: 3 });
      mode.current = want;
      draw.current.onModeChange?.(want);
      priceLines.current = [];
      setSeriesVersion((v) => v + 1);
    }

    if (want === "line") {
      // Match the candles' language rather than the accent colour: the accent
      // is this UI's selection colour, so an accent price line reads as chrome.
      const up = bars.length > 1 && bars[bars.length - 1].close >= bars[0].close;
      series.current!.applyOptions({
        color: css(up ? "--color-up" : "--color-down"),
        priceLineColor: css(up ? "--color-up" : "--color-down"),
      } as never);
    }

    cap.current = trimWicks ? wickCap(bars) : null;
    series.current!.setData(
      (want === "candles"
        ? bars.map((b) => trimBar(b, cap.current))
        : bars.map((b) => ({ time: b.time, value: b.close }))) as never
    );
    if (!fit.current) return;
    fit.current = false;
    c.timeScale().applyOptions({ secondsVisible: tf < 60 });
    if (compact && bars.length > VISIBLE_BARS_MOBILE) {
      // A bar of slack at each end: without it the newest candle sits flush
      // against the price scale and the first and last time labels are cut
      // in half by the edges of the pane.
      c.timeScale().setVisibleLogicalRange({
        from: bars.length - VISIBLE_BARS_MOBILE - 1, to: bars.length + 2,
      });
    } else {
      c.timeScale().fitContent();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, kind, trimWicks]);

  /*
   * The averages, rebuilt whenever the price series is. Added after it so they
   * draw on top, and kept off the price scale's labels: two more coloured
   * tags on the axis would crowd the one that matters, the price.
   */
  useEffect(() => {
    const c = chart.current;
    if (!c) return;
    for (const s of Object.values(studies.current)) if (s) c.removeSeries(s);
    studies.current = {};
    if (loaded.current !== symbol || !series.current) return;
    const add = (key: "ma20" | "ema50") => c.addSeries(LineSeries, {
      color: css(INDICATOR_COLORS[key]), lineWidth: 1, priceLineVisible: false,
      lastValueVisible: false, crosshairMarkerVisible: false,
    });
    if (indicators?.ma20) {
      studies.current.ma20 = add("ma20");
      studies.current.ma20.setData(sma(raw.current, 20) as never);
    }
    if (indicators?.ema50) {
      studies.current.ema50 = add("ema50");
      studies.current.ema50.setData(ema(raw.current, 50) as never);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [indicators?.ma20, indicators?.ema50, data, seriesVersion, theme]);

  useEffect(() => {
    chart.current?.priceScale("right").applyOptions({
      mode: logScale ? PriceScaleMode.Logarithmic : PriceScaleMode.Normal,
    });
  }, [logScale, compact]);

  useEffect(() => {
    const c = chart.current;
    if (!c) return;
    c.applyOptions({
      layout: { textColor: css("--color-dim") },
      grid: { horzLines: { color: css("--color-linesoft") } },
      crosshair: {
        vertLine: { color: css("--color-dim"), labelBackgroundColor: css("--color-panel3") },
        horzLine: { color: css("--color-dim"), labelBackgroundColor: css("--color-panel3") },
      },
    });
    // The price lines carry colours of their own and are rebuilt, not
    // recoloured, so this leaves them to the effect that owns them.
    if (series.current && mode.current === "candles") {
      series.current.applyOptions({
        upColor: css("--color-up"), downColor: css("--color-down"),
        borderUpColor: css("--color-up"), borderDownColor: css("--color-down"),
        wickUpColor: css("--color-up"), wickDownColor: css("--color-down"),
        priceLineColor: css("--color-brand"),
      } as never);
    }
  }, [theme, seriesVersion]);

  // Fold the latest price into the forming bar so it grows between fetches.
  useEffect(() => {
    if (!series.current || price == null || loaded.current !== symbol) return;
    const bars = raw.current;
    const bucket = Math.floor(Date.now() / 1000 / tf) * tf;
    const b = bars[bars.length - 1];
    if (!b || b.time < bucket) {
      bars.push({ time: bucket, open: price, high: price, low: price, close: price });
    } else if (b.time === bucket) {
      bars[bars.length - 1] = { ...b, high: Math.max(b.high, price),
                                low: Math.min(b.low, price), close: price };
    } else return;
    const last = bars[bars.length - 1];
    series.current.update(
      (mode.current === "candles"
        ? trimBar(last, cap.current)
        : { time: last.time, value: price }) as never
    );
    const { ma20, ema50 } = studies.current;
    const m = ma20 && sma(bars.slice(-20), 20).pop();
    if (ma20 && m) ma20.update(m as never);
    const e = ema50 && ema(bars, 50).pop();
    if (ema50 && e) ema50.update(e as never);
  }, [price, symbol, tf]);

  const levels = lines ?? (position ? positionLevels(position) : []);
  const levelKey = JSON.stringify([levels, drawings ?? []]);
  useEffect(() => {
    const s = series.current;
    if (!s) return;
    priceLines.current.forEach((l) => s.removePriceLine(l));
    priceLines.current = [];
    const all: ChartLine[] = [
      ...levels, ...(drawings ?? []).map((price) => ({ kind: "drawn" as const, price })),
    ];
    for (const l of all) {
      if (!(l.price > 0)) continue;
      const look = LINE_STYLE[l.kind];
      priceLines.current.push(s.createPriceLine({
        price: l.price, color: css(look.color), lineWidth: 1, lineStyle: look.style,
        axisLabelVisible: true, title: l.title ?? TITLES[l.kind] }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [levelKey, symbol, seriesVersion, theme]);

  return <div ref={box} className={`min-h-0 min-w-0 flex-1 overflow-hidden
                                   ${drawMode ? "cursor-crosshair" : ""}`} />;
}
