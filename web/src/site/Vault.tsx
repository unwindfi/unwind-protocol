/*
 * One vault: the pool, or the backing behind one market.
 *
 * What it holds and earns, how its value per share has moved, what the
 * market it stands behind can do to it, and the way in and out. Reached
 * from a row on /earn; `?id=` names the vault, `pool` or a market symbol.
 */
import { useMemo, useState } from "react";
import "@/site/serif.css";
import { AnimatePresence } from "motion/react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { RISKS, Shell, SiteFooter, SiteHeader } from "@/site/Chrome";
import { WalletActions } from "@/components/WalletActions";
import { AnimatedNumber } from "@/components/motion/animated-number";
import * as api from "@/lib/api";
import {
  getAccount, getApy, getApySeries, getBackings, getMarkets, useHasBackend, usePoll,
  type Backing, type Market,
} from "@/lib/api";
import { Tile, VaultDialog, VaultIcon, vaultsOf } from "@/site/Earn";
import { compact, money } from "@/lib/format";

const NONE: Market[] = [];
const NO_BACKINGS: Backing[] = [];
const DASH = <span className="font-normal text-dim">–</span>;
const BTN = "press inline-flex h-11 items-center justify-center rounded-full px-6 text-[14px] font-medium " +
  "transition-opacity disabled:pointer-events-none disabled:opacity-35";

export default function VaultPage() {
  const id = new URLSearchParams(location.search).get("id") ?? "pool";
  const wallet = useWallet();
  const { setVisible } = useWalletModal();
  const owner = wallet.publicKey?.toBase58();
  const [tick, setTick] = useState(0);
  const account = usePoll(() => getAccount(owner), 3000, [owner], undefined, tick);
  const markets = usePoll(getMarkets, 5000) ?? NONE;
  const backings = usePoll(() => getBackings(owner), 5000, [owner], undefined, tick) ?? NO_BACKINGS;
  const apy = usePoll(getApy, 30_000);
  const series = usePoll(getApySeries, 60_000);
  const devnet = useHasBackend() === true;
  const [open, setOpen] = useState<"in" | "out" | null>(null);

  const vaults = useMemo(() => vaultsOf(account, markets, backings, apy, !!owner),
    [account, markets, backings, apy, owner]);
  const v = vaults.find((x) => x.id === id);
  const m = v?.market;
  const points = (id === "pool" ? series?.pool : series?.markets[id]) ?? [];
  const backing = backings.find((b) => b.symbol === id);

  return (
    <div className="site min-h-full">
      <SiteHeader here="/earn" actions={<WalletActions />} />
      <Shell main className="pb-14 pt-4 sm:pt-8">
        <p className="text-[13px] text-muted-foreground">
          <a href="/earn" className="hover:text-foreground">Earn</a>
          <span className="mx-2 text-dim">›</span>
          <span className="text-foreground">{v?.title ?? id}</span>
        </p>

        {!v ? (
          <div className="mt-6 rounded-[24px] border border-line bg-panel px-6 py-12 text-center text-[14px] text-muted-foreground">
            {markets.length === 0 ? "Reading the chain." : <>No vault called <span className="font-mono">{id}</span>. <a href="/earn" className="underline underline-offset-4">Back to Earn</a></>}
          </div>
        ) : (
          <div className="mt-5 grid gap-5 lg:grid-cols-[minmax(0,1fr)_380px]">
            <div className="min-w-0">
              <div className="flex items-center gap-4">
                <VaultIcon v={v} />
                <div className="min-w-0">
                  <h1 className="text-balance font-serif-display text-[clamp(2.2rem,4.5vw,3rem)] leading-none tracking-[-.025em]">
                    {v.title}
                  </h1>
                  <p className="mt-1.5 text-[14px] text-muted-foreground">
                    {v.kind === "pool"
                      ? "Every market's liquidity. Takes what backers leave, after them."
                      : `First-loss backing behind ${m?.name ?? v.id}. ${v.subtitle}.`}
                  </p>
                </div>
              </div>

              <div className="mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <Tile k="TVL" v={<AnimatedNumber value={v.tvl} duration={0.9} format={compact} />} sub={v.tvlNote} />
                <Tile k="APY" tone={v.apy.tone}
                  v={v.apy.value != null ? `${v.apy.value.toFixed(2)}%` : v.apy.text} sub={v.apy.note} />
                <Tile k="Utilisation" v={v.util.pct != null ? `${v.util.pct.toFixed(1)}%` : "–"} sub={v.util.note} />
                <Tile k="Yours" v={v.yours > 0 ? money(v.yours) : DASH}
                  sub={backing ? `${money(backing.deposited)} posted` : v.kind === "pool" && account ? `${compact(account.lp.value)} in xLP` : owner ? "Nothing here yet" : "Not connected"} />
              </div>

              <section className="mt-5 overflow-hidden rounded-[24px] border border-line bg-panel">
                <div className="flex flex-wrap items-baseline justify-between gap-3 px-6 pb-2 pt-5 sm:px-8">
                  <div>
                    <h2 className="text-balance text-[16px] font-medium">Value per share</h2>
                    <p className="mt-0.5 text-[12.5px] text-muted-foreground">
                      What one share of this vault is worth, as the server has watched it. Fees lift it; losses the
                      market's traders took from it lower it.
                    </p>
                  </div>
                  {points.length > 1 && (
                    <span className="n text-[12.5px] text-muted-foreground">
                      {new Date(points[0][0]).toLocaleDateString(undefined, { month: "short", day: "numeric" })} to today
                    </span>
                  )}
                </div>
                <div className="px-6 pb-6 sm:px-8"><Chart points={points} /></div>
              </section>

              {m && <Risk m={m} />}
              {v.kind === "pool" && account && (
                <section className="mt-5 overflow-hidden rounded-[24px] border border-line bg-panel px-6 py-5 sm:px-8">
                  <h2 className="text-balance text-[16px] font-medium">Where the pool stands</h2>
                  <div className="mt-3 grid gap-x-8 sm:grid-cols-2">
                    <KV k="Liquidity">{money(account.pool.liquidity, 0)}</KV>
                    <KV k="Insurance fund">{money(account.pool.insurance, 0)}</KV>
                    <KV k="Traders' PnL against it">{money(account.pool.traderPnl, 0)}</KV>
                    <KV k="Exit fee">{account.pool.removeFeePct}%</KV>
                  </div>
                </section>
              )}
            </div>

            <aside className="lg:sticky lg:top-6 lg:self-start">
              <div className="overflow-hidden rounded-[24px] border border-line bg-panel px-6 py-6">
                <div className="text-[13px] text-muted-foreground">Your position</div>
                <div className="n mt-2 text-[34px] font-semibold leading-none tracking-[-.02em]">
                  {v.yours > 0 ? money(v.yours) : DASH}
                </div>
                <div className="mt-4">
                  {backing && <KV k="Posted">{money(backing.deposited)}</KV>}
                  {backing && <KV k="Since posted" tone={backing.value - backing.deposited >= 0 ? "text-up" : "text-down"}>
                    {money(backing.value - backing.deposited)}</KV>}
                  {backing && Object.entries(backing.held).map(([sym, amt]) => (
                    <KV key={sym} k={`Held as ${sym}`}>{amt.toLocaleString(undefined, { maximumFractionDigits: 4 })}</KV>
                  ))}
                  {v.kind === "pool" && account && <KV k="xLP">{account.lp.value > 0 ? money(account.lp.value) : DASH}</KV>}
                  <KV k="Strategy">{v.strategy}</KV>
                </div>
                <div className="mt-6 flex flex-col gap-2">
                  {!owner ? (
                    <button type="button" onClick={() => setVisible(true)} disabled={api.readOnly}
                      className={`${BTN} bg-foreground text-background hover:opacity-85`}>Connect wallet</button>
                  ) : (
                    <>
                      <button type="button" onClick={() => setOpen("in")} disabled={!devnet}
                        className={`${BTN} bg-foreground text-background hover:opacity-85`}>Deposit</button>
                      <button type="button" onClick={() => setOpen("out")} disabled={!devnet || v.yours <= 0}
                        className={`${BTN} border border-line hover:border-foreground/40`}>Withdraw</button>
                    </>
                  )}
                </div>
                <p className="text-pretty mt-4 text-[12.5px] leading-[1.55] text-muted-foreground">
                  {v.kind === "pool"
                    ? "The pool takes the losses backers do not, up to each market's budget, and earns the fees on every market."
                    : "Backing takes this market's losses first, up to what you post, and earns half of the pool's share of its fees. Withdrawing pays the mix it holds."}{" "}
                  <a href={RISKS} target="_blank" rel="noreferrer" className="underline decoration-line underline-offset-4 hover:text-foreground">Risks</a>
                </p>
              </div>
            </aside>
          </div>
        )}
      </Shell>

      <AnimatePresence>
        {v && open && (
          <VaultDialog key={`${v.id}-${open}`} v={v} account={account} start={open}
            onClose={() => setOpen(null)} onDone={() => setTick((t) => t + 1)} />
        )}
      </AnimatePresence>
      <SiteFooter />
    </div>
  );
}

const KV = ({ k, children, tone = "" }: { k: string; children: React.ReactNode; tone?: string }) => (
  <div className="flex items-baseline justify-between gap-4 border-t border-line py-2.5 first:border-t-0">
    <span className="text-[13px] text-muted-foreground">{k}</span>
    <span className={`n text-right text-[13.5px] font-semibold ${tone}`}>{children}</span>
  </div>
);

/// What the market can do to this vault: its leverage, the margin it
/// liquidates at, and the budget the backing is measured against.
function Risk({ m }: { m: Market }) {
  const L = m.maxLeverage;
  const mm = m.maintenanceMarginBps / 100;
  const filled = m.lossBudgetUsd > 0 ? Math.min(100, (m.backingUsd / m.lossBudgetUsd) * 100) : 0;
  return (
    <section className="mt-5 overflow-hidden rounded-[24px] border border-line bg-panel px-6 py-5 sm:px-8">
      <h2 className="text-balance text-[16px] font-medium">What this vault stands behind</h2>
      <p className="text-pretty mt-1.5 text-[13.5px] leading-[1.55] text-muted-foreground">
        Traders open {m.symbol} at up to {L.toFixed(L % 1 ? 1 : 0)}x and are liquidated under {mm.toFixed(1)}% margin.
        Their losses come out of this backing first, up to its budget of {compact(m.lossBudgetUsd)}, then the pool.
        Gains come back to it only up to what was drawn.
      </p>
      <div className="mt-4 grid gap-x-8 sm:grid-cols-2">
        <KV k="Budget backed">{filled.toFixed(1)}%</KV>
        <KV k="Open interest">{compact(m.oi)}</KV>
        <KV k="Price source">{m.observed ? "Pool, observed" : "Pyth feed"}</KV>
        <KV k="Open fee">{(m.openFeeBps / 100).toFixed(2)}%</KV>
      </div>
      <div className="mt-4 flex h-9 gap-1 text-[11.5px] font-medium">
        <span className="flex flex-[2] items-center rounded-[7px] bg-up/10 px-3 text-up">Backing pays first</span>
        <span className="flex flex-[1.6] items-center rounded-[7px] bg-[#f5b8201f] px-3 text-[#d9a21b]">Then the pool, to budget</span>
        <span className="flex flex-[1.2] items-center rounded-[7px] bg-down/10 px-3 text-down">Then insurance</span>
      </div>
    </section>
  );
}

/// One line, drawn to fit, with the level it started from as a baseline.
function Chart({ points }: { points: [number, number][] }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 1000, H = 220, PAD = 12;
  const geo = useMemo(() => {
    if (points.length < 2) return null;
    const t0 = points[0][0], t1 = points[points.length - 1][0];
    let lo = Math.min(...points.map((p) => p[1])), hi = Math.max(...points.map((p) => p[1]));
    if (hi === lo) { hi += Math.abs(hi) * 0.001 || 1; lo -= Math.abs(lo) * 0.001 || 1; }
    const pad = (hi - lo) * 0.12; lo -= pad; hi += pad;
    const x = (t: number) => ((t - t0) / (t1 - t0 || 1)) * W;
    const y = (v: number) => PAD + (1 - (v - lo) / (hi - lo)) * (H - PAD * 2);
    const d = points.map((p, i) => `${i ? "L" : "M"}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join("");
    return { x, y, d, area: `${d}L${x(t1).toFixed(1)},${H}L${x(t0).toFixed(1)},${H}Z`, t0, t1, lo, hi };
  }, [points]);
  if (!geo) {
    return <div className="grid h-[220px] place-items-center text-[13px] text-muted-foreground">Nothing recorded yet. The server writes a point every two minutes.</div>;
  }
  const first = points[0][1], last = points[points.length - 1][1];
  const up = last >= first;
  const at = hover == null ? null : points[hover];
  const fmt = (v: number) => v.toFixed(4);
  return (
    <div className="relative">
      <div className="n mb-2 flex items-baseline gap-3">
        <span className="text-[24px] font-semibold tracking-[-.02em]">{fmt(at ? at[1] : last)}</span>
        <span className={`text-[13px] ${up ? "text-up" : "text-down"}`}>
          {((last / first - 1) * 100).toFixed(2)}% over the window
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="block h-[220px] w-full"
        onMouseMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const t = geo.t0 + ((e.clientX - r.left) / r.width) * (geo.t1 - geo.t0);
          let i = 0; while (i < points.length - 1 && points[i + 1][0] <= t) i++;
          setHover(i);
        }}
        onMouseLeave={() => setHover(null)}>
        <defs>
          <linearGradient id="vault-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="currentColor" stopOpacity=".18" />
            <stop offset="1" stopColor="currentColor" stopOpacity="0" />
          </linearGradient>
        </defs>
        <line x1="0" x2={W} y1={geo.y(first)} y2={geo.y(first)} className="stroke-dim" strokeWidth="1"
          strokeDasharray="3 4" vectorEffect="non-scaling-stroke" opacity=".7" />
        <g className={up ? "text-up" : "text-down"}>
          <path d={geo.area} fill="url(#vault-fill)" />
          <path d={geo.d} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
        </g>
        {at && <line x1={geo.x(at[0])} x2={geo.x(at[0])} y1="0" y2={H} className="stroke-foreground" strokeWidth="1" vectorEffect="non-scaling-stroke" opacity=".5" />}
      </svg>
      {at && (
        <div className="n mt-1 text-[12px] text-muted-foreground">
          {new Date(at[0]).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
        </div>
      )}
    </div>
  );
}
