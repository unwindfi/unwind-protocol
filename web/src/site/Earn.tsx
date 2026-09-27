/*
 * Earn.
 *
 * The page a depositor opens: what they hold at the top, beside the way in,
 * and every vault in a table underneath -- one row each, read across by what
 * it holds, what it has returned and what it is for, and opened by clicking
 * the row.
 *
 * Backing leads. The way most people should take part is to pick a market
 * they believe in and stand behind it: first loss on that one market, half
 * the LP share of its fees. The pool is the default under all of it, for
 * whoever would rather hold every market at once than choose.
 *
 * There are two kinds of vault and the Strategy column says which. The pool
 * is the shared one: the counterparty of last resort in every market at once,
 * where a deposit mints xLP and the share price moves with what the pool
 * earns and pays. Every other row is one market's backing: first-loss capital
 * behind one listing, spent before the pool is touched, and the only thing
 * that lets a market somebody opened take positions at all.
 *
 * The APY is measured, not projected. The server watches what each vault's
 * share is worth -- the pool's share price, a market's backing per share,
 * both of which rise with the fees they keep and fall with what traders win
 * -- and annualizes the change over the window it has seen. Each figure says
 * how long that window is, and a vault watched for under an hour says
 * "Measuring" rather than scaling a few minutes up to a year.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import "@/site/serif.css";
import { AnimatePresence, motion } from "motion/react";
import { ChevronRight, X } from "lucide-react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { PILL_INDICATOR, PILL_LIST, PILL_TRIGGER, Shell, SiteFooter, SiteHeader } from "@/site/Chrome";
import { Mark } from "@/components/Brand";
import { TickerLogo } from "@/components/TickerLogo";
import { WalletActions } from "@/components/WalletActions";
import { Tabs, TabsList, TabsTrigger } from "@/components/motion/tabs";
import { AnimatedNumber } from "@/components/motion/animated-number";
import * as api from "@/lib/api";
import {
  getAccount, getApy, getBackings, getMarkets, usePoll,
  type Account, type Apy, type Backing, type Market,
} from "@/lib/api";
import { signAndSend } from "@/lib/tx";
import { PAY_TOKENS, usdPrices, type PayWith } from "@/lib/listing";
import { PayToken } from "@/components/PayToken";
import { YourBacking } from "@/components/YourBacking";
import { compact, money } from "@/lib/format";

const NONE: Market[] = [];
const NO_BACKINGS: Backing[] = [];

/*
 * beUI's sliding tabs, dressed as /list's pills: no track behind them, and
 * the indicator inverted to the foreground so the active label reads as
 * background on it. Classes only, so the shared defaults /markets uses stay.
 */

/// A key and its figure, one row of a summary.
const Stat = ({ k, children, tone = "" }: { k: string; children: ReactNode; tone?: string }) => (
  <div className="flex items-baseline justify-between gap-4 border-t border-line py-3 first:border-t-0">
    <span className="flex-none text-[12.5px] text-muted-foreground">{k}</span>
    <span className={`n truncate text-right text-[12.5px] font-semibold ${tone}`}>{children}</span>
  </div>
);

/// One place to put money, whichever kind it is.
interface Vault {
  id: string;
  kind: "pool" | "market";
  title: string;
  subtitle: string;
  market?: Market;
  tvl: number;
  /// The line under the TVL: what it is measured in, or against.
  tvlNote: string;
  /// The APY column: the rate, and the window it was measured over.
  apy: { text: string; tone: string; note: string; value?: number };
  strategy: string;
  yours: number;
  symbol?: string;
  /// Which of the toggle's groups it belongs to.
  group: "pool" | "equities" | "crypto" | "opened";
}

/// What the APY column says, for a vault the server has or has not watched.
function apyCell(a: Apy | null | undefined, empty: string) {
  if (!a) return { text: "–", tone: "text-dim", note: empty };
  if (a.apy == null) {
    const mins = Math.round(a.hours * 60);
    return { text: "Measuring", tone: "text-muted-foreground",
      note: `${mins < 60 ? `${mins}m` : `${a.hours.toFixed(1)}h`} of 1h` };
  }
  const window = a.hours >= 167 ? "7d" : a.hours >= 23.5 ? `${Math.round(a.hours / 24)}d`
    : `${Math.round(a.hours)}h`;
  return {
    text: `${a.apy >= 0 ? "" : "-"}${Math.abs(a.apy).toFixed(2)}%`,
    value: a.apy,
    tone: a.apy > 0 ? "text-up" : a.apy < 0 ? "text-down" : "text-foreground",
    note: `over ${window}`,
  };
}

function vaultsOf(account: Account | null | undefined, markets: Market[], backings: Backing[],
  apy: { pool: Apy | null; markets: Record<string, Apy> } | null | undefined) {
  const out: Vault[] = [];
  const pool = account?.pool;
  if (pool) {
    out.push({
      id: "pool", kind: "pool", title: "The pool", subtitle: "Every market · xLP",
      tvl: pool.aum,
      tvlNote: `${compact(pool.lpSupply)} xLP`,
      apy: apyCell(apy?.pool, "no deposits"),
      strategy: "Default",
      yours: account!.lp.value,
      group: "pool",
    });
  }
  /*
   * Every market, not only the ones somebody opened on a pool. `back_market`
   * does not care where a price comes from, so an equity priced by Pyth takes
   * first-loss capital exactly as a pool-watched token does -- it simply has
   * a feed where the other has a depth, and the row says which.
   */
  for (const m of markets) {
    const o = m.observed;
    out.push({
      id: m.symbol, kind: "market", symbol: m.symbol, market: m,
      title: m.name,
      subtitle: m.name === m.symbol ? "Listed by anyone" : m.symbol,
      tvl: m.backingUsd,
      tvlNote: o ? `of ${compact(o.depthUsd)} depth` : `${compact(m.lossBudgetUsd)} budget`,
      apy: apyCell(apy?.markets[m.symbol], "not backed yet"),
      strategy: "First loss",
      yours: backings.find((b) => b.symbol === m.symbol)?.value ?? 0,
      group: o ? "opened" : /x$/.test(m.symbol) ? "equities" : "crypto",
    });
  }
  return out;
}

/*
 * The vault, opened: in and out of one place.
 *
 * A dialog on a desktop and a sheet on a phone, from one element whose
 * anchoring changes at `sm` -- a centred card over a table is what a person at
 * a desk expects, and a panel rising from the bottom is what a thumb can
 * reach. Escape and the backdrop both close it.
 */
function VaultDialog({ v, account, start, onClose, onDone }: {
  v: Vault; account: Account | null | undefined; start: "in" | "out";
  onClose: () => void; onDone: () => void;
}) {
  const wallet = useWallet();
  const { setVisible } = useWalletModal();
  const owner = wallet.publicKey?.toBase58();
  const input = useRef<HTMLInputElement>(null);
  const [side, setSide] = useState<"in" | "out">(start);
  const [amount, setAmount] = useState("");
  /// MAX on the way out sends "all of it", so a position closes to zero
  /// instead of leaving a share's worth of dust behind.
  const [all, setAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  /// Backing can be paid in SOL or USDT as well, and is held as what it was
  /// paid in. The pool takes USDC only: xLP is minted against dollars.
  const [payWith, setPayWith] = useState<PayWith>("USDC");
  const [prices, setPrices] = useState<Record<PayWith, number> | null>(null);
  useEffect(() => { void usdPrices().then(setPrices).catch(() => {}); }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    addEventListener("keydown", onKey);
    input.current?.focus();
    return () => removeEventListener("keydown", onKey);
  }, [onClose]);

  const pool = account?.pool;
  const price = account?.lp.price ?? 1;
  const usd = Number(amount) > 0 ? Number(amount) : 0;
  const fee = v.kind === "pool"
    ? (side === "in" ? pool?.addFeePct ?? 0 : pool?.removeFeePct ?? 0) : 0;
  const paying = v.kind === "market" && side === "in" ? payWith : "USDC";
  const ceiling = side === "in" ? (account?.usdc ?? 0) : v.yours;
  // Only USDC has a balance this page knows; a SOL or USDT amount is checked
  // by the wallet instead.
  const over = paying === "USDC" && usd > ceiling + 1e-9;
  const usdOf = (n: number) => n * (paying === "USDC" ? 1 : prices?.[paying] ?? 0);
  const verb = side === "in" ? (v.kind === "pool" ? "Deposit" : "Back") : "Withdraw";

  const submit = async () => {
    if (!usd || over) return;
    setBusy(true); setNote(null);
    const [path, body]: [string, Record<string, unknown>] = v.kind === "pool"
      ? side === "in"
        ? ["deposit", { amount: usd }]
        : ["withdraw", { lpAmount: all ? account!.lp.held : usd / price }]
      : side === "in"
        ? ["back-market", { symbol: v.symbol, amount: usd, payWith: paying }]
        : ["unback-market", all ? { symbol: v.symbol, all: true } : { symbol: v.symbol, amount: usd }];
    try {
      const r = await signAndSend(wallet, path, body);
      setNote(r.ok
        ? { ok: true, text: `${side === "out" ? "Withdrew" : v.kind === "pool" ? "Deposited" : "Backed with"} ${
          paying === "USDC" ? money(usd) : `${usd} ${paying}`}.` }
        : { ok: false, text: r.error ?? "Not accepted." });
      if (r.ok) { setAmount(""); setAll(false); onDone(); }
    } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-6">
      <motion.button type="button" aria-label="Close" onClick={onClose}
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        transition={{ duration: 0.18 }}
        className="absolute inset-0 cursor-default bg-black/60" />
      <motion.div role="dialog" aria-modal="true" aria-label={v.title}
        initial={{ opacity: 0, y: 24, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 16, scale: 0.98 }}
        transition={{ duration: 0.22, ease: [0.23, 1, 0.32, 1] }}
        className="relative max-h-[92dvh] w-full overflow-y-auto rounded-t-[24px] border border-line
                   bg-panel safe-b sm:max-w-[460px] sm:rounded-[24px]">
        <div className="px-5 pb-5 pt-5 sm:px-6">
          <header className="flex items-center gap-3">
            <VaultIcon v={v} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[16px] font-medium">{v.title}</span>
              <span className="block truncate text-[12.5px] text-muted-foreground">
                {v.strategy} · {money(v.tvl, 0)} deposited
              </span>
            </span>
            <button type="button" onClick={onClose} aria-label="Close"
              className="press grid size-9 place-items-center rounded-full text-muted-foreground
                         transition-colors hover:bg-panel2 hover:text-foreground">
              <X size={16} strokeWidth={1.75} />
            </button>
          </header>

          <Tabs value={side} variant="pill" className="mt-5"
            onValueChange={(k) => {
              setSide(k as "in" | "out"); setAmount(""); setAll(false); setNote(null); setPayWith("USDC");
            }}>
            <TabsList className={PILL_LIST}>
              {(["in", "out"] as const).map((k) => (
                <TabsTrigger key={k} value={k} className={PILL_TRIGGER} indicatorClassName={PILL_INDICATOR}>
                  {k === "in" ? (v.kind === "pool" ? "Deposit" : "Back") : "Withdraw"}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>

          {v.kind === "market" && side === "in" && (
            <div className="mt-5">
              <span className="mb-2 block text-[13px] text-foreground">Pay with</span>
              <div role="radiogroup" aria-label="Pay with" className="flex flex-wrap gap-2">
                {(Object.keys(PAY_TOKENS) as PayWith[]).map((k) => (
                  <button key={k} type="button" role="radio" aria-checked={payWith === k}
                    onClick={() => { setPayWith(k); setAmount(""); }}
                    className={`press flex h-10 items-center rounded-full border pl-1.5 pr-4
                                text-[13.5px] transition-colors ${payWith === k
                      ? "border-foreground text-foreground"
                      : "border-line text-muted-foreground hover:text-foreground"}`}>
                    <PayToken k={k} size={26} className="gap-2.5" />
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="mt-5">
            <div className="mb-2 flex items-baseline justify-between gap-3">
              <label htmlFor="vault-amount" className="text-[13px] text-foreground">Amount</label>
              {owner && paying === "USDC" && (
                <button type="button"
                  onClick={() => { setAmount(ceiling.toFixed(2)); setAll(side === "out"); }}
                  className="n text-[12px] text-dim transition-colors hover:text-foreground">
                  {side === "in" ? "Wallet" : "Yours"} {money(ceiling)}
                  <span className="ml-1.5 font-medium text-foreground">MAX</span>
                </button>
              )}
            </div>
            <div className="relative">
              <input id="vault-amount" ref={input} value={amount} inputMode="decimal"
                onChange={(e) => { setAmount(e.target.value.replace(/[^\d.]/g, "")); setAll(false); }}
                onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
                placeholder="0.00" aria-label={`Amount to ${verb.toLowerCase()}`}
                className="n h-[52px] w-full rounded-[12px] border border-line bg-panel2 pl-4 pr-16
                           text-[20px] font-medium outline-none transition-colors
                           placeholder:text-dim focus:border-brand" />
              <span className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2">
                <img src={PAY_TOKENS[paying].logo} alt="" className="size-5 rounded-full" />
              </span>
            </div>
          </div>

          <div className="mt-5">
            {!owner ? (
              <button type="button" onClick={() => setVisible(true)} disabled={api.readOnly}
                className="press h-[48px] w-full rounded-full bg-foreground text-[14px] font-medium
                           text-background transition-opacity hover:opacity-90
                           disabled:pointer-events-none disabled:opacity-35">
                Connect wallet
              </button>
            ) : (
              <button type="button" onClick={submit} disabled={busy || !usd || over || api.readOnly}
                className="press h-[48px] w-full rounded-full bg-foreground text-[14px] font-medium
                           text-background transition-opacity hover:opacity-90
                           disabled:pointer-events-none disabled:opacity-35">
                {busy ? "Confirm in wallet"
                  : over ? `Over ${side === "in" ? "your balance" : "your deposit"}` : verb}
              </button>
            )}
            {api.readOnly && (
              <p className="mt-2.5 text-[12px] text-muted-foreground">
                Read-only. Deposits open with devnet.
              </p>
            )}
            {note && (
              <p className={`mt-2.5 text-[12.5px] ${note.ok ? "text-up" : "text-down"}`}>
                {note.text}
              </p>
            )}
          </div>
        </div>

        {/* The summary, set apart the way /list sets its preview apart. */}
        <div className="border-t border-line bg-panel2 px-5 pb-5 pt-2 sm:px-6">
          <Stat k="You receive">
            {!usd ? "–" : v.kind === "pool" && side === "in"
              ? `${(usd * (1 - fee / 100) / price).toLocaleString(undefined, { maximumFractionDigits: 2 })} xLP`
              : paying !== "USDC"
                ? `≈${money(usdOf(usd), 0)} backing, held as ${paying}`
                : money(usd * (1 - fee / 100))}
          </Stat>
          <Stat k="Fee">{fee ? `${fee}%, paid to remaining LPs` : "none"}</Stat>
          <Stat k="Yours now">{money(v.yours)}</Stat>
          <Stat k="APY" tone={v.apy.tone}>
            {v.apy.text}
            <span className="ml-1.5 font-normal text-dim">{v.apy.note}</span>
          </Stat>

          {/* The risk, where the money is committed rather than on another page. */}
          <p className="border-t border-line pt-3.5 text-[12px] leading-relaxed text-dim">
            {v.kind === "pool"
              ? "The pool takes the other side of traders' net PnL. When they win, xLP is worth less."
              : `First loss when this market's traders win. Earns half the LP fee share. Held as ${paying}, not swapped${
                paying === "SOL" ? "; counts at 80%" : ""
              }. Withdrawals come back in the same mix, minus what open positions still need.`}
          </p>
        </div>
      </motion.div>
    </div>
  );
}

/// The pool wears the venue's own mark; a market wears its token's.
function VaultIcon({ v }: { v: Vault }) {
  return v.kind === "pool" || !v.market ? (
    <span className="grid size-10 flex-none place-items-center rounded-full border border-line
                     bg-panel2">
      <Mark size={22} />
    </span>
  ) : (
    <span className="flex-none"><TickerLogo m={v.market} size={40} /></span>
  );
}

/*
 * The toggle over the table, in the pills /list switches its tabs with. The
 * groups are the market list's own, what a market tracks and who opened it,
 * plus the one only this page needs: what is yours.
 */
const FILTERS = [
  { key: "all", label: "All" },
  { key: "equities", label: "Equities" },
  { key: "crypto", label: "Crypto" },
  { key: "opened", label: "Opened by anyone" },
  { key: "yours", label: "Yours" },
] as const;
type Filter = (typeof FILTERS)[number]["key"];

const keep = (v: Vault, f: Filter) =>
  f === "all" ? true
    : f === "yours" ? v.yours > 0
      // The pool is every market's, so it belongs under All and nowhere narrower.
      : v.group === f;

export default function Earn() {
  const wallet = useWallet();
  const { setVisible } = useWalletModal();
  const owner = wallet.publicKey?.toBase58();
  const [tick, setTick] = useState(0);
  const account = usePoll(() => getAccount(owner), 3000, [owner, tick]);
  const markets = usePoll(getMarkets, 5000) ?? NONE;
  const backings = usePoll(() => getBackings(owner), 5000, [owner, tick]) ?? NO_BACKINGS;
  // The tape is sampled every two minutes, so polling faster than this would
  // only ask the same question again.
  const apy = usePoll(getApy, 30_000);

  const [open, setOpen] = useState<{ id: string; start: "in" | "out" } | null>(null);
  const [filter, setFilter] = useState<Filter>("all");

  const vaults = useMemo(() => vaultsOf(account, markets, backings, apy),
    [account, markets, backings, apy]);
  const opened = open ? vaults.find((v) => v.id === open.id) ?? null : null;
  // Markets first, most-backed at the top, and the pool after them: backing
  // is the thing to choose, and the pool is what you get by not choosing.
  const shown = useMemo(() => vaults
    .filter((v) => keep(v, filter))
    .sort((a, b) => (a.kind === "pool" ? 1 : b.kind === "pool" ? -1 : b.tvl - a.tvl)),
  [vaults, filter]);

  const pool = account?.pool;
  const deposited = vaults.reduce((a, v) => a + v.tvl, 0);
  const yours = vaults.reduce((a, v) => a + v.yours, 0);
  const poolApy = apyCell(apy?.pool, "no deposits");
  const table = useRef<HTMLElement>(null);
  const toMarkets = () => {
    setFilter("all");
    table.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div className="site min-h-full">
      <SiteHeader here="/earn" actions={<WalletActions />} />

      <Shell className="pb-14 pt-4 sm:pt-8">
        <div className="grid overflow-hidden rounded-[24px] border border-line bg-panel
                        lg:grid-cols-[minmax(0,1fr)_440px]">
          {/*
           * The hero: the page's claim on the left and, on the right, the
           * three coins that claim names, SOL, USDC and USDT on the pedestal a
           * vault is.
           *
           * The render is on its own transparent ground, so the card shows
           * through it in either theme. It is sized by the column's width, not
           * its height, because the column narrows a long way before it gets
           * any shorter. Hidden on a phone, where the copy takes the full
           * width and there is no side to put it on.
           */}
          <section className="relative min-h-[300px] overflow-hidden">
            {/* The front page's violet light, faint, under the render (dark mode only). */}
            <img src="/waitlist/field.webp" alt="" aria-hidden
              className="pointer-events-none absolute inset-0 hidden h-full w-full object-cover
                         opacity-45 dark:block" />
            {/* Two renders: the dark one's glow reads as haze on white. Both are the
                blue originals with the stand and glow shifted to the brand violet
                (the *-violet files); the three coins keep their own colours. */}
            <img src="/earn/hero-violet.webp" alt="" aria-hidden width={900} height={900}
              draggable={false}
              className="pointer-events-none absolute right-2 top-1/2 hidden h-auto
                         w-[min(46%,320px)] -translate-y-1/2 select-none sm:block
                         dark:!hidden" />
            <img src="/earn/hero-dark-violet.webp" alt="" aria-hidden width={900} height={900}
              draggable={false}
              className="pointer-events-none absolute right-2 top-1/2 hidden h-auto
                         w-[min(46%,320px)] -translate-y-1/2 select-none
                         dark:sm:block" />
            {/* Keeps the copy legible where the render's glow reaches under
                it, and stops short of the coins themselves. */}
            <div aria-hidden className="pointer-events-none absolute inset-0 bg-gradient-to-r
                                        from-panel via-panel/70 via-40% to-transparent to-58%" />
            <div className="relative flex h-full flex-col justify-center px-5 py-9
                            sm:max-w-[min(460px,58%)] sm:px-9">
              <h1 className="font-serif-display text-[clamp(3rem,6vw,4.5rem)] leading-none
                             tracking-[-.025em]">
                Earn
              </h1>
              <p className="mt-3.5 text-[15px] leading-[1.55] text-muted-foreground">
                Back a market you believe in with{" "}
                <span className="whitespace-nowrap">
                  <PayToken k="SOL" size={17} className="font-medium text-foreground" />,
                </span>{" "}
                <PayToken k="USDC" size={17} className="font-medium text-foreground" /> or{" "}
                <PayToken k="USDT" size={17} className="font-medium text-foreground" />.
              </p>
              <div className="mt-7 flex flex-wrap items-center gap-x-5 gap-y-3">
                <button type="button" onClick={toMarkets}
                  className="press h-[48px] rounded-full bg-foreground px-6 text-[14px]
                             font-medium text-background transition-opacity hover:opacity-90">
                  Back a market
                </button>
                <button type="button" onClick={() => setOpen({ id: "pool", start: "in" })}
                  disabled={!pool}
                  className="text-[13.5px] text-muted-foreground underline decoration-line
                             underline-offset-4 transition-colors hover:text-foreground
                             hover:decoration-foreground/40 disabled:opacity-35">
                  or join the pool
                </button>
              </div>
            </div>
          </section>

          {/* What the visitor holds, beside the way in. */}
          <aside className="flex min-w-0 flex-col border-t border-line bg-panel2 px-5 py-7
                            sm:px-9 sm:py-9 lg:border-l lg:border-t-0">
            <h2 className="text-[16px] font-medium">The pool</h2>
            <p className="mt-1 text-[12.5px] leading-relaxed text-muted-foreground">
              One deposit across every market.
            </p>

            <div className="mt-4">
              <Stat k="In your wallet">
                {owner ? (
                  <span className="inline-flex items-center gap-1.5">
                    <AnimatedNumber value={account?.usdc ?? 0} duration={0.9}
                      format={(n) => n.toLocaleString(undefined, { maximumFractionDigits: 2 })} />
                    <PayToken k="USDC" size={15} />
                  </span>
                ) : <span className="font-normal text-muted-foreground">not connected</span>}
              </Stat>
              <Stat k={`Pool APY${poolApy.text !== "–" ? `, ${poolApy.note}` : ""}`} tone={poolApy.tone}>
                {poolApy.value != null
                  ? <AnimatedNumber value={poolApy.value} duration={0.9}
                      format={(n) => `${n < 0 ? "-" : ""}${Math.abs(n).toFixed(2)}%`} />
                  : poolApy.text}
              </Stat>
              <Stat k="Deposited">
                {owner ? <AnimatedNumber value={yours} duration={0.9} format={(n) => money(n)} /> : <span className="font-normal text-dim">–</span>}
              </Stat>
            </div>

            {/* Without a wallet there is nothing to deposit from, and a greyed
                Deposit says "unavailable" when the truth is "connect first". */}
            {!owner ? (
              <div className="mt-auto pt-6">
                <button type="button" onClick={() => setVisible(true)} disabled={api.readOnly}
                  className="press h-[48px] w-full rounded-full bg-foreground text-[14px] font-medium
                             text-background transition-opacity hover:opacity-90
                             disabled:pointer-events-none disabled:opacity-35">
                  Connect wallet
                </button>
              </div>
            ) : (
            <div className="mt-auto grid grid-cols-2 gap-2.5 pt-6">
              <button type="button" onClick={() => setOpen({ id: "pool", start: "in" })}
                disabled={!pool}
                className="press h-[48px] rounded-full bg-foreground text-[14px] font-medium
                           text-background transition-opacity hover:opacity-90
                           disabled:pointer-events-none disabled:opacity-35">
                Deposit
              </button>
              <button type="button" onClick={() => setOpen({ id: "pool", start: "out" })}
                disabled={!pool}
                className="press h-[48px] rounded-full border border-line text-[14px] font-medium
                           transition-colors hover:border-foreground/40
                           disabled:pointer-events-none disabled:opacity-35">
                Withdraw
              </button>
            </div>
            )}
          </aside>
        </div>

        {/* ---------------------------------------------- where yours is */}
        <YourBacking backings={backings} markets={markets}
          onAdd={(symbol) => setOpen({ id: symbol, start: "in" })}
          onWithdraw={(symbol) => setOpen({ id: symbol, start: "out" })} />

        {/* ------------------------------------------------ the vaults */}
        <section ref={table}
          className="mt-5 scroll-mt-24 overflow-hidden rounded-[24px] border border-line bg-panel">
          <div className="flex flex-wrap items-center justify-between gap-4 px-5 pb-5 pt-7 sm:px-9">
            <div>
              <h2 className="text-[clamp(1.375rem,2.2vw,1.625rem)] font-medium tracking-[-.02em]">
                Back a market
                <span className="n ml-2 text-[14px] font-normal text-dim">{shown.length}</span>
              </h2>
              <p className="n mt-1 text-[12.5px] text-muted-foreground">
                <AnimatedNumber value={deposited} duration={0.9} format={(n) => money(n, 0)} /> deposited
              </p>
            </div>
            <Tabs value={filter} onValueChange={(f) => setFilter(f as Filter)} variant="pill"
              className="min-w-0 max-w-full">
              <TabsList className={PILL_LIST}>
                {FILTERS.map((f) => (
                  <TabsTrigger key={f.key} value={f.key} className={PILL_TRIGGER}
                    indicatorClassName={PILL_INDICATOR}>
                    {f.label}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          </div>

          {/*
           * One grid for the header and every row, so a column cannot drift
           * between them. Below `md` the APY and Strategy columns go and the
           * row keeps what a thumb needs to choose: which vault, how big, and
           * the way in.
           */}
          <div className="grid grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_28px] items-center
                          gap-4 border-t border-line px-5 py-3 text-[12.5px]
                          text-muted-foreground sm:px-9
                          md:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,.8fr)_28px]">
            <span>Vault</span>
            <span>TVL</span>
            <span className="hidden md:block">APY</span>
            <span className="hidden md:block">Strategy</span>
            <span className="hidden md:block">Yours</span>
            <span />
          </div>

          {shown.length === 0 && (
            <p className="border-t border-line px-5 py-10 text-center text-[13px] text-muted-foreground">
              {filter === "yours"
                ? "Nothing deposited yet."
                : "None yet."}
            </p>
          )}
          {shown.map((v) => (
            <button key={v.id} type="button" onClick={() => setOpen({ id: v.id, start: "in" })}
              className="group grid w-full grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_28px]
                         items-center gap-4 border-t border-line px-5 py-4 text-left
                         transition-colors hover:bg-panel2 sm:px-9
                         md:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,.8fr)_28px]">
              <span className="flex min-w-0 items-center gap-3">
                <VaultIcon v={v} />
                <span className="min-w-0">
                  <span className="block truncate text-[14px] font-medium">{v.title}</span>
                  <span className="block truncate text-[12.5px] text-muted-foreground">
                    {v.subtitle}
                  </span>
                </span>
              </span>
              <span className="min-w-0">
                {/* Compact on a phone, where the full figure is wider than
                    its column and would be cut to "$10,007,...": a number
                    with its end missing is worse than a rounder one. */}
                <span className="n block truncate text-[14px] font-semibold">
                  <AnimatedNumber value={v.tvl} duration={0.9} format={compact} className="md:hidden" />
                  <AnimatedNumber value={v.tvl} duration={0.9} format={(n) => money(n, 0)}
                    className="hidden md:inline" />
                </span>
                <span className="n block truncate text-[12px] text-muted-foreground">
                  {v.tvlNote}
                </span>
              </span>
              <span className="hidden min-w-0 md:block">
                <span className={`n block truncate text-[14px] font-semibold ${v.apy.tone}`}>
                  {v.apy.value != null
                    ? <AnimatedNumber value={v.apy.value} duration={0.9}
                        format={(n) => `${n < 0 ? "-" : ""}${Math.abs(n).toFixed(2)}%`} />
                    : v.apy.text}
                </span>
                <span className="n block truncate text-[12px] text-muted-foreground">
                  {v.apy.note}
                </span>
              </span>
              <span className="hidden md:block">
                <span className={`inline-block rounded-full border px-3 py-1 text-[12px] ${
                  v.kind === "pool" ? "border-foreground/40 text-foreground"
                    : "border-line text-muted-foreground"}`}>
                  {v.strategy}
                </span>
              </span>
              <span className="n hidden truncate text-[13.5px] md:block">
                {v.yours > 0 ? money(v.yours) : <span className="text-dim">–</span>}
              </span>
              <ChevronRight size={18} strokeWidth={1.75}
                className="justify-self-end text-dim transition-transform duration-200
                           group-hover:translate-x-0.5 group-hover:text-foreground" />
            </button>
          ))}

          {/* Where the table ends, the way to make it longer: every market
              anybody opens becomes a vault here. */}
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line
                          bg-panel2 px-5 py-4 text-[13px] text-muted-foreground sm:px-9">
            Every new market becomes a vault.
            <a href="/list"
              className="press flex h-9 flex-none items-center rounded-full border border-line px-4
                         text-[13px] font-medium text-foreground transition-colors
                         hover:border-foreground/40">
              Open a market
            </a>
          </div>
        </section>
      </Shell>

      <AnimatePresence>
        {opened && open && (
          <VaultDialog key={`${opened.id}-${open.start}`} v={opened} account={account}
            start={open.start} onClose={() => setOpen(null)} onDone={() => setTick((t) => t + 1)} />
        )}
      </AnimatePresence>

      <SiteFooter />
    </div>
  );
}
