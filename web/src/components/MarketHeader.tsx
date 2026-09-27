import { ChevronDown } from "lucide-react";
import { DigitSwap } from "@/components/motion/digit-swap";
import { Tooltip } from "@/components/motion/tooltip";
import { BatchClock, usePriceTitle } from "./BatchClock";
import { StatTiles } from "./market/MarketHead";
import { TickerLogo } from "./TickerLogo";
import type { Batch, Market } from "@/lib/api";
import { pct, tone } from "@/lib/format";

export function MarketHeader({
  m, onOpen, mobile = false, batch,
}: {
  m: Market; onOpen: () => void; mobile?: boolean;
  /// The batch, when the page already polls it; fetched here otherwise.
  batch?: Batch | null;
}) {
  usePriceTitle(m);
  const stale = m.priceAgeMs != null && m.priceAgeMs / 1000 > m.maxPriceAgeSec;

  if (mobile) {
    /*
     * One row, not three.
     *
     * The first pass stacked a title row, a stat strip and a summary strip
     * above the timeframe bar: four bands of near-identical grey type that ate
     * a quarter of the screen before the chart began, and read as a pile of
     * unrelated bars rather than a header. The market and its price are the
     * only two things this row has to answer; everything else moved to the
     * Market tab, which exists for exactly that.
     */
    return (
      <header className="flex flex-none items-center gap-3 border-b border-line
                         bg-panel px-4 py-2.5">
        <button onClick={onOpen}
          className="press flex min-h-[44px] min-w-0 flex-1 items-center gap-2.5 text-left">
          <TickerLogo m={m} size={32} />
          <span className="min-w-0">
            <span className="flex items-center gap-1">
              <span className="truncate text-[17px] font-semibold tracking-[-.02em]">
                {m.symbol}
              </span>
              <ChevronDown size={15} className="flex-none text-dim" />
            </span>
            <span className="mt-px flex items-center gap-1.5">
              {stale ? (
                <span className="rounded-full bg-down/15 px-2 py-px text-[11px] font-medium text-down">
                  feed {Math.round(m.priceAgeMs! / 1000)}s
                </span>
              ) : (
                <span className="truncate text-[12px] text-muted-foreground">{m.name}</span>
              )}
            </span>
          </span>
        </button>

        {/* The window between the name and the price: the one figure on this
            row that says whether an order placed now makes this batch. */}
        <BatchClock m={m} batch={batch} compact />

        <div className="flex flex-none flex-col items-end">
          <DigitSwap value={m.ask.toFixed(2)} animationKey={m.ask}
            direction={m.change >= 0 ? "up" : "down"}
            className="text-[24px] font-semibold leading-none tracking-[-.025em]" />
          {/* The move in its own colour, no badge: the arrow the badge
              carried said what the sign already did. */}
          <span className={`n mt-1.5 text-[12.5px] font-medium ${tone(m.changePct)}`}>
            {m.change >= 0 ? "+" : ""}{m.change.toFixed(2)} · {pct(m.changePct)}
          </span>
        </div>
      </header>
    );
  }

  return (
    <header className="strip-scroll flex flex-none items-center gap-5 border-b border-line
                       bg-panel px-4 py-2">
      <button onClick={onOpen} className="flex flex-none items-center gap-2.5">
        <TickerLogo m={m} size={26} />
        <span className="whitespace-nowrap text-[16px] font-semibold tracking-[-.02em]">
          {m.symbol}-USDC
        </span>
        <ChevronDown size={13} className="text-dim" />
      </button>

      <div className="flex flex-none gap-1.5">
        {stale && (
          <Tooltip content={m.feedError ?? "Price source not responding."} side="bottom">
            <span className="cursor-default rounded-full bg-down/15 px-2 py-px text-[11px]
                             font-medium text-down">
              feed {Math.round(m.priceAgeMs! / 1000)}s
            </span>
          </Tooltip>
        )}
        {/* Only a tokenised equity is an xStock; a crypto market wearing the
            badge was saying something untrue about it. */}
        {/x$/.test(m.symbol) && (
          <span className="rounded-full border border-line px-2 py-px text-[11px] text-muted-foreground">xStock</span>
        )}
        <span className="rounded-full border border-line px-2 py-px text-[11px] font-medium">
          {m.maxLeverage}x
        </span>
      </div>

      {/* The ring and one line: the book beside the chart carries the full
          clock, and the figures need the width here. */}
      <BatchClock m={m} batch={batch} compact />
      <StatTiles m={m} dense />
    </header>
  );
}
