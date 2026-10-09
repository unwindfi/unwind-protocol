/*
 * Resting orders, checked against the account: a limit away from the
 * market, the same limit moved closer (the site replaces a standing limit in
 * the same transaction), the limit canceled with its collateral back, then a
 * post-only maker quote. A limit that fires before it is canceled is checked
 * as a fill instead: never worse than its price, at its batch's one clearing
 * price.
 *
 * A maker quote lives one batch (one second). The batch is read from the
 * moment it is placed, for the quote resting there as this wallet's maker
 * order; then it either filled at the flow's clearing price or lapsed and
 * its margin came back.
 */
import { live, openTrade, parseMoney, setLeverage, submitButton, ticket, ticketNote, type Journey } from "./common";
import * as fu from "./followup";
import { freeMarket } from "./lifecycle";
import { accountTab, acct, batchOf, checkClearingPrice, checkHistory, closeVia, fillsOf, fmtPrice, freshMarkets,
  parsePrice, priceTick, rowFor, settled, until, type Account, type MarketFull, type TxResult, connected } from "./venue";
import type { Ctx } from "../session";

const NAME = "makers";
const LIMIT_USD = 20;
const MAKER_USD = 15;
const LEV = 2;

interface State { sym: string; isLong: boolean; px?: number; collateral?: number; misses?: number; placedAt?: number }

const limitOf = (a: Account | null, sym: string) => a?.orders.find((o) => o.symbol === sym && o.kind === 1);

export const makers: Journey = {
  name: NAME,
  budgetMs: 180_000,
  wallet: true,
  async run(ctx) {
    // The Open orders tab, where limits are canceled, is not on the phone.
    if (ctx.phone) return;
    const id = ctx.persona.id;
    const plan = fu.get<State>(id, NAME);
    const stage = plan?.stage ?? "limit";

    let m: MarketFull | null;
    let s: State;
    if (stage === "limit") {
      m = await ctx.step("pick a market", () => freeMarket(ctx, LIMIT_USD));
      if (!m) return;
      s = { sym: m.symbol, isLong: ctx.rng.chance(0.5) };
    } else {
      s = plan!.data;
      m = (await freshMarkets(ctx)).find((x) => x.symbol === s.sym) ?? null;
      if (!m) return fu.clear(id, NAME);
    }
    await openTrade(ctx, m);
    await connected(ctx);
    const a0 = await acct(ctx);
    if (!a0) return;

    if (stage === "limit" || stage === "amend") {
      const prev = limitOf(a0, s.sym);
      if (stage === "amend" && !prev) return fired(ctx, m, s, a0);
      const away = stage === "limit" ? 0.03 : 0.004;
      const mid = (m.bid + m.ask) / 2 || m.price;
      const px = Number(fmtPrice(s.isLong ? mid * (1 - away) : mid * (1 + away)));
      const r = await placeLimit(ctx, m, s.isLong, px, LIMIT_USD, false);
      if (!(await carryOn(ctx, r, stage, s))) return;
      const at = (p: number) => Math.abs(p - px) <= priceTick(px) * 1.01;
      // The moved limit sits near the mark and may fire before it is read.
      const a = await ctx.step("watch it rest", () => settled(ctx, (x) => {
        const o = limitOf(x, s.sym);
        return !!o && at(o.triggerPrice) || x.orderFills.some((f) => f.symbol === s.sym && at(f.trigger));
      }));
      if (a && !limitOf(a, s.sym)) return fired(ctx, m, { ...s, px }, a);
      if (!a) {
        await ctx.rec.issue("order-missing", "high", `${NAME}: limit at ${px} on ${s.sym} confirmed but not in /api/account's orders after 30s`, { key: `${NAME} ${stage} not listed` });
        return fu.clear(id, NAME);
      }
      const o = limitOf(a, s.sym)!;
      const n = a.orders.filter((x) => x.symbol === s.sym && x.kind === 1).length;
      if (n !== 1) await ctx.rec.issue("order-duplicate", "high", `${NAME}: ${n} limits on ${s.sym} after ${stage === "amend" ? "moving one (the site replaces it)" : "placing one"}`, { key: `${NAME} ${stage} count` });
      if (o.isLong !== s.isLong || Math.abs(o.sizeUsd - LIMIT_USD) > 0.011) {
        await ctx.rec.issue("number-mismatch", "high", `${NAME}: limit ${s.isLong ? "buy" : "sell"} $${LIMIT_USD} rests as ${o.isLong ? "buy" : "sell"} $${o.sizeUsd}`, { key: `${NAME} limit fields` });
      }
      // The escrow: the new collateral out, the replaced one back.
      const moved = a0.usdc - a.usdc;
      const expect = o.collateralUsd - (prev?.collateralUsd ?? 0);
      if (Math.abs(moved - expect) > 0.02) {
        await ctx.rec.issue("number-mismatch", "high", `${NAME}: ${stage} moved $${moved.toFixed(4)} of USDC; escrow says $${expect.toFixed(4)}`, { key: `${NAME} ${stage} escrow` });
      }
      await ctx.step("watch Open orders", () => checkRow(ctx, s.sym, s.isLong, o.triggerPrice, o.sizeUsd));
      fu.next<State>(id, NAME, stage === "limit" ? "amend" : "cancel", fu.txReadyAt(id),
        { ...s, px, collateral: o.collateralUsd, misses: 0, placedAt: Date.now() }, stage === "limit" ? Date.now() : undefined);
      return;
    }

    if (stage === "cancel") {
      const o = limitOf(a0, s.sym);
      if (!o) return fired(ctx, m, s, a0);
      const r = await ctx.step("cancel the limit", async (): Promise<TxResult> => {
        await accountTab(ctx, "Open orders");
        const row = ctx.page.getByRole("row").filter({ hasText: s.sym }).filter({ hasText: /Limit (buy|sell)/ }).first();
        if (!(await row.isVisible().catch(() => false))) return "blocked";
        return ctx.tx("cancel", () => ctx.click(row.getByRole("button", { name: "Cancel", exact: true }), "Cancel on the limit"));
      });
      if (!(await carryOn(ctx, r, stage, s))) return;
      const a = await ctx.step("watch it go", () => settled(ctx, (x) => !limitOf(x, s.sym)));
      if (!a) {
        await ctx.rec.issue("order-stuck", "high", `${NAME}: canceled the limit on ${s.sym}; /api/account still lists it 30s later`, { key: `${NAME} cancel` });
        return fu.clear(id, NAME);
      }
      const back = a.usdc - a0.usdc;
      if (Math.abs(back - o.collateralUsd) > 0.02) {
        await ctx.rec.issue("number-mismatch", "high", `${NAME}: canceling a limit with $${o.collateralUsd} escrowed returned $${back.toFixed(4)}`, { key: `${NAME} cancel refund` });
      }
      await ctx.step("watch it leave Open orders", async () => {
        const gone = await until(ctx, async () => !(await rowFor(ctx, s.sym, (c) => /^Limit/.test(c["Type"] ?? ""))), 10_000);
        if (!gone) await ctx.rec.issue("stale-row", "medium", `${NAME}: the canceled limit on ${s.sym} is still on Open orders`, { key: `${NAME} cancel row` });
      });
      fu.next<State>(id, NAME, "maker", fu.txReadyAt(id), { ...s, misses: 0 });
      return;
    }

    if (stage === "maker") {
      if (a0.positions[s.sym] && a0.positions[s.sym].isLong !== s.isLong) return fu.clear(id, NAME);
      const mid = (m.bid + m.ask) / 2 || m.price;
      // At the mid: inside the house's quotes, so any taker on the other side
      // in that batch crosses it.
      const px = Number(fmtPrice(mid));
      let rested = false, poll = true;
      const watcher = (async () => {
        while (poll) {
          const b = await batchOf(ctx, s.sym);
          if (b?.resting?.some((o) => o.mine && o.isMaker && o.isBid === s.isLong)) rested = true;
          await new Promise((r) => setTimeout(r, 300));
        }
      })();
      const sent = Date.now();
      let r: TxResult;
      try {
        r = await placeLimit(ctx, m, s.isLong, px, MAKER_USD, true);
        if (r === "confirmed") await ctx.page.waitForTimeout(4_000);
      } finally {
        poll = false;
        await watcher;
      }
      if (!(await carryOn(ctx, r, stage, s))) return;
      const fill = await until(ctx, async () => (await fillsOf(ctx)).find((f) => f.symbol === s.sym && f.kind === "open" && f.t >= sent - 2_000), 8_000);
      if (fill) {
        // A maker bid meets taker sells, so it fills at the sell flow's price.
        const worse = s.isLong ? fill.price > px + priceTick(px) : fill.price < px - priceTick(px);
        if (worse) await ctx.rec.issue("fill-past-limit", "high", `${NAME}: maker ${s.isLong ? "bid" : "ask"} at ${px} filled at ${fill.price}`, { key: `${NAME} maker past limit`, shot: false });
        const b = await batchOf(ctx, s.sym);
        const clear = s.isLong ? b?.last?.sellPrice : b?.last?.buyPrice;
        if (b?.last && Math.abs(b.last.t - fill.t) < 1_500 && clear != null && Math.abs(clear - fill.price) > fill.price * 1e-9) {
          await ctx.rec.issue("clearing-price-split", "high", `${NAME}: maker filled at ${fill.price}; that batch's ${s.isLong ? "sell" : "buy"} flow cleared at ${clear}`, { key: `${NAME} maker clear`, shot: false });
        }
        await checkClearingPrice(ctx, NAME, fill);
        await checkHistory(ctx, NAME, s.sym, "open", sent);
        fu.note(NAME, id, `maker ${s.isLong ? "bid" : "ask"} on ${s.sym} at ${px} filled at ${fill.price}${rested ? "" : " (not seen resting)"}`);
        fu.next<State>(id, NAME, "cleanup", fu.txReadyAt(id), s);
        return;
      }
      // Unfilled, the margin comes back at settlement.
      const a = await settled(ctx, (x) => Math.abs(x.usdc - a0.usdc) <= 0.02, 20_000);
      if (!a) {
        const now = await acct(ctx);
        await ctx.rec.issue("maker-refund", "high", `${NAME}: maker quote on ${s.sym} did not fill, and USDC is ${now?.usdc} against ${a0.usdc} before it`, { key: `${NAME} maker refund` });
      }
      if (!rested) {
        await ctx.rec.issue("maker-not-resting", "medium", `${NAME}: maker quote on ${s.sym} confirmed but never seen in /api/batch as this wallet's maker order`, { key: `${NAME} maker resting`, shot: false });
      }
      fu.note(NAME, id, `maker ${s.isLong ? "bid" : "ask"} on ${s.sym} at ${px} lapsed unfilled${rested ? " after resting" : ""}`);
      if (a0.positions[s.sym]) fu.next<State>(id, NAME, "cleanup", fu.txReadyAt(id), s);
      else fu.clear(id, NAME);
      return;
    }

    if (stage === "cleanup") {
      if (!a0.positions[s.sym]) return fu.clear(id, NAME);
      const r = await closeVia(ctx, s.sym, null);
      if (r === "skipped") { fu.next<State>(id, NAME, "cleanup", fu.txReadyAt(id), s); return; }
      fu.clear(id, NAME);
    }
  },
};

/// The limit was gone before it could be moved or canceled: it fired.
async function fired(ctx: Ctx, m: MarketFull, s: State, a: Account) {
  const id = ctx.persona.id;
  const f = a.orderFills.find((x) => x.symbol === s.sym && s.px != null && Math.abs(x.trigger - s.px) <= priceTick(s.px) * 1.01);
  if (!f || f.expired) {
    fu.note(NAME, id, `limit on ${s.sym} gone with no fill${f?.expired ? " (expired)" : ""}`);
    return fu.clear(id, NAME);
  }
  const fill = await checkHistory(ctx, NAME, s.sym, "open", f.t);
  if (fill && s.px != null) {
    const worse = s.isLong ? fill.price > s.px + priceTick(s.px) : fill.price < s.px - priceTick(s.px);
    if (worse) await ctx.rec.issue("fill-past-limit", "high", `${NAME}: limit ${s.isLong ? "buy" : "sell"} at ${s.px} filled at ${fill.price}`, { key: `${NAME} limit past price`, shot: false });
    await checkClearingPrice(ctx, NAME, fill);
  }
  if (!a.positions[s.sym]) await ctx.rec.issue("position-missing", "high", `${NAME}: limit on ${s.sym} fired at ${f.price} but no position followed`, { key: `${NAME} fired no position` });
  fu.note(NAME, id, `limit on ${s.sym} at ${s.px} fired at ${f.price}${fill ? `, filled at ${fill.price}` : ""}`);
  fu.next<State>(id, NAME, a.positions[s.sym] ? "cleanup" : "maker", fu.txReadyAt(id), s);
}

/// The Limit tab, priced and sized; `post` ticks Post only (a maker quote).
async function placeLimit(ctx: Ctx, m: MarketFull, isLong: boolean, px: number, usd: number, post: boolean): Promise<TxResult> {
  const side = isLong ? "long" : "short";
  const t = await ctx.step("open the ticket", () => ticket(ctx, side));
  await ctx.step("switch to Limit", async () => {
    await ctx.click(t.getByRole("tab", { name: isLong ? "Long" : "Short", exact: true }), `the ${side} tab`, { expectChange: false });
    await ctx.click(t.getByRole("tab", { name: "Limit", exact: true }), "the Limit tab", { expectChange: false });
    await ctx.ready(t.getByRole("spinbutton", { name: "Limit price" }), "the limit price field");
  });
  await ctx.step("price and size", async () => {
    await ctx.type(t.getByRole("spinbutton", { name: "Limit price" }), String(px));
    await setLeverage(ctx, t, LEV, m.maxLeverage);
    await ctx.type(t.getByRole("textbox", { name: "Amount" }), String(usd));
    const box = t.getByRole("checkbox", { name: "Post only, maker only" });
    if (await box.first().isVisible().catch(() => false)) {
      const on = (await box.first().getAttribute("aria-checked")) === "true" || await box.first().isChecked().catch(() => false);
      if (on !== post) await ctx.click(box, "Post only", { expectChange: false });
    } else if (post) {
      throw new Error("no Post only box on the Limit tab");
    }
    const tif = t.getByRole("combobox", { name: "Time in force" });
    if (!post && await tif.first().isVisible().catch(() => false)) await tif.first().selectOption("gtc");
  });
  return ctx.step(post ? "post the quote" : "place the limit", async () => {
    const submit = submitButton(t).first();
    const label = await submit.innerText().catch(() => "");
    const want = post ? new RegExp(`^Post ${side}$`) : new RegExp(`^Place ${side} limit$`);
    if (!want.test(label) || !(await submit.isEnabled().catch(() => false))) {
      if (((await acct(ctx))?.usdc ?? 0) < usd / LEV + 0.5) return "unfunded" as const;
      await ctx.rec.issue("order-blocked", "medium", `${NAME}: "${label}" not pressable for a ${post ? "maker" : "limit"} ${side} $${usd} at ${px}: ${await ticketNote(t)}`, { key: `${NAME} ${post ? "maker" : "limit"} blocked` });
      return "blocked" as const;
    }
    return ctx.tx(post ? "maker" : "limit", () => ctx.click(submit, `"${label}"`));
  });
}

async function checkRow(ctx: Ctx, sym: string, isLong: boolean, px: number, usd: number) {
  await accountTab(ctx, "Open orders");
  const type = isLong ? "Limit buy" : "Limit sell";
  const row = await until(ctx, () => rowFor(ctx, sym, (c) => c["Type"] === type), 10_000);
  if (!row) {
    await ctx.rec.issue("order-missing", "high", `${NAME}: ${type} on ${sym} is in the API but not on the Open orders tab`, { key: `${NAME} limit row` });
    return;
  }
  const trig = parsePrice(row["Trigger"]);
  const size = parseMoney(row["Size"]);
  if (trig != null && Math.abs(trig - px) > Math.max(priceTick(px), px * 1e-4) || size != null && Math.abs(size - usd) > 1.01) {
    await ctx.rec.issue("number-mismatch", "medium", `${NAME}: Open orders shows ${row["Trigger"]} ${row["Size"]}; the API ${px} $${usd}`, { key: `${NAME} limit row figures` });
  }
}

async function carryOn(ctx: Ctx, r: TxResult, stage: string, s: State) {
  const id = ctx.persona.id;
  if (r === "confirmed") return true;
  if (r === "skipped") { if (stage !== "limit") fu.next<State>(id, NAME, stage, fu.txReadyAt(id), s); return false; }
  if (r === "dry" || !live()) return false;
  const misses = (s.misses ?? 0) + 1;
  if (stage === "limit" || misses >= 2) {
    fu.note(NAME, id, `${stage} on ${s.sym} gave ${r}; stopped`);
    // A standing limit is left for the next limit journey to cancel or move.
    return fu.clear(id, NAME), false;
  }
  fu.next<State>(id, NAME, stage, fu.txReadyAt(id), { ...s, misses });
  return false;
}
