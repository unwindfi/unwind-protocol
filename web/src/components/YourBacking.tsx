import { PayToken } from "@/components/PayToken";
import { AnimatedNumber } from "@/components/motion/animated-number";
import { TickerLogo } from "@/components/TickerLogo";
import type { Backing, Market } from "@/lib/api";
import { compact, money } from "@/lib/format";
import type { PayWith } from "@/lib/listing";

/*
 * What you have put behind each market, and what it has done since.
 *
 * The vault table answers "where could my money go"; this answers "where is
 * it". Three numbers a backer actually wants per market: what they posted,
 * what it is worth now, and the difference, which is fee income less whatever
 * the market's traders took out of it (and, for SOL, the price of SOL). Then
 * the mix it is held in, because that is what comes back on withdrawal.
 */

const TOKENS: PayWith[] = ["SOL", "USDC", "USDT"];

/// "0.5 SOL", "25 USDT": whole units, trimmed to what is worth reading.
const amount = (sym: string, n: number) =>
  sym === "SOL" ? n.toLocaleString(undefined, { maximumFractionDigits: 4 })
    : n.toLocaleString(undefined, { maximumFractionDigits: 2 });

function status(b: Backing) {
  if (b.opening) return { text: "Opening auction", tone: "text-brand" };
  if (b.tradeable) return { text: `Live · ${compact(b.budgetUsd)} budget`, tone: "text-up" };
  return { text: "Not live", tone: "text-dim" };
}

export function YourBacking({ backings, markets, onWithdraw, onAdd }: {
  backings: Backing[];
  markets: Market[];
  onWithdraw: (symbol: string) => void;
  onAdd: (symbol: string) => void;
}) {
  if (backings.length === 0) return null;
  const posted = backings.reduce((a, b) => a + b.deposited, 0);
  const worth = backings.reduce((a, b) => a + b.value, 0);
  const change = worth - posted;

  return (
    <section className="mt-5 overflow-hidden rounded-[24px] border border-line bg-panel">
      <div className="flex flex-wrap items-end justify-between gap-4 px-5 pb-5 pt-7 sm:px-9">
        <h2 className="text-[clamp(1.375rem,2.2vw,1.625rem)] font-medium tracking-[-.02em]">
          Your backing
          <span className="n ml-2 text-[14px] font-normal text-dim">{backings.length}</span>
        </h2>
        <div className="flex gap-6 text-right">
          <div>
            <div className="n text-[16px] font-semibold">
              <AnimatedNumber value={worth} duration={0.9} format={(n) => money(n)} />
            </div>
            <div className="text-[12.5px] text-muted-foreground">Worth now</div>
          </div>
          <div>
            <div className={`n text-[16px] font-semibold ${change >= 0 ? "text-up" : "text-down"}`}>
              <AnimatedNumber value={change} duration={0.9}
                format={(n) => `${n >= 0 ? "+" : "-"}${money(Math.abs(n))}`} />
            </div>
            <div className="text-[12.5px] text-muted-foreground">Since posted</div>
          </div>
        </div>
      </div>

      <div>
        {backings.map((b) => {
          const m = markets.find((x) => x.symbol === b.symbol);
          const s = status(b);
          const diff = b.value - b.deposited;
          const mix = TOKENS.filter((k) => (b.held[k] ?? 0) > 0);
          return (
            <div key={b.symbol}
              className="grid grid-cols-1 gap-3 border-t border-line px-5 py-4 sm:px-9
                         md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.6fr)_auto]
                         md:items-center md:gap-4">
              <div className="flex min-w-0 items-center gap-3">
                {m && <TickerLogo m={m} size={32} />}
                <div className="min-w-0">
                  <a href={`/trade?symbol=${b.symbol}`}
                    className="block truncate text-[14px] font-medium underline-offset-2 hover:underline">
                    {m?.name ?? b.symbol}
                  </a>
                  <div className={`truncate text-[12.5px] ${s.tone}`}>{s.text}</div>
                </div>
              </div>

              <div className="flex justify-between md:block">
                <span className="text-[12.5px] text-muted-foreground md:hidden">Posted</span>
                <span className="n text-[14px]">{money(b.deposited)}</span>
              </div>

              <div className="flex justify-between md:block">
                <span className="text-[12.5px] text-muted-foreground md:hidden">Worth now</span>
                <span className="text-right md:text-left">
                  <span className="n block text-[14px] font-semibold">{money(b.value)}</span>
                  <span className={`n block text-[12px] ${diff >= 0 ? "text-up" : "text-down"}`}>
                    {diff >= 0 ? "+" : "-"}{money(Math.abs(diff))}
                  </span>
                </span>
              </div>

              {/* The mix it is held in, which is the mix it comes back in. */}
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px]">
                <span className="text-muted-foreground md:hidden">Held as</span>
                {mix.length === 0
                  ? <span className="text-dim">nothing left</span>
                  : mix.map((k) => (
                    <span key={k} className="n inline-flex items-center gap-1">
                      {amount(k, b.held[k])} <PayToken k={k} size={14} />
                    </span>
                  ))}
              </div>

              <div className="flex gap-2 md:justify-end">
                <button type="button" onClick={() => onAdd(b.symbol)}
                  className="press h-9 flex-1 rounded-full bg-foreground px-4 text-[13px] font-medium
                             text-background transition-opacity hover:opacity-90 md:flex-none">
                  Add
                </button>
                <button type="button" onClick={() => onWithdraw(b.symbol)}
                  className="press h-9 flex-1 rounded-full border border-line px-4 text-[13px]
                             font-medium transition-colors hover:border-foreground/40 md:flex-none">
                  Withdraw
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
