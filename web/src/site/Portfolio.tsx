/*
 * Portfolio.
 *
 * Everything one wallet holds here, on one page: positions, the orders
 * waiting to fire, what it has in the pool and behind markets, and the fills
 * the server has settled for it. The trade screen shows one market at a time
 * and /earn one vault at a time; this is the page that adds them up.
 *
 * Every figure is read from the chain except the fill history, which the
 * program does not keep. The server records fills as it settles them, so the
 * history covers what it has settled since it last started and says so.
 *
 * Laid out as /rewards is: one split card with the totals, then a card per
 * table. `?wallet=` shows anyone's, read only, since it is all public anyway.
 */
import { useState, type ReactNode } from "react";
import "@/site/serif.css";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { Shell, SiteFooter, SiteHeader } from "@/site/Chrome";
import { WalletActions } from "@/components/WalletActions";
import { AnimatedNumber } from "@/components/motion/animated-number";
import * as api from "@/lib/api";
import {
  getAccount, getBackings, getFills, getRewards, peek, useHasBackend, usePoll,
  type Account, type Backing, type Position, type Rewards, type Trade,
} from "@/lib/api";
import { signAndSend } from "@/lib/tx";
import { money, price, tone } from "@/lib/format";

const BTN = "press h-[48px] rounded-full bg-foreground px-6 text-[14px] font-medium text-background " +
  "transition-opacity hover:opacity-90 disabled:pointer-events-none disabled:opacity-35";
const SMALL = "press h-8 rounded-full border border-line px-3.5 text-[12.5px] font-medium " +
  "transition-colors hover:border-foreground/40 disabled:pointer-events-none disabled:opacity-35";
const LINK = "underline decoration-line underline-offset-4 transition-colors hover:text-foreground";
const CAPS = "text-[11px] font-medium uppercase tracking-[.08em] text-muted-foreground";
const DASH = <span className="font-normal text-dim">–</span>;

const NO_BACKINGS: Backing[] = [];
const NO_FILLS: Trade[] = [];

const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;
/// A signed dollar figure, with the plus a gain needs to read as one.
const signed = (n: number) => (n > 0 ? "+" : "") + money(n);
const when = (t: number) => {
  const d = new Date(t);
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString("en-GB")
    : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
};

type Order = Account["orders"][number];
/// What an order is, in the words the ticket used to set it. Slot 0 is the
/// take profit and slot 1 the stop; a limit order rests in any slot above.
const orderKind = (o: Order) =>
  o.kind === 1 ? (o.isLong ? "Limit buy" : "Limit sell")
    : o.slot === 0 ? "Take profit" : "Stop loss";

export default function PortfolioPage() {
  const wallet = useWallet();
  const { setVisible } = useWalletModal();
  const connected = wallet.publicKey?.toBase58();
  const [viewing] = useState(() => {
    const w = new URLSearchParams(location.search).get("wallet");
    return w && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(w) ? w : null;
  });
  const owner = viewing ?? connected;
  const self = !viewing || viewing === connected;
  const testnet = useHasBackend() === true;

  // Nothing is read without a wallet. The server answers an ownerless
  // account request with its own demo account, which is not the visitor's.
  const [tick, setTick] = useState(0);
  const account = usePoll(() => owner ? getAccount(owner) : Promise.resolve(null), 5000, [owner, tick],
    () => (owner ? peek<Account>(`/api/account?owner=${owner}`) : null));
  const backingsRaw = usePoll(() => getBackings(owner), 10_000, [owner, tick]);
  const backings = backingsRaw ?? NO_BACKINGS;
  const rewards = usePoll<Rewards | null>(() => getRewards(owner), 15_000, [owner, tick]);
  const fillsRaw = usePoll(() => getFills(owner), 5000, [owner, tick]);
  const fills = fillsRaw ?? NO_FILLS;

  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const cancel = async (o: Order) => {
    const key = `${o.symbol}:${o.slot}`;
    setBusy(key); setNote(null);
    const res = await signAndSend(wallet, "order/cancel", { symbol: o.symbol, slot: o.slot });
    setBusy(null);
    setNote(res.ok ? null : res.error ?? "failed");
    if (res.ok) setTick((t) => t + 1);
  };

  const positions = account
    ? Object.entries(account.positions).map(([symbol, p]) => ({ symbol, ...p }))
    : [];
  const backed = backings.reduce((a, b) => a + b.value, 0);
  const posEquity = account ? account.margin + account.unrealized : 0;
  // What the wallet would have if it closed and withdrew everything now.
  // `equity` from the server already counts USDC, margin, PnL and xLP.
  const total = account ? account.equity + backed : 0;
  const ready = !!owner && !!account;
  const canAct = self && !!connected && testnet && !busy;
  const explorer = (address: string) =>
    `https://solscan.io/account/${address}${testnet ? "?cluster=devnet" : ""}`;

  return (
    <div className="site min-h-full">
      <SiteHeader here="/portfolio" actions={<WalletActions />} />

      <Shell className="pb-14 pt-4 sm:pt-8">
        <div className="grid overflow-hidden rounded-[24px] border border-line bg-panel
                        lg:grid-cols-[minmax(0,1fr)_440px]">
          <section className="relative min-h-[320px] overflow-hidden">
            {/* The same violet field /rewards carries, without the mark: this
                page is a statement, not a pitch. */}
            <img src="/waitlist/field.webp" alt="" aria-hidden
              className="pointer-events-none absolute inset-0 hidden h-full w-full object-cover
                         opacity-45 dark:block" />
            <div aria-hidden className="pointer-events-none absolute inset-0 bg-gradient-to-r
                                        from-panel via-panel/75 via-45% to-transparent to-70%" />

            <div className="relative flex h-full flex-col justify-center px-5 py-9
                            sm:max-w-[min(460px,60%)] sm:px-9">
              <h1 className="font-serif-display text-[clamp(3rem,6vw,4.5rem)] leading-none
                             tracking-[-.025em]">
                Portfolio
              </h1>
              <p className="mt-3.5 text-[15px] leading-[1.55] text-muted-foreground">
                Positions, orders, pool and backing for one wallet. Read from the chain.
              </p>

              <div className="mt-7">
                {!self ? (
                  <p className="text-[13px] text-muted-foreground">
                    Viewing{" "}
                    <a href={explorer(viewing!)} target="_blank" rel="noreferrer"
                      className="n font-medium text-foreground hover:underline">{short(viewing!)}</a>.
                    Only its owner can cancel.{" "}
                    <a href="/portfolio" className={LINK}>Yours</a>
                  </p>
                ) : !owner ? (
                  <button type="button" onClick={() => setVisible(true)} disabled={api.readOnly}
                    className={BTN}>
                    Connect wallet
                  </button>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    <a href="/trade" className={BTN + " inline-flex items-center"}>Trade</a>
                    <a href="/earn" className="press inline-flex h-[48px] items-center rounded-full border
                                                border-line px-6 text-[14px] font-medium transition-colors
                                                hover:border-foreground/40">
                      Earn
                    </a>
                  </div>
                )}
                {api.readOnly && (
                  <p className="mt-4 text-[12.5px] text-muted-foreground">
                    This deploy has no chain behind it, so there is nothing to read.
                  </p>
                )}
                {note && <p className="mt-3 text-[12.5px] text-down">{note}</p>}
              </div>
            </div>
          </section>

          <aside className="flex min-w-0 flex-col border-t border-line bg-panel2 px-5 py-7
                            sm:px-9 sm:py-9 lg:border-l lg:border-t-0">
            <div className={CAPS}>Account value</div>
            <div className="n mt-2 text-[40px] font-semibold leading-none tracking-[-.02em]">
              {ready ? <AnimatedNumber value={total} duration={0.9} format={(n) => money(n)} /> : DASH}
            </div>

            <div className="mt-5">
              <Stat k="Position equity">{ready ? money(posEquity) : DASH}</Stat>
              <Stat k="Unrealized PnL">
                {ready ? <span className={tone(account!.unrealized)}>{signed(account!.unrealized)}</span> : DASH}
              </Stat>
              <Stat k="Margin">{ready ? money(account!.margin) : DASH}</Stat>
              <Stat k="Available USDC">{ready ? money(account!.usdc) : DASH}</Stat>
              <Stat k="Pool (xLP)">{ready ? money(account!.lp.value) : DASH}</Stat>
              <Stat k="Backing">{ready ? money(backed) : DASH}</Stat>
              <Stat k="USDC to claim">{rewards ? money(rewards.claimable) : DASH}</Stat>
              <Stat k="Volume">{rewards ? money(rewards.volume, 0) : DASH}</Stat>
            </div>

            <div className="mt-auto pt-6">
              {rewards && rewards.claimable > 0 && self ? (
                <a href="/rewards" className={`${BTN} flex w-full items-center justify-center`}>
                  Claim on Rewards
                </a>
              ) : owner ? (
                <p className="text-center text-[12px] text-muted-foreground">
                  <a href={explorer(owner)} target="_blank" rel="noreferrer" className={LINK}>
                    Verify on Solscan
                  </a>
                </p>
              ) : null}
            </div>
          </aside>
        </div>

        <Positions rows={positions} owner={owner} loaded={ready} />
        <Orders orders={account?.orders ?? []} owner={owner} loaded={ready}
          canAct={canAct} busy={busy} onCancel={cancel} />
        {/* Each card waits only for what it reads. The account read is the
            slow one (a few round trips to the RPC), and holding the fills
            and backings behind it left every card blank for seconds. */}
        <Holdings account={account} backings={backings} rewards={rewards} owner={owner}
          loaded={!!owner && (!!account || backingsRaw !== null)} />
        <History fills={fills} account={account} owner={owner} loaded={!!owner && fillsRaw !== null} />
      </Shell>

      <SiteFooter />
    </div>
  );
}

/// One key and its figure, as /rewards writes them.
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

/// Three grey rows where a table will be, so a card that is still reading
/// looks like a table on its way rather than a sentence that never changes.
const Skeleton = () => (
  <div className="border-t border-line px-5 py-4 sm:px-7" aria-label="Loading">
    {[0.9, 0.7, 0.8].map((w, i) => (
      <div key={i} className="my-2.5 h-3 animate-pulse rounded-full bg-panel2"
        style={{ width: `${w * 100}%` }} />
    ))}
  </div>
);

const Empty = ({ children }: { children: ReactNode }) => (
  <p className="border-t border-line px-5 py-8 text-[13px] text-muted-foreground sm:px-7">{children}</p>
);

const Head = ({ children, cols }: { children: ReactNode; cols: string }) => (
  <div className={`${cols} border-t border-line px-5 py-2.5 sm:px-7 ${CAPS}`}>{children}</div>
);

const ROW = "border-t border-line px-5 py-3 text-[13.5px] sm:px-7";

/// Said once for every card when there is nothing to read yet.
const waiting = (owner?: string) =>
  owner ? "Loading." : "Connect a wallet to see yours.";

/// Side sits under the market on a phone and in its own column from md up,
/// so the row keeps to three columns where there is room for three.
const POS = "grid grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_minmax(0,1fr)] items-center gap-x-4 " +
  "md:grid-cols-[minmax(0,1fr)_64px_repeat(4,minmax(0,1fr))] " +
  "lg:grid-cols-[minmax(0,1fr)_64px_repeat(6,minmax(0,1fr))]";

function Positions({ rows, owner, loaded }: {
  rows: (Position & { symbol: string })[]; owner?: string; loaded: boolean;
}) {
  const pnl = rows.reduce((a, r) => a + r.pnl, 0);
  return (
    <Card title="Positions" aside={rows.length > 0 && (
      <span className="n text-[12.5px] text-muted-foreground">
        {rows.length} open · <span className={tone(pnl)}>{signed(pnl)}</span>
      </span>
    )}>
      {!loaded ? (owner ? <Skeleton /> : <Empty>{waiting(owner)}</Empty>) : rows.length === 0 ? (
        <Empty>No open positions.</Empty>
      ) : (
        <>
          <Head cols={POS}>
            <span>Market</span>
            <span className="hidden md:block">Side</span>
            <span>Size</span>
            <span className="hidden md:block">Entry</span>
            <span className="hidden md:block">Mark</span>
            <span className="text-right md:text-left">PnL</span>
            <span className="hidden lg:block">Liq. price</span>
            <span className="hidden lg:block">Margin</span>
          </Head>
          {rows.map((r) => (
            <a key={r.symbol} href={`/trade?symbol=${r.symbol}`}
              className={`${POS} ${ROW} hover:bg-panel2`}>
              <span className="min-w-0">
                <span className="block truncate font-medium">{r.symbol}</span>
                <span className="block text-[12px] text-muted-foreground md:hidden">
                  {r.isLong ? "Long" : "Short"} {r.leverage.toFixed(1)}x
                </span>
              </span>
              <span className="hidden text-muted-foreground md:block">{r.isLong ? "Long" : "Short"}</span>
              <span className="n">{money(r.size, 0)}</span>
              <span className="n hidden md:block">{price(r.entry)}</span>
              <span className="n hidden md:block">{price(r.mark)}</span>
              <span className={`n text-right md:text-left ${tone(r.pnl)}`}>
                {signed(r.pnl)}
                <span className="block text-[12px] md:inline md:pl-1.5">
                  {(r.pnlPct > 0 ? "+" : "") + r.pnlPct.toFixed(1)}%
                </span>
              </span>
              <span className="n hidden lg:block">{r.liqPrice ? price(r.liqPrice) : DASH}</span>
              <span className="n hidden lg:block">{money(r.collateral)}</span>
            </a>
          ))}
        </>
      )}
    </Card>
  );
}

const ORD = "grid grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_auto] items-center gap-x-4 " +
  "md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_88px]";

function Orders({ orders, owner, loaded, canAct, busy, onCancel }: {
  orders: Order[]; owner?: string; loaded: boolean; canAct: boolean;
  busy: string | null; onCancel: (o: Order) => void;
}) {
  return (
    <Card title="Orders" aside={orders.length > 0 && (
      <span className="n text-[12.5px] text-muted-foreground">{orders.length} standing</span>
    )}>
      {!loaded ? (owner ? <Skeleton /> : <Empty>{waiting(owner)}</Empty>) : orders.length === 0 ? (
        <Empty>No take profits, stops or limit orders.</Empty>
      ) : (
        <>
          <Head cols={ORD}>
            <span>Market</span>
            <span className="hidden md:block">Type</span>
            <span>Trigger</span>
            <span className="hidden md:block">Size</span>
            <span className="hidden md:block">Margin</span>
            <span />
          </Head>
          {orders.map((o) => {
            const key = `${o.symbol}:${o.slot}`;
            return (
              <div key={o.address} className={`${ORD} ${ROW}`}>
                <a href={`/trade?symbol=${o.symbol}`} className="min-w-0 hover:underline">
                  <span className="block truncate font-medium">{o.symbol}</span>
                  <span className="block text-[12px] text-muted-foreground md:hidden">{orderKind(o)}</span>
                </a>
                <span className="hidden text-muted-foreground md:block">{orderKind(o)}</span>
                <span className="n">
                  {o.triggerAbove ? "≥ " : "≤ "}{price(o.triggerPrice)}
                </span>
                {/* A take profit or stop with no size closes the whole position. */}
                <span className="n hidden md:block">
                  {o.sizeUsd > 0 ? money(o.sizeUsd, 0) : <span className="text-muted-foreground">All</span>}
                </span>
                <span className="n hidden md:block">{o.collateralUsd > 0 ? money(o.collateralUsd) : DASH}</span>
                <span className="text-right">
                  {canAct || busy === key ? (
                    <button type="button" disabled={!!busy} onClick={() => onCancel(o)} className={SMALL}>
                      {busy === key ? "Cancelling" : "Cancel"}
                    </button>
                  ) : null}
                </span>
              </div>
            );
          })}
        </>
      )}
    </Card>
  );
}

const HOLD = "grid grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1fr)] items-center gap-x-4 " +
  "md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)]";

/// The pool and every market's backing, in one table: both are capital this
/// wallet has lent the venue, and /earn is where either is changed.
function Holdings({ account, backings, rewards, owner, loaded }: {
  account: Account | null; backings: Backing[]; rewards: Rewards | null;
  owner?: string; loaded: boolean;
}) {
  const lp = account?.lp;
  // What the xLP cost, as the program records it for tokens this wallet
  // minted. Tokens bought elsewhere have no cost here, so it is left blank
  // rather than shown as a gain.
  const lpCost = rewards?.exists && rewards.lp > 0 ? rewards.lp : null;
  const rows: { key: string; name: string; sub: string; value: number; deposited: number | null;
                status: string }[] = [];
  if (lp && lp.held > 0) {
    rows.push({ key: "pool", name: "Pool", sub: `${lp.held.toLocaleString(undefined,
      { maximumFractionDigits: 2 })} xLP at ${price(lp.price)}`,
      value: lp.value, deposited: lpCost, status: "Every market" });
  }
  for (const b of backings) {
    rows.push({ key: b.symbol, name: b.symbol, sub: "Backing", value: b.value, deposited: b.deposited,
      status: b.opening ? "Opening" : b.tradeable ? "Live" : "Waiting" });
  }
  const sum = rows.reduce((a, r) => a + r.value, 0);

  return (
    <Card title="Pool and backing" aside={rows.length > 0 && (
      <span className="n text-[12.5px] text-muted-foreground">{money(sum)}</span>
    )}>
      {!loaded ? (owner ? <Skeleton /> : <Empty>{waiting(owner)}</Empty>) : rows.length === 0 ? (
        <Empty>Nothing in the pool or behind a market. <a href="/earn" className={LINK}>Earn</a></Empty>
      ) : (
        <>
          <Head cols={HOLD}>
            <span>Vault</span>
            <span>Value</span>
            <span className="hidden md:block">Deposited</span>
            <span className="text-right md:text-left">Change</span>
            <span className="hidden md:block">Status</span>
          </Head>
          {rows.map((r) => {
            const change = r.deposited == null ? null : r.value - r.deposited;
            return (
              <a key={r.key} href="/earn" className={`${HOLD} ${ROW} hover:bg-panel2`}>
                <span className="min-w-0">
                  <span className="block truncate font-medium">{r.name}</span>
                  <span className="block truncate text-[12px] text-muted-foreground">{r.sub}</span>
                </span>
                <span className="n">{money(r.value)}</span>
                <span className="n hidden md:block">{r.deposited == null ? DASH : money(r.deposited)}</span>
                <span className={`n text-right md:text-left ${change == null ? "" : tone(change)}`}>
                  {change == null ? DASH : signed(change)}
                </span>
                <span className="hidden text-muted-foreground md:block">{r.status}</span>
              </a>
            );
          })}
        </>
      )}
    </Card>
  );
}

const HIST = "grid grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1fr)] items-center gap-x-4 " +
  "md:grid-cols-[90px_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)]";

const ACTION: Record<string, string> = {
  open: "Open", close: "Close", liquidation: "Liquidated", trigger: "Trigger fired", expired: "Expired",
};

/// Settled fills, liquidations and the take profits and stops that fired,
/// merged into one list, newest first.
function History({ fills, account, owner, loaded }: {
  fills: Trade[]; account: Account | null; owner?: string; loaded: boolean;
}) {
  // Fired triggers come from the account's shared list, which carries every
  // wallet's; only this one's belong here.
  const fired = (account?.orderFills ?? []).filter((f) => f.owner === owner).map((f) => ({
    t: f.t, symbol: f.symbol, kind: f.expired ? "expired" : "trigger",
    side: null as "buy" | "sell" | null, size: null as number | null, price: f.price,
  }));
  const rows = [...fills.map((f) => ({ ...f, side: f.side as "buy" | "sell" | null,
    size: f.size as number | null })), ...fired].sort((a, b) => b.t - a.t);

  return (
    <Card title="History">
      {!loaded ? (owner ? <Skeleton /> : <Empty>{waiting(owner)}</Empty>) : rows.length === 0 ? (
        <Empty>No fills since the server last started.</Empty>
      ) : (
        <>
          <Head cols={HIST}>
            <span className="hidden md:block">Time</span>
            <span>Market</span>
            <span className="hidden md:block">Action</span>
            <span className="hidden md:block">Side</span>
            <span>Size</span>
            <span className="text-right md:text-left">Price</span>
          </Head>
          {rows.map((r, i) => (
            <div key={`${r.t}-${i}`} className={`${HIST} ${ROW}`}>
              <span className="n hidden text-muted-foreground md:block">{when(r.t)}</span>
              <span className="min-w-0">
                <span className="block truncate font-medium">{r.symbol}</span>
                <span className="block truncate text-[12px] text-muted-foreground md:hidden">
                  {ACTION[r.kind] ?? r.kind}{r.side ? ` ${r.side}` : ""} · {when(r.t)}
                </span>
              </span>
              <span className="hidden text-muted-foreground md:block">{ACTION[r.kind] ?? r.kind}</span>
              <span className="hidden capitalize text-muted-foreground md:block">{r.side ?? DASH}</span>
              <span className="n">{r.size == null ? DASH : money(r.size, 0)}</span>
              <span className="n text-right md:text-left">{price(r.price)}</span>
            </div>
          ))}
        </>
      )}
      {loaded && (
        <p className="border-t border-line px-5 py-4 text-[12.5px] text-muted-foreground sm:px-7">
          The chain keeps positions, not a fill log. This is what the server has settled for
          this wallet since it last started, up to 50.
        </p>
      )}
    </Card>
  );
}
