/*
 * The page's figures against the API's, beyond rounding.
 *
 * One persona, desktop. As a visitor first: /markets (each row's price, open
 * interest, 24h change and volume, per-batch fill) and two trade pages (the
 * header's mark, spread, volume, open interest, funding and leverage cap;
 * the market list beside the chart; the Liquidity panel's bid, ask, caps and
 * pool; the batch clock, the last clear and the resting book against
 * /api/batch/:sym). Then connected: /portfolio's balances and positions
 * against /api/account.
 *
 * Prices move between two reads, so a field that disagrees is read again,
 * page and API both, three seconds later, and filed only if it still does.
 * Each issue says the field, what the page showed, what the API said and
 * where.
 */
import type { Browser, Page } from "playwright-core";
import { config } from "../config";
import { keyOf } from "../personas";
import { routeOf } from "../detectors";
import type { AccountView, Ctx, Market } from "../session";
import { StepError } from "../session";
import { api, asPersona, fileIssue, pause, persona, READ_LABELS, sameFigure } from "./common";

interface BatchView {
  exists: boolean; seq: number; clearsAtMs: number; sealed: boolean;
  opening: { opensAtMs: number } | null;
  resting: { price: number; size: number; isBid: boolean; house: boolean }[];
  last: { buyPrice: number | null; sellPrice: number | null; matched: number } | null;
}

/// One comparison: what the page printed and what the API holds.
interface Reading { field: string; where: string; shown: string; truth: number | string; ok: boolean }

const fmt = (n: number) => (Number.isFinite(n) ? String(Math.round(n * 1e8) / 1e8) : String(n));

const num = (field: string, where: string, shown: string | undefined, truth: number | null | undefined,
  o: { compact?: boolean; slack?: number } = {}): Reading | null => {
  if (shown == null || truth == null || !Number.isFinite(truth)) return null;
  // A dash where the API has nothing (or zero) agrees.
  if (/^[–-]{1,2}$/.test(shown.trim())) return { field, where, shown, truth, ok: truth === 0 };
  return { field, where, shown, truth, ok: sameFigure(shown, truth, o) };
};

// ------------------------------------------------------------ /markets

async function readMarkets(page: Page): Promise<Reading[]> {
  const [rows, list] = await Promise.all([
    page.evaluate(() => Array.from(document.querySelectorAll('main a[href^="/trade/"]')).map((a) => {
      const row = a.parentElement!;
      const cells = Array.from(row.querySelectorAll(":scope > span.n")).map((s) => (s.textContent ?? "").trim());
      const chip = row.querySelector(":scope > span:last-child span.n")?.textContent?.trim() ?? null;
      return { sym: decodeURIComponent(a.getAttribute("href")!.split("/")[2] ?? ""), cells, chip };
    })),
    api<Market[]>("/api/markets"),
  ]);
  if (!list) return [];
  if (!rows.length) throw new StepError("no market rows on /markets");
  const out: Reading[] = [];
  for (const r of rows) {
    const m = list.find((x) => x.symbol === r.sym) as (Market & Record<string, any>) | undefined;
    if (!m) continue;
    // Price, open interest, 24h change, 24h volume, as the columns read.
    if (r.cells.length !== 4) throw new StepError(`a /markets row has ${r.cells.length} figures, the check expects 4`);
    const w = `/markets ${m.symbol}`;
    out.push(...[
      num("price", w, r.cells[0], m.price),
      num("open interest", w, r.cells[1], m.oi, { compact: true }),
      num("24h change", w, r.cells[2], m.changePct),
      num("24h volume", w, r.cells[3], m.volume24h, { compact: true }),
      num("per batch", w, r.chip ?? undefined, m.poolFillUsd ?? Math.max(0, m.lossBudgetUsd ?? 0) * 0.05, { compact: true }),
    ].filter((x): x is Reading => !!x));
  }
  return out;
}

// ------------------------------------------------------------ /trade/:sym

/// The batch's phase, by the page's own rule (BatchClock's phaseOf).
function phaseOf(b: BatchView, now: number) {
  if (b.opening) return "Opening auction";
  if (!b.sealed && b.clearsAtMs - now > 0) return "Collecting";
  if (!b.sealed && b.resting.every((o) => o.house)) return "Waiting for orders";
  return "Clearing";
}

async function readTrade(page: Page, sym: string): Promise<Reading[]> {
  const t = Date.now();
  const [header, panels, ui, list, batch] = await Promise.all([
    page.evaluate(READ_LABELS, { scope: "main header", labels: ["Mark", "Reference", "Spread", "24h volume", "Open interest", "1h funding"] }),
    page.evaluate(READ_LABELS, { labels: ["Bid", "Ask", "Max long", "Max short", "Per batch", "Pool free", "Buy", "Sell", "Matched"] }),
    page.evaluate(() => {
      const lev = Array.from(document.querySelectorAll("main header span")).map((s) => (s.textContent ?? "").trim()).find((s) => /^\d+(\.\d+)?x$/.test(s)) ?? null;
      const timer = document.querySelector("main [role=timer][aria-label^='Batch']")?.getAttribute("aria-label") ?? null;
      // The market list beside the chart, one button a market:
      // "SOL4xSolana$109.78+3.03%" once its spacing is gone.
      const side = Array.from(document.querySelectorAll("main aside button"))
        .map((b) => (b.textContent ?? "").replace(/\s+/g, ""))
        .filter((s) => /x.*\$[\d,.]+[+-][\d.]+%$/.test(s));
      // Resting orders, as "price" and "$size" pairs under Resting / Size.
      const resting: { price: string; size: string }[] = [];
      const head = Array.from(document.querySelectorAll("main span")).find((s) => s.textContent?.trim() === "Resting");
      const book = head?.parentElement?.nextElementSibling;
      book?.querySelectorAll(":scope > div").forEach((row) => {
        const spans = row.querySelectorAll(":scope > span");
        if (spans.length < 2) return;
        const price = (spans[0].firstChild?.textContent ?? "").trim();
        const size = (spans[spans.length - 1].textContent ?? "").trim();
        if (/^\d/.test(price) && /^\$/.test(size)) resting.push({ price, size });
      });
      return { lev, timer, side, resting };
    }),
    api<Market[]>("/api/markets"),
    api<BatchView>(`/api/batch/${encodeURIComponent(sym)}`),
  ]);
  const out: Reading[] = [];
  const m = list?.find((x) => x.symbol === sym) as (Market & Record<string, any>) | undefined;
  if (!m) return out;
  const w = `/trade/${sym}`;
  const h = (k: string) => header[k]?.[0];
  const p = (k: string) => panels[k]?.[0];
  const mid = (m.bid + m.ask) / 2;
  out.push(...[
    num("mark", w, h("Mark"), mid),
    num("reference price", w, h("Reference"), m.price),
    num("spread", w, h("Spread"), mid > 0 ? ((m.ask - m.bid) / mid) * 100 : null, { slack: 0.02 }),
    num("24h volume", w, h("24h volume"), m.volume24h, { compact: true }),
    num("open interest", w, h("Open interest"), m.oi, { compact: true }),
    num("1h funding", w, h("1h funding"), (m.fundingRateLongBps ?? 0) / 100),
    num("leverage cap", w, ui.lev ?? undefined, m.maxLeverage),
    num("bid", w, p("Bid"), m.bid),
    num("ask", w, p("Ask"), m.ask),
    num("max long", w, p("Max long"), m.capLong, { compact: true }),
    num("max short", w, p("Max short"), m.capShort, { compact: true }),
    num("per batch", w, p("Per batch"), m.poolFillUsd ?? Math.max(0, m.lossBudgetUsd ?? 0) * 0.05, { compact: true }),
    num("pool free", w, p("Pool free"), m.freeLiquidity, { compact: true }),
  ].filter((x): x is Reading => !!x));

  // The list beside the chart: each market's leverage cap and price.
  // Matched by the longest symbol it starts with, so "1KPENGU4x" is 1KPENGU
  // at 4x and not 1 at some other cap.
  const bySize = [...list!].sort((a, b) => b.symbol.length - a.symbol.length);
  for (const s of ui.side) {
    const x = bySize.find((y) => s.startsWith(y.symbol) && /^\d+(\.\d+)?x/.test(s.slice(y.symbol.length)));
    if (!x) continue;
    const rest = s.slice(x.symbol.length);
    const lev = /^(\d+(?:\.\d+)?)x/.exec(rest)?.[1];
    const px = /(\$[\d,.]+)[+-][\d.]+%$/.exec(rest)?.[1];
    out.push(...[
      num("leverage cap (market list)", `${w} list ${x.symbol}`, lev, x.maxLeverage),
      num("price (market list)", `${w} list ${x.symbol}`, px, x.price),
    ].filter((r): r is Reading => !!r));
  }

  if (batch?.exists) {
    const seq = /Batch (\d+)/.exec(ui.timer ?? "")?.[1];
    if (seq != null) out.push({ field: "batch number", where: w, shown: seq, truth: batch.seq, ok: Math.abs(Number(seq) - batch.seq) <= 1 });
    const phase = /Batch \d+, (.+)$/.exec(ui.timer ?? "")?.[1];
    // A one-second window flips between two reads; only a phase the API is
    // not near is a disagreement.
    if (phase && phase !== "Collecting") {
      const want = phaseOf(batch, t);
      out.push({ field: "batch phase", where: w, shown: phase, truth: want, ok: phase === want || want === "Collecting" || phase === "Clearing" });
    }
    out.push(...[
      num("last clear buy price", w, p("Buy"), batch.last?.buyPrice ?? 0),
      num("last clear sell price", w, p("Sell"), batch.last?.sellPrice ?? 0),
      num("last clear matched", w, p("Matched"), batch.last?.matched ?? 0, { compact: true }),
    ].filter((x): x is Reading => !!x));
    // The book: every resting size the page lists should be one the API has.
    const sizes = batch.resting.map((o) => o.size);
    for (const r of ui.resting) {
      const ok = sizes.some((s) => sameFigure(r.size, s, { compact: true }));
      out.push({ field: "resting order size", where: `${w} book ${r.price}`, shown: r.size, truth: sizes.map(fmt).join(", ") || "none", ok });
    }
    if (!ui.resting.length && batch.resting.length && ui.timer) {
      out.push({ field: "resting orders", where: w, shown: "none", truth: `${batch.resting.length} orders`, ok: false });
    }
  }
  return out;
}

// ------------------------------------------------------------ /portfolio

async function readPortfolio(page: Page, owner: string, where: string): Promise<Reading[]> {
  const [stats, ui, acct] = await Promise.all([
    page.evaluate(READ_LABELS, { scope: "main aside", labels: ["Available USDC", "Margin", "Unrealized PnL"] }),
    page.evaluate(() => {
      const card = Array.from(document.querySelectorAll("main section")).find((s) => s.querySelector("h2")?.textContent?.trim() === "Positions");
      const rows = Array.from(card?.querySelectorAll('a[href^="/trade/"]') ?? []).map((a) => {
        const cells = Array.from(a.querySelectorAll(":scope > span")).map((s) => (s.textContent ?? "").replace(/\s+/g, " ").trim());
        return { sym: decodeURIComponent(a.getAttribute("href")!.split("/")[2] ?? ""), cells };
      });
      const empty = !!card && /No open positions/.test(card.textContent ?? "");
      return { rows, empty, loaded: !!card };
    }),
    api<AccountView & { margin: number; unrealized: number }>(`/api/account?owner=${owner}`),
  ]);
  if (!acct) return [];
  const out: Reading[] = [];
  out.push(...[
    num("available USDC", where, stats["Available USDC"]?.[0], acct.usdc),
    num("margin", where, stats["Margin"]?.[0], acct.margin),
  ].filter((x): x is Reading => !!x));
  if (!ui.loaded) return out;
  const held = Object.entries(acct.positions ?? {});
  const shown = new Set(ui.rows.map((r) => r.sym));
  for (const [sym] of held) {
    if (!shown.has(sym)) out.push({ field: "position missing", where: `${where} ${sym}`, shown: "no row", truth: `${sym} open`, ok: false });
  }
  for (const r of ui.rows) {
    const p = acct.positions?.[r.sym];
    if (!p) { out.push({ field: "position extra", where: `${where} ${r.sym}`, shown: "a row", truth: "no position", ok: false }); continue; }
    // Market, Side, Size, Entry, Mark, PnL, Liq. price, Margin.
    const [, side, size, entry, , , , margin] = r.cells;
    if (side) out.push({ field: "position side", where: `${where} ${r.sym}`, shown: side, truth: p.isLong ? "Long" : "Short", ok: side === (p.isLong ? "Long" : "Short") });
    out.push(...[
      num("position size", `${where} ${r.sym}`, size, p.size),
      num("position entry", `${where} ${r.sym}`, entry, p.entry),
      num("position margin", `${where} ${r.sym}`, margin, p.collateral),
    ].filter((x): x is Reading => !!x));
  }
  return out;
}

// ------------------------------------------------------------ the check

/// Reads, and reads again what disagreed; files what disagreed both times.
async function compare(ctx: Ctx, read: () => Promise<Reading[]>, severity: "high" | "medium"): Promise<{ checked: number; filed: number }> {
  const first = await read();
  if (process.env.VERBOSE) for (const r of first) console.log(`  ${r.ok ? "=" : "≠"} ${r.where} ${r.field}: ${r.shown} | ${r.truth}`);
  const bad = first.filter((r) => !r.ok);
  if (!bad.length) return { checked: first.length, filed: 0 };
  await pause(3_000);
  const second = await read();
  const still = second.filter((r) => !r.ok && bad.some((b) => b.field === r.field && b.where === r.where));
  for (const r of still) {
    const was = bad.find((b) => b.field === r.field && b.where === r.where)!;
    await fileIssue({
      type: "number-mismatch", severity, route: routeOf(r.where.split(" ")[0]),
      message: `${r.field} on ${r.where}: the page shows ${r.shown}, the API says ${typeof r.truth === "number" ? fmt(r.truth) : r.truth}`
        + ` (first read: ${was.shown} vs ${typeof was.truth === "number" ? fmt(was.truth) : was.truth})`,
      key: `numbers ${r.field}`,
      persona: ctx.persona.id, device: ctx.persona.device.name, theme: ctx.persona.theme, step: "numbers",
    }, ctx.page);
  }
  return { checked: second.length, filed: still.length };
}

/// The persona to read: the first of NUMBERS_PERSONAS holding a position,
/// else the first.
async function pickPersona() {
  for (const id of config.numbersPersonas) {
    try {
      const p = persona(id);
      const a = await api<AccountView>(`/api/account?owner=${keyOf(p).publicKey.toBase58()}`);
      if (a && Object.keys(a.positions ?? {}).length) return p;
    } catch { /* not in the keys file */ }
  }
  return persona(config.numbersPersonas[0]);
}

/// Two trade pages, picked like the survey's: a keeper-priced coin and an
/// xStock, by symbol order, so the same ones come back run after run.
async function tradeTargets(): Promise<string[]> {
  const list = (await api<Market[]>("/api/markets")) ?? [];
  const live = list.filter((m) => !m.hidden && !m.paused).sort((a, b) => a.symbol.localeCompare(b.symbol));
  const coin = live.find((m) => m.observed && !/x$/.test(m.symbol));
  const stock = live.find((m) => /x$/.test(m.symbol));
  return [coin, stock].filter((m): m is Market => !!m).map((m) => m.symbol);
}

export async function run(browser: Browser): Promise<{ ok: boolean; summary: string }> {
  const p = await pickPersona();
  let checked = 0, filed = 0;
  const r = await asPersona(browser, p, "numbers", config.checkTimeoutMs - 30_000, async (ctx) => {
    const page = ctx.page;
    await ctx.step("open /markets", () => ctx.goto("/markets", (pg) => pg.locator('main a[href^="/trade/"]')));
    await ctx.step("compare /markets", async () => {
      await page.waitForTimeout(2_000);
      const x = await compare(ctx, () => readMarkets(page), "medium");
      checked += x.checked; filed += x.filed;
    });
    for (const sym of await tradeTargets()) {
      await ctx.step(`open /trade/:sym`, () => ctx.goto(`/trade/${encodeURIComponent(sym)}`,
        (pg) => pg.locator("main header").getByText("Open interest", { exact: true })));
      await ctx.step(`compare /trade/${sym}`, async () => {
        // The Liquidity panel and the book fill in from their own polls.
        await page.waitForTimeout(3_000);
        const x = await compare(ctx, () => readTrade(page, sym), "medium");
        checked += x.checked; filed += x.filed;
      });
    }
    await ctx.connect();
    await ctx.step("open /portfolio", () => ctx.goto("/portfolio", (pg) => pg.getByText("Available USDC", { exact: true })));
    await ctx.step("compare /portfolio", async () => {
      // A dash until the account answers.
      const t0 = Date.now();
      while (Date.now() - t0 < 15_000) {
        const v = (await page.evaluate(READ_LABELS, { scope: "main aside", labels: ["Available USDC"] }).catch(() => ({} as Record<string, string[]>)))["Available USDC"]?.[0];
        if (v && /\d/.test(v)) break;
        await page.waitForTimeout(500);
      }
      await page.waitForTimeout(1_500);
      const x = await compare(ctx, () => readPortfolio(page, ctx.owner, "/portfolio"), "high");
      checked += x.checked; filed += x.filed;
    });
    if (config.numbersViewWallet) {
      const v = config.numbersViewWallet;
      await ctx.step("open /portfolio?wallet=", () => ctx.goto(`/portfolio?wallet=${v}`, (pg) => pg.getByText("Available USDC", { exact: true })));
      await ctx.step("compare a viewed wallet", async () => {
        await page.waitForTimeout(4_000);
        const x = await compare(ctx, () => readPortfolio(page, v, "/portfolio?wallet"), "high");
        checked += x.checked; filed += x.filed;
      });
    }
    return `${checked} figures compared, ${filed} mismatches filed`;
  });
  return { ok: r.ok && filed === 0, summary: `numbers as ${p.id}: ${r.note}` };
}
