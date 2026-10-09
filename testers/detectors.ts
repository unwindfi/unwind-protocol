/*
 * What a session watches for, and how a sighting becomes an issue.
 *
 * Listeners (console, page errors, network, toasts) run for the whole
 * session; the page checks (layout, accessibility) run when a journey asks,
 * usually once a page has settled. Every sighting goes through `issue`,
 * which gives it a signature that ignores the parts that change between
 * sightings (addresses, numbers, query strings), records it once per
 * session, and takes a screenshot the first time the fleet sees it.
 */
import crypto from "crypto";
import path from "path";
import type { Page, Request, Response } from "playwright-core";
import { config, paths } from "./config";
import type { Persona } from "./personas";
import * as store from "./store";
import type { Severity } from "./store";

/// Normalizes a path to the route it belongs to: /trade/BONK is /trade/:sym.
export function routeOf(url: string): string {
  let p: string;
  try { p = new URL(url, "http://x").pathname; } catch { p = url; }
  p = p.replace(/(.)\/$/, "$1");
  return p
    .replace(/^\/trade\/[^/]+$/, "/trade/:sym")
    .replace(/^\/vault\/[^/]+$/, "/vault/:id")
    .replace(/^\/list\/[^/]+$/, "/list/:q")
    .replace(/^\/r\/[^/]+$/, "/r/:code")
    .replace(/^\/api\/(trades|batch|candles|pool|referral-code|og\/trade)\/[^/]+$/, "/api/$1/:id");
}

/// The parts of a message that differ between sightings of the same problem.
export function normalize(msg: string): string {
  return msg
    .replace(/https?:\/\/[^\s"')]+/g, (u) => { try { const x = new URL(u); return x.host.includes("localhost") || x.host.includes("unwindfi") ? routeOf(x.pathname) : `${x.host}${routeOf(x.pathname)}`; } catch { return "<url>"; } })
    .replace(/\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g, "<addr>")
    .replace(/\b0x[0-9a-f]+\b/gi, "<hex>")
    .replace(/\b[0-9a-f]{16,}\b/gi, "<hex>")
    .replace(/\$?-?\d[\d,]*(\.\d+)?%?/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

const sigOf = (...parts: string[]) => crypto.createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 16);

/*
 * Network answers the fleet expects, each with why. Anything else at 400 or
 * above, or a request that never completes, is an issue.
 */
const EXPECTED: { test: (u: URL, status: number, method: string, failure?: string) => boolean; why: string }[] = [
  { test: (u) => u.pathname.startsWith("/_vercel/"), why: "Vercel analytics only exists on Vercel; the dev server answers 404" },
  { test: (_u, _s, _m, f) => f === "net::ERR_ABORTED", why: "a poll in flight when the page changed is cancelled by the browser" },
  // Chrome names an abort from route.abort("blockedbyclient") this way; an
  // ad blocker's is plain ERR_BLOCKED_BY_CLIENT, so only the harness's own match.
  { test: (_u, _s, _m, f) => !!f && f.includes("ERR_BLOCKED_BY_CLIENT.Inspector"), why: "the harness blocked it on purpose (faucet, devnet-copy outside a real listing, broadcast in dry runs)" },
  { test: (u, s) => /\/NOTA(MARKET|VAULT)\b/.test(u.pathname + u.search) && s === 404, why: "the tour opens a market and a vault that do not exist on purpose" },
  { test: (u) => u.host === "challenges.cloudflare.com", why: "Turnstile is a human check; testers never load or answer it" },
  { test: (u, s) => u.pathname.startsWith("/api/tx/") && s === 400, why: "a refused build is shown to the user as a toast, which is checked there" },
  { test: (u, s) => u.pathname.startsWith("/api/referral-code/") && s === 404, why: "a free code answers 404" },
];

export interface ToastEvent { status: string; text: string }

export class Recorder {
  step = "start";
  /// Signatures already recorded in this session.
  private seen = new Set<string>();
  private lastShot = 0;
  private shotsThisHour: number[] = [];
  requests = 0;
  responses429 = 0;
  apiFailures = 0;
  errors: string[] = [];
  /// Open "Confirming…" toasts by text, with when they appeared.
  private loading = new Map<string, number>();
  /// Messages from the session's toasts, newest last.
  toasts: ToastEvent[] = [];
  /// Outcomes of /api/tx/send, newest last.
  sends: { ok: boolean; error?: string; sig?: string; at: number }[] = [];
  /// An error toast a check provokes on purpose (a trade with no SOL): kept
  /// in `toasts`, not filed.
  expectToast: RegExp | null = null;

  /// The route each request was made from: by the time it fails the page
  /// may have moved on.
  private origin = new WeakMap<Request, string>();

  constructor(public page: Page, public persona: Persona, public onIssue?: (type: string) => void) {}

  get route() { return routeOf(this.page.url()); }

  /// Records one issue. `key` replaces the message in the signature when the
  /// message itself carries too much that varies.
  async issue(type: string, severity: Severity, message: string, o: { detail?: string; key?: string; route?: string; shot?: boolean } = {}) {
    const route = o.route ?? this.route;
    const signature = sigOf(type, route, o.key ?? normalize(message));
    if (this.seen.has(signature)) return;
    this.seen.add(signature);
    this.onIssue?.(type);
    const { fresh, reopened } = store.recordIssue({
      type, severity, route, message, detail: o.detail, signature,
      persona: this.persona.id, device: this.persona.device.name, theme: this.persona.theme, step: this.step,
    });
    if ((fresh || reopened) && o.shot !== false) await this.screenshot(signature);
  }

  private async screenshot(sig: string) {
    const t = Date.now();
    this.shotsThisHour = this.shotsThisHour.filter((x) => t - x < 3_600_000);
    if (t - this.lastShot < config.shotGapMs || this.shotsThisHour.length >= config.shotsPerHour) return;
    if (this.page.isClosed()) return;
    this.lastShot = t;
    this.shotsThisHour.push(t);
    const file = `${sig}-${t}.jpg`;
    try {
      await this.page.screenshot({ path: path.join(paths.shots, file), type: "jpeg", quality: 60, timeout: 8_000 });
      store.setScreenshot(sig, file);
    } catch { /* the page went away */ }
  }

  /// Wires the listeners. Call once, before the first navigation.
  attach() {
    const page = this.page;
    page.on("console", (m) => {
      if (m.type() !== "error") return;
      const text = m.text();
      // The network listener already reports failed loads, with their URL.
      if (/^Failed to load resource/.test(text)) return;
      // The wallet adapter logs every refusal; in a dry run the harness
      // refuses on purpose.
      if (/\(dry run\)/.test(text)) return;
      this.errors.push(text);
      void this.issue("console-error", "medium", text, { detail: m.location()?.url ? `${m.location().url}:${m.location().lineNumber}` : undefined });
    });
    page.on("pageerror", (e) => {
      this.errors.push(e.message);
      void this.issue("page-error", "high", `${e.name}: ${e.message}`, { detail: e.stack });
    });
    page.on("request", (r) => { this.requests++; this.origin.set(r, this.route); });
    page.on("requestfailed", (r) => this.onFailed(r));
    page.on("response", (r) => this.onResponse(r));
  }

  private expected(url: string, status: number, method: string, failure?: string) {
    let u: URL;
    try { u = new URL(url); } catch { return true; }
    if (u.protocol === "data:" || u.protocol === "blob:") return true;
    return EXPECTED.some((e) => e.test(u, status, method, failure));
  }

  private onFailed(r: Request) {
    const f = r.failure()?.errorText ?? "failed";
    if (this.expected(r.url(), 0, r.method(), f)) return;
    const u = new URL(r.url());
    if (u.pathname.startsWith("/api/")) this.apiFailures++;
    void this.issue("request-failed", u.pathname.startsWith("/api/") ? "high" : "medium",
      `${r.method()} ${u.host}${u.pathname} failed: ${f}`, { key: `${r.method()} ${u.host}${routeOf(u.pathname)} ${f}`, route: this.origin.get(r) });
  }

  private async onResponse(r: Response) {
    const status = r.status();
    const url = r.url();
    if (url.includes("/api/tx/send") && r.request().method() === "POST") void this.onSend(r);
    if (status < 400) return;
    if (status === 429) this.responses429++;
    if (this.expected(url, status, r.request().method())) return;
    const u = new URL(url);
    const api = u.pathname.startsWith("/api/");
    if (api && status >= 500) this.apiFailures++;
    let body = "";
    if (api) body = (await r.text().catch(() => "")).slice(0, 300);
    const kind = r.request().resourceType();
    void this.issue("http-error", api && status >= 500 ? "high" : kind === "image" ? "low" : "medium",
      `${r.request().method()} ${u.host}${u.pathname} answered ${status}${body ? `: ${body}` : ""}`,
      { key: `${r.request().method()} ${u.host}${routeOf(u.pathname)} ${status}`, route: this.origin.get(r.request()) });
  }

  private async onSend(r: Response) {
    // Stamped on arrival. The request's own timing() was read before the
    // body finished and came back -1 for every transaction.
    const at = Date.now();
    let j: any = {};
    try { j = await r.json(); } catch { j = { ok: false, error: `non-JSON answer (${r.status()})` }; }
    this.sends.push({ ok: !!j.ok, error: j.error, sig: j.sig, at });
  }

  /// Toasts, as the page reports them (see TOAST_WATCH).
  onToast(t: ToastEvent) {
    this.toasts.push(t);
    if (this.toasts.length > 50) this.toasts.shift();
    if (t.status === "loading") { if (!this.loading.has(t.text)) this.loading.set(t.text, Date.now()); return; }
    for (const k of this.loading.keys()) if (t.text.startsWith(k.split("\n")[0])) this.loading.delete(k);
    if (t.status === "error" && !this.expectToast?.test(t.text)) {
      // A transaction's failure says "<label> failed"; anything else red is
      // the page telling the user something went wrong.
      const tx = /\bfailed\b/i.test(t.text.split("\n")[0]);
      void this.issue(tx ? "tx-failed" : "error-toast", tx ? "high" : "medium", t.text.replace(/\n+/g, " / "));
    }
  }
  /// Loading toasts that have sat longer than TX_TIMEOUT_MS.
  async checkStuck() {
    for (const [text, at] of this.loading) {
      if (Date.now() - at > config.txTimeoutMs) {
        this.loading.delete(text);
        await this.issue("tx-unconfirmed", "high", `"${text.replace(/\n+/g, " / ")}" still confirming after ${Math.round((Date.now() - at) / 1000)}s`);
      }
    }
  }
}

/*
 * Runs in the page from the first script on: counts DOM mutations (for dead
 * click detection) and reports each toast as it appears or changes. A toast
 * is an `li` in the site's `ol[aria-live]` stack; its status shows in the
 * icon's colour class (text-down for errors, text-up for success) and a
 * loading toast says "Confirming".
 */
export const PAGE_WATCH = () => {
  const w = window as any;
  if (w.top !== w || w.__unwindWatch) return;
  w.__unwindWatch = true;
  w.__unwindMut = 0;
  const start = () => {
    new MutationObserver((ms) => { w.__unwindMut += ms.length; })
      .observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
    const last = new Map<Element, string>();
    setInterval(() => {
      const items = document.querySelectorAll("ol[aria-live] > li");
      const live = new Set<Element>();
      items.forEach((li) => {
        live.add(li);
        const text = (li as HTMLElement).innerText.trim();
        if (!text) return;
        const status = li.querySelector(".text-down") ? "error"
          : li.querySelector(".text-up") ? "success"
          : /Confirming/.test(text) ? "loading" : "neutral";
        const key = `${status}|${text}`;
        if (last.get(li) === key) return;
        last.set(li, key);
        try { w.__unwindToast?.({ status, text }); } catch { /* binding gone */ }
      });
      for (const k of [...last.keys()]) if (!live.has(k)) last.delete(k);
    }, 400);
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
};

export interface PageFinding { type: string; severity: Severity; message: string; key: string; detail?: string }

/*
 * The layout and accessibility checks, evaluated in the page. Returns
 * findings; the caller records them. `phone` turns on the fixed-overlap
 * check, which only matters where the screen is small.
 */
export const PAGE_CHECKS = (opts: { phone: boolean; width?: number }) => {
  const out: { type: string; severity: string; message: string; key: string; detail?: string }[] = [];
  // The screen's width, not innerWidth: a phone browser widens its layout
  // viewport to fit a page that overflows, which hides the overflow from
  // any measure taken against it.
  const vw = Math.min(window.innerWidth, opts.width ?? window.innerWidth);
  const vh = window.innerHeight;
  const visible = (el: Element) => {
    const s = getComputedStyle(el);
    if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) === 0) return false;
    if (el.closest("[aria-hidden='true'], [inert], [hidden]")) return false;
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1;
  };
  /// `withText` off for signatures: the text can be an address or a balance.
  const describe = (el: Element, withText = true) => {
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute("role");
    const label = el.getAttribute("aria-label");
    const text = withText ? ((el as HTMLElement).innerText ?? "").trim().replace(/\s+/g, " ").slice(0, 40) : "";
    const near = el.closest("section, aside, header, nav, main, footer, [role=dialog]");
    const where = near ? (near.getAttribute("aria-label") || near.tagName.toLowerCase()) : "";
    return `${where ? where + " > " : ""}${tag}${role ? `[role=${role}]` : ""}${label ? `[aria-label="${label}"]` : ""}${text ? ` "${text}"` : ""}`;
  };
  const clipsX = (el: Element) => {
    for (let p = el.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
      const o = getComputedStyle(p).overflowX;
      if (o === "auto" || o === "scroll" || o === "hidden" || o === "clip") return true;
    }
    return false;
  };

  // Horizontal overflow of the page itself.
  const docW = document.documentElement.scrollWidth;
  if (docW > vw + 1) {
    const culprits: Element[] = [];
    document.querySelectorAll("body *").forEach((el) => {
      if (culprits.length > 40) return;
      const r = el.getBoundingClientRect();
      if (r.right > vw + 1 && r.width > 0 && visible(el) && !clipsX(el)) culprits.push(el);
    });
    const top = culprits.filter((el) => !culprits.some((c) => c !== el && c.contains(el))).slice(0, 3);
    out.push({
      type: "horizontal-overflow", severity: "high",
      message: `Page is ${docW}px wide in a ${vw}px viewport${top.length ? `: ${top.map((el) => describe(el)).join("; ")}` : ""}`,
      key: `overflow ${top.map((el) => describe(el, false)).join(";")}`,
    });
  }

  // Controls pushed past the viewport's sides.
  const controls = Array.from(document.querySelectorAll("button, a[href], input, select, textarea, [role=button], [role=tab]"));
  for (const el of controls) {
    if (!visible(el) || clipsX(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.left < -1 || r.right > vw + 1) {
      out.push({ type: "offscreen-control", severity: "medium",
        message: `${describe(el)} sits outside the viewport (${Math.round(r.left)} to ${Math.round(r.right)} of ${vw}px)`,
        key: `offscreen ${describe(el).replace(/\d+/g, "n")}` });
    }
  }

  // Controls with no accessible name.
  const nameOf = (el: Element) => {
    const a = el.getAttribute("aria-label")?.trim();
    if (a) return a;
    const by = el.getAttribute("aria-labelledby");
    if (by) {
      const t = by.split(/\s+/).map((id) => document.getElementById(id)?.textContent?.trim() ?? "").join(" ").trim();
      if (t) return t;
    }
    const text = (el.textContent ?? "").trim();
    if (text) return text;
    const title = el.getAttribute("title")?.trim();
    if (title) return title;
    const img = el.querySelector("img[alt]:not([alt=''])");
    if (img) return img.getAttribute("alt");
    const svgTitle = el.querySelector("svg title");
    if (svgTitle?.textContent?.trim()) return svgTitle.textContent.trim();
    if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) {
      if (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent?.trim()) return "label";
      if (el.closest("label")?.textContent?.trim()) return "label";
      if (el instanceof HTMLInputElement && (el.type === "hidden")) return "hidden";
    }
    return "";
  };
  for (const el of controls) {
    if (!visible(el)) continue;
    if (!nameOf(el)) {
      const html = el.outerHTML.replace(/\sclass="[^"]*"/g, "").slice(0, 160);
      // Grouped by shape (tags, no values), so a list of fifty rows with the
      // same unnamed link is one issue.
      const shape = (e: Element, depth: number): string => e.tagName.toLowerCase()
        + (depth > 0 && e.children.length ? `(${Array.from(e.children).slice(0, 3).map((c) => shape(c, depth - 1)).join(",")})` : "");
      const near = el.closest("section, aside, header, nav, main, footer, [role=dialog]");
      out.push({ type: "a11y-unnamed", severity: "low",
        message: `${el.tagName.toLowerCase()} with no accessible name near ${describe(el.parentElement ?? el)}`,
        key: `unnamed ${near?.tagName ?? ""} ${shape(el, 3)}`, detail: html });
    }
  }

  // Labels cut off without an ellipsis: text that runs past the box that
  // clips it. Measured on the text itself (a Range), so decorative art that
  // overflows on purpose is not mistaken for clipped words.
  const labels = Array.from(document.querySelectorAll("button, h1, h2, h3, th, label, [role=tab], a[href]"));
  for (const el of labels) {
    if (!visible(el)) continue;
    const h = el as HTMLElement;
    const s = getComputedStyle(h);
    if (s.overflowX === "visible" && s.overflowY === "visible") continue;
    if (s.textOverflow === "ellipsis" || Array.from(h.querySelectorAll("*")).some((c) => getComputedStyle(c).textOverflow === "ellipsis")) continue;
    const box = h.getBoundingClientRect();
    const walker = document.createTreeWalker(h, NodeFilter.SHOW_TEXT);
    let cut = 0;
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!n.textContent?.trim()) continue;
      const parent = n.parentElement;
      if (parent && (!visible(parent) || parent.closest(".sr-only"))) continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      for (const r of Array.from(range.getClientRects())) {
        cut = Math.max(cut, r.right - box.right, box.left - r.left, r.bottom - box.bottom - 2, box.top - r.top - 2);
      }
    }
    if (cut > 2) {
      out.push({ type: "clipped-text", severity: "low",
        message: `${describe(h)} is cut off (text runs ${Math.round(cut)}px past its box)`,
        key: `clipped ${describe(h).replace(/\d+/g, "n")}` });
    }
  }

  // On a phone, fixed or sticky bars that cover each other.
  if (opts.phone) {
    const fixed = Array.from(document.querySelectorAll("body *")).filter((el) => {
      const p = getComputedStyle(el).position;
      if (p !== "fixed" && p !== "sticky") return false;
      if (!visible(el) || el.closest("[aria-live], [role=dialog]")) return false;
      const r = el.getBoundingClientRect();
      if (r.width * r.height > vw * vh * 0.8) return false; // a backdrop or full-screen sheet
      return r.bottom > 0 && r.top < vh;
    });
    for (let i = 0; i < fixed.length; i++) {
      for (let j = i + 1; j < fixed.length; j++) {
        const a = fixed[i], b = fixed[j];
        if (a.contains(b) || b.contains(a)) continue;
        const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
        const w = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
        const hgt = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
        if (w > 4 && hgt > 4) {
          out.push({ type: "fixed-overlap", severity: "medium",
            message: `${describe(a)} overlaps ${describe(b)} by ${Math.round(w)}x${Math.round(hgt)}px`,
            key: `overlap ${describe(a)} ${describe(b)}`.replace(/\d+/g, "n") });
        }
      }
    }
  }
  return out;
};
