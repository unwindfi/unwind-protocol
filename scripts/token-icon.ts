/*
 * Token logos, fetched once and served from our own origin.
 *
 * A token's logo is whatever URL its metadata names, and most name an IPFS
 * gateway. Browsers refuse a good share of them: ipfs.io answers without the
 * headers a cross-origin image needs, dweb.link subdomains are blocked as
 * opaque responses, and a project's own Pinata gateway answers 403 to anyone
 * but its owner's site. The same file is usually on a public gateway that
 * does answer, so the server tries the URL as given and then the content's
 * path on gateways that serve anyone, checks that what comes back is an
 * image, and keeps it.
 *
 * Kept on disk under .cache/icons, so a restart does not refetch the lot,
 * and in memory for the ones asked for most. A token with no logo, or one
 * nobody serves, is remembered as missing for an hour, so a page of them
 * costs one lookup each rather than one per view.
 */
import * as fs from "fs";
import * as path from "path";

/// Jupiter's token API turns away requests without a browser's User-Agent.
export const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/129.0 Safari/537.36";

/// Gateways that serve any CID to anyone, fastest first. ipfs.io and
/// dweb.link come last: they rate-limit servers as readily as browsers.
const GATEWAYS = [
  "https://ipfs.filebase.io/ipfs/",
  "https://gateway.pinata.cloud/ipfs/",
  "https://ipfs.io/ipfs/",
  "https://dweb.link/ipfs/",
];

const MAX_BYTES = 2_000_000;
const FETCH_MS = 8_000;
/// How long a fetched logo is trusted before it is fetched again. A failed
/// refetch keeps serving the old one.
const FRESH_MS = 7 * 86_400_000;
const MISSING_MS = 3_600_000;
const MEMORY_ENTRIES = 400;
/// Upstream fetches at once, across every caller.
const CONCURRENCY = 4;

const MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export const isMint = (s: string) => MINT.test(s);

/// The CID and path of an IPFS URL, in any of the shapes metadata uses:
/// ipfs://, a gateway's /ipfs/ path, or a CID subdomain.
export function ipfsPath(url: string): string | null {
  if (url.startsWith("ipfs://")) return url.slice(7).replace(/^ipfs\//, "") || null;
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  const at = u.pathname.indexOf("/ipfs/");
  if (at >= 0) return u.pathname.slice(at + 6) + u.search || null;
  const sub = u.hostname.match(/^([a-z0-9]{46,})\.ipfs\./i);
  if (sub) return sub[1] + (u.pathname === "/" ? "" : u.pathname) + u.search;
  return null;
}

/// Where to look for a logo: the URL as given, then the same content on
/// each public gateway. Plain http and non-web schemes are not fetched.
export function candidates(url: string): string[] {
  const out: string[] = [];
  if (/^https:\/\//i.test(url)) out.push(url);
  const p = ipfsPath(url);
  if (p) for (const g of GATEWAYS) out.push(g + p);
  return [...new Set(out)];
}

/// The image type of these bytes, from their content rather than the header:
/// gateways send application/octet-stream as often as anything else.
export function sniff(b: Buffer): string | null {
  if (b.length >= 8 && b.readUInt32BE(0) === 0x89504e47) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 6 && b.subarray(0, 4).toString("latin1") === "GIF8") return "image/gif";
  if (b.length >= 12 && b.subarray(0, 4).toString("latin1") === "RIFF"
    && b.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  if (b.length >= 12 && b.subarray(4, 8).toString("latin1") === "ftyp"
    && /^(avif|avis)$/.test(b.subarray(8, 12).toString("latin1"))) return "image/avif";
  const head = b.subarray(0, 1024).toString("utf8").replace(/^﻿/, "").trimStart();
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!doctype svg[^>]*>\s*)?<svg[\s>]/i.test(head)) return "image/svg+xml";
  return null;
}

export interface Icon { type: string; body: Buffer }

async function fetchImage(url: string): Promise<Icon | null> {
  try {
    const r = await fetch(url, {
      headers: { "user-agent": BROWSER_UA, accept: "image/*" },
      signal: AbortSignal.timeout(FETCH_MS),
      redirect: "follow",
    });
    if (!r.ok || !r.body) { void r.body?.cancel(); return null; }
    if (Number(r.headers.get("content-length")) > MAX_BYTES) { void r.body.cancel(); return null; }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of r.body as any as AsyncIterable<Uint8Array>) {
      size += c.length;
      if (size > MAX_BYTES) return null;
      chunks.push(Buffer.from(c));
    }
    const body = Buffer.concat(chunks);
    const type = sniff(body);
    return type ? { type, body } : null;
  } catch { return null; }
}

export class IconStore {
  private memory = new Map<string, Icon>();
  private missing = new Map<string, number>();
  private inflight = new Map<string, Promise<Icon | null>>();
  private running = 0;
  private waiting: (() => void)[] = [];

  /// `source` names a mint's logo URL (null when it has none); it is asked
  /// only for a mint not already kept.
  constructor(private dir: string, private source: (mint: string) => Promise<string | null>) {}

  /// The logo for a mint, or null when there is none to be had.
  get(mint: string): Promise<Icon | null> {
    const hot = this.memory.get(mint);
    if (hot) {
      // Most recently used last, so the oldest is the one evicted.
      this.memory.delete(mint); this.memory.set(mint, hot);
      return Promise.resolve(hot);
    }
    if ((this.missing.get(mint) ?? 0) > Date.now()) return Promise.resolve(null);
    let p = this.inflight.get(mint);
    if (!p) {
      p = this.load(mint).finally(() => this.inflight.delete(mint));
      this.inflight.set(mint, p);
    }
    return p;
  }

  private async load(mint: string): Promise<Icon | null> {
    const file = path.join(this.dir, mint);
    let stale: Icon | null = null;
    try {
      const st = fs.statSync(file);
      const body = fs.readFileSync(file);
      const type = sniff(body);
      if (type) {
        stale = { type, body };
        if (Date.now() - st.mtimeMs < FRESH_MS) return this.keep(mint, stale);
      }
    } catch { /* not on disk yet */ }

    const fresh = await this.throttled(async () => {
      const url = await this.source(mint).catch(() => null);
      if (!url) return null;
      for (const u of candidates(url)) {
        const got = await fetchImage(u);
        if (got) return got;
      }
      return null;
    });
    if (fresh) {
      try {
        fs.mkdirSync(this.dir, { recursive: true });
        fs.writeFileSync(file, fresh.body);
      } catch { /* served from memory all the same */ }
      return this.keep(mint, fresh);
    }
    if (stale) return this.keep(mint, stale);
    this.missing.set(mint, Date.now() + MISSING_MS);
    return null;
  }

  private keep(mint: string, icon: Icon) {
    this.memory.set(mint, icon);
    if (this.memory.size > MEMORY_ENTRIES) this.memory.delete(this.memory.keys().next().value!);
    return icon;
  }

  private async throttled<T>(f: () => Promise<T>): Promise<T> {
    while (this.running >= CONCURRENCY) await new Promise<void>((r) => this.waiting.push(r));
    this.running++;
    try { return await f(); } finally {
      this.running--;
      this.waiting.shift()?.();
    }
  }
}
