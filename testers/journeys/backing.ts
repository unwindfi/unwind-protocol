/*
 * The pool and backing, step by step against the API: deposit into the
 * pool, back a market, request a withdrawal of part of the deposit, and
 * claim it once its 150 slots have passed. At each step the wallet's USDC,
 * the xLP held or escrowed, the backing and the wait the page states are
 * read against /api/account and /api/backings.
 */
import type { Locator } from "playwright-core";
import { agrees, live, parseMoney, readFigure, type Journey } from "./common";
import * as fu from "./followup";
import { acct, settled, until, connected } from "./venue";
import type { Ctx } from "../session";

const NAME = "backing";
interface Backing { symbol: string; shares: number; value: number; deposited: number }
interface State { deposit?: number; back?: number; request?: number; misses?: number }

const backings = async (ctx: Ctx) => (await ctx.api<Backing[]>(`/api/backings?owner=${ctx.owner}`)) ?? [];
const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol + 1e-9;

export const backing: Journey = {
  name: NAME,
  budgetMs: 180_000,
  wallet: true,
  async run(ctx) {
    const id = ctx.persona.id;
    const plan = fu.get<State>(id, NAME);
    const a0 = await acct(ctx);
    // A withdrawal already waiting from an earlier visit goes first.
    const stage = plan?.stage ?? (a0?.lp.pending ? "claim" : "deposit");
    const s: State = plan?.data ?? {};
    const page = ctx.page;
    await ctx.step("open /earn", () => ctx.goto("/earn", (p) => p.getByRole("heading", { name: "Earn", level: 1 })));
    await connected(ctx);
    if (!a0) return;

    if (stage === "deposit") {
      const usd = Math.min(ctx.rng.pick([20, 30, 50]), Math.floor(a0.usdc / 2));
      if (usd < 10) return;
      const r = await ctx.step("deposit", async () => {
        const d = await poolDialog(ctx, "Deposit");
        await ctx.type(d.getByRole("textbox", { name: "Amount to deposit" }), String(usd));
        const stat = parseMoney(await readFigure(d, "Your deposit now"));
        if (stat != null && !near(stat, a0.lp.value, 0.02)) {
          await ctx.rec.issue("number-mismatch", "high", `${NAME}: pool dialog says $${stat} deposited; the API $${a0.lp.value.toFixed(2)}`, { key: `${NAME} deposit now` });
        }
        return press(ctx, d, "Deposit", "deposit");
      });
      if (!(await carryOn(ctx, r, stage, s))) return;
      const a = await ctx.step("watch it land", () => settled(ctx, (x) => x.lp.held > a0.lp.held + 1e-6));
      if (!a) return stuck(ctx, `deposit of $${usd}`);
      const paid = a0.usdc - a.usdc;
      const minted = a.lp.held - a0.lp.held;
      const fee = a.pool?.addFeePct ?? 0;
      if (!near(paid, usd, 0.011)) await ctx.rec.issue("number-mismatch", "high", `${NAME}: depositing $${usd} took $${paid.toFixed(4)} of USDC`, { key: `${NAME} deposit paid` });
      if (!near(minted * a0.lp.price, usd * (1 - fee / 100), usd * 0.005 + 0.02)) {
        await ctx.rec.issue("number-mismatch", "high", `${NAME}: $${usd} minted ${minted.toFixed(6)} xLP at ${a0.lp.price.toFixed(6)} ($${(minted * a0.lp.price).toFixed(2)})`, { key: `${NAME} deposit minted` });
      }
      await ctx.step("watch the Deposited figure", () => agrees(ctx, `${NAME}: Earn's Deposited`,
        async () => parseMoney(await readFigure(page, "Deposited")), async () => (await acct(ctx))?.lp.value ?? null, 0.02));
      fu.next<State>(id, NAME, "back", fu.txReadyAt(id), { deposit: usd }, Date.now());
      return;
    }

    if (stage === "back") {
      const usd = ctx.rng.pick([10, 15, 20]);
      const b0 = await backings(ctx);
      const r = await ctx.step("back a market", async () => {
        const backs = page.getByRole("button", { name: "Back", exact: true });
        const n = await backs.count();
        if (!n) return "blocked" as const;
        await ctx.click(backs.nth(ctx.rng.int(0, Math.min(n, 6) - 1)), "a market's Back");
        const d = page.getByRole("dialog");
        await ctx.ready(d, "the backing dialog");
        const usdc = d.getByRole("radiogroup", { name: "Pay with" }).getByRole("radio", { name: /^USDC/ });
        if (await usdc.first().isVisible().catch(() => false)) await ctx.click(usdc, "Pay with USDC", { expectChange: false });
        await ctx.type(d.getByRole("textbox", { name: "Amount to back" }), String(usd));
        return press(ctx, d.first(), "Back", "back-market");
      });
      if (!(await carryOn(ctx, r, stage, s))) return;
      const after = await ctx.step("watch it land", () => until(ctx, async () => {
        const b1 = await backings(ctx);
        return b1.find((b) => b.deposited > (b0.find((x) => x.symbol === b.symbol)?.deposited ?? 0) + 1e-6) ?? null;
      }, 30_000, 2_000));
      if (!after) return stuck(ctx, `backing of $${usd}`);
      const was = b0.find((x) => x.symbol === after.symbol)?.deposited ?? 0;
      if (!near(after.deposited - was, usd, 0.02)) {
        await ctx.rec.issue("number-mismatch", "high", `${NAME}: backing ${after.symbol} with $${usd} added $${(after.deposited - was).toFixed(4)} to /api/backings`, { key: `${NAME} back amount` });
      }
      await ctx.step("watch the market's backing figure", async () => {
        await ctx.goto("/earn", (p) => p.getByRole("heading", { name: "Earn", level: 1 }));
        const d = await openBacking(ctx, after.symbol);
        if (!d) return;
        await agrees(ctx, `${NAME}: ${after.symbol} Your backing now`,
          async () => parseMoney(await readFigure(d, "Your backing now")),
          async () => (await backings(ctx)).find((b) => b.symbol === after.symbol)?.value ?? null, 0.02);
        await ctx.page.keyboard.press("Escape");
      });
      fu.next<State>(id, NAME, "request", fu.txReadyAt(id), { ...s, back: usd, misses: 0 });
      return;
    }

    if (stage === "request") {
      if (a0.lp.pending) { fu.next<State>(id, NAME, "claim", Date.now(), s); return; }
      const usd = Math.max(10, Math.floor((s.deposit ?? 20) / 2));
      if (a0.lp.value < usd) return fu.clear(id, NAME);
      const r = await ctx.step("request a withdrawal", async () => {
        const d = await poolDialog(ctx, "Withdraw");
        await ctx.type(d.getByRole("textbox", { name: "Amount to request withdrawal" }), String(usd));
        return press(ctx, d, "Request withdrawal", "withdraw");
      });
      if (!(await carryOn(ctx, r, stage, s))) return;
      const a = await ctx.step("watch it land", () => settled(ctx, (x) => !!x.lp.pending));
      if (!a) return stuck(ctx, `withdrawal request of $${usd}`);
      const p = a.lp.pending!;
      if (!near(p.shares * a0.lp.price, usd, usd * 0.005 + 0.02)) {
        await ctx.rec.issue("number-mismatch", "high", `${NAME}: requested $${usd}; ${p.shares} xLP escrowed ($${(p.shares * a0.lp.price).toFixed(2)})`, { key: `${NAME} request shares` });
      }
      await ctx.step("watch the stated wait", () => checkWait(ctx));
      fu.next<State>(id, NAME, "claim", Math.max(fu.txReadyAt(id), Date.now() + p.secondsLeft * 1_000 + 10_000), { ...s, request: usd, misses: 0 });
      return;
    }

    if (stage === "claim") {
      const p = a0.lp.pending;
      if (!p) return fu.clear(id, NAME);
      if (p.slotsLeft > 0) {
        // Not yet: the page must say so and keep Claim off.
        await ctx.step("claim not ready", async () => {
          const d = await poolDialog(ctx, "Withdraw");
          if (await d.getByRole("button", { name: "Claim", exact: true }).first().isEnabled().catch(() => false)) {
            await ctx.rec.issue("control-mismatch", "high", `${NAME}: Claim is enabled with ${p.slotsLeft} slots still to wait`, { key: `${NAME} claim early` });
          }
          await ctx.page.keyboard.press("Escape");
        });
        fu.next<State>(id, NAME, "claim", Date.now() + p.secondsLeft * 1_000 + 10_000, s);
        return;
      }
      const shown = await readFigure(page, "Withdrawing");
      if (shown && !/ready to claim/.test(shown)) {
        await ctx.rec.issue("number-mismatch", "medium", `${NAME}: Earn says "${shown}" for a withdrawal the API calls ready`, { key: `${NAME} ready text` });
      }
      const fee = (a0.pool?.removeFeePct ?? 0) / 100;
      const r = await ctx.step("claim", async () => {
        const d = await poolDialog(ctx, "Withdraw");
        const claim = d.getByRole("button", { name: "Claim", exact: true });
        if (!(await claim.first().isEnabled().catch(() => false))) {
          await ctx.rec.issue("control-mismatch", "high", `${NAME}: the API says the withdrawal is ready; Claim is disabled`, { key: `${NAME} claim disabled` });
          return "blocked" as const;
        }
        return ctx.tx("withdraw-claim", () => ctx.click(claim, "Claim"));
      });
      if (!(await carryOn(ctx, r, stage, s))) return;
      const a = await ctx.step("watch it land", () => settled(ctx, (x) => !x.lp.pending));
      if (!a) return stuck(ctx, "claim");
      const got = a.usdc - a0.usdc;
      const want = p.value * (1 - fee);
      if (!near(got, want, want * 0.005 + 0.02)) {
        await ctx.rec.issue("number-mismatch", "high", `${NAME}: claim paid $${got.toFixed(4)} for $${p.value.toFixed(4)} pending (fee ${(fee * 100).toFixed(2)}%)`, { key: `${NAME} claim paid` });
      }
      fu.note(NAME, id, `deposited $${s.deposit ?? "?"}, backed $${s.back ?? "?"}, withdrew $${got.toFixed(2)}`);
      fu.clear(id, NAME);
    }
  },
};

/// The pool's dialog, opened from its Deposit or Withdraw button.
async function poolDialog(ctx: Ctx, which: "Deposit" | "Withdraw"): Promise<Locator> {
  const d = ctx.page.getByRole("dialog", { name: "The pool" });
  if (!(await d.first().isVisible().catch(() => false))) {
    await ctx.click(ctx.page.getByRole("button", { name: which, exact: true }), `the pool's ${which}`);
    await ctx.ready(d, "the pool dialog");
  }
  if (which === "Withdraw") {
    const tab = d.getByRole("tab", { name: "Withdraw" });
    if (await tab.first().isVisible().catch(() => false)) await ctx.click(tab, "the Withdraw tab", { expectChange: false });
  }
  return d.first();
}

/// A market's backing dialog, by the symbol in its title.
async function openBacking(ctx: Ctx, sym: string): Promise<Locator | null> {
  const backs = ctx.page.getByRole("button", { name: "Back", exact: true });
  const n = await backs.count();
  for (let i = 0; i < n; i++) {
    await ctx.click(backs.nth(i), "a market's Back", { expectChange: false });
    const d = ctx.page.getByRole("dialog").first();
    await ctx.ready(d, "the backing dialog");
    const title = (await d.getAttribute("aria-label").catch(() => "")) ?? "";
    if (title.includes(sym)) return d;
    await ctx.page.keyboard.press("Escape");
    await d.waitFor({ state: "hidden", timeout: 3_000 }).catch(() => undefined);
  }
  return null;
}

async function press(ctx: Ctx, d: Locator, verb: string, kind: string) {
  const submit = d.getByRole("button", { name: verb, exact: true });
  if (!(await submit.first().isEnabled({ timeout: 2_000 }).catch(() => false))) {
    const label = await d.getByRole("button", { name: /^(Over your (balance|deposit)|Confirm in wallet)$/ }).first().innerText({ timeout: 500 }).catch(() => "");
    await ctx.rec.issue("control-mismatch", "medium", `${NAME}: ${verb} not pressable${label ? ` ("${label}")` : ""}`, { key: `${NAME} ${kind} disabled` });
    return "blocked" as const;
  }
  return ctx.tx(kind, () => ctx.click(submit, verb));
}

/// "Claimable in about 52s (130 slots)." in the dialog and "52s left" beside
/// Withdrawing, against the API's countdown.
async function checkWait(ctx: Ctx) {
  const api = (await acct(ctx))?.lp.pending;
  if (!api) return;
  const d = await poolDialog(ctx, "Withdraw");
  const line = await d.getByText(/^[\d,.]+ xLP\./).first().innerText({ timeout: 8_000 }).catch(() => "");
  const sec = /about (\d+)s/.exec(line)?.[1];
  const min = /about (\d+) min/.exec(line)?.[1];
  const slots = Number(/\((\d+) slots\)/.exec(line)?.[1] ?? NaN);
  const said = sec ? Number(sec) : min ? Number(min) * 60 : null;
  if (!line) {
    await ctx.rec.issue("cooldown-text", "medium", `${NAME}: a pending withdrawal and no "Withdrawal pending" line in the dialog`, { key: `${NAME} pending line` });
  } else if (api.slotsLeft > 0 && (said == null || Math.abs(said - api.secondsLeft) > (min ? 60 : 20) || Number.isFinite(slots) && Math.abs(slots - api.slotsLeft) > 40)) {
    await ctx.rec.issue("cooldown-text", "medium", `${NAME}: dialog says "${line}"; the API ${api.secondsLeft}s, ${api.slotsLeft} slots`, { key: `${NAME} wait text` });
  }
  await ctx.page.keyboard.press("Escape");
  const aside = await readFigure(ctx.page, "Withdrawing");
  const v = parseMoney(aside);
  if (aside && v != null && !near(v, api.value, 0.02)) {
    await ctx.rec.issue("number-mismatch", "medium", `${NAME}: Withdrawing shows ${aside}; the API $${api.value.toFixed(2)}`, { key: `${NAME} withdrawing figure` });
  }
}

async function stuck(ctx: Ctx, what: string) {
  await ctx.rec.issue("not-settled", "high", `${NAME}: ${what} confirmed but the API did not show it within 30s`, { key: `${NAME} ${what.split(" ")[0]} not settled` });
  fu.clear(ctx.persona.id, NAME);
}

async function carryOn(ctx: Ctx, r: string, stage: string, s: State) {
  const id = ctx.persona.id;
  if (r === "confirmed") return true;
  if (r === "skipped") { fu.next<State>(id, NAME, stage, fu.txReadyAt(id), s); return false; }
  if (r === "dry" || !live()) return false;
  const misses = (s.misses ?? 0) + 1;
  if (misses >= 2 || stage === "deposit") { fu.note(NAME, id, `${stage} gave ${r}; stopped`); fu.clear(id, NAME); return false; }
  fu.next<State>(id, NAME, stage, fu.txReadyAt(id), { ...s, misses });
  return false;
}
