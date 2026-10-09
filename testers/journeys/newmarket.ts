/*
 * A new market end to end: search a token devnet does not list, read the
 * preview, post the minimum backing and list it; then find it on /markets
 * and in /api/markets, wait for its first price within the window the
 * preview promised, and trade it with one small order (closed afterwards).
 *
 * Listings share list.ts's daily budget (LISTINGS_PER_DAY, fleet wide, never
 * in a dry run). Tokens the fleet listed before and devnet no longer shows
 * are listed again first; only then the next of LIST_CANDIDATES that devnet
 * does not have. Over the budget, or in a dry run, the journey stops at the
 * review and checks the fleet's earlier listings are still listed and priced.
 */
import { config } from "../config";
import { live, openTrade, type Journey } from "./common";
import * as fu from "./followup";
import { acct, closeVia, freshMarkets, marketOrder, settled, until, type MarketFull, connected } from "./venue";
import { listingAllowed } from "../txgate";
import * as store from "../store";
import type { Ctx } from "../session";

const NAME = "newmarket";
const BACKING_USD = 100;
const ORDER_USD = 10;
const FLEET_KEY = "list:fleet";

interface Listed { symbol: string; query: string; at: number }
interface State { sym: string; query: string; listedAt: number; priceBy: number }

const fleetListed = (): Listed[] => { try { return JSON.parse(store.getMeta(FLEET_KEY) ?? "[]"); } catch { return []; } };
const remember = (l: Listed) => store.setMeta(FLEET_KEY, JSON.stringify([...fleetListed().filter((x) => x.query !== l.query), l].slice(-30)));
const skipKey = (q: string) => `list:skip:${q.toLowerCase()}`;

const priced = (m?: MarketFull) => !!m && m.price > 0 && m.priceAgeMs != null && m.priceAgeMs / 1000 < m.maxPriceAgeSec;

export const newmarket: Journey = {
  name: NAME,
  budgetMs: 200_000,
  wallet: true,
  async run(ctx) {
    const id = ctx.persona.id;
    const plan = fu.get<State>(id, NAME);
    const stage = plan?.stage ?? "list";
    if (stage === "list") return list(ctx);
    const s = plan!.data;
    const m = (await freshMarkets(ctx)).find((x) => x.symbol === s.sym);
    if (!m) {
      await ctx.rec.issue("market-missing", "high", `${NAME}: ${s.sym}, listed by the fleet, is gone from /api/markets`, { key: `${NAME} gone` });
      return fu.clear(id, NAME);
    }

    if (stage === "price") {
      if (priced(m)) { fu.next<State>(id, NAME, "trade", fu.txReadyAt(id), s); return; }
      if (Date.now() < s.priceBy) { fu.next<State>(id, NAME, "price", Math.min(s.priceBy, Date.now() + 3 * 60_000), s); return; }
      await ctx.rec.issue("listing-unpriced", "high", `${NAME}: ${s.sym} has no price ${Math.round((Date.now() - s.listedAt) / 60_000)} min after listing, past the preview's promise`, { key: `${NAME} no first price` });
      return fu.clear(id, NAME);
    }

    await openTrade(ctx, m);
    await connected(ctx);
    if (stage === "trade") {
      const [r, why] = await marketOrder(ctx, m, ctx.rng.chance(0.5) ? "long" : "short", ORDER_USD, Math.min(1.5, m.maxLeverage));
      if (r === "skipped") { fu.next<State>(id, NAME, "trade", fu.txReadyAt(id), s); return; }
      if (r === "blocked") {
        await ctx.rec.issue("order-blocked", "high", `${NAME}: the new market ${s.sym} would not take a $${ORDER_USD} order: ${why}`, { key: `${NAME} first order blocked` });
        return fu.clear(id, NAME);
      }
      if (r !== "confirmed") return fu.clear(id, NAME);
      const a = await ctx.step("watch it settle", () => settled(ctx, (x) => !!x.positions[s.sym]));
      if (!a) {
        await ctx.rec.issue("position-missing", "high", `${NAME}: first order on the new market ${s.sym} confirmed but no position after 30s`, { key: `${NAME} first order` });
        return fu.clear(id, NAME);
      }
      fu.note(NAME, id, `${s.sym}: listed, priced and traded ($${a.positions[s.sym].size} at ${a.positions[s.sym].entry})`);
      fu.next<State>(id, NAME, "close", fu.txReadyAt(id), s);
      return;
    }
    if (stage === "close") {
      const r = await closeVia(ctx, s.sym, null);
      if (r === "skipped") { fu.next<State>(id, NAME, "close", fu.txReadyAt(id), s); return; }
      fu.clear(id, NAME);
    }
  },
};

async function list(ctx: Ctx) {
  const page = ctx.page;
  const before = await freshMarkets(ctx);
  const have = new Set(before.map((m) => m.symbol.toUpperCase()));
  // A dry run walks to the review and stops there; a live one lists only
  // within the day's budget.
  const may = !live() || listingAllowed();
  const queries = [
    ...fleetListed().filter((l) => !have.has(l.symbol.toUpperCase())).map((l) => l.query),
    ...config.listCandidates.filter((q) => !have.has(q.toUpperCase())),
  ].filter((q) => !store.getMeta(skipKey(q)));
  if (!may || !queries.length) return stillListed(ctx, before);
  const q = queries[0];

  await ctx.step("open /list", () => ctx.goto("/list", (p) => p.getByRole("heading", { name: /^(List|Back) a market$/ })));
  await connected(ctx);
  const picked = await ctx.step(`search ${q}`, async () => {
    await ctx.type(page.getByRole("combobox"), q);
    // The row's symbol carries it as a title; its text starts with the
    // icon's fallback letter, so the text alone cannot be anchored.
    const rows = page.getByRole("listbox").getByRole("button").filter({ has: page.locator(`span[title="${q}"]`) });
    if (!(await rows.first().waitFor({ state: "visible", timeout: 15_000 }).then(() => true, () => false))) return false;
    // A devnet pool someone seeded needs no copy; prefer it.
    const devnet = rows.filter({ hasText: "devnet pool" });
    await ctx.click((await devnet.count()) ? devnet.first() : rows.first(), `${q} in the results`);
    return true;
  });
  if (!picked) {
    store.setMeta(skipKey(q), String(Date.now()));
    fu.note(NAME, ctx.persona.id, `${q}: no listable result; skipped from now on`);
    return;
  }

  const status = await ctx.step("wait for the preview", async () => {
    const ok = page.getByText(/^(Live at listing|Opening auction in|Too thin|Pool not read)/);
    if (!(await ok.first().waitFor({ state: "visible", timeout: 30_000 }).then(() => true, () => false))) {
      await ctx.rec.issue("list-preview", "medium", `${NAME}: preview for ${q} still reading the pool after 30s`, { key: `${NAME} preview slow` });
      return "";
    }
    return ok.first().innerText().catch(() => "");
  });
  if (!/^(Live at listing|Opening auction in)/.test(status)) {
    if (status) { store.setMeta(skipKey(q), String(Date.now())); fu.note(NAME, ctx.persona.id, `${q}: preview "${status}"; skipped from now on`); }
    return;
  }
  // "Opening auction in ~15m": the promise is that long; live at listing,
  // the keeper's next pass.
  const mins = Number(/~(\d+)m/.exec(status)?.[1] ?? 0);
  const window = mins ? mins * 60_000 + 2 * 60_000 : config.listPriceWindowMs;

  const cta = page.getByRole("button", { name: /^List .+$/ });
  await ctx.step("back it", async () => {
    const usdc = page.getByRole("radiogroup", { name: "Pay with" }).getByRole("radio", { name: /^USDC/ });
    if (await usdc.first().isVisible().catch(() => false) && (await usdc.first().getAttribute("aria-checked")) !== "true") {
      await ctx.click(usdc, "Pay with USDC", { expectChange: false });
    }
    await ctx.type(page.getByRole("textbox", { name: "Backing in USDC" }), String(BACKING_USD));
    await ctx.click(page.getByRole("checkbox", { name: "My backing takes this market's losses first" }), "the acknowledgement");
    await ctx.checkPage();
  });
  const label = await cta.first().innerText().catch(() => "");
  if (!(await cta.first().isEnabled().catch(() => false))) {
    if (((await acct(ctx))?.usdc ?? 0) < BACKING_USD) return; // the fleet's funding, not the site
    await ctx.rec.issue("list-blocked", "medium", `${NAME}: "${label}" stayed disabled for ${q} with $${BACKING_USD} backing and the box ticked`, { key: `${NAME} cta disabled` });
    return;
  }
  if (!live()) return;
  ctx.allowMirror = true;
  const r = await ctx.step("list it", () => ctx.tx("list-market", () => ctx.click(cta, `"${label}"`)));
  ctx.allowMirror = false;
  if (r !== "confirmed") return;
  const listedAt = Date.now();

  const m = await ctx.step("watch /api/markets", () => until(ctx, async () =>
    (await freshMarkets(ctx)).find((x) => !have.has(x.symbol.toUpperCase())), 60_000, 2_000));
  if (!m) {
    await ctx.rec.issue("market-missing", "high", `${NAME}: listed ${q} (confirmed) but no new market in /api/markets after 60s`, { key: `${NAME} not in markets` });
    return;
  }
  remember({ symbol: m.symbol, query: q, at: listedAt });
  await ctx.step("watch /markets", () => onMarkets(ctx, m.symbol));
  const s: State = { sym: m.symbol, query: q, listedAt, priceBy: listedAt + window };
  if (!mins) {
    const p = await ctx.step("watch for the first price", () => until(ctx, async () =>
      (await freshMarkets(ctx)).find((x) => x.symbol === m.symbol && priced(x)), Math.max(0, s.priceBy - Date.now()), 5_000));
    if (!p) {
      await ctx.rec.issue("listing-unpriced", "high", `${NAME}: ${m.symbol} listed "Live at listing" but had no price ${Math.round(window / 1000)}s later`, { key: `${NAME} no first price` });
      return;
    }
    fu.next<State>(ctx.persona.id, NAME, "trade", fu.txReadyAt(ctx.persona.id), s, Date.now());
  } else {
    fu.next<State>(ctx.persona.id, NAME, "price", Date.now() + mins * 60_000, s, Date.now());
  }
}

/// Over the budget: the fleet's earlier listings, on the page and the API.
async function stillListed(ctx: Ctx, markets: MarketFull[]) {
  const mine = fleetListed();
  if (!mine.length) return;
  const l = ctx.rng.pick(mine);
  const m = markets.find((x) => x.symbol === l.symbol);
  if (!m) return; // relisted on a later day, within the budget
  if (m.hidden) {
    await ctx.rec.issue("market-hidden", "medium", `${NAME}: ${m.symbol}, listed by the fleet, is hidden in /api/markets`, { key: `${NAME} hidden`, shot: false });
    return;
  }
  await ctx.step("watch /markets", () => onMarkets(ctx, m.symbol));
}

async function onMarkets(ctx: Ctx, sym: string) {
  await ctx.goto("/markets", (p) => p.getByRole("textbox", { name: "Search markets" }));
  await ctx.type(ctx.page.getByRole("textbox", { name: "Search markets" }), sym);
  const link = ctx.page.locator(`a[href="/trade/${encodeURIComponent(sym)}"]`);
  if (!(await link.first().waitFor({ state: "visible", timeout: 10_000 }).then(() => true, () => false))) {
    await ctx.rec.issue("market-missing", "high", `${NAME}: ${sym} is in /api/markets but searching /markets for it shows no row`, { key: `${NAME} not on /markets` });
  }
}
