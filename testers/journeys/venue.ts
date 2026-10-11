/*
 * What the multi-stage trading journeys share: the API's fuller shapes, a
 * market order and a close with exact sizes (trade.ts picks them at random),
 * reading a position, an order or a fill off the account panel, and
 * comparing each with the API.
 */
import type { Locator } from "playwright-core";
import type { AccountView, Ctx, Market } from "../session";
import { StepError } from "../session";
import { parseMoney, setLeverage, submitButton, ticket, ticketNote } from "./common";

export interface Position {
  isLong: boolean; size: number; collateral: number; entry: number; mark: number;
  exit?: number; leverage?: number; pnl?: number; funding?: number; liqPrice?: number; liquidatable?: boolean;
}
export interface Order {
  address: string; symbol: string; slot: number; kind: number; sizeUsd: number; collateralUsd: number;
  isLong: boolean; triggerPrice: number; triggerAbove: boolean; expiryTs: number;
}
export interface Liquidation { t: number; symbol: string; isLong: boolean; size: number; price: number; returned: number; pnl?: number; fee?: number }
export interface OrderFill { t: number; symbol: string; trigger: number; price: number; above: boolean; expired?: boolean }
export interface Account extends Omit<AccountView, "positions" | "orders" | "lp"> {
  margin: number; unrealized: number;
  positions: Record<string, Position>;
  orders: Order[];
  liquidations: Liquidation[];
  deleverages: { t: number; symbol: string }[];
  orderFills: OrderFill[];
  pool?: { addFeePct: number; removeFeePct: number; lpPrice: number };
  lp: { held: number; price: number; value: number; owed?: unknown[];
    pending: { shares: number; value: number; readySlot: number; slotsLeft: number; secondsLeft: number } | null };
}
export interface Fill {
  t: number; symbol: string; side: "buy" | "sell"; size: number; price: number; kind: string;
  fee?: number; pnl?: number; sig?: string; feeExact?: boolean; house?: boolean;
}
export interface MarketFull extends Market { openFeeBps?: number; closeFeeBps?: number; maintenanceMarginBps?: number; high?: number; low?: number; mint?: string }
export interface Batch {
  exists: boolean; seq?: number; sealed?: boolean;
  resting?: { price: number; size: number; isBid: boolean; isMaker: boolean; reduceOnly: boolean; house: boolean; mine?: boolean }[];
  last?: { buyPrice: number | null; sellPrice: number | null; matched: number; t: number } | null;
}

export const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export const acct = (ctx: Ctx) => ctx.api<Account>(`/api/account?owner=${ctx.owner}`);
export const fillsOf = async (ctx: Ctx) => (await ctx.api<Fill[]>(`/api/fills?owner=${ctx.owner}`)) ?? [];
/// The market list as it is now: `ctx.markets()` keeps the session's first read.
export const freshMarkets = async (ctx: Ctx) => (await ctx.api<MarketFull[]>("/api/markets")) ?? [];
export const batchOf = (ctx: Ctx, sym: string) => ctx.api<Batch>(`/api/batch/${encodeURIComponent(sym)}?owner=${ctx.owner}`);

/// Polls `fn` until it gives something, or `ms` runs out (then null).
export async function until<T>(ctx: Ctx, fn: () => Promise<T | null | undefined | false>, ms: number, every = 1_000): Promise<T | null> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() + every > end) return null;
    if (ctx.page && !ctx.page.isClosed()) await ctx.page.waitForTimeout(every);
    else await new Promise((r) => setTimeout(r, every));
  }
}

/// Decimals the site prints a price at (format.ts's priceDecimals).
export const priceDecimals = (n: number) =>
  !Number.isFinite(n) || n <= 0 || n >= 10 ? 2 : Math.min(12, 3 - Math.floor(Math.log10(n)));
/// One unit in the last place the site shows for a price.
export const priceTick = (n: number) => 10 ** -priceDecimals(Math.abs(n));
const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol + 1e-9;
export const fmtPrice = (n: number) => n.toFixed(priceDecimals(n));

// ------------------------------------------------------------ the ticket

/// "unfunded": the ticket refused because the wallet cannot pay for it,
/// which is the fleet's funding, not the site.
export type TxResult = Awaited<ReturnType<Ctx["tx"]>> | "blocked" | "unfunded";

/*
 * A market order of exactly `usd` notional at `lev`. "blocked" when the
 * ticket would not take it (the reason is in the note, and in the result's
 * second field).
 */
export async function marketOrder(ctx: Ctx, m: Market, side: "long" | "short", usd: number, lev: number, kind = "order"): Promise<[TxResult, string]> {
  const t = await ctx.step("open the ticket", () => ticket(ctx, side));
  await ctx.step(`choose ${side}, Market`, async () => {
    await ctx.click(t.getByRole("tab", { name: side === "long" ? "Long" : "Short", exact: true }), `the ${side} tab`, { expectChange: false });
    const market = t.getByRole("tab", { name: "Market", exact: true });
    if (await market.first().isVisible().catch(() => false)) await ctx.click(market, "the Market tab", { expectChange: false });
  });
  await ctx.step("set leverage", () => setLeverage(ctx, t, lev, m.maxLeverage));
  await ctx.step("type a size", () => ctx.type(t.getByRole("textbox", { name: "Amount" }), String(usd)));
  return ctx.step("place the order", async (): Promise<[TxResult, string]> => {
    const submit = submitButton(t).first();
    const label = await submit.innerText().catch(() => "");
    if (!/^Place (long|short)$/.test(label) || !(await submit.isEnabled().catch(() => false))) {
      const note = `"${label}": ${await ticketNote(t)}`;
      const free = (await acct(ctx))?.usdc ?? 0;
      return [free < usd / lev + 0.5 ? "unfunded" : "blocked", note];
    }
    return [await ctx.tx(kind, () => ctx.click(submit, `"${label}"`)), label];
  });
}

/// The account panel's tab, on a phone after raising the Positions view.
export async function accountTab(ctx: Ctx, name: "Positions" | "Open orders" | "Funding" | "Trade history" | "Liquidations") {
  const page = ctx.page;
  if (ctx.phone) {
    const close = page.getByRole("dialog").getByRole("button", { name: "Close" });
    if (await close.first().isVisible().catch(() => false)) await ctx.click(close, "the sheet's Close");
    const view = page.getByRole("button", { name: /^Positions( \d+)?$/ });
    if (await view.first().isVisible().catch(() => false)) await ctx.click(view, "the Positions view", { expectChange: false });
  }
  const tab = page.getByRole("tablist", { name: "Account" }).getByRole("tab", { name: new RegExp(`^${esc(name)}( \\(\\d+\\))?$`) });
  if (!(await tab.first().waitFor({ state: "visible", timeout: 8_000 }).then(() => true, () => false))) return false;
  await ctx.click(tab, `the ${name} tab`, { expectChange: false });
  await page.waitForTimeout(600);
  return true;
}

/*
 * The row for `sym` in whatever table the account panel shows, as header ->
 * cell text. The first cell is the market ("SOL 4.0x" or "SOL"). On the
 * phone's Positions tab, where each position is a card, the card's figures.
 */
export async function rowFor(ctx: Ctx, sym: string, match?: (cells: Record<string, string>) => boolean): Promise<Record<string, string> | null> {
  const rows = await ctx.page.evaluate((s) => {
    const out: Record<string, string>[] = [];
    const panel = document.querySelector("[role=tablist][aria-label=Account]")?.closest("section") ?? document;
    for (const table of Array.from(panel.querySelectorAll("table"))) {
      const heads = Array.from(table.querySelectorAll("thead th")).map((th) => (th as HTMLElement).innerText.trim());
      for (const tr of Array.from(table.querySelectorAll("tbody tr"))) {
        const cells = Array.from(tr.querySelectorAll("td")).map((td) => (td as HTMLElement).innerText.trim());
        if (!cells.length || !(cells[0] === s || cells[0].startsWith(`${s} `) || cells[0].startsWith(`${s}\n`))) continue;
        const row: Record<string, string> = {};
        heads.forEach((h, i) => { row[h || `#${i}`] = cells[i] ?? ""; });
        out.push(row);
      }
    }
    // The phone's position cards.
    if (!out.length) {
      for (const b of Array.from(panel.querySelectorAll("b"))) {
        if (b.textContent?.trim() !== s) continue;
        const card = b.closest(".border-b") as HTMLElement | null;
        if (!card || card.querySelector("table")) continue;
        const lines = card.innerText.split("\n").map((l) => l.trim()).filter(Boolean);
        const row: Record<string, string> = { Market: s };
        for (let i = 0; i < lines.length; i++) {
          if (["Size", "Entry", "Mark", "Liq."].includes(lines[i]) && lines[i + 1]) row[lines[i] === "Size" ? "Value" : lines[i]] = lines[i + 1];
          const mm = /^(Margin|Funding) (.+)$/.exec(lines[i]);
          if (mm) row[mm[1]] = mm[2];
          if (/^-?\$[\d,.]+ \(/.test(lines[i]) && !row["PnL (ROE)"]) row["PnL (ROE)"] = lines[i];
        }
        out.push(row);
      }
    }
    return out;
  }, sym).catch(() => [] as Record<string, string>[]);
  return (match ? rows.find(match) : rows[0]) ?? null;
}

/// A price as the tables print it ("109.69", "0.002134"), unsigned.
export const parsePrice = (s: string | undefined) => {
  const m = /-?[\d,]*\.?\d+/.exec((s ?? "").replace(/−/g, "-"));
  return m ? Number(m[0].replace(/,/g, "")) : null;
};

/*
 * The position row against the API, field by field, read a poll apart up to
 * three times so a figure that moved on chain between the two reads is not a
 * mismatch. Each disagreement is its own issue, keyed by journey and field.
 */
export async function comparePosition(ctx: Ctx, journey: string, sym: string) {
  if (!(await accountTab(ctx, "Positions"))) return;
  let diffs: string[] = [];
  for (let i = 0; i < 3; i++) {
    const [api, ui] = [(await acct(ctx))?.positions[sym], await rowFor(ctx, sym)];
    if (!api) return;
    if (!ui) {
      if (i === 2) await ctx.rec.issue("position-missing", "high", `${journey}: ${sym} position is on chain but not on the panel`, { key: `${journey} row` });
      await ctx.page.waitForTimeout(2_500);
      continue;
    }
    diffs = [];
    const value = parseMoney(ui["Value"]);
    if (value != null && !near(value, api.size, 1.01)) diffs.push(`value ${value} vs size ${api.size}`);
    const entry = parsePrice(ui["Entry"]);
    if (entry != null && !near(entry, api.entry, priceTick(api.entry) * 1.01)) diffs.push(`entry ${entry} vs ${api.entry}`);
    const margin = parseMoney(ui["Margin"]);
    if (margin != null && !near(margin, api.collateral, 0.011)) diffs.push(`margin ${margin} vs ${api.collateral}`);
    const pnl = parseMoney(ui["PnL (ROE)"]);
    if (pnl != null && api.pnl != null && !near(pnl, api.pnl, Math.max(0.02, api.size * 0.0015))) diffs.push(`PnL ${pnl} vs ${api.pnl.toFixed(4)}`);
    // The column shows what was paid, so a cost reads negative.
    const funding = parseMoney(ui["Funding"]);
    if (funding != null && api.funding != null && !near(funding, -api.funding, 0.011)) diffs.push(`funding ${funding} vs ${-api.funding}`);
    if (!diffs.length) break;
    await ctx.page.waitForTimeout(2_500);
  }
  for (const d of diffs) {
    const field = d.split(" ")[0];
    await ctx.rec.issue("number-mismatch", "high", `${journey}: ${sym} position ${d} (UI vs API)`, { key: `${journey} position ${field}` });
  }
  // Funding has its own tab with the same figure; the docked table leaves
  // the column out, so this is where it is read on a laptop.
  // Read together and retried, as the Positions check is: one read of each
  // a few seconds apart caught a new position's funding crossing zero (WIF
  // on October 10, 2026: the page at 0.01, the API at -0.01045) and filed
  // the timing as a sign bug.
  if (!ctx.phone && await accountTab(ctx, "Funding")) {
    let miss: string | null = null;
    for (let i = 0; i < 3; i++) {
      const [api, ui] = [(await acct(ctx))?.positions[sym], await rowFor(ctx, sym)];
      const paid = parseMoney(ui?.["Paid so far"]);
      miss = api?.funding != null && paid != null && !near(paid, -api.funding, 0.011)
        ? `${journey}: ${sym} funding paid shows ${paid}, the API says ${-api.funding}` : null;
      if (!miss) break;
      await ctx.page.waitForTimeout(2_500);
    }
    if (miss) await ctx.rec.issue("number-mismatch", "high", miss, { key: `${journey} funding tab` });
  }
}

/*
 * The newest fill of `kind` on `sym` since `since`, from the API, and its row
 * on the Trade history tab: size, price and fee as printed. Files an issue
 * when the row is missing or its figures disagree.
 */
export async function checkHistory(ctx: Ctx, journey: string, sym: string, kind: "open" | "close" | "liquidation", since: number): Promise<Fill | null> {
  const fill = await until(ctx, async () => (await fillsOf(ctx)).find((f) => f.symbol === sym && f.kind === kind && f.t >= since - 5_000), 20_000);
  if (!fill) {
    // The server keeps fills only since it last started; a restart in between
    // loses them, so this is worth a look but not a red flag.
    await ctx.rec.issue("fill-missing", "medium", `${journey}: no ${kind} fill for ${sym} in /api/fills after it settled`, { key: `${journey} fill ${kind}` });
    return null;
  }
  const action = kind === "open" ? "Open" : kind === "close" ? "Close" : "Liquidated";
  if (!(await accountTab(ctx, "Trade history"))) return fill;
  const row = await until(ctx, () => rowFor(ctx, sym, (c) => c["Action"] === action), 12_000);
  if (!row) {
    await ctx.rec.issue("history-missing", "high", `${journey}: the ${kind} of ${sym} is in /api/fills but not on the Trade history tab`, { key: `${journey} history ${kind}` });
    return fill;
  }
  const diffs: string[] = [];
  const size = parseMoney(row["Size"]);
  if (size != null && !near(size, fill.size, 1.01)) diffs.push(`size ${size} vs ${fill.size}`);
  const price = parsePrice(row["Price"]);
  if (price != null && !near(price, fill.price, priceTick(fill.price) * 1.01)) diffs.push(`price ${price} vs ${fill.price}`);
  const fee = parseMoney(row["Fee"]);
  if (fee != null && fill.fee != null && !near(fee, fill.fee, 0.011)) diffs.push(`fee ${fee} vs ${fill.fee}`);
  for (const d of diffs) {
    await ctx.rec.issue("number-mismatch", "high", `${journey}: Trade history ${sym} ${action} ${d} (UI vs API)`, { key: `${journey} history ${kind} ${d.split(" ")[0]}` });
  }
  return fill;
}

/*
 * A fill's fee against the market's rate. A referred wallet pays 10% less
 * and a market's own lister half, so any of the three is right; anything
 * else is not. Only for fills the server marks exact.
 */
export async function checkFee(ctx: Ctx, journey: string, m: MarketFull, fill: Fill) {
  if (!fill.feeExact || fill.fee == null) return;
  const bps = fill.kind === "close" ? (m.closeFeeBps ?? m.openFeeBps) : m.openFeeBps;
  if (bps == null) return;
  const full = fill.size * bps / 1e4;
  if ([1, 0.9, 0.5].some((k) => near(fill.fee!, full * k, 0.011))) return;
  await ctx.rec.issue("fee-mismatch", "high",
    `${journey}: ${fill.symbol} ${fill.kind} of $${fill.size} charged $${fill.fee}; ${bps} bps is $${full.toFixed(4)}`,
    { key: `${journey} fee ${fill.kind}`, shot: false });
}

/*
 * Every fill of one batch on one flow pays one price: the auction's whole
 * claim. The market's tape (the server's last 40 fills) is grouped by
 * settlement time and side.
 */
export async function checkClearingPrice(ctx: Ctx, journey: string, fill: Fill) {
  const tape = (await ctx.api<Fill[]>(`/api/trades/${encodeURIComponent(fill.symbol)}`)) ?? [];
  const same = tape.filter((t) => Math.abs(t.t - fill.t) < 600 && t.side === fill.side);
  const off = same.filter((t) => !near(t.price, fill.price, fill.price * 1e-9));
  if (off.length) {
    await ctx.rec.issue("clearing-price-split", "high",
      `${journey}: ${fill.symbol} ${fill.side} fills in one batch at ${[fill.price, ...off.map((t) => t.price)].join(", ")}; one flow should clear at one price`,
      { key: `${journey} clearing split`, shot: false });
  }
}

/// Closes `usd` of the position on `sym` (all of it when null) through the
/// panel's close dialog. "blocked" when the dialog would not take it.
export async function closeVia(ctx: Ctx, sym: string, usd: number | null): Promise<TxResult> {
  return ctx.step(usd == null ? "close the position" : "close part of it", async () => {
    await accountTab(ctx, "Positions");
    const open = ctx.page.getByRole("button", { name: `Close ${sym} position` });
    if (!(await open.first().waitFor({ state: "visible", timeout: 8_000 }).then(() => true, () => false))) {
      throw new StepError(`no Close button for ${sym}`);
    }
    await ctx.click(open, `Close ${sym}`);
    const dialog = ctx.page.getByRole("dialog", { name: new RegExp(`^Close ${esc(sym)}$`) });
    await ctx.ready(dialog, "the close dialog");
    if (usd == null) await ctx.click(dialog.getByRole("button", { name: "100%", exact: true }), "100%");
    else await ctx.type(dialog.getByRole("textbox", { name: "Amount" }), usd.toFixed(2));
    const go = dialog.getByRole("button", { name: /^Close (position|\$)/ });
    if (!(await go.first().isEnabled().catch(() => false))) {
      await ctx.click(dialog.getByRole("button", { name: "Cancel" }).last(), "Cancel", { expectChange: false }).catch(() => undefined);
      return "blocked" as const;
    }
    return ctx.tx("close", () => ctx.click(go, "the close button"));
  });
}

/// Waits for the account to show what a settled batch leaves. Null after
/// `ms` (the batch never settled, or settled to something else).
export const settled = (ctx: Ctx, test: (a: Account) => boolean, ms = 30_000) =>
  until(ctx, async () => { const a = await acct(ctx); return a && test(a) ? a : null; }, ms, 750);

/// The figure in the ticket next to "Available to trade", as a number.
export async function shownFree(scope: Locator) {
  const k = scope.getByText("Available to trade", { exact: true }).first();
  if (!(await k.isVisible().catch(() => false))) return null;
  return parseMoney(await k.locator("xpath=following-sibling::*[1]").innerText({ timeout: 3_000 }).catch(() => null));
}

/*
 * Connects, or waits for the wallet the page reconnects by itself. A second
 * journey in one session lands on a page that is already reconnecting, and
 * `ctx.connect` looked for the Wallet button before the address came back.
 */
export async function connected(ctx: Ctx) {
  if (ctx.connected && await ctx.addressTile().first().waitFor({ state: "visible", timeout: 8_000 }).then(() => true, () => false)) return;
  await ctx.connect();
}
