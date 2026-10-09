/*
 * What the checks share: their own tables (beside the store's, created the
 * same way), filing an issue without a session's Recorder, timed fetches,
 * a session wrapper for checks that drive the site as a persona, and the
 * readers that turn a figure on the page back into a number.
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";
import type { Browser, Page } from "playwright-core";
import { config, paths } from "../config";
import { normalize } from "../detectors";
import { PERSONAS, DEVICES, type Persona } from "../personas";
import { Ctx, StepError } from "../session";
import * as store from "../store";
import type { Severity } from "../store";

// ------------------------------------------------------------ tables

let ready = false;

/*
 * The checks' tables, in the store's file. Additive: created if missing, so
 * the runner and the dashboard can each open them first.
 *
 *   api_checks     one row per route per ping (API health)
 *   api_routes     each route's current state, for closing its issue
 *   page_metrics   speed and errors per survey capture
 *   deploys        each deploy seen, and how its smoke pass went
 *   check_runs     each periodic check's run, pass or fail
 */
export function db() {
  const d = store.open();
  if (ready) return d;
  d.exec(`
    CREATE TABLE IF NOT EXISTS api_checks (
      t INTEGER, route TEXT, status INTEGER, ms INTEGER, ok INTEGER, error TEXT
    );
    CREATE INDEX IF NOT EXISTS api_checks_t ON api_checks(t);
    CREATE TABLE IF NOT EXISTS api_routes (
      route TEXT PRIMARY KEY, ok INTEGER, since INTEGER, sig TEXT, status INTEGER, ms INTEGER, t INTEGER
    );
    CREATE TABLE IF NOT EXISTS page_metrics (
      t INTEGER, route TEXT, device TEXT, theme TEXT, build TEXT,
      ttfb_ms INTEGER, dcl_ms INTEGER, load_ms INTEGER, lcp_ms INTEGER, cls REAL,
      transfer_kb INTEGER, requests INTEGER, failed INTEGER, console_errors INTEGER, broken_images INTEGER
    );
    CREATE INDEX IF NOT EXISTS page_metrics_t ON page_metrics(t);
    CREATE TABLE IF NOT EXISTS deploys (
      id INTEGER PRIMARY KEY AUTOINCREMENT, t INTEGER, site TEXT, server TEXT, reason TEXT,
      status TEXT, results TEXT, finished INTEGER
    );
    CREATE TABLE IF NOT EXISTS check_runs (
      t INTEGER, name TEXT, ms INTEGER, ok INTEGER, summary TEXT
    );
    CREATE INDEX IF NOT EXISTS check_runs_t ON check_runs(t);
  `);
  ready = true;
  return d;
}

export function recordRun(name: string, started: number, ok: boolean, summary: string) {
  db().prepare("INSERT INTO check_runs (t, name, ms, ok, summary) VALUES (?,?,?,?,?)")
    .run(started, name, Date.now() - started, ok ? 1 : 0, summary.slice(0, 1000));
}

/// Old rows go, as the store's do.
export function prune(days = 21) {
  const cut = Date.now() - days * 86_400_000;
  const d = db();
  d.prepare("DELETE FROM api_checks WHERE t < ?").run(cut);
  d.prepare("DELETE FROM page_metrics WHERE t < ?").run(cut);
  d.prepare("DELETE FROM check_runs WHERE t < ?").run(cut);
  d.prepare("DELETE FROM deploys WHERE t < ?").run(Date.now() - 90 * 86_400_000);
}

// ------------------------------------------------------------ issues

/// The same signature a Recorder gives, so a check's sighting and a
/// session's sighting of one problem are one issue.
export const sigOf = (type: string, route: string, key: string) =>
  crypto.createHash("sha1").update([type, route, key].join("|")).digest("hex").slice(0, 16);

export interface CheckIssue {
  type: string; severity: Severity; route: string; message: string;
  key?: string; detail?: string; persona?: string; device?: string; theme?: string; step?: string;
}

const shotTimes: number[] = [];

/// Files one sighting. With `shot` (a page or a JPEG already written), the
/// first sighting gets a picture, at most 30 an hour across the checks.
export async function fileIssue(i: CheckIssue, shot?: Page | string): Promise<string> {
  const signature = sigOf(i.type, i.route, i.key ?? normalize(i.message));
  const { fresh, reopened } = store.recordIssue({
    type: i.type, severity: i.severity, route: i.route, message: i.message, detail: i.detail, signature,
    persona: i.persona ?? "fleet", device: i.device ?? "-", theme: i.theme ?? "-", step: i.step ?? "check",
  });
  if ((fresh || reopened) && shot) {
    const t = Date.now();
    while (shotTimes.length && t - shotTimes[0] > 3_600_000) shotTimes.shift();
    if (shotTimes.length < 30) {
      shotTimes.push(t);
      const file = `${signature}-${t}.jpg`;
      try {
        if (typeof shot === "string") fs.copyFileSync(shot, path.join(paths.shots, file));
        else await shot.screenshot({ path: path.join(paths.shots, file), type: "jpeg", quality: 60, timeout: 8_000 });
        store.setScreenshot(signature, file);
      } catch { /* the page went away */ }
    }
  }
  return signature;
}

// ------------------------------------------------------------ fetching

export interface Fetched { status: number; ms: number; text: string; headers: Headers; error?: string; type: string }

/// One request, timed to the end of its body, never throwing.
export async function timed(url: string, o: { method?: string; ua?: string; ms?: number; accept?: string } = {}): Promise<Fetched> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), o.ms ?? config.apiTimeoutMs);
  const t = Date.now();
  try {
    const r = await fetch(url, {
      method: o.method ?? "GET", signal: ctl.signal, redirect: "follow",
      headers: { "user-agent": o.ua ?? "unwind-testers/1", accept: o.accept ?? "*/*" },
    });
    const text = o.method === "HEAD" ? "" : await r.text();
    return { status: r.status, ms: Date.now() - t, text, headers: r.headers, type: r.headers.get("content-type") ?? "" };
  } catch (e: any) {
    const why = e?.name === "AbortError" ? `no answer in ${(o.ms ?? config.apiTimeoutMs) / 1000}s` : String(e?.cause?.code ?? e?.message ?? e);
    return { status: 0, ms: Date.now() - t, text: "", headers: new Headers(), error: why, type: "" };
  } finally { clearTimeout(timer); }
}

/// JSON from the API at its own host, or null.
export async function api<T>(p: string): Promise<T | null> {
  const r = await timed(config.checksApiUrl + p, { accept: "application/json" });
  if (r.status !== 200) return null;
  try { return JSON.parse(r.text) as T; } catch { return null; }
}

export const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------ personas

export function persona(id: string, desktop = true): Persona {
  const p = PERSONAS.find((x) => x.id === id);
  if (!p) throw new Error(`no persona ${id}`);
  // Checks read the desktop layout unless they ask for the persona's own.
  return desktop ? { ...p, device: DEVICES.desktop } : p;
}

/*
 * A check that drives the site: one persona, one fresh context, its steps
 * timed and its issues filed as a session's are. Recorded as a session and
 * a journey named after the check, so the dashboard shows it beside the
 * rest. Throws nothing; says how it went.
 */
export async function asPersona(
  browser: Browser, p: Persona, name: string, budgetMs: number,
  fn: (ctx: Ctx) => Promise<string | void>,
  o: { key?: import("@solana/web3.js").Keypair; worker?: number } = {},
): Promise<{ ok: boolean; note: string }> {
  const id = store.startSession({ persona: p.id, role: `check:${name}`, device: p.device.name, theme: p.theme, worker: o.worker ?? 0 });
  const ctx = new Ctx(p, id, o.worker ?? 0, o.key);
  const t0 = Date.now();
  let ok = true, note = "", err: string | undefined;
  try {
    await ctx.open(browser);
    ctx.deadline = t0 + budgetMs;
    let timer: NodeJS.Timeout | undefined;
    try {
      note = (await Promise.race([
        fn(ctx),
        new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new StepError(`over its ${budgetMs / 1000}s budget`)), budgetMs + 5_000); }),
      ])) ?? "";
    } finally { if (timer) clearTimeout(timer); }
  } catch (e: any) {
    ok = false;
    err = `${ctx.rec?.step ?? "open"}: ${String(e?.message ?? e).split("\n")[0]}`;
    note = err;
    // A check that could not run is a finding about the check or the site;
    // the step says which.
    if (ctx.rec) {
      await ctx.rec.issue("check-failed", "low", `${name} / ${err}`, {
        key: `${name} ${ctx.rec.step} ${normalize(String(e?.message ?? e).split("\n")[0])}`.slice(0, 200),
        detail: String(e?.stack ?? e).slice(0, 4000),
      }).catch(() => undefined);
    }
  } finally {
    store.recordJourney({ session: id, persona: p.id, name: `check:${name}`, started: t0, ok, error: err, steps: ctx.steps });
    await ctx.close();
    store.endSession(id, { ok, passed: ok ? 1 : 0, failed: ok ? 0 : 1, error: err });
  }
  return { ok, note };
}

// ------------------------------------------------------------ figures

export interface Shown { text: string; value: number | null }

/*
 * "$17.93K" to 17930, "-$3.10" to -3.1, "0.480%" to 0.48, "–" to null, with
 * how far off a figure can be from its source by rounding alone: half a
 * unit of its last place. `compact` figures (Intl compact notation) carry up
 * to two places even when they print fewer ("$12.5K" is 12,500 to 12,505).
 */
export function figure(text: string | null | undefined, compact = false): { value: number | null; tol: number } {
  if (!text) return { value: null, tol: 0 };
  const s = text.replace(/[−–]/g, (c) => (c === "−" ? "-" : "–")).trim();
  const m = /(-|\+)?\$?\s*(-|\+)?([\d,]*\.?\d+)\s*([KMBT])?/.exec(s);
  if (!m) return { value: null, tol: 0 };
  const mult = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 }[m[4] as "K"] ?? 1;
  const digits = m[3].replace(/,/g, "");
  const places = digits.includes(".") ? digits.split(".")[1].length : 0;
  const sign = m[1] === "-" || m[2] === "-" ? -1 : 1;
  const value = sign * Number(digits) * mult;
  const unit = compact && m[4] ? 10 ** -Math.max(places, 2) : 10 ** -places;
  return { value, tol: 0.5 * unit * mult };
}

/// Whether a shown figure is its source, beyond rounding (and `slack`, a
/// share of the value for figures that move between two reads).
export function sameFigure(text: string, truth: number, o: { compact?: boolean; slack?: number } = {}) {
  const f = figure(text, o.compact);
  if (f.value == null || !Number.isFinite(truth)) return true;
  return Math.abs(f.value - truth) <= f.tol + Math.abs(truth) * (o.slack ?? 0) + 1e-9;
}

/*
 * In the page: every figure printed beside one of `labels` in the site's
 * label-over-value pairs (StatTiles, KV, Stat). The label is a leaf whose own
 * text is the label; the figure is the next element beside it, or beside the
 * nearest ancestor that has one. Text inside aria-hidden (DigitSwap's
 * animated glyphs) is skipped, so a figure reads once.
 */
export const READ_LABELS = (a: { labels: string[]; scope?: string }) => {
  const root = (a.scope ? document.querySelector(a.scope) : document.body) ?? document.body;
  const textOf = (el: Element) => {
    let out = "";
    const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      if ((n.parentElement as Element | null)?.closest("[aria-hidden='true']")) continue;
      out += n.textContent ?? "";
    }
    return out.replace(/\s+/g, " ").trim();
  };
  const found: Record<string, string[]> = {};
  root.querySelectorAll("*").forEach((el) => {
    if (el.children.length) return;
    const t = (el.textContent ?? "").trim();
    if (!a.labels.includes(t)) return;
    let at: Element | null = el;
    for (let i = 0; i < 3 && at && !at.nextElementSibling; i++) at = at.parentElement;
    const v = at?.nextElementSibling;
    if (!v) return;
    (found[t] ??= []).push(textOf(v));
  });
  return found;
};
