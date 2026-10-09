/*
 * What more than one journey needs: reading a labelled figure off the page,
 * comparing it with the API, and the trade terminal's ticket.
 */
import type { Locator, Page } from "playwright-core";
import { config } from "../config";
import { type Ctx, type Market, StepError } from "../session";

export interface Journey {
  name: string;
  /// The longest this journey may run before it is cut off.
  budgetMs: number;
  /// Whether it needs a connected wallet (all of them can run without funds).
  wallet: boolean;
  run(ctx: Ctx): Promise<void>;
}

/// "$1,234.50" or "-$3.10" or "1,234.5" to a number; null for "N/A", "–".
export function parseMoney(s: string | null | undefined): number | null {
  if (!s) return null;
  const m = /(-)?\$?\s*(-)?([\d,]+(?:\.\d+)?)/.exec(s.replace(/−/g, "-"));
  if (!m) return null;
  const n = Number(m[3].replace(/,/g, ""));
  return m[1] || m[2] ? -n : n;
}

/// The figure beside a label in the site's two-column rows (KV, Stat).
export async function readFigure(page: Page | Locator, label: string): Promise<string | null> {
  const k = page.getByText(label, { exact: true }).first();
  if (!(await k.isVisible().catch(() => false))) return null;
  return k.locator("xpath=following-sibling::*[1]").innerText({ timeout: 3_000 }).catch(() => null);
}

/*
 * A figure on screen that should equal one from the API. Read twice, a poll
 * apart, so a value that just changed on chain is not called a mismatch.
 */
export async function agrees(ctx: Ctx, what: string, shown: () => Promise<number | null>, truth: () => Promise<number | null>, tol = 0.011) {
  for (let i = 0; i < 3; i++) {
    const [a, b] = [await shown(), await truth()];
    if (a == null || b == null) return;
    if (Math.abs(a - b) <= Math.max(tol, Math.abs(b) * 0.005)) return;
    if (i === 2) {
      await ctx.rec.issue("number-mismatch", "high", `${what} shows ${a} but the API says ${b}`, { key: `mismatch ${what}` });
      return;
    }
    await ctx.page.waitForTimeout(2_500);
  }
}

// ------------------------------------------------------------ the terminal

/// The terminal's ticket: on a phone it lives in a sheet that Long/Short in
/// the bottom bar raise; elsewhere it is the right-hand rail.
export async function ticket(ctx: Ctx, side: "long" | "short"): Promise<Locator> {
  const page = ctx.page;
  if (ctx.phone) {
    const sheet = page.getByRole("dialog", { name: new RegExp(`^(Long|Short) `) });
    if (!(await sheet.first().isVisible().catch(() => false))) {
      await ctx.click(page.getByRole("button", { name: new RegExp(`^${side === "long" ? "Long" : "Short"}\\b`) }), `${side} in the bottom bar`);
      await ctx.ready(sheet, "order sheet");
    }
    return sheet.first();
  }
  return page.locator("aside").filter({ has: page.getByRole("tab", { name: "Long" }) }).first();
}

export const submitButton = (scope: Locator) =>
  scope.getByRole("button", { name: /^(Place (long|short)( limit)?|Post (long|short)|Reduce (long|short)|Connect wallet)$/ });

/// Opens /trade/SYM with a document load, ready when the ticket's submit
/// (or, on a phone, the bottom bar) shows.
export async function openTrade(ctx: Ctx, m: Market | null) {
  const path = m ? `/trade/${encodeURIComponent(m.symbol)}` : "/trade";
  await ctx.step(`open ${m ? "/trade/:sym" : "/trade"}`, () => ctx.goto(path, (p) => ctx.phone
    ? p.getByRole("button", { name: /^Long\b/ })
    : p.getByRole("button", { name: /^(Place (long|short)|Connect wallet)/ })));
  if (m) {
    // The address should still name the market it was opened on.
    const shownSym = decodeURIComponent(new URL(ctx.page.url()).pathname.split("/")[2] ?? "");
    if (shownSym.toLowerCase() !== m.symbol.toLowerCase()) {
      await ctx.rec.issue("deep-link", "high", `/trade/${m.symbol} opened ${shownSym || "no market"} instead`, { key: "deep link trade" });
    }
  }
}

/// Moves the leverage slider to `target` with the keyboard (Home, then steps
/// of 0.1), the way a keyboard user would.
export async function setLeverage(ctx: Ctx, scope: Locator, target: number, max: number) {
  const chip = scope.getByRole("button", { name: /^Leverage / });
  if (!(await chip.first().isVisible().catch(() => false))) return;
  await ctx.click(chip, "the leverage chip");
  const slider = scope.getByRole("slider", { name: "Leverage" });
  await slider.first().waitFor({ state: "visible", timeout: 5_000 }).catch(() => { throw new StepError("leverage slider did not open"); });
  const L = Math.min(Math.max(target, 1.1), max);
  await slider.first().focus();
  await slider.first().press("Home");
  const steps = Math.round((L - 1.1) / 0.1);
  for (let i = 0; i < steps; i++) await slider.first().press("ArrowRight");
  const now = Number(await slider.first().getAttribute("aria-valuenow"));
  if (Number.isFinite(now) && Math.abs(now - L) > 0.051) {
    await ctx.rec.issue("control-mismatch", "medium", `Leverage slider at ${now} after keying to ${L.toFixed(1)}`, { key: "leverage keys" });
  }
  // Compared as numbers: the chip writes a whole leverage as "4x", and a
  // target built by float steps can be 3.9999 rather than 4.
  const label = await chip.first().innerText().catch(() => "");
  const shown = Number(/(\d+(?:\.\d+)?)x/.exec(label)?.[1] ?? NaN);
  if (label && !(Math.abs(shown - L) < 0.051)) {
    await ctx.rec.issue("control-mismatch", "medium", `Leverage chip says "${label}" for ${L.toFixed(1)}x`, { key: "leverage chip" });
  }
  await ctx.click(chip, "the leverage chip (close)");
}

/// The ticket's own note under the submit button (a warning or a hint).
export async function ticketNote(scope: Locator) {
  const submit = submitButton(scope).first();
  return submit.locator("xpath=following-sibling::p[1]").innerText({ timeout: 1_500 }).catch(() => "");
}

/// Waits for the batch clock to move to a new batch; a clock that stays on
/// one batch for 25s while the market is open has stalled.
export async function watchBatch(ctx: Ctx) {
  const timer = ctx.page.getByRole("timer").first();
  if (!(await timer.isVisible().catch(() => false))) return;
  const seqOf = async () => Number(/#?(\d+)/.exec((await timer.getAttribute("aria-label").catch(() => "")) ?? "")?.[1] ?? NaN);
  const first = await seqOf();
  if (!Number.isFinite(first)) return;
  const until = Date.now() + 25_000;
  while (Date.now() < until) {
    await ctx.page.waitForTimeout(1_000);
    const s = await seqOf();
    if (Number.isFinite(s) && s !== first) return;
  }
  const label = await timer.getAttribute("aria-label").catch(() => "");
  if (/Waiting for orders|Opening/i.test(label ?? "")) return; // idle by design
  await ctx.rec.issue("batch-stalled", "high", `Batch clock stayed on batch ${first} for 25s ("${label}")`, { key: "batch stalled" });
}

export const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const live = () => !config.dryTx;
