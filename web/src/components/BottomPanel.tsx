import { useEffect, useMemo, useRef, useState } from "react";
import { Table } from "@/components/motion/table";
import type { TableColumn } from "@/components/motion/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/Tabs";
import { getFills, usePoll } from "@/lib/api";
import type { Account, Market, Position, Trade } from "@/lib/api";
import { hhmmss, money, pct, price, tone } from "@/lib/format";

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

/// The height a box has been given, for the table, which virtualises its rows
/// and so needs a number rather than a flex rule.
function useHeight<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [h, setH] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setH(Math.floor(e.contentRect.height)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, h] as const;
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
          r.isLong ? "bg-up/15 text-up" : "bg-down/15 text-down"}`}>
          {r.isLong ? "LONG" : "SHORT"} {r.leverage.toFixed(1)}x
        </span>
        <span className={`n ml-auto text-[13px] font-semibold ${tone(r.pnl)}`}>
          {money(r.pnl)} <span className="text-[11px] font-normal">({pct(r.pnlPct)})</span>
        </span>
      </div>

      <div className="mt-3 grid grid-cols-4 gap-2">
        <KV k="Size">{money(r.size, 0)}</KV>
        <KV k="Entry">{r.entry.toFixed(2)}</KV>
        <KV k="Mark">{r.mark.toFixed(2)}</KV>
        <KV k="Liq."><span className="text-down">{r.liqPrice ? r.liqPrice.toFixed(2) : "–"}</span></KV>
      </div>

      <div className="mt-3 flex items-center gap-2">
        <span className="text-[11.5px] text-muted-foreground">
          Margin <span className="n text-foreground">{money(r.collateral)}</span>
        </span>
        <span className="text-[11.5px] text-muted-foreground">
          Funding <span className={`n ${tone(-r.funding)}`}>{money(-r.funding)}</span>
        </span>
        <button disabled={busy} onClick={() => onClose(r.symbol)}
          className="press ml-auto min-h-[36px] rounded-full border border-line px-4 text-[12.5px]
                     font-medium transition-colors hover:border-foreground/40 active:bg-panel3
                     disabled:opacity-40">
          Close
        </button>
      </div>
    </div>
  );
}

export function BottomPanel({
  account, trades, busy, onClose, mobile = false, docked = false,
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
  const [bodyRef, bodyH] = useHeight<HTMLDivElement>();
  const bySymbol = useMemo(() => new Map(markets.map((m) => [m.symbol, m])), [markets]);
  const orders = account?.orders ?? [];
  // Read only while the tab is open: a wallet's fills change once a batch, and
  // nobody is reading them from any other tab.
  const fillsOpen = tab === "fills" && !!owner;
  const fills = usePoll(() => (fillsOpen ? getFills(owner) : Promise.resolve(NO_FILLS)),
    5000, [owner, fillsOpen]) ?? NO_FILLS;

  const positions = useMemo<PosRow[]>(
    () => Object.entries(account?.positions ?? {}).map(([symbol, p]) => ({ ...p, symbol })),
    [account]
  );

  const posCols: TableColumn<PosRow>[] = [
    { key: "symbol", header: "Market", width: "150px",
      cell: (r) => (<span><b>{r.symbol}</b>{" "}
        <span className="text-muted-foreground">{r.leverage.toFixed(1)}x</span></span>) },
    { key: "side", header: "Side", width: "80px",
      cell: (r) => (<span className={`font-semibold ${r.isLong ? "text-up" : "text-down"}`}>
        {r.isLong ? "LONG" : "SHORT"}</span>) },
    { key: "size", header: "Position Value", align: "right", sortable: true,
      cell: (r) => money(r.size, 0) },
    { key: "entry", header: "Entry Price", align: "right", cell: (r) => r.entry.toFixed(2) },
    { key: "mark", header: "Mark Price", align: "right", cell: (r) => r.mark.toFixed(2) },
    { key: "pnl", header: "PNL (ROE %)", align: "right", sortable: true,
      cell: (r) => (<span className={tone(r.pnl)}>{money(r.pnl)}{" "}
        <span className="text-muted-foreground">({pct(r.pnlPct)})</span></span>) },
    { key: "liqPrice", header: "Liq. Price", align: "right",
      cell: (r) => <span className="text-down">{r.liqPrice ? r.liqPrice.toFixed(2) : "–"}</span> },
    { key: "collateral", header: "Margin", align: "right", cell: (r) => money(r.collateral) },
    { key: "funding", header: "Funding", align: "right",
      cell: (r) => <span className={tone(-r.funding)}>{money(-r.funding)}</span> },
    { key: "act", header: "", width: "80px",
      cell: (r) => (
        <button disabled={busy} onClick={() => onClose(r.symbol)}
          className="press h-7 rounded-full border border-line px-3 text-[12px] font-medium
                     transition-colors hover:border-foreground/40 disabled:opacity-40">
          Close
        </button>) },
  ];

  const tradeCols: TableColumn<Trade>[] = [
    { key: "t", header: "Time", width: "110px",
      cell: (r) => <span className="text-muted-foreground">{hhmmss(r.t)}</span> },
    { key: "symbol", header: "Market", width: "110px", cell: (r) => <b>{r.symbol}</b> },
    { key: "kind", header: "Action", width: "110px" },
    { key: "side", header: "Side", width: "90px",
      cell: (r) => (<span className={`font-semibold ${r.side === "buy" ? "text-up" : "text-down"}`}>
        {r.side.toUpperCase()}</span>) },
    { key: "size", header: "Size", align: "right", sortable: true, cell: (r) => money(r.size, 0) },
    { key: "price", header: "Price", align: "right", cell: (r) => r.price.toFixed(2) },
  ];

  const liqs = account?.liquidations ?? [];
  const liqCols: TableColumn<(typeof liqs)[number]>[] = [
    { key: "t", header: "Time", width: "110px",
      cell: (r) => <span className="text-muted-foreground">{hhmmss(r.t)}</span> },
    { key: "symbol", header: "Market", width: "110px", cell: (r) => <b>{r.symbol}</b> },
    { key: "isLong", header: "Side", width: "90px",
      cell: (r) => (<span className={`font-semibold ${r.isLong ? "text-up" : "text-down"}`}>
        {r.isLong ? "LONG" : "SHORT"}</span>) },
    { key: "size", header: "Size", align: "right", cell: (r) => money(r.size, 0) },
    { key: "price", header: "Price", align: "right", cell: (r) => r.price.toFixed(2) },
    { key: "returned", header: "Returned", align: "right", cell: (r) => money(r.returned) },
  ];

  const orderCols: TableColumn<Order>[] = [
    { key: "symbol", header: "Market", width: "130px", cell: (r) => <b>{r.symbol}</b> },
    { key: "kind", header: "Type", width: "120px", cell: (r) => orderKind(r) },
    { key: "isLong", header: "Side", width: "80px",
      cell: (r) => (<span className={`font-semibold ${r.isLong ? "text-up" : "text-down"}`}>
        {r.isLong ? "LONG" : "SHORT"}</span>) },
    { key: "triggerPrice", header: "Trigger", align: "right",
      cell: (r) => `${r.triggerAbove ? "≥" : "≤"} ${price(r.triggerPrice)}` },
    // A take profit or stop with no size closes the whole position.
    { key: "sizeUsd", header: "Size", align: "right",
      cell: (r) => (r.sizeUsd > 0 ? money(r.sizeUsd, 0)
        : <span className="text-muted-foreground">All</span>) },
    { key: "collateralUsd", header: "Margin", align: "right",
      cell: (r) => (r.collateralUsd > 0 ? money(r.collateralUsd) : "–") },
    { key: "expiryTs", header: "Expires", align: "right",
      cell: (r) => <span className="text-muted-foreground">
        {r.expiryTs > 0 ? hhmmss(r.expiryTs * 1000) : "GTC"}</span> },
    { key: "act", header: "", width: "90px",
      cell: (r) => onCancelOrder && (
        <button disabled={busy} onClick={() => onCancelOrder(r)}
          className="press h-7 rounded-full border border-line px-3 text-[12px] font-medium
                     transition-colors hover:border-foreground/40 disabled:opacity-40">
          Cancel
        </button>) },
  ];

  /*
   * Funding, per position: the side's rate now and what it has cost so far.
   * The rate is quoted per hour, so the hourly figure is the rate on the
   * position's size, which is what a trader weighs against holding it.
   */
  const fundCols: TableColumn<PosRow>[] = [
    { key: "symbol", header: "Market", width: "130px", cell: (r) => <b>{r.symbol}</b> },
    { key: "side", header: "Side", width: "80px",
      cell: (r) => (<span className={`font-semibold ${r.isLong ? "text-up" : "text-down"}`}>
        {r.isLong ? "LONG" : "SHORT"}</span>) },
    { key: "size", header: "Position Value", align: "right", cell: (r) => money(r.size, 0) },
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
    { key: "t", header: "Time", width: "110px",
      cell: (r) => <span className="text-muted-foreground">{hhmmss(r.t)}</span> },
    { key: "symbol", header: "Market", width: "110px", cell: (r) => <b>{r.symbol}</b> },
    { key: "kind", header: "Action", width: "110px", cell: (r) => FILL_ACTION[r.kind] ?? r.kind },
    { key: "side", header: "Side", width: "90px",
      cell: (r) => (<span className={`font-semibold ${r.side === "buy" ? "text-up" : "text-down"}`}>
        {r.side.toUpperCase()}</span>) },
    { key: "size", header: "Size", align: "right", cell: (r) => money(r.size, 0) },
    { key: "price", header: "Price", align: "right", cell: (r) => r.price.toFixed(2) },
  ];

  /*
   * The table's own frame -- a border, a page-coloured body and a tinted
   * header -- inside a panel that already has an edge read as a box clipped
   * into a box. On the page it is the panel's rows, nothing more; and it is
   * as tall as the panel's body, so there is one scroller rather than a
   * table scrolling inside a box that also scrolls.
   */
  const flat = "border-0 bg-transparent px-2 [&_th]:bg-panel [&_th]:text-[12.5px] " +
    "[&_th]:font-normal [&_th]:text-dim [&_td]:text-[13px]";
  /// As tall as its rows, up to a cap: a fixed height left one position
  /// floating in a panel of blank rows, and none floating in more.
  const tableH = (n: number) => (docked ? Math.max(120, bodyH)
    : n === 0 ? 200 : Math.min(300, 48 * (n + 1) + 2));

  const empty = (s: string) => <div className="p-6 text-center text-[12.5px] text-dim">{s}</div>;

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
          {!mobile && <TabsTrigger soft value="orders">Open Orders{count(orders.length)}</TabsTrigger>}
          {!mobile && <TabsTrigger soft value="funding">Funding</TabsTrigger>}
          <TabsTrigger soft={!mobile} value="history">Trade History</TabsTrigger>
          {!mobile && <TabsTrigger soft value="fills">Order History</TabsTrigger>}
          <TabsTrigger soft={!mobile} value="liqs">Liquidations</TabsTrigger>
        </TabsList>
      </Tabs>

      <div ref={bodyRef}
        className={mobile ? "pane-scroll min-h-0 flex-1" : docked ? "min-h-0 flex-1 overflow-hidden" : ""}>
        {tab === "orders" && (
          <Table data={orders} columns={orderCols} getRowId={(r) => r.address}
            className={flat} height={tableH(orders.length)}
            emptyState={empty("No take profits, stops or limit orders")} />
        )}
        {tab === "funding" && (
          positions.length === 0 && nowRates ? nowRates
            : <Table data={positions} columns={fundCols} getRowId={(r) => r.symbol}
                className={flat} height={tableH(positions.length)}
                emptyState={empty("No open positions")} />
        )}
        {tab === "fills" && (
          <Table data={fills} columns={fillCols} getRowId={(_, i) => String(i)}
            className={flat} height={tableH(fills.length)}
            emptyState={empty(owner ? "No fills since the server last started" : "Connect a wallet to see its fills")} />
        )}
        {tab === "positions" && (
          mobile
            ? positions.length === 0
              ? empty("No open positions")
              : positions.map((r) => (
                  <PositionCard key={r.symbol} r={r} busy={busy} onClose={onClose} />))
            : <Table data={positions} columns={posCols} getRowId={(r) => r.symbol}
                className={flat} height={tableH(positions.length)}
                emptyState={empty("No open positions")} />
        )}
        {/*
         * Balances was a tab here and a box in the rail, saying the same
         * thing twice: USDC total, available, in position, unrealized, and
         * the xLP holding. The rail's Account box is the one that survives --
         * it is beside the ticket those figures constrain, where they are
         * read while sizing an order rather than found by opening a tab.
         */}
        {tab === "history" && (
          <div className={mobile ? "strip-scroll [&>*]:min-w-[560px]" : ""}>
            <Table data={trades} columns={tradeCols} getRowId={(_, i) => String(i)}
              className={mobile ? undefined : flat} height={mobile ? undefined : tableH(trades.length)}
              emptyState={empty("No trades yet")} />
          </div>
        )}
        {tab === "liqs" && (
          <div className={mobile ? "strip-scroll [&>*]:min-w-[620px]" : ""}>
            <Table data={liqs} columns={liqCols} getRowId={(_, i) => String(i)}
              className={mobile ? undefined : flat} height={mobile ? undefined : tableH(liqs.length)}
              emptyState={empty("No liquidations")} />
          </div>
        )}
      </div>
    </section>
  );
}
