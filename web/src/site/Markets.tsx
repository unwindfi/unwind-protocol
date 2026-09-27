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
import { useEffect, useMemo, useState } from "react";
import "@/site/serif.css";
import { ChevronUp, Search, Star as LucideStar } from "lucide-react";
import { PILL_INDICATOR, Shell, SiteFooter, SiteHeader } from "@/site/Chrome";
import { WalletActions } from "@/components/WalletActions";
import { Tabs, TabsList, TabsTrigger } from "@/components/motion/tabs";
import { TrendBadge } from "@/components/ui/trend-badge";
import { Checkbox } from "@/components/motion/checkbox";
import { Mark } from "@/components/Brand";
import { Board } from "@/components/Board";
import { Track } from "@/components/Track";
import { TickerLogo } from "@/components/TickerLogo";
import { getMarkets, useHasBackend, usePoll, type Market } from "@/lib/api";
import { compact, pct, price } from "@/lib/format";

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
    of: (m) => MEMES.includes(m.symbol),
    art: "/logos/BONK.png",
  },
  {
    key: "crypto", label: "Crypto",
    of: (m) => !/x$/.test(m.symbol) && !MEMES.includes(m.symbol),
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

/// What the table can be sorted by, and how each column reads a market.
const COLUMNS = [
  { key: "price", label: "Price", get: (m: Market) => m.price },
  { key: "oi", label: "Open interest", get: (m: Market) => m.oi },
  { key: "change", label: "24h change", get: (m: Market) => m.changePct },
  { key: "volume", label: "24h volume", get: (m: Market) => m.volume24h },
  { key: "liquidity", label: "Liquidity", get: (m: Market) => m.freeLiquidity },
] as const;

type SortKey = (typeof COLUMNS)[number]["key"];

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

const Caret = ({ up }: { up: boolean }) => (
  <ChevronUp size={13} strokeWidth={2.25} aria-hidden
    className={`inline-block transition-transform ${up ? "" : "rotate-180"}`} />
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
  const backend = useHasBackend();
  const markets = usePoll(getMarkets, 4000) ?? NONE;
  const { saved, toggle } = useWatchlist();
  const [group, setGroup] = useState("all");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("oi");
  const [desc, setDesc] = useState(true);
  const [source, setSource] = useState<SourceKey>("all");
  const [sourcesOpen, setSourcesOpen] = useState(false);
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
    const col = COLUMNS.find((c) => c.key === sort) ?? COLUMNS[1];
    const found = q
      ? markets.filter((m) =>
          m.symbol.toLowerCase().includes(q) || m.name.toLowerCase().includes(q))
      : markets.filter((m) => picked.of(m, saved));
    // The filters narrow whatever the group or the search returned, rather
    // than competing with it.
    const src = SOURCES.find((x) => x.key === source) ?? SOURCES[0];
    const kept = found.filter((m) =>
      src.of(m) && (!openOnly || m.session !== 2) && (!withOi || m.oi > 0));
    return [...kept].sort((a, b) =>
      desc ? col.get(b) - col.get(a) : col.get(a) - col.get(b));
  }, [markets, query, picked, saved, sort, desc, source, openOnly, withOi]);

  const filtersOn = (openOnly ? 1 : 0) + (withOi ? 1 : 0) + (source === "all" ? 0 : 1);

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

  const GRID = "grid-cols-[1.7fr_auto_1fr_.9fr] md:grid-cols-[1.9fr_auto_1fr_1.1fr_.9fr_1fr_1fr]";

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
      <div className="relative overflow-hidden border-b border-line">
        {/* The front page's violet light (waitlist/field.webp) behind the search,
            fading into the page at the foot so the table below starts clean. */}
        <img src="/waitlist/field.webp" alt="" aria-hidden
          className="pointer-events-none absolute inset-0 h-full w-full object-cover opacity-70
                     [mask-image:linear-gradient(to_bottom,black_45%,transparent)]" />
        <Shell className="relative py-12 text-center sm:py-16 md:py-24">
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
          <div className="relative mx-auto mt-9 max-w-[610px] md:mt-11">
            <Track markets={markets} />
            <span className="pointer-events-none absolute left-[18px] top-1/2 z-20
                             -translate-y-1/2 text-muted-foreground sm:left-[22px]">
              <Find />
            </span>
            <input value={query} onChange={(e) => setQuery(e.target.value)}
              placeholder="Search markets" aria-label="Search markets"
              className="relative z-10 h-[56px] w-full rounded-full border border-line
                         bg-[#121028] pl-[46px] pr-5 text-[15px] transition-colors
                         placeholder:text-muted-foreground focus:border-brand
                         focus:outline-none sm:h-[62px] sm:pl-[52px] sm:pr-6" />
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
        <div className="strip-scroll -mx-5 flex gap-3 overflow-x-auto px-5 pb-1 sm:mx-0 sm:px-0">
          {GROUPS.filter((g) => ["all", "memes", "watchlist"].includes(g.key)
            || counts[g.key] > 0)
            .map((g) => {
              const on = g.key === group && !query;
              const empty = counts[g.key] === 0;
              const art = g.art;
              const face = empty ? undefined : g.face?.(markets, saved);
              return (
                <button key={g.key} type="button" disabled={empty && g.key !== "all"}
                  onClick={() => { setGroup(g.key); setQuery(""); }} aria-pressed={on}
                  className={`press relative h-[112px] w-[204px] flex-none overflow-hidden
                              rounded-[14px] border text-left transition-colors ${
                    empty && g.key !== "all" ? "cursor-default opacity-45" : ""} ${on
                      ? "border-brand/55 bg-brand/[.09]"
                      : "border-line bg-panel hover:bg-panel2"}`}>
                  {/* Artwork bleeds off the top-right and is clipped by the
                      card, which is what stops it reading as an icon. */}
                  {/*
                   * A drawing if the group has one, and its count if not.
                   *
                   * The number is not a placeholder standing in for art. It
                   * is the one thing on the card that could not appear on
                   * anybody else's: what this group holds right now, which
                   * changes when somebody opens a market. Tabular figures, so
                   * the row does not jostle as the counts move.
                   */}
                  {/*
                   * Every card wears a logo, cut by the corner.
                   *
                   * The order is: a mark the group names, else a market from
                   * inside it, else this venue's own. A group that is empty
                   * still gets one -- a card that falls back to a bare number
                   * while its neighbours carry artwork reads as the one that
                   * failed to load, and an empty group is the case where the
                   * card most needs to look like somewhere worth pressing.
                   */}
                  <span aria-hidden
                    className="pointer-events-none absolute -right-7 -top-7 overflow-hidden
                               rounded-[22px]">
                    {art ? (
                      <img src={art} alt="" width={120} height={120}
                        onError={(e) => { e.currentTarget.style.display = "none"; }}
                        className="block" />
                    ) : face ? (
                      <TickerLogo m={face} size={120} />
                    ) : (
                      <Mark size={120} />
                    )}
                  </span>
                  <span className="absolute bottom-3.5 left-4 text-[15px] font-medium">
                    {g.label}
                  </span>
                </button>
              );
            })}
        </div>

        {/*
         * The row above the table. Sort lives here rather than only in the
         * header, because the columns it offers are dropped on a phone and
         * sorting by something you cannot see is still worth having.
         */}
        <div className="mt-7 flex flex-wrap items-center gap-2.5">
          {/*
           * The source control opens sideways, into the row it lives in.
           *
           * A menu would cover the table it is filtering, and there are three
           * answers -- not a list long enough to need one. The strip animates
           * its own column from nothing to content, so nothing below it moves
           * and the options arrive where the eye already is.
           */}
          <button type="button" onClick={() => setSourcesOpen((o) => !o)}
            aria-expanded={sourcesOpen}
            className={`press flex flex-none items-center gap-2 rounded-full border px-4 py-2
                        text-[12.5px] font-medium transition-colors ${
              source === "all"
                ? "border-line bg-panel text-foreground hover:border-line/80"
                : "border-brand/50 bg-brand/[.08] text-foreground"}`}>
            {SOURCES.find((x) => x.key === source)?.label}
            <Caret up={sourcesOpen} />
          </button>

          <div className="grid transition-[grid-template-columns] duration-300
                          ease-[cubic-bezier(0.16,1,0.3,1)]"
            style={{ gridTemplateColumns: sourcesOpen ? "1fr" : "0fr" }}>
            <div className="overflow-hidden">
              {/*
               * `w-max` is what makes this a reveal rather than a squash. In
               * a zero-width grid column the flex row inside will happily
               * shrink to fit, so the pills crush into each other on the way
               * out and spring back on the way in. Pinned to its own content
               * width, the column clips it instead, which is the motion that
               * was wanted.
               */}
              <div className={`flex w-max items-center gap-1 rounded-full border border-line
                               bg-panel p-1 transition-opacity duration-200 ${
                sourcesOpen ? "opacity-100" : "opacity-0"}`}>
                {SOURCES.map((x) => (
                  <button key={x.key} type="button" onClick={() => setSource(x.key)}
                    className={`press whitespace-nowrap rounded-full px-3 py-1.5 text-[12.5px]
                                transition-colors ${source === x.key
                      ? "bg-panel3 text-foreground"
                      : "text-muted-foreground hover:text-foreground"}`}>
                    {x.short}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/*
           * The sort row is beUI's tabs rather than a hand-rolled pill group,
           * so the indicator is one spring-driven element sliding between
           * columns instead of a background appearing and disappearing under
           * each. Controlled, because the header's own column buttons set the
           * same state and the two have to agree.
           */}
          <Tabs value={sort} onValueChange={(v) => hit(v as SortKey)} variant="pill"
            className="min-w-0 max-w-full">
            <TabsList>
              {COLUMNS.map((c) => (
                <TabsTrigger key={c.key} value={c.key} indicatorClassName={PILL_INDICATOR}
                  className="[&_[data-tabs-label]]:text-background">
                  {c.label}
                  {sort === c.key && <> <Caret up={!desc} /></>}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>

          <button type="button" onClick={() => setFiltersOpen((o) => !o)}
            aria-expanded={filtersOpen} aria-controls="market-filters"
            className={`press ml-auto flex flex-none items-center gap-2 rounded-full border
                        px-4 py-2 text-[12.5px] font-medium transition-colors ${
              filtersOn > 0
                ? "border-brand/50 bg-brand/[.08] text-foreground"
                : "border-line bg-panel text-muted-foreground hover:text-foreground"}`}>
            Filters
            {filtersOn > 0 && <span className="n text-brand">{filtersOn}</span>}
            <Caret up={filtersOpen} />
          </button>
        </div>

        {/*
         * The filters open downward, pushing the table rather than covering
         * it: the point of changing one is watching what it does to the rows,
         * and a panel over them hides the answer. Rows from 0fr to 1fr is how
         * you animate to a height nobody has measured.
         */}
        <div id="market-filters"
          className="grid transition-[grid-template-rows] duration-300
                     ease-[cubic-bezier(0.16,1,0.3,1)]"
          style={{ gridTemplateRows: filtersOpen ? "1fr" : "0fr" }}>
          <div className="overflow-hidden">
            <div className="mt-3 flex flex-wrap items-center gap-x-7 gap-y-3 rounded-xl
                            border border-line bg-panel px-4 py-3.5">
              <Checkbox checked={openOnly} onCheckedChange={setOpenOnly}
                label="Trading now" />
              <Checkbox checked={withOi} onCheckedChange={setWithOi}
                label="With open interest" />
              {filtersOn > 0 && (
                <button type="button"
                  onClick={() => { setOpenOnly(false); setWithOi(false); setSource("all"); }}
                  className="press ml-auto text-[12.5px] text-muted-foreground
                             transition-colors hover:text-foreground">
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
        <div className="mt-3.5 overflow-hidden rounded-[14px] border border-line bg-panel">
          <div className={`grid ${GRID} items-center gap-2 border-b border-line bg-panel2/50
                           px-3 py-3 text-[10.5px] uppercase tracking-[.1em] text-muted-foreground
                           sm:gap-3 sm:px-4`}>
            <span>Market</span>
            <span className="w-[17px]" />
            {COLUMNS.map((c) => (
              <button key={c.key} type="button" onClick={() => hit(c.key)}
                className={`flex items-center justify-end gap-1 text-right uppercase
                            tracking-[.1em] transition-colors hover:text-foreground ${
                  sort === c.key ? "text-foreground" : ""} ${
                  PHONE.includes(c.key) ? "" : "hidden md:flex"}`}>
                {c.label}
                {sort === c.key && <Caret up={!desc} />}
              </button>
            ))}
          </div>

          {markets.length > 0 && rows.length === 0 && (
            <p className="px-4 py-12 text-center text-[13px] text-muted-foreground">
              {group === "watchlist" && !query
                ? "Nothing starred yet."
                : <>
                    <span className="block">
                      {query.trim() ? <>No market for <span className="text-foreground">{query.trim()}</span> yet.</>
                        : "No matches."}
                    </span>
                    {query.trim() && (
                      <a href="/list" className="press mt-4 inline-flex h-9 items-center rounded-full
                                                 bg-foreground px-4 text-[13px] font-medium
                                                 text-background hover:opacity-90">
                        List it
                      </a>
                    )}
                  </>}
            </p>
          )}

          {(markets.length ? rows : (Array.from({ length: 10 }) as (Market | undefined)[]))
            .map((m, i) => m ? (
              <a key={m.symbol} href={`/trade?symbol=${m.symbol}`}
                className={`group grid ${GRID} items-center gap-2 border-b border-line px-3
                            py-3 transition-colors last:border-0 hover:bg-panel2
                            sm:gap-3 sm:px-4`}>
                <span className="flex min-w-0 items-center gap-2.5 sm:gap-3">
                  <TickerLogo m={m} size={30} />
                  <span className="min-w-0">
                    <span className="block truncate text-[14px] font-medium">{m.name}</span>
                    <span className="block truncate text-[11.5px] text-muted-foreground">
                      {m.symbol}
                      {m.observed ? " · opened by anyone" : " · Pyth"}
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
                <span className="n text-right text-[13.5px]">{price(m.price)}</span>
                <span className="n hidden text-right text-[13px] text-muted-foreground md:block">
                  {compact(m.oi)}
                </span>
                {/*
                 * Oxygen's trend badge, wearing this venue's up and down
                 * rather than its own emerald and red. The component states
                 * those as ordinary utilities, so naming ours at the call
                 * site replaces them instead of fighting them, and the two
                 * colours stay defined in one place for the whole site.
                 */}
                <span className="flex justify-end">
                  <TrendBadge trend={m.changePct < 0 ? "down" : "up"}
                    className={`n text-[12px] ${m.changePct < 0
                      ? "border-down/25 bg-down/15 text-down"
                      : "border-up/25 bg-up/15 text-up"}`}>
                    {pct(m.changePct)}
                  </TrendBadge>
                </span>
                <span className="n hidden text-right text-[13px] text-muted-foreground md:block">
                  {compact(m.volume24h)}
                </span>
                {/* Liquidity as a chip, because it is the figure that decides
                    whether the rest of the row is reachable in any size. */}
                <span className="hidden justify-end md:flex">
                  <span className="n rounded-md bg-panel3 px-2 py-1 text-[12.5px]
                                   text-muted-foreground transition-colors
                                   group-hover:bg-transparent">
                    {compact(m.freeLiquidity)}
                  </span>
                </span>
              </a>
            ) : (
              <div key={i} className="h-[62px] border-b border-line last:border-0" />
            ))}
        </div>

        {/*
         * The part-opened markets sit under the table rather than above it.
         * They are the most interesting thing here and the least useful: a
         * market opened two minutes ago has no price, no depth and nothing to
         * trade, so it cannot be what the page opens on.
         */}
        {markets.some((m) => m.observed) && (
          <div className="pt-12">
            <div className="flex flex-col gap-1 pb-4 sm:flex-row sm:items-baseline
                            sm:justify-between sm:gap-3">
              <h2 className="text-[13.5px] font-medium">Opening now</h2>
              <span className="text-[12px] text-muted-foreground">
                Live from the first price, seconds after listing
              </span>
            </div>
            <Board markets={markets} />
          </div>
        )}

        {markets.length > 0 && (
          <p className="mt-10 text-[12px] text-muted-foreground">
            Open interest:{" "}
            <span className="n text-foreground">
              {compact(markets.reduce((a, m) => a + m.oi, 0))}
            </span>.{backend === false && " Read-only deploy."}
          </p>
        )}
      </Shell>
        </div>
      </div>

      <SiteFooter />
    </div>
  );
}
