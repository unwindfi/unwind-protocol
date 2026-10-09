/*
 * Resting orders: a limit away from the market (sometimes post only, with a
 * time in force), then the open orders tab and a cancel; take profit and
 * stop loss on a position when there is one.
 */
import { live, openTrade, setLeverage, submitButton, ticket, ticketNote, type Journey } from "./common";
import type { Ctx } from "../session";

export const limit: Journey = {
  name: "limit",
  budgetMs: 200_000,
  wallet: true,
  async run(ctx) {
    const m = await ctx.pickMarket();
    await openTrade(ctx, m);
    if (!m) return;
    await ctx.connect();
    const side = ctx.rng.chance(0.5) ? "long" : "short";
    const t = await ctx.step("open the ticket", () => ticket(ctx, side));
    const page = ctx.page;

    await ctx.step("switch to Limit", async () => {
      await ctx.click(t.getByRole("tab", { name: side === "long" ? "Long" : "Short", exact: true }), `the ${side} tab`, { expectChange: false });
      await ctx.click(t.getByRole("tab", { name: "Limit", exact: true }), "the Limit tab");
      await ctx.ready(t.getByRole("spinbutton", { name: "Limit price" }), "the limit price field");
    });

    await ctx.step("price the limit", async () => {
      await ctx.click(t.getByRole("button", { name: "Mid", exact: true }), "Mid");
      const field = t.getByRole("spinbutton", { name: "Limit price" });
      const mid = Number(await field.first().inputValue());
      if (!(mid > 0)) {
        await ctx.rec.issue("control-mismatch", "medium", `Mid filled the limit price with "${mid}"`, { key: "mid" });
        return;
      }
      // Rest away from the market, the way a limit user does: below for a
      // buy, above for a sell, 1 to 6 percent.
      const away = 0.01 + ctx.rng.next() * 0.05;
      const px = side === "long" ? mid * (1 - away) : mid * (1 + away);
      const digits = mid < 1 ? 5 : mid < 100 ? 3 : 2;
      await ctx.type(field, px.toFixed(digits));
    });

    await ctx.step("size and options", async () => {
      await setLeverage(ctx, t, ctx.persona.leverage[0], m.maxLeverage);
      await ctx.type(t.getByRole("textbox", { name: "Amount" }), String(ctx.rng.pick(ctx.persona.sizes)));
      const post = t.getByRole("checkbox", { name: "Post only, maker only" });
      if (ctx.rng.chance(0.3) && await post.first().isEnabled().catch(() => false)) await ctx.click(post, "Post only");
      const tif = t.getByRole("combobox", { name: "Time in force" });
      if (await tif.first().isVisible().catch(() => false)) {
        await tif.first().selectOption(ctx.rng.pick(["gtc", "1h", "1d"]));
      }
      await ctx.checkPage();
    });

    await ctx.step("place the limit", async () => {
      const submit = submitButton(t).first();
      const label = await submit.innerText().catch(() => "");
      if (!(await submit.isEnabled().catch(() => false))) {
        const note = await ticketNote(t);
        if (!note) await ctx.rec.issue("disabled-no-reason", "medium", `"${label}" disabled with no reason shown`, { key: "limit disabled" });
        return;
      }
      await ctx.tx(/^Post/.test(label) ? "maker" : "limit", () => ctx.click(submit, `"${label}"`));
    });

    await cancelAnOrder(ctx);
    await triggers(ctx, m.symbol);
  },
};

async function cancelAnOrder(ctx: Ctx) {
  if (ctx.phone) return; // the phone has no open orders tab
  const page = ctx.page;
  await ctx.step("open orders", async () => {
    await ctx.click(page.getByRole("tab", { name: /^Open orders/ }), "the Open orders tab", { expectChange: false });
    const acct = await ctx.account();
    const n = acct?.orders.length ?? 0;
    const tabLabel = await page.getByRole("tab", { name: /^Open orders/ }).first().innerText().catch(() => "");
    const shown = Number(/\((\d+)\)/.exec(tabLabel)?.[1] ?? 0);
    if (acct && Math.abs(shown - n) > 0) {
      await page.waitForTimeout(4_000);
      const again = Number(/\((\d+)\)/.exec(await page.getByRole("tab", { name: /^Open orders/ }).first().innerText().catch(() => ""))?.[1] ?? 0);
      const truth = (await ctx.account())?.orders.length ?? 0;
      if (again !== truth) await ctx.rec.issue("number-mismatch", "high", `Open orders tab counts ${again}; the API lists ${truth}`, { key: "orders count" });
    }
    if (!n) return;
    const cancel = page.getByRole("button", { name: "Cancel", exact: true });
    if (!(await cancel.first().isVisible().catch(() => false))) return;
    if (live()) await ctx.tx("cancel", () => ctx.click(cancel, "Cancel on an order"));
  });
}

async function triggers(ctx: Ctx, symbol: string) {
  const acct = await ctx.account();
  const pos = acct?.positions[symbol];
  const page = ctx.page;
  await ctx.step("take profit / stop loss", async () => {
    const t = await ticket(ctx, "long");
    const box = t.getByRole("checkbox", { name: "Take profit / stop loss" });
    if (!(await box.first().isVisible().catch(() => false))) return;
    const enabled = await box.first().isEnabled().catch(() => false);
    if (!pos) {
      if (enabled) await ctx.rec.issue("control-mismatch", "low", "Take profit / stop loss is enabled with no position to protect", { key: "tpsl enabled" });
      return;
    }
    await ctx.click(box, "Take profit / stop loss");
    const kind = ctx.rng.chance(0.5) ? "tp" : "sl";
    const input = t.getByRole("spinbutton", { name: kind === "tp" ? "Take profit price" : "Stop loss price" });
    if (!(await input.first().waitFor({ state: "visible", timeout: 3_000 }).then(() => true, () => false))) return; // one already standing
    const placeholder = Number(await input.first().getAttribute("placeholder"));
    if (placeholder > 0) await ctx.type(input, String(placeholder));
    const set = input.locator("xpath=following-sibling::button[1]");
    if (live() && await set.isEnabled().catch(() => false)) await ctx.tx("trigger", () => ctx.click(set, "Set"));
    void page;
  });
}
