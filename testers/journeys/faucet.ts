/*
 * The faucet through the site, the way a new wallet meets it: the Earn
 * page's "No test funds" prompt and its Get test funds button. The fleet's
 * own wallets are funded by fund.ts and never see the prompt, so this runs
 * as a throwaway wallet made for the visit, in a browser context of its own
 * (the persona's context blocks /api/faucet).
 *
 * The claim sits behind Cloudflare Turnstile. The journey never touches the
 * check: it waits for it to pass by itself, and if it does not, it records
 * "faucet needs human check" once and stays away for FAUCET_HUMAN_BACKOFF_MS.
 * That is the check doing its job, not a site bug.
 *
 * When the check passes: the USDC and SOL the server says it sent must reach
 * the wallet. Then the over-limit path: the whole balance goes into the pool
 * (so the prompt shows again, as "No free USDC"), and a second claim from a
 * fresh browser must be refused in words that say why and when.
 *
 * At most FAUCET_CLAIMS_PER_DAY a day, fleet wide: each claim spends the
 * faucet's daily budget, which real users share. A dry run only checks the
 * prompt renders for an empty wallet.
 */
import { Keypair } from "@solana/web3.js";
import type { Response } from "playwright-core";
import { config } from "../config";
import { PAGE_WATCH, Recorder } from "../detectors";
import { Ctx } from "../session";
import * as store from "../store";
import { installWallet } from "../wallet";
import { live, parseMoney, readFigure, type Journey } from "./common";
import * as fu from "./followup";
import { acct, settled } from "./venue";

const NAME = "faucet";
const HUMAN_KEY = "faucet:human";

export const faucet: Journey = {
  name: NAME,
  budgetMs: 200_000,
  wallet: true,
  async run(ctx) {
    if (live()) {
      if (fu.countToday(NAME) >= config.faucetClaimsPerDay) return;
      const human = Number(store.getMeta(HUMAN_KEY) ?? 0);
      if (Date.now() - human < config.faucetHumanBackoffMs) return;
    }
    const kp = Keypair.generate();
    const c = await openAs(ctx, kp);
    try {
      const prompt = await ctx.step("wait for the empty wallet's prompt", () => fundPrompt(c, /^No test funds\./));
      if (!prompt || !live()) return;
      fu.countOne(NAME);
      const first = await ctx.step("claim and wait for the check", () => claim(c));
      if (first.outcome !== "answered") return;
      if (!first.ok) {
        await c.rec.issue("faucet-refused", "medium", `${NAME}: a new wallet's first claim was refused: ${first.error}`, { key: `${NAME} first refused`, shot: false });
        return;
      }
      await ctx.step("watch the funds arrive", async () => {
        const a = await settled(c, (x) => x.usdc >= (first.usdc ?? 1) - 0.01 && (!first.sol || (x.sol ?? 0) >= first.sol * 0.99), 60_000);
        if (!a) {
          const now = await acct(c);
          await c.rec.issue("faucet-not-arrived", "high", `${NAME}: the faucet answered ${first.usdc} USDC and ${first.sol} SOL; the wallet holds ${now?.usdc} USDC and ${now?.sol} SOL a minute later`, { key: `${NAME} not arrived` });
          return;
        }
        const shown = parseMoney(await readFigure(c.page, "In your wallet"));
        if (shown != null && Math.abs(shown - a.usdc) > 0.011) {
          await c.page.waitForTimeout(3_000);
          const again = parseMoney(await readFigure(c.page, "In your wallet"));
          if (again != null && Math.abs(again - a.usdc) > 0.011) {
            await c.rec.issue("number-mismatch", "high", `${NAME}: Earn shows ${again} USDC after the faucet; the API ${a.usdc}`, { key: `${NAME} wallet figure` });
          }
        }
      });
      await overLimit(ctx, c, kp);
    } finally {
      await c.close();
    }
  },
};

/// A second visitor in this session: the same persona's device and theme,
/// another wallet, the same detectors.
async function openAs(ctx: Ctx, kp: Keypair): Promise<Ctx> {
  const browser = ctx.context.browser();
  if (!browser) throw new Error("no browser to open a second context in");
  const p = ctx.persona;
  const c = new Ctx(p, ctx.session, ctx.worker);
  c.owner = kp.publicKey.toBase58();
  c.deadline = ctx.deadline;
  c.context = await browser.newContext({
    viewport: { width: p.device.width, height: p.device.height }, isMobile: p.device.mobile, hasTouch: p.device.touch,
    deviceScaleFactor: 1, colorScheme: p.theme, locale: "en-US", serviceWorkers: "block",
  });
  c.context.setDefaultTimeout(12_000);
  c.context.setDefaultNavigationTimeout(30_000);
  await c.context.addInitScript(({ theme, key }) => {
    try {
      localStorage.setItem("unwind.theme", theme);
      localStorage.setItem(key, JSON.stringify({ v: 1, at: Date.now(), skipped: true }));
    } catch { /* storage blocked */ }
  }, { theme: p.theme, key: `unwind.welcome:${c.owner}` });
  await c.context.addInitScript(PAGE_WATCH);
  if (config.dryTx) await c.context.route("**/api/tx/send", (r) => r.abort("blockedbyclient"));
  c.wallet = await installWallet(c.context, p, kp, {
    onRefused: (reason) => void c.rec?.issue("unexpected-sign", "medium", `Wallet asked to sign outside a journey's transaction step: ${reason}`),
  });
  await c.context.exposeFunction("__unwindToast", (t: { status: string; text: string }) => c.rec?.onToast(t));
  c.page = await c.context.newPage();
  c.rec = new Recorder(c.page, p, ctx.rec.onIssue);
  c.rec.attach();
  c.rec.step = ctx.rec.step;
  return c;
}

/// Earn, connected, until the prompt reads `want`; false when it never does.
async function fundPrompt(c: Ctx, want: RegExp): Promise<boolean> {
  await c.goto("/earn", (p) => p.getByRole("heading", { name: "Earn", level: 1 }));
  await c.connect();
  const line = c.page.getByText(want);
  if (!(await line.first().waitFor({ state: "visible", timeout: 15_000 }).then(() => true, () => false))) {
    const a = await acct(c);
    await c.rec.issue("fund-prompt", "medium", `${NAME}: Earn shows no "${want.source}" prompt for a wallet with ${a?.usdc ?? "?"} USDC and ${a?.sol ?? "?"} SOL`, { key: `${NAME} prompt ${want.source}` });
    return false;
  }
  if (!(await c.page.getByRole("button", { name: "Get test funds" }).first().isVisible().catch(() => false))) {
    await c.rec.issue("fund-prompt", "medium", `${NAME}: the "${want.source}" prompt has no Get test funds button`, { key: `${NAME} no button` });
    return false;
  }
  return true;
}

type Claim = { outcome: "answered" | "human" | "no-check"; ok?: boolean; error?: string; usdc?: number; sol?: number };

/*
 * Presses Get test funds and waits, hands off, for the human check to pass
 * by itself. Anything else is "faucet needs human check", recorded once a
 * backoff, and the check is closed with its own Cancel.
 */
async function claim(c: Ctx): Promise<Claim> {
  const answer = c.page.waitForResponse((r) => r.url().includes("/api/faucet") && r.request().method() === "POST", { timeout: 45_000 })
    .catch(() => null as Response | null);
  await c.click(c.page.getByRole("button", { name: "Get test funds" }), "Get test funds");
  const check = c.page.getByRole("dialog", { name: "Get test funds" });
  const shown = await check.first().waitFor({ state: "visible", timeout: 8_000 }).then(() => true, () => false);
  if (shown) {
    const passed = await check.first().waitFor({ state: "hidden", timeout: 30_000 }).then(() => true, () => false);
    if (!passed) {
      const said = await check.first().innerText().catch(() => "");
      store.setMeta(HUMAN_KEY, String(Date.now()));
      await c.rec.issue("needs-human", "low", "faucet needs human check",
        { key: "faucet needs human check", detail: `The Turnstile check did not pass on its own in 30s; the tester does not answer it. Dialog: ${said.replace(/\s+/g, " ").slice(0, 300)}`, shot: false });
      await c.click(check.getByRole("button", { name: "Cancel" }), "Cancel the check", { expectChange: false }).catch(() => undefined);
      return { outcome: "human" };
    }
  }
  const r = await answer;
  if (!r) {
    if (!shown) await c.rec.issue("faucet-silent", "medium", `${NAME}: Get test funds showed no check and sent nothing`, { key: `${NAME} silent` });
    return { outcome: "no-check" };
  }
  const j = await r.json().catch(() => ({})) as { ok?: boolean; error?: string; usdc?: number; sol?: number };
  return { outcome: "answered", ok: !!j.ok, error: j.error, usdc: j.usdc, sol: j.sol };
}

/*
 * The over-limit claim: the balance into the pool, then a fresh browser for
 * the same wallet (this one remembers the claim and hides the button), and
 * a second claim the server must refuse in plain words.
 */
async function overLimit(ctx: Ctx, c: Ctx, kp: Keypair) {
  const a = await acct(c);
  if (!a || a.usdc <= 0) return;
  const r = await ctx.step("everything into the pool", async () => {
    await c.goto("/earn", (p) => p.getByRole("heading", { name: "Earn", level: 1 }));
    await c.click(c.page.getByRole("button", { name: "Deposit", exact: true }), "the pool's Deposit");
    const d = c.page.getByRole("dialog", { name: "The pool" });
    await c.ready(d, "the pool dialog");
    await c.type(d.getByRole("textbox", { name: "Amount to deposit" }), String(Math.floor(a.usdc * 100) / 100));
    const go = d.getByRole("button", { name: "Deposit", exact: true });
    if (!(await go.first().isEnabled({ timeout: 2_000 }).catch(() => false))) return "blocked";
    return c.tx("deposit", () => c.click(go, "Deposit"));
  });
  if (r !== "confirmed") return;
  if (!(await settled(c, (x) => x.usdc < 0.01, 30_000))) return;

  const again = await openAs(ctx, kp);
  try {
    if (!(await ctx.step("wait for the prompt again", () => fundPrompt(again, /^No free USDC\./)))) return;
    const second = await ctx.step("claim again and wait for the check", () => claim(again));
    if (second.outcome !== "answered") return;
    if (second.ok) {
      await again.rec.issue("faucet-over-limit", "high", `${NAME}: a second claim the same day was paid (${second.usdc} USDC)`, { key: `${NAME} paid twice` });
      return;
    }
    await again.page.waitForTimeout(2_000);
    const toast = again.rec.toasts.filter((t) => t.status === "error").pop()?.text.replace(/\n+/g, " ") ?? "";
    if (!/(funded today|try again in \d+h|too many claims|given out)/i.test(toast)) {
      await again.rec.issue("faucet-refusal", "medium", `${NAME}: an over-limit claim was refused (${second.error}) with ${toast ? `"${toast}"` : "no message on the page"}`, { key: `${NAME} refusal text` });
    }
    const next = again.page.getByText(/Next claim in \d+h\./);
    if (/try again in \d+h/.test(second.error ?? "") && !(await next.first().waitFor({ state: "visible", timeout: 12_000 }).then(() => true, () => false))) {
      await again.rec.issue("faucet-refusal", "low", `${NAME}: after "${second.error}" the prompt does not say when the next claim is`, { key: `${NAME} next claim line`, shot: false });
    }
  } finally {
    await again.close();
  }
}
