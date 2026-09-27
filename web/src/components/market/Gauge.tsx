import type { ReactNode } from "react";

/*
 * A dial, drawn as a row of ticks bent into a half circle.
 *
 * It reports one ratio, and it is here because a ratio is the one thing a
 * column of figures reads badly: "$1.2M free of $4.1M" is two numbers to
 * divide, while a dial three-quarters round has already done it.
 *
 * Ticks rather than an arc. A solid sweep invites the eye to read a precise
 * angle it cannot actually resolve, which is a precision this number does not
 * have -- what is free moves with every fill. Nineteen segments say "about
 * this much" and mean it.
 */
const TICKS = 19;

const clamp01 = (n: number) => (Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0);

export function Gauge({ value, display, caption, tone = "fill-brand", compact = false }: {
  /// 0 to 1. Anything else -- a division by zero, a market with no capacity
  /// at all -- reads as empty rather than as a broken dial.
  value: number;
  display: ReactNode;
  caption: ReactNode;
  tone?: string;
  /// Inside a tab that also has to show its figures, rather than alone in a
  /// box of its own.
  compact?: boolean;
}) {
  const lit = Math.round(clamp01(value) * TICKS);
  return (
    <div className={`relative flex flex-col items-center ${
      compact ? "px-2 pb-2 pt-1" : "px-4 pb-5 pt-4"}`}>
      <svg viewBox="0 0 200 118" aria-hidden
        className={`max-w-full ${compact ? "w-[132px]" : "w-[188px]"}`}>
        {Array.from({ length: TICKS }, (_, i) => (
          <rect key={i} x="98.4" y="8" width="3.2" height="21" rx="1.6"
            className={i < lit ? tone : "fill-panel3"}
            /* Every tick is the same bar, drawn straight up from the centre
               and then turned. Laying them out with trigonometry would put
               the same rotation in the transform anyway, and this way the
               tick is a rectangle rather than four computed corners. */
            transform={`rotate(${-90 + (i / (TICKS - 1)) * 180} 100 100)`} />
        ))}
      </svg>
      {/* Over the dial rather than under it: the figure is what the dial is
          about, and printed below it the two read as separate facts. */}
      <div className={`pointer-events-none absolute inset-x-0 text-center ${
        compact ? "top-[42px]" : "top-[62px]"}`}>
        <div className={`n font-medium leading-none ${compact ? "text-[16px]" : "text-[20px]"}`}>
          {display}
        </div>
        <div className={`leading-tight text-muted-foreground ${
          compact ? "mt-1.5 text-[10.5px]" : "mt-2 text-[11.5px]"}`}>
          {caption}
        </div>
      </div>
    </div>
  );
}
