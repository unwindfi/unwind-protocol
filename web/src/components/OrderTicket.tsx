import { ArrowLeftRight, ChevronDown, ChevronRight, ChevronUp } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useId, useMemo, useState, type ReactNode } from "react";
import { Checkbox } from "@/components/motion/checkbox";
import { RangeSlider } from "@/components/motion/range-slider";
import { Tooltip } from "@/components/motion/tooltip";
import { Tabs, TabsList, TabsTrigger } from "@/components/Tabs";
import { NumberTicker } from "@/components/motion/number-ticker";
import { EASE_OUT } from "@/lib/ease";
import type { Account, Market } from "@/lib/api";
import { money, tone } from "@/lib/format";

/// Key and value across one rule, the way /list states a figure: the name
/// quiet on the left, the number in weight on the right.
function KV({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-t border-line py-2.5
                    first:border-t-0">
      <span className="flex-none text-[12.5px] text-muted-foreground">{k}</span>
      <span className="n truncate text-right text-[12.5px] font-semibold">{children}</span>
    </div>
  );
}

/// A field's name, above it rather than inside it, as on /list.
const Label = ({ children, htmlFor }: { children: ReactNode; htmlFor?: string }) => (
  <label htmlFor={htmlFor} className="mb-2 block text-[13px] text-foreground">{children}</label>
);

/// beUI's checkbox in the page's own ink: checked is the inverted fill every
/// other selection on the site uses, not the library's blue.
const CHECK =
  "gap-2.5 [&_span]:text-[13px] [&_button]:size-[18px] [&_button]:rounded-[5px] " +
  "[&_button]:border-[1.5px] [&_button[data-state=checked]]:border-foreground " +
  "[&_button[data-state=checked]]:bg-foreground [&_button[data-state=checked]]:text-background";

/// The settings chips at the top of the ticket: the /list pill at its
/// smallest, outlined at rest and inverted when open.
const CHIP =
  "inline-flex h-8 items-center rounded-full border border-line px-3 text-[12.5px] " +
  "font-medium transition-colors pointer-coarse:h-9";

const levText = (L: number) => `${L % 1 === 0 ? L.toFixed(0) : L.toFixed(1)}x`;

/*
 * Every input in the ticket is the same shape: the name above, the number in
 * a rounded well under it, its unit after it on the right. The /list form's
 * fields, so a trader moving between opening a market and trading one meets
 * one kind of input.
 */
const FIELD =
  "flex h-[44px] items-center gap-2 rounded-[12px] border border-line bg-panel2 px-3.5 " +
  "transition-colors focus-within:border-foreground/40 pointer-coarse:h-[48px]";

/// "25000.5" as "25,000.5", keeping whatever is typed after the point so a
/// half-typed decimal is not rounded away under the cursor.
const group = (v: string) => {
  if (!v) return v;
  const [int, dec] = v.split(".");
  const g = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return dec === undefined ? g : `${g}.${dec}`;
};

function Field({
  label, value, onChange, unit, placeholder, trailing, min, step, ariaLabel, grouped,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  unit?: string;
  placeholder?: string;
  /// Rendered after the unit: the affordance that belongs to this field alone
  /// (mid-price, denomination swap, stepper).
  trailing?: ReactNode;
  min?: number;
  step?: number;
  ariaLabel?: string;
  /// Show thousands separators. The field becomes text, since a number input
  /// cannot hold a comma; what is passed back is still the bare number.
  grouped?: boolean;
}) {
  const id = useId();
  const shown = grouped ? group(value) : value;
  return (
    <div>
      <Label htmlFor={id}>{label}</Label>
      <div className={FIELD}>
        <input
          id={id} type={grouped ? "text" : "number"} inputMode="decimal" value={shown}
          min={grouped ? undefined : min} step={grouped ? undefined : step}
          placeholder={placeholder} aria-label={ariaLabel ?? label}
          onChange={(e) => onChange(grouped ? e.target.value.replace(/[^\d.]/g, "") : e.target.value)}
          className="n min-w-0 flex-1 bg-transparent text-[14px] font-medium
                     outline-none placeholder:font-normal placeholder:text-dim" />
        {unit && <span className="flex-none text-[12.5px] text-muted-foreground">{unit}</span>}
        {trailing}
      </div>
    </div>
  );
}

/*
 * The native number spinner is a browser widget: it fades in only on hover,
 * sits hard against the field's edge and takes no theming. It is hidden in
 * index.css and replaced by these two chevrons, which stay visible and share
 * the field's palette. tabIndex -1 keeps them out of the tab order: the arrow
 * keys already step a focused number input.
 */
function Stepper({
  value, min, step, onChange, label,
}: {
  value: number; min: number; step: number; onChange: (n: number) => void; label: string;
}) {
  // Stepping off a hand-typed value has to snap to the step grid, and snap in
  // the direction of travel: from 25_050 the up arrow gives 25_100 and the down
  // arrow 25_000. Rounding to the nearest step first would skip one of those.
  const bump = (dir: 1 | -1) => {
    const grid = dir === 1 ? Math.floor(value / step) : Math.ceil(value / step);
    onChange(Math.max(min, Number(((grid + dir) * step).toFixed(6))));
  };
  return (
    <div className="flex flex-none flex-col text-dim">
      {([1, -1] as const).map((dir) => {
        const Icon = dir === 1 ? ChevronUp : ChevronDown;
        return (
          <button
            key={dir} type="button" tabIndex={-1}
            aria-label={`${dir === 1 ? "Increase" : "Decrease"} ${label}`}
            onClick={() => bump(dir)}
            className="flex h-[13px] w-5 items-center justify-center rounded-[4px]
                       transition-colors hover:bg-panel3 hover:text-foreground
                       pointer-coarse:h-[16px] pointer-coarse:w-6">
            <Icon className="size-3" strokeWidth={2.5} />
          </button>
        );
      })}
    </div>
  );
}

/// Time in force. The program takes an expiry timestamp, where zero means the
/// order stands until it fills or is cancelled, so "good till cancelled" and
/// a dated order are the same field, and this is the whole range of it.
const TIF = { gtc: 0, "1h": 3600, "1d": 86_400 } as const;
type Tif = keyof typeof TIF;

export function OrderTicket({
  m, account, busy, onOrder, onLimit, onMaker, onPool, onFund, onTrigger, onCancelTrigger,
  onReduce, submitLabel, mobile = false, card = false, side: sideProp, onSideChange,
}: {
  m: Market;
  account: Account | null;
  busy: boolean;
  /// Present only for a connected wallet with nothing to trade with; localnet
  /// has no other way to hand it test funds.
  onFund?: () => void;
  onOrder: (a: { isLong: boolean; size: number; collateral: number }) => void;
  /// Places a limit order: the collateral is escrowed until it fills.
  onLimit?: (a: { isLong: boolean; size: number; collateral: number;
                  triggerPrice: number; expiryTs: number }) => void;
  /*
   * Places a post-only order: a resting limit that trades only against
   * takers, never the pool. It is its own callback rather than two optional
   * fields on `onOrder` because it goes to a different place than a limit
   * (POST /order with `price` and `maker: true`, not /order/trigger), and a
   * caller that forwarded only onOrder's old fields would send it as a
   * market taker. The "Post only" box is shown only when this is passed.
   */
  onMaker?: (a: { isLong: boolean; size: number; collateral: number; price: number;
                  maker: true }) => void;
  /// Places a take-profit or stop on the open position.
  onTrigger?: (a: { kind: "tp" | "sl"; triggerPrice: number; isLong: boolean }) => void;
  onCancelTrigger?: (slot: number) => void;
  /// Closes part of the open position, which is what a reduce-only order is here.
  onReduce?: (a: { size: number }) => void;
  onPool?: (kind: "deposit" | "withdraw", amount: number) => void;
  /// Overrides the action button's label. The landing page mounts this ticket
  /// for real (live index, live margin) but its button opens the app rather
  /// than sending an order, and it has to say so.
  submitLabel?: string;
  mobile?: boolean;
  /// On the market page the ticket is a card in a sticky rail rather than a
  /// column bolted to the right edge of the window.
  card?: boolean;
  /// On mobile the side is chosen by the Buy/Sell bar that opens the sheet, so
  /// the ticket has to open on the side the trader already pressed.
  side?: "long" | "short";
  onSideChange?: (s: "long" | "short") => void;
}) {
  const uid = useId();
  const reduceMotion = useReducedMotion();
  const [sideState, setSideState] = useState<"long" | "short">("long");
  const side = sideProp ?? sideState;
  const setSide = onSideChange ?? setSideState;
  const [amount, setAmount] = useState("25000");
  /// Which unit the amount field is typed in. The program sizes in USD; a
  /// trader who thinks in shares should not have to do the multiplication.
  const [denom, setDenom] = useState<"usd" | "base">("usd");
  const [lev, setLev] = useState(5);
  const [levOpen, setLevOpen] = useState(false);
  const [triggers, setTriggers] = useState({ tp: "", sl: "" });
  const [tpsl, setTpsl] = useState(false);
  const [mode, setMode] = useState<"market" | "limit">("market");
  const [reduceOnly, setReduceOnly] = useState(false);
  const [tif, setTif] = useState<Tif>("gtc");
  const [limitPrice, setLimitPrice] = useState("");
  const [postOnly, setPostOnly] = useState(false);

  const maxLev = m.maxLeverage;
  const L = Math.min(Math.max(lev, 1.1), maxLev);
  const avail = account?.usdc ?? 0;
  const pos = account?.positions[m.symbol];

  // A maker needs a price of its own, so the box only means something on the
  // limit tab; it is remembered across tabs but only acts where it applies.
  const maker = !!onMaker && postOnly && mode === "limit" && !reduceOnly;

  const typed = Number(amount) || 0;
  const size = denom === "usd" ? typed : typed * m.price;
  const swap = () => {
    const next = denom === "usd" ? "base" : "usd";
    setAmount(typed
      ? (next === "base" ? (typed / m.price).toFixed(4) : (typed * m.price).toFixed(2))
      : "");
    setDenom(next);
  };

  const calc = useMemo(() => {
    const margin = size / L;
    const fee = size * (m.openFeeBps / 1e4);
    // The program deducts the open fee from posted collateral, so it is charged
    // on top of margin; otherwise an order at the cap lands just over it.
    const debit = margin + fee;
    const entry = side === "long" ? m.ask : m.bid;
    const move = m.maintenanceMarginBps / 1e4 - 1 / L;
    const liq = side === "long" ? entry * (1 + move) : entry * (1 - move);
    const capped = size > (side === "long" ? m.capLong : m.capShort);
    return { margin, fee, debit, entry, liq, capped };
  }, [size, L, side, m]);

  // The program rejects any fill priced off an oracle older than the market's
  // tolerance. The page would otherwise keep showing the last good price and
  // let the trader find out by having the order bounce.
  const ageSec = m.priceAgeMs == null ? null : m.priceAgeMs / 1000;
  const stale = ageSec != null && ageSec > m.maxPriceAgeSec;

  // A reduce-only order posts no margin and takes no capacity (it hands size
  // back), so it is measured against the position instead of the account.
  const warn =
    stale ? `Price feed stale (${Math.round(ageSec!)}s). Orders paused.`
    : reduceOnly
      ? !pos ? `No ${m.symbol} position to reduce`
        : pos.isLong === (side === "long")
          ? `Choose ${pos.isLong ? "Short" : "Long"} to reduce a ${pos.isLong ? "long" : "short"}`
          : ""
    : size <= 0 ? ""
    : account && calc.debit > avail ? `Needs ${money(calc.debit)} margin`
    : calc.capped ? `Above ${side} capacity for this market`
    : "";

  /*
   * The most this order can be, for the slider and its steps. Opening, it is
   * what the free balance margins at this leverage once the open fee is taken
   * out (size / L + size * fee = avail), held under the side's remaining
   * capacity so Max never lands on a warning. Reducing, it is the position.
   */
  const feeRate = m.openFeeBps / 1e4;
  const maxSize = reduceOnly
    ? (pos?.size ?? 0)
    : Math.max(0, Math.min(avail / (1 / L + feeRate), side === "long" ? m.capLong : m.capShort));
  const pct = maxSize > 0 ? Math.min(100, (size / maxSize) * 100) : 0;
  // Floored to the cent (or the ten-thousandth of a share), so a step never
  // rounds up past the balance it was measured against.
  const setPct = (p: number) => {
    const usd = (maxSize * p) / 100;
    setAmount(usd <= 0 ? ""
      : denom === "usd" ? String(Math.floor(usd * 100) / 100)
      : String(Math.floor((usd / m.price) * 1e4) / 1e4));
  };

  const submit = () => {
    if (reduceOnly) return onReduce?.({ size });
    if (maker) {
      onMaker?.({
        isLong: side === "long", size, collateral: calc.debit,
        price: Number(limitPrice), maker: true,
      });
      setLimitPrice("");
    } else if (mode === "limit") {
      onLimit?.({
        isLong: side === "long", size, collateral: calc.debit,
        triggerPrice: Number(limitPrice),
        expiryTs: tif === "gtc" ? 0 : Math.floor(Date.now() / 1000) + TIF[tif],
      });
      setLimitPrice("");
    } else {
      onOrder({ isLong: side === "long", size, collateral: calc.debit });
    }
  };

  // "Buy / Long" describes a fill. This places an order into the next batch,
  // and the button should not promise more than that.
  const cta = submitLabel
    ? submitLabel
    : reduceOnly ? `Reduce ${pos?.isLong ? "Long" : "Short"}`
    : maker ? (side === "long" ? "Post Buy Order" : "Post Sell Order")
    : mode === "limit" ? (side === "long" ? "Place Buy Order" : "Place Sell Order")
    : side === "long" ? "Buy / Long" : "Sell / Short";

  return (
    <aside className={mobile
      // Inside the sheet the panel is the sheet: no border, no width, no
      // scroller of its own. The sheet already owns all three.
      ? "flex flex-col bg-panel"
      : card
        // In the rail it is an object on the page, the /list card: the page
        // scrolls it, so it has no scroller, and it is bounded on all four
        // sides rather than hung off a shared edge.
        ? "flex flex-col overflow-hidden rounded-[14px] border-b border-line bg-panel"
        : "pane-scroll flex w-[262px] flex-none flex-col border-l border-line bg-panel xl:w-[296px]"}>

      {/*
       * Leverage and margin mode as chips above everything else, the way a
       * perps ticket states them: settings the order is placed under, read at
       * a glance and changed rarely, so they take one short row rather than
       * two labelled fields. Isolated is not a choice (every position posts
       * its own collateral and is liquidated on its own), so its chip only
       * explains; the leverage chip opens the slider under it.
       */}
      <div className="px-5 pt-5">
        <div className="flex items-center gap-2">
          <Tooltip content="Each position risks only its own collateral" side="bottom">
            <span className={`${CHIP} cursor-default`}>Isolated</span>
          </Tooltip>
          <button type="button" onClick={() => setLevOpen((o) => !o)} aria-expanded={levOpen}
            aria-label={`Leverage ${levText(L)}`}
            className={`${CHIP} gap-1 ${levOpen
              ? "border-foreground bg-foreground text-background"
              : "hover:border-foreground/40"}`}>
            <span className="n">{levText(L)}</span>
            <ChevronDown className={`size-3.5 transition-transform ${levOpen ? "rotate-180" : ""}`} />
          </button>
        </div>

        <AnimatePresence initial={false}>
          {levOpen && (
            <motion.div key="lev"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={reduceMotion ? { duration: 0 } : { duration: 0.22, ease: EASE_OUT }}
              className="overflow-hidden">
              <div className="pt-4">
                <RangeSlider value={L} onValueChange={setLev} min={1.1} max={maxLev} step={0.1}
                  aria-label="Leverage" formatValueText={(v) => `${v.toFixed(1)}x`} />
                {/* The ends of the range, so a thumb at the far right reads as
                    "this market's maximum" rather than as a slider stuck. */}
                <div className="mt-1.5 flex justify-between text-[11.5px] text-dim">
                  <span className="n">1.1x</span>
                  <span className="n">{maxLev}x max</span>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/*
       * The side is the first decision, so it leads, full width: two pills in
       * a quiet tray. The chosen one fills with the side's own colour, the
       * one place the ticket uses colour at all, so that "long" and "short"
       * are told apart by more than a word before the button repeats it.
       */}
      <div className="px-5 pt-4">
        <Tabs value={side} onValueChange={(v) => setSide(v as "long" | "short")}>
          <TabsList className={`grid w-full grid-cols-2 rounded-full border border-line p-1
                                [&_[data-tabs-indicator]]:transition-colors ${side === "long"
            ? "[&_[data-tabs-indicator]]:bg-up" : "[&_[data-tabs-indicator]]:bg-down"}`}>
            <TabsTrigger value="long"
              className={`w-full text-[14px] ${mobile ? "h-11" : "h-10"}`}>Long</TabsTrigger>
            <TabsTrigger value="short"
              className={`w-full text-[14px] ${mobile ? "h-11" : "h-10"}`}>Short</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      <div className="px-5 pt-5">
        {/* The order type, as the /list tab row: pills, the chosen one
            inverted, no tray. */}
        <Tabs value={mode} onValueChange={(v) => setMode(v as "market" | "limit")}>
          <TabsList>
            <TabsTrigger value="market" className={mobile ? "h-10" : ""}>Market</TabsTrigger>
            <TabsTrigger value="limit" className={mobile ? "h-10" : ""}>Limit</TabsTrigger>
          </TabsList>
        </Tabs>

        {onFund && avail === 0 && (
          // Inverted, because with nothing to trade with it is the one thing
          // this ticket can do: every other control waits on it.
          <button type="button" onClick={onFund} disabled={busy}
            className="press mt-4 h-10 w-full rounded-full bg-foreground text-[13.5px]
                       font-medium text-background transition-opacity hover:opacity-90
                       disabled:opacity-40">
            Get test USDC
          </button>
        )}

        {(account?.address || pos) && (
          <div className="mt-3">
            {account?.address && <KV k="Available to Trade">{money(avail)}</KV>}
            {/* Only when there is one. "Current Position 0 SPYx" is a row that
                exists to say nothing is there, which the rest of the ticket
                already says. */}
            {pos && (
              <KV k="Current Position">
                {`${pos.isLong ? "+" : "-"}${(pos.size / pos.mark).toFixed(4)} ${m.symbol}`}
              </KV>
            )}
          </div>
        )}

        <div className="mt-4 space-y-4">
          {mode === "limit" && (
            <Field
              label="Limit Price" unit="USD" value={limitPrice} onChange={setLimitPrice}
              placeholder={((m.bid + m.ask) / 2).toFixed(2)}
              trailing={
                <button type="button" onClick={() => setLimitPrice(((m.bid + m.ask) / 2).toFixed(2))}
                  className="flex-none rounded-full border border-line px-2.5 py-[3px] text-[11px]
                             font-medium text-muted-foreground transition-colors
                             hover:border-foreground/40 hover:text-foreground">
                  Mid
                </button>
              } />
          )}

          <Field
            label="Amount" value={amount} onChange={setAmount} placeholder="0" grouped
            unit={denom === "usd" ? "USD" : m.symbol} min={0}
            trailing={
              <button type="button" onClick={swap} aria-label="Switch amount unit"
                className="flex-none text-dim transition-colors hover:text-foreground">
                <ArrowLeftRight className="size-3.5" />
              </button>
            } />
        </div>

        {/*
         * The size as a share of what this order can be. Typing a figure is
         * how a trader who knows the number works; the slider and its steps
         * are for the one who thinks "half my balance", and they read back
         * whatever was typed, so the two never disagree. Measured at the
         * chosen leverage, so raising leverage moves the thumb left.
         */}
        <div className="mt-3">
          <RangeSlider value={pct} onValueChange={setPct} min={0} max={100} step={1}
            showTicks={false} disabled={maxSize <= 0} className="h-8"
            aria-label="Size, percent of max" formatValueText={(v) => `${Math.round(v)}%`} />
          <div className="mt-2 grid grid-cols-4 gap-1.5">
            {[25, 50, 75, 100].map((p) => {
              const on = maxSize > 0 && Math.abs(pct - p) < 0.5;
              return (
                <button key={p} type="button" disabled={maxSize <= 0} onClick={() => setPct(p)}
                  className={`n h-7 rounded-full border text-[12px] font-medium transition-colors
                              disabled:opacity-35 pointer-coarse:h-9 ${on
                    ? "border-foreground bg-foreground text-background"
                    : "border-line text-muted-foreground hover:border-foreground/40 hover:text-foreground"}`}>
                  {p === 100 ? "Max" : `${p}%`}
                </button>
              );
            })}
          </div>
        </div>

        {onMaker && (
          <div className="mt-4">
            <Checkbox
              checked={postOnly && mode === "limit"} onCheckedChange={setPostOnly}
              // A maker names its own price; at market there is none to rest at.
              disabled={mode !== "limit" || reduceOnly}
              label="Post only" aria-label="Post only" className={CHECK}
              aria-describedby={mode === "limit" ? `${uid}-post-hint` : undefined} />
            {mode === "limit" && (
              <p id={`${uid}-post-hint`} className="mt-1 pl-[28px] text-[12px] text-dim">
                Rests as a maker. Trades only against takers, never the pool.
              </p>
            )}
          </div>
        )}

        <div className={`mt-4 flex items-center justify-between
                         ${onReduce ? "" : "hidden"}`}>
          <Checkbox
            checked={reduceOnly} onCheckedChange={setReduceOnly}
            // A resting reduce-only order would have to be a close order the
            // keeper fills later; the program's standing orders are the
            // take-profit and the stop, which are exactly that and live below.
            disabled={mode === "limit"} label="Reduce Only" aria-label="Reduce Only"
            className={CHECK} />
          {/* A maker order has no expiry of its own: it lasts one batch and
              is refunded if nobody crosses it, so TIF is only offered for the
              limit. */}
          {mode === "limit" && !maker && (
            <label className="flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
              TIF
              <span className="relative flex items-center">
                <select value={tif} onChange={(e) => setTif(e.target.value as Tif)}
                  aria-label="Time in force"
                  className="appearance-none bg-transparent pr-4 text-[12.5px] font-medium
                             text-foreground outline-none [&>option]:bg-panel2">
                  <option value="gtc">GTC</option>
                  <option value="1h">1H</option>
                  <option value="1d">1D</option>
                </select>
                <ChevronDown className="pointer-events-none absolute right-0 size-3 text-dim" />
              </span>
            </label>
          )}
        </div>

        {/* Only offered when there is a position to protect: a stop with
            nothing behind it is an order that can never fill. */}
        {onTrigger && (
          <div className="mt-3">
            <Checkbox
              checked={tpsl && !!pos} onCheckedChange={setTpsl} disabled={!pos}
              label="Take Profit / Stop Loss" aria-label="Take Profit / Stop Loss"
              className={CHECK}
              aria-describedby={pos ? undefined : `${uid}-tpsl-hint`} />
            {!pos && (
              <p id={`${uid}-tpsl-hint`} className="mt-1 pl-[28px] text-[12px] text-dim">
                Available once you hold {m.symbol}.
              </p>
            )}
          </div>
        )}

        <AnimatePresence initial={false}>
          {tpsl && pos && onTrigger && (
            <motion.div key="tpsl"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={reduceMotion ? { duration: 0 } : { duration: 0.22, ease: EASE_OUT }}
              className="overflow-hidden">
              <fieldset className="mt-4 min-w-0 rounded-[16px] border border-line px-4 pb-3 pt-1">
                <legend className="px-1.5 text-[13px] text-foreground">Triggers</legend>
                <div className="-mt-0.5 mb-2 text-right text-[11.5px] text-dim">
                  mark {pos.mark.toFixed(2)}
                </div>

                {(["tp", "sl"] as const).map((kind) => {
                  const standing = account?.orders.find(
                    (o) => o.symbol === m.symbol && o.slot === (kind === "tp" ? 0 : 1));
                  return (
                    <div key={kind} className="mb-2 flex items-center gap-2">
                      <span className="w-[26px] text-[12px] text-muted-foreground">
                        {kind === "tp" ? "TP" : "SL"}
                      </span>
                      {standing ? (
                        <>
                          <span className="n flex-1 text-[12.5px] font-semibold">
                            {standing.triggerPrice.toFixed(2)}
                            <span className="ml-1.5 font-normal text-dim">
                              {standing.triggerAbove ? "or above" : "or below"}
                            </span>
                          </span>
                          <button type="button" disabled={busy}
                            onClick={() => onCancelTrigger?.(standing.slot)}
                            className="press h-8 rounded-full border border-line px-3 text-[12px]
                                       font-medium text-down transition-colors
                                       hover:border-foreground/40 disabled:opacity-40">
                            Cancel
                          </button>
                        </>
                      ) : (
                        <>
                          <input
                            type="number"
                            aria-label={kind === "tp" ? "Take profit price" : "Stop loss price"}
                            placeholder={(pos.mark * (kind === "tp"
                              ? (pos.isLong ? 1.1 : 0.9)
                              : (pos.isLong ? 0.95 : 1.05))).toFixed(2)}
                            value={triggers[kind]}
                            onChange={(e) => setTriggers({ ...triggers, [kind]: e.target.value })}
                            className="n h-9 min-w-0 flex-1 rounded-[10px] border border-line
                                       bg-panel2 px-3 text-[12.5px] outline-none transition-colors
                                       placeholder:text-dim focus:border-foreground/40" />
                          <button
                            type="button"
                            disabled={busy || !Number(triggers[kind])}
                            onClick={() => {
                              onTrigger({ kind, triggerPrice: Number(triggers[kind]), isLong: pos.isLong });
                              setTriggers({ ...triggers, [kind]: "" });
                            }}
                            className="press h-9 rounded-full bg-foreground px-4 text-[12.5px]
                                       font-medium text-background transition-opacity
                                       hover:opacity-90 disabled:opacity-35">
                            Set
                          </button>
                        </>
                      )}
                    </div>
                  );
                })}
              </fieldset>
            </motion.div>
          )}
        </AnimatePresence>

        <button
          type="button"
          disabled={busy || size <= 0 || !!warn || stale
            || (mode === "limit" && !reduceOnly && !Number(limitPrice))}
          // Filled with the side's colour, the same as the switch above it.
          // The page's background ink is dark on the bright dark-theme green
          // and red and pale on the deeper light-theme ones, so it clears
          // both without a colour of its own.
          onClick={submit}
          className={`press mt-5 flex min-h-[48px] w-full items-center justify-center rounded-full
                      px-4 text-center font-medium transition-opacity ${warn
            ? "border border-down/30 bg-down/[.06] text-[13px] text-down"
            : `${side === "long" ? "bg-up" : "bg-down"} text-[14px] text-background
               hover:opacity-90 disabled:opacity-35`}
                      disabled:pointer-events-none`}>
          {/* The reason the order cannot go is said on the button itself, not
              under a greyed one: one place to look, and it reads as a state
              rather than an error stacked on a dead control. */}
          {warn || cta}
        </button>
      </div>

      <div className="mt-2 border-t border-line bg-panel2 px-5 py-1.5">
        <KV k="Liquidation Price">
          {size > 0 && calc.liq > 0 && !reduceOnly ? money(calc.liq) : "N/A"}
        </KV>
        <KV k="Order Value">{size > 0 ? money(size) : "N/A"}</KV>
        <KV k="Margin Required">{size > 0 && !reduceOnly ? money(calc.debit) : "N/A"}</KV>
        {/* A listed market still seasoning holds every order for its opening
            batch, so "within 5s" would be the wrong promise. */}
        <KV k="Fill">{maker ? "This batch, if a taker crosses"
          : m.observed && !m.observed.seasoned ? "Opening auction" : "Next batch, within 5s"}</KV>
        <KV k="Fees">{(m.openFeeBps / 100).toFixed(4)}% / {money(calc.fee)}</KV>
      </div>

      {!card && onPool && <PoolPanel onPool={onPool} busy={busy} mobile={mobile} bordered />}

      {!card && account && <AccountPanel account={account} bordered />}
    </aside>
  );
}

/*
 * Putting money into the pool, and what the account is worth.
 *
 * Neither is placing an order, and neither was ever a section of the order
 * ticket. They were simply the next thing down the same card, which is how
 * the rail became one nine-hundred-pixel scroll holding four unrelated jobs.
 * Split out, the page can give each one its own box and its own heading, and
 * the ticket goes back to being a ticket.
 *
 * `bordered` is for the two places they are still rendered inline: the
 * phone's sheet and the old docked rail, where there is no box around them
 * and the rule above is what separates them from the order.
 */
export function PoolPanel({ onPool, busy, mobile = false, bordered = false }: {
  onPool: (kind: "deposit" | "withdraw", amount: number) => void;
  busy: boolean;
  mobile?: boolean;
  bordered?: boolean;
}) {
  const [poolAmt, setPoolAmt] = useState(25000);
  return (
    <div className={`flex flex-col gap-4 px-5 py-5 ${
      bordered ? "border-t border-line" : ""}`}>
      <Field
        label="Pool Amount" unit="USD" value={String(poolAmt)} min={1} step={1000} grouped
        onChange={(v) => setPoolAmt(Number(v) || 0)}
        trailing={
          <Stepper value={poolAmt} min={1} step={1000} onChange={setPoolAmt}
            label="pool amount" />
        } />
      {/* The /list pair: the inverted pill for the way in, the outlined one
          for the way out. */}
      <div className="grid grid-cols-2 gap-2">
        <button type="button" onClick={() => onPool("deposit", poolAmt)} disabled={busy}
          className={`press rounded-full bg-foreground text-[13.5px] font-medium
                      text-background transition-opacity hover:opacity-90
                      disabled:pointer-events-none disabled:opacity-35 ${
            mobile ? "h-[46px]" : "h-[44px]"}`}>
          Deposit</button>
        <button type="button" onClick={() => onPool("withdraw", poolAmt)} disabled={busy}
          className={`press rounded-full border border-line text-[13.5px] font-medium
                      transition-colors hover:border-foreground/40 disabled:opacity-35 ${
            mobile ? "h-[46px]" : "h-[44px]"}`}>
          Withdraw</button>
      </div>
    </div>
  );
}

export function AccountPanel({ account, bordered = false, compact = false }: {
  account: Account; bordered?: boolean;
  /// The terminal's cut: what the account can still trade with, and the pool
  /// as one line pointing at Earn, where depositing lives now. Pool-wide
  /// figures (utilization, insurance) are the book's to show, not the account's.
  compact?: boolean;
}) {
  if (compact) {
    return (
      <div className="px-5 py-1">
        <KV k="Portfolio Value">
          <NumberTicker value={account.equity} prefix="$" locale
            format={(v) => v.toLocaleString(undefined, { maximumFractionDigits: 2, minimumFractionDigits: 2 })} />
        </KV>
        <KV k="Available">{money(account.usdc)}</KV>
        <KV k="Unrealized PnL">
          <span className={tone(account.unrealized)}>{money(account.unrealized)}</span>
        </KV>
        <KV k="Account Ratio">
          {account.equity > 0 ? ((account.margin / account.equity) * 100).toFixed(2) : "0.00"}%
        </KV>
        <KV k="Pool">
          <a href="/earn" className="inline-flex items-center gap-1 font-medium text-foreground
                                     underline-offset-4 hover:underline">
            {account.lp.value > 0 ? `${money(account.lp.value)} on Earn` : "Deposit on Earn"}
            <ChevronRight size={13} className="text-muted-foreground" />
          </a>
        </KV>
      </div>
    );
  }
  return (
    <div className={`px-5 py-2 ${bordered ? "border-t border-line pt-4" : ""}`}>
      {bordered && (
        <div className="mb-1 text-[13.5px] font-medium">Unified Account Summary</div>
      )}
      <KV k="Account Ratio">
        {account.equity > 0 ? ((account.margin / account.equity) * 100).toFixed(2) : "0.00"}%
      </KV>
      <KV k="Portfolio Value">
        <NumberTicker value={account.equity} prefix="$" locale
          format={(v) => v.toLocaleString(undefined, { maximumFractionDigits: 2, minimumFractionDigits: 2 })} />
      </KV>
      <KV k="Unrealized PnL">
        <span className={tone(account.unrealized)}>{money(account.unrealized)}</span>
      </KV>
      <KV k="LP Position">{money(account.lp.value)}</KV>
      <KV k="Pool Utilization">
        {account.pool.utilization.toFixed(2)}% / {account.pool.maxUtilization}%
      </KV>
      <KV k="Insurance Fund">{money(account.pool.insurance)}</KV>
    </div>
  );
}
