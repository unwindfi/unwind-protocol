import { useEffect, useState } from "react";
import { BatchClock, useNow } from "@/components/BatchClock";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/motion/tabs";

/// The book's tabs: words on the panel's rule, the open one underlined.
// The terminal's tab row: 12px text, the selected one underlined in violet.
const TAB = "min-h-0 h-9 px-2.5 py-0 text-[12px] font-normal";
const LINE = "bottom-[-1px] h-[2px] rounded-full bg-tab";
import { Gauge } from "@/components/market/Gauge";
import { Ripeness, statusOf } from "@/components/Ripeness";
import { poolFill, useHasBackend, type Batch, type Market, type Trade } from "@/lib/api";
import { compact, hhmmss, pnum } from "@/lib/format";

/// Caption over figure, the stat tiles' manner without the tile: the wide
/// panel's way of stating a number.
const Stat = ({ k, v, cls = "" }: { k: string; v: string; cls?: string }) => (
  <div className="min-w-0">
    <div className="text-[12.5px] text-muted-foreground">{k}</div>
    <div className={`n mt-1.5 truncate text-[16px] font-medium ${cls}`}>{v}</div>
  </div>
);

const px = (p: number | null | undefined) => (p ? pnum(p) : "–");

/// Caption over figure, small, for the book's three-up row.
const Fig = ({ k, v, cls = "", sub }: { k: string; v: string; cls?: string; sub?: string }) => (
  <div className="min-w-0">
    <div className="text-[11px] text-muted-foreground">{k}</div>
    <div className={`n mt-1 truncate text-[15px] font-medium leading-none ${cls}`}>{v}</div>
    {sub && <div className="n mt-1 text-[10.5px] text-dim">{sub}</div>}
  </div>
);

/// One resting order. Size is drawn as a bar behind the row, so relative
/// weight reads without anyone having to compare the numbers. Makers are
/// marked: they rest as liquidity and only ever meet takers.
const Order = ({ price, size, bid, isMaker, widest }: {
  price: number; size: number; bid: boolean; isMaker: boolean; widest: number;
}) => (
  <div className="relative grid grid-cols-2 gap-1.5 px-5 py-[3px] text-[12px] sm:px-6">
    <i
      className={`absolute inset-y-0 right-0 block ${bid ? "bg-up/10" : "bg-down/10"}`}
      style={{ width: `${(size / widest) * 100}%` }}
    />
    <span className={`relative n ${bid ? "text-up" : "text-down"}`}>
      {pnum(price)}
      {isMaker && <span className="ml-1 text-[10.5px] text-dim" title="Maker">M</span>}
    </span>
    <span className="relative n text-right">{compact(size)}</span>
  </div>
);

/// The opening auction: a listed market still earning its mark.
///
/// The same book as every other batch, only longer. Orders rest until the
/// mark has seasoned and then all clear at one price in the first batch, so
/// being first in is worth exactly as much as being last in: nothing. What
/// the panel owes the reader is when that is, and where the book would cross
/// if it were now.
function OpeningClock({ opening, indicative }: {
  opening: NonNullable<Batch["opening"]>; indicative: Batch["indicative"];
}) {
  const now = useNow(1000);
  const left = Math.max(0, opening.opensAtMs - now);
  const mm = Math.floor(left / 60_000);
  const ss = Math.floor((left % 60_000) / 1000);
  const frac = Math.min(1, opening.readings / Math.max(1, opening.readingsNeeded));

  return (
    <>
      <div className="flex items-baseline justify-between text-[12px]">
        <span className="font-medium text-foreground">Opening auction</span>
        <span className="n">
          {left > 0 ? `opens in ${mm}:${String(ss).padStart(2, "0")}` : "opening…"}
        </span>
      </div>
      {/* Fills rather than drains: what is running here is the mark being
          earned, reading by reading, not a window closing on anyone. */}
      <div className="mt-1.5 h-[3px] overflow-hidden rounded-full bg-panel3">
        <i className="block h-full w-full origin-left bg-foreground"
          style={{ transform: `scaleX(${frac})`, transition: "transform 700ms var(--ease-out-strong)" }} />
      </div>
      <div className="mt-1.5 flex justify-between text-[10.5px] text-dim">
        <span className="n">{compact(indicative.bidUsd)} bid · {compact(indicative.askUsd)} ask</span>
        <span className="n">
          {indicative.buy.price != null || indicative.sell.price != null
            ? `buy ${px(indicative.buy.price)} · sell ${px(indicative.sell.price)}`
            : "no cross yet"}
        </span>
      </div>
    </>
  );
}

/// Seconds since the last clear, ticking on its own so the book behind it
/// does not redraw once a second to move one figure.
function Ago({ t }: { t: number }) {
  const now = useNow(1000);
  const s = Math.max(0, Math.round((now - t) / 1000));
  return <>{s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`} ago</>;
}

/// The pool's share of each recent clear, kept in the page as the batches go
/// by. The server reports one running total; this is the same figure clear by
/// clear, which is what shows whether it is falling.
const HISTORY = 40;
function usePoolShareHistory(symbol: string, last: Batch["last"] | undefined) {
  const [h, setH] = useState<{ symbol: string; list: { t: number; share: number }[] }>(
    { symbol, list: [] });
  useEffect(() => {
    if (!last || last.matched <= 0) return;
    setH((prev) => {
      const list = prev.symbol === symbol ? prev.list : [];
      if (list.length && list[list.length - 1].t >= last.t) return prev;
      const share = Math.min(100, (last.poolUsd / last.matched) * 100);
      return { symbol, list: [...list, { t: last.t, share }].slice(-HISTORY) };
    });
  }, [symbol, last]);
  return h.symbol === symbol ? h.list : [];
}

/// The auction, as it is happening.
///
/// This is the one screen that shows what the venue actually does differently:
/// the two prices the last batch cleared at (takers buying from makers, and
/// takers selling to them), how much of that the pool had to fill, and the
/// orders resting in the next one. Rendered as a book because it is a book.
/// The pool fills only the takers the makers leave standing.
function BatchTab({ m, batch }: { m: Market; batch: Batch | null; narrow: boolean }) {
  const history = usePoolShareHistory(m.symbol, batch?.last);
  const backend = useHasBackend();
  if (!batch) {
    // With a server behind the page, a missing batch is a read that has not
    // come back yet (devnet's RPC rate-limits at busy times), not a missing chain.
    return (
      <div className="px-5 py-8 text-center text-[12.5px] leading-relaxed text-dim">
        {backend === false ? "Devnet offline." : "Loading batch"}
      </div>
    );
  }
  if (!batch.exists) {
    return (
      <div className="px-5 py-8 text-center text-[12.5px] leading-relaxed text-dim">
        No batch open yet.
      </div>
    );
  }

  const asks = batch.resting.filter((o) => !o.isBid).sort((a, b) => b.price - a.price);
  const bids = batch.resting.filter((o) => o.isBid).sort((a, b) => b.price - a.price);
  const widest = Math.max(1, ...batch.resting.map((o) => o.size));

  const last = batch.last;
  const pool = last ? Math.min(last.poolUsd, last.matched) : 0;
  const book = last ? Math.max(0, last.matched - pool) : 0;
  const lastShare = last && last.matched > 0 ? (pool / last.matched) * 100 : null;
  const share = batch.poolSharePct;

  /*
   * The last clear first, then the book.
   *
   * It used to be one row of five small figures under a drain bar, the same
   * weight as the batch number beside them. But the clearing prices are the
   * venue's output, and the pool's part of the fill is the number the whole
   * design has to answer for; the countdown moved up to the market header,
   * where it is always in view, and these took its place at the top.
   */
  return (
    <div className="flex flex-col">
      {/* One line: the clock, then when the last batch cleared. What the
          batch is waiting for is the clock's own caption. */}
      <div className="flex items-center justify-between gap-3 px-4 pt-3 sm:px-5">
        <BatchClock m={m} batch={batch} compact />
        {last && (
          <span className="n text-[11.5px] text-muted-foreground">
            Last clear <Ago t={last.t} />
          </span>
        )}
      </div>

      {batch.opening && (
        <div className="px-4 pt-3 sm:px-5">
          <OpeningClock opening={batch.opening} indicative={batch.indicative} />
        </div>
      )}

      {/*
       * The last clear as three figures in a row. Before anything has
       * cleared there is one dash per column and nothing else: a bar of
       * zero split between makers and pool, and a pool share of nothing
       * over no clears, were five ways of saying "not yet".
       */}
      <div className="grid grid-cols-3 gap-x-3 px-4 py-3 sm:px-5">
        <Fig k="Buy" v={last?.buyPrice ? pnum(last.buyPrice) : "–"} cls={last?.buyPrice ? "text-up" : "text-dim"} />
        <Fig k="Sell" v={last?.sellPrice ? pnum(last.sellPrice) : "–"} cls={last?.sellPrice ? "text-down" : "text-dim"} />
        <Fig k="Matched" v={last && last.matched > 0 ? compact(last.matched) : "–"}
          cls={last && last.matched > 0 ? "" : "text-dim"}
          sub={lastShare != null ? `pool ${lastShare.toFixed(0)}%` : undefined} />
      </div>

      {last && last.matched > 0 && (
        <div className="px-4 pb-3 sm:px-5">
          <div className="flex h-[3px] gap-[2px] overflow-hidden rounded-full bg-panel3">
            <i className="block h-full rounded-full bg-foreground"
              style={{ width: `${(book / last.matched) * 100}%` }} />
            <i className="block h-full rounded-full bg-dim"
              style={{ width: `${(pool / last.matched) * 100}%` }} />
          </div>
          <div className="n mt-1.5 flex justify-between text-[11px] text-muted-foreground">
            <span>Makers {compact(book)}</span>
            <span>Pool {compact(pool)}{share != null && <> · {share.toFixed(1)}% all clears</>}</span>
          </div>
          {history.length > 1 && (
            <div className="mt-2 flex h-6 items-end gap-[2px] overflow-hidden"
              aria-label={`Pool share of the last ${history.length} clears`}>
              {history.map((x) => (
                <i key={x.t} title={`${x.share.toFixed(0)}%`}
                  className={`block w-[4px] flex-none rounded-[1px]
                              ${x.share > 50 ? "bg-down/70" : "bg-foreground/60"}`}
                  style={{ height: `${Math.max(2, x.share)}%` }} />
              ))}
            </div>
          )}
        </div>
      )}

      <div className="border-t border-line">
        {batch.resting.length === 0
          ? <div className="px-4 py-5 text-[12px] text-dim sm:px-5">
              {batch.opening
                ? "Nothing resting. Orders clear together at open."
                : "Nothing resting."}
            </div>
          : <>
              <div className="grid grid-cols-2 gap-1.5 px-4 py-2 text-[11px] text-dim sm:px-5">
                <span>Resting</span><span className="text-right">Size</span>
              </div>
              <div className="pane-scroll max-h-[240px] pb-2">
                {asks.map((o, i) => <Order key={`a${i}`} {...o} bid={false} widest={widest} />)}
                {/* The last two clearing prices, where a spread would sit on a
                    continuous book: what takers paid makers, and what makers
                    paid takers. */}
                <div className="my-1 flex items-center gap-2 px-5 sm:px-6">
                  <i className="h-px flex-1 bg-line" />
                  <span className="n text-[11px]">
                    {last ? `${px(last.buyPrice)} / ${px(last.sellPrice)}` : "–"}
                  </span>
                  <i className="h-px flex-1 bg-line" />
                </div>
                {bids.map((o, i) => <Order key={`b${i}`} {...o} bid widest={widest} />)}
              </div>
            </>}
      </div>
    </div>
  );
}

/// The side column: the auction first, then the tape, then what the pool can
/// still absorb behind it.
export function BookPanel({
  m, trades, utilization, batch, narrow = false,
}: {
  m: Market; trades: Trade[]; utilization?: number; batch: Batch | null;
  /// A column beside the chart in the terminal rather than a panel under it:
  /// one column of figures, and each tab scrolls inside the column's height.
  narrow?: boolean;
}) {
  const maxLong = Math.max(0, Math.min(m.freeLiquidity, m.capLong));
  const maxShort = Math.max(0, Math.min(m.freeLiquidity, m.capShort));
  const total = maxLong + maxShort || 1;

  return (
    /*
     * Under the chart, full width, on a page that scrolls. The terminal puts
     * it beside the chart instead (`narrow`), because there the fold is the
     * constraint: a book under the chart pushes positions out of view.
     */
    <section className="flex min-h-0 flex-1 flex-col">
      <Tabs defaultValue="batch" variant="underline" className="flex min-h-0 flex-1 flex-col">
        <div className="flex-none border-b border-line px-2">
          <TabsList className="-mb-px gap-1 border-0">
            <TabsTrigger value="batch" className={TAB} indicatorClassName={LINE}>Batch</TabsTrigger>
            <TabsTrigger value="trades" className={TAB} indicatorClassName={LINE}>Trades</TabsTrigger>
            <TabsTrigger value="liquidity" className={TAB} indicatorClassName={LINE}>Liquidity</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="batch"
          className={`mt-0 flex min-h-0 flex-1 flex-col ${narrow ? "pane-scroll" : ""}`}>
          <BatchTab m={m} batch={batch} narrow={narrow} />
        </TabsContent>

        <TabsContent value="trades" className="mt-0 flex min-h-0 flex-1 flex-col">
          {trades.length === 0
            ? <div className="grid flex-1 place-items-center px-5 py-8 text-[12.5px] text-dim">
                No trades yet
              </div>
            : <>
                <div className="grid flex-none grid-cols-3 gap-1.5 px-5 py-2 text-[11.5px] text-dim sm:px-6">
                  <span>Price</span><span className="text-right">Size</span><span className="text-right">Time</span>
                </div>
                <div className={`pane-scroll pb-2 ${narrow ? "min-h-0 flex-1" : "max-h-[240px]"}`}>
                  {trades.map((t, i) => (
                    <div key={i} className="grid grid-cols-3 gap-1.5 px-5 py-[3px] text-[12px] sm:px-6">
                      <span className={t.side === "buy" ? "text-up" : "text-down"}>{pnum(t.price)}</span>
                      <span className="text-right">{compact(t.size)}</span>
                      <span className="text-right text-muted-foreground">{hhmmss(t.t)}</span>
                    </div>
                  ))}
                </div>
              </>}
        </TabsContent>

        <TabsContent value="liquidity"
          className={`mt-0 grid gap-x-10 gap-y-6 px-5 py-5 ${narrow
            ? "pane-scroll min-h-0 flex-1 content-start" : "sm:px-6 md:grid-cols-[240px_1fr]"}`}>
          {/*
           * The dial and the long/short split on the left, the figures across
           * the right. As a column of key-value rows it was built for the old
           * 264px rail; at full width it was seven long rules.
           *
           * A market still ripening gets its gates instead: depth is not the
           * question until it can be traded at all.
           */}
          <div>
            {m.observed && !m.observed.tradeable ? (
              <div className="pb-3">
                <Ripeness o={m.observed} />
                <p className="text-pretty mt-3 text-[12px] leading-relaxed text-muted-foreground">
                  {statusOf(m).detail}. {m.observed.budgetUsd > 0
                    ? "Orders clear together at open, at one price."
                    : "Opens after 15m of readings, once backed."}
                </p>
              </div>
            ) : (
              <Gauge compact
                value={total > 0 ? (maxLong + maxShort) / (maxLong + maxShort + m.oi || 1) : 0}
                display={compact(maxLong + maxShort)}
                caption="free to open"
                tone={maxLong + maxShort > 0 ? "fill-brand" : "fill-panel3"} />
            )}
            <div className="flex h-[5px] overflow-hidden rounded-full bg-panel3">
              <i className="block h-full bg-up" style={{ width: `${(maxLong / total) * 100}%` }} />
              <i className="block h-full bg-down" style={{ width: `${(maxShort / total) * 100}%` }} />
            </div>
            <div className="mt-2 flex justify-between text-[11.5px]">
              <span className="text-up">{compact(maxLong)} long</span>
              <span className="text-down">short {compact(maxShort)}</span>
            </div>
          </div>
          <div className={`grid content-center grid-cols-2 gap-x-6 gap-y-5 ${narrow ? "" : "sm:grid-cols-3"}`}>
            {/* Bids in the buy colour and asks in the sell colour, as on every
                other book. */}
            <Stat k="Bid" v={pnum(m.bid)} cls="text-up" />
            <Stat k="Ask" v={pnum(m.ask)} cls="text-down" />
            <Stat k="Spread" v={`${(m.spreadBps / 50).toFixed(3)}%`} />
            <Stat k="Max long" v={compact(maxLong)} />
            <Stat k="Max short" v={compact(maxShort)} />
            {/* The most one batch fills a side with no makers: below the caps. */}
            <Stat k="Per batch" v={compact(poolFill(m))} />
            <Stat k="Pool free" v={compact(m.freeLiquidity)} />
            <Stat k="Utilization" v={utilization != null ? `${utilization.toFixed(2)}%` : "–"} />
          </div>
        </TabsContent>
      </Tabs>
    </section>
  );
}
