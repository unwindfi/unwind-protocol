/*
 * A market's last day, shown on hover over its row: the logo, the name and
 * the price, a day of candles, and the day's high and low.
 *
 * It waits a beat before it opens (a pointer crossing the list on its way
 * somewhere else should not set off a card per row), follows the pointer
 * while it is up, and closes the moment the pointer leaves. Bars are read
 * once per market per page and kept. Only where there is a real hover: a
 * touch screen gets nothing.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { TickerLogo } from "@/components/TickerLogo";
import { getCandles, type Market } from "@/lib/api";
import { price } from "@/lib/format";

type Bar = { time: number; open: number; high: number; low: number; close: number };
const cache = new Map<string, Promise<Bar[]>>();
/// Fifteen-minute bars, the last day of them.
const bars = (symbol: string) => {
  let hit = cache.get(symbol);
  if (!hit) {
    hit = getCandles(symbol, 900).then((b) => b.slice(-96)).catch(() => []);
    cache.set(symbol, hit);
  }
  return hit;
};

const canHover = () => typeof window !== "undefined" && window.matchMedia?.("(hover: hover) and (pointer: fine)").matches;
const OPEN_MS = 280;
const W = 300;

/// Wraps a row: hovering it shows the card for `m`.
export function MarketPeek({ m, children }: { m: Market; children: ReactNode }) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const [open, setOpen] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const pos = useRef({ x: 0, y: 0 });
  const raf = useRef(0);

  useEffect(() => () => { clearTimeout(timer.current); cancelAnimationFrame(raf.current); }, []);

  const enter = (e: React.MouseEvent) => {
    if (!canHover()) return;
    pos.current = { x: e.clientX, y: e.clientY };
    void bars(m.symbol);
    timer.current = window.setTimeout(() => { setAt({ ...pos.current }); setOpen(true); }, OPEN_MS);
  };
  const move = (e: React.MouseEvent) => {
    pos.current = { x: e.clientX, y: e.clientY };
    if (!open) return;
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(() => setAt({ ...pos.current }));
  };
  const leave = () => { clearTimeout(timer.current); setOpen(false); };

  return (
    <div onMouseEnter={enter} onMouseMove={move} onMouseLeave={leave} onMouseDown={leave}>
      {children}
      {open && at && createPortal(<Card m={m} at={at} />, document.body)}
    </div>
  );
}

function Card({ m, at }: { m: Market; at: { x: number; y: number } }) {
  const [data, setData] = useState<Bar[] | null>(null);
  const [shown, setShown] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const [h, setH] = useState(330);

  useEffect(() => {
    let live = true;
    bars(m.symbol).then((b) => { if (live) setData(b); });
    const id = requestAnimationFrame(() => setShown(true));
    return () => { live = false; cancelAnimationFrame(id); };
  }, [m.symbol]);
  useLayoutEffect(() => { if (box.current) setH(box.current.offsetHeight); }, [data]);

  // Beside the pointer, flipped to whichever side has room, never off screen.
  const gap = 18;
  const left = at.x + gap + W > window.innerWidth - 12 ? at.x - gap - W : at.x + gap;
  const top = Math.min(Math.max(12, at.y - h / 2), window.innerHeight - h - 12);

  const hi = data && data.length ? Math.max(...data.map((b) => b.high)) : m.high;
  const lo = data && data.length ? Math.min(...data.map((b) => b.low)) : m.low;

  return (
    <div ref={box} role="tooltip"
      style={{ left, top, width: W }}
      className={`pointer-events-none fixed z-[80] rounded-[22px] border border-line bg-panel p-5
                  shadow-[0_24px_60px_-20px_rgba(0,0,0,.35)] transition-[opacity,transform] duration-200
                  ease-out-strong ${shown ? "translate-y-0 scale-100 opacity-100" : "translate-y-1 scale-[.98] opacity-0"}`}>
      <div className="flex items-center gap-3 border-b border-line pb-4">
        <TickerLogo m={m} size={36} />
        <span title={m.name} className="min-w-0 flex-1 truncate text-[15.5px] font-semibold">{m.name}</span>
        <span className="n text-[15px] font-semibold">{price(m.price)}</span>
      </div>
      <div className="py-4">
        {data === null
          ? <div className="h-[170px] animate-pulse rounded-[10px] bg-panel2" />
          : data.length < 2
            ? <div className="grid h-[170px] place-items-center text-center text-[13px] text-muted-foreground">
                Too little history to chart.
              </div>
            : <Candles bars={data} />}
      </div>
      <div className="flex justify-between border-t border-line pt-4">
        <div>
          <div className="text-[12.5px] text-muted-foreground">High</div>
          <div className="n mt-1 text-[14.5px]">{hi > 0 ? price(hi) : "–"}</div>
        </div>
        <div className="text-right">
          <div className="text-[12.5px] text-muted-foreground">Low</div>
          <div className="n mt-1 text-[14.5px]">{lo > 0 ? price(lo) : "–"}</div>
        </div>
      </div>
    </div>
  );
}

/// A day of candles, drawn to fit the card.
function Candles({ bars }: { bars: Bar[] }) {
  const Wd = 260, H = 170, P = 6;
  const hi = Math.max(...bars.map((b) => b.high));
  const lo = Math.min(...bars.map((b) => b.low));
  const span = hi - lo || hi * 0.001 || 1;
  const y = (v: number) => P + (1 - (v - lo) / span) * (H - P * 2);
  const step = Wd / bars.length;
  const body = Math.max(1, step * 0.6);
  return (
    <svg viewBox={`0 0 ${Wd} ${H}`} className="block h-[170px] w-full" preserveAspectRatio="none">
      {bars.map((b, i) => {
        const up = b.close >= b.open;
        const cx = i * step + step / 2;
        const top = y(Math.max(b.open, b.close));
        const bot = y(Math.min(b.open, b.close));
        return (
          <g key={b.time} className={up ? "text-up" : "text-down"}>
            <line x1={cx} x2={cx} y1={y(b.high)} y2={y(b.low)} stroke="currentColor" strokeWidth="1"
              vectorEffect="non-scaling-stroke" opacity=".85" />
            <rect x={cx - body / 2} y={top} width={body} height={Math.max(1, bot - top)} fill="currentColor" rx=".5" />
          </g>
        );
      })}
    </svg>
  );
}
