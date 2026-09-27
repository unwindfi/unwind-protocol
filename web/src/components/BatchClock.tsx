/*
 * The batch as a clock: a ring that drains over the five-second window, the
 * seconds left inside it, and which batch this is beside it.
 *
 * It lives in the market header because the window is the one thing on this
 * venue that changes what an order does: an order placed with a second left
 * clears with everything else in this batch, and one placed after the ring
 * empties waits for the next. A trader should never have to scroll to learn
 * which of those they are about to be.
 */
import { useEffect, useRef, useState } from "react";
import { getBatch, usePoll, type Batch, type Market } from "@/lib/api";
import { clock, price } from "@/lib/format";

/// How long a batch collects for. Mirrors `BATCH_INTERVAL_SEC` in the program;
/// used only to draw the ring, never to decide anything.
export const WINDOW_MS = 5_000;

/// A clock that ticks faster than the data does.
///
/// The batch is polled once a second, but a countdown that moves once a second
/// reads as a stuck clock rather than a window closing. The remaining time is
/// derived from `clearsAtMs`, which came from the chain; this only decides how
/// often the page recomputes it.
export function useNow(ms: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/// The batch for a market, from the caller when it already polls one and
/// fetched here when it does not.
///
/// The header and the book sit in different branches of the page, and only
/// the book is handed the batch today. Passing `given` (even as null) turns
/// this component's own poll into a no-op, so a parent that owns the poll can
/// hand it down without the page asking the server twice a second.
export function useBatch(symbol: string, given?: Batch | null) {
  const own = usePoll(
    () => (given === undefined ? getBatch(symbol) : Promise.resolve(null)),
    1000, [symbol, given === undefined]);
  return given === undefined ? own : given;
}

export type Phase =
  /// Taking orders, with time left on the window.
  | "collecting"
  /// The window is up and orders are in it: the crank has not landed yet.
  | "clearing"
  /// The window is up and nothing is in it. The crank skips an empty batch,
  /// so "clearing" would sit there forever; the first order clears next pass.
  | "idle"
  /// A listed market still seasoning: orders rest until the mark is ready.
  | "opening";

export function phaseOf(b: Batch, now: number): { phase: Phase; left: number } {
  if (b.opening) return { phase: "opening", left: Math.max(0, b.opening.opensAtMs - now) };
  const left = b.clearsAtMs - now;
  if (!b.sealed && left > 0) return { phase: "collecting", left };
  if (!b.sealed && b.resting.length === 0) return { phase: "idle", left: 0 };
  return { phase: "clearing", left: 0 };
}

const LABEL: Record<Phase, string> = {
  collecting: "Collecting",
  clearing: "Clearing",
  idle: "Waiting for orders",
  opening: "Opening auction",
};

const reducedMotion = () =>
  typeof window !== "undefined"
  && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/// The ring on its own.
///
/// The drain is one Web Animation per batch, started at the right point of the
/// window and left to the browser, so the ring moves at display rate without
/// React rendering anything to move it. The figure in the middle is the only
/// part that re-renders, four times a second. With reduced motion there is no
/// animation: the ring steps with that figure instead of sliding.
export function BatchRing({ batch, size = 34 }: { batch: Batch; size?: number }) {
  const now = useNow(250);
  const { phase, left } = phaseOf(batch, now);
  const arc = useRef<SVGCircleElement>(null);

  const stroke = size >= 30 ? 3 : 2.5;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;

  // How full the ring is: the time left in the window, or for an opening
  // auction the readings the mark has earned so far, which fills rather than
  // drains because nobody is racing it.
  const frac = phase === "opening"
    ? Math.min(1, batch.opening!.readings / Math.max(1, batch.opening!.readingsNeeded))
    : phase === "collecting" ? Math.min(1, left / WINDOW_MS) : 0;

  const live = phase === "collecting" && !reducedMotion();
  useEffect(() => {
    const el = arc.current;
    if (!live || !el?.animate) return;
    const elapsed = WINDOW_MS - (batch.clearsAtMs - Date.now());
    const a = el.animate(
      [{ strokeDashoffset: "0" }, { strokeDashoffset: String(c) }],
      { duration: WINDOW_MS, iterations: 1, fill: "forwards", easing: "linear" });
    a.currentTime = Math.max(0, Math.min(WINDOW_MS, elapsed));
    return () => a.cancel();
  }, [live, batch.clearsAtMs, c]);

  const centre = phase === "collecting" ? String(Math.ceil(left / 1000))
    : phase === "opening" ? "" : "0";

  return (
    <span className="relative grid flex-none place-items-center"
      style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}
        className="absolute inset-0 -rotate-90" aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke}
          className="stroke-panel3" />
        <circle ref={arc} cx={size / 2} cy={size / 2} r={r} fill="none"
          strokeWidth={stroke} strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={live ? undefined : c * (1 - frac)}
          className={phase === "clearing" ? "stroke-dim" : "stroke-foreground"} />
      </svg>
      <span className={`n relative text-[11.5px] font-semibold leading-none
                        ${phase === "collecting" ? "" : "text-dim"}`}>
        {centre}
      </span>
    </span>
  );
}

/// The ring with what it is counting: batch number over state.
///
/// `compact` is the phone header's cut: the ring and one line, because that
/// row is already carrying the market and its price.
export function BatchClock({ m, batch: given, compact = false }: {
  m: Market; batch?: Batch | null; compact?: boolean;
}) {
  const batch = useBatch(m.symbol, given);
  const now = useNow(250);
  // No chain behind this deploy, or no batch opened yet: nothing to count.
  if (!batch?.exists) return null;
  const { phase, left } = phaseOf(batch, now);

  const detail = phase === "collecting" ? `${(left / 1000).toFixed(1)}s`
    : phase === "opening" ? (left > 0 ? `opens ${clock(left)}` : "opening")
    : phase === "idle" ? "clears on first order"
    : batch.resting.length ? `${batch.resting.length} orders` : "";

  return (
    <div className="flex flex-none items-center gap-2.5"
      role="timer" aria-label={`Batch ${batch.seq}, ${LABEL[phase]}`}>
      <BatchRing batch={batch} size={compact ? 26 : 34} />
      {compact ? (
        <span className="hidden text-[11px] leading-tight text-muted-foreground min-[380px]:block">
          <span className="n block text-foreground">#{batch.seq}</span>
          {phase === "idle" ? "waiting" : phase}
        </span>
      ) : (
        <span className="leading-tight">
          <span className="block text-[12px] text-muted-foreground">
            Batch <span className="n text-foreground">#{batch.seq}</span>
          </span>
          <span className="block whitespace-nowrap text-[12.5px] font-medium">
            {LABEL[phase]}
            {detail && <span className="n ml-1.5 font-normal text-muted-foreground">{detail}</span>}
          </span>
        </span>
      )}
    </div>
  );
}

/// The market's price in the browser tab, so a trader with the page behind
/// another window can still read it. Puts back whatever title was there when
/// the market view goes away.
export function usePriceTitle(m: Market | null | undefined) {
  useEffect(() => {
    const before = document.title;
    return () => { document.title = before; };
  }, []);
  const label = m ? `${price(m.price)} ${m.symbol} · unwind` : null;
  useEffect(() => {
    if (label) document.title = label;
  }, [label]);
}
