/*
 * The market list beside the terminal, the way Jupiter and Backpack keep one:
 * every market with its price and move, searchable and grouped, one click from
 * being the market on screen.
 *
 * The palette (Cmd/Ctrl K) is still the fast way to jump; this is the way to
 * browse, and to keep an eye on the markets you are not trading. Desktop only:
 * the phone switches markets from its header.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ChevronsLeft, ChevronsRight, Search, Star } from "lucide-react";
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

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

export function MarketList({ markets, current, onPick, onPalette }: {
  markets: Market[];
  current: string;
  onPick: (symbol: string) => void;
  /// Opens the command palette, which owns the Cmd/Ctrl K shortcut.
  onPalette: () => void;
}) {
  const [saved, setSaved] = useState<string[]>(() => read(SAVED, []));
  const [collapsed, setCollapsed] = useState<boolean>(() => read(COLLAPSED, false));
  const [group, setGroup] = useState("all");
  const [query, setQuery] = useState("");

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

  // Search beats the group: somebody typing a symbol wants that market
  // wherever it is filed. Busiest first, as the palette sorts.
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const g = GROUPS.find((x) => x.key === group) ?? GROUPS[0];
    return [...markets]
      .filter((m) => (q
        ? m.symbol.toLowerCase().includes(q) || m.name.toLowerCase().includes(q)
        : g.of(m, saved)))
      .sort((a, b) => b.volume24h - a.volume24h || b.oi - a.oi);
  }, [markets, group, query, saved]);

  if (collapsed) {
    return (
      <aside className="flex w-[52px] flex-none flex-col items-center gap-1 overflow-hidden
                        bg-panel py-2">
        <IconBtn label="Show markets" onClick={toggleCollapsed}><ChevronsRight size={16} /></IconBtn>
        <IconBtn label={`Search markets (${isMac ? "Cmd" : "Ctrl"} K)`} onClick={onPalette}>
          <Search size={15} />
        </IconBtn>
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
      <div className="flex flex-none items-center gap-1.5 px-2.5 pt-2.5">
        {/* The field rings when its input has focus; the palette key sits beside
            the label rather than in it, so a click on it is only its own. */}
        <div className="field-ring flex h-8 min-w-0 flex-1 items-center gap-2 rounded-full bg-panel2 pl-3 pr-1
                        text-muted-foreground focus-within:text-foreground">
          <label className="flex min-w-0 flex-1 items-center gap-2">
            <Search size={14} className="flex-none" />
            <input value={query} onChange={(e) => setQuery(e.target.value)}
              placeholder="Search" aria-label="Search markets"
              className="min-w-0 flex-1 bg-transparent text-[12.5px] text-foreground outline-none
                         placeholder:text-dim" />
          </label>
          <button type="button" onClick={onPalette} title="Open the market palette"
            className="inline-flex h-6 flex-none items-center rounded-full border border-line px-2 text-[10.5px]
                       text-dim transition-colors hover:text-foreground">
            {isMac ? "⌘K" : "Ctrl K"}
          </button>
        </div>
        <IconBtn label="Hide markets" onClick={toggleCollapsed}><ChevronsLeft size={16} /></IconBtn>
      </div>

      <div className="mx-2.5 my-2 flex flex-none justify-between rounded-full bg-panel2 p-1">
        {GROUPS.map((g) => (
          <button key={g.key} type="button" onClick={() => { setGroup(g.key); setQuery(""); }}
            aria-pressed={g.key === group && !query}
            aria-label={g.key === "fav" ? "Favorites" : undefined} title={g.key === "fav" ? "Favorites" : undefined}
            className={cn("flex h-7 flex-none items-center rounded-full px-2.5 text-[12.5px] transition-colors",
              g.key === group && !query ? "bg-panel3 font-medium text-foreground"
                : "text-muted-foreground hover:text-foreground")}>
            {/* The star in place of the word, so all five fit the column. */}
            {g.key === "fav" ? <Star size={13} strokeWidth={2} fill={g.key === group && !query ? "currentColor" : "none"} /> : g.label}
          </button>
        ))}
      </div>

      <div className="grid flex-none grid-cols-[1fr_auto] border-b border-line px-3 pb-1.5
                      text-[11px] text-dim">
        <span>Market</span><span>Price / 24h</span>
      </div>

      <div className="pane-scroll min-h-0 flex-1">
        {shown.length === 0 && (
          <div className="px-4 py-8 text-center text-[12px] text-dim">
            {query ? "No markets match" : group === "fav" ? "Star a market to keep it here" : "None yet"}
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
