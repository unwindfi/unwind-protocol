import { useEffect, useState, type ReactNode } from "react";
import { Eraser, Maximize2, Minimize2, PenLine } from "lucide-react";
import { Chart, INDICATOR_COLORS, type ChartIndicators } from "@/components/Chart";
import { Tabs, TabsList, TabsTrigger } from "@/components/Tabs";
import { getBatch, useHasBackend, type Account, type Batch, type Market } from "@/lib/api";
import { cn } from "@/lib/utils";
import { CHART_TFS } from "./bars";
import { accountLines, type ChartLine } from "./lines";
import { DepthView, FundingView, InfoView, type FundingSample } from "./views";

type View = "chart" | "depth" | "funding" | "info";

/*
 * The viewer's chart settings, kept across visits on this browser only. A
 * blocked or empty store just means the defaults.
 */
type Prefs = { kind: "auto" | "candles" | "line"; ind: ChartIndicators; log: boolean; trim: boolean };
const PREFS_KEY = "unwind.chart";
const DEFAULTS: Prefs = { kind: "auto", ind: {}, log: false, trim: false };
function readPrefs(): Prefs {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") }; }
  catch { return DEFAULTS; }
}

/// A toggle in the chart's toolbar, in the house pill: inverted when on.
function Pill({ on, onClick, children, title }: {
  on: boolean; onClick: () => void; children: ReactNode; title?: string;
}) {
  return (
    <button type="button" aria-pressed={on} title={title} onClick={onClick}
      className={cn("h-7 flex-none rounded-full px-3 text-[12px] font-medium transition-colors",
        on ? "bg-foreground text-background"
           : "text-muted-foreground hover:bg-panel2 hover:text-foreground")}>
      {children}
    </button>
  );
}

function IconButton({ on = false, onClick, label, children }: {
  on?: boolean; onClick: () => void; label: string; children: ReactNode;
}) {
  return (
    <button type="button" aria-label={label} title={label} aria-pressed={on} onClick={onClick}
      className={cn("grid size-7 flex-none place-items-center rounded-full transition-colors",
        on ? "bg-foreground text-background"
           : "text-muted-foreground hover:bg-panel2 hover:text-foreground")}>
      {children}
    </button>
  );
}

const Sep = () => <span className="mx-1 h-4 w-px flex-none bg-line" />;

/*
 * The chart with the views a trader flips to beside it: the batch's depth,
 * funding, and the market's parameters.
 *
 * Everything is optional past the market. The timeframe is the caller's when
 * it passes one and this component's own otherwise; the batch and the account
 * are read from props when the page already polls them, and the batch is
 * fetched here, only while its tab is open, when it does not.
 */
export function ChartPanel({
  market, tf: tfProp, onTf, account, batch: batchProp, lines, compact = false,
  showTimeframes = true, className,
}: {
  market: Market;
  tf?: number; onTf?: (tf: number) => void;
  /// The connected account. Its position and trigger orders in this market
  /// are drawn as lines.
  account?: Account | null;
  /// The page's own batch poll, when it has one. Undefined means fetch here.
  batch?: Batch | null;
  /// Overrides the lines derived from `account`.
  lines?: ChartLine[];
  compact?: boolean;
  /// Off when the page already shows timeframes somewhere else.
  showTimeframes?: boolean;
  className?: string;
}) {
  const symbol = market.symbol;
  const [view, setView] = useState<View>("chart");
  const [ownTf, setOwnTf] = useState(300);
  const tf = tfProp ?? ownTf;
  const setTf = (v: number) => { setOwnTf(v); onTf?.(v); };
  const [prefs, setPrefs] = useState(readPrefs);
  const set = (p: Partial<Prefs>) => setPrefs((cur) => {
    const next = { ...cur, ...p };
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(next)); } catch { /* defaults next time */ }
    return next;
  });
  const [mode, setMode] = useState<"candles" | "line" | null>(null);
  const [full, setFull] = useState(false);
  const [drawMode, setDrawMode] = useState(false);
  const [drawings, setDrawings] = useState<Record<string, number[]>>({});
  const hasBackend = useHasBackend();

  // Fetched here only when the page did not pass a batch in.
  const [ownBatch, setOwnBatch] = useState<Batch | null>(null);
  const fetchBatch = batchProp === undefined && view === "depth";
  useEffect(() => {
    setOwnBatch(null);
    if (!fetchBatch) return;
    let alive = true;
    let timer: number | undefined;
    const run = async () => {
      try { const b = await getBatch(symbol); if (alive) setOwnBatch(b); } catch { /* keep */ }
      if (alive) timer = window.setTimeout(run, 1500);
    };
    run();
    return () => { alive = false; clearTimeout(timer); };
  }, [fetchBatch, symbol]);
  const batch = batchProp === undefined ? ownBatch : batchProp;

  // Funding indices as they arrive, so the funding tab can measure a rate.
  const [samples, setSamples] = useState<FundingSample[]>([]);
  useEffect(() => { setSamples([]); }, [symbol]);
  useEffect(() => {
    setSamples((s) => {
      const last = s[s.length - 1];
      if (last && last.long === market.fundingLong && last.short === market.fundingShort) return s;
      return [...s.slice(-20), { t: Date.now(), long: market.fundingLong, short: market.fundingShort }];
    });
  }, [market.fundingLong, market.fundingShort]);

  useEffect(() => {
    if (!full) return;
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") setFull(false); };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [full]);

  const marks = drawings[symbol] ?? [];
  const drawn = (p: number) => {
    setDrawings((d) => ({ ...d, [symbol]: [...(d[symbol] ?? []), p] }));
    setDrawMode(false);
  };
  const shown = mode ?? (prefs.kind === "line" ? "line" : "candles");

  return (
    <div className={cn("flex min-h-0 min-w-0 flex-col",
      full ? "fixed inset-0 z-50 bg-panel p-3 safe-t safe-b" : "flex-1", className)}>
      <div className="flex flex-none items-center justify-between gap-2 pb-2">
        <Tabs value={view} onValueChange={(v) => setView(v as View)}>
          <TabsList>
            <TabsTrigger value="chart">Chart</TabsTrigger>
            <TabsTrigger value="depth">Depth</TabsTrigger>
            <TabsTrigger value="funding">Funding</TabsTrigger>
            <TabsTrigger value="info">Info</TabsTrigger>
          </TabsList>
        </Tabs>
        <IconButton onClick={() => setFull((f) => !f)} label={full ? "Exit full screen" : "Full screen"}>
          {full ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
        </IconButton>
      </div>

      {view === "chart" && (
        <div className="strip-scroll flex flex-none items-center gap-1 pb-2">
          {showTimeframes && <>
            {CHART_TFS.map((t) => (
              <Pill key={t.v} on={tf === t.v} onClick={() => setTf(t.v)}>{t.l}</Pill>
            ))}
            <Sep />
          </>}
          <Pill on={shown === "candles"} onClick={() => set({ kind: "candles" })}>Candles</Pill>
          <Pill on={shown === "line"} onClick={() => set({ kind: "line" })}
            title="Closes only">Line</Pill>
          <Sep />
          <Pill on={!!prefs.ind.ma20} onClick={() => set({ ind: { ...prefs.ind, ma20: !prefs.ind.ma20 } })}
            title="Simple average of the last 20 closes">MA 20</Pill>
          <Pill on={!!prefs.ind.ema50} onClick={() => set({ ind: { ...prefs.ind, ema50: !prefs.ind.ema50 } })}
            title="Exponential average of the last 50 closes">EMA 50</Pill>
          <Pill on={prefs.log} onClick={() => set({ log: !prefs.log })} title="Log price scale">Log</Pill>
          <Pill on={prefs.trim} onClick={() => set({ trim: !prefs.trim })}
            title="Cap wicks at 3x the median bar range">Trim wicks</Pill>
          <Sep />
          <IconButton on={drawMode} onClick={() => setDrawMode((d) => !d)}
            label={drawMode ? "Cancel line" : "Draw a price line"}>
            <PenLine size={15} />
          </IconButton>
          {marks.length > 0 && (
            <IconButton onClick={() => setDrawings((d) => ({ ...d, [symbol]: [] }))}
              label="Clear drawn lines">
              <Eraser size={15} />
            </IconButton>
          )}
        </div>
      )}

      {/* Kept mounted behind the other tabs, so flipping to depth and back
          keeps the bars loaded and wherever the viewer had scrolled to. */}
      <div className={cn("relative min-h-0 flex-1 flex-col", view === "chart" ? "flex" : "hidden")}>
        <Legend ind={prefs.ind} trim={prefs.trim && shown === "candles"} drawMode={drawMode} />
        <Chart symbol={symbol} price={market.price} tf={tf} compact={compact}
          kind={prefs.kind} indicators={prefs.ind} logScale={prefs.log} trimWicks={prefs.trim}
          lines={lines ?? accountLines(account, symbol)}
          drawings={marks} drawMode={drawMode} onDraw={drawn} onModeChange={setMode} />
      </div>
      {view === "depth" && <DepthView m={market} batch={batch} hasBackend={hasBackend} />}
      {view === "funding" && <FundingView m={market} samples={samples} />}
      {view === "info" && <InfoView m={market} />}
    </div>
  );
}

/// What is drawn on the chart that its axis does not explain.
function Legend({ ind, trim, drawMode }: { ind: ChartIndicators; trim: boolean; drawMode: boolean }) {
  const items: ReactNode[] = [];
  const swatch = (k: keyof typeof INDICATOR_COLORS, label: string) => (
    <span key={k} className="flex items-center gap-1.5">
      <span className="h-0.5 w-3 rounded-full" style={{ background: `var(${INDICATOR_COLORS[k]})` }} />
      {label}
    </span>
  );
  if (ind.ma20) items.push(swatch("ma20", "MA 20"));
  if (ind.ema50) items.push(swatch("ema50", "EMA 50"));
  if (trim) items.push(<span key="trim">Wicks trimmed to 3x median range</span>);
  if (drawMode) items.push(<span key="draw" className="text-foreground">Tap a price to draw a line</span>);
  if (items.length === 0) return null;
  return (
    <div className="pointer-events-none absolute left-1 top-1 z-10 flex flex-wrap gap-x-3 gap-y-1
                    rounded-[6px] bg-panel/80 px-2 py-1 text-[11px] text-muted-foreground">
      {items}
    </div>
  );
}
