import type { ReactNode } from "react";
import type { Batch, Market, RestingOrder } from "@/lib/api";
import { compact, hhmmss, price, tone } from "@/lib/format";

function Row({ k, children, hint }: { k: string; children: ReactNode; hint?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-t border-line py-2.5">
      <span className="text-[12.5px] text-muted-foreground">
        {k}
        {hint && <span className="ml-1.5 text-[11px] text-dim">{hint}</span>}
      </span>
      <span className="n text-right text-[13px] font-medium">{children}</span>
    </div>
  );
}

const Note = ({ children }: { children: ReactNode }) => (
  <p className="py-6 text-center text-[12.5px] text-muted-foreground">{children}</p>
);

/// The same precision the rest of the page quotes at, without the dollar sign.
const px = (n: number) => price(n).replace("$", "");

type Level = { price: number; size: number; total: number };

/// Resting orders summed per price, then accumulated outward from the middle:
/// a level's total is what a taker would reach by walking the book to it.
function levels(orders: RestingOrder[], isBid: boolean): Level[] {
  const byPrice = new Map<number, number>();
  for (const o of orders) {
    if (o.isBid !== isBid) continue;
    byPrice.set(o.price, (byPrice.get(o.price) ?? 0) + o.size);
  }
  const sorted = [...byPrice].sort((a, b) => (isBid ? b[0] - a[0] : a[0] - b[0]));
  let total = 0;
  return sorted.map(([price, size]) => ({ price, size, total: (total += size) }));
}

function DepthRow({ l, max, bid }: { l: Level; max: number; bid: boolean }) {
  return (
    <div className="relative grid grid-cols-3 px-1 py-1 text-[12.5px]">
      <div className={`absolute inset-y-0 right-0 rounded-[4px] ${bid ? "bg-up/10" : "bg-down/10"}`}
        style={{ width: `${(l.total / max) * 100}%` }} />
      <span className={`n relative ${bid ? "text-up" : "text-down"}`}>{px(l.price)}</span>
      <span className="n relative text-right">{compact(l.size)}</span>
      <span className="n relative text-right text-muted-foreground">{compact(l.total)}</span>
    </div>
  );
}

/*
 * The batch's resting orders as cumulative depth.
 *
 * A ladder rather than a curve: the book is a handful of orders most of the
 * time, and a depth curve through three points draws a shape the book does
 * not have. The pool's quote sits in the middle because it is what fills any
 * taker the resting orders leave standing.
 */
export function DepthView({ m, batch, hasBackend }: {
  m: Market; batch: Batch | null | undefined; hasBackend: boolean | null;
}) {
  if (hasBackend === false) return <Note>No chain behind this deploy, so there is no batch to show.</Note>;
  if (!batch) return <Note>Reading the batch.</Note>;
  if (!batch.exists) return <Note>No batch is open for this market yet.</Note>;

  const asks = levels(batch.resting, false);
  const bids = levels(batch.resting, true);
  const max = Math.max(1, asks[asks.length - 1]?.total ?? 0, bids[bids.length - 1]?.total ?? 0);
  const { buy, sell } = batch.indicative;

  return (
    <div className="pane-scroll min-h-0 flex-1 px-1">
      <div className="grid grid-cols-3 px-1 pb-2 text-[11.5px] text-muted-foreground">
        <span>Price</span><span className="text-right">Size</span>
        <span className="text-right">Total</span>
      </div>
      {[...asks].reverse().map((l) => <DepthRow key={`a${l.price}`} l={l} max={max} bid={false} />)}
      {asks.length === 0 && <div className="px-1 py-1 text-[12px] text-dim">No asks resting</div>}
      <div className="my-1.5 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1
                      rounded-[8px] bg-panel2 px-3 py-2 text-[12.5px]">
        <span className="text-muted-foreground">Pool quote</span>
        <span className="n">
          <span className="text-up">{px(m.bid)}</span>
          <span className="text-dim"> / </span>
          <span className="text-down">{px(m.ask)}</span>
        </span>
      </div>
      {bids.map((l) => <DepthRow key={`b${l.price}`} l={l} max={max} bid />)}
      {bids.length === 0 && <div className="px-1 py-1 text-[12px] text-dim">No bids resting</div>}
      <div className="mt-3 px-1">
        <Row k="Buy flow crosses at">{buy.price != null ? px(buy.price) : "No cross"}</Row>
        <Row k="Sell flow crosses at">{sell.price != null ? px(sell.price) : "No cross"}</Row>
      </div>
    </div>
  );
}

export type FundingSample = { t: number; long: number; short: number };

/// Index units to percent of notional. The program keeps funding per USD of
/// size at 1e12.
const idxPct = (n: number) => (n / 1e12) * 100;
const signed = (n: number, d = 4) => (n >= 0 ? "+" : "") + n.toFixed(d) + "%";

/*
 * What funding has done, from the two numbers the server publishes.
 *
 * The market account keeps cumulative indices, not a rate, and the server
 * records no history of them. So the rate here is measured: the index moves
 * each time funding accrues, and two moves seen while this page is open give
 * the rate between them. Until then it says it is waiting rather than showing
 * a number it does not have.
 */
export function FundingView({ m, samples }: { m: Market; samples: FundingSample[] }) {
  const moves = samples.filter((s, i) =>
    i > 0 && (s.long !== samples[i - 1].long || s.short !== samples[i - 1].short));
  const a = moves[moves.length - 2], b = moves[moves.length - 1];
  const hours = a && b ? (b.t - a.t) / 3_600_000 : 0;
  // The server's own rate when it sends one, worked out from the market's
  // parameters and the open interest now; measured from accruals otherwise.
  const measured = (k: "long" | "short") => (hours > 0 ? idxPct(b[k] - a[k]) / hours : null);
  const live = m.fundingRateLongBps != null;
  const long = live ? m.fundingRateLongBps! / 100 : measured("long");
  const short = live ? m.fundingRateShortBps! / 100 : measured("short");
  const total = m.longSize + m.shortSize;

  return (
    <div className="pane-scroll min-h-0 flex-1 px-1">
      <Row k="Longs" hint="paid per $1 since listing">
        <span className={tone(-idxPct(m.fundingLong))}>{signed(idxPct(m.fundingLong))}</span>
      </Row>
      <Row k="Shorts" hint="paid per $1 since listing">
        <span className={tone(-idxPct(m.fundingShort))}>{signed(idxPct(m.fundingShort))}</span>
      </Row>
      <Row k="Open interest" hint="long / short">
        {compact(m.longSize)} / {compact(m.shortSize)}
        {total > 0 && <span className="text-dim"> · {((m.longSize / total) * 100).toFixed(0)}% long</span>}
      </Row>
      <Row k="Rate, longs" hint={live ? "now" : "measured"}>
        {long == null ? <span className="text-dim">Waiting</span>
          : <span className={tone(-long)}>{signed(long)}/h</span>}
      </Row>
      <Row k="Rate, shorts" hint={live ? "now" : "measured"}>
        {short == null ? <span className="text-dim">Waiting</span>
          : <span className={tone(-short)}>{signed(short)}/h</span>}
      </Row>
      <Row k="Last accrual seen">{b ? hhmmss(b.t) : <span className="text-dim">Not yet</span>}</Row>
      <p className="border-t border-line pt-3 text-[12px] leading-relaxed text-muted-foreground">
        Funding accrues on every trade and on each keeper pass. The heavier side
        pays the lighter one, plus a borrow charge on both. History is not
        recorded yet.
      </p>
    </div>
  );
}

const SESSIONS = ["Regular", "Extended", "Closed"];
const bps = (n: number) => `${(n / 100).toFixed(2)}%`;

/// The market's parameters as the program holds them.
export function InfoView({ m }: { m: Market }) {
  const o = m.observed;
  return (
    <div className="pane-scroll min-h-0 flex-1 px-1">
      <Row k="Price source">{o ? "Pool, observed" : "Oracle feed"}</Row>
      {o && <Row k="Pool">{o.source.slice(0, 4)}...{o.source.slice(-4)}</Row>}
      {m.mint && <Row k="Mint">{m.mint.slice(0, 4)}...{m.mint.slice(-4)}</Row>}
      <Row k="Session">{SESSIONS[m.session] ?? m.session}</Row>
      <Row k="Max leverage">{m.maxLeverage.toFixed(m.maxLeverage % 1 ? 1 : 0)}x</Row>
      <Row k="Open fee">{bps(m.openFeeBps)}</Row>
      <Row k="Maintenance margin">{bps(m.maintenanceMarginBps)}</Row>
      <Row k="Open interest" hint="long / short">{compact(m.longSize)} / {compact(m.shortSize)}</Row>
      <Row k="Room under OI cap" hint="long / short">
        {compact(Math.max(0, m.capLong))} / {compact(Math.max(0, m.capShort))}
      </Row>
      <Row k="Free liquidity">{compact(m.freeLiquidity)}</Row>
      <Row k="Backing" hint="of budget">{compact(m.backingUsd)} / {compact(m.lossBudgetUsd)}</Row>
      <Row k="Max price age">{m.maxPriceAgeSec}s</Row>
      {o && <Row k="Seasoning">{o.seasoned ? "Done" : `${o.readings}/${o.readingsNeeded} readings`}</Row>}
    </div>
  );
}
