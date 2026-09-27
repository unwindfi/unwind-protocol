/*
 * Opening a market.
 *
 * It starts from a token, because that is what people arrive with. The old
 * page asked for a Raydium pool address first, which almost nobody has to
 * hand, and on the deployed site it could not even read one -- so the first
 * thing every visitor did was the thing that failed.
 *
 * Now: type a ticker, a name or a mint. The page finds every USD pool that
 * token has on the venues the program can read, picks the deepest, and reads
 * it from the chain. What remains is one decision with a sensible default
 * (how big the market may get, under Advanced) and one optional act (backing
 * it). The preview beside it is the market as it will list, every figure one
 * the program will hold.
 *
 * Search, pools and the preview all work without a chain server. Only the
 * signature needs one, and the button says so rather than failing.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import "@/site/serif.css";
import {
  ArrowUpRight, BadgeCheck, ChevronDown, Loader2, Search, X,
} from "lucide-react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import {
  DOCS, PILL_INDICATOR, PILL_LIST, PILL_TRIGGER, Shell, SiteFooter, SiteHeader,
} from "@/site/Chrome";
import { PayToken } from "@/components/PayToken";
import { Mark } from "@/components/Brand";
import { RangeSlider } from "@/components/motion/range-slider";
import { Tabs, TabsList, TabsTrigger } from "@/components/motion/tabs";
import { Checkbox } from "@/components/motion/checkbox";
import { AnimatedNumber } from "@/components/motion/animated-number";
import { WalletActions } from "@/components/WalletActions";
import { Ripeness, statusOf } from "@/components/Ripeness";
import {
  canSign, getMarkets, getPool, getTestnetPools, usePoll, type Market, type PoolPreview,
  type TestnetPool,
} from "@/lib/api";
import {
  DEX_NAME, PAY_TOKENS, byDepth, looksLikeAddress, poolSources, prefetchPools, searchTokens, usdPrices,
  type PayWith, type PoolOption, type TokenHit,
} from "@/lib/listing";
import { signAndSend } from "@/lib/tx";
import { compact, money, price } from "@/lib/format";
import {
  listingLimits, LISTING_ROUND_TRIP_FEE_BPS, MIN_LISTING_BACKING_USD, POOL_QUOTE_BUDGET_BPS,
  TESTNET_LISTING_BACKING_USD,
} from "@scripts/listing-policy";

const NONE: Market[] = [];

const FIELD =
  "w-full rounded-[10px] border border-line bg-panel2 px-3.5 text-[13.5px] outline-none " +
  "transition-colors placeholder:text-dim focus:border-brand";

/// Round numbers for a listing's backing. Smaller than a backer's, because
/// the lister is opening the door, not underwriting the whole room.
const LIST_QUICK: Record<PayWith, number[]> = {
  USDC: [100, 500, 1_000], USDT: [100, 500, 1_000], SOL: [1, 5, 10],
};

const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;
const unitWords = (e: number) =>
  ({ 3: "1,000", 6: "1,000,000", 9: "1,000,000,000" } as Record<number, string>)[e] ?? `10^${e}`;

/// The URL keeps the token and pool, so a listing in progress can be linked.
function remember(token: string | null, pool: string | null) {
  const q = new URLSearchParams(location.search);
  token ? q.set("token", token) : q.delete("token");
  pool ? q.set("pool", pool) : q.delete("pool");
  const s = q.toString();
  history.replaceState(null, "", location.pathname + (s ? `?${s}` : ""));
}

/// A group of related fields under a label set into its border, the way a
/// paper form groups them.
function Fieldset({ legend, aside, locked, children }: {
  legend: string; aside?: ReactNode; locked?: boolean; children: ReactNode;
}) {
  return (
    <fieldset inert={locked || undefined}
      className={`min-w-0 rounded-[16px] border border-line px-4 pb-4 pt-2 transition-opacity
                  duration-200 ${locked ? "opacity-55 saturate-0" : ""}`}>
      <legend className="px-1.5 text-[13px] text-foreground">{legend}</legend>
      {aside && <div className="-mt-1 mb-2 text-right text-[11.5px] text-dim">{aside}</div>}
      {children}
    </fieldset>
  );
}

const Label = ({ children, htmlFor }: { children: ReactNode; htmlFor?: string }) => (
  <label htmlFor={htmlFor} className="mb-2 block text-[13px] text-foreground">{children}</label>
);

/// A section that stays folded until asked for, labelled in small caps.
function Fold({ label, open, onToggle, children }: {
  label: string; open: boolean; onToggle: () => void; children: ReactNode;
}) {
  return (
    <div>
      <button type="button" onClick={onToggle} aria-expanded={open}
        className="flex items-center gap-1.5 text-[11px] uppercase tracking-[.12em] text-dim
                   transition-colors hover:text-foreground">
        {label}
        <ChevronDown size={13} className={`transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && <div className="mt-4">{children}</div>}
    </div>
  );
}

/// The token's own art, over its initial. The initial is always drawn, so a
/// slow or dead image host shows a letter rather than an empty circle.
function TokenIcon({ src, label, size = 32 }: { src?: string | null; label: string; size?: number }) {
  const [state, setState] = useState<"loading" | "ok" | "broken">("loading");
  useEffect(() => setState("loading"), [src]);
  return (
    <span className="relative grid flex-none place-items-center overflow-hidden rounded-full
                     bg-panel3 font-semibold text-muted-foreground"
      style={{ width: size, height: size, fontSize: size * 0.4 }}>
      {(label[0] ?? "?").toUpperCase()}
      {src && state !== "broken" && (
        <img src={src} alt="" decoding="async" onLoad={() => setState("ok")}
          onError={() => setState("broken")}
          className={`absolute inset-0 size-full object-cover transition-opacity duration-200 ${
            state === "ok" ? "opacity-100" : "opacity-0"}`} />
      )}
    </span>
  );
}

/// One limit: the figure, over a slider whose far end is the pool's ceiling.
function Limit({ label, display, value, min, max, step, onChange, lo, hi, text }: {
  label: string; display: string; value: number; min: number; max: number; step: number;
  onChange: (v: number) => void; lo: string; hi: string; text: (v: number) => string;
}) {
  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <span className="text-[12.5px] text-muted-foreground">{label}</span>
        <span className="n text-[18px] font-medium leading-none">{display}</span>
      </div>
      <RangeSlider value={value} min={min} max={max} step={step} onValueChange={onChange}
        showTicks={(max - min) / step <= 12} aria-label={label} formatValueText={text} />
      <div className="n mt-2 flex justify-between text-[11px] text-dim">
        <span>{lo}</span><span>{hi} · set by depth</span>
      </div>
    </div>
  );
}

const Stat = ({ k, children, tone = "", hint }: {
  k: string; children: ReactNode; tone?: string; hint?: string;
}) => (
  <div className="flex items-baseline justify-between gap-4 border-t border-line py-3"
    title={hint}>
    <span className="flex-none text-[12.5px] text-muted-foreground">{k}</span>
    <span className={`n truncate text-right text-[12.5px] font-semibold ${tone}`}>{children}</span>
  </div>
);

export default function List() {
  const wallet = useWallet();
  const { setVisible } = useWalletModal();
  const input = useRef<HTMLInputElement>(null);

  // ------------------------------------------------------------ search
  const [query, setQuery] = useState("");
  const [testnetPools, setTestnetPools] = useState<TestnetPool[]>([]);
  const [seed, setSeed] = useState(String(MIN_LISTING_BACKING_USD));
  useEffect(() => {
    void getTestnetPools().then((p) => {
      setTestnetPools(p);
      // Only while the field still holds the default: never over a number
      // somebody typed.
      if (p.length) {
        setSeed((s) => s === String(MIN_LISTING_BACKING_USD) ? String(TESTNET_LISTING_BACKING_USD) : s);
      }
    });
  }, []);
  const defaultBacking = testnetPools.length ? TESTNET_LISTING_BACKING_USD : MIN_LISTING_BACKING_USD;
  const unlisted = testnetPools.filter((p) => !p.listed);
  const [hits, setHits] = useState<TokenHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchErr, setSearchErr] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);

  // ------------------------------------------------------- token, pool
  const [token, setToken] = useState<TokenHit | null>(null);
  const [pools, setPools] = useState<PoolOption[] | null>(null);
  const [poolsErr, setPoolsErr] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [preview, setPreview] = useState<PoolPreview | null>(null);
  const [previewErr, setPreviewErr] = useState<string | null>(null);
  /// A pool the testnet seeded lives on devnet; everything else on mainnet.
  const onDevnet = !!preview && testnetPools.some((p) => p.pool === preview.address);
  const [reading, setReading] = useState(false);

  // ------------------------------------------------------ the listing
  const [tab, setTab] = useState<"list" | "back">("list");
  const [advanced, setAdvanced] = useState(false);
  /// The lister says, before signing, that they know what backing does.
  const [ack, setAck] = useState(false);
  const [leverage, setLeverage] = useState<number | null>(null);
  const [size, setSize] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [signable, setSignable] = useState<boolean | null>(null);
  const [backing, setBacking] = useState<Record<string, string>>({});
  /// What the backing is paid in. Amounts are typed in this token.
  const [payWith, setPayWith] = useState<PayWith>("USDC");
  const [prices, setPrices] = useState<Record<PayWith, number> | null>(null);

  const markets = usePoll(getMarkets, 5000) ?? NONE;
  const listed = useMemo(() => markets.filter((m) => m.observed), [markets]);

  useEffect(() => { void canSign().then(setSignable); }, []);
  useEffect(() => { void usdPrices().then(setPrices).catch(() => {}); }, []);

  // Resume from the URL: a linked pool is read directly, a linked token
  // searched for so its pools can be offered.
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    const pool = q.get("pool"), mint = q.get("token");
    if (pool && looksLikeAddress(pool)) void readPoolAddress(pool, mint);
    else if (mint && looksLikeAddress(mint)) {
      void searchTokens(mint).then((h) => { const t = h.find((x) => x.mint === mint); if (t) pick(t); });
    } else input.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Search as the query settles. A query that is the chosen token's own
  // label is the selection being shown, not a new search.
  useEffect(() => {
    const q = query.trim();
    setSearchErr(null);
    if (!q || (token && q === token.symbol)) { setHits([]); setSearching(false); return; }
    const ctl = new AbortController();
    setSearching(true);
    const id = window.setTimeout(async () => {
      try {
        const found = await searchTokens(q, ctl.signal);
        setHits(found); setCursor(0);
        if (found[0]) prefetchPools(found[0].mint);
        // A pasted address that is not a token may be a pool. Say what to do
        // with it rather than showing an empty list.
        if (!found.length && looksLikeAddress(q)) {
          setSearchErr("No token at that address. If it's a pool, press Enter.");
        } else if (!found.length) {
          setSearchErr("No token by that name.");
        }
      } catch (e: any) {
        if (e?.name !== "AbortError") setSearchErr("Search is down. Try again.");
      } finally {
        if (!ctl.signal.aborted) setSearching(false);
      }
    }, 180);
    return () => { ctl.abort(); window.clearTimeout(id); };
  }, [query, token]);

  function reset() {
    setToken(null); setPools(null); setPoolsErr(null); setChosen(null);
    setPreview(null); setPreviewErr(null); setLeverage(null); setSize(null);
    setDone(null); setError(null);
  }

  function pick(t: TokenHit) {
    reset();
    setToken(t); setQuery(t.symbol); setOpen(false);
    remember(t.mint, null);
    input.current?.blur();
  }

  /// A pool address pasted or linked: read it, and let its token be the token.
  async function readPoolAddress(address: string, mint?: string | null) {
    reset();
    setOpen(false);
    setReading(true);
    try {
      const p = await getPool(address);
      const t: TokenHit = {
        mint: p.base, symbol: p.symbol.replace(p.unitLabel, ""), name: p.name,
        icon: p.icon ?? null, price: p.price, liquidity: 0, mcap: null, verified: false,
      };
      if (mint && mint !== p.base) throw new Error("That pool doesn't trade that token.");
      preset.current = true; touched.current = true;
      setToken(t); setQuery(t.symbol);
      setPools([{ dex: p.dex, address, quote: "USD", tvl: 0, volume24h: 0, feePct: 0 }]);
      setChosen(address); setPreview(p);
      remember(p.base, address);
    } catch (e: any) {
      setPreviewErr(String(e?.message ?? e));
    } finally {
      setReading(false);
    }
  }

  // The token's pools, each venue's shown as it answers. The first answer
  // picks the default; a deeper pool arriving later takes over only if the
  // user has not chosen one themselves.
  const touched = useRef(false);
  /// Set when a pasted pool arrives with its list already known, so the
  /// token it names does not go looking for others.
  const preset = useRef(false);
  useEffect(() => {
    if (!token) return;
    if (preset.current) { preset.current = false; return; }
    let live = true, pending = 0, failed = 0;
    touched.current = false;
    const sources = poolSources(token.mint);
    pending = sources.length;
    const settle = () => {
      if (--pending > 0 || !live) return;
      setPools((ps) => {
        const got = ps ?? [];
        if (!got.length) {
          setPoolsErr(failed === sources.length
            ? "Can't reach Raydium or Meteora. Try again."
            : `${token.symbol} has no USDC or USDT pool on Raydium CLMM or Meteora DLMM.`);
        }
        return got;
      });
    };
    for (const src of sources) {
      src.then((found) => {
        if (!live) return;
        setPools((ps) => {
          const merged = [...(ps ?? []), ...found].sort(byDepth);
          if (merged.length && !touched.current) setChosen(merged[0].address);
          return merged.length || pending > 1 ? merged : ps;
        });
      }, () => { failed++; }).finally(settle);
    }
    return () => { live = false; };
  }, [token]);

  // Read the chosen pool from the chain. Sequenced, so a slow answer for a
  // pool the user has already moved on from cannot overwrite the new one.
  const seq = useRef(0);
  useEffect(() => {
    if (!chosen || preview?.address === chosen) return;
    const mine = ++seq.current;
    setReading(true); setPreviewErr(null); setPreview(null);
    setLeverage(null); setSize(null);
    if (token) remember(token.mint, chosen);
    getPool(chosen)
      .then((p) => { if (seq.current === mine) setPreview(p); })
      .catch((e) => { if (seq.current === mine) setPreviewErr(String(e?.message ?? e)); })
      .finally(() => { if (seq.current === mine) setReading(false); });
  }, [chosen, preview, token]);

  const limits = listingLimits(preview?.depthUsd ?? 0, {
    leverage: leverage ?? undefined, oiUsd: size ?? undefined,
  });
  const seedAmount = Number(seed) > 0 ? Number(seed) : 0;
  /// The seed in dollars, for the preview. An estimate for SOL: the program
  /// values it at the oracle when it lands.
  const seedUsd = seedAmount * (payWith === "USDC" ? 1 : prices?.[payWith] ?? 0);
  const payLabel = (n: number) =>
    payWith === "SOL" ? `${n.toLocaleString(undefined, { maximumFractionDigits: 4 })} SOL`
      : `${money(n, 0)}${payWith === "USDT" ? " USDT" : ""}`;
  const name = preview?.symbol ?? "";
  const pool = pools?.find((p) => p.address === chosen) ?? null;
  const backerShare = (preview?.backerFeeShareBps ?? 5_000) / 100;
  const tooThin = !!preview && preview.depthUsd < 1_000;
  /// Below the site's minimum, going by the page's own estimate. The server
  /// checks again at its own price.
  const underMin = seedUsd < MIN_LISTING_BACKING_USD
    && !(payWith !== "USDC" && !prices && seedAmount > 0);
  const ready = !!preview && !busy && !tooThin && !underMin && ack && signable === true;

  const deploy = async () => {
    if (!preview) return;
    setBusy(true); setError(null); setDone(null);
    try {
      // One transaction: the market, its observation, its batch and the
      // lister's backing land together or not at all, so a listing never
      // ends on a market nobody can trade.
      const r = await signAndSend(wallet, "list-market", {
        pool: preview.address, maxLeverage: limits.leverage, maxOiUsd: limits.oiUsd,
        backing: seedAmount, payWith,
      });
      if (!r.ok) { setError(r.error ?? "Transaction failed."); return; }
      setDone(preview.opensAtListing
        ? `${name} is live, backed with ${payLabel(seedAmount)}.`
        : `${name} is listed, backed with ${payLabel(seedAmount)}. `
          + `Trading opens in about ${Math.round(preview.seasonSec / 60)} minutes.`);
    } finally {
      setBusy(false);
    }
  };

  const back = async (m: Market) => {
    const amount = Number(backing[m.symbol]);
    if (!(amount > 0)) return;
    setBusy(true); setError(null);
    try {
      const r = await signAndSend(wallet, "back-market", { symbol: m.symbol, amount, payWith });
      if (r.ok) {
        setDone(`${m.symbol} is backed with ${payLabel(amount)}.`);
        setBacking((b) => ({ ...b, [m.symbol]: "" }));
      } else {
        setError(r.error ?? "Transaction failed.");
      }
    } finally { setBusy(false); }
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setOpen(true); setCursor((c) => Math.min(c + 1, hits.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setCursor((c) => Math.max(c - 1, 0)); }
    else if (e.key === "Escape") setOpen(false);
    else if (e.key === "Enter") {
      if (hits[cursor]) pick(hits[cursor]);
      else if (looksLikeAddress(query)) void readPoolAddress(query.trim());
    }
  };

  /// Read from mainnet by the preview path while a chain is attached: a
  /// real pool the local validator never cloned. Describable, not listable.
  const offChain = signable === true && !!preview?.readOnly;

  const cta = (() => {
    if (offChain) return { label: "Pool not on this chain", onClick: undefined, disabled: true };
    if (signable === false) {
      return { label: "Opens at devnet launch", onClick: undefined, disabled: true };
    }
    if (!wallet.publicKey) return { label: "Connect wallet", onClick: () => setVisible(true), disabled: false };
    return {
      label: busy ? "Confirm in wallet" : `List ${name || "market"}`,
      onClick: deploy, disabled: !ready,
    };
  })();

  const showList = open && query.trim() !== "" && !(token && query === token.symbol);

  /// What the preview's status card says: when this market can trade.
  const status = !token
    ? { title: "Pick a token", body: "Its market shows here, sized to its pool." }
    : !preview
    ? { title: previewErr ? "Pool not read" : "Reading the pool", body: previewErr ?? "Price and depth, on chain." }
    : tooThin
    ? { title: "Too thin", body: "Pick a deeper pool." }
    : preview.opensAtListing
    ? { title: "Live at listing", body: "Tradeable from the first price, within seconds of listing." }
    : { title: `Opening auction in ~${Math.round(preview.seasonSec / 60)}m`,
        body: "Opens after 15 minutes of price readings. Orders placed before then clear together." };

  return (
    <div className="site relative min-h-full">
      <SiteHeader here="/list" actions={<WalletActions />} />

      {/* The front page's violet light across the top of the page, fading out
          before the card's fields, so the page opens the way the front page does. */}
      <img src="/waitlist/field.webp" alt="" aria-hidden
        className="pointer-events-none absolute inset-x-0 top-[76px] hidden h-[420px] w-full
                   object-cover opacity-60 [mask-image:linear-gradient(to_bottom,black,transparent)]
                   dark:block" />
      <Shell className="relative pb-28 pt-4 sm:pt-8 lg:pb-14">
        <div className="grid overflow-hidden rounded-[24px] border border-line bg-panel
                        lg:grid-cols-[minmax(0,1fr)_440px]">
          {/* ------------------------------------------------------ form */}
          <div className="min-w-0 px-5 py-7 sm:px-9 sm:py-9">
            <div className="mb-7 flex flex-wrap items-center justify-between gap-4">
              <h1 className="font-serif-display text-[clamp(2rem,3.4vw,2.6rem)] leading-none
                             tracking-[-.02em]">
                {tab === "list" ? "List a market" : "Back a market"}
              </h1>
              <Tabs value={tab} onValueChange={(v) => setTab(v as "list" | "back")} variant="pill">
                <TabsList className={PILL_LIST}>
                  <TabsTrigger value="list" className={PILL_TRIGGER} indicatorClassName={PILL_INDICATOR}>
                    List
                  </TabsTrigger>
                  <TabsTrigger value="back" className={PILL_TRIGGER} indicatorClassName={PILL_INDICATOR}>
                    Back{listed.length > 0 && <span className="n ml-1.5 opacity-60">{listed.length}</span>}
                  </TabsTrigger>
                </TabsList>
              </Tabs>
            </div>

            {tab === "list" ? (
              <div className="flex flex-col gap-6">
                {/* ------------------------------------------------ token */}
                <div>
                  <Label htmlFor="token-search">Token</Label>
                  <div className="relative">
                    <Search size={16} strokeWidth={1.75}
                      className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2
                                 text-dim" />
                    <input id="token-search" ref={input} value={query}
                      onChange={(e) => {
                        setQuery(e.target.value); setOpen(true);
                        if (token && e.target.value !== token.symbol) { reset(); remember(null, null); }
                      }}
                      onFocus={() => setOpen(true)}
                      onBlur={() => window.setTimeout(() => setOpen(false), 120)}
                      onKeyDown={onKey}
                      role="combobox" aria-expanded={showList} aria-controls="token-results"
                      spellCheck={false} autoComplete="off"
                      placeholder="Search a ticker, name or mint"
                      className={`${FIELD} h-[48px] pl-10 pr-10 text-[14.5px]`} />
                    {(searching || (reading && !preview)) ? (
                      <Loader2 size={16} className="absolute right-3.5 top-1/2 -translate-y-1/2
                                                    animate-spin text-dim" />
                    ) : query && (
                      <button type="button" aria-label="Clear"
                        onClick={() => { setQuery(""); reset(); remember(null, null); input.current?.focus(); }}
                        className="absolute right-2 top-1/2 grid size-8 -translate-y-1/2
                                   place-items-center rounded-md text-dim hover:text-foreground">
                        <X size={15} />
                      </button>
                    )}

                    {showList && hits.length > 0 && (
                      <ul id="token-results" role="listbox"
                        className="absolute inset-x-0 top-[calc(100%+6px)] z-30 max-h-[360px]
                                   overflow-y-auto overscroll-contain rounded-[14px] border
                                   border-line bg-panel p-1 shadow-2xl">
                        {hits.map((t, i) => (
                          <li key={t.mint} role="option" aria-selected={i === cursor}>
                            <button type="button"
                              onMouseDown={(e) => e.preventDefault()}
                              onMouseEnter={() => { setCursor(i); prefetchPools(t.mint); }}
                              onClick={() => pick(t)}
                              className={`flex w-full items-center gap-3 rounded-[10px] px-2.5 py-2
                                          text-left ${i === cursor ? "bg-panel2" : ""}`}>
                              <TokenIcon src={t.icon} label={t.symbol} />
                              <span className="min-w-0 flex-1">
                                <span className="flex items-center gap-1 text-[13.5px] font-medium">
                                  <span className="truncate">{t.symbol}</span>
                                  {t.verified && <BadgeCheck size={14} className="flex-none text-brand" />}
                                </span>
                                <span className="block truncate text-[11.5px] text-muted-foreground">
                                  {t.name} · {short(t.mint)}
                                </span>
                              </span>
                              <span className="flex-none text-right">
                                <span className="n block text-[12.5px]">
                                  {t.price != null ? price(t.price) : "–"}
                                </span>
                                <span className="n block text-[11px] text-dim">
                                  {t.liquidity > 0 ? `${compact(t.liquidity)} liq` : ""}
                                </span>
                              </span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                  <p className={`mt-2 min-h-[18px] text-[12px] ${
                    searchErr ? "text-down" : "text-muted-foreground"}`}>
                    {searchErr ?? (token ? (
                      <>
                        {token.name}{token.verified ? " · verified" : ""}
                        {token.mcap ? ` · ${compact(token.mcap)} market cap` : ""}
                        {" · "}
                        <a href={`https://solscan.io/token/${token.mint}${onDevnet ? "?cluster=devnet" : ""}`}
                          target="_blank" rel="noreferrer"
                          className="inline-flex items-center gap-0.5 hover:text-foreground">
                          {short(token.mint)} <ArrowUpRight size={11} strokeWidth={1.75} />
                        </a>
                      </>
                    ) : unlisted.length ? (
                      // On the testnet the search finds mainnet tokens, which
                      // cannot list here; these are pools that can.
                      <>
                        Devnet pools:{" "}
                        {unlisted.map((p, i) => (
                          <span key={p.pool}>
                            {i > 0 && ", "}
                            <button type="button" onClick={() => void readPoolAddress(p.pool)}
                              className="font-medium text-foreground underline-offset-2 hover:underline">
                              {p.symbol}
                            </button>
                          </span>
                        ))}
                      </>
                    ) : "Or paste a Raydium CLMM or Meteora DLMM pool address.")}
                  </p>
                </div>

                {/* ------------------------------------------------- pool */}
                <Fieldset legend="Price source" locked={!token}>
                  {!token ? (
                    <div className="grid grid-cols-2 gap-2">
                      {["Raydium CLMM", "Meteora DLMM"].map((d) => (
                        <div key={d} className="grid h-[56px] place-items-center rounded-[12px]
                                                border border-line text-[13.5px] text-muted-foreground">
                          {d}
                        </div>
                      ))}
                    </div>
                  ) : poolsErr ? (
                    <p className="py-2 text-[12.5px] text-down">{poolsErr}</p>
                  ) : !pools ? (
                    <div className="grid grid-cols-2 gap-2">
                      {[0, 1].map((i) => (
                        <div key={i} className="h-[56px] animate-pulse rounded-[12px] bg-panel2" />
                      ))}
                    </div>
                  ) : (
                    <div role="radiogroup" aria-label="Pool" className="grid gap-2 sm:grid-cols-2">
                      {pools.slice(0, 4).map((p, i) => {
                        const on = p.address === chosen;
                        return (
                          <button key={p.address} type="button" role="radio" aria-checked={on}
                            onClick={() => { touched.current = true; setChosen(p.address); }}
                            className={`press flex min-h-[56px] items-center justify-between gap-3
                                        rounded-[12px] border px-4 py-2.5 text-left transition-colors ${on
                              ? "border-foreground bg-foreground text-background"
                              : "border-line hover:border-foreground/30"}`}>
                            <span className="min-w-0">
                              <span className="flex items-center gap-2 text-[13.5px] font-medium">
                                {DEX_NAME[p.dex]}
                                {i === 0 && pools.length > 1 && (
                                  <span className={`rounded-full px-1.5 py-px text-[10px] font-medium ${on
                                    ? "bg-background/15" : "bg-up/15 text-up"}`}>Deepest</span>
                                )}
                              </span>
                              <span className={`block truncate text-[11.5px] ${on
                                ? "opacity-60" : "text-muted-foreground"}`}>
                                {token.symbol} / {p.quote}
                                {p.feePct > 0 && ` · ${p.feePct.toFixed(2)}% fee`}
                              </span>
                            </span>
                            {p.tvl > 0 && (
                              <span className="n flex-none text-[12.5px]">{compact(p.tvl)}</span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  )}
                  <p className="mt-3 text-[12px] text-muted-foreground">
                    {previewErr
                      ? <span className="text-down">{previewErr}</span>
                      : "Deepest USD pool. Price read on chain."}
                  </p>
                </Fieldset>

                {/* ---------------------------------------------- backing */}
                <Fieldset legend="Backing" locked={!preview}>
                  <div role="radiogroup" aria-label="Pay with" className="mb-3 grid grid-cols-3 gap-2 sm:flex">
                    {(Object.keys(PAY_TOKENS) as PayWith[]).map((k) => (
                      <button key={k} type="button" role="radio" aria-checked={payWith === k}
                        onClick={() => { setPayWith(k); setSeed(k === "SOL" ? "" : String(defaultBacking)); }}
                        className={`press flex h-10 min-w-0 items-center justify-center rounded-full
                                    border px-2 text-[13.5px] transition-colors sm:justify-start
                                    sm:pl-1.5 sm:pr-4 ${payWith === k
                          ? "border-foreground text-foreground"
                          : "border-line text-muted-foreground hover:text-foreground"}`}>
                        <PayToken k={k} size={24} className="gap-2" />
                      </button>
                    ))}
                  </div>
                  <div className="relative">
                    <input value={seed} inputMode="decimal"
                      onChange={(e) => setSeed(e.target.value.replace(/[^\d.]/g, ""))}
                      placeholder="0.00" aria-label={`Backing in ${payWith}`}
                      className={`n ${FIELD} h-[48px] pr-16 text-[14.5px]`} />
                    <span className="pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2">
                      <img src={PAY_TOKENS[payWith].logo} alt="" className="size-5 rounded-full" />
                    </span>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    {LIST_QUICK[payWith].map((q) => (
                      <button key={q} type="button" onClick={() => setSeed(String(q))}
                        className={`press h-7 rounded-full border px-3 text-[12px] transition-colors ${
                          seedAmount === q
                            ? "border-foreground/60 text-foreground"
                            : "border-line text-muted-foreground hover:text-foreground"}`}>
                        {payWith === "SOL" ? `${q} SOL` : compact(q)}
                      </button>
                    ))}
                  </div>
                  <p className={`mt-2.5 text-[12px] leading-relaxed ${
                    underMin && seedAmount > 0 ? "text-down" : "text-muted-foreground"}`}>
                    {underMin && seedAmount > 0
                      ? `At least ${money(MIN_LISTING_BACKING_USD, 0)} to list${
                        payWith !== "USDC" && seedUsd > 0 ? `; this is about ${money(seedUsd, 0)}` : ""}.`
                      : <>First loss, capped at what you post. Earns {backerShare}% of LP fees.
                        {payWith === "SOL" ? " SOL counts at 80%." : ""}</>}
                  </p>
                </Fieldset>

                {/* The limits default to the most the pool allows, which is
                    what almost everyone wants. Folded rather than removed,
                    for the lister who wants a smaller market. */}
                {preview && (
                  <Fold label={`Advanced · ${limits.leverage}x, ${compact(limits.oiUsd)} max`}
                    open={advanced} onToggle={() => setAdvanced((a) => !a)}>
                    <div className="flex flex-col gap-6">
                      <p className="text-[12px] text-muted-foreground">
                        Opens at {limits.startLeverage}x. Rises to{" "}
                        {Math.min(limits.leverage, limits.depthLeverage)}x while depth holds. Falls if
                        it thins.
                      </p>
                      <Limit label="Leverage ceiling" display={`${limits.leverage}x`}
                        value={limits.leverage} min={1} max={Math.max(1.5, limits.maxLeverage)}
                        step={0.5} onChange={setLeverage}
                        lo="1x" hi={`${limits.maxLeverage}x`} text={(v) => `${v}x`} />
                      <Limit label="Max size per side" display={money(limits.oiUsd, 0)}
                        value={limits.oiUsd} min={limits.minOiUsd}
                        max={Math.max(limits.minOiUsd + 1_000, limits.maxOiUsd)}
                        step={1_000} onChange={setSize}
                        lo={compact(limits.minOiUsd)} hi={compact(limits.maxOiUsd)}
                        text={(v) => money(v, 0)} />
                    </div>
                  </Fold>
                )}

                <div className="border-t border-line pt-6">
                  <div className="mb-4 flex items-start gap-3 text-[13px] text-muted-foreground">
                    <Checkbox id="ack" checked={ack} onCheckedChange={setAck}
                      aria-label="My backing takes this market's losses first" />
                    <label htmlFor="ack" className="cursor-pointer">
                      My backing takes this market's losses first, up to what I post.{" "}
                      <a href={`${DOCS}/onboarding/how-to-underwrite-a-market`} target="_blank" rel="noreferrer"
                        className="text-foreground underline underline-offset-2">How backing works</a>
                    </label>
                  </div>
                  <button type="button" onClick={cta.onClick} disabled={cta.disabled}
                    className="press flex h-[48px] w-full items-center justify-center gap-2
                               rounded-full bg-foreground text-[14px] font-medium text-background
                               transition-opacity hover:opacity-90 disabled:pointer-events-none
                               disabled:opacity-35">
                    {busy && <Loader2 size={15} className="animate-spin" />}
                    {cta.label}
                  </button>
                  <p className="mt-3 text-[12px] leading-relaxed text-dim">
                    {offChain
                      ? "Read from mainnet. This pool isn't on this chain."
                      : signable === false
                      ? "Live from mainnet. Listing opens with devnet."
                      : "One signature. Listing and backing land together. You pay the rent."}
                  </p>
                  {done && <p className="mt-3 text-[12.5px] leading-relaxed text-up">{done}</p>}
                  {error && <p className="mt-3 text-[12.5px] leading-relaxed text-down">{error}</p>}
                </div>
              </div>
            ) : (
              /* ---------------------------------------------------- back */
              <div className="flex flex-col gap-3">
                <p className="text-[13px] leading-relaxed text-muted-foreground">
                  Anyone can back these. First loss, {backerShare}% of LP fees.
                </p>
                <div role="radiogroup" aria-label="Pay with" className="flex flex-wrap gap-2">
                  {(Object.keys(PAY_TOKENS) as PayWith[]).map((k) => (
                    <button key={k} type="button" role="radio" aria-checked={payWith === k}
                      onClick={() => setPayWith(k)}
                      className={`press flex h-9 items-center rounded-full border pl-1.5 pr-3.5
                                  text-[13px] transition-colors ${payWith === k
                        ? "border-foreground text-foreground"
                        : "border-line text-muted-foreground hover:text-foreground"}`}>
                      <PayToken k={k} size={22} className="gap-2" />
                    </button>
                  ))}
                </div>
                {listed.length === 0 ? (
                  <div className="rounded-[16px] border border-dashed border-line px-4 py-10 text-center
                                  text-[13px] text-muted-foreground">
                    No markets yet.{" "}
                    <button type="button" onClick={() => setTab("list")}
                      className="text-foreground underline underline-offset-2">List the first one</button>.
                  </div>
                ) : listed.map((m) => {
                  const s = statusOf(m);
                  return (
                    <div key={m.symbol} id={m.symbol}
                      className="scroll-mt-24 rounded-[16px] border border-line px-4 py-3.5 target:border-foreground/40">
                      <div className="flex items-center gap-3">
                        {m.observed!.tradeable || m.observed!.budgetUsd > 0 ? (
                          <a href={`/trade?symbol=${m.symbol}`}
                            className="flex-1 text-[13.5px] font-medium transition-colors hover:text-brand">
                            {m.symbol}
                          </a>
                        ) : (
                          <span className="flex-1 text-[13.5px] font-medium">{m.symbol}</span>
                        )}
                        <span className="n flex-none text-[13px] text-muted-foreground">{price(m.price)}</span>
                        <span className="flex-none text-right">
                          <span className={`block text-[12px] ${s.tone}`}>{s.label}</span>
                          {s.detail && <span className="block text-[11px] text-dim">{s.detail}</span>}
                        </span>
                      </div>
                      <div className="mt-3"><Ripeness o={m.observed!} /></div>
                      <div className="mt-3 flex items-center gap-2">
                        <input value={backing[m.symbol] ?? ""} inputMode="decimal"
                          onChange={(e) => setBacking((b) => ({ ...b, [m.symbol]: e.target.value }))}
                          onKeyDown={(e) => { if (e.key === "Enter") back(m); }}
                          placeholder={`0.00 ${payWith}`} aria-label={`Back ${m.symbol} in ${payWith}`}
                          className={`n ${FIELD} h-10 flex-1`} />
                        <button onClick={() => back(m)}
                          disabled={busy || !wallet.publicKey || !(Number(backing[m.symbol]) > 0)}
                          className="press h-10 flex-none rounded-full bg-foreground px-5 text-[13px]
                                     font-medium text-background transition-opacity hover:opacity-90
                                     disabled:pointer-events-none disabled:opacity-35">
                          Back it
                        </button>
                      </div>
                    </div>
                  );
                })}
                {!wallet.publicKey && listed.length > 0 && (
                  <button type="button" onClick={() => setVisible(true)}
                    className="press mt-1 h-[48px] w-full rounded-full bg-foreground text-[14px]
                               font-medium text-background hover:opacity-90">
                    Connect wallet
                  </button>
                )}
                {done && <p className="text-[12.5px] leading-relaxed text-up">{done}</p>}
                {error && <p className="text-[12.5px] leading-relaxed text-down">{error}</p>}
              </div>
            )}
          </div>

          {/* --------------------------------------------------- preview */}
          <aside className="flex min-w-0 flex-col gap-5 border-t border-line bg-panel2 px-5 py-7
                            sm:px-9 sm:py-9 lg:border-l lg:border-t-0">
            <div className="lg:sticky lg:top-24 lg:flex lg:flex-col lg:gap-5">
              <div className="flex items-start gap-3 rounded-[16px] border border-line bg-panel
                              px-4 py-3.5 shadow-[0_8px_24px_-12px_rgba(0,0,0,.5)]">
                {token
                  ? <TokenIcon src={preview?.icon ?? token.icon} label={token.symbol} size={36} />
                  : <span className="grid size-9 flex-none place-items-center rounded-full bg-panel3">
                      <Mark size={18} />
                    </span>}
                <span className="min-w-0">
                  <span className="block text-[13px] font-medium">{status.title}</span>
                  <span className="block text-[12px] leading-snug text-muted-foreground">{status.body}</span>
                </span>
              </div>

              <div className="mt-5 rounded-[20px] border border-line bg-panel p-4 lg:mt-0">
                <div className="relative grid aspect-[4/3] place-items-center overflow-hidden
                                rounded-[14px] border border-line bg-panel2">
                  {token || preview ? (
                    <div className="flex flex-col items-center gap-3">
                      <TokenIcon src={preview?.icon ?? token?.icon} label={name || token?.symbol || "?"} size={72} />
                      <span className="text-[11px] uppercase tracking-[.12em] text-dim">
                        {preview ? `live from ${onDevnet ? "devnet" : "mainnet"}` : "reading pool"}
                      </span>
                    </div>
                  ) : (
                    <span className="h-px w-3 bg-dim" />
                  )}
                </div>

                <div className="mt-4 flex items-baseline gap-2">
                  <span className="truncate text-[14px] font-medium">
                    {token?.name ?? "Token name"}
                  </span>
                  <span className="n flex-none text-[11px] uppercase tracking-[.08em] text-dim">
                    {name || token?.symbol || "Ticker"}
                  </span>
                </div>
                <div className="mt-1.5 flex items-baseline gap-4">
                  <span className="n text-[20px] font-semibold tracking-[-.01em]">
                    {preview ? <AnimatedNumber value={preview.unitPrice} format={price} startOnView={false} duration={0.8} /> : reading ? "…" : "$0"}
                    <span className="ml-1 text-[11px] font-normal text-dim">
                      MARK{preview?.unitLabel ? ` / ${preview.unitLabel}` : ""}
                    </span>
                  </span>
                  <span className={`n text-[20px] font-semibold tracking-[-.01em] ${tooThin ? "text-down" : ""}`}>
                    {preview ? <AnimatedNumber value={preview.depthUsd} format={compact} startOnView={false} duration={0.8} /> : "$0"}
                    <span className="ml-1 text-[11px] font-normal text-dim">DEPTH</span>
                  </span>
                </div>
                {preview && preview.unitExp > 0 && (
                  <p className="mt-1.5 text-[11.5px] text-dim">
                    Priced per {unitWords(preview.unitExp)} {token?.symbol}.
                  </p>
                )}

                <div className="mt-4">
                  <Stat k="Price source">
                    {preview && pool ? `${DEX_NAME[preview.dex]} · ${pool.quote}` : "–"}
                  </Stat>
                  <Stat k="Max size per side">{preview ? money(limits.oiUsd, 0) : "–"}</Stat>
                  <Stat k="Max leverage">
                    {preview ? `${limits.startLeverage}x → ${Math.min(limits.leverage, limits.depthLeverage)}x` : "–"}
                  </Stat>
                  <Stat k="Trading fee">{`${LISTING_ROUND_TRIP_FEE_BPS / 100}% round trip`}</Stat>
                  <Stat k="Backers earn">{`${backerShare}% of LP fees`}</Stat>
                  <Stat k="Backing" tone={seedAmount > 0 ? "text-up" : ""}>
                    {seedAmount > 0
                      ? payWith === "USDC" ? money(seedAmount, 0) : `≈${money(seedUsd, 0)} in ${payWith}`
                      : `at least ${money(MIN_LISTING_BACKING_USD, 0)}`}
                  </Stat>
                  {/* What the backing buys in fills. With nobody on the other
                      side the pool is the counterparty, for a twentieth of the
                      budget each batch; saying so up front is the difference
                      between a small market and a broken one. */}
                  {preview && seedUsd > 0 && (
                    <Stat k="Pool fills per batch">
                      {`up to ${money(Math.min(seedUsd, preview.depthUsd) * POOL_QUOTE_BUDGET_BPS / 10_000, 0)}`}
                    </Stat>
                  )}
                </div>
              </div>

              <p className="mt-5 text-[12px] leading-relaxed text-dim lg:mt-0">
                The program enforces every figure here. Listing gives you no control over
                the market.
              </p>
            </div>
          </aside>
        </div>
      </Shell>

      {/* On a phone the preview is below the fold, so the action rides along
          at the bottom with the one figure that matters while deciding. */}
      {tab === "list" && (
        <div className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-background/95
                        px-4 pb-[max(12px,env(safe-area-inset-bottom))] pt-3 backdrop-blur lg:hidden">
          <div className="mx-auto flex max-w-[640px] items-center gap-3">
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-medium">{name || "Pick a token"}</span>
              <span className="n block truncate text-[11.5px] text-muted-foreground">
                {preview ? `${price(preview.unitPrice)} · ${compact(limits.oiUsd)} max` : "Search above"}
              </span>
            </span>
            <button type="button" onClick={cta.onClick} disabled={cta.disabled}
              className="press h-[44px] flex-none rounded-full bg-foreground px-5 text-[13.5px]
                         font-medium text-background disabled:opacity-35">
              {offChain ? "Not on this chain" : signable === false ? "Devnet soon" : cta.label}
            </button>
          </div>
        </div>
      )}

      <SiteFooter />
    </div>
  );
}
