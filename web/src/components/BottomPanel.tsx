import { useEffect, useMemo, useRef, useState } from "react";
import { Table } from "@/components/motion/table";
import type { TableColumn } from "@/components/motion/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/Tabs";
import { getFills, usePoll } from "@/lib/api";
import type { Account, Market, Position, Trade } from "@/lib/api";
import { hhmmss, money, pct, pnum, price, tone } from "@/lib/format";

type PosRow = Position & { symbol: string };
type Order = Account["orders"][number];

/// What an order is, in the words the ticket used to set it. Slot 0 is the
/// take profit and slot 1 the stop; a limit order rests in any slot above.
/// The same reading as the portfolio page's.
const orderKind = (o: Order) =>
  o.kind === 1 ? (o.isLong ? "Limit buy" : "Limit sell")
    : o.slot === 0 ? "Take profit" : "Stop loss";

/// A side's current funding rate in percent an hour, positive to pay. Null
/// where the server has no program to read it from.
const rateOf = (m: Market | undefined, isLong: boolean) => {
  const bps = isLong ? m?.fundingRateLongBps : m?.fundingRateShortBps;
  return bps == null ? null : bps / 100;
};
const signedPct = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(4)}%`;

const FILL_ACTION: Record<string, string> = {
  open: "Open", close: "Close", liquidation: "Liquidated",
};
const NO_FILLS: Trade[] = [];

/// The size a box has been given: its height for the table, which
/// virtualises its rows and so needs a number rather than a flex rule, and
/// its width for which columns fit.
function useSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setSize({
      w: Math.floor(e.contentRect.width), h: Math.floor(e.contentRect.height) }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size.h, size.w] as const;
}

/// Close takes two taps: the first arms it for three seconds and says what
/// the second will do. A position is the one thing on this panel a stray tap
/// cannot take back.
function CloseButton({
  symbol, busy, onClose, className,
}: { symbol: string; busy: boolean; onClose: (symbol: string) => void; className: string }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <button disabled={busy}
      aria-label={armed ? `Confirm close ${symbol} position` : `Close ${symbol} position`}
      onClick={() => {
        if (!armed) return setArmed(true);
        setArmed(false);
        onClose(symbol);
      }}
      onBlur={() => setArmed(false)}
      className={`${className} ${armed ? "border-down text-down" : ""}`}>
      {armed ? "Confirm" : "Close"}
    </button>
  );
}

/*
 * A position as a card, for the phone.
 *
 * The desktop table is ten columns wide. Shrinking it to 375px gives either a
 * horizontal scroller -- where the market you are reading scrolls out of view
 * before you reach its PnL -- or columns too narrow to hold a price. The same
 * fields stacked are legible at a glance, and Close becomes a real target
 * instead of an 11px link.
 */
function KV({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[11.5px] text-muted-foreground">{k}</div>
      <div className="n mt-0.5 text-[12.5px] font-semibold">{children}</div>
    </div>
  );
}

function PositionCard({
  r, busy, onClose,
}: { r: PosRow; busy: boolean; onClose: (symbol: string) => void }) {
  return (
    <div className="border-b border-line px-4 py-3.5">
      <div className="flex items-center gap-2">
        <b className="text-[14px] font-medium">{r.symbol}</b>
        <span className={`rounded-full px-2 py-px text-[11px] font-medium ${
          r.isLong ? "bg-up/10 text-up" : "bg-down/10 text-down"}`}>
          {r.isLong ? "Long" : "Short"} {r.leverage.toFixed(1)}x
        </span>
        <span className={`n ml-auto text-[13px] font-semibold ${tone(r.pnl)}`}>
          {money(r.pnl)} <span className="text-[11px] font-normal">({pct(r.pnlPct)})</span>
        </span>
      </div>

      <div className="mt-3 grid grid-cols-4 gap-2">
        <KV k="Size">{money(r.size, 0)}</KV>
        <KV k="Entry">{pnum(r.entry)}</KV>
        <KV k="Mark"><span title={`Closes at ${pnum(r.exit)}`}>{pnum(r.mark)}</span></KV>
        <KV k="Liq."><span className="text-down">{r.liqPrice ? pnum(r.liqPrice) : "–"}</span></KV>
      </div>

      <div className="mt-3 flex items-center gap-2">
        <span className="text-[11.5px] text-muted-foreground">
          Margin <span className="n text-foreground">{money(r.collateral)}</span>
        </span>
        <span className="text-[11.5px] text-muted-foreground">
          Funding <span className={`n ${tone(-r.funding)}`}>{money(-r.funding)}</span>
        </span>
        <CloseButton symbol={r.symbol} busy={busy} onClose={onClose}
          className="press ml-auto min-h-[36px] rounded-full border border-line px-4 text-[12.5px]
                     font-medium transition-colors hover:border-foreground/40 active:bg-panel3
                     disabled:opacity-35" />
      </div>
    </div>
  );
}

export function BottomPanel({
  account, busy, onClose, mobile = false, docked = false,
  markets = [], market, owner, onCancelOrder,
}: {
  account: Account | null;
  trades: Trade[];
  busy: boolean;
  onClose: (symbol: string) => void;
  mobile?: boolean;
  /// Fills a fixed-height box in the terminal, scrolling inside it, rather
  /// than being as tall as its rows.
  docked?: boolean;
  /// For each position's funding rate. The tabs past positions, history and
  /// liquidations are desktop only; the phone keeps its three.
  markets?: Market[];
  /// The market on screen, whose rates the funding tab shows with nothing open.
  market?: Market;
  /// The connected wallet, for its own fills.
  owner?: string;
  onCancelOrder?: (o: Order) => void;
}) {
  const [tab, setTab] = useState("positions");
  const [bodyRef, bodyH, bodyW] = useSize<HTMLDivElement>();
  // Positions carries the most columns. On a laptop's docked panel they
  // did not fit beside Close, so the table squeezed every column, Market and
  // Close included. Mark goes there: PnL already counts it, and the market
  // header shows the one on screen.
  const narrow = docked && bodyW > 0 && bodyW < 760;
  const bySymbol = useMemo(() => new Map(markets.map((m) => [m.symbol, m])), [markets]);
  const orders = account?.orders ?? [];
  // Read only while the tab is open: a wallet's fills change once a batch, and
  // nobody is reading them from any other tab.
  const fillsOpen = tab === "history" && !!owner;
  const fills = usePoll(() => (fillsOpen ? getFills(owner) : Promise.resolve(NO_FILLS)),
    5000, [owner, fillsOpen]) ?? NO_FILLS;

  const positions = useMemo<PosRow[]>(
    () => Object.entries(account?.positions ?? {}).map(([symbol, p]) => ({ ...p, symbol })),
    [account]
  );

  /*
   * Every tab opens with the same two columns at the same widths, Market and
   * Side, so switching tabs changes what follows them rather than moving
   * them. Each tab used to set its own (110 to 130px, 64 to 90px), and the
   * history tabs led with Time, so the first columns jumped on every switch.
   * Time now closes those tabs.
   *
   * The figures get widths too, when the panel has room for them. Left to
   * share a wide panel, three of them sat hundreds of pixels apart; packed,
   * they sit together and the table's empty last column takes what is left.
   * On a laptop's panel they do not fit at those widths, and the table
   * cannot narrow a column below the width it was given, so there they share
   * the space as before.
   */
  const W = { market: "108px", side: "52px", kind: "112px", time: "96px", act: "76px",
    num: "112px", pnl: "150px" };
  const sideCell = (isLong: boolean) => (
    <span className={isLong ? "text-up" : "text-down"}>{isLong ? "Long" : "Short"}</span>);
  const pack = <R,>(cols: TableColumn<R>[]): TableColumn<R>[] => {
    const px = (w?: string) => (w ? parseInt(w, 10) || 0 : 0);
    const figure = (c: TableColumn<R>) => !c.width && c.align === "right";
    const need = cols.reduce((t, c) => t + (figure(c) ? px(c.key === "pnl" ? W.pnl : W.num) : px(c.width)), 16);
    return bodyW >= need
      ? cols.map((c) => (figure(c) ? { ...c, width: c.key === "pnl" ? W.pnl : W.num } : c))
      : cols;
  };
  const timeCol = { key: "t", header: "Time", width: W.time, align: "right" as const,
    cell: (r: { t: number }) => <span className="text-muted-foreground">{hhmmss(r.t)}</span> };

  const posCols: TableColumn<PosRow>[] = [
    { key: "symbol", header: "Market", width: W.market,
      cell: (r) => (<span><b>{r.symbol}</b>{" "}
        <span className="text-muted-foreground">{r.leverage.toFixed(1)}x</span></span>) },
    { key: "side", header: "Side", width: W.side, cell: (r) => sideCell(r.isLong) },
    { key: "size", header: "Value", align: "right", sortable: true,
      cell: (r) => money(r.size, 0) },
    { key: "entry", header: "Entry", align: "right", cell: (r) => pnum(r.entry) },
    ...(narrow ? [] : [{ key: "mark", header: "Mark", align: "right" as const,
      cell: (r: PosRow) => <span title={`Closes at ${pnum(r.exit)}`}>{pnum(r.mark)}</span> }]),
    { key: "pnl", header: "PnL (ROE)", align: "right", sortable: true,
      cell: (r) => {
        // A winner in a market that cannot cover every winner is paid a
        // fair share of its profit on close; say so beside the figure.
        const paid = bySymbol.get(r.symbol)?.payoutPct;
        return (<span className={tone(r.pnl)}>{money(r.pnl)}{" "}
          <span className="text-muted-foreground">({pct(r.pnlPct)})</span>
          {r.pnl > 0 && paid != null && paid < 99.95 && (
            <span className="block text-[11px] text-down" title="This market can't pay every winner in full right now">
              paid at {paid.toFixed(0)}%
            </span>
          )}</span>);
      } },
    { key: "liqPrice", header: "Liq. price", align: "right",
      cell: (r) => <span className="text-down">{r.liqPrice ? pnum(r.liqPrice) : "–"}</span> },
    { key: "collateral", header: "Margin", align: "right", cell: (r) => money(r.collateral) },
    // Funding paid so far has a tab of its own; in the docked table it was
    // the column that pushed Close off the panel's edge.
    ...(docked ? [] : [{ key: "funding", header: "Funding", align: "right" as const,
      cell: (r: PosRow) => <span className={tone(-r.funding)}>{money(-r.funding)}</span> }]),
    { key: "act", header: "", width: W.act,
      cell: (r) => (
        <CloseButton symbol={r.symbol} busy={busy} onClose={onClose}
          className="press h-7 rounded-full border border-line px-3 text-[12px] font-medium
                     transition-colors hover:border-foreground/40 disabled:opacity-35" />) },
  ];


  const liqs = account?.liquidations ?? [];
  const liqCols: TableColumn<(typeof liqs)[number]>[] = [
    { key: "symbol", header: "Market", width: W.market, cell: (r) => <b>{r.symbol}</b> },
    { key: "isLong", header: "Side", width: W.side, cell: (r) => sideCell(r.isLong) },
    { key: "size", header: "Size", align: "right", cell: (r) => money(r.size, 0) },
    { key: "price", header: "Price", align: "right", cell: (r) => pnum(r.price) },
    { key: "returned", header: "Returned", align: "right", cell: (r) => money(r.returned) },
    timeCol,
  ];

  const orderCols: TableColumn<Order>[] = [
    { key: "symbol", header: "Market", width: W.market, cell: (r) => <b>{r.symbol}</b> },
    { key: "isLong", header: "Side", width: W.side, cell: (r) => sideCell(r.isLong) },
    { key: "kind", header: "Type", width: W.kind, cell: (r) => orderKind(r) },
    { key: "triggerPrice", header: "Trigger", align: "right",
      cell: (r) => `${r.triggerAbove ? "≥" : "≤"} ${price(r.triggerPrice)}` },
    // A take profit or stop with no size closes the whole position.
    // "All" of a position that is gone (liquidated, say) is nothing; said
    // so, since it would otherwise fire against the next one opened here.
    { key: "sizeUsd", header: "Size", align: "right",
      cell: (r) => (r.sizeUsd > 0 ? money(r.sizeUsd, 0)
        : r.kind === 0 && !positions.some((p) => p.symbol === r.symbol)
          ? <span className="text-down">No position</span>
          : <span className="text-muted-foreground">All</span>) },
    { key: "collateralUsd", header: "Margin", align: "right",
      cell: (r) => (r.collateralUsd > 0 ? money(r.collateralUsd) : "–") },
    { key: "expiryTs", header: "Expires", align: "right",
      cell: (r) => <span className="text-muted-foreground">
        {r.expiryTs > 0 ? hhmmss(r.expiryTs * 1000) : "GTC"}</span> },
    { key: "act", header: "", width: W.act,
      cell: (r) => onCancelOrder && (
        <button disabled={busy} onClick={() => onCancelOrder(r)}
          className="press h-7 rounded-full border border-line px-3 text-[12px] font-medium
                     transition-colors hover:border-foreground/40 disabled:opacity-35">
          Cancel
        </button>) },
  ];

  /*
   * Funding, per position: the side's rate now and what it has cost so far.
   * The rate is quoted per hour, so the hourly figure is the rate on the
   * position's size, which is what a trader weighs against holding it.
   */
  const fundCols: TableColumn<PosRow>[] = [
    { key: "symbol", header: "Market", width: W.market, cell: (r) => <b>{r.symbol}</b> },
    { key: "side", header: "Side", width: W.side, cell: (r) => sideCell(r.isLong) },
    { key: "size", header: "Value", align: "right", cell: (r) => money(r.size, 0) },
    { key: "rate", header: "Rate / 1h", align: "right",
      cell: (r) => {
        const v = rateOf(bySymbol.get(r.symbol), r.isLong);
        return v == null ? "–" : <span className={tone(-v)}>{signedPct(v)}</span>;
      } },
    { key: "hour", header: "Next 1h", align: "right",
      cell: (r) => {
        const v = rateOf(bySymbol.get(r.symbol), r.isLong);
        return v == null ? "–" : <span className={tone(-v)}>{money(-(r.size * v) / 100)}</span>;
      } },
    { key: "funding", header: "Paid so far", align: "right",
      cell: (r) => <span className={tone(-r.funding)}>{money(-r.funding)}</span> },
  ];

  const fillCols: TableColumn<Trade>[] = [
    { key: "symbol", header: "Market", width: W.market, cell: (r) => <b>{r.symbol}</b> },
    { key: "side", header: "Side", width: W.side,
      cell: (r) => (<span className={r.side === "buy" ? "text-up" : "text-down"}>
        {r.side === "buy" ? "Buy" : "Sell"}</span>) },
    { key: "kind", header: "Action", width: W.kind, cell: (r) => FILL_ACTION[r.kind] ?? r.kind },
    { key: "size", header: "Size", align: "right", cell: (r) => money(r.size, 0) },
    { key: "price", header: "Price", align: "right", cell: (r) => pnum(r.price) },
    timeCol,
  ];

  /*
   * The table's own frame -- a border, a page-coloured body and a tinted
   * header -- inside a panel that already has an edge read as a box clipped
   * into a box. On the page it is the panel's rows, nothing more; and it is
   * as tall as the panel's body, so there is one scroller rather than a
   * table scrolling inside a box that also scrolls.
   */
  const flat = "border-0 bg-transparent px-2 [&_th]:bg-panel [&_th]:text-[12.5px] " +
    "[&_th]:font-normal [&_th]:text-dim [&_td]:text-[13px] " +
    // The widths above are hints to a table sized by its content: a crowded
    // one (Positions on a laptop) squeezed Market and Side with the rest, so
    // they still moved. As minimums they hold, and the figures give way.
    "[&_th:nth-child(1)]:min-w-[108px] [&_td:nth-child(1)]:min-w-[108px] " +
    "[&_th:nth-child(2)]:min-w-[52px] [&_td:nth-child(2)]:min-w-[52px]";
  /// As tall as its rows, up to a cap: a fixed height left one position
  /// floating in a panel of blank rows, and none floating in more.
  const tableH = (n: number) => (docked ? Math.max(120, bodyH)
    : n === 0 ? 200 : Math.min(300, 48 * (n + 1) + 2));

  const empty = (s: string) => <div className="p-6 text-center text-[12.5px] text-dim">{s}</div>;
  // A connected wallet whose account has not been read yet has nothing to
  // say about its positions: "None" there would be a guess.
  const mine = (s: string, nobody: string) => empty(!owner ? nobody : account ? s : "Loading");

  const count = (n: number) => n > 0 && <span className="n ml-1 text-dim">{n}</span>;
  const nowRates = market && (
    <div className="p-6 text-center text-[12.5px] text-dim">
      No open positions. {market.symbol} now:{" "}
      {rateOf(market, true) == null ? "rates not published" : <>
        longs <span className={tone(-rateOf(market, true)!)}>{signedPct(rateOf(market, true)!)}</span>,
        shorts <span className={tone(-rateOf(market, false)!)}>{signedPct(rateOf(market, false)!)}</span> an hour
      </>}
    </div>
  );

  return (
    <section className={mobile || docked
      // As a tab pane or a docked panel it owns its box; on the page it is
      // as tall as its table, inside a panel that already draws the edge.
      ? "flex min-h-0 flex-1 flex-col bg-panel"
      : "flex flex-none flex-col bg-panel"}>
      <Tabs value={tab} onValueChange={setTab}
        className={mobile ? "flex-none border-b border-line px-3 py-2.5"
          : docked ? "strip-scroll flex-none border-b border-line px-3 py-2"
          : "flex-none border-b border-line px-5 py-3 sm:px-6"}>
        <TabsList soft={!mobile}>
          <TabsTrigger soft={!mobile} value="positions">
            Positions{!mobile && count(positions.length)}
          </TabsTrigger>
          {!mobile && <TabsTrigger soft value="orders">Open orders{count(orders.length)}</TabsTrigger>}
          {!mobile && <TabsTrigger soft value="funding">Funding</TabsTrigger>}
          {/* One history, the wallet's own fills. The market's tape, every
              trader's fills and the maker's other side of them, is the book's
              Trades tab; shown here it listed each buy twice, once as a sell. */}
          <TabsTrigger soft={!mobile} value="history">Trade history</TabsTrigger>
          <TabsTrigger soft={!mobile} value="liqs">Liquidations</TabsTrigger>
        </TabsList>
      </Tabs>

      <div ref={bodyRef}
        className={mobile ? "pane-scroll min-h-0 flex-1" : docked ? "min-h-0 flex-1 overflow-hidden" : ""}>
        {tab === "orders" && (
          <Table data={orders} columns={pack(orderCols)} getRowId={(r) => r.address}
            className={flat} height={tableH(orders.length)}
            emptyState={mine("No take profits, stops or limit orders", "Connect a wallet to see its orders")} />
        )}
        {/* With nothing open the header row stays and the market's rates
            fill the body: swapping the table for a line of text changed the
            panel's shape on every switch to this tab. */}
        {tab === "funding" && (
          <Table data={positions} columns={pack(fundCols)} getRowId={(r) => r.symbol}
            className={flat} height={tableH(positions.length)}
            emptyState={account && nowRates ? nowRates
              : mine("No open positions", "Connect a wallet to see its positions")} />
        )}

        {tab === "positions" && (
          mobile
            ? positions.length === 0
              ? mine("No open positions", "Connect a wallet to see its positions")
              : positions.map((r) => (
                  <PositionCard key={r.symbol} r={r} busy={busy} onClose={onClose} />))
            : <Table data={positions} columns={pack(posCols)} getRowId={(r) => r.symbol}
                className={flat} height={tableH(positions.length)}
                emptyState={mine("No open positions", "Connect a wallet to see its positions")} />
        )}
        {/*
         * Balances was a tab here and a box in the rail, saying the same
         * thing twice: USDC total, available, in position, unrealized, and
         * the xLP holding. The rail's Account box is the one that survives --
         * it is beside the ticket those figures constrain, where they are
         * read while sizing an order rather than found by opening a tab.
         */}
        {tab === "history" && (
          <div className={mobile ? "strip-scroll fade-right pr-10 [&>*]:min-w-[560px]" : ""}>
            <Table data={fills} columns={pack(fillCols)} getRowId={(_, i) => String(i)}
              className={mobile ? undefined : flat} height={mobile ? undefined : tableH(fills.length)}
              emptyState={mine("No fills yet", "Connect a wallet to see its fills")} />
          </div>
        )}
        {tab === "liqs" && (
          <div className={mobile ? "strip-scroll fade-right pr-10 [&>*]:min-w-[620px]" : ""}>
            <Table data={liqs} columns={pack(liqCols)} getRowId={(_, i) => String(i)}
              className={mobile ? undefined : flat} height={mobile ? undefined : tableH(liqs.length)}
              emptyState={empty("No liquidations")} />
          </div>
        )}
      </div>
    </section>
  );
}
