/*
 * Earn: the pool's deposit and its two-step withdrawal (request, then claim
 * once the wait is over), backing a market and taking backing out, and a
 * vault's own page.
 */
import { agrees, live, parseMoney, readFigure, type Journey } from "./common";
import type { Ctx } from "../session";

export const earn: Journey = {
  name: "earn",
  budgetMs: 180_000,
  wallet: true,
  async run(ctx) {
    const page = ctx.page;
    await ctx.step("open /earn", () => ctx.goto("/earn", (p) => p.getByRole("heading", { name: "Earn", level: 1 })));
    await ctx.step("look around", async () => { await ctx.checkPage(); await ctx.think(); });
    await ctx.connect();
    await ctx.step("wallet figure", async () => {
      await page.waitForTimeout(2_000); // the figure counts up
      await agrees(ctx, "Earn's In your wallet",
        async () => parseMoney(await readFigure(page, "In your wallet")),
        async () => (await ctx.account())?.usdc ?? null);
    });

    const acct = await ctx.account();
    const pending = acct?.lp.pending;
    const choice = pending ? "claim" : ctx.rng.weighted([["deposit", 3], ["withdraw", 2], ["back", ctx.persona.role === "backer" ? 4 : 1]] as const);
    if (choice === "back") await backAMarket(ctx);
    else await pool(ctx, choice);

    if (ctx.rng.chance(0.5)) {
      await ctx.step("a vault's page", async () => {
        const id = ctx.rng.chance(0.5) ? "pool" : (await ctx.pickMarket())?.symbol ?? "pool";
        await ctx.goto(`/vault/${encodeURIComponent(id)}`, (p) => p.getByRole("heading", { level: 1 }).or(p.getByText(/^No vault called/)));
        if (await page.getByText(/^No vault called/).first().isVisible().catch(() => false)) {
          await ctx.rec.issue("vault-missing", "medium", `/vault/${id} says there is no such vault`, { key: `no vault ${id === "pool" ? "pool" : "market"}` });
        }
        await ctx.checkPage();
      });
    }
  },
};

async function pool(ctx: Ctx, what: "deposit" | "withdraw" | "claim") {
  const page = ctx.page;
  await ctx.step(`pool ${what}`, async () => {
    const open = what === "deposit" && ctx.rng.chance(0.4)
      ? page.getByRole("button", { name: "or join the pool" })
      : page.getByRole("button", { name: what === "deposit" ? "Deposit" : "Withdraw", exact: true });
    await ctx.click(open, `the pool's ${what === "deposit" ? "Deposit" : "Withdraw"}`);
    const dialog = page.getByRole("dialog", { name: "The pool" });
    await ctx.ready(dialog, "the pool dialog");
    await ctx.checkPage();
    if (what === "claim") {
      const claim = dialog.getByRole("button", { name: "Claim", exact: true });
      if (live() && await claim.first().isEnabled().catch(() => false)) {
        await ctx.tx("withdraw-claim", () => ctx.click(claim, "Claim"));
      }
      return close(ctx);
    }
    const input = dialog.getByRole("textbox", { name: what === "deposit" ? "Amount to deposit" : "Amount to request withdrawal" });
    const max = dialog.getByRole("button", { name: /MAX/ });
    if (what === "withdraw" && ctx.rng.chance(0.4) && await max.first().isVisible().catch(() => false)) {
      await ctx.click(max, "MAX");
    } else {
      await ctx.type(input, String(ctx.rng.pick(ctx.persona.sizes)));
    }
    const verb = what === "deposit" ? "Deposit" : "Request withdrawal";
    const submit = dialog.getByRole("button", { name: new RegExp(`^(${verb}|Over your (balance|deposit)|Confirm in wallet)$`) });
    const label = await submit.first().innerText().catch(() => "");
    if (label === verb && await submit.first().isEnabled().catch(() => false)) {
      // The first half of a withdrawal: the claim comes in a later session.
      await ctx.tx(what === "deposit" ? "deposit" : "withdraw", () => ctx.click(submit, verb));
    }
    await close(ctx);
  });
}

async function backAMarket(ctx: Ctx) {
  const page = ctx.page;
  await ctx.step("back a market", async () => {
    const backs = page.getByRole("button", { name: "Back", exact: true });
    const n = await backs.count();
    if (!n) return;
    await ctx.click(backs.nth(ctx.rng.int(0, n - 1)), "a market's Back");
    const dialog = page.getByRole("dialog");
    await ctx.ready(dialog, "the backing dialog");
    const out = ctx.rng.chance(0.3);
    if (out) await ctx.click(dialog.getByRole("tab", { name: "Withdraw" }), "the Withdraw tab");
    const pay = dialog.getByRole("radio");
    if (!out && await pay.count() > 1 && ctx.rng.chance(0.3)) await ctx.click(pay.nth(ctx.rng.int(0, (await pay.count()) - 1)), "a Pay with token");
    await ctx.type(dialog.getByRole("textbox", { name: /^Amount to / }), String(ctx.rng.pick([10, 20, 30])));
    await ctx.checkPage();
    const verb = out ? "Withdraw" : "Back";
    const submit = dialog.getByRole("button", { name: verb, exact: true });
    if (await submit.first().isEnabled().catch(() => false)) {
      await ctx.tx(out ? "unback-market" : "back-market", () => ctx.click(submit, verb));
    }
    await close(ctx);
  });
}

async function close(ctx: Ctx) {
  const x = ctx.page.getByRole("dialog").getByRole("button", { name: "Close" });
  if (await x.first().isVisible().catch(() => false)) {
    if (ctx.rng.chance(0.5)) await ctx.page.keyboard.press("Escape");
    else await ctx.click(x.first(), "Close");
  }
  // Closing animates out; only a dialog still there after that is stuck.
  if (!(await ctx.page.getByRole("dialog").first().waitFor({ state: "hidden", timeout: 3_000 }).then(() => true, () => false))) {
    await ctx.rec.issue("dialog-stuck", "medium", "A dialog stayed open after Escape or Close", { key: "dialog close" });
  }
}
