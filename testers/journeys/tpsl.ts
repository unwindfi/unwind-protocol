/*
 * Take profit and stop loss on one position: set a take profit, set a stop,
 * move the take profit (the ticket has no edit: cancel, then set again, near
 * the mark this time), cancel the stop, then watch whether the take profit
 * fires. After each signature the trigger is read in /api/account's orders,
 * in the ticket's Triggers box and on the Open orders tab.
 *
 * Keeper-priced markets move with the real price, so a take profit 0.2%
 * from the mark often fires within TRIGGER_WATCH_MS. When it does not, that
 * is recorded as a result and the position is closed; the market not moving
 * is never an issue.
 */
import type { Locator } from "playwright-core";
import { config } from "../config";
import { live, openTrade, ticket, type Journey } from "./common";
import * as fu from "./followup";
import { freeMarket } from "./lifecycle";
import { accountTab, acct, checkHistory, closeVia, fmtPrice, freshMarkets, marketOrder, parsePrice, priceTick, rowFor,
  settled, type Account, type Order, type TxResult, connected } from "./venue";
import type { Ctx } from "../session";

const NAME = "tpsl";
const OPEN_USD = 20;
/// Between watches: the keeper checks triggers every 3 seconds, so this is
/// only how often the fleet looks.
const WATCH_EVERY_MS = 3 * 60_000;

type Kind = "tp" | "sl";
interface State { sym: string; isLong: boolean; tp?: number; sl?: number; setAt?: number; watchUntil?: number; misses?: number }

const SLOT: Record<Kind, number> = { tp: 0, sl: 1 };
const above = (k: Kind, isLong: boolean) => (k === "tp") === isLong;
const standingOf = (a: Account | null, sym: string, k: Kind) => a?.orders.find((o) => o.symbol === sym && o.slot === SLOT[k] && o.kind === 0);

export const tpsl: Journey = {
  name: NAME,
  budgetMs: 180_000,
  wallet: true,
  async run(ctx) {
    const id = ctx.persona.id;
    const plan = fu.get<State>(id, NAME);
    const stage = plan?.stage ?? "open";

    if (stage === "open") {
      const m = await ctx.step("pick a market", () => freeMarket(ctx, OPEN_USD));
      if (!m) return;
      await openTrade(ctx, m);
      await connected(ctx);
      const side = ctx.rng.chance(0.5) ? "long" : "short";
      const [r, why] = await marketOrder(ctx, m, side, OPEN_USD, Math.min(m.maxLeverage, 2));
      if (r === "skipped") return; // nothing started; another turn
      if (r !== "confirmed") {
        if (r === "blocked") await ctx.rec.issue("order-blocked", "medium", `${NAME}: open on ${m.symbol} not accepted: ${why}`, { key: `${NAME} open blocked` });
        return;
      }
      const a = await ctx.step("watch it settle", () => settled(ctx, (x) => !!x.positions[m.symbol]));
      if (!a) return;
      fu.next<State>(id, NAME, "set-tp", fu.txReadyAt(id), { sym: m.symbol, isLong: side === "long" }, Date.now());
      return;
    }

    const s = plan!.data;
    const a0 = await acct(ctx);
    const pos = a0?.positions[s.sym];

    if (stage === "watch") return watch(ctx, s, a0);
    if (!pos) {
      fu.note(NAME, id, `${s.sym} position gone before "${stage}"`);
      return fu.clear(id, NAME);
    }
    const m = (await freshMarkets(ctx)).find((x) => x.symbol === s.sym);
    if (!m) return fu.clear(id, NAME);
    await openTrade(ctx, m);
    await connected(ctx);

    if (stage === "set-tp" || stage === "set-sl" || stage === "reset-tp") {
      const k: Kind = stage === "set-sl" ? "sl" : "tp";
      // Far enough not to fire on the first two; the moved take profit near
      // enough that an ordinary hour's move reaches it.
      const away = stage === "reset-tp" ? 0.002 : 0.04;
      const px = Number(fmtPrice(pos.mark * (above(k, s.isLong) ? 1 + away : 1 - away)));
      const r = await setTrigger(ctx, k, px);
      if (!(await carryOn(ctx, r, stage, s))) return;
      const a = await ctx.step("watch it land", () => settled(ctx, (x) => !!standingOf(x, s.sym, k)));
      if (!a) {
        await ctx.rec.issue("order-missing", "high", `${NAME}: ${k.toUpperCase()} at ${px} confirmed but not in /api/account's orders after 30s`, { key: `${NAME} ${k} not listed` });
        return fu.clear(id, NAME);
      }
      await checkTrigger(ctx, standingOf(a, s.sym, k)!, k, px, s.isLong);
      const nextStage = stage === "set-tp" ? "set-sl" : stage === "set-sl" ? "cancel-tp" : "cancel-sl";
      const data: State = { ...s, [k]: px, misses: 0, ...(stage === "reset-tp" ? { setAt: Date.now() } : {}) };
      fu.next<State>(id, NAME, nextStage, fu.txReadyAt(id), data);
      return;
    }

    if (stage === "cancel-tp" || stage === "cancel-sl") {
      const k: Kind = stage === "cancel-tp" ? "tp" : "sl";
      if (!standingOf(a0, s.sym, k)) {
        // Fired or gone already: on to what follows.
        fu.next<State>(id, NAME, stage === "cancel-tp" ? "reset-tp" : "watch", Date.now(),
          stage === "cancel-tp" ? s : { ...s, watchUntil: Date.now() + config.triggerWatchMs });
        return;
      }
      const r = await cancelTrigger(ctx, k);
      if (!(await carryOn(ctx, r, stage, s))) return;
      const a = await ctx.step("watch it go", () => settled(ctx, (x) => !standingOf(x, s.sym, k)));
      if (!a) {
        await ctx.rec.issue("order-stuck", "high", `${NAME}: canceled the ${k.toUpperCase()} on ${s.sym}; /api/account still lists it 30s later`, { key: `${NAME} ${k} cancel` });
        return fu.clear(id, NAME);
      }
      await ctx.step("watch it leave the ticket", async () => {
        if (await triggerBox(ctx).then((b) => standingRow(b, k).isVisible()).catch(() => false)) {
          await ctx.page.waitForTimeout(6_000);
          if (await triggerBox(ctx).then((b) => standingRow(b, k).isVisible()).catch(() => false)) {
            await ctx.rec.issue("stale-row", "medium", `${NAME}: the ticket still shows a ${k.toUpperCase()} the API canceled`, { key: `${NAME} ${k} stale ticket` });
          }
        }
      });
      if (stage === "cancel-tp") fu.next<State>(id, NAME, "reset-tp", fu.txReadyAt(id), { ...s, tp: undefined });
      else fu.next<State>(id, NAME, "watch", Date.now(), { ...s, sl: undefined, watchUntil: Date.now() + config.triggerWatchMs });
      return;
    }

    if (stage === "cleanup") {
      const r = await closeVia(ctx, s.sym, null);
      if (r === "skipped") { fu.next<State>(id, NAME, "cleanup", fu.txReadyAt(id), s); return; }
      if (r === "confirmed") {
        const a = await settled(ctx, (x) => !x.positions[s.sym]);
        // Closing the whole position cancels its take profit and stop with it.
        if (a && a.orders.some((o) => o.symbol === s.sym && o.kind === 0)) {
          await ctx.rec.issue("order-stuck", "high", `${NAME}: ${s.sym} closed in full but its take profit or stop is still standing`, { key: `${NAME} trigger after close` });
        }
      }
      fu.clear(id, NAME);
    }
  },
};

/// Between visits, from the API alone: no page is loaded unless it fired.
async function watch(ctx: Ctx, s: State, a: Account | null) {
  const id = ctx.persona.id;
  const fired = a?.orderFills.find((f) => f.symbol === s.sym && s.tp != null && Math.abs(f.trigger - s.tp) <= priceTick(s.tp) * 1.01 && f.t >= (s.setAt ?? 0) - 5_000);
  if (fired && !fired.expired) {
    const m = (await freshMarkets(ctx)).find((x) => x.symbol === s.sym);
    await openTrade(ctx, m ?? null);
    await connected(ctx);
    if (a?.positions[s.sym]) {
      fu.note(NAME, id, `TP on ${s.sym} fired at ${fired.price} but part of the position is still open (filled pro rata)`);
    }
    // A long's take profit fires at or above the trigger, a short's at or below.
    const wrong = s.isLong ? fired.price < s.tp! - priceTick(s.tp!) : fired.price > s.tp! + priceTick(s.tp!);
    if (wrong) {
      await ctx.rec.issue("trigger-early", "high", `${NAME}: ${s.sym} TP at ${s.tp} fired with the mark at ${fired.price}`, { key: `${NAME} fired early`, shot: false });
    }
    await ctx.step("watch the close in history", () => checkHistory(ctx, NAME, s.sym, "close", fired.t));
    if (!ctx.phone) {
      await ctx.step("watch it leave Open orders", async () => {
        await accountTab(ctx, "Open orders");
        const row = await rowFor(ctx, s.sym, (c) => c["Type"] === "Take profit");
        if (row) await ctx.rec.issue("stale-row", "medium", `${NAME}: the fired TP on ${s.sym} is still on the Open orders tab`, { key: `${NAME} fired tp row` });
      });
    }
    fu.note(NAME, id, `TP on ${s.sym} at ${s.tp} fired at ${fired.price} within ${Math.round((fired.t - (s.setAt ?? fired.t)) / 60_000)} min`);
    return fu.clear(id, NAME);
  }
  if (!a?.positions[s.sym]) { fu.note(NAME, id, `${s.sym} position gone without the TP firing`); return fu.clear(id, NAME); }
  if (Date.now() < (s.watchUntil ?? 0)) { fu.next<State>(id, NAME, "watch", Date.now() + WATCH_EVERY_MS, s); return; }
  fu.note(NAME, id, `TP on ${s.sym} at ${s.tp} did not trigger in ${Math.round(config.triggerWatchMs / 60_000)} min (mark ${a.positions[s.sym].mark}); closing`);
  fu.next<State>(id, NAME, "cleanup", fu.txReadyAt(id), s);
}

/// The ticket's Triggers box, opened.
async function triggerBox(ctx: Ctx): Promise<Locator> {
  const t = await ticket(ctx, "long");
  const box = t.getByRole("checkbox", { name: "Take profit / stop loss" });
  if (!(await box.first().isVisible().catch(() => false))) throw new Error("no Take profit / stop loss box in the ticket");
  const group = t.getByRole("group", { name: "Triggers" });
  if (!(await group.first().isVisible().catch(() => false))) {
    await ctx.click(box, "Take profit / stop loss");
    await ctx.ready(group, "the Triggers box");
  }
  return group.first();
}
const standingRow = (group: Locator, k: Kind) =>
  group.locator("div").filter({ has: group.page().getByText(k === "tp" ? "TP" : "SL", { exact: true }) })
    .filter({ has: group.page().getByRole("button", { name: "Cancel", exact: true }) }).last();

async function setTrigger(ctx: Ctx, k: Kind, px: number): Promise<TxResult> {
  return ctx.step(`set the ${k.toUpperCase()}`, async () => {
    const group = await triggerBox(ctx);
    const input = group.getByRole("spinbutton", { name: k === "tp" ? "Take profit price" : "Stop loss price" });
    if (!(await input.first().isVisible().catch(() => false))) return "blocked" as const; // one already standing
    await ctx.type(input, String(px));
    const set = input.first().locator("xpath=following-sibling::button[1]");
    if (!(await set.isEnabled().catch(() => false))) return "blocked" as const;
    return ctx.tx("trigger", () => ctx.click(set, "Set"));
  });
}

async function cancelTrigger(ctx: Ctx, k: Kind): Promise<TxResult> {
  return ctx.step(`cancel the ${k.toUpperCase()}`, async () => {
    const group = await triggerBox(ctx);
    const row = standingRow(group, k);
    if (!(await row.isVisible().catch(() => false))) {
      await ctx.rec.issue("order-missing", "high", `${NAME}: the API lists a ${k.toUpperCase()} the ticket does not show`, { key: `${NAME} ${k} not in ticket` });
      return "blocked" as const;
    }
    return ctx.tx("cancel", () => ctx.click(row.getByRole("button", { name: "Cancel", exact: true }), `Cancel the ${k.toUpperCase()}`));
  });
}

/// The trigger the API holds against what was typed, the ticket and the tab.
async function checkTrigger(ctx: Ctx, o: Order, k: Kind, px: number, isLong: boolean) {
  const label = k === "tp" ? "Take profit" : "Stop loss";
  if (Math.abs(o.triggerPrice - px) > priceTick(px) * 1.01) {
    await ctx.rec.issue("number-mismatch", "high", `${NAME}: ${label} typed at ${px}, the API holds ${o.triggerPrice}`, { key: `${NAME} ${k} price` });
  }
  if (o.triggerAbove !== above(k, isLong)) {
    await ctx.rec.issue("order-direction", "high", `${NAME}: ${label} on a ${isLong ? "long" : "short"} fires ${o.triggerAbove ? "above" : "below"}`, { key: `${NAME} ${k} direction` });
  }
  await ctx.step(`watch the ${k.toUpperCase()} in the ticket`, async () => {
    const group = await triggerBox(ctx);
    const row = standingRow(group, k);
    if (!(await row.waitFor({ state: "visible", timeout: 10_000 }).then(() => true, () => false))) {
      await ctx.rec.issue("order-missing", "high", `${NAME}: ${label} is in the API but not in the ticket's Triggers box`, { key: `${NAME} ${k} ticket` });
      return;
    }
    const text = await row.innerText().catch(() => "");
    const shown = parsePrice(text.replace(/^(TP|SL)\s*/, ""));
    const dir = o.triggerAbove ? "or above" : "or below";
    if (shown != null && Math.abs(shown - o.triggerPrice) > priceTick(px) * 1.01 || !text.includes(dir)) {
      await ctx.rec.issue("number-mismatch", "medium", `${NAME}: ticket shows "${text.replace(/\s+/g, " ")}" for a ${label} at ${o.triggerPrice} ${dir}`, { key: `${NAME} ${k} ticket text` });
    }
  });
  if (ctx.phone) return; // the phone has no Open orders tab
  await ctx.step(`watch the ${k.toUpperCase()} on Open orders`, async () => {
    await accountTab(ctx, "Open orders");
    const row = await rowFor(ctx, o.symbol, (c) => c["Type"] === label);
    if (!row) {
      await ctx.rec.issue("order-missing", "high", `${NAME}: ${label} on ${o.symbol} is in the API but not on the Open orders tab`, { key: `${NAME} ${k} tab` });
      return;
    }
    const trig = parsePrice(row["Trigger"]);
    if (trig != null && Math.abs(trig - o.triggerPrice) > Math.max(priceTick(px), o.triggerPrice * 1e-4)) {
      await ctx.rec.issue("number-mismatch", "medium", `${NAME}: Open orders shows ${label} at ${row["Trigger"]}, the API ${o.triggerPrice}`, { key: `${NAME} ${k} tab price` });
    }
  });
}

async function carryOn(ctx: Ctx, r: TxResult, stage: string, s: State) {
  const id = ctx.persona.id;
  if (r === "confirmed") return true;
  if (r === "skipped") { fu.next<State>(id, NAME, stage, fu.txReadyAt(id), s); return false; }
  if (r === "dry" || !live()) return false;
  const misses = (s.misses ?? 0) + 1;
  if (misses >= 2) { fu.note(NAME, id, `${stage} on ${s.sym} gave ${r} twice; closing`); fu.next<State>(id, NAME, "cleanup", fu.txReadyAt(id), s); return false; }
  fu.next<State>(id, NAME, stage, fu.txReadyAt(id), { ...s, misses });
  return false;
}
