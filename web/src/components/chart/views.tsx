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

/// The market's parameters as the program holds them: a grid of facts, then
/// the band a position lives in and what $100 of margin does here.
export function InfoView({ m }: { m: Market }) {
  const o = m.observed;
  return (
    <div className="pane-scroll min-h-0 flex-1">
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-[10px] border border-line bg-line sm:grid-cols-3">
        <Fact k="Price source" sub={o ? `${o.source.slice(0, 4)}…${o.source.slice(-4)}` : "Pyth feed"}>
          {o ? "Pool, observed" : "Oracle"}
        </Fact>
        <Fact k="Max leverage" sub={`Open at up to ${m.maxLeverage.toFixed(m.maxLeverage % 1 ? 1 : 0)}x`}>
          {m.maxLeverage.toFixed(m.maxLeverage % 1 ? 1 : 0)}x
        </Fact>
        <Fact k="Maintenance margin" sub="Liquidated under this" tone="text-down">{bps(m.maintenanceMarginBps)}</Fact>
        <Fact k="Open fee" sub="Same to close">{bps(m.openFeeBps)}</Fact>
        <Fact k="Open interest" sub={`${compact(m.longSize)} long · ${compact(m.shortSize)} short`}>{compact(m.oi)}</Fact>
        <Fact k="Free liquidity" sub={`Room ${compact(Math.max(0, m.capLong))} / ${compact(Math.max(0, m.capShort))}`}>
          {compact(m.freeLiquidity)}
        </Fact>
        <Fact k="Backing" sub={`of ${compact(m.lossBudgetUsd)} budget`}>{compact(m.backingUsd)}</Fact>
        <Fact k="Session" sub={`Feed at most ${m.maxPriceAgeSec}s old`}>{SESSIONS[m.session] ?? m.session}</Fact>
        {o
          ? <Fact k="Seasoning" sub={o.seasoned ? "Priced by the keeper" : "Opening auction"}>
              {o.seasoned ? "Done" : `${o.readings}/${o.readingsNeeded}`}
            </Fact>
          : m.mint
            ? <Fact k="Mint" sub="On Solscan">{m.mint.slice(0, 4)}…{m.mint.slice(-4)}</Fact>
            : <Fact k="Market" sub="Pyth priced">{m.symbol}</Fact>}
      </div>
      <Band m={m} />
    </div>
  );
}

/*
 * Where a position stands, as a bar: open while its margin is above the
 * initial requirement, held but not grown between that and the maintenance
 * margin, liquidatable under it. The figures are the market's own, so the
 * sentence under it is arithmetic rather than a disclaimer.
 */
function Band({ m }: { m: Market }) {
  const L = m.maxLeverage;
  const initial = 100 / L;
  const mm = m.maintenanceMarginBps / 100;
  const move = Math.max(0, initial - mm);
  const lev = L.toFixed(L % 1 ? 1 : 0);
  return (
    <div className="mt-3 rounded-[10px] border border-line px-4 py-4">
      <div className="text-[14px] font-medium">What $100 of margin does here</div>
      <p className="mt-1.5 text-[12.5px] leading-[1.55] text-muted-foreground">
        Opens up to {compact(100 * L)} of {m.symbol} at {lev}x. Above {initial.toFixed(1)}% margin you can add
        to it; between {initial.toFixed(1)}% and {mm.toFixed(1)}% you can hold or reduce but not add; under{" "}
        {mm.toFixed(1)}% it can be liquidated, which at {lev}x is a move of about {move.toFixed(1)}% against you.
        The liquidation fee comes out of what is left, never out of the pool.
      </p>
      <div className="mt-3 flex h-9 gap-1 text-[11.5px] font-medium">
        <span className="flex flex-[3] items-center rounded-[7px] bg-up/15 px-3 text-up">Above {initial.toFixed(1)}% · open</span>
        <span className="flex flex-[1.2] items-center rounded-[7px] bg-[#f5b8201f] px-3 text-[#d9a21b]">Hold only</span>
        <span className="flex flex-[1.6] items-center rounded-[7px] bg-down/15 px-3 text-down">Under {mm.toFixed(1)}% · liquidatable</span>
      </div>
    </div>
  );
}

function Fact({ k, sub, tone = "", children }: { k: string; sub?: string; tone?: string; children: ReactNode }) {
  return (
    <div className="bg-panel px-4 py-3">
      <div className="text-[11.5px] text-muted-foreground">{k}</div>
      <div className={`n mt-1 text-[16px] font-semibold leading-none ${tone}`}>{children}</div>
      {sub && <div className="n mt-1.5 truncate text-[11px] text-dim">{sub}</div>}
    </div>
  );
}
