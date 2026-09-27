import { TickerLogo } from "@/components/TickerLogo";
import { Ripeness, statusOf } from "@/components/Ripeness";
import type { Market } from "@/lib/api";
import { price } from "@/lib/format";

/// Seconds since the source pool was first read, which is the market's age:
/// nothing observes a pool until someone lists it against one.
const age = (sec: number) =>
  sec < 90 ? `${Math.max(1, Math.round(sec))}s`
    : sec < 5400 ? `${Math.round(sec / 60)}m`
      : sec < 172800 ? `${Math.round(sec / 3600)}h`
        : `${Math.round(sec / 86400)}d`;

function Card({ m }: { m: Market }) {
  const o = m.observed!;
  const s = statusOf(m);
  // Live markets, and backed ones running their opening auction, go to the
  // terminal; the rest go to the page where the thing they are missing can be
  // supplied. A card that leads to a market you cannot trade yet is only
  // useful if it leads to the way to finish it.
  const href = o.tradeable || o.budgetUsd > 0 ? `/trade?symbol=${m.symbol}` : `/list#${m.symbol}`;

  return (
    <a href={href}
      className="rise group block rounded-xl border border-line bg-panel p-3.5
                 transition-colors hover:border-dim">
      <div className="flex items-start gap-2.5">
        <TickerLogo m={m} size={28} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="truncate text-[13.5px] font-medium">{m.symbol}</span>
            <span className="n flex-none text-[11px] text-dim">{age(o.spanSec)}</span>
          </div>
          <div className="n mt-[2px] text-[12.5px] text-muted-foreground">
            {price(m.price)}
          </div>
        </div>
        <span className={`flex-none text-[11px] ${s.tone}`}>{s.label}</span>
      </div>

      <div className="mt-3">
        <Ripeness o={o} />
      </div>
    </a>
  );
}

/*
 * Every permissionlessly-opened market, newest first, ripening in public.
 *
 * The ordering is the point. A market's whole first act is visible here before
 * it can take a single position, which is what makes this a page worth leaving
 * open rather than one you query when you already know the symbol.
 */
export function Board({ markets }: { markets: Market[] }) {
  const listed = markets.filter((m) => m.observed);
  // Youngest first. `spanSec` is time since the pool was first read, so it is
  // the listing's age without the server having to carry a second clock.
  const ordered = [...listed].sort((a, b) => a.observed!.spanSec - b.observed!.spanSec);

  if (ordered.length === 0) return null;

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {/*
       * Every card carries the entrance animation, and only the new ones play
       * it. A CSS animation runs once when its node mounts; these are keyed by
       * symbol, so a poll that returns the same markets reuses the same nodes
       * and nothing re-animates. Tracking which symbols are new by hand did
       * the same thing with a ref read during render.
       */}
      {ordered.map((m) => <Card key={m.symbol} m={m} />)}
    </div>
  );
}
