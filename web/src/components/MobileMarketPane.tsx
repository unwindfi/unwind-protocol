import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/Tabs";
import type { Market, Trade } from "@/lib/api";
import { compact, hhmmss, pct, tone } from "@/lib/format";
import { fundingPct } from "@/components/market/MarketHead";

/*
 * Everything the header used to cram into two scrolling strips.
 *
 * A label-left / value-right list is the shape a phone reads best: the eye runs
 * down one column of names and one column of numbers, instead of hunting across
 * a row of 9px captions. It also gives each figure room to be 14px, which is
 * the difference between a stat you can read and one you squint at.
 */
function Row({
  k, children, hint,
}: { k: string; children: React.ReactNode; hint?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-t border-line py-3">
      <span className="text-[12.5px] text-muted-foreground">
        {k}
        {hint && <span className="ml-1.5 text-[11px] text-dim">{hint}</span>}
      </span>
      <span className="n text-[13.5px] font-semibold">{children}</span>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="px-4 pb-1 pt-5">
      <div className="mb-2 text-[13.5px] font-medium text-foreground">{title}</div>
      {children}
    </div>
  );
}

export function MobileMarketPane({
  m, trades, utilization,
}: { m: Market; trades: Trade[]; utilization?: number }) {
  const funding = fundingPct(m) / 100;
  const maxLong = Math.max(0, Math.min(m.freeLiquidity, m.capLong));
  const maxShort = Math.max(0, Math.min(m.freeLiquidity, m.capShort));
  const total = maxLong + maxShort || 1;

  return (
    <section className="flex min-h-0 flex-1 flex-col bg-panel">
      <Tabs defaultValue="overview" className="flex min-h-0 flex-1 flex-col">
        <div className="flex-none border-b border-line px-3 py-2.5">
          <TabsList>
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="trades">Trades</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="overview" className="pane-scroll mt-0 min-h-0 flex-1 pb-4">
          <Section title="Price">
            <Row k="Oracle" hint="index">{m.price.toFixed(2)}</Row>
            <Row k="Bid"><span className="text-down">{m.bid.toFixed(2)}</span></Row>
            <Row k="Ask"><span className="text-up">{m.ask.toFixed(2)}</span></Row>
            <Row k="Spread">{(m.ask - m.bid).toFixed(2)} · {(m.spreadBps / 100).toFixed(2)}%</Row>
            <Row k="24h change">
              <span className={tone(m.changePct)}>
                {m.change >= 0 ? "+" : ""}{m.change.toFixed(2)} · {pct(m.changePct)}
              </span>
            </Row>
            <Row k="24h range">{m.low.toFixed(2)} – {m.high.toFixed(2)}</Row>
          </Section>

          <Section title="Market">
            <Row k="24h volume">{compact(m.volume24h)}</Row>
            <Row k="Open interest">{compact(m.oi)}</Row>
            <Row k="Funding" hint="per hour">
              <span className={tone(funding)}>{(funding * 100).toFixed(4)}%</span>
            </Row>
            <Row k="Max leverage">{m.maxLeverage}x</Row>
            <Row k="Session">
              {m.session === 2
                ? <span className="text-down">Underlying closed</span>
                : <span className="text-up">Open</span>}
            </Row>
          </Section>

          <Section title="Capacity">
            {/* The pool has no book, so what actually bounds a fill is how much
                size each side can still absorb. */}
            <div className="mb-2 mt-1.5">
              <div className="flex h-[6px] overflow-hidden rounded-full bg-panel3">
                <i className="block h-full bg-up" style={{ width: `${(maxLong / total) * 100}%` }} />
                <i className="block h-full bg-down" style={{ width: `${(maxShort / total) * 100}%` }} />
              </div>
              <div className="mt-1.5 flex justify-between text-[12px]">
                <span className="text-up">{compact(maxLong)} long</span>
                <span className="text-down">short {compact(maxShort)}</span>
              </div>
            </div>
            <Row k="Pool free">{compact(m.freeLiquidity)}</Row>
            <Row k="Utilization">{utilization != null ? `${utilization.toFixed(2)}%` : "–"}</Row>
            <Row k="Long / short">
              {m.longShare.toFixed(0)}% / {(100 - m.longShare).toFixed(0)}%
            </Row>
          </Section>
        </TabsContent>

        <TabsContent value="trades" className="mt-0 flex min-h-0 flex-1 flex-col">
          <div className="grid flex-none grid-cols-3 gap-2 border-b border-line px-4 py-2.5
                          text-[12px] text-muted-foreground">
            <span>Price</span><span className="text-right">Size</span><span className="text-right">Time</span>
          </div>
          <div className="pane-scroll min-h-0 flex-1">
            {trades.length === 0
              ? <div className="p-8 text-center text-[13px] text-dim">No trades yet</div>
              : trades.map((t, i) => (
                <div key={i}
                  className="grid grid-cols-3 gap-2 border-b border-line px-4 py-2.5 text-[13px]">
                  <span className={`n font-medium ${t.side === "buy" ? "text-up" : "text-down"}`}>
                    {t.price.toFixed(2)}
                  </span>
                  <span className="n text-right">{compact(t.size)}</span>
                  <span className="n text-right text-muted-foreground">{hhmmss(t.t)}</span>
                </div>
              ))}
          </div>
        </TabsContent>
      </Tabs>
    </section>
  );
}
