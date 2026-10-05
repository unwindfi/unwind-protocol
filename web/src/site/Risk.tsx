/*
 * Risk Hub: every parameter the program enforces, per market, and the rules
 * behind them, on one page. The figures are read from the same API the
 * terminal reads, so this page cannot say something the venue does not do.
 * The rules are the docs' own, condensed, each with a link to the page that
 * states it in full.
 */
import "@/site/serif.css";
import { DOCS, Shell, SiteFooter, SiteHeader } from "@/site/Chrome";
import { WalletActions } from "@/components/WalletActions";
import { TickerLogo } from "@/components/TickerLogo";
import { getAccount, getMarkets, useHasBackend, usePoll, type Market } from "@/lib/api";
import { compact } from "@/lib/format";

const NONE: Market[] = [];
const COLS = "grid grid-cols-[minmax(0,1.5fr)_repeat(3,minmax(0,1fr))] items-center gap-3 " +
  "md:grid-cols-[minmax(0,1.5fr)_repeat(7,minmax(0,1fr))]";

const RULES: { title: string; body: string; href: string }[] = [
  { title: "Liquidation", href: `${DOCS}/trading/liquidations`,
    body: "A position whose margin falls under the market's maintenance margin can be closed by any account, at the mark. The fee comes out of what is left of the position, never out of the pool; a position already through zero pays none. Liquidation is permissionless, so a keeper that stops cannot stop it." },
  { title: "Where losses go", href: `${DOCS}/trading/auto-deleveraging`,
    body: "A market's losses are paid in order: the backing posted behind it, then pool liquidity up to the market's loss budget, then the insurance fund. The pool never locks more than its utilisation cap against open positions, and a winner is never paid past its reserve or its market's budget: it is closed at the mark instead." },
  { title: "Budget", href: `${DOCS}/trading/loss-budget`,
    body: "Each market has a loss budget raised only by backing (USDC and USDT in full, SOL at 80%) and capped by the depth of the asset's own pool. Nobody can raise it any other way, the protocol authority included; the authority can only lower it. The pool takes at most 5% of the remaining budget in any one batch." },
  { title: "Leverage", href: `${DOCS}/trading/margining`,
    body: "Maximum leverage is per market and, for a market priced off a pool, follows that pool's sustained depth: 2x under $10k, 3x to $50k, 4x to $250k, 5x above. Depth parked for a moment buys at most one tier until the next reading. The maintenance margin must sit under the initial margin the leverage implies, or the program refuses the configuration." },
  { title: "Prices", href: `${DOCS}/trading/price-sources`,
    body: "A market is priced by a Pyth feed or by a spot pool it observes. Positions are valued and liquidated against that mark, not the last clearing price. Orders pause when the feed is older than the market allows. On devnet the equity prices are Jupiter quotes relayed in Pyth's format." },
  { title: "Fees", href: `${DOCS}/trading/fees`,
    body: "Open and close fees are per market, 10 basis points by default; liquidation is 100. Every fee splits 60% to the pool (half of that to backers on a backed market), 20% protocol, 10% insurance, 10% chain. Referral and listing rewards come out of the protocol's 20% only." },
  { title: "Backing", href: `${DOCS}/markets/how-to-underwrite-a-market`,
    body: "Backers take a market's losses first, up to what they posted, and are made whole from later gains only up to what was drawn. Backing earns half of the pool's share of the market's fees. Withdrawing pays the mix the pot holds. If backing is drawn to zero while backers hold shares, the market refuses new backing until a gain restores some." },
  { title: "Clearing", href: `${DOCS}/trading/auction`,
    body: "Orders rest for a batch and clear together at one price per side. Takers meet makers first; the pool fills only what makers leave, at its quote, and only within the market's budget. Nothing is filled continuously, so there is no spread paid to the house and nothing to front-run." },
];

export default function RiskPage() {
  const markets = usePoll(getMarkets, 5000) ?? NONE;
  const account = usePoll(() => getAccount(undefined), 10_000, []);
  const devnet = useHasBackend() === true;
  const pool = account?.pool;
  const bps = (n: number) => `${(n / 100).toFixed(2)}%`;
  return (
    <div className="site min-h-full">
      <SiteHeader actions={<WalletActions />} />
      <Shell main className="pb-14 pt-4 sm:pt-8">
        <div className="max-w-[62ch]">
          <h1 className="font-serif-display text-[clamp(2.6rem,6vw,4rem)] leading-none tracking-[-.025em]">Risk Hub</h1>
          <p className="mt-4 text-[15px] leading-[1.55] text-muted-foreground">
            Every number the program holds a market to, read live, and the rules behind them. If something
            here and the docs disagree, the chain is right and both are wrong.
            {devnet && " This is devnet: test USDC, unaudited, and parameters can change."}
          </p>
        </div>

        {pool && (
          <div className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Tile k="Pool liquidity" v={compact(pool.liquidity)} sub={`${compact(pool.free)} free`} />
            <Tile k="Utilisation" v={`${pool.utilization.toFixed(1)}%`} sub={`Cap ${pool.maxUtilization}%`} />
            <Tile k="Insurance fund" v={compact(pool.insurance)} sub="Pays after the pool" />
            <Tile k="Markets" v={String(markets.length)} sub={`${markets.filter((m) => m.observed).length} opened by anyone`} />
          </div>
        )}

        <section className="mt-8 overflow-hidden rounded-[24px] border border-line bg-panel">
          <div className="px-5 pb-4 pt-6 sm:px-7">
            <h2 className="text-[16px] font-medium">Per market</h2>
            <p className="mt-1 text-[12.5px] text-muted-foreground">As the program holds them now.</p>
          </div>
          <div className={`${COLS} whitespace-nowrap border-t border-line px-5 py-2.5 text-[12.5px] text-muted-foreground sm:px-7`}>
            <span>Market</span><span>Leverage</span><span>Maintenance</span><span>Fee</span>
            <span className="hidden md:block">Backing</span><span className="hidden md:block">Budget</span>
            <span className="hidden md:block">OI</span><span className="hidden md:block">Source</span>
          </div>
          {markets.length === 0 && <p className="border-t border-line px-5 py-10 text-[13px] text-muted-foreground sm:px-7">Reading the chain.</p>}
          {markets.map((m) => (
            <a key={m.symbol} href={`/trade?symbol=${m.symbol}`}
              className={`${COLS} n border-t border-line px-5 py-3 text-[13.5px] transition-colors hover:bg-panel2 sm:px-7`}>
              <span className="flex min-w-0 items-center gap-2.5">
                <TickerLogo m={m} size={22} />
                <span className="truncate font-medium">{m.symbol}</span>
              </span>
              <span>{m.maxLeverage.toFixed(m.maxLeverage % 1 ? 1 : 0)}x</span>
              <span className="text-down">{bps(m.maintenanceMarginBps)}</span>
              <span>{bps(m.openFeeBps)}</span>
              <span className="hidden md:block">{compact(m.backingUsd)}</span>
              <span className="hidden md:block">{compact(m.lossBudgetUsd)}</span>
              <span className="hidden md:block">{compact(m.oi)}</span>
              <span className="hidden text-muted-foreground md:block">{m.observed ? "Pool" : "Pyth"}</span>
            </a>
          ))}
        </section>

        <h2 className="mt-10 text-[16px] font-medium">The rules</h2>
        <ol className="mt-3 grid gap-3 md:grid-cols-2">
          {RULES.map((r, i) => (
            <li key={r.title} className="rounded-[20px] border border-line bg-panel px-6 py-5">
              <div className="flex items-baseline gap-3">
                <span className="n text-[12px] text-muted-foreground">{String(i + 1).padStart(2, "0")}</span>
                <h3 className="text-[16px] font-medium">{r.title}</h3>
              </div>
              <p className="mt-2 text-[13.5px] leading-[1.6] text-muted-foreground">{r.body}</p>
              <a href={r.href} target="_blank" rel="noreferrer"
                className="mt-3 inline-block text-[13px] underline decoration-line underline-offset-4 hover:text-foreground">
                In full
              </a>
            </li>
          ))}
        </ol>
      </Shell>
      <SiteFooter />
    </div>
  );
}

function Tile({ k, v, sub }: { k: string; v: string; sub: string }) {
  return (
    <div className="rounded-[20px] border border-line bg-panel px-6 py-5">
      <div className="text-[13px] text-muted-foreground">{k}</div>
      <div className="n mt-2.5 text-[28px] font-semibold leading-none tracking-[-.02em]">{v}</div>
      <div className="n mt-2 text-[12.5px] text-muted-foreground">{sub}</div>
    </div>
  );
}
