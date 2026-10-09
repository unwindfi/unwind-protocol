/*
 * The wallet's awkward moments, every WALLET_EDGES_EVERY_MIN minutes, on one
 * market's terminal at desktop size.
 *
 *   reject        an order, signed for and then rejected in the wallet: the
 *                 page should say so, leave no "Confirming…" behind, and take
 *                 the next order. Nothing is signed or sent.
 *   disconnect    with an order typed, disconnect from the site's menu, and
 *                 again from the wallet's side (the extension dropping the
 *                 site): the ticket should ask to connect, with no error, and
 *                 connecting again should bring the account back.
 *   switch        switch the wallet to another persona's account in the same
 *                 context, as the extension's account picker does: the header
 *                 and the ticket's balance should follow it.
 *   zero SOL      a dedicated wallet with no SOL (UNFUNDED_KEY, which holds
 *                 test USDC only; a fresh key each run otherwise, which holds
 *                 nothing): the ticket should refuse with a reason, or the
 *                 order should fail with a message about SOL, and the page
 *                 should come back to a usable ticket either way.
 *
 * Every expectation that fails is its own issue, in words that say which.
 */
import fs from "fs";
import type { Browser, Locator } from "playwright-core";
import { Keypair } from "@solana/web3.js";
import { config } from "../config";
import { parseMoney, readFigure, submitButton, ticket, ticketNote } from "../journeys/common";
import { keyOf } from "../personas";
import type { Ctx, Market } from "../session";
import { StepError } from "../session";
import { REJECT } from "../wallet";
import { api, asPersona, persona } from "./common";

const MIN_ORDER = 10;
const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;

/// A market the ticket would take an order on now.
export async function market(): Promise<Market | null> {
  const list = (await api<Market[]>("/api/markets")) ?? [];
  const ok = list.filter((m) => !m.hidden && !m.paused && (m.priceAgeMs == null || m.priceAgeMs / 1000 < m.maxPriceAgeSec * 0.7)
    && (!m.observed || m.observed.tradeable));
  return ok.find((m) => m.symbol === "SOL") ?? ok[0] ?? null;
}

export async function openTerminal(ctx: Ctx, m: Market) {
  await ctx.step("open /trade/:sym", () => ctx.goto(`/trade/${encodeURIComponent(m.symbol)}`,
    (p) => p.getByRole("button", { name: /^(Place (long|short)|Connect wallet)/ })));
}

async function typeAmount(ctx: Ctx, t: Locator, usd: number) {
  const amount = t.getByRole("textbox", { name: "Amount" });
  await ctx.type(amount, String(usd));
}

/// No toast still saying "Confirming", and the submit button not stuck busy.
async function settled(ctx: Ctx, t: Locator, what: string, within = 8_000) {
  const until = Date.now() + within;
  let confirming = true;
  while (Date.now() < until) {
    confirming = await ctx.page.locator("ol[aria-live] > li").filter({ hasText: "Confirming" }).first().isVisible().catch(() => false);
    if (!confirming) break;
    await ctx.page.waitForTimeout(400);
  }
  if (confirming) {
    await ctx.rec.issue("wallet-edge", "high", `After ${what}, a "Confirming…" toast was still up ${within / 1000}s later`, { key: `confirming after ${what}` });
  }
  const submit = submitButton(t).first();
  const label = await submit.innerText().catch(() => "");
  if (/…|\.\.\.|Confirming|Signing/i.test(label)) {
    await ctx.rec.issue("wallet-edge", "high", `After ${what}, the order button still reads "${label}"`, { key: `busy button after ${what}` });
  }
}

export async function reject(ctx: Ctx, m: Market) {
  // The wallet's account now, which a switch may have moved off the persona's.
  const acct = await api<{ usdc: number; positions: Record<string, { isLong: boolean }> }>(`/api/account?owner=${ctx.wallet.address()}`);
  if (!acct || acct.usdc < MIN_ORDER * 1.2) return `reject skipped: ${short(ctx.wallet.address())} holds ${acct?.usdc ?? "?"} USDC`;
  // The side already held, if any: the ticket refuses to flip a position.
  const held = acct.positions?.[m.symbol];
  const side = held ? (held.isLong ? "long" : "short") : "long";
  const t = await ticket(ctx, side);
  await ctx.step("reject a signature", async () => {
    const tab = t.getByRole("tab", { name: side === "long" ? "Long" : "Short", exact: true });
    if (await tab.first().isVisible().catch(() => false)) await ctx.click(tab, `the ${side} tab`, { expectChange: false });
    const market = t.getByRole("tab", { name: "Market", exact: true });
    if (await market.first().isVisible().catch(() => false)) await ctx.click(market, "the Market tab", { expectChange: false });
    await typeAmount(ctx, t, MIN_ORDER);
    const submit = submitButton(t).first();
    if (!(await submit.isEnabled().catch(() => false))) {
      return void await ctx.rec.issue("check-skipped", "low", `Wallet edges could not test a rejection: the order button is disabled ("${await ticketNote(t)}")`, { key: "reject precondition" });
    }
    const before = ctx.wallet.rejected();
    const toasts = ctx.rec.toasts.length;
    ctx.wallet.rejectNext();
    await ctx.click(submit, `Place ${side} (to reject)`);
    const until = Date.now() + 20_000;
    while (Date.now() < until && ctx.wallet.rejected() === before) await ctx.page.waitForTimeout(250);
    if (ctx.wallet.rejected() === before) {
      ctx.wallet.revoke();
      throw new StepError("the wallet was never asked to sign the order");
    }
    // The page's word for it ("Rejected in wallet"), in a toast or the ticket.
    const said = async () => ctx.rec.toasts.slice(toasts).some((x) => /reject|cancel|denied/i.test(x.text))
      || await ctx.page.getByText(/rejected|cancell?ed in (the )?wallet/i).first().isVisible().catch(() => false);
    const t0 = Date.now();
    let ok = await said();
    while (!ok && Date.now() - t0 < 6_000) { await ctx.page.waitForTimeout(300); ok = await said(); }
    if (!ok) {
      await ctx.rec.issue("wallet-edge", "medium", `Rejecting the signature in the wallet showed no message (the wallet answered "${REJECT}")`, { key: "reject no message" });
    }
    const failed = ctx.rec.toasts.slice(toasts).find((x) => x.status === "error");
    if (failed) {
      await ctx.rec.issue("wallet-edge", "medium", `A rejected signature is reported as a failure: "${failed.text.replace(/\n+/g, " / ")}"`, { key: "reject as failure" });
    }
    await settled(ctx, t, "rejecting a signature");
    if (!(await submit.isEnabled().catch(() => false))) {
      await ctx.rec.issue("wallet-edge", "high", `After a rejected signature the order button stays disabled ("${await ticketNote(t)}")`, { key: "reject disabled after" });
    }
  });
  return "reject ok";
}

async function disconnect(ctx: Ctx, m: Market, how: "menu" | "wallet") {
  await ctx.connect();
  const t = await ticket(ctx, "short");
  await ctx.step(`disconnect from the ${how}`, async () => {
    await typeAmount(ctx, t, MIN_ORDER);
    if (how === "menu") {
      await ctx.click(ctx.addressTile(), "the address tile");
      await ctx.click(ctx.page.getByRole("menuitem", { name: "Disconnect" }), "Disconnect");
    } else {
      await ctx.wallet.drop(ctx.page);
    }
    const back = ctx.page.getByRole("button", { name: /^(Wallet|Connect wallet)$/ }).first();
    if (!(await back.waitFor({ state: "visible", timeout: 8_000 }).then(() => true, () => false))) {
      await ctx.rec.issue("wallet-edge", "high", `Disconnected from the ${how}, the header still shows the wallet ${ctx.short}`, { key: `disconnect ${how} header` });
    }
    const label = await submitButton(t).first().innerText().catch(() => "");
    if (label !== "Connect wallet") {
      await ctx.rec.issue("wallet-edge", "high", `Disconnected from the ${how}, the order button reads "${label}" instead of "Connect wallet"`, { key: `disconnect ${how} ticket` });
    }
    // Errors it logs or throws are filed by the session's own listeners.
    await settled(ctx, t, `a disconnect from the ${how}`, 3_000);
  });
  ctx.connected = false;
  // And back: the account and the ticket's balance return.
  await ctx.connect();
  await ctx.step("reconnect", async () => {
    const acct = await ctx.account();
    await ctx.page.waitForTimeout(2_000);
    const shown = parseMoney(await readFigure(t, "Available to trade"));
    if (acct && shown != null && Math.abs(shown - acct.usdc) > Math.max(0.011, acct.usdc * 0.005)) {
      await ctx.rec.issue("wallet-edge", "high", `Reconnected after a disconnect from the ${how}, the ticket shows $${shown} available; the API says ${acct.usdc}`, { key: `reconnect ${how} balance` });
    }
  });
}

async function switchWallet(ctx: Ctx, otherId: string) {
  const other = keyOf(persona(otherId));
  const b = other.publicKey.toBase58();
  await ctx.connect();
  const t = await ticket(ctx, "long");
  await ctx.step(`switch the wallet to ${otherId}`, async () => {
    // B has read the welcome, as a returning user would have.
    await ctx.page.evaluate((k) => { try { localStorage.setItem(k, JSON.stringify({ v: 1, at: Date.now(), skipped: true })); } catch { /* blocked */ } }, `unwind.welcome:${b}`);
    const [mine, theirs] = await Promise.all([ctx.account(), api<{ usdc: number }>(`/api/account?owner=${b}`)]);
    await ctx.wallet.switchTo(ctx.page, other);
    const tile = ctx.page.getByRole("button", { name: short(b) }).first();
    if (!(await tile.waitFor({ state: "visible", timeout: 10_000 }).then(() => true, () => false))) {
      const stale = await ctx.addressTile().first().isVisible().catch(() => false);
      await ctx.rec.issue("wallet-edge", "high",
        `Switched the wallet's account to ${short(b)}; the header ${stale ? `still shows ${ctx.short}` : "shows neither address"}`, { key: "switch header" });
      return;
    }
    await ctx.page.waitForTimeout(3_000);
    const shown = parseMoney(await readFigure(t, "Available to trade"));
    if (theirs && shown != null && Math.abs(shown - theirs.usdc) > Math.max(0.011, theirs.usdc * 0.005)) {
      const old = mine && Math.abs(shown - mine.usdc) <= 0.011;
      await ctx.rec.issue("wallet-edge", "high",
        `After switching to ${short(b)} the ticket shows $${shown} available; ${short(b)} holds ${theirs.usdc}${old ? ` (it is the previous account's ${mine!.usdc})` : ""}`,
        { key: "switch balance" });
    }
  });
}

async function zeroSol(browser: Browser): Promise<string> {
  let key: Keypair;
  let dedicated = false;
  try {
    key = config.unfundedKey ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(config.unfundedKey, "utf8")))) : Keypair.generate();
    dedicated = !!config.unfundedKey;
  } catch { key = Keypair.generate(); }
  const m = await market();
  if (!m) return "zero SOL skipped: no tradeable market";
  // A returning trader's habits on a wallet nobody funded.
  const p = { ...persona(config.walletEdgePersonas[0]), id: "t00", name: "Unfunded" };
  const r = await asPersona(browser, p, "zero-sol", 150_000, async (ctx) => {
    await openTerminal(ctx, m);
    await ctx.connect();
    const acct = await ctx.account();
    if (acct?.sol && acct.sol > 0) return `zero SOL skipped: the unfunded wallet holds ${acct.sol} SOL`;
    const t = await ticket(ctx, "long");
    await ctx.step("order with no SOL", async () => {
      await typeAmount(ctx, t, MIN_ORDER);
      await ctx.page.waitForTimeout(1_500);
      const submit = submitButton(t).first();
      const enabled = await submit.isEnabled().catch(() => false);
      const note = await ticketNote(t);
      const fund = await ctx.page.getByText(/Get test funds|No test funds|No test USDC|No USDC|Low SOL|Not enough SOL/).first().isVisible().catch(() => false);
      if (!enabled) {
        if (!note && !fund) await ctx.rec.issue("wallet-edge", "medium", "With no SOL and no USDC the order button is disabled and nothing says why", { key: "zero sol no reason" });
        return;
      }
      if ((acct?.usdc ?? 0) < MIN_ORDER) {
        await ctx.rec.issue("wallet-edge", "medium", `The ticket takes a $${MIN_ORDER} order from a wallet with ${acct?.usdc ?? 0} USDC`, { key: "zero funds enabled" });
        return;
      }
      if (config.dryTx) return;
      // A real attempt: it cannot land without SOL for the fee, so the only
      // question is what the page says.
      ctx.rec.expectToast = /SOL|fee|funds/i;
      const toasts = ctx.rec.toasts.length;
      const out = await ctx.tx("order-no-sol", () => ctx.click(submit, "Place long (no SOL)"));
      const said = ctx.rec.toasts.slice(toasts).filter((x) => x.status === "error").map((x) => x.text);
      if (out === "confirmed") {
        await ctx.rec.issue("wallet-edge", "high", "An order from a wallet with 0 SOL confirmed; the fee came from somewhere", { key: "zero sol confirmed" });
      } else if (out !== "skipped" && !said.some((s) => /SOL/i.test(s))) {
        await ctx.rec.issue("wallet-edge", "medium",
          `An order from a wallet with 0 SOL failed without saying SOL is short (${said.length ? `"${said[0].replace(/\n+/g, " / ")}"` : "no message"})`, { key: "zero sol message" });
      }
      await settled(ctx, t, "an order with no SOL");
      ctx.rec.expectToast = null;
    });
    return `zero SOL ok (${dedicated ? "dedicated" : "fresh"} wallet, ${acct?.usdc ?? 0} USDC)`;
  }, { key });
  return r.note;
}

export async function run(browser: Browser): Promise<{ ok: boolean; summary: string }> {
  const [a, b] = config.walletEdgePersonas;
  const m = await market();
  if (!m) return { ok: true, summary: "wallet edges skipped: no tradeable market" };
  const notes: string[] = [];
  const main = await asPersona(browser, persona(a), "wallet-edges", config.checkTimeoutMs - 180_000, async (ctx) => {
    await openTerminal(ctx, m);
    await ctx.connect();
    notes.push(await reject(ctx, m));
    await disconnect(ctx, m, "menu");
    await disconnect(ctx, m, "wallet");
    if (b) await switchWallet(ctx, b);
    return `${m.symbol}: ${notes.join("; ")}`;
  });
  const zero = await zeroSol(browser);
  return { ok: main.ok, summary: `wallet edges as ${a}: ${main.note}; ${zero}` };
}
