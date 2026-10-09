/*
 * A position from open to close, one signature per visit: open, add to the
 * same side, close part of it, close the rest. After each batch settles the
 * Positions row (size, entry, PnL, margin, funding) is read against
 * /api/account, the fill against /api/fills and the Trade history tab, and
 * its fee against the market's rate.
 *
 * Stages wait for the persona's transaction gap between them (follow-ups,
 * see followup.ts), so the whole thing takes about four turns.
 */
import { live, openTrade, type Journey } from "./common";
import * as fu from "./followup";
import { acct, checkClearingPrice, checkFee, checkHistory, closeVia, comparePosition, freshMarkets, marketOrder,
  priceTick, rowFor, settled, until, type MarketFull, type TxResult, connected } from "./venue";
import type { Ctx } from "../session";

const NAME = "lifecycle";
const OPEN_USD = 30;
const ADD_USD = 20;
const REDUCE_USD = 20;

interface State { sym: string; side: "long" | "short"; lev: number; misses?: number }

/// A tradeable market this wallet holds nothing in and has no orders on,
/// whose pool fills the whole order in one batch. Keeper-priced coins first:
/// they trade around the clock, where an xStock's feed keeps market hours.
export async function freeMarket(ctx: Ctx, usd: number, pick?: (ms: MarketFull[]) => MarketFull | undefined): Promise<MarketFull | null> {
  const [ms, a] = [await freshMarkets(ctx), await acct(ctx)];
  if (!a) return null;
  const ok = ms.filter((m) => !m.hidden && !m.paused && (!m.observed || m.observed.tradeable)
    && (m.priceAgeMs == null || m.priceAgeMs / 1000 < m.maxPriceAgeSec)
    && !a.positions[m.symbol] && !a.orders.some((o) => o.symbol === m.symbol)
    && (m.poolFillUsd == null || m.poolFillUsd >= usd));
  if (!ok.length) return null;
  if (pick) return pick(ok) ?? null;
  const coins = ok.filter((m) => m.observed);
  const pool = coins.length ? coins : ok;
  return pool.find((m) => ctx.persona.favorites.includes(m.symbol)) ?? ctx.rng.pick(pool);
}

export const lifecycle: Journey = {
  name: NAME,
  budgetMs: 180_000,
  wallet: true,
  async run(ctx) {
    const plan = fu.get<State>(ctx.persona.id, NAME);
    const stage = plan?.stage ?? "open";
    const s = plan?.data;
    const id = ctx.persona.id;

    if (stage === "open") {
      const m = await ctx.step("pick a market", () => freeMarket(ctx, OPEN_USD + ADD_USD));
      if (!m) return;
      await openTrade(ctx, m);
      await connected(ctx);
      const side = ctx.rng.chance(0.5) ? "long" : "short";
      const lev = Math.min(m.maxLeverage, Math.max(1.5, ctx.persona.leverage[0]));
      const before = await acct(ctx);
      const [r, why] = await marketOrder(ctx, m, side, OPEN_USD, lev);
      if (!(await carryOn(ctx, r, why, "open", { sym: m.symbol, side, lev }))) return;
      const a = await ctx.step("watch it settle", () => settled(ctx, (x) => (x.positions[m.symbol]?.size ?? 0) >= OPEN_USD * 0.98));
      if (!a) return lost(ctx, m.symbol, `opened $${OPEN_USD}`, before?.usdc);
      await ctx.step("watch the position vs API", () => comparePosition(ctx, NAME, m.symbol));
      await ctx.step("watch the open in history", async () => {
        const f = await checkHistory(ctx, NAME, m.symbol, "open", ctx.lastSend?.at ?? Date.now() - 60_000);
        if (f) { await checkFee(ctx, NAME, m, f); await checkClearingPrice(ctx, NAME, f); }
      });
      fu.next<State>(id, NAME, "add", fu.txReadyAt(id), { sym: m.symbol, side, lev }, Date.now());
      return;
    }

    if (!s) return fu.clear(id, NAME);
    const m = (await freshMarkets(ctx)).find((x) => x.symbol === s.sym);
    const held = (await acct(ctx))?.positions[s.sym];
    if (!m || !held) {
      // Gone between visits: liquidated, deleveraged, or closed by hand.
      fu.note(NAME, id, `${s.sym} position gone before "${stage}"`);
      return fu.clear(id, NAME);
    }
    await openTrade(ctx, m);
    await connected(ctx);

    if (stage === "add") {
      const [r, why] = await marketOrder(ctx, m, s.side, ADD_USD, s.lev);
      if (!(await carryOn(ctx, r, why, "add", s))) return;
      const a = await ctx.step("watch it settle", () => settled(ctx, (x) => (x.positions[s.sym]?.size ?? 0) >= held.size + ADD_USD * 0.98));
      if (!a) return lost(ctx, s.sym, `added $${ADD_USD} to $${held.size}`);
      const f = await ctx.step("watch the add in history", () => checkHistory(ctx, NAME, s.sym, "open", ctx.lastSend?.at ?? Date.now() - 60_000));
      if (f) {
        await checkFee(ctx, NAME, m, f);
        // Blended by size: the new entry lies between the old one and this fill.
        const e = a.positions[s.sym].entry;
        const lo = Math.min(held.entry, f.price) - priceTick(e), hi = Math.max(held.entry, f.price) + priceTick(e);
        if (e < lo || e > hi) {
          await ctx.rec.issue("number-mismatch", "high", `${NAME}: entry after adding is ${e}, outside ${held.entry} (before) and ${f.price} (the add's fill)`, { key: `${NAME} blended entry` });
        }
      }
      await ctx.step("watch the position vs API", () => comparePosition(ctx, NAME, s.sym));
      fu.next<State>(id, NAME, "reduce", fu.txReadyAt(id), s);
      return;
    }

    if (stage === "reduce") {
      const r = await closeVia(ctx, s.sym, REDUCE_USD);
      if (!(await carryOn(ctx, r, "the close dialog refused a partial close", "reduce", s))) return;
      const a = await ctx.step("watch it settle", () => settled(ctx, (x) => !!x.positions[s.sym] && x.positions[s.sym].size <= held.size - REDUCE_USD + 1.01));
      if (!a) return lost(ctx, s.sym, `closed $${REDUCE_USD} of $${held.size}`);
      // A partial close leaves the entry where it was.
      const e = a.positions[s.sym].entry;
      if (Math.abs(e - held.entry) > priceTick(e) * 1.01) {
        await ctx.rec.issue("number-mismatch", "high", `${NAME}: entry moved from ${held.entry} to ${e} on a partial close`, { key: `${NAME} entry after reduce` });
      }
      const f = await ctx.step("watch the close in history", () => checkHistory(ctx, NAME, s.sym, "close", ctx.lastSend?.at ?? Date.now() - 60_000));
      if (f) { await checkFee(ctx, NAME, m, f); await checkClearingPrice(ctx, NAME, f); }
      await ctx.step("watch the position vs API", () => comparePosition(ctx, NAME, s.sym));
      fu.next<State>(id, NAME, "close", fu.txReadyAt(id), s);
      return;
    }

    if (stage === "close") {
      const r = await closeVia(ctx, s.sym, null);
      if (!(await carryOn(ctx, r, "the close dialog refused a full close", "close", s))) return;
      const a = await ctx.step("watch it settle", () => settled(ctx, (x) => !x.positions[s.sym]));
      if (!a) return lost(ctx, s.sym, `closed all $${held.size}`);
      await ctx.step("watch the row go", async () => {
        const gone = await until(ctx, async () => !(await rowFor(ctx, s.sym)), 10_000);
        if (!gone) await ctx.rec.issue("stale-row", "high", `${NAME}: ${s.sym} is still on the Positions tab 10s after the API shows it closed`, { key: `${NAME} row after close` });
      });
      const f = await ctx.step("watch the close in history", () => checkHistory(ctx, NAME, s.sym, "close", ctx.lastSend?.at ?? Date.now() - 60_000));
      if (f) await checkFee(ctx, NAME, m, f);
      fu.note(NAME, id, `${s.sym} ${s.side}: open, add, partial and full close done`);
      fu.clear(id, NAME);
    }
  },
};

/*
 * What a stage does with its transaction's outcome: carry on once it is
 * confirmed; come back later when the gate said wait; give up on a dry run;
 * and after two failed tries drop the plan, leaving what the toasts and the
 * detectors already filed.
 */
async function carryOn(ctx: Ctx, r: TxResult, why: string, stage: string, s: State): Promise<boolean> {
  const id = ctx.persona.id;
  if (r === "confirmed") return true;
  if (r === "skipped") { fu.next<State>(id, NAME, stage, fu.txReadyAt(id), s); return false; }
  if (r === "dry" || r === "unfunded" || !live()) { if (stage === "open") fu.clear(id, NAME); return false; }
  const misses = (s.misses ?? 0) + 1;
  if (r === "blocked") {
    await ctx.rec.issue("order-blocked", "medium", `${NAME}: ${stage} on ${s.sym} not accepted by the page: ${why}`, { key: `${NAME} ${stage} blocked` });
  }
  if (misses >= 2 || stage === "open") { fu.note(NAME, id, `${stage} on ${s.sym} gave ${r} twice; stopped`); fu.clear(id, NAME); return false; }
  fu.next<State>(id, NAME, stage, fu.txReadyAt(id), { ...s, misses });
  return false;
}

/// A confirmed transaction whose batch never showed on the account.
async function lost(ctx: Ctx, sym: string, what: string, usdc?: number) {
  await ctx.rec.issue("position-missing", "high", `${NAME}: ${what} on ${sym}, confirmed, but /api/account did not show it within 30s`, { key: `${NAME} not settled` });
  fu.note(NAME, ctx.persona.id, `${sym}: ${what} never settled${usdc != null ? ` (USDC before ${usdc})` : ""}`);
  fu.clear(ctx.persona.id, NAME);
}
