/*
 * Rewards.
 *
 * What a wallet has earned. Points are counted by the program as they are
 * earned, so every figure here is one anybody can check. Referrals and
 * listings also pay USDC, out of the protocol's cut of each fee.
 *
 * The copy leads with the figure, not an adjective; gives each rate a caps
 * label, a number and one line of qualification; and states the principles
 * as things the program refuses to do. An earlier version used step cards,
 * stat tiles, a FAQ and paired slogans, and read as a template.
 */
import { useEffect, useState, type ReactNode } from "react";
import "@/site/serif.css";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { DOCS, PILL_INDICATOR, PILL_LIST, PILL_TRIGGER, Shell, SiteFooter, SiteHeader } from "@/site/Chrome";
import { WalletActions } from "@/components/WalletActions";
import { Tabs, TabsList, TabsTrigger } from "@/components/motion/tabs";
import { AnimatedNumber } from "@/components/motion/animated-number";
import * as api from "@/lib/api";
import {
  checkCode, getLeaderboard, getRewards, useHasBackend, usePoll,
  type LeaderRow, type Leaderboard, type Rewards,
} from "@/lib/api";
import { storedRef } from "@/lib/ref";
import { signAndSend } from "@/lib/tx";
import { compact, money } from "@/lib/format";

/// The rules in force. Shown on the page so a change is never silent.
const RULES_VERSION = "v1";
const RULES_URL = `${DOCS}/trading/rewards`;

type Tab = "leaderboard" | "referrals" | "rules";
const TABS: [Tab, string][] = [
  ["leaderboard", "Leaderboard"],
  ["referrals", "Referrals"],
  ["rules", "How it works"],
];

const BTN = "press h-[48px] rounded-full bg-foreground px-6 text-[14px] font-medium text-background " +
  "transition-opacity hover:opacity-90 disabled:pointer-events-none disabled:opacity-35";
const LINK = "underline decoration-line underline-offset-4 transition-colors hover:text-foreground";
const CAPS = "text-[11px] font-medium uppercase tracking-[.08em] text-muted-foreground";
const DASH = <span className="font-normal text-dim">–</span>;

const points = (n: number) =>
  n.toLocaleString(undefined, { maximumFractionDigits: n < 100 ? 2 : 0 });
const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;

/// Every rate, as the program counts it. Mirrors `constants.rs`.
const RATES: { label: string; figure: string; line: string }[] = [
  { label: "Trading", figure: "1 point per $1",
    line: "Every fill, open or close, maker or taker." },
  { label: "Referrals", figure: "10% of their fees",
    line: "Paid in USDC, out of our cut. Plus 10% of their points. They pay 10% less." },
  { label: "Markets", figure: "10% of every fee",
    line: "On any market you open, for as long as it trades. Half fees when you trade it yourself." },
  { label: "Backing", figure: "2 points per $1 a day",
    line: "Backing takes first loss, so it earns double." },
  { label: "Pool", figure: "1 point per $1 a day",
    line: "On xLP still in the wallet that minted it." },
];

/// What the program will not do. Stated plainly, since these are what
/// other points programs were caught doing.
const PRINCIPLES = [
  "No snapshots. No multipliers. No points changed after the fact.",
  "Counted by the program, not by us. Anyone can check any wallet on chain.",
  "Referral and market rewards come out of our cut. LPs, backers, insurance and the chain are paid in full.",
  "A referrer is set once, before the first trade. It can't be bought later.",
  "Points are not a token.",
];

/// Seconds, ticking once a second while `on`.
function useClock(on: boolean) {
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    if (!on) return;
    const id = setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => clearInterval(id);
  }, [on]);
  return now;
}

export default function RewardsPage() {
  const wallet = useWallet();
  const { setVisible } = useWalletModal();
  const connected = wallet.publicKey?.toBase58();
  // `?wallet=` shows anyone's rewards, read only. It is all public on chain.
  const [viewing] = useState(() => {
    const w = new URLSearchParams(location.search).get("wallet");
    return w && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(w) ? w : null;
  });
  const owner = viewing ?? connected;
  const self = !viewing || viewing === connected;
  const testnet = useHasBackend() === true;

  // The tab lives in the hash, so a link can open straight to one.
  const tabFromHash = (): Tab => {
    const h = location.hash.slice(1) as Tab;
    return TABS.some(([k]) => k === h) ? h : "leaderboard";
  };
  const [tab, setTab] = useState<Tab>(tabFromHash);
  useEffect(() => {
    const sync = () => setTab(tabFromHash());
    addEventListener("hashchange", sync);
    return () => removeEventListener("hashchange", sync);
  }, []);
  const go = (t: Tab) => {
    setTab(t);
    history.replaceState(null, "", `${location.pathname}${location.search}#${t}`);
  };

  const [tick, setTick] = useState(0);
  const r = usePoll<Rewards | null>(() => getRewards(owner), 15_000, [owner, tick]);
  const all = usePoll<Leaderboard | null>(() => getLeaderboard("all", owner), 30_000, [owner, tick]);
  const week = usePoll<Leaderboard | null>(() => getLeaderboard("week", owner), 30_000, [owner, tick]);
  const refresh = () => setTick((t) => t + 1);

  // Backing and the pool earn by the second, so those points are carried
  // forward between reads. Everything else arrives in steps.
  const rate = r ? r.perDay.backing + r.perDay.lp : 0;
  const now = useClock(rate > 0);
  const live = r ? r.points + (rate * Math.max(0, now - r.asOf)) / 86_400 : 0;

  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const run = async (key: string, path: string, body: Record<string, unknown> = {}) => {
    setBusy(key); setNote(null);
    const res = await signAndSend(wallet, path, body);
    setBusy(null);
    setNote(res.ok ? null : res.error ?? "failed");
    if (res.ok) refresh();
  };

  const arrived = storedRef();
  const link = r?.code ? `${location.origin}/?ref=${r.code}` : null;
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (!link) return;
    try { await navigator.clipboard.writeText(link); setCopied(true); } catch { /* denied */ }
    setTimeout(() => setCopied(false), 1400);
  };
  const explorer = (address: string) =>
    `https://solscan.io/account/${address}${testnet ? "?cluster=devnet" : ""}`;
  const who = (address: string, code?: string | null) => code ?? short(address);

  return (
    <div className="site min-h-full">
      <SiteHeader here="/rewards" actions={<WalletActions />} />

      <Shell className="pb-14 pt-4 sm:pt-8">
        <div className="grid overflow-hidden rounded-[24px] border border-line bg-panel
                        lg:grid-cols-[minmax(0,1fr)_440px]">
          <section className="relative min-h-[320px] overflow-hidden">
            {/* The front page's violet light and the glass mark, as /earn
                carries its coins. Hidden on a phone. */}
            <img src="/waitlist/field.webp" alt="" aria-hidden
              className="pointer-events-none absolute inset-0 hidden h-full w-full object-cover
                         opacity-45 dark:block" />
            <img src="/waitlist/logo-glass.webp" alt="" aria-hidden width={900} height={900}
              draggable={false}
              className="pointer-events-none absolute right-[-4%] top-1/2 hidden h-auto
                         w-[min(46%,340px)] -translate-y-1/2 select-none sm:block
                         [animation:spin_120s_linear_infinite] motion-reduce:[animation:none]" />
            <div aria-hidden className="pointer-events-none absolute inset-0 bg-gradient-to-r
                                        from-panel via-panel/75 via-45% to-transparent to-70%" />

            <div className="relative flex h-full flex-col justify-center px-5 py-9
                            sm:max-w-[min(460px,60%)] sm:px-9">
              <h1 className="font-serif-display text-[clamp(3rem,6vw,4.5rem)] leading-none
                             tracking-[-.025em]">
                Rewards
              </h1>
              <p className="mt-3.5 text-[15px] leading-[1.55] text-muted-foreground">
                Points on every dollar you trade, back or deposit. USDC on every trader you
                bring and every market you open.
              </p>

              <div className="mt-7">
                {!self ? (
                  <p className="text-[13px] text-muted-foreground">
                    Viewing <span className="n font-medium text-foreground">{who(viewing!, r?.code)}</span>.
                    Only its owner can claim.{" "}
                    <a href="/rewards" className={LINK}>Yours</a>
                  </p>
                ) : !owner ? (
                  <button type="button" onClick={() => setVisible(true)} disabled={api.readOnly}
                    className={BTN}>
                    Connect wallet
                  </button>
                ) : link ? (
                  <YourLink link={link} copied={copied} onCopy={copy} />
                ) : (
                  <ClaimCode busy={busy === "code"}
                    onClaim={(code) => run("code", "referral-code", { code })} />
                )}
                {self && owner && r?.canSetReferrer !== false && !r?.referrer && arrived
                  && arrived !== r?.code && (
                  <p className="mt-4 text-[12.5px] leading-relaxed text-muted-foreground">
                    Joined through <span className="font-medium text-foreground">{arrived}</span>.
                    Your first order locks them in as your referrer and takes 10% off your fees.{" "}
                    <button type="button" disabled={!!busy} className={`${LINK} disabled:opacity-35`}
                      onClick={() => run("ref", "set-referrer", { code: arrived })}>
                      {busy === "ref" ? "Confirming" : "Lock in now"}
                    </button>
                  </p>
                )}
                {r?.referrer && (
                  <p className="mt-4 text-[12.5px] text-muted-foreground">
                    Referred by{" "}
                    <span className="font-medium text-foreground">
                      {r.referrerCode ?? short(r.referrer)}
                    </span>. 10% off every fee.
                  </p>
                )}
                {note && <p className="mt-3 text-[12.5px] text-down">{note}</p>}
              </div>
            </div>
          </section>

          <aside className="flex min-w-0 flex-col border-t border-line bg-panel2 px-5 py-7
                            sm:px-9 sm:py-9 lg:border-l lg:border-t-0">
            <div className={CAPS}>Points</div>
            <div className="n mt-2 text-[40px] font-semibold leading-none tracking-[-.02em]">
              {/* Two places while it is earning by the second, or the ticking
                  would be invisible. */}
              {r ? <AnimatedNumber value={live} duration={0.9}
                format={rate > 0 ? (n) => n.toLocaleString(undefined,
                  { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : points} /> : DASH}
            </div>

            <div className="mt-5">
              <Stat k="Rank">
                {all?.me ? <>#{all.me.rank} <span className="font-normal text-muted-foreground">
                  of {all.wallets.toLocaleString()}</span></> : DASH}
              </Stat>
              {rate > 0 && <Stat k="Earning">+{points(rate)} a day</Stat>}
              <Stat k="Trading">{r ? points(r.breakdown.trading) : DASH}</Stat>
              <Stat k="Referrals">{r ? points(r.breakdown.referrals) : DASH}</Stat>
              <Stat k="Markets">{r ? points(r.breakdown.listing) : DASH}</Stat>
              <Stat k="Backing and pool">{r ? points(r.breakdown.stakes) : DASH}</Stat>
              <Stat k="Fees saved">{r ? money(r.feesSaved) : DASH}</Stat>
              <Stat k="USDC to claim">
                {r ? <AnimatedNumber value={r.claimable} duration={0.9} format={(n) => money(n)} /> : DASH}
              </Stat>
            </div>

            <div className="mt-auto pt-6">
              <button type="button" disabled={!self || !owner || !r || r.claimable <= 0 || !!busy}
                onClick={() => run("claim", "claim-rewards")} className={`${BTN} w-full`}>
                {busy === "claim" ? "Claiming" : "Claim"}
              </button>
              {r?.exists && (
                <p className="mt-2.5 text-center text-[12px] text-muted-foreground">
                  {r.claimed > 0 && <>{money(r.claimed)} claimed. </>}
                  <a href={explorer(r.account)} target="_blank" rel="noreferrer" className={LINK}>
                    Verify on Solscan
                  </a>
                </p>
              )}
            </div>
          </aside>
        </div>

        <div className="mt-8">
          <Tabs value={tab} onValueChange={(t) => go(t as Tab)} variant="pill" className="min-w-0 max-w-full">
            <TabsList className={PILL_LIST}>
              {TABS.map(([k, label]) => (
                <TabsTrigger key={k} value={k} className={PILL_TRIGGER} indicatorClassName={PILL_INDICATOR}>
                  {label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>

        {tab === "leaderboard" && <Board all={all} week={week} owner={owner} self={self} who={who} />}

        {tab === "referrals" && (
          owner && r ? (
            <>
              <Referrals r={r} self={self} explorer={explorer} />
              <Markets r={r} self={self} />
            </>
          ) : (
            <Card title="Referrals"><Empty>Connect a wallet to see yours.</Empty></Card>
          )
        )}

        {tab === "rules" && (
          <div className="mt-4 grid overflow-hidden rounded-[24px] border border-line bg-panel
                          lg:grid-cols-[minmax(0,1fr)_440px]">
            {/* Bulk's numbered facts: a label, the figure, one line. */}
            <ol>
              {RATES.map((x, i) => (
                <li key={x.label}
                  className="grid grid-cols-[32px_minmax(0,1fr)] gap-x-4 border-t border-line px-5 py-6
                             first:border-t-0 sm:px-9">
                  <span className="n pt-0.5 text-[12px] text-muted-foreground">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <div>
                    <div className={CAPS}>{x.label}</div>
                    <div className="mt-1.5 text-[22px] font-semibold leading-tight tracking-[-.01em]">
                      {x.figure}
                    </div>
                    <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">{x.line}</p>
                  </div>
                </li>
              ))}
            </ol>
            <aside className="border-t border-line bg-panel2 px-5 py-7 sm:px-9 sm:py-9 lg:border-l
                              lg:border-t-0">
              <div className={CAPS}>The rules</div>
              <ul className="mt-4 space-y-3 text-[14px] leading-relaxed">
                {PRINCIPLES.map((p) => <li key={p}>{p}</li>)}
              </ul>
              <p className="mt-6 text-[12.5px] text-muted-foreground">
                Rules {RULES_VERSION}. They only change going forward, and every change is{" "}
                <a href={`${RULES_URL}#rules-changelog`} target="_blank" rel="noreferrer" className={LINK}>
                  logged
                </a>.
              </p>
            </aside>
          </div>
        )}
      </Shell>

      <SiteFooter />
    </div>
  );
}

/// One key and its figure, as /list's preview writes them.
const Stat = ({ k, children }: { k: string; children: ReactNode }) => (
  <div className="flex items-baseline justify-between gap-4 border-t border-line py-3 first:border-t-0">
    <span className="flex-none text-[12.5px] text-muted-foreground">{k}</span>
    <span className="n truncate text-right text-[12.5px] font-semibold">{children}</span>
  </div>
);

function Card({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="mt-4 overflow-hidden rounded-[24px] border border-line bg-panel">
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 pb-4 pt-6 sm:px-7">
        <h2 className="text-[16px] font-medium">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

const Empty = ({ children }: { children: ReactNode }) => (
  <p className="border-t border-line px-5 py-8 text-[13px] text-muted-foreground sm:px-7">{children}</p>
);

const Head = ({ children, cols }: { children: ReactNode; cols: string }) => (
  <div className={`${cols} border-t border-line px-5 py-2.5 sm:px-7 ${CAPS}`}>{children}</div>
);

const BOARD = "grid grid-cols-[40px_minmax(0,1fr)_minmax(0,.8fr)] items-center gap-x-4 " +
  "md:grid-cols-[48px_minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,.8fr)]";

function Board({ all, week, owner, self, who }: {
  all: Leaderboard | null; week: Leaderboard | null; owner?: string; self: boolean;
  who: (a: string, c?: string | null) => string;
}) {
  const [period, setPeriod] = useState<"all" | "week">("all");
  const b = period === "all" ? all : week;
  const score = (row: LeaderRow) => period === "week" ? row.week : row.points;
  const rows = b?.top ?? [];
  const pinned = b?.me && !rows.some((t) => t.wallet === b.me!.wallet) ? b.me : null;

  const Line = ({ row }: { row: LeaderRow }) => (
    <div className={`${BOARD} border-t border-line px-5 py-3 text-[13.5px] sm:px-7 ${
      row.wallet === owner ? "bg-panel2" : ""}`}>
      <span className={`n ${row.rank <= 3 ? "font-semibold" : "text-muted-foreground"}`}>{row.rank}</span>
      <span className="n min-w-0 truncate font-medium">
        {who(row.wallet, row.code)}
        {row.wallet === owner && self && <span className="ml-2 font-normal text-muted-foreground">(you)</span>}
      </span>
      <span className="n text-right md:text-left">{points(score(row))}</span>
      <span className="n hidden text-muted-foreground md:block">{compact(row.volume)}</span>
    </div>
  );

  return (
    <Card title="Leaderboard" aside={
      <Tabs value={period} onValueChange={(p) => setPeriod(p as "all" | "week")} variant="pill"
        className="min-w-0 max-w-full">
        <TabsList className={PILL_LIST}>
          {([["all", "All time"], ["week", "This week"]] as const).map(([k, label]) => (
            <TabsTrigger key={k} value={k} className={PILL_TRIGGER} indicatorClassName={PILL_INDICATOR}>
              {label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
    }>
      <Head cols={BOARD}>
        <span>#</span><span>Wallet</span>
        <span className="text-right md:text-left">{period === "week" ? "This week" : "Points"}</span>
        <span className="hidden md:block">Volume</span>
      </Head>
      {pinned && <Line row={pinned} />}
      {rows.map((row) => <Line key={row.wallet} row={row} />)}
      {!b && <Empty>Connect to devnet to load it.</Empty>}
      {b && rows.length === 0 && <Empty>No points yet.</Empty>}
      {b && b.wallets > 0 && (
        <p className="border-t border-line px-5 py-4 text-[12.5px] text-muted-foreground sm:px-7">
          {b.wallets.toLocaleString()} wallets. Top 20 hold {(b.concentration * 100).toFixed(1)}%.{" "}
          {money(b.paidUsd)} paid out. House wallets aren't ranked.
        </p>
      )}
    </Card>
  );
}

function Referrals({ r, self, explorer }: {
  r: Rewards; self: boolean; explorer: (a: string) => string;
}) {
  const cols = "grid grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)] items-center gap-x-4 " +
    "md:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)]";
  return (
    <Card title="Referred" aside={
      <span className="n text-[12.5px] text-muted-foreground">
        {r.referralCount} · {money(r.earned.referrals)} earned
      </span>
    }>
      {r.referees.length === 0 ? (
        <Empty>{!self || r.code ? "No referrals yet." : "Claim a code above to get a link."}</Empty>
      ) : (
        <>
          <Head cols={cols}>
            <span>Wallet</span><span>Volume</span><span>USDC</span>
            <span className="hidden md:block">Points</span>
          </Head>
          {r.referees.map((x) => (
            <div key={x.wallet}
              className={`${cols} border-t border-line px-5 py-3 text-[13.5px] sm:px-7`}>
              <a href={explorer(x.wallet)} target="_blank" rel="noreferrer"
                className="n min-w-0 truncate font-medium hover:underline">
                {x.code ?? short(x.wallet)}
              </a>
              <span className="n">{compact(x.volume)}</span>
              <span className="n">{money(x.usdc)}</span>
              <span className="n hidden md:block">{points(x.points)}</span>
            </div>
          ))}
        </>
      )}
    </Card>
  );
}

function Markets({ r, self }: { r: Rewards; self: boolean }) {
  const cols = "grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)] items-center gap-x-4 " +
    "md:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)]";
  return (
    <Card title="Markets opened" aside={
      <span className="n text-[12.5px] text-muted-foreground">{money(r.earned.listing)} earned</span>
    }>
      {r.listed.length === 0 ? (
        <Empty>
          {self ? <>No markets yet. <a href="/list" className={LINK}>Open one</a> and earn 10% of its fees.</>
            : "No markets yet."}
        </Empty>
      ) : (
        <>
          <Head cols={cols}>
            <span>Market</span><span>Volume</span><span>USDC</span>
            <span className="hidden md:block">Points</span>
          </Head>
          {r.listed.map((m) => (
            <a key={m.symbol} href={`/trade?symbol=${m.symbol}`}
              className={`${cols} border-t border-line px-5 py-3 text-[13.5px] hover:bg-panel2 sm:px-7`}>
              <span className="min-w-0 truncate font-medium">{m.symbol}</span>
              <span className="n">{compact(m.volume)}</span>
              <span className="n">{money(m.earned)}</span>
              <span className="n hidden md:block">{points(m.volume * 0.1)}</span>
            </a>
          ))}
        </>
      )}
    </Card>
  );
}

function YourLink({ link, copied, onCopy }: { link: string; copied: boolean; onCopy: () => void }) {
  return (
    <div>
      <div className={CAPS}>Your link</div>
      <div className="mt-2 flex items-center gap-2">
        <div className="n flex h-[48px] min-w-0 flex-1 items-center truncate rounded-[12px] border
                        border-line bg-panel2/80 px-4 text-[13.5px] backdrop-blur">
          {link.replace(/^https?:\/\//, "")}
        </div>
        <button type="button" onClick={onCopy} className={`${BTN} flex-none px-5`}>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <p className="mt-2.5 text-[12.5px] text-muted-foreground">
        They pay 10% less. You get 10% of what they pay, in USDC.
      </p>
    </div>
  );
}

/// Takes a code, checking as you type whether it is free.
function ClaimCode({ busy, onClaim }: { busy: boolean; onClaim: (code: string) => void }) {
  const [code, setCode] = useState("");
  const [state, setState] = useState<"idle" | "free" | "taken" | "invalid">("idle");
  useEffect(() => {
    if (!code) { setState("idle"); return; }
    if (!/^[a-z0-9_-]{3,16}$/.test(code)) { setState("invalid"); return; }
    let live = true;
    const t = setTimeout(() => {
      checkCode(code).then((c) => live && setState(c.owner ? "taken" : "free"),
        () => live && setState("idle"));
    }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [code]);

  const hint = {
    idle: "3 to 16 characters. Yours for good.",
    free: "Available.",
    taken: "Taken.",
    invalid: "Letters, numbers, _ and -. 3 to 16 characters.",
  }[state];

  return (
    <div>
      <div className={CAPS}>Referral code</div>
      <form className="mt-2 flex items-center gap-2"
        onSubmit={(e) => { e.preventDefault(); if (state === "free") onClaim(code); }}>
        <input value={code} maxLength={16} spellCheck={false} autoCapitalize="none"
          onChange={(e) => setCode(e.target.value.toLowerCase())}
          placeholder="yourname"
          className="n h-[48px] min-w-0 flex-1 rounded-[12px] border border-line bg-panel2/80 px-4
                     text-[14px] outline-none backdrop-blur focus:border-foreground/40" />
        <button type="submit" disabled={state !== "free" || busy} className={`${BTN} flex-none px-5`}>
          {busy ? "Claiming" : "Claim"}
        </button>
      </form>
      <p className={`mt-2.5 text-[12.5px] ${state === "taken" || state === "invalid"
        ? "text-down" : "text-muted-foreground"}`}>{hint}</p>
    </div>
  );
}
