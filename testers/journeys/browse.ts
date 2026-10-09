/*
 * The front door: the market list, its groups and filters, a search, a
 * star, then a market opened either from the Cmd K menu or from its row.
 */
import { type Journey } from "./common";
import { StepError } from "../session";

const GROUPS = ["All markets", "Movers", "Equities", "Memecoins", "Crypto", "Opened by anyone"];
const SORTS = ["Price", "Open interest", "24h change", "24h volume", "Per batch"];

export const browse: Journey = {
  name: "browse",
  budgetMs: 150_000,
  wallet: false,
  async run(ctx) {
    const page = ctx.page;
    const search = () => page.getByPlaceholder("Search ticker or name");
    const start = ctx.rng.pick(["/", "/", "/markets"]);
    await ctx.step(`open ${start}`, () => ctx.goto(start, search));
    await ctx.step("check the list", async () => {
      // The list arrives on its own poll after the page.
      await ctx.ready(page.locator('a[href^="/trade/"]'), "market rows");
      await ctx.checkPage();
    });
    const markets = await ctx.tradeable();
    const m = await ctx.pickMarket();

    for (const g of ctx.rng.shuffle(GROUPS).slice(0, ctx.rng.int(1, 3))) {
      await ctx.step(`group ${g}`, async () => {
        const b = page.getByRole("button", { name: g, exact: true });
        if (!(await b.first().isVisible().catch(() => false))) return;
        // The group already open has nothing to change into, so it is
        // allowed to stay still.
        const open = (await b.first().getAttribute("aria-pressed")) === "true";
        await ctx.click(b, `the ${g} group`, { expectChange: !open });
        if ((await b.first().getAttribute("aria-pressed")) !== "true") {
          await ctx.rec.issue("control-mismatch", "medium", `The ${g} group did not show as selected after a click`, { key: `group ${g}` });
        }
        await ctx.think(700);
      });
    }

    if (ctx.rng.chance(0.6)) {
      await ctx.step("filters", async () => {
        await ctx.click(page.getByRole("button", { name: /^Filters/ }), "Filters");
        const sort = ctx.rng.pick(SORTS);
        const radio = page.getByRole("radio", { name: sort, exact: true });
        if (await radio.first().isVisible().catch(() => false)) await ctx.click(radio, `sort by ${sort}`);
        const show = page.getByRole("button", { name: ctx.rng.pick(["Trading now", "With open interest"]), exact: true });
        if (await show.first().isVisible().catch(() => false)) await ctx.click(show, "a Show filter");
        await ctx.checkPage();
        const clear = page.getByRole("button", { name: "Clear", exact: true });
        if (await clear.first().isVisible().catch(() => false)) await ctx.click(clear, "Clear filters");
      });
    }
    if (ctx.rng.chance(0.4)) {
      await ctx.step("price source", async () => {
        await ctx.click(page.getByRole("button", { name: /^Price source:/ }), "the price source menu");
        const opt = page.getByRole("button", { name: /^Show (oracle|pool|all sources)$/ });
        await ctx.click(opt.first(), "a price source");
      });
    }

    if (m) {
      await ctx.step("search the list", async () => {
        await ctx.click(page.getByRole("button", { name: "All markets", exact: true }), "All markets", { expectChange: false }).catch(() => {});
        await ctx.type(search(), m.symbol.slice(0, ctx.rng.int(2, m.symbol.length)));
        await ctx.think(800);
        const row = page.locator(`a[href="/trade/${encodeURIComponent(m.symbol)}"]`);
        if (!(await row.first().waitFor({ state: "visible", timeout: 5_000 }).then(() => true, () => false))) {
          await ctx.rec.issue("search-miss", "medium", `Typing part of ${m.symbol} into the market search did not show its row`, { key: "search miss" });
        }
      });

      if (ctx.rng.chance(0.5)) {
        await ctx.step("star a market", async () => {
          const star = page.getByRole("button", { name: new RegExp(`^(Star|Unstar) ${m.symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) });
          if (!(await star.first().isVisible().catch(() => false))) return;
          const was = await star.first().getAttribute("aria-pressed");
          await ctx.click(star, `the star on ${m.symbol}`);
          if ((await star.first().getAttribute("aria-pressed")) === was) {
            await ctx.rec.issue("control-mismatch", "medium", `Starring ${m.symbol} did not change its state`, { key: "star" });
          }
          await search().fill("");
          const watch = page.getByRole("button", { name: "Watchlist", exact: true });
          if (was !== "true" && await watch.first().isVisible().catch(() => false)) {
            await ctx.click(watch, "Watchlist");
            if (!(await page.locator(`a[href="/trade/${encodeURIComponent(m.symbol)}"]`).first().waitFor({ state: "visible", timeout: 4_000 }).then(() => true, () => false))) {
              await ctx.rec.issue("watchlist", "medium", `${m.symbol} starred but missing from the Watchlist group`, { key: "watchlist" });
            }
          }
        });
      }

      const viaMenu = ctx.rng.chance(0.55);
      await ctx.step(viaMenu ? "open a market with Cmd K" : "open a market from its row", async () => {
        const t = Date.now();
        if (viaMenu) {
          await page.keyboard.press(ctx.rng.chance(0.5) ? "Control+k" : "Meta+k");
          const dialog = page.getByRole("dialog");
          await ctx.ready(dialog, "the Cmd K menu");
          await ctx.type(page.getByPlaceholder("Search markets and pages"), m.symbol);
          // The option's name runs the symbol into the name ("JUPJupiter $0.37").
          const opt = page.getByRole("option", { name: new RegExp(`^${m.symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`) });
          // The menu fetches its own list on open; note it if, meanwhile,
          // it tells the reader there are no results.
          const typed = Date.now();
          let saidNone = false;
          while (Date.now() - typed < 15_000 && !(await opt.first().isVisible().catch(() => false))) {
            if (await page.getByText(/^No results for/).first().isVisible().catch(() => false)) saidNone = true;
            await page.waitForTimeout(250);
          }
          if (!(await opt.first().isVisible().catch(() => false))) {
            const detail = await dialog.first().ariaSnapshot().catch(() => "");
            await ctx.rec.issue("search-miss", "medium", `Cmd K search for ${m.symbol} listed no market in 15s`, { key: "cmdk miss", detail });
            throw new StepError("market not in Cmd K");
          }
          if (saidNone) {
            await ctx.rec.issue("loading-state", "low",
              `Cmd K said "No results for ${m.symbol}" for ${((Date.now() - typed) / 1000).toFixed(1)}s while its market list loaded`,
              { key: "cmdk no results while loading" });
          }
          await page.keyboard.press("Enter");
        } else {
          await search().fill("");
          await ctx.click(page.getByRole("button", { name: "All markets", exact: true }), "All markets", { expectChange: false }).catch(() => {});
          await ctx.click(page.locator(`a[href="/trade/${encodeURIComponent(m.symbol)}"]`), `the ${m.symbol} row`);
        }
        await page.waitForURL((u) => u.pathname.startsWith("/trade/"), { timeout: 15_000 })
          .catch(() => { throw new StepError("did not reach the trade page"); });
        await ctx.ready(ctx.phone ? page.getByRole("button", { name: /^Long\b/ })
          : page.getByRole("button", { name: /^(Place (long|short)|Connect wallet)/ }), "the trade page", t);
        await ctx.checkPage();
      });
    } else if (!markets.length) {
      await ctx.rec.issue("no-markets", "high", "The API lists no tradeable market", { key: "no markets", shot: false });
    }
  },
};
