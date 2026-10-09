/*
 * The site's edges: the theme switch, the page menu on a phone (or the nav
 * bar on a desktop), addresses that name nothing, the legal pages, and the
 * old query-string addresses that must still land.
 */
import { pause, type Journey } from "./common";

const PAGES = ["Markets", "Trade", "Earn", "Portfolio", "Rewards", "List"];

export const tour: Journey = {
  name: "tour",
  budgetMs: 180_000,
  wallet: false,
  async run(ctx) {
    const page = ctx.page;
    await ctx.step("open /markets", () => ctx.goto("/markets", (p) => p.getByPlaceholder("Search ticker or name")));

    await ctx.step("theme switch", async () => {
      const before = await page.evaluate(() => document.documentElement.dataset.theme);
      if (before !== ctx.persona.theme) {
        await ctx.rec.issue("theme", "medium", `Stored theme ${ctx.persona.theme} but the page drew ${before}`, { key: "theme stored" });
      }
      const toggle = page.getByRole("button", { name: /^Switch to (light|dark) theme$/ });
      await ctx.click(toggle, "the theme switch");
      await pause(400);
      const after = await page.evaluate(() => document.documentElement.dataset.theme);
      if (after === before) await ctx.rec.issue("theme", "high", "The theme switch did not change the theme", { key: "theme toggle" });
      await ctx.checkPage();
      await ctx.click(toggle, "the theme switch (back)");
    });

    // Every page from the menu (phone, tablet, laptop) or the bar (wide).
    for (const name of ctx.rng.shuffle(PAGES).slice(0, ctx.rng.int(2, 4))) {
      await ctx.step(`nav to ${name}`, async () => {
        const t = Date.now();
        const bar = page.getByRole("navigation", { name: "Pages" }).getByRole("link", { name, exact: true });
        if (await bar.first().isVisible().catch(() => false)) {
          await ctx.click(bar, `${name} in the bar`);
        } else {
          const menu = page.getByRole("button", { name: "Open menu" });
          await ctx.click(menu, "the page menu");
          await ctx.click(page.getByRole("navigation", { name: "Pages" }).getByRole("link", { name, exact: true }), `${name} in the menu`);
        }
        await page.waitForLoadState("domcontentloaded");
        await ctx.ready(page.locator("main"), `${name} page`, t);
        await ctx.think(700);
        await ctx.checkPage();
      });
    }

    const odd = ctx.rng.shuffle([
      { path: `/nope-${ctx.rng.int(100, 999)}`, want: (p: typeof page) => p.getByRole("heading", { name: "Nothing here." }) },
      { path: "/trade/NOTAMARKET", want: (p: typeof page) => p.getByRole("button", { name: /^(Place (long|short)|Connect wallet|Long)/ }) },
      { path: "/vault/NOTAVAULT", want: (p: typeof page) => p.getByText(/^No vault called/) },
      { path: "/terms", want: (p: typeof page) => p.getByRole("heading", { level: 1 }) },
      { path: "/privacy", want: (p: typeof page) => p.getByRole("heading", { level: 1 }) },
      { path: "/disclosures", want: (p: typeof page) => p.getByRole("heading", { level: 1 }) },
      { path: "/trade?symbol=SOL", want: (p: typeof page) => p.getByRole("button", { name: /^(Place (long|short)|Connect wallet|Long)/ }), lands: "/trade/SOL" },
      { path: "/list?q=bonk", want: (p: typeof page) => p.getByRole("heading", { name: /^(List|Back) a market$/ }), lands: "/list/bonk" },
      { path: "/vault?id=pool", want: (p: typeof page) => p.getByRole("heading", { level: 1 }), lands: "/vault/pool" },
      { path: "/waitlist", want: (p: typeof page) => p.getByPlaceholder("Search ticker or name"), lands: "/" },
    ]).slice(0, ctx.rng.int(2, 4));
    for (const o of odd) {
      await ctx.step(`deep link ${o.path.replace(/\d+/g, "n")}`, async () => {
        await ctx.goto(o.path, o.want);
        if (o.lands && new URL(page.url()).pathname !== o.lands) {
          await ctx.rec.issue("deep-link", "medium", `${o.path} landed on ${new URL(page.url()).pathname}, expected ${o.lands}`, { key: `lands ${o.path}` });
        }
        await ctx.checkPage();
      });
    }

    await ctx.step("browser back", async () => {
      await page.goBack({ waitUntil: "domcontentloaded" }).catch(() => undefined);
      await pause(1_000);
      await ctx.checkPage();
    });
  },
};
