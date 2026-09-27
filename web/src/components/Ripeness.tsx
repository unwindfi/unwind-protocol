import type { Market, Observed } from "@/lib/api";
import { compact } from "@/lib/format";

/*
 * How far a market is through the two gates between a listing and a fill.
 *
 * Deliberately not one number. Seasoning is spent in time and backing is spent
 * in money, and a single averaged bar would report a market as "half ready"
 * when what is actually true is that the mark is finished and nobody has
 * underwritten a cent of it. Two segments read left to right say which half is
 * missing, which is the only thing anyone looking at this wants to know.
 */
export function gates(o: Observed) {
  const clamp = (n: number) => Math.max(0, Math.min(1, n));
  // Both conditions have to hold, so the slower of the two is the progress.
  const seasoning = o.seasoned ? 1 : clamp(Math.min(
    o.readingsNeeded > 0 ? o.readings / o.readingsNeeded : 1,
    o.spanNeededSec > 0 ? o.spanSec / o.spanNeededSec : 1));
  // The ceiling is the source pool's own depth: the budget is trimmed to what
  // that pool costs to move, so backing past it buys nothing and the bar stops
  // rather than implying there is more to fill.
  const backing = o.depthUsd > 0 ? clamp(o.backingUsd / o.depthUsd)
    : o.backingUsd > 0 ? 1 : 0;
  return { seasoning, backing, live: o.tradeable };
}

/// The state a market is in, named rather than described. A market that says
/// "Seasoning · 12/30 reads" is reporting a status; one that says "reading the
/// pool, it will be ready in a while" is prose, and prose cannot be scanned
/// down a column.
export function statusOf(m: Market) {
  const o = m.observed!;
  if (!o.seasoned) {
    const left = Math.max(0, o.spanNeededSec - o.spanSec);
    // Backed and waiting only on the mark: orders are welcome now, and all
    // clear together the moment it is ready.
    if (o.budgetUsd > 0) {
      return {
        label: "Opening auction",
        tone: "text-brand",
        detail: `opens in ${Math.ceil(left / 60)}m · orders clear together`,
      };
    }
    return {
      label: "Seasoning",
      tone: "text-muted-foreground",
      detail: `${o.readings}/${o.readingsNeeded} reads · ${Math.ceil(left / 60)}m left`,
    };
  }
  if (o.budgetUsd <= 0) {
    return { label: "Unbacked", tone: "text-dim", detail: "anyone can underwrite it" };
  }
  return { label: "Live", tone: "text-up", detail: compact(o.budgetUsd) + " budget" };
}

const Seg = ({ pct, fill }: { pct: number; fill: string }) => (
  <div className="h-[3px] flex-1 overflow-hidden rounded-full bg-panel3">
    <div className={`h-full rounded-full ${fill}`}
      style={{
        width: `${pct * 100}%`,
        transition: "width 700ms var(--ease-out-strong)",
      }} />
  </div>
);

/*
 * The one recurring visual in the product: a market ripening in public.
 *
 * Every market on the board carries this, which is what makes the board worth
 * watching rather than worth querying. It is also the mechanism drawn to
 * scale -- the right-hand segment fills toward the pool's own depth, so the
 * rule that caps what a market can cost the LPs is a thing you can see rather
 * than a paragraph in the docs.
 */
export function Ripeness({ o, labels = true }: { o: Observed; labels?: boolean }) {
  const g = gates(o);
  return (
    <div>
      <div className="flex items-center gap-[3px]">
        <Seg pct={g.seasoning} fill="bg-brand" />
        <Seg pct={g.backing} fill={g.live ? "bg-up" : "bg-brand/45"} />
      </div>
      {labels && (
        <div className="mt-[7px] flex items-baseline justify-between gap-3
                        text-[10.5px] leading-none">
          <span className={g.seasoning >= 1 ? "text-muted-foreground" : "text-dim"}>
            {g.seasoning >= 1 ? "Seasoned" : `${o.readings}/${o.readingsNeeded} reads`}
          </span>
          <span className={`n ${g.live ? "text-up" : "text-dim"}`}>
            {o.backingUsd <= 0 ? "unbacked"
              // Backing past the depth cap buys nothing -- the budget is
              // trimmed to it either way -- so reporting the raw figure over
              // the ceiling ("$120K / $95K") reads as a bug rather than as the
              // market being finished.
              : g.backing >= 1 ? `${compact(o.depthUsd)} backed · at cap`
                : `${compact(o.backingUsd)} / ${compact(o.depthUsd)} backed`}
          </span>
        </div>
      )}
    </div>
  );
}
