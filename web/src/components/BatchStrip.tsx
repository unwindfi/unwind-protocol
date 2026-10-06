/*
 * The batch in one line, along the chart's bottom edge: how long this market's
 * window has left, where it last cleared and how long ago, and whether the
 * mark is fresh enough to take an order.
 *
 * It asks the server for nothing. The batch is the page's own half-second
 * poll and the mark age rides on the market list, so the strip only decides
 * how often to recompute the countdown. The bars on the right are what the
 * strip has seen since the page opened, five seconds a bar: a violet bar is a
 * clear, a red one a mark too old to trade on.
 */
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { StatusBar as History, StatusBarPlot, StatusBarTooltip,
  type StatusBarDatum, type StatusBarStatus } from "@/components/beui/status-bar";
import { phaseOf, useNow } from "@/components/BatchClock";
import type { Batch, Market } from "@/lib/api";
import { clock, hhmmss, price } from "@/lib/format";
import { cn } from "@/lib/utils";

const BUCKET_MS = 5_000;
const BUCKETS = 24;

const STATES: StatusBarStatus[] = [
  { id: "cleared", label: "Batch cleared", color: "var(--color-tab)" },
  { id: "fresh", label: "Mark fresh", color: "color-mix(in srgb, var(--color-foreground) 22%, transparent)" },
  { id: "stale", label: "Mark too old", color: "var(--color-down)" },
  { id: "none", label: "Not watched", color: "var(--color-panel2)" },
];

type Seen = { cleared?: number; stale?: boolean; fresh?: boolean };

/// "12s", "4m", "3h", "2d": how long ago, at the coarsest unit that is not zero.
export const ago = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86_400)}d`;
};

const clearPrice = (b: Batch | null | undefined) =>
  b?.last ? (b.last.buyPrice ?? b.last.sellPrice) : null;

/// What the strip has seen, bucketed. Fed from the polls the page already
/// runs; a new bucket state bumps `version`, nothing else re-renders it.
function useHistory(m: Market, batch: Batch | null | undefined) {
  const seen = useRef(new Map<number, Seen>());
  const [version, setVersion] = useState(0);
  useEffect(() => { seen.current = new Map(); setVersion((v) => v + 1); }, [m.symbol]);

  const stale = m.priceAgeMs != null && m.priceAgeMs / 1000 > m.maxPriceAgeSec;
  const known = m.priceAgeMs != null;
  const lastT = batch?.last?.t;
  const lastPx = clearPrice(batch);
  useEffect(() => {
    const map = seen.current;
    let changed = false;
    const put = (k: number, patch: Seen) => {
      const cur = map.get(k) ?? {};
      const next = { ...cur, ...patch };
      if (cur.cleared === next.cleared && cur.stale === next.stale && cur.fresh === next.fresh) return;
      map.set(k, next);
      changed = true;
    };
    const k = Math.floor(Date.now() / BUCKET_MS);
    if (known) put(k, stale ? { stale: true } : { fresh: true });
    if (lastT && lastPx && lastT > (k - BUCKETS) * BUCKET_MS) put(Math.floor(lastT / BUCKET_MS), { cleared: lastPx });
    // Forget what has scrolled off the left.
    for (const key of map.keys()) if (key <= k - BUCKETS) { map.delete(key); changed = true; }
    if (changed) setVersion((v) => v + 1);
  }, [m.symbol, known, stale, m.priceAgeMs, lastT, lastPx]);
  return { seen, version };
}

/// The bars, memoised so the countdown's four-a-second tick does not redraw
/// two dozen animated spans that only change every five seconds.
const HistoryBars = memo(function HistoryBars({ data, label }: { data: StatusBarDatum[]; label: string }) {
  return (
    <History data={data} statuses={STATES} label={label} className="space-y-0">
      <StatusBarPlot showLabels={false} trackClassName="h-6 [&>div]:gap-px" barClassName="h-3 rounded-[1px]" />
      <StatusBarTooltip side="top">
        {({ datum, status }) => (
          <span className="flex flex-col gap-0.5 text-[11.5px]">
            <span className="n text-muted-foreground">{datum.label}</span>
            <span className="font-medium">{status.label}</span>
            {datum.description && <span className="n text-muted-foreground">{datum.description}</span>}
          </span>
        )}
      </StatusBarTooltip>
    </History>
  );
});

export function BatchStrip({ m, batch, condensed = false, className }: {
  m: Market;
  /// The page's own batch poll.
  batch: Batch | null | undefined;
  /// The phone's cut: the countdown, and the last clear when it fits.
  condensed?: boolean;
  className?: string;
}) {
  const now = useNow(250);
  const { seen, version } = useHistory(m, batch);
  const bucket = Math.floor(now / BUCKET_MS);

  const data = useMemo<StatusBarDatum[]>(() => Array.from({ length: BUCKETS }, (_, i) => {
    const k = bucket - (BUCKETS - 1 - i);
    const s = seen.current.get(k);
    const status = s?.cleared ? "cleared" : s?.stale ? "stale" : s?.fresh ? "fresh" : "none";
    return {
      id: String(k),
      label: hhmmss(k * BUCKET_MS),
      status,
      description: s?.cleared ? `Cleared at ${price(s.cleared)}`
        : status === "stale" ? `Older than ${m.maxPriceAgeSec}s` : undefined,
    };
  // `version` stands in for the ref's contents.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [bucket, version, m.maxPriceAgeSec]);

  // The window.
  let clockText: string;
  let clockLive = false;
  if (!batch?.exists) clockText = "No batch open yet";
  else {
    const { phase, left } = phaseOf(batch, now);
    if (phase === "collecting") { clockText = `Batch #${batch.seq} clears in ${(left / 1000).toFixed(1)}s`; clockLive = true; }
    else if (phase === "idle") clockText = "Next batch opens on your order";
    else if (phase === "opening") clockText = left > 0 ? `Opening auction in ${clock(left)}` : "Opening auction";
    else clockText = `Batch #${batch.seq} clearing`;
  }

  const px = clearPrice(batch);
  const last = batch?.last && px
    ? <>Last clear <span className="n text-foreground">{price(px)}</span>{" "}
        <span className="n">{ago(now - batch.last.t)} ago</span></>
    : <>No clear yet</>;

  const age = m.priceAgeMs;
  const stale = age != null && age / 1000 > m.maxPriceAgeSec;

  return (
    <div className={cn("@container flex h-8 min-w-0 flex-none items-center gap-4 border-t border-line",
      "text-[11.5px] text-muted-foreground", className)}>
      <span role="timer" aria-label={clockText}
        className={cn("n flex-none whitespace-nowrap", clockLive ? "text-foreground" : "")}>
        {clockText}
      </span>
      <span className={cn("min-w-0 truncate whitespace-nowrap",
        condensed ? "hidden @[400px]:inline" : "hidden @[360px]:inline")}>
        {last}
      </span>
      {!condensed && (
        <span className="hidden flex-none whitespace-nowrap @[520px]:inline"
          title={`Orders are refused once the mark is older than ${m.maxPriceAgeSec}s.`}>
          Mark{" "}
          <span className={cn("n", stale ? "text-down" : "text-foreground")}>
            {age == null ? "n/a" : `${ago(age)} old`}
          </span>
          <span className="n"> / {m.maxPriceAgeSec}s max</span>
        </span>
      )}
      {!condensed && (
        <div className="ml-auto hidden min-w-[72px] max-w-[200px] flex-1 @[500px]:block">
          <HistoryBars data={data} label={`${m.symbol} batches and mark, last 2 minutes`} />
        </div>
      )}
    </div>
  );
}
