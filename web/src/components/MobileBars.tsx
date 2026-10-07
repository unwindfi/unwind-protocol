import type { Market } from "@/lib/api";
import { pnum } from "@/lib/format";

export type MobileView = "chart" | "book" | "positions" | "account";

/// Words only, as in the site header: an icon over every label said nothing
/// the label did not.
const VIEWS = [
  { v: "chart", l: "Chart" },
  { v: "book", l: "Market" },
  { v: "positions", l: "Positions" },
  { v: "account", l: "Account" },
] as const;

/*
 * The pane switcher, and above it the one action the screen exists for.
 *
 * On desktop the order ticket is always visible in a side column. A phone has
 * no side column, so the ticket becomes a sheet -- and if the way in were a tab
 * like any other, placing a trade would cost a tab switch from wherever the
 * trader happens to be. Buy and Sell stay pinned instead, above the tab bar and
 * under the thumb, and open the sheet with the side already chosen.
 */
export function MobileBars({
  view, onView, m, positions, onTrade, showTrade = true,
}: {
  view: MobileView;
  onView: (v: MobileView) => void;
  m: Market;
  positions: number;
  onTrade: (side: "long" | "short") => void;
  /// Hidden on the Account pane, where the ticket is already on screen and
  /// raising the sheet over it would just cover what you are reading.
  showTrade?: boolean;
}) {
  return (
    <div className="flex-none border-t border-line bg-panel safe-b">
      {showTrade && (
      // Filled with each side's colour, the same fills the ticket's submit
      // button uses, so the bar already says which way each one trades.
      <div className="grid grid-cols-2 gap-2.5 px-4 py-2.5">
        <button onClick={() => onTrade("long")}
          className="press flex min-h-[48px] flex-col items-center justify-center gap-0.5
                     rounded-full bg-up text-background transition-opacity hover:opacity-90">
          <span className="text-[14px] font-medium leading-none">Long</span>
          <span className="n text-[11px] leading-none opacity-70">{pnum(m.ask)}</span>
        </button>
        <button onClick={() => onTrade("short")}
          className="press flex min-h-[48px] flex-col items-center justify-center gap-0.5
                     rounded-full bg-down text-background transition-opacity hover:opacity-90">
          <span className="text-[14px] font-medium leading-none">Short</span>
          <span className="n text-[11px] leading-none opacity-70">{pnum(m.bid)}</span>
        </button>
      </div>
      )}

      <nav className={`grid grid-cols-4 gap-1 px-2 py-2 ${showTrade ? "border-t border-line" : ""}`}>
        {VIEWS.map(({ v, l }) => {
          const on = view === v;
          return (
            <button key={v} onClick={() => onView(v)}
              aria-current={on ? "page" : undefined}
              className={`press flex h-10 items-center justify-center gap-1.5 rounded-full
                          text-[13px] transition-colors duration-base
                          ${on ? "bg-foreground font-medium text-background"
                               : "text-muted-foreground hover:text-foreground"}`}>
              {l}
              {v === "positions" && positions > 0 && (
                <span className="n text-[11.5px] opacity-60">{positions}</span>
              )}
            </button>
          );
        })}
      </nav>
    </div>
  );
}
