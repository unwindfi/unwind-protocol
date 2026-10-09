/*
 * One persona's visit: a fresh browser context, the wallet, the detectors,
 * and the helpers every journey uses to move through the site the way a
 * person would (and to notice when the site does not answer).
 */
import type { Browser, BrowserContext, Locator, Page } from "playwright-core";
import { config } from "./config";
import { Recorder, PAGE_CHECKS, PAGE_WATCH } from "./detectors";
import { keyOf, type Persona } from "./personas";
import { rng, type Rng } from "./rng";
import * as store from "./store";
import * as txgate from "./txgate";
import { installWallet, WALLET_NAME, type WalletHandle } from "./wallet";

export interface Market {
  symbol: string; name: string; price: number; bid: number; ask: number;
  maxLeverage: number; hidden?: boolean; paused?: boolean; priceAgeMs: number | null;
  maxPriceAgeSec: number; observed: { tradeable: boolean; seasoned: boolean } | null;
  poolFillUsd?: number;
}

export interface AccountView {
  address: string; usdc: number; sol?: number | null; equity: number;
  positions: Record<string, { isLong: boolean; size: number; collateral: number; entry: number; mark: number }>;
  orders: { symbol: string; slot: number; kind: number; isLong: boolean; triggerPrice: number }[];
  lp: { value: number; pending?: { slotsLeft: number } | null };
}

/// A journey step that could not be done as written: the control was not
/// there, or the page never reached the state the step waits for.
export class StepError extends Error {}

export class Ctx {
  page!: Page;
  context!: BrowserContext;
  rec!: Recorder;
  wallet!: WalletHandle;
  rng: Rng;
  owner: string;
  steps = 0;
  deadline = 0;
  connected = false;
  private marketCache: Market[] | null = null;

  constructor(public persona: Persona, public session: number, public worker: number) {
    this.rng = rng(persona.seed ^ (session * 2654435761));
    this.owner = keyOf(persona).publicKey.toBase58();
  }

  get phone() { return this.persona.device.width < 768; }
  get short() { return `${this.owner.slice(0, 4)}…${this.owner.slice(-4)}`; }

  async open(browser: Browser) {
    const p = this.persona;
    this.context = await browser.newContext({
      viewport: { width: p.device.width, height: p.device.height },
      isMobile: p.device.mobile,
      hasTouch: p.device.touch,
      deviceScaleFactor: 1,
      colorScheme: p.theme,
      locale: "en-US",
      userAgent: undefined,
      serviceWorkers: "block",
    });
    this.context.setDefaultTimeout(12_000);
    this.context.setDefaultNavigationTimeout(30_000);
    // The theme this person chose last time, and (for anyone but a first
    // visitor) the welcome they already read: a returning user.
    await this.context.addInitScript(({ theme, welcomeKey }) => {
      try {
        localStorage.setItem("unwind.theme", theme);
        if (welcomeKey) localStorage.setItem(welcomeKey, JSON.stringify({ v: 1, at: Date.now(), skipped: true }));
      } catch { /* storage blocked */ }
    }, { theme: p.theme, welcomeKey: p.role === "new" ? null : `unwind.welcome:${this.owner}` });
    await this.context.addInitScript(PAGE_WATCH);

    // Never the faucet: it sits behind a human check the fleet must not
    // touch, and the fleet is funded by fund.ts instead.
    await this.context.route("**/api/faucet", (r) => r.abort("blockedbyclient"));
    await this.context.route("**/api/devnet-copy", (r) =>
      this.allowMirror ? r.continue() : r.abort("blockedbyclient"));
    if (config.dryTx) {
      // Belt and braces: the wallet already refuses to hand back a signed
      // transaction in a dry run, and nothing may reach the chain.
      await this.context.route("**/api/tx/send", (r) => r.abort("blockedbyclient"));
      // The welcome's report writes to the server's records; answered here.
      await this.context.route("**/api/seen", (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' }));
    }

    this.wallet = await installWallet(this.context, p, keyOf(p), {
      onRefused: (reason) => void this.rec?.issue("unexpected-sign", "medium", `Wallet asked to sign outside a journey's transaction step: ${reason}`),
    });
    await this.context.exposeFunction("__unwindToast", (t: { status: string; text: string }) => this.rec?.onToast(t));

    this.page = await this.context.newPage();
    this.rec = new Recorder(this.page, p);
    this.rec.attach();
  }

  /// Set by the lister's real listing, the one flow that may ask the server
  /// to copy a mainnet pool to devnet.
  allowMirror = false;

  async close() {
    try { await this.context?.close(); } catch { /* already gone */ }
  }

  url(path: string) { return config.baseUrl + path; }

  /// Runs one named step; its errors say which step they came from, and a
  /// step that takes too long is itself an issue.
  async step<T>(name: string, fn: () => Promise<T>): Promise<T> {
    if (Date.now() > this.deadline) throw new StepError(`out of time before "${name}"`);
    this.rec.step = name;
    this.steps++;
    const t = Date.now();
    try {
      return await fn();
    } finally {
      const ms = Date.now() - t;
      if (ms > config.slowStepMs && !/wait|watch|think/i.test(name)) {
        await this.rec.issue("slow-step", "low", `Step "${name}" took ${(ms / 1000).toFixed(1)}s`, { key: `slow ${name}` });
      }
      await this.rec.checkStuck();
    }
  }

  /// A pause the length this person takes to read a screen.
  async think(base = 1_200) {
    const ms = base * (0.5 + this.persona.patience) * (0.6 + this.rng.next() * 0.8);
    await this.page.waitForTimeout(Math.min(ms, Math.max(0, this.deadline - Date.now())));
  }

  /// A document load to `path`, timed to the moment `ready` shows.
  async goto(path: string, ready: (p: Page) => Locator) {
    const t = Date.now();
    await this.page.goto(this.url(path), { waitUntil: "domcontentloaded" });
    await this.ready(ready(this.page), `open ${path}`, t);
  }

  /// Waits for `loc`, and reports a slow page if it took past SLOW_NAV_MS.
  async ready(loc: Locator, what: string, since = Date.now()) {
    try {
      await loc.first().waitFor({ state: "visible", timeout: 30_000 });
    } catch {
      throw new StepError(`${what}: never showed ${loc}`);
    }
    const ms = Date.now() - since;
    if (ms > config.slowNavMs) {
      await this.rec.issue("slow-navigation", ms > 10_000 ? "high" : "medium",
        `${what} took ${(ms / 1000).toFixed(1)}s to show its content`, { key: `slow ${this.rec.route}` });
    }
    return ms;
  }

  /*
   * A click that is expected to do something. If nothing in the DOM, the
   * network or the address changes within DEAD_CLICK_MS, the click was dead.
   */
  async click(loc: Locator, label: string, o: { force?: boolean; expectChange?: boolean } = {}) {
    const target = loc.first();
    try {
      await target.waitFor({ state: "visible", timeout: 10_000 });
    } catch {
      throw new StepError(`no ${label} to click (${loc})`);
    }
    await target.scrollIntoViewIfNeeded().catch(() => {});
    const m0 = await Promise.race([
      this.page.evaluate(() => (window as any).__unwindMut ?? 0).catch(() => 0),
      new Promise<number>((r) => setTimeout(() => r(0), 1_000)),
    ]);
    const n0 = this.rec.requests;
    const u0 = this.page.url();
    if (this.persona.device.touch && this.rng.chance(0.5)) await target.tap({ force: o.force, timeout: 8_000 });
    else await target.click({ force: o.force, timeout: 8_000 });
    if (o.expectChange === false) return;
    const until = Date.now() + config.deadClickMs;
    while (Date.now() < until) {
      if (this.page.isClosed()) return;
      if (this.page.url() !== u0 || this.rec.requests > n0) return;
      // Bounded: a page busy throwing errors can hold an evaluate up.
      const m = await Promise.race([
        this.page.evaluate(() => (window as any).__unwindMut ?? 0).catch(() => m0 + 1),
        new Promise<number>((r) => setTimeout(() => r(m0), 1_000)),
      ]);
      if (m > m0) return;
      await this.page.waitForTimeout(150);
    }
    await this.rec.issue("dead-click", "medium", `Clicking ${label} changed nothing for ${config.deadClickMs / 1000}s`, { key: `dead ${label}` });
  }

  /// Types the way a person does: clear, then a key at a time.
  async type(loc: Locator, text: string) {
    const t = loc.first();
    await t.click({ timeout: 8_000 });
    await t.fill("");
    await t.pressSequentially(text, { delay: 30 + this.rng.int(0, 60) });
  }

  /// The layout and accessibility checks on whatever is on screen now.
  async checkPage() {
    const found = await this.page.evaluate(PAGE_CHECKS, { phone: this.phone }).catch(() => []);
    for (const f of found as { type: string; severity: "high" | "medium" | "low"; message: string; key: string; detail?: string }[]) {
      // The header and footer are on every page: one issue, not one per route.
      const chrome = /(^|[ "])(header|footer) > /.test(f.message);
      await this.rec.issue(f.type, f.severity, f.message, { key: f.key, detail: f.detail, route: chrome ? "(every page)" : undefined });
    }
  }

  // ------------------------------------------------------------ the API

  async api<T>(path: string): Promise<T | null> {
    try {
      const r = await fetch(config.apiUrl + path, { headers: { accept: "application/json" } });
      if (!r.ok) return null;
      return (await r.json()) as T;
    } catch { return null; }
  }

  async markets(): Promise<Market[]> {
    if (!this.marketCache) this.marketCache = (await this.api<Market[]>("/api/markets")) ?? [];
    return this.marketCache;
  }

  /// Markets a person could trade right now: listed, not paused, priced.
  async tradeable(): Promise<Market[]> {
    return (await this.markets()).filter((m) => !m.hidden && !m.paused
      && (m.priceAgeMs == null || m.priceAgeMs / 1000 < m.maxPriceAgeSec)
      && (!m.observed || m.observed.tradeable));
  }

  /// The market this persona would open: a favorite if listed, else one to
  /// its taste, else any.
  async pickMarket(): Promise<Market | null> {
    const all = await this.tradeable();
    if (!all.length) return (await this.markets())[0] ?? null;
    const favs = all.filter((m) => this.persona.favorites.includes(m.symbol));
    if (favs.length && this.rng.chance(0.75)) return this.rng.pick(favs);
    const taste = this.persona.taste;
    const pool = taste === "opened" ? all.filter((m) => m.observed)
      : taste === "equities" ? all.filter((m) => /x$/.test(m.symbol))
      : all;
    return this.rng.pick(pool.length ? pool : all);
  }

  account() { return this.api<AccountView>(`/api/account?owner=${this.owner}`); }

  // ------------------------------------------------------------ the wallet

  /// The header's connected tile, which shows the short address.
  addressTile() { return this.page.getByRole("button", { name: this.short }); }

  /*
   * Connects through the site's own picker, the way a person would: the
   * header's Wallet button (or a page's "Connect wallet"), then the tester
   * wallet's row. Ends when the header shows the address.
   */
  async connect(via?: Locator) {
    if (await this.addressTile().first().isVisible().catch(() => false)) { this.connected = true; return; }
    await this.step("connect wallet", async () => {
      const button = via ?? this.page.getByRole("button", { name: /^(Wallet|Connect wallet)$/ });
      await this.click(button, "the wallet button");
      const picker = this.page.getByRole("dialog", { name: "Connect wallet" });
      await this.ready(picker, "wallet picker");
      const row = picker.getByRole("button", { name: WALLET_NAME });
      if (!(await row.first().isVisible().catch(() => false))) {
        await this.rec.issue("wallet-missing", "high", `The wallet picker does not list "${WALLET_NAME}" (Wallet Standard registration not seen)`);
        throw new StepError("tester wallet not in the picker");
      }
      await this.click(row, "the tester wallet");
      try {
        await this.addressTile().first().waitFor({ state: "visible", timeout: 15_000 });
      } catch {
        await this.rec.issue("connect-failed", "high", "Picked the wallet but the header never showed its address");
        throw new StepError("wallet did not connect");
      }
      this.connected = true;
    });
    await this.welcome();
  }

  /*
   * The first-connect welcome: three screens, then a message to sign. A new
   * user reads it through (and signs, sometimes after going back a screen);
   * anyone else has it remembered from an earlier visit.
   */
  async welcome() {
    const d = this.page.getByRole("dialog", { name: /^(unwind|Start with|Before you start)$/ });
    // A returning persona has it remembered; a glance is enough to be sure.
    const wait = this.persona.role === "new" ? 5_000 : 1_000;
    if (!(await d.first().waitFor({ state: "visible", timeout: wait }).then(() => true, () => false))) return;
    await this.step("welcome", async () => {
      if (this.rng.chance(0.15)) { await this.click(d.getByRole("button", { name: "Skip" }), "Skip"); return; }
      await this.click(d.getByRole("button", { name: "Continue" }), "Continue (welcome 1)");
      await this.think(600);
      // A chosen path sends the reader to that page; pick the one they are
      // already on (or none), so the journey carries on where it was.
      const here = new URL(this.page.url()).pathname;
      const path = this.rng.chance(0.6) ? (/^\/trade/.test(here) ? "Trade" : here === "/earn" ? "Earn" : null) : null;
      if (path) await this.click(d.getByRole("button", { name: new RegExp(`^${path}`) }), `${path} path`);
      await this.click(d.getByRole("button", { name: /^(Continue|Decide later)$/ }), "Continue (welcome 2)");
      await this.click(d.getByRole("checkbox"), "the risk checkbox");
      const start = d.getByRole("button", { name: /^(Start|Trade|Earn)$/ });
      await this.click(start, "Start");
      await d.first().waitFor({ state: "hidden", timeout: 15_000 }).catch(async () => {
        await this.rec.issue("welcome-stuck", "medium", "The welcome stayed open after signing");
      });
      // A chosen path sends the reader on with a full page load.
      await this.page.waitForLoadState("domcontentloaded").catch(() => {});
    });
  }

  /*
   * Presses something that asks the wallet to sign a transaction, inside the
   * fleet's rate limits. Returns what happened:
   *   skipped    over the limit; nothing was pressed
   *   no-sign    pressed, but the page never asked the wallet (a refused
   *              build shows as a toast, which the detectors record)
   *   dry        signed and refused (DRY_TX)
   *   confirmed / failed / timeout   the server's answer to the send
   */
  async tx(kind: string, press: () => Promise<void>): Promise<"skipped" | "no-sign" | "dry" | "confirmed" | "failed" | "timeout"> {
    const ticket = await txgate.acquire(this.persona.id, kind);
    if (!ticket) return "skipped";
    this.wallet.allow(ticket);
    const sends = this.rec.sends.length;
    const signed = this.wallet.log.signed.length;
    await press();
    await this.wallet.waitForSign(30_000);
    if (this.wallet.log.signed.length === signed) {
      this.wallet.revoke();
      store.recordTx({ persona: this.persona.id, kind, status: "not-asked" });
      const last = this.rec.toasts[this.rec.toasts.length - 1];
      if (!last || last.status !== "error") {
        await this.rec.issue("tx-no-prompt", "medium", `Pressed ${kind} but the wallet was never asked to sign and no error showed`, { key: `noprompt ${kind}` });
      }
      return "no-sign";
    }
    if (config.dryTx) return "dry";
    const t = Date.now();
    while (Date.now() - t < config.txTimeoutMs && this.rec.sends.length === sends) await this.page.waitForTimeout(250);
    const r = this.rec.sends[sends];
    if (!r) {
      store.recordTx({ persona: this.persona.id, kind, status: "timeout", ms: Date.now() - t });
      await this.rec.issue("tx-unconfirmed", "high", `${kind}: no answer from the send after ${config.txTimeoutMs / 1000}s`, { key: `unconfirmed ${kind}` });
      return "timeout";
    }
    store.recordTx({ persona: this.persona.id, kind, status: r.ok ? "confirmed" : "failed", ms: r.ms, message: r.error, sig: r.sig });
    if (!r.ok) {
      // The failure is the toast detector's to record, in the page's words;
      // a failure the page never mentions is its own problem.
      await this.page.waitForTimeout(3_000);
      if (!this.rec.toasts.slice(-4).some((x) => x.status === "error")) {
        await this.rec.issue("tx-failed-silent", "high", `${kind} failed (${r.error ?? "no reason"}) and the page showed no error`, { key: `silent ${kind}` });
      }
    }
    return r.ok ? "confirmed" : "failed";
  }
}
