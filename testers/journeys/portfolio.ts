/*
 * The portfolio: connect from its own empty state, check its figures
 * against the API, and read the fills and orders lists.
 */
import { agrees, parseMoney, readFigure, type Journey } from "./common";

export const portfolio: Journey = {
  name: "portfolio",
  budgetMs: 120_000,
  wallet: true,
  async run(ctx) {
    const page = ctx.page;
    await ctx.step("open /portfolio", () => ctx.goto("/portfolio", (p) => p.getByRole("heading", { level: 1 })));
    await ctx.step("empty state", async () => {
      const prompt = page.getByRole("heading", { name: "Connect a wallet to see your portfolio." });
      if (ctx.connected) {
        // An earlier journey in this session left the wallet connected (the
        // adapter reconnects it on load), so the page shows the portfolio.
        // The prompt is wrong here; its absence is not.
        await ctx.addressTile().first().waitFor({ state: "visible", timeout: 10_000 }).catch(() => undefined);
        if (await prompt.first().isVisible().catch(() => false)) {
          await ctx.rec.issue("empty-state", "low", "Portfolio asks to connect a wallet that is connected", { key: "portfolio empty connected" });
        }
      } else if (!(await prompt.first().waitFor({ state: "visible", timeout: 5_000 }).then(() => true, () => false))) {
        // Before connecting, the page should say what connecting gives.
        await ctx.rec.issue("empty-state", "low", "Portfolio without a wallet does not say to connect one", { key: "portfolio empty" });
      }
      await ctx.checkPage();
    });
    await ctx.connect(ctx.rng.chance(0.5) ? page.getByRole("button", { name: "Connect wallet" }) : undefined);
    await ctx.step("figures against the API", async () => {
      await page.waitForTimeout(2_500);
      await agrees(ctx, "Portfolio's Available USDC",
        async () => parseMoney(await readFigure(page, "Available USDC")),
        async () => (await ctx.account())?.usdc ?? null);
      await agrees(ctx, "Portfolio's Pool (xLP)",
        async () => parseMoney(await readFigure(page, "Pool (xLP)")),
        async () => (await ctx.account())?.lp.value ?? null, 0.02);
      await ctx.checkPage();
    });
    await ctx.step("scroll the lists", async () => {
      for (let i = 0; i < 3; i++) { await page.mouse.wheel(0, 600); await ctx.think(500); }
      await ctx.checkPage();
    });
  },
};
