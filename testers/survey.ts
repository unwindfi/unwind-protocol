/*
 * The survey: every main route, in both themes, on a desktop and a phone,
 * once an hour (SURVEY_EVERY_MIN), as an anonymous visitor with no wallet.
 *
 * Each capture keeps a JPEG (full page, capped at MAX_H tall), the page's
 * aria snapshot trimmed to SNAP_MAX, the console errors seen while it
 * loaded, and an 8x8 average hash of the picture. Only the latest capture
 * per (route, theme, device) is kept; `changed_at` says when it last moved,
 * which is what the review feed reads.
 *
 * The pass is split into chunks of SURVEY_CHUNK captures that a worker
 * takes between sessions (run.ts), never more than one worker at a time, so
 * the fleet's browser count and its CPU and memory caps stay as they are.
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";
import type { Browser, Page } from "playwright-core";
import { config, paths } from "./config";
import { DEVICES, type Device } from "./personas";
import * as store from "./store";

export interface Target { route: string; theme: "dark" | "light"; device: Device }

const MAX_H = 3_000;
const SNAP_MAX = 6_000;
const QUALITY = 70;
/// A path nobody claimed, for the not-found page.
export const NOT_FOUND_PATH = "/survey-no-such-page";

interface MarketLite { symbol: string; hidden?: boolean; paused?: boolean; observed?: unknown }

/// The routes of one pass. The two markets are picked by symbol order from
/// the live list, so the same ones come back hour after hour.
export async function routes(): Promise<string[]> {
  let markets: MarketLite[] | null = null;
  for (let i = 0; i < 3 && !markets; i++) {
    try {
      const r = await fetch(config.apiUrl + "/api/markets", { headers: { accept: "application/json", "user-agent": "unwind-testers/1" } });
      const j = r.ok ? await r.json() : null;
      if (Array.isArray(j)) markets = j as MarketLite[];
    } catch { /* tried again below */ }
    if (!markets) await new Promise((r) => setTimeout(r, 3_000));
  }
  let trade: string[];
  if (markets) {
    const live = markets.filter((m) => !m.hidden && !m.paused).sort((a, b) => a.symbol.localeCompare(b.symbol));
    const stock = live.find((m) => /x$/.test(m.symbol));
    const coin = live.find((m) => m.observed && !/x$/.test(m.symbol)) ?? live.find((m) => !/x$/.test(m.symbol));
    trade = [coin, stock].filter((m): m is MarketLite => !!m).map((m) => `/trade/${encodeURIComponent(m.symbol)}`);
    store.setMeta("survey_trade", JSON.stringify(trade));
  } else {
    // The list did not answer: the same two markets as last time.
    try { trade = JSON.parse(store.getMeta("survey_trade") ?? "[]"); } catch { trade = []; }
  }
  return ["/", "/markets", ...trade, "/list", "/list/bonk", "/earn", "/portfolio", "/rewards", NOT_FOUND_PATH];
}

export async function targets(): Promise<Target[]> {
  const out: Target[] = [];
  for (const route of await routes()) {
    for (const device of [DEVICES.desktop, DEVICES["phone-390"]]) {
      for (const theme of ["dark", "light"] as const) out.push({ route, theme, device });
    }
  }
  return out;
}

/// Figures move every poll; a snapshot that differs only in them has not
/// meaningfully changed.
export function snapSig(snapshot: string): string {
  const flat = snapshot.replace(/\d+([.,]\d+)*/g, "0").replace(/[ \t]+/g, " ");
  return crypto.createHash("sha1").update(flat).digest("hex").slice(0, 16);
}

export function trimSnapshot(s: string, max = SNAP_MAX): string {
  if (s.length <= max) return s;
  const cut = s.lastIndexOf("\n", max);
  const head = s.slice(0, cut > max / 2 ? cut : max);
  return `${head}\n# trimmed ${s.length - head.length} more characters`;
}

const fileFor = (t: Target) =>
  `${(t.route.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "home")}-${t.theme}-${t.device.name}.jpg`;

/*
 * An 8x8 average hash of a JPEG, decoded by the browser itself so no image
 * library is needed: drawn to 64x64, averaged into 8x8 blocks of luminance,
 * one bit per block above the mean.
 */
async function averageHash(page: Page, jpeg: Buffer): Promise<string | null> {
  return page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/jpeg;base64,${b64}`;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = c.height = 64;
    const g = c.getContext("2d")!;
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = "high";
    g.drawImage(img, 0, 0, 64, 64);
    const px = g.getImageData(0, 0, 64, 64).data;
    const cells = new Array(64).fill(0);
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 64; x++) {
        const i = (y * 64 + x) * 4;
        cells[(y >> 3) * 8 + (x >> 3)] += 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
      }
    }
    const mean = cells.reduce((s, v) => s + v, 0) / 64;
    let hex = "";
    for (let n = 0; n < 64; n += 4) {
      let v = 0;
      for (let k = 0; k < 4; k++) v = (v << 1) | (cells[n + k] > mean ? 1 : 0);
      hex += v.toString(16);
    }
    return hex;
  }, jpeg.toString("base64")).catch(() => null);
}

/// One capture: a fresh context, the page loaded and settled, then the
/// picture, the snapshot and the hash. Returns whether it changed.
export async function capture(browser: Browser, t: Target): Promise<boolean> {
  const context = await browser.newContext({
    viewport: { width: t.device.width, height: t.device.height },
    isMobile: t.device.mobile, hasTouch: t.device.touch, deviceScaleFactor: 1,
    colorScheme: t.theme, locale: "en-US", serviceWorkers: "block",
  });
  const errors: string[] = [];
  let error: string | null = null;
  let shot: Buffer | null = null;
  let snapshot: string | null = null;
  let hash: string | null = null;
  try {
    context.setDefaultTimeout(12_000);
    context.setDefaultNavigationTimeout(30_000);
    await context.addInitScript((theme) => {
      try { localStorage.setItem("unwind.theme", theme); } catch { /* storage blocked */ }
    }, t.theme);
    // The same fences as a session: no faucet, no mirror, nothing sent.
    await context.route(/\/api\/(faucet|devnet-copy|tx\/send|seen)(\?|$)/, (r) => r.abort("blockedbyclient"));
    const page = await context.newPage();
    page.on("console", (m) => {
      if (m.type() !== "error") return;
      const text = m.text();
      if (/^Failed to load resource/.test(text) && /blockedbyclient|ERR_BLOCKED_BY_CLIENT/.test(text)) return;
      if (!errors.includes(text)) errors.push(text.slice(0, 500));
    });
    page.on("pageerror", (e) => { const s = `${e.name}: ${e.message}`.slice(0, 500); if (!errors.includes(s)) errors.push(s); });

    const res = await page.goto(config.baseUrl + t.route, { waitUntil: "domcontentloaded" });
    if (res && res.status() >= 400 && t.route !== NOT_FOUND_PATH) error = `answered ${res.status()}`;
    // The site polls, so the network is never idle for long; a bounded wait
    // and a short rest let the first data land.
    // A lazy page can be an empty shell for a moment: wait for words.
    await page.waitForFunction(() => (document.body?.innerText ?? "").trim().length > 40, undefined, { timeout: 10_000 }).catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {});
    await page.waitForTimeout(1_500);

    const h = await page.evaluate(() => Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0)).catch(() => t.device.height);
    shot = await page.screenshot({
      type: "jpeg", quality: QUALITY, fullPage: true, timeout: 15_000,
      clip: { x: 0, y: 0, width: t.device.width, height: Math.max(t.device.height, Math.min(h, MAX_H)) },
    });
    snapshot = trimSnapshot(await page.locator("body").ariaSnapshot({ timeout: 8_000 }).catch((e) => `# no snapshot: ${String(e?.message ?? e).split("\n")[0]}`));
    // Decoded on a blank page, outside the site's content policy.
    const blank = await context.newPage();
    hash = await averageHash(blank, shot);
  } catch (e: any) {
    error = String(e?.message ?? e).split("\n")[0].slice(0, 500);
  } finally {
    await context.close().catch(() => undefined);
  }

  let shotPath: string | null = null;
  if (shot) {
    const file = fileFor(t);
    // Written beside, then renamed, so the feed never serves half a file.
    const tmp = path.join(paths.survey, `.${file}.tmp`);
    fs.writeFileSync(tmp, shot);
    fs.renameSync(tmp, path.join(paths.survey, file));
    shotPath = `survey/${file}`;
  }
  return store.recordSurvey({
    route: t.route, theme: t.theme, device: t.device.name, hash, snapshot,
    console: JSON.stringify(errors.slice(0, 20)), shot_path: shotPath, captured_at: Date.now(),
    snap_sig: snapshot ? snapSig(snapshot) : null, error,
  }, config.surveyHashBits);
}

// ------------------------------------------------------------ scheduling

const state = { queue: [] as Target[], busy: false, nextAt: 0, planning: false, changed: 0, passStarted: 0 };

/// Whether this worker should take a survey chunk now instead of a session.
/// Plans a new pass when one is due; one worker at a time.
export async function due(): Promise<boolean> {
  if (config.surveyEveryMin <= 0 || state.busy || state.planning) return false;
  if (state.queue.length) return true;
  if (!state.nextAt) state.nextAt = Number(store.getMeta("survey_last") ?? 0) + config.surveyEveryMin * 60_000;
  if (Date.now() < state.nextAt) return false;
  state.planning = true;
  try {
    state.queue = await targets();
    state.changed = 0;
    state.passStarted = Date.now();
    state.nextAt = Date.now() + config.surveyEveryMin * 60_000;
    store.setMeta("survey_last", String(Date.now()));
  } finally { state.planning = false; }
  return state.queue.length > 0;
}

/// Takes up to SURVEY_CHUNK captures off the pass. Returns a line for the log.
export async function chunk(browser: Browser, stopping: () => boolean): Promise<string> {
  if (state.busy) return "survey busy";
  state.busy = true;
  const t0 = Date.now();
  let n = 0, failed = 0;
  try {
    while (state.queue.length && n < config.surveyChunk && !stopping()) {
      const t = state.queue.shift()!;
      try {
        if (await capture(browser, t)) state.changed++;
      } catch { failed++; }
      n++;
    }
  } finally { state.busy = false; }
  const left = state.queue.length;
  return `survey ${n} captures in ${((Date.now() - t0) / 1000).toFixed(0)}s${failed ? `, ${failed} failed` : ""}; ` +
    (left ? `${left} left in this pass` : `pass done, ${state.changed} changed, ${((Date.now() - state.passStarted) / 60_000).toFixed(1)} min`);
}
