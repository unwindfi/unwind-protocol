/*
 * The market list beside the terminal, the way Jupiter and Backpack keep one:
 * every market with its price and move, grouped, one click from
 * being the market on screen.
 *
 * The header's search (Cmd/Ctrl K) is the way to find a market; this is the
 * way to browse, and to keep an eye on the markets you are not trading. Desktop only:
 * the phone switches markets from its header.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ChevronsLeft, ChevronsRight, Star } from "lucide-react";
import { TickerLogo } from "@/components/TickerLogo";
import type { Market } from "@/lib/api";
import { pct, price, tone } from "@/lib/format";
import { cn } from "@/lib/utils";

/// The same key /markets keeps its watchlist under, so a star set on either
/// page is the same star.
const SAVED = "unwind.watchlist";
const COLLAPSED = "unwind.trade.list";

const GROUPS: { key: string; label: string; of: (m: Market, saved: string[]) => boolean }[] = [
  { key: "all", label: "All", of: () => true },
  { key: "fav", label: "Favorites", of: (m, saved) => saved.includes(m.symbol) },
  // The tokenised equities carry the x suffix their issuer gives them, the
  // same rule /markets groups by.
  { key: "equities", label: "Stocks", of: (m) => /x$/.test(m.symbol) },
  { key: "crypto", label: "Crypto", of: (m) => !/x$/.test(m.symbol) },
];

/// Local storage throws outright in some browsers rather than returning
/// nothing, so every read and write is wrapped and a failure is the default.
function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : (JSON.parse(raw) as T);
  } catch { return fallback; }
}
function write(key: string, v: unknown) {
  try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* not kept; fine */ }
}


export function MarketList({ markets, current, onPick }: {
  markets: Market[];
  current: string;
  onPick: (symbol: string) => void;
}) {
  const [saved, setSaved] = useState<string[]>(() => read(SAVED, []));
  const [collapsed, setCollapsed] = useState<boolean>(() => read(COLLAPSED, false));
  const [group, setGroup] = useState("all");

  // /markets may change the watchlist in another tab.
  useEffect(() => {
    const on = (e: StorageEvent) => { if (e.key === SAVED) setSaved(read(SAVED, [])); };
    window.addEventListener("storage", on);
    return () => window.removeEventListener("storage", on);
  }, []);

  const toggleSaved = (symbol: string) => setSaved((was) => {
    const next = was.includes(symbol) ? was.filter((s) => s !== symbol) : [...was, symbol];
    write(SAVED, next);
    return next;
  });
  const toggleCollapsed = () => setCollapsed((c) => { write(COLLAPSED, !c); return !c; });

  // Busiest first, as the Cmd K menu sorts.
  const shown = useMemo(() => {
    const g = GROUPS.find((x) => x.key === group) ?? GROUPS[0];
    return [...markets]
      .filter((m) => g.of(m, saved))
      .sort((a, b) => b.volume24h - a.volume24h || b.oi - a.oi);
  }, [markets, group, saved]);

  if (collapsed) {
    return (
      <aside className="flex w-[52px] flex-none flex-col items-center gap-1 overflow-hidden
                        bg-panel py-2">
        <IconBtn label="Show markets" onClick={toggleCollapsed}><ChevronsRight size={16} /></IconBtn>
        <div className="pane-scroll mt-1 flex min-h-0 w-full flex-1 flex-col items-center gap-1.5 border-t
                        border-line pt-2">
          {shown.map((m) => (
            <button key={m.symbol} type="button" onClick={() => onPick(m.symbol)}
              title={`${m.symbol} ${price(m.price)} ${pct(m.changePct)}`}
              aria-label={m.symbol} aria-current={m.symbol === current || undefined}
              className={cn("grid size-9 flex-none place-items-center rounded-full transition-colors",
                m.symbol === current ? "bg-panel3" : "hover:bg-panel2")}>
              <TickerLogo m={m} size={24} />
            </button>
          ))}
        </div>
      </aside>
    );
  }

  return (
    <aside className="flex w-[248px] flex-none flex-col overflow-hidden bg-panel 2xl:w-[272px]">
      {/* No search here: the site header's search (Cmd K) is the one way to
          find a market, and on this page it switches the terminal in place.
          So the groups lead the column, with the hide button beside them
          rather than on a row of its own. */}
      <div className="mx-2.5 mb-2 mt-2.5 flex flex-none items-center gap-1.5">
      <div className="flex min-w-0 flex-1 justify-between rounded-full bg-panel2 p-1">
        {GROUPS.map((g) => (
          <button key={g.key} type="button" onClick={() => setGroup(g.key)}
            aria-pressed={g.key === group}
            aria-label={g.key === "fav" ? "Favorites" : undefined} title={g.key === "fav" ? "Favorites" : undefined}
            className={cn("flex h-7 flex-none items-center rounded-full px-2 text-[12.5px] transition-colors",
              g.key === group ? "bg-panel3 font-medium text-foreground"
                : "text-muted-foreground hover:text-foreground")}>
            {/* The star in place of the word, so all five fit the column. */}
            {g.key === "fav" ? <Star size={13} strokeWidth={2} fill={g.key === group ? "currentColor" : "none"} /> : g.label}
          </button>
        ))}
      </div>
        <IconBtn label="Hide markets" onClick={toggleCollapsed}><ChevronsLeft size={16} /></IconBtn>
      </div>

      <div className="grid flex-none grid-cols-[1fr_auto] border-b border-line px-3 pb-1.5
                      text-[11px] text-dim">
        <span>Market</span><span>Price / 24h</span>
      </div>

      <div className="pane-scroll min-h-0 flex-1">
        {shown.length === 0 && (
          <div className="px-4 py-8 text-center text-[12px] text-dim">
            {group === "fav" ? "Star a market to keep it here" : "None yet"}
          </div>
        )}
        {shown.map((m) => {
          const on = m.symbol === current;
          const fav = saved.includes(m.symbol);
          return (
            <div key={m.symbol}
              className={cn("group flex items-center gap-2 border-b border-line/60 pl-1.5 pr-3",
                on ? "bg-panel2" : "hover:bg-panel2/60")}>
              {/* Out of the Tab order, so the list is one stop per market;
                  F on a focused row does the same thing. */}
              <button type="button" onClick={() => toggleSaved(m.symbol)} tabIndex={-1}
                aria-label={fav ? `Remove ${m.symbol} from favorites` : `Add ${m.symbol} to favorites`}
                aria-pressed={fav}
                className={cn("grid size-6 flex-none place-items-center rounded-full transition-colors",
                  fav ? "text-foreground" : "text-dim opacity-60 hover:text-foreground group-hover:opacity-100")}>
                <Star size={12} fill={fav ? "currentColor" : "none"} />
              </button>
              <button type="button" onClick={() => onPick(m.symbol)} aria-current={on || undefined}
                aria-keyshortcuts="F"
                onKeyDown={(e) => { if (e.key.toLowerCase() === "f" && !e.metaKey && !e.ctrlKey) { e.preventDefault(); toggleSaved(m.symbol); } }}
                className="flex min-w-0 flex-1 items-center gap-2 py-2 text-left">
                <TickerLogo m={m} size={22} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span title={m.symbol} className="truncate text-[12.5px] font-medium">{m.symbol}</span>
                    <span className="n flex-none text-[11px] text-dim">{m.maxLeverage}x</span>
                  </span>
                  <span title={m.name} className="block truncate text-[11px] text-dim">{m.name}</span>
                </span>
                <span className="flex-none text-right">
                  <span className="n block text-[12.5px]">{price(m.price)}</span>
                  <span className={`n block text-[11px] ${tone(m.changePct)}`}>{pct(m.changePct)}</span>
                </span>
              </button>
            </div>
          );
        })}
      </div>
    </aside>
  );
}

function IconBtn({ label, onClick, children }: {
  label: string; onClick: () => void; children: ReactNode;
}) {
  return (
    <button type="button" onClick={onClick} aria-label={label} title={label}
      className="grid size-8 flex-none place-items-center rounded-full text-muted-foreground
                 transition-colors hover:bg-panel2 hover:text-foreground">
      {children}
    </button>
  );
}
