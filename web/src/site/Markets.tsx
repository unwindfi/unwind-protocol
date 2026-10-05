/*
 * Markets, as a place to look around rather than a table with a title.
 *
 * The venue's whole claim is that anyone can open a market on anything, which
 * means the list is the product: it is long, it is not curated, and most of
 * what is in it is not what somebody came looking for. So the page is built
 * for browsing -- search first, then a row of ways to cut the list, then the
 * list -- instead of presenting one ranking and hoping it is the right one.
 *
 * Nothing here decides what is worth trading. Every group is a fact about a
 * market (what it tracks, who opened it, whether it moved), never a
 * recommendation, because a venue that lists permissionlessly cannot also be
 * the one saying which listing is good.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import "@/site/serif.css";
import { ChevronDown, ChevronUp, ChevronsUpDown, ListFilter, Search, Star as LucideStar } from "lucide-react";
import { Shell, SiteFooter, SiteHeader } from "@/site/Chrome";
import { WalletActions } from "@/components/WalletActions";
import { Track } from "@/components/Track";
import { TickerLogo } from "@/components/TickerLogo";
import { MarketPeek } from "@/components/MarketPeek";
import { NavIcon } from "@/components/NavIcon";
import { getMarkets, usePoll, type Market } from "@/lib/api";
import { compact, pct, price, tone } from "@/lib/format";

const NONE: Market[] = [];
const SAVED = "unwind.watchlist";

/*
 * The groups.
 *
 * `of` is the whole definition: a predicate over a market, so a group can
 * never drift from what it claims to hold. `face` picks the market whose
 * artwork fronts the card, from the same set -- a card showing a logo that is
 * not in the group it opens would be decoration lying about its contents.
 */
type Group = {
  key: string;
  label: string;
  of: (m: Market, saved: string[]) => boolean;
  /*
   * A drawing made for this group. Optional on purpose: a card with no
   * drawing falls back to its own count, so the row is never half-finished
   * while artwork is still being made, and a group added later is never
   * blocked on one.
   */
  art?: string;
  /// Picks a market from inside the group to front the card, when no drawing
  /// is named. Never from outside it: a card showing a logo that is not in
  /// what it opens is decoration lying about its contents.
  face?: (ms: Market[], saved: string[]) => Market | undefined;
};



/*
 * The memecoins, by name.
 *
 * Nothing in a market says it is one. There is no field for it and no rule
 * that could be written without somebody's judgement in it, so the list is
 * stated here rather than inferred -- which at least makes the judgement
 * visible and easy to argue with.
 */
const MEMES = ["BONK", "WIF", "POPCAT", "FARTCOIN", "MEW", "PENGU", "TRUMP",
  "BOME", "WEN", "AI16Z"];
/// A market's token without its unit: 1MBONK is BONK quoted per million.
const isMeme = (symbol: string) => MEMES.includes(symbol.replace(/^1[KMB](?=[A-Z])/, ""));

const GROUPS: Group[] = [
  { key: "all", label: "All markets", of: () => true, art: "/logos/SOL.png" },
  {
    key: "moving", label: "Movers",
    of: (m) => Math.abs(m.changePct) >= 1,
    // Whichever market moved furthest, so the card is showing the reason it
    // is worth pressing.
    face: (ms) => [...ms].sort((a, b) =>
      Math.abs(b.changePct) - Math.abs(a.changePct))[0],
  },
  {
    key: "equities", label: "Equities",
    // The tokenised equities carry the x suffix their issuer gives them.
    of: (m) => /x$/.test(m.symbol),
    art: "/logos/SPYx.png",
  },
  {
    key: "memes", label: "Memecoins",
    of: (m) => isMeme(m.symbol),
    art: "/logos/BONK.png",
  },
  {
    key: "crypto", label: "Crypto",
    of: (m) => !/x$/.test(m.symbol) && !isMeme(m.symbol),
    art: "/logos/JUP.png",
  },
  {
    key: "opened", label: "Opened by anyone",
    of: (m) => !!m.observed,
    face: (ms) => ms.find((m) => m.observed),
  },
  {
    key: "watchlist", label: "Watchlist",
    of: (m, saved) => saved.includes(m.symbol),
    face: (ms, saved) => ms.find((m) => saved.includes(m.symbol)),
  },
];

/// Room to open on a market: what its long and short sides can still take.
const roomOf = (m: Market) => Math.max(0, m.capLong) + Math.max(0, m.capShort);

/// What the table can be sorted by, and how each column reads a market.
const COLUMNS = [
  { key: "price", label: "Price", get: (m: Market) => m.price },
  { key: "oi", label: "Open interest", get: (m: Market) => m.oi },
  { key: "change", label: "24h change", get: (m: Market) => m.changePct },
  { key: "volume", label: "24h volume", get: (m: Market) => m.volume24h },
  // What this market can still take, both sides together, rather than the
  // pool's free liquidity, which is one figure shared by every market and
  // printed the same $9.98M on every row.
  { key: "liquidity", label: "Liquidity", get: (m: Market) => roomOf(m) },
] as const;

type SortKey = (typeof COLUMNS)[number]["key"] | "name";

/*
 * Where a market's price comes from, which is the one axis this venue has
 * that the list does not already cut by.
 *
 * There is no network filter here and there should not be: everything
 * settles on one chain. A control offering a choice with one answer is
 * furniture.
 */
const SOURCES = [
  { key: "all", label: "All sources", short: "All", of: () => true },
  { key: "feed", label: "Oracle feeds", short: "Pyth", of: (m: Market) => !m.observed },
  { key: "pool", label: "Opened on a pool", short: "Pool", of: (m: Market) => !!m.observed },
] as const;

type SourceKey = (typeof SOURCES)[number]["key"];

/*
 * The two figures a phone keeps.
 *
 * Five columns of numbers at 375 is a wall, so the narrow table carries what
 * a market is worth and what it did today and drops the rest. One list, read
 * by both the header and the rows, because the alternative -- each hiding by
 * position -- is what put `Open interest` over a column of 24h changes.
 */
const PHONE: SortKey[] = ["price", "change"];

/// The Filters panel's sort: the orders people actually browse a list in.
const SORTS: [SortKey, string][] = [
  ["oi", "Open interest"], ["volume", "Volume"], ["change", "24h change"], ["name", "Name"],
];

const SOURCE_LABEL: Record<SourceKey, string> = { all: "All sources", feed: "Oracle", pool: "Pool" };

/// Where prices come from: one closed pill that opens sideways into the
/// choices, and closes again once one is picked.
function SourceMenu({ value, onChange }: { value: SourceKey; onChange: (v: SourceKey) => void }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const out = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", out); window.addEventListener("keydown", key);
    return () => { document.removeEventListener("mousedown", out); window.removeEventListener("keydown", key); };
  }, [open]);
  return (
    <div ref={box} className="flex items-center gap-2">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}
        aria-label={`Price source: ${SOURCE_LABEL[value]}`}
        className={`press flex h-11 flex-none items-center gap-2.5 rounded-full px-5 text-[15px] text-foreground ${
          open || value !== "all" ? "bg-panel3" : "bg-panel2 hover:bg-panel3"}`}>
        {SOURCE_LABEL[value]}
        <ChevronDown size={16} strokeWidth={2}
          className={`text-muted-foreground transition-transform duration-200 ${open ? "-rotate-90" : ""}`} />
      </button>
      {/* The choices slide out to the side: a grid column going from 0fr
          to 1fr, so nothing below moves. */}
      <div className="grid transition-[grid-template-columns] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]"
        style={{ gridTemplateColumns: open ? "1fr" : "0fr" }}>
        <div className="overflow-hidden">
          <div className={`flex w-max items-center gap-1.5 transition-opacity duration-200 ${open ? "opacity-100" : "opacity-0"}`}>
            {(Object.keys(SOURCE_LABEL) as SourceKey[]).filter((k) => k !== value).map((k) => (
              <button key={k} type="button" tabIndex={open ? 0 : -1}
                aria-label={`Show ${SOURCE_LABEL[k].toLowerCase()}`}
                onClick={() => { onChange(k); setOpen(false); }}
                className="press h-11 whitespace-nowrap rounded-full bg-panel2 px-5 text-[15px] text-muted-foreground
                           hover:bg-panel3 hover:text-foreground">
                {SOURCE_LABEL[k]}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/// A soft track with the chosen option a lighter chip in it.
function Seg<T extends string>({ value, options, onChange }: {
  value: T; options: [T, string][]; onChange: (v: T) => void;
}) {
  return (
    <div role="radiogroup" className="strip-scroll flex max-w-full items-center gap-0.5 rounded-full bg-panel2 p-1">
      {options.map(([k, label]) => (
        <button key={k} type="button" role="radio" aria-checked={value === k} onClick={() => onChange(k)}
          className={`press h-10 flex-none whitespace-nowrap rounded-full px-4 text-[15px] ${value === k
            ? "bg-panel text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}>
          {label}
        </button>
      ))}
    </div>
  );
}

/*
 * One icon set across the site.
 *
 * These were drawn by hand, one path each, and hand-drawn icons never agree
 * with each other: the magnifier's stroke was 1.5 where the nav's was 1.4,
 * the star was built on a 20-unit grid where everything else used 16. A set
 * is drawn against one grid by one hand, which is the part you cannot do an
 * icon at a time.
 */
const Find = ({ size = 16 }: { size?: number }) => (
  <Search size={size} strokeWidth={1.75} aria-hidden />
);


const Star = ({ on }: { on: boolean }) => (
  <LucideStar size={16} strokeWidth={1.75} aria-hidden
    className={on ? "fill-current" : ""} />
);

/*
 * The watchlist, in this browser and nowhere else.
 *
 * Marking a market has nothing to do with holding a position in it, so it
 * does not belong on chain and there is no account here to hang it off. Local
 * storage is refused outright in some browsers and throws rather than
 * returning nothing, which is why both halves are wrapped.
 */
function useWatchlist() {
  const [saved, setSaved] = useState<string[]>([]);
  useEffect(() => {
    try {
      const raw = localStorage.getItem(SAVED);
      if (raw) setSaved(JSON.parse(raw) as string[]);
    } catch { /* private window, or storage refused; an empty list is fine */ }
  }, []);
  const toggle = (symbol: string) =>
    setSaved((was) => {
      const next = was.includes(symbol)
        ? was.filter((s) => s !== symbol)
        : [...was, symbol];
      try { localStorage.setItem(SAVED, JSON.stringify(next)); } catch { /* as above */ }
      return next;
    });
  return { saved, toggle };
}

export default function Markets() {
  const markets = usePoll(getMarkets, 4000) ?? NONE;
  const { saved, toggle } = useWatchlist();
  const [group, setGroup] = useState("all");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("oi");
  const [desc, setDesc] = useState(true);
  const [source, setSource] = useState<SourceKey>("all");
    const [filtersOpen, setFiltersOpen] = useState(false);
  const [openOnly, setOpenOnly] = useState(false);
  const [withOi, setWithOi] = useState(false);

  const picked = GROUPS.find((g) => g.key === group) ?? GROUPS[0];

  /*
   * Search beats the group. Somebody typing a symbol is asking for that
   * market, and answering "not in this tab" when the venue does list it is
   * the one thing a search over a permissionless list must never do.
   */
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const col = COLUMNS.find((c) => c.key === sort);
    const found = q
      ? markets.filter((m) =>
          m.symbol.toLowerCase().includes(q) || m.name.toLowerCase().includes(q))
      : markets.filter((m) => picked.of(m, saved));
    // The filters narrow whatever the group or the search returned, rather
    // than competing with it.
    const src = SOURCES.find((x) => x.key === source) ?? SOURCES[0];
    const kept = found.filter((m) =>
      src.of(m) && (!openOnly || m.session !== 2) && (!withOi || m.oi > 0));
    // Name reads A to Z first; every figure reads largest first.
    if (!col) return [...kept].sort((a, b) => (desc ? -1 : 1) * a.name.localeCompare(b.name));
    return [...kept].sort((a, b) =>
      desc ? col.get(b) - col.get(a) : col.get(a) - col.get(b));
  }, [markets, query, picked, saved, sort, desc, source, openOnly, withOi]);

  const filtersOn = (openOnly ? 1 : 0) + (withOi ? 1 : 0);

  const counts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const g of GROUPS) out[g.key] = markets.filter((m) => g.of(m, saved)).length;
    return out;
  }, [markets, saved]);


  const hit = (key: SortKey) => {
    if (key === sort) return setDesc((d) => !d);
    setSort(key);
    setDesc(true);
  };

  const GRID = "grid-cols-[1.7fr_auto_1fr_.9fr] md:grid-cols-[1.6fr_auto_1fr_1.2fr_1fr_1.1fr_1fr]";

  return (
    <div className="site min-h-full">
      {/* Both: opening a market is what this page invites you to do, and
          connecting is what you need before you can. */}
      <SiteHeader here="/markets" actions={<WalletActions />} />


      {/*
       * The search is the hero, because on a venue whose list is unbounded the
       * useful first move is to say what you are after. The line behind it is
       * scenery, and is marked as such.
       */}
      {/* The hero and the table are the page's content, past the header. */}
      <main>
      <div className="relative overflow-hidden border-b border-line">

        {/* The front page's violet light (waitlist/field.webp) behind the search,
            fading into the page at the foot so the table below starts clean. */}
        <img src="/waitlist/field.webp" alt="" aria-hidden
          className="pointer-events-none absolute inset-0 h-full w-full object-cover opacity-45
                     [mask-image:linear-gradient(to_bottom,black_45%,transparent)] dark:opacity-70" />
        <Shell className="relative py-10 text-center sm:py-12 md:py-16">
          {/* The two things this page does, in the order it offers them: the
              field below, and the link beside the table under it. The second
              sentence is the whole claim -- the listing is not ours to grant
              -- put as something you can go and do rather than argued. */}
          <h1 className="font-serif-display mx-auto max-w-[13ch] text-[clamp(2.6rem,10vw,3.4rem)]
                         leading-[1] tracking-[-.025em] md:text-[80px]">
            Find a market. Or open one.
          </h1>
          {/*
           * The road is a decoration of this row, not of the section, so it
           * is mounted here: its lane sits at the middle of its own box and
           * that box is centred on the field, which is what makes the two
           * line up without either knowing the other's measurements.
           */}
          <div className="relative mx-auto mt-7 max-w-[520px] md:mt-9">
            <Track markets={markets} />
            {/*
             * The field sits in a thick rim the road runs into: the lane
             * flares where it meets the rim on each side, so the road reads
             * as arriving at the search rather than passing behind it.
             */}
            <div className="relative z-10">
              <span className="pointer-events-none absolute left-[18px] top-1/2 z-20
                               -translate-y-1/2 text-muted-foreground sm:left-[22px]">
                <Find />
              </span>
              <input value={query} onChange={(e) => setQuery(e.target.value)}
                placeholder="Search markets" aria-label="Search markets"
                className="relative z-10 h-[56px] w-full rounded-full border border-line
                           bg-panel pl-[46px] pr-5 text-[15px] transition-colors dark:bg-[#121028]
                           placeholder:text-muted-foreground focus:border-foreground/40
                           sm:h-[62px] sm:pl-[52px] sm:pr-6" />
            </div>
          </div>
        </Shell>
      </div>

      {/*
       * The list sits on a panel, inset from the window; the hero above it
       * does not. That is the split in the reference and it is the right one:
       * the hero is the page's backdrop and runs to the edges, while the
       * cards and the table are a surface laid on top of it, with the panel's
       * own edge telling you where that surface begins.
       */}
      <div className="mx-auto w-full max-w-[1460px] px-2.5 pb-12 sm:px-4">
        <div className="rounded-[18px] border border-line bg-background">
      <Shell className="py-8 md:py-10">
        {/*
         * The groups, as cards fronted by a market from inside them. A group
         * nobody can enter is not shown at all: this list grows by listings
         * nobody approves, so which groups have anything in them is not
         * knowable when the page is written.
         */}
        {/*
         * The groups as small cards, each with its own 3D coin leaning out of
         * the top-right corner and cut by the card's edge (rendered in the
         * brand's Blender scene, brand/x/3d/coins.py). Then one row: where
         * prices come from on the left, Filters on the right.
         */}
        <div className="strip-scroll -mx-5 flex gap-2.5 overflow-x-auto px-5 pb-1 sm:mx-0 sm:px-0">
          {/* Six: "Opened" is the Pool source below, so it is not a card too.
              An empty group drops out only once the list has arrived: before
              that every count is zero, and the two cards left stretched
              across the whole row while the page loaded. */}
          {GROUPS.filter((g) => g.key !== "opened"
            && (!markets.length || ["all", "watchlist"].includes(g.key) || counts[g.key] > 0)).map((g) => {
            const on = g.key === group && !query;
            return (
              <button key={g.key} type="button" aria-pressed={on}
                onClick={() => { setGroup(g.key); setQuery(""); }}
                className={`press group/card relative h-[124px] w-[170px] flex-none overflow-hidden rounded-[16px] sm:w-auto sm:min-w-[132px] sm:flex-1
                            border text-left ${on
                  ? "border-foreground/25 bg-panel3" : "border-line bg-panel hover:bg-panel2"}`}>
                <img src={`/groups/${g.key}.webp`} alt="" aria-hidden
                  width={118} height={118} draggable={false}
                  className="pointer-events-none absolute -right-5 -top-6 h-[118px] w-[118px] select-none
                             transition-transform duration-300 ease-[cubic-bezier(0.23,1,0.32,1)]
                             group-hover/card:-translate-y-0.5 group-hover/card:rotate-[-4deg]" />
                <span className={`absolute bottom-4 left-4 text-[16px] leading-none ${on ? "font-medium text-foreground" : "text-muted-foreground"}`}>
                  {g.key === "all" ? "All markets" : g.label}
                </span>
              </button>
            );
          })}
        </div>

        <div className="mt-4 flex items-center gap-3">
          <SourceMenu value={source} onChange={setSource} />
          <button type="button" onClick={() => setFiltersOpen((o) => !o)}
            aria-expanded={filtersOpen} aria-controls="market-filters"
            className={`press ml-auto flex h-11 flex-none items-center gap-2.5 rounded-full px-5
                        text-[15px] text-foreground ${filtersOn > 0 || filtersOpen
                ? "bg-panel3" : "bg-panel2 hover:bg-panel3"}`}>
            Filters
            {filtersOn > 0 && <span className="n text-muted-foreground">{filtersOn}</span>}
            <ListFilter size={17} strokeWidth={1.8} className="text-muted-foreground" />
          </button>
        </div>

        <div id="market-filters"
          className="grid transition-[grid-template-rows] duration-300
                     ease-[cubic-bezier(0.16,1,0.3,1)]"
          style={{ gridTemplateRows: filtersOpen ? "1fr" : "0fr" }}>
          <div className="overflow-hidden">
            <div className="mt-4 flex flex-wrap items-center gap-x-8 gap-y-4 rounded-[20px] border
                            border-line px-5 py-4">
              <div className="flex min-w-0 flex-wrap items-center gap-4">
                <span className="text-[15px] text-muted-foreground">Sort by</span>
                <Seg value={sort} options={SORTS} onChange={(k) => {
                  setSort(k); setDesc(k !== "name");
                }} />
              </div>
              <div className="flex min-w-0 flex-wrap items-center gap-4">
                <span className="text-[15px] text-muted-foreground">Show</span>
                <div className="flex items-center gap-0.5 rounded-full bg-panel2 p-1">
                  {([["Trading now", openOnly, setOpenOnly], ["With open interest", withOi, setWithOi]] as const)
                    .map(([label, on, set]) => (
                      <button key={label} type="button" aria-pressed={on} onClick={() => set(!on)}
                        className={`press h-10 whitespace-nowrap rounded-full px-4 text-[15px] ${on
                          ? "bg-panel text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}>
                        {label}
                      </button>
                    ))}
                </div>
              </div>
              {filtersOn > 0 && (
                <button type="button"
                  onClick={() => { setOpenOnly(false); setWithOi(false); setSource("all"); }}
                  className="press ml-auto text-[14px] text-muted-foreground hover:text-foreground">
                  Clear
                </button>
              )}
            </div>
          </div>
        </div>

        {/*
         * One grid for the header and every row, so a column cannot drift
         * between them. Everything past the first two numbers is dropped on a
         * phone rather than crushed: five figures at 375 is a wall.
         */}
        <div className="mt-4 overflow-hidden rounded-[20px] border border-line bg-panel [&>div:last-child>a]:border-0">
          <div className={`grid ${GRID} items-center gap-2 border-b border-line bg-panel2
                           px-3 py-4 text-[14px] text-muted-foreground sm:gap-3 sm:px-5`}>
            <span>Market</span>
            <span className="w-[17px]" />
            {COLUMNS.map((c) => (
              <button key={c.key} type="button" onClick={() => hit(c.key)}
                aria-sort={sort === c.key ? (desc ? "descending" : "ascending") : "none"}
                className={`flex items-center justify-end gap-1.5 whitespace-nowrap text-right
                            hover:text-foreground ${sort === c.key ? "text-foreground" : ""} ${
                  PHONE.includes(c.key) ? "" : "hidden md:flex"}`}>
                {c.label}
                {sort === c.key
                  ? (desc ? <ChevronDown size={14} strokeWidth={2} /> : <ChevronUp size={14} strokeWidth={2} />)
                  : <ChevronsUpDown size={13} strokeWidth={2} className="text-dim" />}
              </button>
            ))}
          </div>

          {/* Two words, the way an exchange says it, and the one thing to do
              about it at the row's end. */}
          {markets.length > 0 && rows.length === 0 && (
            <div className="flex items-center justify-between gap-4 px-3 py-5 text-[14px] sm:px-5">
              <span className="text-muted-foreground">
                {group === "watchlist" && !query.trim() ? "Star a market to keep it here" : "No results"}
              </span>
              {query.trim() && (
                <a href={`/list?q=${encodeURIComponent(query.trim())}`}
                  className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground">
                  <NavIcon name="list" size={16} />
                  List {query.trim().toUpperCase()}
                </a>
              )}
            </div>
          )}

          {(markets.length ? rows : (Array.from({ length: 10 }) as (Market | undefined)[]))
            .map((m, i) => m ? (
              <MarketPeek key={m.symbol} m={m}>
              <a href={`/trade?symbol=${m.symbol}`}
                className={`group grid ${GRID} items-center gap-2 border-b border-line px-3
                            py-3.5 last:border-0 hover:bg-panel2/60 sm:gap-3 sm:px-5`}>
                <span className="flex min-w-0 items-center gap-3">
                  <TickerLogo m={m} size={36} />
                  <span className="min-w-0">
                    <span title={m.name} className="block truncate text-[15.5px] font-medium">{m.name}</span>
                    <span className="block truncate text-[13px] text-muted-foreground">
                      {m.symbol}
                      <span className="hidden sm:inline">{m.observed ? " · opened by anyone" : " · Pyth"}</span>
                    </span>
                  </span>
                </span>
                {/*
                 * Inside the row's link, so it has to stop the press from
                 * following it -- starring a market is the one thing here that
                 * is not a request to go and look at it.
                 */}
                <button type="button" aria-pressed={saved.includes(m.symbol)}
                  aria-label={`${saved.includes(m.symbol) ? "Unstar" : "Star"} ${m.symbol}`}
                  onClick={(e) => { e.preventDefault(); toggle(m.symbol); }}
                  className={`press -my-3 grid place-items-center py-3
                    transition-colors ${saved.includes(m.symbol)
                    ? "text-brand" : "text-dim hover:text-foreground"}`}>
                  <Star on={saved.includes(m.symbol)} />
                </button>
                <span className="n text-right text-[15px]">{price(m.price)}</span>
                <span className="n hidden text-right text-[15px] md:block">
                  {compact(m.oi)}
                </span>
                {/* The move as a coloured figure, the way every screener prints
                    it: the colour says the direction, the sign says it again. */}
                <span className={`n text-right text-[15px] ${tone(m.changePct)}`}>
                  {pct(m.changePct)}
                </span>
                <span className="n hidden text-right text-[15px] md:block">
                  {compact(m.volume24h)}
                </span>
                {/* Liquidity as a chip, because it is the figure that decides
                    whether the rest of the row is reachable in any size. */}
                <span className="hidden justify-end md:flex">
                  <span className="n rounded-[10px] bg-panel2 px-3 py-1.5 text-[15px]
                                   group-hover:bg-panel3">
                    {compact(roomOf(m))}
                  </span>
                </span>
              </a>
              </MarketPeek>
            ) : (
              <div key={i} className="h-[69px] border-b border-line last:border-0" />
            ))}
        </div>

      </Shell>
        </div>
      </div>

      </main>
      <SiteFooter />
    </div>
  );
}
