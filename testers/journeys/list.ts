/*
 * Opening a market: search a token, pick its pool, read the preview, set
 * the limits and the backing, tick the acknowledgement, and stop at the
 * List button (the review). A lister persona, at most LISTINGS_PER_DAY times
 * a day across the fleet and never in a dry run, presses it. The Back tab
 * backs a listed market.
 */
import { live, type Journey } from "./common";
import { listingAllowed } from "../txgate";
import type { Ctx } from "../session";

const QUERIES = ["bonk", "wif", "popcat", "jup", "pengu", "ray", "orca", "trump", "fart", "jto", "render", "pyth"];

export const list: Journey = {
  name: "list",
  budgetMs: 200_000,
  wallet: true,
  async run(ctx) {
    const page = ctx.page;
    const deep = ctx.rng.chance(0.25);
    const q = ctx.rng.pick(QUERIES);
    await ctx.step(deep ? "open /list/:q" : "open /list", () =>
      ctx.goto(deep ? `/list/${q}` : "/list", (p) => p.getByRole("heading", { name: /^(List|Back) a market$/ })));
    await ctx.step("look around", async () => { await ctx.checkPage(); await ctx.think(); });
    await ctx.connect(ctx.rng.chance(0.4) ? page.getByRole("button", { name: "Connect wallet" }) : undefined);
    await ctx.step("faucet prompt renders", async () => {
      // Unfunded wallets see the prompt; it is looked at, never pressed.
      const acct = await ctx.account();
      if (!acct || acct.usdc > 0) return;
      const prompt = page.getByRole("button", { name: "Get test funds" });
      const said = page.getByText(/No test funds|No test USDC|No free USDC|Low SOL/);
      if (!(await said.first().waitFor({ state: "visible", timeout: 6_000 }).then(() => true, () => false))) {
        await ctx.rec.issue("fund-prompt", "medium", "An unfunded wallet on /list sees no funding prompt", { key: "fund prompt" });
      }
      void prompt;
    });

    const backTab = ctx.persona.role === "backer" || ctx.rng.chance(0.25);
    if (backTab) return backIt(ctx);

    await ctx.step("search a token", async () => {
      const field = page.getByRole("combobox");
      if (!deep) await ctx.type(field, q);
      else await field.first().focus();
      const options = page.getByRole("listbox").getByRole("button").or(page.getByRole("listbox").getByRole("link"));
      if (!(await options.first().waitFor({ state: "visible", timeout: 12_000 }).then(() => true, () => false))) {
        const none = await page.getByText("No token by that name on devnet or mainnet.").first().isVisible().catch(() => false);
        if (!none) await ctx.rec.issue("list-search", "medium", `Token search for "${q}" showed neither results nor a no-results line`, { key: "token search" });
        return;
      }
      // A "Listed · Trade" row leaves the page; pick one that lists.
      const lists = page.getByRole("listbox").getByRole("button");
      const n = await lists.count();
      if (!n) return;
      await ctx.click(lists.nth(ctx.rng.int(0, Math.min(n, 4) - 1)), "a token to list");
    });

    await ctx.step("read the preview", async () => {
      const ok = page.getByText(/^(Live at listing|Opening auction in|Too thin|Pool not read|Pick a token)/);
      await ctx.ready(ok, "the listing preview").catch(() => undefined);
      const status = await ok.first().innerText().catch(() => "");
      if (status === "Pool not read") {
        const why = await ok.first().locator("xpath=following-sibling::*[1]").innerText().catch(() => "");
        await ctx.rec.issue("list-preview", "medium", `Listing preview could not read the pool: ${why}`, { key: `pool not read ${why}` });
      }
      await ctx.checkPage();
    });

    await ctx.step("limits and backing", async () => {
      for (const s of await page.getByRole("slider").all()) {
        if (!(await s.isVisible().catch(() => false)) || ctx.rng.chance(0.5)) continue;
        await s.focus();
        await s.press(ctx.rng.pick(["ArrowLeft", "ArrowRight", "End", "Home"]));
      }
      const backing = page.getByRole("textbox", { name: /^Backing in / });
      if (await backing.first().isVisible().catch(() => false)) await ctx.type(backing, String(ctx.rng.pick([100, 150, 250])));
      const ack = page.getByRole("checkbox", { name: "My backing takes this market's losses first" });
      if (await ack.first().isVisible().catch(() => false)) await ctx.click(ack, "the acknowledgement");
      await ctx.checkPage();
    });

    await ctx.step("review", async () => {
      const cta = page.getByRole("button", { name: /^(List .+|Connect wallet|Read-only|Pool not on this chain|Confirm in wallet|Preparing devnet pool…)$/ });
      const label = await cta.first().innerText().catch(() => "");
      const enabled = await cta.first().isEnabled().catch(() => false);
      if (!/^List /.test(label) || !enabled) return;
      if (ctx.persona.role === "lister" && live() && listingAllowed()) {
        ctx.allowMirror = true;
        await ctx.tx("list-market", () => ctx.click(cta, label));
      }
    });
  },
};

async function backIt(ctx: Ctx) {
  const page = ctx.page;
  await ctx.step("the Back tab", async () => {
    await ctx.click(page.getByRole("tab", { name: /^Back/ }), "the Back tab");
    const inputs = page.getByRole("textbox", { name: /^Back .+ in / });
    if (!(await inputs.first().waitFor({ state: "visible", timeout: 6_000 }).then(() => true, () => false))) return;
    const n = await inputs.count();
    const i = ctx.rng.int(0, n - 1);
    await ctx.type(inputs.nth(i), String(ctx.rng.pick([10, 25, 50])));
    const go = inputs.nth(i).locator("xpath=following-sibling::button[1]");
    await ctx.checkPage();
    if (await go.isEnabled().catch(() => false)) await ctx.tx("back-market", () => ctx.click(go, "Back it"));
  });
}
