import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatedToastStack, useAnimatedToastStack } from "@/components/motion/animated-toast-stack";
import { Nav } from "@/components/Nav";
import { MarketHeader } from "@/components/MarketHeader";
import { MarketPalette } from "@/components/MarketPalette";
import { Chart } from "@/components/Chart";
import { ChartPanel } from "@/components/chart/ChartPanel";
import { BookPanel } from "@/components/BookPanel";
import { AccountPanel, OrderTicket } from "@/components/OrderTicket";
import { MarketList } from "@/components/MarketList";
import { StatusBar } from "@/components/StatusBar";
import { BottomPanel } from "@/components/BottomPanel";
import { Sheet } from "@/components/Sheet";
import { MobileBars, type MobileView } from "@/components/MobileBars";
import { MobileMarketPane } from "@/components/MobileMarketPane";
import { useIsMobile, useMediaQuery } from "@/lib/media";
import { ReadOnlyNotice } from "@/components/ReadOnlyNotice";
import { SiteFooter, SiteHeader } from "@/site/Chrome";
import { WalletActions } from "@/components/WalletActions";
import { Box } from "@/components/market/Box";
import { Tabs, TabsList, TabsTrigger } from "@/components/Tabs";
import * as api from "@/lib/api";
import { useWallet } from "@solana/wallet-adapter-react";
import { getAccount, getBatch, getMarkets, getTrades, peek, post, usePoll } from "@/lib/api";
import { signAndSend } from "@/lib/tx";
import type { Account, Batch, Market, Trade } from "@/lib/api";
import { money } from "@/lib/format";

/// Only timeframes the price source actually carries. Jupiter publishes no
/// sub-minute bars at all, so 5s/15s had nothing behind them but this process's
/// own uptime.
const TFS = [
  { v: 60, l: "1m" }, { v: 300, l: "5m" }, { v: 900, l: "15m" },
];

/// Closing is an order like any other now, and saying "Closed" the moment one
/// is accepted would be the same small lie as telling someone they are long
/// while they are still queued.
const CLOSE_NOTE = "Exits clear in the next batch, same price as entries.";

export default function App() {
  // A link from the landing page names the market it was clicked on.
  const [symbol, setSymbol] = useState<string | null>(
    () => new URLSearchParams(window.location.search).get("symbol"));
  const [tf, setTf] = useState(300);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const isMobile = useIsMobile();
  // The fixed terminal needs the width for four columns; between the phone
  // and this, the same panels stack on a page that scrolls.
  const isWide = useMediaQuery("(min-width: 1024px)");
  const [view, setView] = useState<MobileView>("chart");
  const [ticketOpen, setTicketOpen] = useState(false);
  const [side, setSide] = useState<"long" | "short">("long");
  const [busy, setBusy] = useState(false);
  const [trades, setTrades] = useState<Trade[]>([]);
  const seenLiqs = useRef(0);

  const wallet = useWallet();
  const owner = wallet.publicKey?.toBase58();

  // Each read starts from the browser's last copy of it (see `peek`), so the
  // terminal draws real prices the instant it opens and the network only
  // freshens them.
  const polled = usePoll(getMarkets, 900, [], () => peek<Market[]>("/api/markets"));
  const markets = polled ?? [];
  // Each answer is a fresh array, so a change of reference is a poll that
  // came back: the status bar's liveness, without a request of its own.
  const [lastOk, setLastOk] = useState(0);
  useEffect(() => { if (polled) setLastOk(Date.now()); }, [polled]);
  const readOnly = markets.length > 0 && api.readOnly;
  const [accountTick, setAccountTick] = useState(0);
  // Follows the connected wallet, falling back to the demo account when there
  // is none: the view is always of whoever is actually trading.
  const account = usePoll(() => getAccount(owner), 1800, [accountTick, owner],
    () => peek<Account>("/api/account" + (owner ? `?owner=${owner}` : "")));

  // Twice a second against a one-second window: fast enough that the book is
  // at most half a batch behind, and the countdown between polls is interpolated from
  // the chain's own deadline rather than from this interval.
  const batch = usePoll(() => (symbol ? getBatch(symbol) : Promise.resolve(null)), 500, [symbol],
    () => (symbol ? peek<Batch>(`/api/batch/${symbol}`) : null));

  const market = useMemo(
    () => markets.find((m) => m.symbol === symbol) ?? markets[0],
    [markets, symbol]
  );

  // Also corrects a symbol that came in off a link and does not exist.
  useEffect(() => {
    if (markets.length && !markets.some((m) => m.symbol === symbol)) setSymbol(markets[0].symbol);
  }, [markets, symbol]);

  useEffect(() => {
    if (!market) return;
    let alive = true;
    setTrades(peek<Trade[]>(`/api/trades/${market.symbol}`) ?? []);
    const run = async () => {
      try { const t = await getTrades(market.symbol); if (alive) setTrades(t); } catch {}
    };
    run();
    const id = setInterval(run, 2500);
    return () => { alive = false; clearInterval(id); };
  }, [market?.symbol]);

  // The library owns toast ids, timers and dismissal; we only raise events.
  const { toasts, showToast, dismissToast } = useAnimatedToastStack({ limit: 4 });

  // A liquidation is the one event the trader did not initiate, so it is the one
  // that has to interrupt them.
  useEffect(() => {
    const n = account?.liquidations.length ?? 0;
    if (n > seenLiqs.current) {
      const l = account!.liquidations[0];
      showToast({
        title: "Position liquidated",
        description: `${l.symbol} ${l.isLong ? "long" : "short"} at ${l.price.toFixed(2)} · ${money(l.returned)} returned`,
        status: "error",
      });
      seenLiqs.current = n;
    }
  }, [account?.liquidations.length, showToast]);

  /// One entry point for both paths: a connected wallet signs the transaction
  /// itself, and without one the server signs with the demo keypair.
  const act = useCallback(async (
    path: string,
    body: Record<string, unknown>,
    ok: string,
    record?: { symbol: string; side: "buy" | "sell"; size: number; kind: string },
    /// Shown under the confirmation. For anything that is accepted now and
    /// resolves later, which an auction order always is.
    note?: string
  ) => {
    setBusy(true);
    try {
      const r = wallet.publicKey
        ? await signAndSend(wallet, path.replace(/^\//, ""), body, record)
        : await post(path, body);
      showToast(r.ok
        ? { title: ok, description: note, status: "success" }
        : { title: "Rejected", description: r.error, status: "error" });
    } catch (e) {
      showToast({ title: "Network error", description: String(e), status: "error" });
    } finally {
      setBusy(false);
      setAccountTick((t) => t + 1);
    }
  }, [showToast, wallet]);

  /// Funds a freshly connected wallet with test USDC, and SOL when it has
  /// too little for fees. The server says how much, since it differs by
  /// cluster and the testnet caps the SOL.
  const fund = useCallback(async () => {
    if (!owner) return;
    setBusy(true);
    try {
      const r = await post("/faucet", { owner }) as { ok: boolean; error?: string; usdc?: number; sol?: number };
      showToast(r.ok
        ? {
            title: "Funded",
            description: `${(r.usdc ?? 0).toLocaleString()} test USDC` + (r.sol ? ` and ${r.sol} SOL` : ""),
            status: "success",
          }
        : { title: "Faucet failed", description: r.error, status: "error" });
    } finally {
      setBusy(false);
      setAccountTick((t) => t + 1);
    }
  }, [owner, showToast]);

  /*
   * Before the first market list lands, draw the terminal's shape rather
   * than a blank screen: the real header, then grey panes where the list,
   * chart, book, ticket and positions will be. A blank page reading
   * "Connecting" was the slowest-feeling second of the whole app, and the
   * layout is known before any data is.
   */
  if (!market) return <TradeSkeleton wide={isWide} />;

  const ticket = (
    <OrderTicket
          onLimit={(a) => act("/order/trigger",
            { symbol: market.symbol, kind: "limit", ...a },
            `Limit ${a.isLong ? "buy" : "sell"} ${money(a.size, 0)} at ${a.triggerPrice}`)}
          onTrigger={(t) => act("/order/trigger",
            { symbol: market.symbol, ...t }, `${t.kind === "tp" ? "Take profit" : "Stop"} set at ${t.triggerPrice}`)}
          onCancelTrigger={(slot) => act("/order/cancel",
            { symbol: market.symbol, slot }, "Order cancelled")}
          onReduce={({ size }) => act("/close", { symbol: market.symbol, size },
            `Reduce ${market.symbol} by ${money(size, 0)} queued`,
            undefined,
            "Exits clear in the next batch, same price as entries.")}
          onMaker={(a) => act("/order", { symbol: market.symbol, ...a },
            `Maker ${a.isLong ? "buy" : "sell"} ${money(a.size, 0)} at ${a.price} posted`,
            undefined, "Rests this batch. Unfilled, the margin comes back.")}
          onFund={owner ? fund : undefined}
      m={market} account={account} busy={busy || readOnly} mobile={isMobile}
      card={!isMobile}
      side={isMobile ? side : undefined}
      onSideChange={isMobile ? setSide : undefined}
      onOrder={({ isLong, size, collateral }) => {
        setTicketOpen(false);
        // An order is not a fill. It rests in the market's batch until that
        // batch clears, so the confirmation says what actually happened --
        // telling someone they are long when they are queued is the kind of
        // small lie that costs trust the first time a batch does not cross.
        act("/order", { symbol: market.symbol, isLong, size, collateral },
          `${isLong ? "Buy" : "Sell"} ${money(size, 0)} ${market.symbol} queued`,
          undefined,
          market.observed && !market.observed.seasoned
            ? "Clears in the opening auction."
            : "Fills in the next batch, within a second.");
      }}
      /* The pool is Earn's job on a wide screen, where the rail links to it.
         The phone's account pane keeps its deposit as it was. */
      onPool={isMobile ? (kind, amount) =>
        act(`/${kind}`, { amount }, kind === "deposit" ? "Deposited to pool" : "Withdrew from pool")
        : undefined}
    />
  );

  const nav = <Nav />;

  const overlays = (
    <>
      <MarketPalette markets={markets} open={paletteOpen} onOpenChange={setPaletteOpen}
        onSelect={(s) => { setSymbol(s); setPaletteOpen(false); }} />
      <AnimatedToastStack toasts={toasts} onDismiss={dismissToast}
        position={isMobile ? "top-center" : "bottom-right"} placement="fixed" />
    </>
  );

  /*
   * The phone layout is a different tree, not the desktop one with columns
   * hidden. Three panes cannot share 375px, so they become tabs; the order
   * ticket has no column to live in, so it becomes a sheet raised by the
   * Buy/Sell bar. Only the active pane is mounted, which also keeps the chart
   * from auto-sizing itself against a hidden, zero-height box.
   */
  if (isMobile) {
    const positionCount = Object.keys(account?.positions ?? {}).length;
    return (
      <div className="flex h-full flex-col overflow-hidden">
        {nav}
        {readOnly && <ReadOnlyNotice />}
        <MarketHeader m={market} onOpen={() => setPaletteOpen(true)} mobile batch={batch} />

        <div className="flex min-h-0 flex-1 flex-col">
          {view === "chart" && (
            <>
              {/* Timeframes on the left, the index they are drawn from on the
                  right. No fill prices off it any more -- a batch's clearing
                  price does -- but it is still what the pool anchors its quote
                  to, so it is the reference worth keeping in view. */}
              <div className="flex flex-none items-center justify-between border-b
                              border-line bg-panel px-4 py-2.5">
                <Tabs value={String(tf)} onValueChange={(v) => setTf(Number(v))}>
                  <TabsList>
                    {TFS.map((t) => (
                      <TabsTrigger key={t.v} value={String(t.v)}>{t.l}</TabsTrigger>
                    ))}
                  </TabsList>
                </Tabs>
                <span className="text-[12px] text-muted-foreground">
                  Reference <span className="n text-foreground">{market.price.toFixed(2)}</span>
                </span>
              </div>
              <Chart symbol={market.symbol} price={market.price} tf={tf} compact
                position={account?.positions[market.symbol]} />
            </>
          )}
          {view === "book" && (
            <MobileMarketPane m={market} trades={trades}
              utilization={account?.pool.utilization} />
          )}
          {view === "positions" && (
            <BottomPanel account={account} trades={trades} busy={busy} mobile
              onClose={(s) => act("/close", { symbol: s }, `Close ${s} queued`,
                undefined, CLOSE_NOTE)} />
          )}
          {view === "account" && (
            <div className="pane-scroll min-h-0 flex-1">{ticket}</div>
          )}
        </div>

        <MobileBars view={view} onView={setView} m={market} positions={positionCount}
          showTrade={view !== "account" && !readOnly}
          onTrade={(s) => { setSide(s); setTicketOpen(true); }} />

        <Sheet open={ticketOpen} onOpenChange={setTicketOpen}
          title={`${side === "long" ? "Buy / Long" : "Sell / Short"} ${market.symbol}`}>
          {ticket}
        </Sheet>

        {overlays}
      </div>
    );
  }

  const onCloseAll = (s: string) => act("/close", { symbol: s }, `Close ${s} queued`,
    undefined, CLOSE_NOTE);
  const positions = (
    <BottomPanel account={account} trades={trades} busy={busy} docked={isWide}
      markets={markets} market={market} owner={owner}
      onClose={onCloseAll}
      onCancelOrder={(o) => act("/order/cancel", { symbol: o.symbol, slot: o.slot },
        "Order cancelled")} />
  );
  const chart = (
    <ChartPanel market={market} tf={tf} onTf={setTf} account={account} batch={batch} />
  );
  const book = (
    <BookPanel m={market} trades={trades} utilization={account?.pool.utilization}
      batch={batch} narrow={isWide} />
  );
  const accountBox = account && (
    <Box title="Account">
      <AccountPanel account={account} compact />
    </Box>
  );
  const header = (
    <SiteHeader here="/trade" actions={<WalletActions />} />
  );
  // Panes divided by hairlines, the way a terminal is ruled: the gap between
  // them shows the line colour behind, and nothing has a corner. Rounded
  // panes a seam apart left a notch of page wherever four corners met.
  const PANE = "min-h-0 overflow-hidden bg-panel";

  if (isWide) {
    return (
      /*
       * The terminal: one fixed screen, every pane scrolling inside itself.
       *
       * Market list, then the market (its header row, the chart with the
       * batch beside it, positions docked under both), then the ticket and
       * the account in the rail. At 1440x900 the chart, the book, the ticket
       * and the top of the positions table are all above the fold, which is
       * the whole reason for giving up the scrolling page on a wide screen:
       * a trader should not scroll to find out what they hold.
       */
      <div className="flex h-full flex-col overflow-hidden bg-background">
        <div className="relative z-30 flex-none">
          {header}
          {readOnly && <ReadOnlyNotice />}
        </div>

        <main className="flex min-h-0 flex-1 gap-px border-t border-line bg-line">
          {/* The list needs a column of its own. Under 1280px that column
              comes out of the chart, so the list waits for a wider window
              and the header's switcher and the palette do its job. */}
          <div className="hidden xl:contents">
            <MarketList markets={markets} current={market.symbol} onPick={setSymbol}
              onPalette={() => setPaletteOpen(true)} />
          </div>

          <div className="flex min-w-0 flex-1 flex-col gap-px">
            <div className="flex-none overflow-hidden bg-panel">
              <MarketHeader m={market} onOpen={() => setPaletteOpen(true)} batch={batch} />
            </div>
            <div className="flex min-h-0 flex-1 gap-px">
              <section className={`${PANE} flex min-w-0 flex-1 flex-col px-3 pt-2.5 pb-2`}>
                {chart}
              </section>
              <section className={`${PANE} flex w-[280px] flex-none flex-col xl:w-[300px] 2xl:w-[340px]`}>
                {book}
              </section>
            </div>
            {/* A fixed share of the height rather than of the rows: it is
                docked, and a table that grew with its rows would move the
                chart every time a position opened. */}
            <section className={`${PANE} flex h-[clamp(190px,28vh,320px)] flex-none flex-col`}>
              {positions}
            </section>
          </div>

          {/* The rail scrolls as one column; the ticket and the account keep
              their own heights inside it rather than being squeezed to fit. */}
          <aside className="pane-scroll relative flex w-[300px] flex-none flex-col gap-px xl:w-[340px]
                            [&>*]:flex-none">
            {ticket}
            {accountBox}
            {/* The rest of the rail is an empty panel rather than bare page,
                so the column ends level with the positions beside it. */}
            <div aria-hidden className="min-h-0 !flex-1 bg-panel" />
          </aside>
        </main>

        <StatusBar lastOk={lastOk} readOnly={readOnly} cluster={account?.cluster} />
        {overlays}
      </div>
    );
  }

  /*
   * Between the phone and the terminal: the same panels, stacked on a page
   * that scrolls, with the ticket beside the chart. `site` releases the
   * document's scroll lock, which the terminal holds.
   */
  return (
    <div className="site flex min-h-full flex-col bg-background">
      <div className="relative z-30">
        {header}
        {readOnly && <ReadOnlyNotice />}
      </div>
      <main className="flex flex-1 flex-col gap-px border-y border-line bg-line">
        <div className="overflow-hidden bg-panel">
          <MarketHeader m={market} onOpen={() => setPaletteOpen(true)} batch={batch} />
        </div>
        <div className="flex gap-px">
          <section className={`${PANE} flex min-h-[460px] min-w-0 flex-1 flex-col px-3 pt-2.5 pb-2`}>
            {chart}
          </section>
          {/* The ticket alone beside the chart, which stretches to its
              height; the account goes under the positions it sums up. */}
          <aside className="flex w-[320px] flex-none flex-col">{ticket}</aside>
        </div>
        <section className={`${PANE} flex min-h-[260px] flex-col`}>{book}</section>
        <section className={PANE}>{positions}</section>
        {accountBox}
      </main>
      <StatusBar lastOk={lastOk} readOnly={readOnly} cluster={account?.cluster} />
      <SiteFooter tradeHref="/trade" />
      {overlays}
    </div>
  );
}

/// Grey panes in the terminal's layout, shown for the second before the
/// first market list arrives.
function TradeSkeleton({ wide }: { wide: boolean }) {
  const pane = "bg-panel";
  const bar = (w: string) => <div className={`h-3 animate-pulse rounded-full bg-panel2 ${w}`} />;
  if (!wide) {
    return (
      <div className="flex h-full flex-col gap-px bg-background">
        <div className={`${pane} flex h-[70px] flex-none items-center gap-3 px-4`}>{bar("w-24")}</div>
        <div className={`${pane} flex-1 animate-pulse`} />
        <div className={`${pane} h-[72px] flex-none`} />
      </div>
    );
  }
  return (
    <div className="flex h-full flex-col overflow-hidden bg-background" aria-busy="true">
      <SiteHeader here="/trade" actions={<WalletActions />} />
      <main className="flex min-h-0 flex-1 gap-px border-t border-line bg-line">
        <div className={`${pane} hidden w-[248px] flex-none flex-col gap-3 p-4 lg:flex 2xl:w-[272px]`}>
          {bar("w-full")}{bar("w-2/3")}{bar("w-5/6")}{bar("w-3/4")}
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-px">
          <div className={`${pane} flex h-[60px] flex-none items-center gap-6 px-4`}>
            {bar("w-28")}{bar("w-16")}{bar("w-16")}{bar("w-16")}
          </div>
          <div className="flex min-h-0 flex-1 gap-px">
            <div className={`${pane} flex-1 animate-pulse`} />
            <div className={`${pane} w-[300px] flex-none`} />
          </div>
          <div className={`${pane} h-[clamp(190px,28vh,320px)] flex-none`} />
        </div>
        <div className={`${pane} flex w-[320px] flex-none flex-col gap-4 p-4 xl:w-[340px]`}>
          {bar("w-1/2")}{bar("w-full")}{bar("w-full")}{bar("w-3/4")}
        </div>
      </main>
      <div className="h-7 flex-none" />
    </div>
  );
}

