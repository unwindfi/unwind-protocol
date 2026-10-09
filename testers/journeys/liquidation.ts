/*
 * The liquidation path, on one dedicated persona (LIQ_PERSONA) with a small
 * stake: LIQ_COLLATERAL_USD at the market's highest leverage, on the market
 * most likely to move that far. Then the API is watched (no page) every few
 * minutes for up to LIQ_WATCH_MS. A market that does not move is a result,
 * not a failure: the position is closed and the next turn tries again.
 *
 * When it is liquidated, a fresh visit must show "Position liquidated" once,
 * naming the symbol, the side and what was returned, and a reload must not
 * show it again (fixed in #139). The Liquidations tab must list it.
 *
 * Everything already liquidated before this position is marked as seen in
 * the page's own storage, as a returning visitor's browser would have it, so
 * the notice is about this liquidation alone.
 */
import { config } from "../config";
import { live, openTrade, parseMoney, type Journey } from "./common";
import * as fu from "./followup";
import { freeMarket } from "./lifecycle";
import { accountTab, acct, closeVia, freshMarkets, marketOrder, rowFor, settled, type MarketFull, connected } from "./venue";
import type { Ctx } from "../session";

const NAME = "liquidation";
const WATCH_EVERY_MS = 3 * 60_000;

interface State { sym: string; isLong: boolean; size: number; liqPrice?: number; seenT: number; openedAt: number; until: number }

/*
 * How far the price must go to liquidate, against how far it went in the
 * last day: the market whose day's range covers the most of that distance.
 */
function mostLikely(ms: MarketFull[], usd: number): MarketFull | undefined {
  const score = (m: MarketFull) => {
    const mm = (m.maintenanceMarginBps ?? 1_000) / 1e4;
    const distance = Math.max(0.002, 1 / Math.max(1, m.maxLeverage) - mm);
    const range = m.high && m.low && m.price ? (m.high - m.low) / m.price : 0;
    return range / distance;
  };
  return ms.filter((m) => (m.poolFillUsd ?? Infinity) >= usd * m.maxLeverage)
    .sort((a, b) => score(b) - score(a))[0];
}

export const liquidation: Journey = {
  name: NAME,
  budgetMs: 180_000,
  wallet: true,
  async run(ctx) {
    const id = ctx.persona.id;
    const plan = fu.get<State>(id, NAME);
    const stage = plan?.stage ?? "open";

    if (stage === "open") {
      const usd = config.liqCollateralUsd;
      const m = await ctx.step("pick a volatile market", () => freeMarket(ctx, 0, (ms) => mostLikely(ms, usd)));
      if (!m) return;
      const before = await acct(ctx);
      const lev = m.maxLeverage;
      const size = Math.max(10, Math.floor(usd * lev));
      await openTrade(ctx, m);
      await connected(ctx);
      // Against the day's move, so a market still trending has to come back.
      const side = (m as any).changePct > 0 ? "short" : "long";
      const [r, why] = await marketOrder(ctx, m, side, size, lev);
      if (r === "blocked") await ctx.rec.issue("order-blocked", "medium", `${NAME}: $${size} at ${lev}x on ${m.symbol} not accepted: ${why}`, { key: `${NAME} open blocked` });
      if (r !== "confirmed") return;
      const a = await ctx.step("watch it settle", () => settled(ctx, (x) => !!x.positions[m.symbol]));
      const p = a?.positions[m.symbol];
      if (!p) return;
      fu.next<State>(id, NAME, "watch", Date.now() + WATCH_EVERY_MS, {
        sym: m.symbol, isLong: side === "long", size: p.size, liqPrice: p.liqPrice,
        seenT: before?.liquidations[0]?.t ?? 0, openedAt: Date.now(), until: Date.now() + config.liqWatchMs,
      }, Date.now());
      fu.note(NAME, id, `${side} $${p.size} ${m.symbol} at ${lev}x, entry ${p.entry}, liquidation at ${p.liqPrice}`);
      return;
    }

    const s = plan!.data;
    if (stage === "watch") {
      const a = await acct(ctx);
      if (!a) { fu.next<State>(id, NAME, "watch", Date.now() + WATCH_EVERY_MS, s); return; }
      const liq = a.liquidations.find((l) => l.symbol === s.sym && l.t > s.seenT && l.t >= s.openedAt - 60_000);
      if (liq) return notice(ctx, s, liq);
      if (!a.positions[s.sym]) {
        const adl = a.deleverages.find((d) => d.symbol === s.sym && d.t >= s.openedAt);
        fu.note(NAME, id, `${s.sym} position gone without a liquidation${adl ? " (deleveraged)" : ""}`);
        return fu.clear(id, NAME);
      }
      if (Date.now() < s.until) { fu.next<State>(id, NAME, "watch", Date.now() + WATCH_EVERY_MS, s); return; }
      const p = a.positions[s.sym];
      fu.note(NAME, id, `no liquidation in ${Math.round(config.liqWatchMs / 60_000)} min: ${s.sym} mark ${p.mark}, liquidation at ${p.liqPrice}; closing`);
      fu.next<State>(id, NAME, "cleanup", fu.txReadyAt(id), s);
      return;
    }

    if (stage === "cleanup") {
      const m = (await freshMarkets(ctx)).find((x) => x.symbol === s.sym);
      if (!m || !(await acct(ctx))?.positions[s.sym]) return fu.clear(id, NAME);
      await openTrade(ctx, m);
      await connected(ctx);
      const r = await closeVia(ctx, s.sym, null);
      if (r === "skipped") { fu.next<State>(id, NAME, "cleanup", fu.txReadyAt(id), s); return; }
      if (r === "dry" || !live()) return;
      fu.clear(id, NAME);
    }
  },
};

/*
 * The notice. Toasts are read off the page as they appear (detectors.ts's
 * PAGE_WATCH); the liquidation's is red, so the toast detector also records
 * it as an error toast, which is the page doing its job here.
 */
async function notice(ctx: Ctx, s: State, liq: { t: number; symbol: string; isLong: boolean; returned: number; price: number }) {
  const id = ctx.persona.id;
  const key = `unwind.seenLiq.${ctx.owner}`;
  // Only when the page has nothing stored, so the reload keeps what the
  // page itself wrote after showing the notice.
  await ctx.context.addInitScript(({ key, seen }) => {
    try { if (localStorage.getItem(key) == null) localStorage.setItem(key, String(seen)); } catch { /* blocked */ }
  }, { key, seen: s.seenT });
  const m = (await freshMarkets(ctx)).find((x) => x.symbol === s.sym);
  const count = () => ctx.rec.toasts.filter((t) => /liquidated/i.test(t.text)).length;
  await openTrade(ctx, m ?? null);
  await connected(ctx);
  await ctx.step("wait for the notice", () => ctx.page.waitForTimeout(8_000));
  const first = ctx.rec.toasts.filter((t) => /liquidated/i.test(t.text));
  const side = liq.isLong ? "long" : "short";
  if (first.length !== 1) {
    await ctx.rec.issue("liquidation-notice", "high", `${NAME}: ${first.length} liquidation notices on the first visit after ${s.sym} was liquidated (expected 1)`, { key: `${NAME} notice count` });
  } else {
    const text = first[0].text.replace(/\n+/g, " ");
    const returned = parseMoney(/· (-?\$[\d,.]+) returned/.exec(text)?.[1]);
    const ok = /^Position liquidated\b/.test(text) && text.includes(`${s.sym} ${side}`)
      && returned != null && Math.abs(returned - liq.returned) <= 0.011;
    if (!ok) {
      await ctx.rec.issue("liquidation-notice", "high", `${NAME}: notice reads "${text}"; the API has ${s.sym} ${side}, $${liq.returned.toFixed(2)} returned`, { key: `${NAME} notice text` });
    }
  }
  await ctx.step("wait after a reload", async () => {
    const n = count();
    await ctx.page.reload({ waitUntil: "domcontentloaded" });
    // The notice needs the wallet; a reload that did not reconnect would
    // pass for the wrong reason.
    if (!(await ctx.addressTile().first().waitFor({ state: "visible", timeout: 10_000 }).then(() => true, () => false))) await connected(ctx);
    await ctx.page.waitForTimeout(8_000);
    if (count() > n) {
      await ctx.rec.issue("liquidation-notice", "high", `${NAME}: "Position liquidated" for ${s.sym} came back after a reload`, { key: `${NAME} notice on reload` });
    }
  });
  await ctx.step("watch the Liquidations tab", async () => {
    if (!(await accountTab(ctx, "Liquidations"))) return;
    const row = await rowFor(ctx, s.sym);
    if (!row) {
      await ctx.rec.issue("history-missing", "high", `${NAME}: ${s.sym} liquidation is in the API but not on the Liquidations tab`, { key: `${NAME} tab row` });
      return;
    }
    const ret = parseMoney(row["Returned"]);
    if (row["Side"] && row["Side"].toLowerCase() !== side || ret != null && Math.abs(ret - liq.returned) > 0.011) {
      await ctx.rec.issue("number-mismatch", "high", `${NAME}: Liquidations tab shows ${row["Side"]} ${row["Returned"]}; the API ${side} $${liq.returned}`, { key: `${NAME} tab figures` });
    }
  });
  fu.note(NAME, id, `${s.sym} ${side} liquidated at ${liq.price} after ${Math.round((liq.t - s.openedAt) / 60_000)} min, $${liq.returned} returned`);
  fu.clear(id, NAME);
}
