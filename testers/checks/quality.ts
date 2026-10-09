/*
 * Speed, errors and layout, measured on the survey's own page loads, so the
 * pass adds no captures: every main route, dark and light, desktop and
 * phone, once an hour, from a cold cache.
 *
 * Speed: navigation timing (time to first byte, DOMContentLoaded, load),
 * Largest Contentful Paint and Cumulative Layout Shift from a
 * PerformanceObserver installed before the page's scripts, total bytes on
 * the wire (from the DevTools protocol, which also counts the API on its
 * own host), and the console errors, failed requests and broken images
 * (complete, with a source, naturalWidth 0) seen on the way. One row per
 * capture in page_metrics. Filed: LCP over PERF_LCP_MS, CLS over PERF_CLS,
 * any console error, any broken image.
 *
 * Layout: the session's page checks (detectors.ts: the page wider than the
 * screen, controls off screen, clipped labels), plus what only matters at
 * these sizes: an element spilling out of its box, interactive text boxes
 * that overlap, tap targets under 44 by 44 CSS px on a touch screen, and
 * button text cut by an overflow-hidden box.
 */
import type { BrowserContext, CDPSession, Page } from "playwright-core";
import { config } from "../config";
import { normalize, PAGE_CHECKS, routeOf } from "../detectors";
import * as store from "../store";
import type { Target } from "../survey";
import { db, fileIssue } from "./common";

/// Before the page's own scripts: LCP and CLS (session windows, as the
/// metric is defined: shifts under a second apart, at most five seconds).
export const PERF_WATCH = () => {
  const w = window as any;
  if (w.top !== w || w.__unwindPerf) return;
  const perf = { lcp: 0, cls: 0, win: 0, first: 0, last: 0 };
  w.__unwindPerf = perf;
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries() as any[]) perf.lcp = Math.max(perf.lcp, e.renderTime || e.loadTime || e.startTime);
    }).observe({ type: "largest-contentful-paint", buffered: true });
  } catch { /* not supported */ }
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries() as any[]) {
        if (e.hadRecentInput) continue;
        if (perf.win && e.startTime - perf.last < 1_000 && e.startTime - perf.first < 5_000) perf.win += e.value;
        else { perf.win = e.value; perf.first = e.startTime; }
        perf.last = e.startTime;
        perf.cls = Math.max(perf.cls, perf.win);
      }
    }).observe({ type: "layout-shift", buffered: true });
  } catch { /* not supported */ }
};

export interface Watch {
  cdp: CDPSession | null;
  bytes: number;
  requests: number;
  failed: string[];
}

/// Starts counting a page's traffic. Call before the navigation.
export async function watch(context: BrowserContext, page: Page): Promise<Watch> {
  const w: Watch = { cdp: null, bytes: 0, requests: 0, failed: [] };
  try {
    w.cdp = await context.newCDPSession(page);
    await w.cdp.send("Network.enable");
    w.cdp.on("Network.loadingFinished", (e: any) => { w.bytes += e.encodedDataLength ?? 0; w.requests++; });
    w.cdp.on("Network.loadingFailed", (e: any) => { w.requests++; });
  } catch { w.cdp = null; }
  page.on("requestfailed", (r) => {
    const f = r.failure()?.errorText ?? "failed";
    // The survey's own fences and polls cut off by the next page.
    if (/ERR_BLOCKED_BY_CLIENT|ERR_ABORTED/.test(f)) return;
    w.failed.push(`${r.method()} ${r.url().split("?")[0]} ${f}`);
  });
  page.on("response", (r) => {
    if (r.status() < 400) return;
    const u = new URL(r.url());
    if (u.pathname.startsWith("/_vercel/") || u.host === "challenges.cloudflare.com") return;
    w.failed.push(`${r.request().method()} ${u.host}${u.pathname} ${r.status()}`);
  });
  return w;
}

interface Measured {
  ttfb: number; dcl: number; load: number; lcp: number; cls: number;
  broken: string[];
}

/// In the page: the timing, the observer's figures, and broken images.
const MEASURE = (): Measured => {
  const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
  const p = (window as any).__unwindPerf ?? { lcp: 0, cls: 0 };
  const broken = Array.from(document.images)
    .filter((img) => img.complete && !!img.currentSrc && img.naturalWidth === 0 && !img.closest("[aria-hidden='true'][hidden]"))
    .map((img) => img.currentSrc.split("?")[0])
    .slice(0, 10);
  return {
    ttfb: Math.round(nav?.responseStart ?? 0), dcl: Math.round(nav?.domContentLoadedEventEnd ?? 0),
    load: Math.round(nav?.loadEventEnd ?? 0), lcp: Math.round(p.lcp), cls: Math.round(p.cls * 1000) / 1000,
    broken: Array.from(new Set(broken)),
  };
};

/*
 * In the page: the layout findings beyond PAGE_CHECKS. Each kind is grouped
 * per page so a list of fifty small stars is one issue, not fifty.
 */
export const LAYOUT_CHECKS = (opts: { touch: boolean; width: number }) => {
  const out: { type: string; severity: string; message: string; key: string; detail?: string; chrome?: boolean }[] = [];
  const vw = Math.min(window.innerWidth, opts.width);
  const visible = (el: Element) => {
    const s = getComputedStyle(el);
    if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) === 0) return false;
    if (el.closest("[aria-hidden='true'], [inert], [hidden], .sr-only")) return false;
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1;
  };
  const describe = (el: Element) => {
    const tag = el.tagName.toLowerCase();
    const label = el.getAttribute("aria-label");
    const text = ((el as HTMLElement).innerText ?? "").trim().replace(/\s+/g, " ").slice(0, 32);
    const near = el.closest("section, aside, header, nav, main, footer, [role=dialog]");
    const where = near ? (near.getAttribute("aria-label") || near.tagName.toLowerCase()) : "";
    return `${where ? where + " > " : ""}${tag}${label ? `[aria-label="${label}"]` : ""}${text ? ` "${text}"` : ""}`;
  };
  const shape = (el: Element) => describe(el).replace(/"[^"]*"/g, "").replace(/\d+/g, "n");
  const clips = (s: CSSStyleDeclaration) => s.overflowX !== "visible" || s.overflowY !== "visible";
  const scrolls = (s: CSSStyleDeclaration) => /auto|scroll/.test(s.overflowX + s.overflowY);
  const inScroller = (el: Element) => {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) if (scrolls(getComputedStyle(p))) return true;
    return false;
  };

  // 1. Out of its box: a text or control whose box runs past the nearest
  // ancestor that draws one (a border or a background), where nothing clips
  // or scrolls it. Positioned and transformed things are left alone: that is
  // a tooltip, a badge or an animation, placed there on purpose.
  const spilled: string[] = [];
  const leaves = Array.from(document.querySelectorAll("main button, main a[href], main input, main h1, main h2, main h3, main p, main span, main td"));
  for (const el of leaves) {
    if (spilled.length >= 6) break;
    if (!visible(el) || inScroller(el)) continue;
    const s = getComputedStyle(el);
    if (s.position === "absolute" || s.position === "fixed" || s.transform !== "none") continue;
    let box: Element | null = el.parentElement;
    for (; box && box !== document.body; box = box.parentElement) {
      const b = getComputedStyle(box);
      if (clips(b) || b.position === "absolute" || b.position === "fixed" || b.transform !== "none") { box = null; break; }
      const drawn = b.borderTopWidth !== "0px" || b.borderLeftWidth !== "0px" || (b.backgroundColor !== "rgba(0, 0, 0, 0)" && b.backgroundColor !== "transparent");
      if (drawn) break;
    }
    if (!box || box === document.body) continue;
    const r = el.getBoundingClientRect(), p = box.getBoundingClientRect();
    const over = Math.max(r.right - p.right, p.left - r.left);
    if (over > 3 && r.width < vw) spilled.push(`${describe(el)} runs ${Math.round(over)}px out of ${describe(box).slice(0, 60)}`);
  }
  if (spilled.length) {
    out.push({ type: "container-overflow", severity: "medium",
      message: `${spilled.length > 5 ? "6 or more" : spilled.length} element(s) run out of their box: ${spilled.slice(0, 3).join("; ")}`,
      key: `spill ${spilled.slice(0, 2).map((x) => x.replace(/"[^"]*"/g, "").replace(/\d+/g, "n")).join(";")}`,
      detail: spilled.join("\n") });
  }

  // Interactive elements on screen, for the next three.
  const controls = Array.from(document.querySelectorAll("button, a[href], input, select, textarea, [role=button], [role=tab], [role=menuitem], [role=checkbox], [role=switch], [role=radio]"))
    .filter((el) => visible(el) && !el.closest("[role=dialog][aria-hidden='true']"));
  const rect = new Map(controls.map((el) => [el, el.getBoundingClientRect()]));
  const onScreen = controls.filter((el) => { const r = rect.get(el)!; return r.bottom > 0 && r.right > 0 && r.left < vw; });
  /// The part of a box its scrolling or clipping ancestors let show: a row
  /// half scrolled out of a list is not under whatever sits below the list.
  const shown = (el: Element) => {
    const r = rect.get(el)!;
    let l = r.left, t = r.top, rt = r.right, b = r.bottom;
    for (let p = el.parentElement; p && p !== document.documentElement; p = p.parentElement) {
      const s = getComputedStyle(p);
      if (s.overflowX === "visible" && s.overflowY === "visible") continue;
      const c = p.getBoundingClientRect();
      if (s.overflowX !== "visible") { l = Math.max(l, c.left); rt = Math.min(rt, c.right); }
      if (s.overflowY !== "visible") { t = Math.max(t, c.top); b = Math.min(b, c.bottom); }
    }
    return { left: l, top: t, right: rt, bottom: b };
  };

  // 2. Overlapping text boxes: two controls with words in them whose boxes
  // cross, neither inside the other, where the one on top hides the other.
  const overlaps: string[] = [];
  // In the page's flow only: a popover, a menu or a fixed bar sits over the
  // page on purpose, and content scrolls under a sticky bar.
  const floating = (el: Element) => {
    for (let p: Element | null = el; p && p !== document.body; p = p.parentElement) {
      if (/^(fixed|sticky|absolute)$/.test(getComputedStyle(p).position)) return true;
    }
    return false;
  };
  const texty = onScreen.filter((el) => ((el as HTMLElement).innerText ?? "").trim().length > 0 && !floating(el)).slice(0, 400);
  const vis = new Map(texty.map((el) => [el, shown(el)]));
  for (let i = 0; i < texty.length && overlaps.length < 6; i++) {
    for (let j = i + 1; j < texty.length && overlaps.length < 6; j++) {
      const a = texty[i], b = texty[j];
      if (a.contains(b) || b.contains(a)) continue;
      const ra = vis.get(a)!, rb = vis.get(b)!;
      const w = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
      const h = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
      if (w <= 4 || h <= 4) continue;
      const x = Math.max(ra.left, rb.left) + w / 2, y = Math.max(ra.top, rb.top) + h / 2;
      // Off screen, the browser cannot say what is on top; two boxes in the
      // flow that cross are wrong either way.
      if (y >= 0 && y < window.innerHeight && x >= 0 && x < vw) {
        const top = document.elementFromPoint(x, y);
        if (!top || (!a.contains(top) && !b.contains(top))) continue;
      }
      overlaps.push(`${describe(a)} and ${describe(b)} overlap by ${Math.round(w)}x${Math.round(h)}px`);
    }
  }
  if (overlaps.length) {
    out.push({ type: "text-overlap", severity: "medium",
      message: overlaps.slice(0, 3).join("; "),
      key: `overlap ${overlaps.slice(0, 2).map((x) => x.replace(/"[^"]*"/g, "").replace(/\d+/g, "n")).join(";")}`,
      detail: overlaps.join("\n") });
  }

  // 3. Tap targets on a touch screen under 44 by 44, links inside running
  // text excepted (a sentence cannot be 44px tall). A small control with
  // room around it still counts: the box is what a finger has to find.
  if (opts.touch) {
    const small = onScreen.filter((el) => {
      const r = rect.get(el)!;
      if (r.width >= 44 && r.height >= 44) return false;
      // A link stretched over its row by a positioned ::after (the market
      // list's rows) is as big as the row.
      const after = getComputedStyle(el, "::after");
      if (after.content !== "none" && after.position === "absolute") return false;
      if (el.tagName === "A" && getComputedStyle(el).display === "inline") {
        const block = el.parentElement;
        if (block && (block.textContent ?? "").trim().length > ((el.textContent ?? "").trim().length + 20)) return false;
      }
      if (el instanceof HTMLInputElement && (el.type === "hidden" || el.type === "range")) return false;
      return true;
    });
    // The header and footer are on every page, so theirs are one issue for
    // the whole site and the page's own are another.
    for (const chrome of [true, false]) {
      const mine = small.filter((el) => (!!el.closest("header, footer") && !el.closest("main")) === chrome);
      if (!mine.length) continue;
      const seen = new Map<string, { n: number; w: number; h: number; d: string }>();
      for (const el of mine) {
        const k = shape(el);
        const r = rect.get(el)!;
        const was = seen.get(k);
        if (was) was.n++; else seen.set(k, { n: 1, w: Math.round(r.width), h: Math.round(r.height), d: describe(el) });
      }
      const top = [...seen.values()].sort((a, b) => b.n - a.n);
      out.push({ type: "small-tap-target", severity: "low",
        message: `${mine.length} tap target(s) under 44x44px: ${top.slice(0, 4).map((x) => `${x.d} ${x.w}x${x.h}${x.n > 1 ? ` (and ${x.n - 1} like it)` : ""}`).join("; ")}`,
        key: chrome ? "tap targets chrome" : "tap targets",
        detail: top.map((x) => `${x.n}x ${x.d} ${x.w}x${x.h}`).join("\n"), chrome });
    }
  }

  // 4. Button text cut by an overflow-hidden box: the label's text runs
  // partly past the nearest box that clips it (the button itself or an
  // ancestor). A scroller is not a cut, and text wholly outside is off
  // screen by design (a carousel), not clipped.
  const cut: string[] = [];
  for (const el of onScreen) {
    if (cut.length >= 6) break;
    if (!(el.tagName === "BUTTON" || el.getAttribute("role") === "button" || el.getAttribute("role") === "tab")) continue;
    let clip: Element | null = el;
    for (; clip && clip !== document.body; clip = clip.parentElement) {
      const s = getComputedStyle(clip);
      if (scrolls(s)) { clip = null; break; }
      if (s.overflowX === "hidden" || s.overflowX === "clip" || s.overflowY === "hidden" || s.overflowY === "clip") break;
    }
    if (!clip || clip === document.body) continue;
    const box = clip.getBoundingClientRect();
    const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let worst = 0;
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      if (!n.textContent?.trim()) continue;
      const parent = n.parentElement;
      if (parent && (!visible(parent) || getComputedStyle(parent).textOverflow === "ellipsis")) continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      for (const r of Array.from(range.getClientRects())) {
        const inside = r.right > box.left && r.left < box.right && r.bottom > box.top && r.top < box.bottom;
        if (!inside) continue;
        worst = Math.max(worst, r.right - box.right, box.left - r.left, r.bottom - box.bottom - 1, box.top - r.top - 1);
      }
    }
    if (worst > 2) cut.push(`${describe(el)} loses ${Math.round(worst)}px of its text`);
  }
  if (cut.length) {
    out.push({ type: "clipped-button", severity: "medium",
      message: cut.slice(0, 3).join("; "),
      key: `cut ${cut.slice(0, 2).map((x) => x.replace(/"[^"]*"/g, "").replace(/\d+/g, "n")).join(";")}`,
      detail: cut.join("\n") });
  }
  return out;
};

export interface Inspection {
  m: Measured | null;
  findings: { type: string; severity: string; message: string; key: string; detail?: string; chrome?: boolean }[];
}

/// Everything above, on a settled page. Never throws.
export async function inspect(page: Page, t: Target): Promise<Inspection> {
  const m = await page.evaluate(MEASURE).catch(() => null);
  const width = t.device.width;
  const phone = width < 768;
  const a = await page.evaluate(PAGE_CHECKS, { phone, width }).catch(() => []);
  const b = await page.evaluate(LAYOUT_CHECKS, { touch: t.device.touch, width }).catch(() => []);
  return { m, findings: [...a, ...b] };
}

/// Files what the capture found and keeps its figures. `shot` is the JPEG
/// the survey just wrote, used as the issues' picture.
export async function record(t: Target, w: Watch | null, q: Inspection | null, errors: string[], shot: string | null) {
  const route = routeOf(t.route);
  const base = { persona: "survey", device: t.device.name, theme: t.theme, step: "survey" };
  const m = q?.m;
  db().prepare(`INSERT INTO page_metrics (t, route, device, theme, build, ttfb_ms, dcl_ms, load_ms, lcp_ms, cls,
      transfer_kb, requests, failed, console_errors, broken_images) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(Date.now(), t.route, t.device.name, t.theme, store.getMeta("build") ?? null,
      m?.ttfb ?? null, m?.dcl ?? null, m?.load ?? null, m?.lcp ?? null, m?.cls ?? null,
      w ? Math.round(w.bytes / 1024) : null, w?.requests ?? null, w?.failed.length ?? null, errors.length, m?.broken.length ?? null);
  await w?.cdp?.detach().catch(() => undefined);
  const file = (i: { type: string; severity: string; message: string; key?: string; detail?: string }) =>
    fileIssue({ ...base, route, type: i.type, severity: i.severity as "high" | "medium" | "low", message: i.message, key: i.key, detail: i.detail }, shot ?? undefined);

  if (m && m.lcp > config.lcpMs) {
    await file({ type: "slow-lcp", severity: m.lcp > 2 * config.lcpMs ? "high" : "medium",
      message: `Largest Contentful Paint ${(m.lcp / 1000).toFixed(1)}s on ${t.device.name} (over ${config.lcpMs / 1000}s)`,
      key: `lcp ${t.device.name}`, detail: `ttfb ${m.ttfb}ms, DOMContentLoaded ${m.dcl}ms, load ${m.load}ms, ${w ? Math.round(w.bytes / 1024) : "?"} KB` });
  }
  if (m && m.cls > config.cls) {
    await file({ type: "layout-shift", severity: "medium",
      message: `Cumulative Layout Shift ${m.cls} on ${t.device.name} (over ${config.cls})`, key: `cls ${t.device.name}` });
  }
  for (const src of m?.broken ?? []) {
    await file({ type: "broken-image", severity: "medium", message: `Image ${src} did not load (naturalWidth 0)`, key: `img ${normalize(src)}` });
  }
  for (const e of errors) {
    // As the session's console listener files them.
    if (/^Failed to load resource/.test(e)) continue;
    await file({ type: "console-error", severity: "medium", message: e });
  }
  for (const f of q?.findings ?? []) {
    // The header and footer are on every page: one issue, not one per route.
    const chrome = f.chrome ?? /(^|[ "])(header|footer) > /.test(f.message);
    await fileIssue({ ...base, route: chrome ? "(every page)" : route, type: f.type, severity: f.severity as "high" | "medium" | "low",
      message: `${f.message} (${t.device.name}, ${t.theme})`, key: f.key, detail: f.detail }, shot ?? undefined);
  }
}
