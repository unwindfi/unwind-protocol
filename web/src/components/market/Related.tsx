/*
 * The other markets, as somewhere to go next.
 *
 * Ordered by what is moving rather than by size, and never including the one
 * you are on. Nothing here is a recommendation: the venue lists whatever
 * anyone opens, so the only defensible sort is a fact about the market -- in
 * this case that it did something today.
 */
import { ArrowUpRight } from "lucide-react";
import { TickerLogo } from "@/components/TickerLogo";
import { Box } from "@/components/market/Box";
import type { Market } from "@/lib/api";
import { pct, price, tone } from "@/lib/format";

const SHOWN = 6;

export function Related({ markets, current, onPick }: {
  markets: Market[];
  current: string;
  /// Switching market is a state change on this page, not a navigation: the
  /// chart, the ticket and the position all follow it, and a full page load
  /// would throw away a half-filled order to do the same thing.
  onPick: (symbol: string) => void;
}) {
  const others = [...markets]
    .filter((m) => m.symbol !== current)
    .sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct))
    .slice(0, SHOWN);

  if (others.length === 0) return null;

  return (
    <Box title="Other markets"
      /* The icon alone: the heading beside it already says what this is, so
         a label here would be the same sentence twice. Still named for a
         screen reader, which has no heading to read it next to. */
      aside={<a href="/markets" aria-label="All markets" title="All markets"
        className="press grid size-7 place-items-center rounded-lg text-muted-foreground
                   transition-colors hover:bg-panel2 hover:text-foreground">
        <ArrowUpRight size={16} />
      </a>}
      bodyClassName="grid grid-cols-1 gap-px bg-line sm:grid-cols-2 lg:grid-cols-3">
      {others.map((m) => (
        <button key={m.symbol} type="button" onClick={() => onPick(m.symbol)}
          className="group flex items-center gap-3 bg-panel px-4 py-3.5 text-left
                     transition-colors hover:bg-panel2">
          <TickerLogo m={m} size={30} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13.5px] font-medium">{m.name}</span>
            <span className="n mt-px block text-[12px] text-muted-foreground">
              {price(m.price)}
            </span>
          </span>
          <span className={`n flex-none text-[12.5px] ${tone(m.changePct)}`}>
            {pct(m.changePct)}
          </span>
        </button>
      ))}
    </Box>
  );
}
