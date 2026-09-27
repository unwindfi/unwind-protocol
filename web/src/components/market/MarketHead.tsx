/*
 * The top of the market page: what this is, what it costs, and the four
 * figures that say whether it is worth trading.
 *
 * The terminal's header packed all of this into one 40px strip because the
 * chart under it needed every pixel. On a page that scrolls the same facts
 * get room to be read rather than scanned, which is the whole point of the
 * change: the strip was for someone already in a position, this is for
 * someone deciding.
 */
import { ChevronDown } from "lucide-react";
import { BatchClock, useNow, usePriceTitle } from "@/components/BatchClock";
import { DigitSwap } from "@/components/motion/digit-swap";
import { Tooltip } from "@/components/motion/tooltip";
import { Tabs, TabsList, TabsTrigger } from "@/components/Tabs";
import { TickerLogo } from "@/components/TickerLogo";
import type { Batch, Market } from "@/lib/api";
import { clock, compact, pct, price, tone } from "@/lib/format";

/// The rate longs pay now, in percent an hour: positive means longs are
/// paying. It used to be the difference of the cumulative indices, which is
/// everything paid since listing, not a rate. Zero where the server has no
/// program to read the rate from.
export const fundingPct = (m: Market) => (m.fundingRateLongBps ?? 0) / 100;

/// Time to the top of the next hour. Funding accrues continuously on chain;
/// the rate is quoted per hour, so the hour is the period a trader holds it
/// against and the countdown says how much of this one is left.
export const toNextHour = (now: number) => 3_600_000 - (now % 3_600_000);

/*
 * The address as a chip: a quiet filled rounded box, no border, no buttons.
 *
 * The component this used to use ships a bordered pill with a copy and an
 * explorer button in it, which made the most technical string on the page
 * also the loudest object in the header. The whole chip is the link instead
 * -- one target, no icons -- and the full address is on the title for anyone
 * who wants to read or copy it.
 */
function Chip({ label, address, href }: {
  label: string; address: string; href: string;
}) {
  return (
    <a href={href} target="_blank" rel="noreferrer" title={address}
      className="flex flex-none items-center gap-2 rounded-full border border-line bg-panel
                 px-3.5 py-2 text-[12.5px] text-muted-foreground transition-colors
                 hover:text-foreground">
      <span className="text-dim">{label}</span>
      <span className="font-mono">{short(address)}</span>
    </a>
  );
}

const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;

export function MarketHead({ m, onOpen, batch }: {
  m: Market; onOpen: () => void;
  /// The batch, when the page already polls it; fetched here otherwise.
  batch?: Batch | null;
}) {
  usePriceTitle(m);
  const stale = m.priceAgeMs != null && m.priceAgeMs / 1000 > m.maxPriceAgeSec;
  return (
    <div>
      {/* The mark sits beside the name, where a title's icon goes. On a line
          of its own it cost the page a row and read as a stray image. */}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        {/* The whole title is the switcher. A market page whose only way to
            another market is a keyboard shortcut is a dead end for anyone who
            arrived from a link. */}
        <button onClick={onOpen}
          className="press group flex min-w-0 items-center gap-3 text-left">
          <TickerLogo m={m} size={40} />
          <span className="flex min-w-0 items-baseline gap-2.5">
          <span className="truncate text-[30px] font-semibold leading-none
                           tracking-[-.025em]">
            {m.name}
          </span>
          {/* Beside the name, not under it: the ticker is how this market is
              written everywhere else, so it reads as part of the title. */}
          <span className="flex-none text-[21px] font-medium leading-none
                           text-muted-foreground">
            {m.symbol}
          </span>
          </span>
          <ChevronDown size={17}
            className="flex-none self-center text-dim transition-colors
                       group-hover:text-foreground" />
        </button>

        <div className="flex flex-wrap items-center gap-2">
          {/* The window first, before the addresses: it is the one thing in
              this row that changes what an order placed now will do. */}
          <div className="mr-2">
            <BatchClock m={m} batch={batch} />
          </div>
          {stale && (
            <span className="rounded-full bg-down/15 px-3 py-1.5 text-[12px]
                             font-medium text-down">
              Feed {Math.round(m.priceAgeMs! / 1000)}s old
            </span>
          )}
          {/*
           * The mint, not a name for it. A ticker is something this venue
           * chose and two markets could share; the mint is the token, and it
           * is the one string that settles which "NVDAx" this is.
           */}
          {m.mint && (
            <Chip label="Mint" address={m.mint}
              href={`https://solscan.io/token/${m.mint}`} />
          )}
          {/* A market somebody opened has no mint here -- it is identified by
              the pool it watches, and the whole claim of a permissionless
              listing is that you can go and check that pool. */}
          {m.observed && (
            <Chip label="Pool" address={m.observed.source}
              href={`https://solscan.io/account/${m.observed.source}`} />
          )}
        </div>
      </div>
    </div>
  );
}

/// Caption over value, the explanation behind a tooltip rather than printed
/// into the row: a trading screen should not be reading you a manual.
function Stat({ label, help, children }: {
  label: string; help: string; children: React.ReactNode;
}) {
  return (
    <div className="flex-none">
      <Tooltip content={help} side="bottom">
        <span className="cursor-default border-b border-dotted border-line pb-px
                         text-[12px] text-muted-foreground">{label}</span>
      </Tooltip>
      <div className="n mt-1.5 whitespace-nowrap text-[14px] font-medium">{children}</div>
    </div>
  );
}

/// The funding cell, split out so its once-a-second tick redraws one figure
/// rather than the whole row.
function Funding({ m }: { m: Market }) {
  const now = useNow(1000);
  const f = fundingPct(m);
  return (
    <Stat label="1h funding" help="Per hour. Positive: longs pay shorts. Both pay the pool to borrow.">
      {/* Signed, because which side is paying is the entire content of a
          funding rate: an unsigned "0.004%" is a number you cannot act on. */}
      <span className={tone(-f)}>{(f >= 0 ? "+" : "") + f.toFixed(4)}%</span>
      <span className="ml-2 text-muted-foreground">{clock(toNextHour(now))}</span>
    </Stat>
  );
}

/*
 * The figures in one row, in the order someone sizing a trade asks for them.
 *
 * This was four tiles, each a card with a 20px figure in it, which gave the
 * header a second band as tall as the first to say four numbers. One row of
 * caption-over-figure says six in half the height, and scrolls sideways on a
 * screen too narrow for it rather than wrapping into a grid.
 */
export function StatTiles({ m, dense = false }: {
  m: Market;
  /// Tighter spacing, for the terminal's header row, which shares its width
  /// with the market's name and the batch clock.
  dense?: boolean;
}) {
  const mark = (m.bid + m.ask) / 2;
  return (
    <div className={`strip-scroll flex items-start gap-y-4 overflow-x-auto ${dense ? "gap-x-6" : "gap-x-8"}`}>
      <Stat label="Mark" help="Pool mid this batch. Fills clear at the batch price.">
        <DigitSwap value={price(mark)} animationKey={mark}
          direction={m.change >= 0 ? "up" : "down"} />
      </Stat>
      <Stat label="Reference" help="Oracle price. Breaks ties, never prices fills.">
        {price(m.price)}
      </Stat>
      <Stat label="24h change" help="Since the session opened.">
        <span className={tone(m.changePct)}>
          {m.change >= 0 ? "+" : ""}{m.change.toFixed(2)} / {pct(m.changePct)}
        </span>
      </Stat>
      <Stat label="24h volume" help="Notional traded.">{compact(m.volume24h)}</Stat>
      <Stat label="Open interest" help="Notional open, both sides.">{compact(m.oi)}</Stat>
      <Funding m={m} />
    </div>
  );
}

/// The price, and the timeframes the chart under it is drawn at.
export function PriceRow({ m, tf, onTf, frames }: {
  m: Market; tf: number; onTf: (v: number) => void;
  frames: { v: number; l: string }[];
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4 px-6 pb-5 pt-7 sm:px-9">
      <div>
        <div className="text-[13px] text-muted-foreground">Price</div>
        <div className="mt-2.5 flex items-center gap-3">
          <DigitSwap value={price(m.price)} animationKey={m.price}
            direction={m.change >= 0 ? "up" : "down"}
            className="n text-[34px] font-medium leading-none tracking-[-.03em]" />
          {/* The move and its window in one soft chip, tinted by direction:
              one object to read rather than two figures side by side. */}
          <span className={`n rounded-[8px] px-2 py-1 text-[12.5px] ${tone(m.changePct)}
                            ${m.changePct >= 0 ? "bg-up/10" : "bg-down/10"}`}>
            {pct(m.changePct)} <span className="opacity-70">24h</span>
          </span>
        </div>
      </div>
      <Tabs value={String(tf)} onValueChange={(v) => onTf(Number(v))}>
        <TabsList soft>
          {frames.map((t) => (
            <TabsTrigger soft key={t.v} value={String(t.v)}>{t.l}</TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
    </div>
  );
}
