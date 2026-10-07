import { useCallback, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Table } from "@/components/motion/table";
import type { TableColumn } from "@/components/motion/table";
import { getFills, poolFill, usePoll } from "@/lib/api";
import { createPortal } from "react-dom";
import { ExternalLink, X } from "lucide-react";
import { TickerLogo } from "@/components/TickerLogo";
import { solscanTx } from "@/lib/tx";
import { useModalFocus } from "@/lib/hooks/use-modal-focus";
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
/// The phone keeps three of them.
const TABS = [
  { key: "positions", label: "Positions", phone: true },
  { key: "orders", label: "Open orders", phone: false },
  { key: "funding", label: "Funding", phone: false },
  // The wallet's own fills. The market's tape, every trader's fills, is the
  // book's Trades tab; shown here it listed each buy twice, once as a sell.
  { key: "history", label: "Trade history", phone: true },
  { key: "liqs", label: "Liquidations", phone: true },
];
const DASH = <span className="text-muted-foreground">–</span>;
/// A row at the 12px type: a terminal's density, not a list's.
const ROW = 36;

/// The size a box has been given: its height for the table, which
/// virtualises its rows and so needs a number rather than a flex rule, and
/// its width for which columns fit.
///
/// Watched from a callback ref, which runs whenever the element appears. A
/// mount-time effect found no element on a page's first load in production
/// (development runs effects twice, which hid it), so the size stayed 0: the
/// docked table sat at its 120px floor and the figure columns never packed.
function useSize<T extends HTMLElement>() {
  const [size, setSize] = useState({ w: 0, h: 0 });
  const watcher = useRef<ResizeObserver | null>(null);
  const ref = useCallback((el: T | null) => {
    watcher.current?.disconnect();
    watcher.current = null;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setSize({
      w: Math.floor(e.contentRect.width), h: Math.floor(e.contentRect.height) }));
    ro.observe(el);
    watcher.current = ro;
  }, []);
  return [ref, size.h, size.w] as const;
}

/*
 * Close asks first, in a dialog that says what the close will do before
 * anything is signed: how much of the position, the price it is expected to
 * fill at, the PnL and fee that leaves, and when it lands. A position is the
 * one thing on this panel a stray tap cannot take back.
 *
 * Closing is a reduce-only market order into the next batch. All of it goes
 * as the plain close the panel always sent; part of it goes as a sized close,
 * which the program holds to the market's minimum position unless it is
 * everything left. A position larger than the pool fills in one batch may
 * close in part, so the dialog says so before, not the toast after.
 */
/// The smallest reduce-only order the program takes, unless it closes all
/// that is left. The site lists every market at this floor; the API does not
/// send a market's own.
const MIN_CLOSE_USD = 10;
const STEPS = [25, 50, 75, 100];

/// A label and its figure on one line, ruled like the Earn dialog's summary.
function DRow({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-t border-line py-2 first:border-t-0">
      <span className="flex-none text-[13px] text-muted-foreground">{k}</span>
      <span className="n text-right text-[13px] font-medium">{children}</span>
    </div>
  );
}

function CloseButton({
  row, market, busy, onClose, className,
}: {
  row: PosRow; market?: Market; busy: boolean;
  onClose: (symbol: string, size?: number) => void; className: string;
}) {
  const [open, setOpen] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  useModalFocus(panel, open, () => setOpen(false), field);
  const titleId = useId();
  const [amount, setAmount] = useState("");
  const start = () => { setAmount(row.size.toFixed(2)); setOpen(true); };

  const amt = Number(amount);
  const full = amt >= row.size - 0.005;
  const size = full ? row.size : amt;
  const share = row.size > 0 ? size / row.size : 0;
  const problem = !(amt > 0) ? "Enter an amount to close."
    : amt > row.size + 0.005 ? `The position is ${money(row.size)}.`
    : !full && amt < MIN_CLOSE_USD ? `At least ${money(MIN_CLOSE_USD, 0)}, unless it closes the whole position.`
    : null;

  const fill = market ? poolFill(market) : null;
  const partly = fill != null && size > fill;
  // What the close books: the PnL marked at the price it is expected to fill
  // at, on the share being closed.
  const pnlAll = row.entry > 0
    ? row.size * ((row.exit - row.entry) / row.entry) * (row.isLong ? 1 : -1) - row.funding
    : row.pnl;
  const pnl = pnlAll * share;
  const pnlPct = row.collateral > 0 ? (pnlAll / row.collateral) * 100 : 0;
  const feeBps = market?.closeFeeBps ?? market?.openFeeBps;
  const fee = feeBps != null ? size * (feeBps / 1e4) : null;
  const payout = market?.payoutPct;

  const go = () => {
    if (problem || busy) return;
    setOpen(false);
    if (full) onClose(row.symbol);
    else onClose(row.symbol, Number(size.toFixed(2)));
  };

  const side = row.isLong ? "Long" : "Short";
  return (
    <>
      <button disabled={busy} aria-label={`Close ${row.symbol} position`} aria-haspopup="dialog"
        onClick={start} className={className}>
        Close
      </button>
      {open && createPortal(
        <div className="fixed inset-0 z-[95] flex items-end justify-center sm:items-center sm:p-6">
          <button type="button" aria-label="Cancel" tabIndex={-1} onClick={() => setOpen(false)}
            className="absolute inset-0 cursor-default bg-black/60" />
          <div ref={panel} role="dialog" aria-modal="true" aria-labelledby={titleId}
            className="relative max-h-[92dvh] w-full overflow-y-auto rounded-t-[20px] border border-line
                       bg-panel safe-b sm:max-w-[380px] sm:rounded-[20px]">
            <div className="px-4 pb-4 pt-4 sm:px-5">
              <header className="flex items-center gap-3">
                {market && <TickerLogo m={market} size={32} />}
                <span className="min-w-0 flex-1">
                  <h2 id={titleId} className="truncate text-[15px] font-medium">Close {row.symbol}</h2>
                  <span className="n block truncate text-[12.5px] text-muted-foreground">
                    <span className={row.isLong ? "text-up" : "text-down"}>{side}</span>
                    {" "}· {money(row.size, 0)} · {row.leverage.toFixed(1)}x
                  </span>
                </span>
                <button type="button" onClick={() => setOpen(false)} aria-label="Cancel"
                  className="press grid size-8 place-items-center rounded-full text-muted-foreground
                             transition-colors hover:bg-panel2 hover:text-foreground">
                  <X size={16} strokeWidth={1.75} />
                </button>
              </header>

              <div className="mt-4">
                <div className="mb-2 flex items-baseline justify-between gap-3">
                  <label htmlFor={`${titleId}-amt`} className="text-[13px] text-foreground">Amount</label>
                  <button type="button" onClick={() => setAmount(row.size.toFixed(2))}
                    className="n -mx-1 rounded-[6px] px-1 text-[12px] text-dim outline-none transition-colors hover:text-foreground focus-visible:bg-panel2">
                    Position {money(row.size)}
                    <span className="ml-1.5 font-medium text-foreground">MAX</span>
                  </button>
                </div>
                <div className="relative">
                  <input id={`${titleId}-amt`} ref={field} inputMode="decimal" autoComplete="off" value={amount}
                    placeholder="0.00"
                    aria-invalid={!!problem} aria-describedby={problem ? `${titleId}-err` : undefined}
                    onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); go(); } }}
                    className="n h-11 w-full rounded-[10px] border border-line bg-panel2 pl-3.5 pr-14
                               text-[16px] font-medium transition-colors placeholder:text-dim focus:border-brand" />
                  <span className="pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2 text-[12px] text-dim">
                    USD
                  </span>
                </div>
                <div role="group" aria-label="Share of the position" className="mt-2 grid grid-cols-4 gap-1.5">
                  {STEPS.map((p) => {
                    const on = Math.abs(share * 100 - p) < 0.5 && !problem;
                    return (
                      <button key={p} type="button" aria-pressed={on}
                        onClick={() => setAmount(p === 100 ? row.size.toFixed(2)
                          : (Math.floor(row.size * p) / 100).toFixed(2))}
                        className={`press n h-7 rounded-full text-[12px] transition-colors ${on
                          ? "bg-panel3 text-foreground"
                          : "bg-panel2 text-muted-foreground hover:text-foreground"}`}>
                        {p}%
                      </button>
                    );
                  })}
                </div>
                {problem && amount !== "" && (
                  <p id={`${titleId}-err`} className="mt-2 text-[12px] text-down">{problem}</p>
                )}
              </div>

              <button type="button" disabled={busy || !!problem} onClick={go}
                className="press mt-4 h-10 w-full rounded-full bg-foreground text-[13.5px] font-medium
                           text-background transition-opacity hover:opacity-90
                           disabled:pointer-events-none disabled:opacity-35">
                {full ? "Close position" : `Close ${money(size)}`}
              </button>
            </div>

            <div className="border-t border-line bg-panel2 px-4 pb-4 pt-1 sm:px-5">
              <DRow k="Est. fill">{pnum(row.exit)}</DRow>
              <DRow k="Est. PnL"><span className={tone(pnl)}>{money(pnl)} ({pct(pnlPct)})</span></DRow>
              {fee != null && <DRow k="Fee">{money(fee)}</DRow>}
              {payout != null && payout < 100 && <DRow k="Profit paid">{payout.toFixed(0)}%</DRow>}
              {partly && (
                <p className="text-pretty border-t border-line pt-2.5 text-[12px] leading-relaxed text-dim">
                  Fills up to {money(fill!, 0)} per batch; the rest stays open.
                </p>
              )}
            </div>
          </div>
        </div>,
        document.body)}
    </>
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
  r, busy, onClose, markets,
}: { r: PosRow; busy: boolean; onClose: (symbol: string, size?: number) => void; markets: Market[] }) {
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
        <CloseButton row={r} market={markets.find((x) => x.symbol === r.symbol)} busy={busy} onClose={onClose}
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
  /// Closes a position: all of it with no size, that many USD of it with one.
  onClose: (symbol: string, size?: number) => void;
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
  // Where the selected tab sits in the strip, for its underline. Measured
  // after layout, and again when the strip resizes or a count changes width.
  const strip = useRef<HTMLDivElement>(null);
  const [line, setLine] = useState({ x: 0, w: 0 });
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

  useLayoutEffect(() => {
    const el = strip.current;
    if (!el) return;
    const place = () => {
      const b = el.querySelector<HTMLElement>(`[data-tab="${tab}"]`);
      if (b) setLine({ x: b.offsetLeft, w: b.offsetWidth });
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(el);
    return () => ro.disconnect();
  }, [tab, positions.length, orders.length]);

  /*
   * Every tab opens with the same two columns at the same widths, Market and
   * Side, so switching tabs changes what follows them rather than moving
   * them. Each tab used to set its own (110 to 130px, 64 to 90px), and the
   * history tabs led with Time, so the first columns jumped on every switch.
   * Time now closes those tabs.
   *
   * The figures share the rest of the width. Every tab carries seven to
   * nine columns (fees, closed PnL, entry and mark included), so they stretch
   * to about the same widths in each and the panel has no empty band. Packed
   * at fixed widths instead, a wide screen left a third of it blank.
   */
  const W = { market: "108px", side: "52px", kind: "112px", time: "96px", act: "76px" };
  const sideCell = (isLong: boolean) => (
    <span className={isLong ? "text-up" : "text-down"}>{isLong ? "Long" : "Short"}</span>);
  // The time links to the transaction that settled the row, where the server
  // kept it, so a fill or a liquidation can be checked on Solscan.
  const timeCol = { key: "t", header: "Time", width: W.time,
    cell: (r: { t: number; sig?: string }) => r.sig
      ? <a href={solscanTx(r.sig)} target="_blank" rel="noreferrer" title="View on Solscan"
          className="inline-flex items-center gap-1 text-muted-foreground transition-colors hover:text-foreground">
          {hhmmss(r.t)}<ExternalLink size={11} strokeWidth={2} aria-hidden />
        </a>
      : <span className="text-muted-foreground">{hhmmss(r.t)}</span> };

  const posCols: TableColumn<PosRow>[] = [
    { key: "symbol", header: "Market", width: W.market,
      cell: (r) => (<span><b>{r.symbol}</b>{" "}
        <span className="text-muted-foreground">{r.leverage.toFixed(1)}x</span></span>) },
    { key: "side", header: "Side", width: W.side, cell: (r) => sideCell(r.isLong) },
    { key: "size", header: "Value",
      cell: (r) => money(r.size, 0) },
    { key: "entry", header: "Entry", cell: (r) => pnum(r.entry) },
    ...(narrow ? [] : [{ key: "mark", header: "Mark",
      cell: (r: PosRow) => <span title={`Closes at ${pnum(r.exit)}`}>{pnum(r.mark)}</span> }]),
    { key: "pnl", header: "PnL (ROE)",
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
    { key: "liqPrice", header: "Liq. price",
      cell: (r) => <span className="text-down">{r.liqPrice ? pnum(r.liqPrice) : "–"}</span> },
    { key: "collateral", header: "Margin", cell: (r) => money(r.collateral) },
    // Funding paid so far has a tab of its own; in the docked table it was
    // the column that pushed Close off the panel's edge.
    ...(docked ? [] : [{ key: "funding", header: "Funding",
      cell: (r: PosRow) => <span className={tone(-r.funding)}>{money(-r.funding)}</span> }]),
    { key: "act", header: "", width: W.act,
      cell: (r) => (
        <CloseButton row={r} market={markets.find((x) => x.symbol === r.symbol)} busy={busy} onClose={onClose}
          className="press text-[12px] font-medium text-foreground transition-opacity
                     hover:opacity-70 disabled:opacity-35" />) },
  ];


  const liqs = account?.liquidations ?? [];
  const liqCols: TableColumn<(typeof liqs)[number]>[] = [
    { key: "symbol", header: "Market", width: W.market, cell: (r) => <b>{r.symbol}</b> },
    { key: "isLong", header: "Side", width: W.side, cell: (r) => sideCell(r.isLong) },
    { key: "size", header: "Size", cell: (r) => money(r.size, 0) },
    { key: "price", header: "Price", cell: (r) => pnum(r.price) },
    { key: "pnl", header: "Loss",
      cell: (r) => (r.pnl == null ? DASH : <span className={tone(r.pnl)}>{money(r.pnl)}</span>) },
    { key: "fee", header: "Fee", cell: (r) => (r.fee == null ? DASH : money(r.fee)) },
    { key: "returned", header: "Returned", cell: (r) => money(r.returned) },
    timeCol,
  ];

  const orderCols: TableColumn<Order>[] = [
    { key: "symbol", header: "Market", width: W.market, cell: (r) => <b>{r.symbol}</b> },
    { key: "isLong", header: "Side", width: W.side, cell: (r) => sideCell(r.isLong) },
    { key: "kind", header: "Type", width: W.kind, cell: (r) => orderKind(r) },
    { key: "triggerPrice", header: "Trigger",
      cell: (r) => `${r.triggerAbove ? "≥" : "≤"} ${price(r.triggerPrice)}` },
    // A take profit or stop with no size closes the whole position.
    // "All" of a position that is gone (liquidated, say) is nothing; said
    // so, since it would otherwise fire against the next one opened here.
    { key: "sizeUsd", header: "Size",
      cell: (r) => (r.sizeUsd > 0 ? money(r.sizeUsd, 0)
        : r.kind === 0 && !positions.some((p) => p.symbol === r.symbol)
          ? <span className="text-down">No position</span>
          : <span className="text-muted-foreground">All</span>) },
    { key: "collateralUsd", header: "Margin",
      cell: (r) => (r.collateralUsd > 0 ? money(r.collateralUsd) : "–") },
    { key: "expiryTs", header: "Expires",
      cell: (r) => <span className="text-muted-foreground">
        {r.expiryTs > 0 ? hhmmss(r.expiryTs * 1000) : "GTC"}</span> },
    { key: "act", header: "", width: W.act,
      cell: (r) => onCancelOrder && (
        <button disabled={busy} onClick={() => onCancelOrder(r)}
          className="press text-[12px] font-medium text-foreground transition-opacity
                     hover:opacity-70 disabled:opacity-35">
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
    { key: "size", header: "Value", cell: (r) => money(r.size, 0) },
    { key: "entry", header: "Entry", cell: (r) => pnum(r.entry) },
    { key: "mark", header: "Mark", cell: (r) => pnum(r.mark) },
    { key: "rate", header: "Rate / 1h",
      cell: (r) => {
        const v = rateOf(bySymbol.get(r.symbol), r.isLong);
        return v == null ? "–" : <span className={tone(-v)}>{signedPct(v)}</span>;
      } },
    { key: "hour", header: "Next 1h",
      cell: (r) => {
        const v = rateOf(bySymbol.get(r.symbol), r.isLong);
        return v == null ? "–" : <span className={tone(-v)}>{money(-(r.size * v) / 100)}</span>;
      } },
    { key: "funding", header: "Paid so far",
      cell: (r) => <span className={tone(-r.funding)}>{money(-r.funding)}</span> },
  ];

  const fillCols: TableColumn<Trade>[] = [
    { key: "symbol", header: "Market", width: W.market, cell: (r) => <b>{r.symbol}</b> },
    { key: "side", header: "Side", width: W.side,
      cell: (r) => (<span className={r.side === "buy" ? "text-up" : "text-down"}>
        {r.side === "buy" ? "Buy" : "Sell"}</span>) },
    { key: "kind", header: "Action", width: W.kind, cell: (r) => FILL_ACTION[r.kind] ?? r.kind },
    { key: "size", header: "Size", cell: (r) => money(r.size, 0) },
    { key: "price", header: "Price", cell: (r) => pnum(r.price) },
    { key: "fee", header: "Fee", cell: (r) => (r.fee == null ? DASH : money(r.fee)) },
    // An open has no PnL to show; a close's arrives a moment after the fill.
    { key: "pnl", header: "Closed PnL",
      cell: (r) => (r.pnl == null ? DASH : <span className={tone(r.pnl)}>{money(r.pnl)}</span>) },
    timeCol,
  ];

  /*
   * The table's own frame -- a border, a page-coloured body and a tinted
   * header -- inside a panel that already has an edge read as a box clipped
   * into a box. On the page it is the panel's rows, nothing more; and it is
   * as tall as the panel's body, so there is one scroller rather than a
   * table scrolling inside a box that also scrolls.
   */
  const flat = "border-0 bg-transparent px-2 [&_th]:bg-panel [&_th]:text-[12px] " +
    "[&_th]:font-normal [&_th]:text-muted-foreground [&_td]:text-[12px] " +
    // The widths above are hints to a table sized by its content: a crowded
    // one (Positions on a laptop) squeezed Market and Side with the rest, so
    // they still moved. As minimums they hold, and the figures give way.
    "[&_th:nth-child(1)]:min-w-[108px] [&_td:nth-child(1)]:min-w-[108px] " +
    "[&_th:nth-child(2)]:min-w-[52px] [&_td:nth-child(2)]:min-w-[52px]";
  /// As tall as its rows, up to a cap: a fixed height left one position
  /// floating in a panel of blank rows, and none floating in more.
  const tableH = (n: number) => (docked ? Math.max(120, bodyH)
    : n === 0 ? 200 : Math.min(300, ROW * (n + 1) + 2));

  const empty = (s: string) => <div className="p-6 text-center text-[12.5px] text-dim">{s}</div>;
  // A connected wallet whose account has not been read yet has nothing to
  // say about its positions: "None" there would be a guess.
  const mine = (s: string, nobody: string) => empty(!owner ? nobody : account ? s : "Loading");

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
      {/*
       * Text on one hairline, the active tab brighter and underlined, as a
       * terminal's tabs read. They were rounded pills with count chips, which
       * made the panel look like a template rather than a trading screen.
       */}
      <div ref={strip} role="tablist" aria-label="Account"
        className="strip-scroll relative flex flex-none items-stretch gap-1 border-b border-line px-2">
        {TABS.filter((t) => !mobile || t.phone).map((t) => {
          const n = t.key === "positions" ? positions.length : t.key === "orders" ? orders.length : 0;
          return (
            <button key={t.key} type="button" role="tab" aria-selected={tab === t.key}
              data-tab={t.key} onClick={() => setTab(t.key)}
              className="h-9 whitespace-nowrap px-2.5 text-[12px] text-muted-foreground transition-colors
                         hover:text-foreground aria-selected:text-foreground">
              {t.label}{n > 0 && <span className="n"> ({n})</span>}
            </button>
          );
        })}
        {/* One underline that slides to the selected tab rather than one per
            tab that blinks: the eye follows it from the old tab to the new. */}
        <span aria-hidden
          className="pointer-events-none absolute bottom-[-1px] left-0 h-[2px] rounded-full bg-tab
                     transition-[transform,width] duration-moderate ease-out motion-reduce:transition-none"
          style={{ width: line.w, transform: `translateX(${line.x}px)`, opacity: line.w ? 1 : 0 }} />
      </div>

      <div ref={bodyRef}
        className={mobile ? "pane-scroll min-h-0 flex-1" : docked ? "min-h-0 flex-1 overflow-hidden" : ""}>
        {tab === "orders" && (
          <Table data={orders} columns={orderCols} getRowId={(r) => r.address} rowHeight={ROW}
            className={flat} height={tableH(orders.length)}
            emptyState={mine("No take profits, stops or limit orders", "Connect a wallet to see its orders")} />
        )}
        {/* With nothing open the header row stays and the market's rates
            fill the body: swapping the table for a line of text changed the
            panel's shape on every switch to this tab. */}
        {tab === "funding" && (
          <Table data={positions} columns={fundCols} getRowId={(r) => r.symbol} rowHeight={ROW}
            className={flat} height={tableH(positions.length)}
            emptyState={account && nowRates ? nowRates
              : mine("No open positions", "Connect a wallet to see its positions")} />
        )}

        {tab === "positions" && (
          mobile
            ? positions.length === 0
              ? mine("No open positions", "Connect a wallet to see its positions")
              : positions.map((r) => (
                  <PositionCard key={r.symbol} r={r} busy={busy} onClose={onClose} markets={markets} />))
            : <Table data={positions} columns={posCols} getRowId={(r) => r.symbol} rowHeight={ROW}
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
            <Table data={fills} columns={fillCols} getRowId={(_, i) => String(i)} rowHeight={ROW}
              className={mobile ? undefined : flat} height={mobile ? undefined : tableH(fills.length)}
              emptyState={mine("No fills yet", "Connect a wallet to see its fills")} />
          </div>
        )}
        {tab === "liqs" && (
          <div className={mobile ? "strip-scroll fade-right pr-10 [&>*]:min-w-[620px]" : ""}>
            <Table data={liqs} columns={liqCols} getRowId={(_, i) => String(i)} rowHeight={ROW}
              className={mobile ? undefined : flat} height={mobile ? undefined : tableH(liqs.length)}
              emptyState={empty("No liquidations")} />
          </div>
        )}
      </div>
    </section>
  );
}
