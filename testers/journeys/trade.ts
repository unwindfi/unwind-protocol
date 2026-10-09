/*
 * The terminal: open a market, connect, set side, leverage and size, place
 * a market order, watch the batch clear, then look at (and sometimes close)
 * the position. Without funds the ticket refuses the order itself, and the
 * journey checks it says why in figures that match the API.
 */
import {
  agrees, live, openTrade, parseMoney, readFigure, setLeverage, submitButton, ticket, ticketNote, watchBatch,
  type Journey,
} from "./common";
import type { Ctx, Market } from "../session";

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const trade: Journey = {
  name: "trade",
  budgetMs: 200_000,
  wallet: true,
  async run(ctx) {
    const m = await ctx.pickMarket();
    await openTrade(ctx, m);
    if (!m) return;
    await ctx.step("look around", async () => { await ctx.checkPage(); await ctx.think(); });
    await ctx.step("watch a batch", () => watchBatch(ctx));

    // Connect from the header, or from the ticket's own button.
    const side = ctx.rng.chance(0.55) ? "long" : "short";
    if (ctx.rng.chance(0.5) && !ctx.phone) {
      const t = await ticket(ctx, side);
      await ctx.connect(submitButton(t).filter({ hasText: "Connect wallet" }));
    } else {
      await ctx.connect();
    }
    await placeMarketOrder(ctx, m, side);
    await accountTabs(ctx);
    await closeSomething(ctx, m);
  },
};

export async function placeMarketOrder(ctx: Ctx, m: Market, side: "long" | "short") {
  const page = ctx.page;
  const t = await ctx.step("open the ticket", () => ticket(ctx, side));
  await ctx.step(`choose ${side}`, async () => {
    const tab = t.getByRole("tab", { name: side === "long" ? "Long" : "Short", exact: true });
    if (await tab.first().isVisible().catch(() => false)) await ctx.click(tab, `the ${side} tab`, { expectChange: false });
    const market = t.getByRole("tab", { name: "Market", exact: true });
    if (await market.first().isVisible().catch(() => false)) await ctx.click(market, "the Market tab", { expectChange: false });
  });

  const acct = await ctx.account();
  await ctx.step("check the balance", async () => {
    await page.waitForTimeout(2_000);
    await agrees(ctx, "Ticket's Available to trade",
      async () => parseMoney(await readFigure(t, "Available to trade")),
      async () => (await ctx.account())?.usdc ?? null);
  });

  const [lo, hi] = ctx.persona.leverage;
  const lev = Math.min(m.maxLeverage, lo + ctx.rng.next() * (hi - lo));
  await ctx.step("set leverage", () => setLeverage(ctx, t, lev, m.maxLeverage));

  const usd = ctx.rng.pick(ctx.persona.sizes);
  await ctx.step("type a size", async () => {
    const amount = t.getByRole("textbox", { name: "Amount" });
    if (ctx.rng.chance(0.25)) {
      // Some people press a share of their balance instead.
      const pct = t.getByRole("button", { name: ctx.rng.pick(["25%", "50%", "75%"]), exact: true });
      if (await pct.first().isEnabled().catch(() => false)) { await ctx.click(pct, "a size share"); return; }
    }
    await ctx.type(amount, String(usd));
    const shown = await amount.first().inputValue();
    if (parseMoney(shown) !== usd) {
      await ctx.rec.issue("control-mismatch", "medium", `Typed ${usd} into Amount, it shows "${shown}"`, { key: "amount field" });
    }
    const value = parseMoney(await readFigure(t, "Order value"));
    if (value != null && Math.abs(value - usd) > 0.02) {
      await ctx.rec.issue("number-mismatch", "medium", `Order value shows ${value} for an amount of ${usd} USD`, { key: "order value" });
    }
  });

  await ctx.step("place the order", async () => {
    const submit = submitButton(t).first();
    const label = await submit.innerText().catch(() => "");
    if (label === "Connect wallet") return;
    if (!(await submit.isEnabled().catch(() => false))) {
      // The ticket says why; check its arithmetic against the account.
      const note = await ticketNote(t);
      const free = acct?.usdc ?? 0;
      const said = /, \$([\d,.]+) free/.exec(note)?.[1];
      if (said != null && Math.abs(Number(said.replace(/,/g, "")) - free) > 0.011) {
        await ctx.rec.issue("number-mismatch", "high", `Ticket says $${said} free; the API says ${free}`, { key: "ticket free" });
      }
      if (!note && free > usd) {
        await ctx.rec.issue("disabled-no-reason", "medium", `"${label}" is disabled with ${free} USDC free and no reason shown`, { key: "submit disabled" });
      }
      return;
    }
    const r = await ctx.tx("order", () => ctx.click(submit, `"${label}"`));
    if (r === "confirmed") {
      await ctx.step("watch it clear", async () => {
        await watchBatch(ctx);
        // The position, as the API and the page both see it.
        await page.waitForTimeout(6_000);
        const pos = (await ctx.account())?.positions[m.symbol];
        if (!pos) return;
        if (!ctx.phone) {
          await ctx.click(page.getByRole("tab", { name: /^Positions/ }), "the Positions tab", { expectChange: false });
          const row = page.getByRole("row").filter({ hasText: m.symbol }).first();
          if (!(await row.waitFor({ state: "visible", timeout: 8_000 }).then(() => true, () => false))) {
            await ctx.rec.issue("position-missing", "high", `${m.symbol} position exists on chain but not in the Positions table`, { key: "position row" });
          }
        }
      });
    }
  });
}

/// The account strip under the chart (or the phone's Positions view).
export async function accountTabs(ctx: Ctx) {
  const page = ctx.page;
  await ctx.step("account tabs", async () => {
    if (ctx.phone) {
      // Close the sheet if it is up, then walk the bottom views.
      const close = page.getByRole("dialog").getByRole("button", { name: "Close" });
      if (await close.first().isVisible().catch(() => false)) await ctx.click(close, "the sheet's Close");
      for (const v of ctx.rng.shuffle(["Chart", "Market", "Positions", "Account"]).slice(0, 3)) {
        const b = page.getByRole("button", { name: new RegExp(`^${v}( \\d+)?$`) });
        if (!(await b.first().isVisible().catch(() => false))) continue;
        await ctx.click(b, `the ${v} view`);
        if ((await b.first().getAttribute("aria-current")) !== "page") {
          await ctx.rec.issue("control-mismatch", "medium", `The ${v} view did not show as current`, { key: `view ${v}` });
        }
        await ctx.checkPage();
        await ctx.think(500);
      }
      return;
    }
    for (const name of ctx.rng.shuffle(["Positions", "Open orders", "Funding", "Trade history", "Liquidations"]).slice(0, 3)) {
      const tab = page.getByRole("tab", { name: new RegExp(`^${name}( \\(\\d+\\))?$`) });
      if (!(await tab.first().isVisible().catch(() => false))) continue;
      await ctx.click(tab, `the ${name} tab`);
      await ctx.think(500);
    }
    await ctx.checkPage();
  });
}

/// Closes an open position through the close dialog (a share or all of it).
export async function closeSomething(ctx: Ctx, m: Market) {
  const acct = await ctx.account();
  const held = Object.keys(acct?.positions ?? {});
  if (!held.length) return;
  const sym = held.includes(m.symbol) ? m.symbol : ctx.rng.pick(held);
  const page = ctx.page;
  await ctx.step("close a position", async () => {
    if (ctx.phone) {
      await ctx.click(page.getByRole("button", { name: /^Positions( \d+)?$/ }), "the Positions view");
    } else {
      await ctx.click(page.getByRole("tab", { name: /^Positions/ }), "the Positions tab", { expectChange: false });
    }
    const open = page.getByRole("button", { name: `Close ${sym} position` });
    if (!(await open.first().waitFor({ state: "visible", timeout: 6_000 }).then(() => true, () => false))) {
      await ctx.rec.issue("position-missing", "high", `${sym} position on chain has no Close button on the page`, { key: "close button" });
      return;
    }
    await ctx.click(open, `Close ${sym}`);
    const dialog = page.getByRole("dialog", { name: new RegExp(`^Close ${esc(sym)}$`) });
    await ctx.ready(dialog, "the close dialog");
    const share = ctx.rng.pick(["25%", "50%", "100%", "MAX"]);
    if (share === "MAX") await ctx.click(dialog.getByRole("button", { name: /MAX/ }), "MAX");
    else await ctx.click(dialog.getByRole("button", { name: share, exact: true }), share);
    await ctx.checkPage();
    const go = dialog.getByRole("button", { name: /^Close (position|\$)/ });
    if (!live() || !(await go.first().isEnabled().catch(() => false))) {
      // Leave without closing: the Cancel path is a path too.
      await ctx.click(dialog.getByRole("button", { name: "Cancel" }).last(), "Cancel");
      return;
    }
    await ctx.tx("close", () => ctx.click(go, "the close button"));
  });
}
